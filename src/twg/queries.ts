/**
 * Teamwork Graph access layer + the deterministic evidence engine.
 *
 * Two query strategies, as designed in final-concept.md §4.6(2):
 *
 *   1. CURATED queries (no registration) for the hops the catalog covers:
 *        atlassianTeamsBySpace, atlassianTeamMembers, confluencePageOwners,
 *        confluencePageContributors, jiraSpaceWorkItems …
 *      Every field is a Relay connection and `first` is capped at 25, so the
 *      helpers here paginate explicitly.
 *
 *   2. PERSISTED Cypher (registered once against this Forge app, executed by
 *      `queryKey`) for the traversals the catalog cannot express — notably
 *      work item -> policy page -> space -> team in one hop.
 *
 * The interesting part is what happens when a query returns nothing. The graph
 * fails closed: a scope the admin did not grant produces an empty, successful
 * result. So "no rows" is ambiguous, and this module refuses to call it MISSING
 * unless it has positive proof that the app can read that object type
 * (a scope proven by some other query returning rows in the same scan).
 * Otherwise the claim is NOT_VISIBLE — "we cannot see it" — and the UI can name
 * the scope to grant.
 *
 * Relationship/property names used by the persisted Cypher drafts follow the
 * Teamwork Graph API reference (content_entity_links_entity, etc.). They are
 * validated in TWG Labs Query Builder at gate G0 before registration; see
 * PERSISTED_QUERIES.validation.
 */

import api from '@forge/api';
import { AsyncLocalStorage } from 'node:async_hooks';

import { noteGraphCall } from '../g0/counters';

import type { EvidenceType, RequirementRow, ControlRow } from '../schema/sql';

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * Teamwork Graph scopes are per object type: read:graph:<object>:<product>.
 * Declare exactly the types a traversal touches, including intermediate hops —
 * a missing scope anywhere in a path empties the whole result.
 * Keep this list in sync with manifest.yml -> permissions.scopes.
 */
export const GRAPH_SCOPES = {
  WORK_ITEM: 'read:graph:issue:jira',
  COMMENT: 'read:graph:issue-comment:jira',
  JIRA_SPACE: 'read:graph:project:jira',
  PAGE: 'read:graph:page:confluence',
  CONFLUENCE_SPACE: 'read:graph:space:confluence',
  USER: 'read:graph:user:atlassian',
  TEAM: 'read:graph:team:atlassian',
} as const;

export type GraphScope = (typeof GRAPH_SCOPES)[keyof typeof GRAPH_SCOPES];

export const ALL_GRAPH_SCOPES: readonly GraphScope[] = Object.values(GRAPH_SCOPES);

/**
 * The permissions that are NOT Teamwork Graph scopes.
 *
 * Two of the claims are answered by Atlassian REST, not by the graph: an approval
 * is a Jira comment, and a policy page's existence is a Confluence page read. When
 * one of those is denied, the admin has to be told the permission that actually
 * unblocks it. Naming a graph scope there used to send the admin to toggle the
 * wrong switch — the product's most visible promise ("we tell you exactly which
 * permission to grant") broke on the row where it mattered.
 */
export type RestScope = 'read:jira-work' | 'read:page:confluence' | 'read:confluence-content.all';

export const REST_SCOPES: Readonly<Record<'JIRA_WORK' | 'PAGE' | 'CONTENT', RestScope>> = {
  JIRA_WORK: 'read:jira-work',
  PAGE: 'read:page:confluence',
  CONTENT: 'read:confluence-content.all',
};

/** Anything the app can ask an admin to grant: a graph scope or a REST scope. */
export type EvidenceScope = GraphScope | RestScope;

export function isGraphScope(scope: string): scope is GraphScope {
  return (ALL_GRAPH_SCOPES as readonly string[]).includes(scope);
}

/** Object type -> scope, for human-readable diagnostics. */
export const OBJECT_TYPE_SCOPE: Readonly<Record<string, GraphScope>> = {
  JiraWorkItem: GRAPH_SCOPES.WORK_ITEM,
  JiraWorkItemComment: GRAPH_SCOPES.COMMENT,
  JiraSpace: GRAPH_SCOPES.JIRA_SPACE,
  ConfluencePage: GRAPH_SCOPES.PAGE,
  ConfluenceSpace: GRAPH_SCOPES.CONFLUENCE_SPACE,
  AtlassianUser: GRAPH_SCOPES.USER,
  AtlassianTeam: GRAPH_SCOPES.TEAM,
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ReadOutcome = 'ROWS' | 'EMPTY' | 'ERROR';

/**
 * Why a read did not produce rows. The distinction is the product: a permission
 * gap is NOT_VISIBLE, a rate limit or service outage is INCOMPLETE, and only a
 * read that finished cleanly can support MISSING.
 */
export type FailureCause =
  | 'PERMISSION_DENIED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'TIMEOUT'
  | 'SERVICE_ERROR'
  | 'INDEX_DELAY'
  /**
   * The site does not hold what the programme assumes: the project or space the
   * control names is not here. This is a cause, not a sixth state — the claim is
   * INCOMPLETE (nobody could check it) but the user's next step is binding the
   * programme, not asking for a permission.
   */
  | 'UNCONFIGURED'
  /**
   * No connector on this site can supply this evidence type at all (a linked pull
   * request or a deployment record, with no Git/Bitbucket/deployment app writing
   * remote links). The claim is not "missing evidence": nothing on this site could
   * ever produce it, so it is reported as unsupported and kept out of the gap count.
   */
  | 'UNSUPPORTED'
  | 'UNKNOWN';

export interface GraphError {
  message: string;
  status?: number;
  /** Scope hints parsed out of the response, when the API volunteers them. */
  scopes?: string[];
  cause?: FailureCause;
  retryAfterMs?: number;
  /** The read may succeed on another attempt, so it cannot become MISSING. */
  retryable?: boolean;
}

/** One failed read behind an observation, kept so the UI can explain the state. */
export interface ObservationFailure {
  cause: FailureCause;
  message: string;
  scope?: EvidenceScope;
  retryable: boolean;
}

export interface GraphRead<T> {
  label: string;
  outcome: ReadOutcome;
  rows: T[];
  error?: GraphError;
  latencyMs: number;
  /** Number of HTTP round trips (pages + 1). Shown in Diagnostics. */
  pages: number;
  /** Retries spent on backoff, shown next to the query key. */
  retries: number;
  /** Persisted query key, when a persisted Cypher query produced the rows. */
  queryKey?: string;
  /** Which route answered: curated graph field, persisted Cypher, or REST fallback. */
  mode: 'curated' | 'persisted' | 'rest' | 'registry';
  /**
   * True when the read stopped at the page cap while the API said more existed.
   * Silent truncation is how a busy site turns "evidence exists" into "evidence is
   * missing", so the fact is carried with the read and said out loud.
   */
  truncated?: boolean;
}

/**
 * Where a hop came from. The diagram draws a relationship this app derived with a
 * rule differently from one the graph answered, because saying otherwise would
 * make the picture claim more than the data does.
 *
 *   graph     — a Teamwork Graph edge (confluencePageOwners, teamsBySpace, …)
 *   persisted — a registered Cypher traversal executed by queryKey
 *   rest      — Jira/Confluence REST (the issue itself, its comments, a page)
 *   rule      — derived here: a label match, a title match, a configured link
 */
export type HopSource = 'graph' | 'persisted' | 'rest' | 'rule';

/** A hop of the chain that produced a verdict. Stored in SQL, shown in the UI. */
export interface ProvenanceHop {
  hop: number;
  fromAri: string | null;
  relation: string;
  toAri: string | null;
  observedAt: string;
  /** Defaults to 'graph' when absent, which is what the curated fields return. */
  source?: HopSource;
}

/** One candidate piece of evidence, already normalised by the caller. */
export interface EvidenceCandidate {
  ari: string;
  kind: string;
  label?: string;
  /** When the evidence itself was last touched (page update, comment, deploy). */
  observedAt: string;
  ownerAccountId?: string | null;
  ownerName?: string | null;
  /** null when the owner's state is unknown (e.g. no user scope). */
  ownerActive?: boolean | null;
  /**
   * True when `ownerActive` is a measured value.
   *
   * It is false for a Confluence page owner: the graph's `AtlassianUser` selection has
   * no active flag and the app does not request `read:jira-user`, so a deactivated page
   * owner cannot be detected. The verdict text has to say that instead of promising a
   * detection the code cannot make (the README used to say "or its owner is
   * deactivated" for every state).
   */
  ownerActiveKnown?: boolean;
  /**
   * False when the ownership hop was attempted and named nobody (the graph
   * returned no rows for confluencePageOwners). The claim can still be VERIFIED —
   * its evidence is real — but the row has to say that nobody is named, instead of
   * passing silently and looking like a resolved owner.
   */
  ownershipResolved?: boolean;
  /** False when the object exists but does not satisfy the rule. */
  usable: boolean;
  /** Why it does not satisfy the rule, e.g. "approved by the author themselves". */
  unusableReason?: string;
  /** Relative web path, when the object is a Confluence page. */
  webPath?: string | null;
}

export interface EvidenceObservation {
  requirementId: string;
  evidenceType: EvidenceType;
  /**
   * The graph scope this observation depends on, or null when the read route
   * itself establishes visibility (a 200 from JQL proves the user can see the
   * project; an empty Teamwork Graph answer proves nothing).
   */
  scope: GraphScope | null;
  read: Pick<
    GraphRead<unknown>,
    'label' | 'outcome' | 'error' | 'latencyMs' | 'mode' | 'queryKey' | 'retries'
  >;
  candidates: EvidenceCandidate[];
  provenance: ProvenanceHop[];
  subjectAri?: string | null;
  /**
   * Reads that failed while this requirement was being judged. Without them the
   * engine cannot tell "there is no evidence" from "we could not look", so they
   * travel with the observation instead of being logged and dropped.
   */
  failures?: ObservationFailure[];
  /** True when the population itself could not be read (nothing was seen). */
  populationUnread?: boolean;
  /**
   * The project holds nothing to judge: no work item carries the control label and
   * no change has been completed in it. A fresh project is not a failed control, so
   * this is reported as "not checked — nothing to judge yet" rather than MISSING.
   */
  populationEmpty?: boolean;
  /**
   * Rows the scoped graph read itself returned — not REST candidates.
   *
   * The policy page comes from Confluence REST and is a candidate; the scope the
   * claim depends on (`read:graph:page:confluence`) is proven only by rows the
   * *graph* returned through it. Conflating the two is what let "0 not visible" be
   * claimed on a scan that never saw a single graph row (A7).
   */
  scopeRows?: number;
  /**
   * The read route itself established that this app can see the object type: a
   * Confluence space resolved and its page listing answered (200 with a result, or
   * a clean "no such title"). With that in hand an empty candidate set is a real
   * absence (MISSING), not a permission gap — the app already knows the page is
   * not there, because REST told it so.
   */
  visibilityProven?: boolean;
  /**
   * A cross-product finding the generic five-state rules cannot express: the graph
   * answered, and what it answered is a finding (the approver is not accountable
   * for the policy). Judged as STALE — evidence exists and is fresh, but the
   * relationship the claim needs is absent.
   */
  crossProductFinding?: { relation: string; reason: string; evidenceAri?: string | null };
  /**
   * The claim could not be concluded for a reason the five-state rules cannot see —
   * e.g. the graph answered nothing about the teams a cross-product claim needs. It
   * is reported as INCOMPLETE ("not checked") with this sentence, never as MISSING:
   * nothing was found because nothing was read.
   */
  uncheckedReason?: string;
  /**
   * The ownership hop (who answers for the policy page) could not be read at all.
   *
   * This is distinct from `ownershipResolved === false` (the hop answered, and it
   * named nobody): a failed read is a blind spot. The unattended scan hit this in the
   * field — its graph reads ran without a user identity and failed, and the gate read
   * "we could not look" as "nobody is accountable", turning six controls STALE.
   */
  accountabilityUnread?: boolean;
  /**
   * Deterministic notes about the read itself — a persisted query that could not
   * run, a registered page that no longer exists, discovery mode in use. They never
   * change a verdict; they are shown next to it.
   */
  notes?: string[];
  /**
   * Not an error: the site has not indexed the object yet. Newly created work
   * items take minutes to appear in the graph, so an empty answer right after
   * creation is INCOMPLETE rather than MISSING.
   */
  indexingDelay?: boolean;
  /**
   * How many objects the claim's population holds (12 changes, one policy page).
   *
   * A claim whose words are "every production change carries an approval" is a
   * statement about a population, and the verdict has to say how much of that
   * population it actually judged. Without this the pack could print "Verified: 1
   * qualifying evidence object(s)" about twelve changes and read as if all twelve
   * had been checked.
   */
  populationTotal?: number | null;
  /** How many of those objects this run actually read and judged. */
  populationJudged?: number | null;
  /**
   * True when the read stopped before the population was covered (a per-scan cap, a
   * page limit). The verdict then says "N of M" and names the cap instead of
   * implying a complete read.
   */
  truncated?: boolean;
  /** What stopped the read, e.g. "comment reads are capped at 25 changes per scan". */
  truncationNote?: string;
}

// ---------------------------------------------------------------------------
// Scope ledger — what this scan has actually proven it can read
// ---------------------------------------------------------------------------

export type ScopeState = 'PROVEN' | 'INCONCLUSIVE' | 'DENIED' | 'NOT_PROBED';

export type ScopeLedger = Partial<Record<GraphScope, ScopeState>>;

export interface ScopeProbeResult {
  probe: string;
  scopes: readonly GraphScope[];
  objectTypes: readonly string[];
  state: ScopeState;
  rowCount: number;
  latencyMs: number;
  error?: GraphError;
}

/**
 * A scope is PROVEN only when a query that reads it returned at least one row.
 * An empty, successful response is INCONCLUSIVE: it may mean "no such data" or
 * "scope not granted". This is the whole reason NOT_VISIBLE exists as a state.
 *
 * Merge order is fixed, not first-wins: PROVEN beats DENIED (a row that came back is
 * proof the grant exists, whatever a later probe hit), DENIED beats INCONCLUSIVE, and
 * NOT_PROBED never overwrites a measurement. The old rule was written as an
 * accidental sequence of ifs, so which state a scope ended in depended on the order
 * the probes ran in.
 */
export function buildScopeLedger(results: readonly ScopeProbeResult[]): ScopeLedger {
  const RANK: Readonly<Record<ScopeState, number>> = {
    NOT_PROBED: 0,
    INCONCLUSIVE: 1,
    DENIED: 2,
    PROVEN: 3,
  };
  const ledger: ScopeLedger = {};
  for (const result of results) {
    for (const scope of result.scopes) {
      const current = ledger[scope];
      if (current === undefined || RANK[result.state] > RANK[current]) {
        ledger[scope] = result.state;
      }
    }
  }
  return ledger;
}

export function scopeIsProven(ledger: ScopeLedger, scope: GraphScope): boolean {
  return ledger[scope] === 'PROVEN';
}

/**
 * What one observation actually established about its scope.
 *
 * The ledger used to be built from `buildScopeLedger([])` in the gate, so every
 * claim was judged against an empty ledger and "no rows" was silently promoted to
 * PROVEN by the caller as long as any candidate existed. Deriving the row from the
 * observation keeps the ledger a *measurement*: rows returned prove the read, a
 * denial denies it, and an empty answer proves nothing.
 */
export function scopeProbeFromObservation(
  probe: string,
  observation: EvidenceObservation,
): ScopeProbeResult | null {
  const scope = observation.scope;
  if (!scope) {
    return null;
  }
  const denied = (observation.failures ?? []).some(
    (failure) => failure.cause === 'PERMISSION_DENIED' && (!failure.scope || failure.scope === scope),
  );
  // A denial wins over a candidate list.
  //
  // This used to read `candidates.length > 0 ? 'PROVEN' : denied ? 'DENIED' : …`, so
  // a policy page found over REST (a candidate) marked the *graph* scope PROVEN even
  // when the ownership hop had just answered 403 to that exact scope. The scope
  // ledger is a measurement of the graph read: a denial denies it, rows from the
  // graph prove it, and everything else is inconclusive.
  const rowsThroughScope = observation.scopeRows ?? 0;
  const state: ScopeState = denied
    ? 'DENIED'
    : rowsThroughScope > 0
      ? 'PROVEN'
      : 'INCONCLUSIVE';
  return {
    probe,
    scopes: [scope],
    objectTypes: [scope],
    state,
    rowCount: rowsThroughScope,
    latencyMs: observation.read.latencyMs,
    error: observation.read.error,
  };
}

// ---------------------------------------------------------------------------
// Low-level GraphQL execution
// ---------------------------------------------------------------------------

interface RawRunResult {
  data?: Record<string, unknown>;
  error?: GraphError;
  latencyMs: number;
  retries: number;
}

/**
 * Read the failure cause out of a message. The graph reports most failures as a
 * 200 with a GraphQL error, so the message is often the only evidence.
 */
export function classifyFailure(status: number | undefined, message: string): FailureCause {
  const text = message.toLowerCase();
  if (/rate.?limit|too many requests|throttl/.test(text) || status === 429) {
    return 'RATE_LIMIT_EXCEEDED';
  }
  // A backend dependency failing is not the caller's permission problem. The
  // teamsV2 403 is the known case: scope and org admin are fine, the service is
  // not answering. It is checked first because its message also contains
  // "status code is: 403" — and that is exactly the trap this function fell into:
  // the generic 403 pattern used to sit in front of the permission branch, so a
  // genuine scope denial was retried three times and then reported as INCOMPLETE
  // ("partly checked") instead of NOT_VISIBLE ("we cannot see it").
  if (/teamsv2/.test(text)) {
    return 'SERVICE_ERROR';
  }
  // Permission is decided before any service-error pattern: a 401/403 — including
  // the graph's `status code is: 403` phrasing — is the caller's permission gap.
  //
  // The bare word "scope" is deliberately no longer enough (v6.27): messages like
  // "the requested scope is unavailable" or a backend complaint mentioning a
  // "query scope" used to be read as a permission gap, which turned a service
  // error into "ask your admin for a permission that is already granted". A scope
  // mention only counts when it is the missing one — "missing scope", "lacks the
  // scope", "requires the scope" — or when the message names a `read:graph:` scope.
  if (
    status === 403 ||
    status === 401 ||
    /status code is: (403|401)|permission denied|permission|forbidden|unauthori[sz]ed|not permitted/.test(
      text,
    ) ||
    /(?:missing|lacks?|lacking|require[sd]?|needs?|insufficient|without)\s+(?:the\s+|a\s+)?scopes?\b/.test(
      text,
    ) ||
    /read:graph:[a-z-]+:[a-z]+/.test(text)
  ) {
    return 'PERMISSION_DENIED';
  }
  if (/upstream/.test(text)) {
    return 'SERVICE_ERROR';
  }
  if (/timeout|timed out|etimedout|took too long/.test(text) || status === 408 || status === 504) {
    return 'TIMEOUT';
  }
  if (/index|not yet available|eventually consistent/.test(text)) {
    return 'INDEX_DELAY';
  }
  if (status !== undefined && status >= 500) {
    return 'SERVICE_ERROR';
  }
  if (/not_found|feature_unavailable|isn't enabled|is not enabled/.test(text)) {
    return 'SERVICE_ERROR';
  }
  return 'UNKNOWN';
}

const RETRYABLE_CAUSES: ReadonlySet<FailureCause> = new Set<FailureCause>([
  'RATE_LIMIT_EXCEEDED',
  'TIMEOUT',
  'SERVICE_ERROR',
  'INDEX_DELAY',
]);

export function isRetryable(cause: FailureCause): boolean {
  return RETRYABLE_CAUSES.has(cause);
}

function extractGraphError(body: unknown, status: number): GraphError | undefined {
  if (typeof body !== 'object' || body === null) {
    return status >= 400 ? { message: `HTTP ${status}`, status } : undefined;
  }
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return status >= 400 ? { message: `HTTP ${status}`, status } : undefined;
  }
  const messages: string[] = [];
  const scopes: string[] = [];
  for (const entry of errors) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const message = (entry as { message?: unknown }).message;
    if (typeof message === 'string') {
      messages.push(message);
      for (const match of message.matchAll(/read:graph:[a-z-]+:[a-z]+/g)) {
        scopes.push(match[0]);
      }
    }
  }
  const joined = messages.join(' | ') || `GraphQL error (HTTP ${status})`;
  const cause = classifyFailure(status >= 400 ? status : undefined, joined);
  return {
    message: joined,
    status: status >= 400 ? status : undefined,
    scopes: scopes.length > 0 ? [...new Set(scopes)] : undefined,
    cause,
    retryable: isRetryable(cause),
  };
}

/**
 * Retry/backoff for graph reads.
 *
 * The graph returns 0 rows for a rate-limited query, which would otherwise be
 * indistinguishable from "no evidence". Retrying with backoff is what keeps the
 * scan from converting a throttle into a false MISSING; when the retries are
 * exhausted the observation carries RATE_LIMIT_EXCEEDED and the requirement
 * becomes INCOMPLETE instead.
 */
export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const GRAPH_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 2_000,
};

/**
 * A Rovo action gets about 20 seconds (manifest action budget). A registry scan
 * measured 19.9 s, so two retries can push a chat invocation past the timeout.
 * The action path therefore reads once and reports INCOMPLETE instead of retrying
 * into a timeout — the same reason it already names.
 */
export const ACTION_RETRY_POLICY: RetryPolicy = {
  attempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
};

/**
 * The retry policy in force for *this* call chain.
 *
 * It used to be a module-level variable with a save/restore around the task, which
 * is not isolation: two scans running concurrently (a Rovo action started while the
 * scheduled scan is mid-flight) overwrote each other's policy, so a chat invocation
 * could inherit the three-attempt policy and blow its 20-second budget, or a scan
 * could silently lose its retries. The policy now lives in an async context, so it
 * follows the call it was set for and nothing else.
 */
const retryPolicyContext = new AsyncLocalStorage<RetryPolicy>();

/** The policy the next graph read will use. Exported for the regression tests. */
export function activeGraphRetryPolicy(): RetryPolicy {
  return retryPolicyContext.getStore() ?? GRAPH_RETRY_POLICY;
}

/** Which policy a scan trigger should use. Pure, so it can be pinned by a test. */
export function graphRetryPolicyFor(
  trigger: 'ROVO_ACTION' | 'MANUAL' | 'SCHEDULED' | 'INSTALL',
): RetryPolicy {
  return trigger === 'ROVO_ACTION' ? ACTION_RETRY_POLICY : GRAPH_RETRY_POLICY;
}

/** Run `task` with a retry policy in force for that call chain only. */
export async function withGraphRetryPolicy<T>(policy: RetryPolicy, task: () => Promise<T>): Promise<T> {
  return retryPolicyContext.run(policy, task);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `operation` until it produces a non-retryable result or the attempts run
 * out. Returns the last result plus how many retries were spent, so the UI can
 * say "27 calls · 3 retries" instead of pretending the scan was clean.
 */
async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  retryAfterOf: (value: T) => number | undefined,
  isRetryableValue: (value: T) => boolean,
  override?: RetryPolicy,
): Promise<{ value: T; retries: number }> {
  const policy = override ?? activeGraphRetryPolicy();
  let retries = 0;
  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    const value = await operation(attempt);
    const last = attempt === policy.attempts - 1;
    if (last || !isRetryableValue(value)) {
      return { value, retries };
    }
    const hinted = retryAfterOf(value);
    const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
    const jitter = Math.floor(Math.random() * 120);
    retries += 1;
    await sleep(hinted ?? backoff + jitter);
  }
  /* istanbul ignore next -- the loop always returns on its last attempt */
  return { value: await operation(policy.attempts - 1), retries };
}

function retryAfterMsOf(response: { headers?: { get?: (name: string) => string | null } }): number | undefined {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) {
    return undefined;
  }
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) ? Math.min(seconds * 1_000, 5_000) : undefined;
}

/**
 * The budget one scan gives its graph reads.
 *
 * The unattended scan has no calling user, so its graph hops have to borrow the
 * stored scan principal. That path can stall — a request that never answers keeps
 * the whole function alive until the platform kills it, which is what happened on
 * the deployed site (a scan that should take 25 s sat past three minutes). The
 * budget turns "wait forever" into a measured answer:
 *
 *   * every hop gets one hard cap (the whole retry sequence, not each attempt);
 *   * a capped hop is TIMEOUT and is *not* retried (a cap means the graph is not
 *     answering, so a retry only spends the next cap);
 *   * impersonation is abandoned after its first cap, and the run's graph reads
 *     stop entirely after two caps in a row — the rest of the scan then reports
 *     what it could read instead of paying the cap hop by hop.
 *
 * The state is a plain object so a test can inspect it and the scan can put it in
 * the scan record. It is per call chain (AsyncLocalStorage), never module-global:
 * a manual scan and an unattended one can run at the same time.
 */
export interface GraphCallState {
  calls: number;
  /** Hops whose cap fired. */
  capped: number;
  /** Back-to-back caps, reset by any answered hop. */
  consecutiveCaps: number;
  /** Set once the graph is written off for this run. */
  breakerOpen: boolean;
  /** Hops requested as the scan principal. */
  impersonated: number;
  /** Set once impersonation has been given up for this run. */
  impersonationRejected: boolean;
}

export interface GraphCallBudget {
  /** Identity to read as when the invocation has none. */
  asAccountId?: string;
  /** Hard cap for one hop, retries included. 0/undefined waits like before. */
  timeoutMs?: number;
  /** How many caps in a row write the graph off. Default 2. */
  capStreak?: number;
  state: GraphCallState;
}

/** The unattended scan's per-hop cap. A warm hop answers in 0.3–3.2 s. */
export const UNATTENDED_GRAPH_CAP_MS = 6_000;

export function newGraphCallState(): GraphCallState {
  return {
    calls: 0,
    capped: 0,
    consecutiveCaps: 0,
    breakerOpen: false,
    impersonated: 0,
    impersonationRejected: false,
  };
}

const graphCallBudget = new AsyncLocalStorage<GraphCallBudget>();

/** Run `task` with a graph budget in force for that call chain only. */
export async function withGraphCallBudget<T>(
  budget: GraphCallBudget,
  task: () => Promise<T>,
): Promise<T> {
  return graphCallBudget.run(budget, task);
}

/** The budget's state, for the scan record and the regression tests. */
export function activeGraphCallState(): GraphCallState | null {
  return graphCallBudget.getStore()?.state ?? null;
}

/** One line about how this run read the graph, for the scan record. */
export function describeGraphBudget(state: GraphCallState, capMs?: number): string {
  const parts = [`graph ${state.calls} read(s)`];
  if (state.impersonated > 0) {
    parts.push(`${state.impersonated} as the scan principal`);
  }
  if (state.capped > 0) {
    parts.push(`${state.capped} capped${capMs ? ` at ${capMs} ms` : ''}`);
  }
  if (state.impersonationRejected) {
    parts.push('impersonation abandoned after its first cap');
  }
  if (state.breakerOpen) {
    parts.push('graph written off for the rest of the run');
  }
  return parts.join(' · ');
}

type CappedOr<T> =
  | { capped: true }
  | { capped: false; value: T }
  | { capped: false; failure: unknown };

/**
 * Race `work` against a cap. The losing promise's rejection is absorbed here so a
 * late failure cannot surface as an unhandled rejection after the scan moved on.
 */
async function withCallCap<T>(work: Promise<T>, timeoutMs?: number): Promise<CappedOr<T>> {
  if (!timeoutMs || timeoutMs <= 0) {
    try {
      return { capped: false, value: await work };
    } catch (failure) {
      return { capped: false, failure };
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<CappedOr<T>>((resolve) => {
    // Deliberately not unref'd: while the cap is racing, its timer is the only thing
    // that will settle this hop if the request never answers. It is cleared in the
    // finally below, so it never outlives the hop.
    timer = setTimeout(() => resolve({ capped: true }), timeoutMs);
  });
  try {
    return await Promise.race([
      work.then(
        (value): CappedOr<T> => ({ capped: false, value }),
        (failure): CappedOr<T> => ({ capped: false, failure }),
      ),
      cap,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Execute one GraphQL document against the Teamwork Graph endpoint.
 *
 * @param asAccountId impersonate this user. Outside a budget this is the only way
 *   to pick an identity; inside one the budget's principal is used when the call
 *   site does not name one, so every hop of an unattended scan reads as the same
 *   person without each call site having to remember.
 */
export async function runGraphQL(
  query: string,
  variables: Record<string, unknown>,
  asAccountId?: string,
): Promise<RawRunResult> {
  noteGraphCall();
  const started = Date.now();
  const budget = graphCallBudget.getStore();
  if (budget) {
    budget.state.calls += 1;
    if (budget.state.breakerOpen) {
      // The graph did not answer twice in a row in this run: spend nothing more on
      // it. The hop is INCOMPLETE with this reason, not a claim about the site.
      return {
        error: {
          message:
            'The Teamwork Graph did not answer earlier in this run, so this read was skipped rather than waited on. ' +
            'The claim is unchecked, not missing.',
          cause: 'TIMEOUT',
          retryable: false,
        },
        latencyMs: 0,
        retries: 0,
      };
    }
  }
  const identity =
    asAccountId ??
    (budget && !budget.state.impersonationRejected ? budget.asAccountId : undefined);
  if (budget && identity && identity === budget.asAccountId) {
    budget.state.impersonated += 1;
  }
  const requester = identity ? api.asUser(identity) : api.asUser();

  const single = async (): Promise<{ result: RawRunResult; retryAfter?: number }> => {
    try {
      const response = await requester.requestTeamworkGraph(query, variables);
      const latencyMs = Date.now() - started;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        const cause = classifyFailure(response.status, `Unreadable response body (HTTP ${response.status})`);
        return {
          result: {
            error: {
              message: `Unreadable response body (HTTP ${response.status})`,
              status: response.status,
              cause,
              retryable: isRetryable(cause),
            },
            latencyMs,
            retries: 0,
          },
          retryAfter: retryAfterMsOf(response),
        };
      }
      const error = extractGraphError(body, response.status);
      if (error) {
        return {
          result: { error, latencyMs, retries: 0 },
          retryAfter: retryAfterMsOf(response),
        };
      }
      const data = (body as { data?: Record<string, unknown> }).data;
      return { result: { data: data ?? {}, latencyMs, retries: 0 } };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const failure = classifyFailure(undefined, message);
      return {
        result: {
          error: { message, cause: failure, retryable: isRetryable(failure) },
          latencyMs: Date.now() - started,
          retries: 0,
        },
      };
    }
  };

  const settled = await withCallCap(
    withRetry(
      async () => single(),
      (value) => value.retryAfter,
      (value) => value.result.error?.retryable === true,
    ),
    budget?.timeoutMs,
  );
  if (settled.capped) {
    if (budget) {
      budget.state.capped += 1;
      budget.state.consecutiveCaps += 1;
      if (identity && identity === budget.asAccountId) {
        // Borrowing the principal is what stalled: stop doing it for this run.
        budget.state.impersonationRejected = true;
      }
      if (budget.state.consecutiveCaps >= (budget.capStreak ?? 2)) {
        budget.state.breakerOpen = true;
      }
    }
    return {
      error: {
        message:
          `The Teamwork Graph did not answer within ${budget?.timeoutMs ?? 0} ms` +
          (identity ? ' while reading as the scan principal' : '') +
          '. The claim is unchecked, not missing — rescan when the graph answers.',
        cause: 'TIMEOUT',
        // A cap is not a hint to try again: the next attempt would spend the next cap.
        retryable: false,
      },
      latencyMs: Date.now() - started,
      retries: 0,
    };
  }
  if (budget) {
    budget.state.consecutiveCaps = 0;
  }
  if ('failure' in settled) {
    const message = settled.failure instanceof Error ? settled.failure.message : String(settled.failure);
    const cause = classifyFailure(undefined, message);
    return {
      error: { message, cause, retryable: isRetryable(cause) },
      latencyMs: Date.now() - started,
      retries: 0,
    };
  }
  return { ...settled.value.value.result, retries: settled.value.retries };
}

/** Reading a Relay connection: edges[].node plus pageInfo. */
interface ConnectionShape<T> {
  edges?: Array<{ node?: T | null } | null>;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

const CURATED_PAGE_SIZE = 25; // hard cap for curated queries

/**
 * Page through a curated connection field.
 *
 * `field` is the GraphQL field name, `args` its declared arguments (without
 * pagination), e.g. (`confluencePageOwners`, `id: $id`). Pagination arguments
 * are appended once, here, so every caller gets the same 25-row cap handling.
 *
 * `selection` is the inline fragment selecting the concrete type, e.g.
 *   `... on AtlassianUser { accountId name }`
 */
async function fetchConnection<T>(
  label: string,
  field: string,
  args: string,
  variables: Record<string, unknown>,
  selection: string,
  asAccountId?: string,
  maxPages = 4,
): Promise<GraphRead<T>> {
  const rows: T[] = [];
  let pages = 0;
  let latencyMs = 0;
  let retries = 0;
  let cursor: string | null | undefined;
  let lastError: GraphError | undefined;
  let truncated = false;
  const callArgs = args.trim().length > 0 ? `${args}, first: $first, after: $after` : 'first: $first, after: $after';

  for (let page = 0; page < maxPages; page += 1) {
    const query = `query AssureLoop_${label}($id: ID!, $first: Int, $after: String) {
  ${field}(${callArgs}) {
    edges { node { __typename ${selection} } }
    pageInfo { hasNextPage endCursor }
  }
}`;

    const result = await runGraphQL(
      query,
      { ...variables, first: CURATED_PAGE_SIZE, after: cursor ?? null },
      asAccountId,
    );
    pages += 1;
    latencyMs += result.latencyMs;
    retries += result.retries;

    if (result.error) {
      lastError = result.error;
      break;
    }

    const connection = (result.data?.[label] ?? null) as ConnectionShape<T> | null;
    if (!connection) {
      // The field came back null without an error: treat as empty and stop.
      break;
    }
    for (const edge of connection.edges ?? []) {
      if (edge?.node) {
        rows.push(edge.node);
      }
    }
    const hasNext = connection.pageInfo?.hasNextPage === true;
    const endCursor = connection.pageInfo?.endCursor ?? null;
    if (!hasNext || !endCursor) {
      break;
    }
    cursor = endCursor;
    if (page === maxPages - 1) {
      // The cap was reached while the API still had more: the rows are a prefix.
      truncated = true;
    }
  }

  return {
    label,
    outcome: lastError ? 'ERROR' : rows.length > 0 ? 'ROWS' : 'EMPTY',
    rows,
    error: lastError,
    latencyMs,
    pages,
    retries,
    truncated,
    mode: 'curated',
  };
}

// ---------------------------------------------------------------------------
// Curated query shapes (typed results)
// ---------------------------------------------------------------------------

export interface GraphUser {
  __typename?: string;
  accountId?: string;
  name?: string;
}

export interface GraphTeam {
  __typename?: string;
  id?: string;
  displayName?: string;
}

export interface GraphPage {
  __typename?: string;
  id?: string;
  pageId?: string;
  title?: string;
  lastUpdatedAt?: string;
  status?: string;
  webUrl?: string;
  space?: { key?: string; name?: string; id?: string } | null;
}

export interface GraphWorkItem {
  __typename?: string;
  id?: string;
  key?: string;
  summary?: string;
  status?: { name?: string; statusCategory?: { key?: string } | null } | null;
  webUrl?: string;
  createdAt?: string;
}

const USER_SELECTION = '... on AtlassianUser { accountId name }';
const TEAM_SELECTION = '... on AtlassianTeam { id displayName }';

/** Teams linked to a Confluence or Jira space — the routing hop for owners. */
export function fetchTeamsBySpace(spaceAri: string, asAccountId?: string): Promise<GraphRead<GraphTeam>> {
  return fetchConnection<GraphTeam>(
    'atlassianTeamsBySpace',
    'atlassianTeamsBySpace',
    'spaceAri: $id',
    { id: spaceAri },
    TEAM_SELECTION,
    asAccountId,
  );
}

/** Teams a user belongs to — the hop that turns an owner into a team. */
export function fetchUserTeams(userAri: string, asAccountId?: string): Promise<GraphRead<GraphTeam>> {
  return fetchConnection<GraphTeam>(
    'atlassianUserInTeams',
    'atlassianUserInTeams',
    'userId: $id',
    { id: userAri },
    TEAM_SELECTION,
    asAccountId,
    1,
  );
}

/** Members of a team — the last hop when deriving an assignee. */
export function fetchTeamMembers(teamAri: string, asAccountId?: string): Promise<GraphRead<GraphUser>> {
  return fetchConnection<GraphUser>(
    'atlassianTeamMembers',
    'atlassianTeamMembers',
    'teamAri: $id',
    { id: teamAri },
    USER_SELECTION,
    asAccountId,
  );
}

/** Owners of a Confluence page. */
export function fetchPageOwners(pageAri: string, asAccountId?: string): Promise<GraphRead<GraphUser>> {
  return fetchConnection<GraphUser>(
    'confluencePageOwners',
    'confluencePageOwners',
    'id: $id',
    { id: pageAri },
    USER_SELECTION,
    asAccountId,
  );
}

/** Contributors to a Confluence page (fallback when a page has no explicit owner). */
export function fetchPageContributors(pageAri: string, asAccountId?: string): Promise<GraphRead<GraphUser>> {
  return fetchConnection<GraphUser>(
    'confluencePageContributors',
    'confluencePageContributors',
    'id: $id',
    { id: pageAri },
    USER_SELECTION,
    asAccountId,
  );
}

/** Spaces linked from a team — used to reverse-trace "who owns this space". */
export function fetchSpacesByTeam(teamAri: string, asAccountId?: string): Promise<GraphRead<GraphPage>> {
  return fetchConnection<GraphPage>(
    'spacesByAtlassianTeam',
    'spacesByAtlassianTeam',
    'teamAri: $id',
    { id: teamAri },
    '... on ConfluenceSpace { id key name } ... on JiraSpace { id key name }',
    asAccountId,
  );
}

export interface GraphComment {
  __typename?: string;
  id?: string;
  /** The comment body. The graph calls it `content`, not `body`. */
  content?: string;
  createdAt?: string;
  webUrl?: string;
  /** `User` exposes `id` (the Atlassian account id), not `accountId`. */
  author?: { id?: string; name?: string } | null;
}

/** Comments on a work item — the hop an approval claim rests on. */
export function fetchWorkItemComments(
  workItemAri: string,
  asAccountId?: string,
): Promise<GraphRead<GraphComment>> {
  return fetchConnection<GraphComment>(
    'jiraWorkItemComments',
    'jiraWorkItemComments',
    'id: $id',
    { id: workItemAri },
    '... on JiraWorkItemComment { id content createdAt webUrl author { id name } }',
    asAccountId,
    1,
  );
}

/** Work items in a Jira space — the population a control is tested against. */
export function fetchSpaceWorkItems(spaceAri: string, asAccountId?: string): Promise<GraphRead<GraphWorkItem>> {
  return fetchConnection<GraphWorkItem>(
    'jiraSpaceWorkItems',
    'jiraSpaceWorkItems',
    'spaceAri: $id',
    { id: spaceAri },
    '... on JiraWorkItem { id key summary status { name statusCategory { key } } webUrl createdAt }',
    asAccountId,
  );
}

// ---------------------------------------------------------------------------
// Persisted Cypher queries
// ---------------------------------------------------------------------------

export interface PersistedQueryDraft {
  /** Forge variable that holds the queryKey returned at registration. */
  envVar: string;
  name: string;
  purpose: string;
  cypher: string;
  paramsSchema: ReadonlyArray<{ name: string; type: 'ARI' | 'STRING' | 'INTEGER' | 'BOOLEAN'; required: boolean }>;
  /** What still has to be checked in TWG Labs before this query is registered. */
  validation: string;
}

/**
 * Register both queries once, against this app:
 *
 *   POST https://<site>.atlassian.net/gateway/api/twg/cypher-queries
 *   { "appId": "ari:cloud:ecosystem::app/<id>", "name": "...", "cypher": "...",
 *     "paramsSchema": [...] }
 *
 * → 201 { queryKey }  (resubmitting identical Cypher is safe: 200 + same key)
 * → wait ~1 minute for propagation, then set the Forge variable:
 *   forge variables set ASSUR_QUERY_KEY_EVIDENCE_CHAIN <queryKey>
 *
 * The app never sends Cypher at request time; it sends the key.
 */
export const PERSISTED_QUERIES: Readonly<Record<'evidenceChain' | 'orphanEvidence', PersistedQueryDraft>> = {
  evidenceChain: {
    envVar: 'ASSUR_QUERY_KEY_EVIDENCE_CHAIN',
    name: 'assureloop.evidence-chain',
    purpose:
      'One traversal for work item -> policy page -> owning space -> linked team -> user. ' +
      'The curated catalog has no work-item-to-page field, so this hop must be Cypher.',
    cypher: [
      'MATCH (item:JiraWorkItem {ari: $issueAri})-[:content_entity_links_entity]->(page:ConfluencePage)',
      'OPTIONAL MATCH (space:ConfluenceSpace)-[:confluence_space_has_confluence_page]->(page)',
      'OPTIONAL MATCH (team:AtlassianTeam)-[:atlassian_team_links_space_entity]->(space)',
      'RETURN item.ari AS itemAri, page.ari AS pageAri, page.title AS pageTitle,',
      '       space.ari AS spaceAri, team.ari AS teamAri, team.displayName AS teamName',
    ].join('\n'),
    paramsSchema: [{ name: 'issueAri', type: 'ARI', required: true }],
    validation:
      'Confirm in TWG Labs that (a) content_entity_links_entity is traversable from JiraWorkItem to ' +
      'ConfluencePage for a Jira->Confluence link, and (b) OPTIONAL MATCH is accepted. If the link ' +
      'only exists as a remote link, use the REST fallback in resolvePolicyLinks().',
  },
  orphanEvidence: {
    envVar: 'ASSUR_QUERY_KEY_ORPHAN_EVIDENCE',
    name: 'assureloop.orphan-evidence',
    purpose:
      'Reverse traversal: governance pages that no work item claims. Innovation point — ' +
      '"evidence nobody asserted", which a spreadsheet can never show.',
    cypher: [
      'MATCH (page:ConfluencePage)',
      'WHERE NOT (page)<-[:content_entity_links_entity]-(:JiraWorkItem)',
      'RETURN page.ari AS pageAri, page.title AS pageTitle, page.lastUpdatedAt AS lastUpdatedAt',
      'LIMIT $limit',
    ].join('\n'),
    paramsSchema: [{ name: 'limit', type: 'INTEGER', required: true }],
    validation:
      'Confirm the pattern predicate form is accepted and that scanning all pages is bounded by LIMIT ' +
      'for a demo-sized site. If unsupported, fall back to per-space iteration.',
  },
};

export function queryKeyFor(draft: PersistedQueryDraft): string | undefined {
  const value = process.env[draft.envVar];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** GraphQL document for executing a persisted query by key. */
function customQueryDocument(): string {
  return `query AssureLoop_customQuery($queryKey: String!, $params: CypherRequestParams, $first: Int, $after: String) {
  customQuery(queryKey: $queryKey, queryParams: $params, first: $first, after: $after) {
    edges {
      node {
        columns {
          key
          value {
            __typename
            ... on CypherQueryResultNode { id data { __typename ... on JiraWorkItem { id key } ... on ConfluencePage { id title } ... on ConfluenceSpace { id key name } ... on AtlassianTeam { id displayName } ... on AtlassianUser { accountId name } } }
          }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
}

export type PersistedRow = Record<string, string | null>;

/**
 * Rebuild the object identity for a persisted-query column value.
 *
 * A Cypher result node carries `id` (a page id, an issue id, a team id), not the
 * ARI the trace and SQL store. Flattening `data.id` into a column called `pageAri`
 * therefore put "4128789" where an ARI belonged, and the provenance chain's node
 * identifier stopped resolving. The identity is reconstructed from the node type
 * and the cloud id; an `ari` field is used when the API returns one.
 */
export function persistedIdentity(
  node: { typename?: string | null; id?: string | null; accountId?: string | null; ari?: string | null },
  cloudId?: string,
): string | null {
  if (node.ari && node.ari.startsWith('ari:')) {
    return node.ari;
  }
  const id = node.id ?? node.accountId ?? null;
  if (!id || !cloudId) {
    return null;
  }
  switch (node.typename) {
    case 'JiraWorkItem':
      return `ari:cloud:jira:${cloudId}:issue/${id}`;
    case 'JiraSpace':
      return `ari:cloud:jira:${cloudId}:project/${id}`;
    case 'ConfluencePage':
      return `ari:cloud:confluence:${cloudId}:page/${id}`;
    case 'ConfluenceSpace':
      return `ari:cloud:confluence:${cloudId}:space/${id}`;
    case 'AtlassianTeam':
      return `ari:cloud:identity::team/${id}`;
    case 'AtlassianUser':
      return `ari:cloud:identity::user/${id}`;
    default:
      return null;
  }
}

/**
 * Execute a persisted Cypher query and flatten its columns into plain rows.
 *
 * Limitation (skeleton): only node identity and the handful of scalar fields
 * selected above are returned. Anything richer needs another inline fragment —
 * add it to customQueryDocument() when a view needs the field, rather than
 * widening every query.
 */
export async function executePersistedQuery(
  label: string,
  queryKey: string,
  params: Record<string, unknown>,
  asAccountId?: string,
  cloudId?: string,
): Promise<GraphRead<PersistedRow>> {
  const rows: PersistedRow[] = [];
  let latencyMs = 0;
  let pages = 0;
  let retries = 0;
  let cursor: string | null | undefined;
  let lastError: GraphError | undefined;
  let truncated = false;

  for (let page = 0; page < 4; page += 1) {
    const result = await runGraphQL(
      customQueryDocument(),
      { queryKey, params, first: CURATED_PAGE_SIZE, after: cursor ?? null },
      asAccountId,
    );
    pages += 1;
    latencyMs += result.latencyMs;
    retries += result.retries;
    if (result.error) {
      lastError = result.error;
      break;
    }
    const connection = (result.data?.customQuery ?? null) as
      | ConnectionShape<{
          columns?: Array<{ key?: string; value?: { __typename?: string; id?: string; data?: Record<string, unknown> } | null }>;
        }>
      | null;
    if (!connection) {
      break;
    }
    for (const edge of connection.edges ?? []) {
      const node = edge?.node;
      if (!node) {
        continue;
      }
      const flat: PersistedRow = {};
      for (const column of node.columns ?? []) {
        const key = column?.key;
        if (!key) {
          continue;
        }
        const value = column?.value;
        if (!value) {
          flat[key] = null;
          continue;
        }
        const data = value.data;
        const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
        // Identity first: a node column holds an object, and the caller asked for
        // its ARI (pageAri, spaceAri, …). Only a column that carries no node falls
        // back to a scalar field or the edge id.
        const identity = record
          ? persistedIdentity(
              {
                typename: typeof record.__typename === 'string' ? record.__typename : null,
                id: typeof record.id === 'string' ? record.id : null,
                accountId: typeof record.accountId === 'string' ? record.accountId : null,
                ari: typeof record.ari === 'string' ? record.ari : null,
              },
              cloudId,
            )
          : null;
        const scalar = record
          ? (record.id ?? record.title ?? record.name ?? record.key ?? record.displayName)
          : undefined;
        flat[key] =
          identity ?? (typeof scalar === 'string' ? scalar : (value.id ?? null));
      }
      rows.push(flat);
    }
    const hasNext = connection.pageInfo?.hasNextPage === true;
    const endCursor = connection.pageInfo?.endCursor ?? null;
    if (!hasNext || !endCursor) {
      break;
    }
    cursor = endCursor;
    if (page === 3) {
      // The page cap was reached while the API still had more: the rows are a
      // prefix of the traversal. The curated reads always said this out loud; the
      // persisted route used to return the prefix as if it were the whole answer, so
      // "the traversal found 4 pages" could be read as "the chain has 4 pages".
      truncated = true;
    }
  }

  return {
    label,
    outcome: lastError ? 'ERROR' : rows.length > 0 ? 'ROWS' : 'EMPTY',
    rows,
    error: lastError,
    latencyMs,
    pages,
    retries,
    truncated,
    queryKey,
    mode: 'persisted',
  };
}

// ---------------------------------------------------------------------------
// Scope probes (Diagnostics tab)
// ---------------------------------------------------------------------------

export interface ScopeProbeContext {
  /** An Atlassian user ARI known to be in at least one team (usually the caller). */
  userAri: string;
  /** Any team ARI. */
  teamAri?: string;
  /** Any Confluence page ARI. */
  pageAri?: string;
  /** Any Confluence or Jira space ARI. */
  spaceAri?: string;
  jiraSpaceAri?: string;
  asAccountId?: string;
}

interface ProbeDefinition {
  probe: string;
  objectTypes: readonly string[];
  run: (context: ScopeProbeContext) => Promise<GraphRead<unknown>> | null;
}

/**
 * Each probe reads one or two object types through a curated field. A probe that
 * returns rows proves every object type it touched. A probe that returns nothing
 * proves nothing — by design, because the API cannot tell us why it was empty.
 */
const PROBES: readonly ProbeDefinition[] = [
  {
    probe: 'atlassianUserInTeams',
    objectTypes: ['AtlassianUser', 'AtlassianTeam'],
    run: (context) =>
      fetchConnection<GraphTeam>(
        'atlassianUserInTeams',
        'atlassianUserInTeams',
        'userId: $id',
        { id: context.userAri },
        TEAM_SELECTION,
        context.asAccountId,
        1,
      ),
  },
  {
    probe: 'atlassianTeamMembers',
    objectTypes: ['AtlassianTeam', 'AtlassianUser'],
    run: (context) =>
      context.teamAri
        ? fetchTeamMembers(context.teamAri, context.asAccountId)
        : null,
  },
  {
    probe: 'confluencePageOwners',
    objectTypes: ['ConfluencePage', 'AtlassianUser'],
    run: (context) =>
      context.pageAri ? fetchPageOwners(context.pageAri, context.asAccountId) : null,
  },
  {
    probe: 'atlassianTeamsBySpace',
    objectTypes: ['ConfluenceSpace', 'AtlassianTeam'],
    run: (context) =>
      context.spaceAri ? fetchTeamsBySpace(context.spaceAri, context.asAccountId) : null,
  },
  {
    probe: 'jiraSpaceWorkItems',
    objectTypes: ['JiraSpace', 'JiraWorkItem'],
    run: (context) =>
      context.jiraSpaceAri ? fetchSpaceWorkItems(context.jiraSpaceAri, context.asAccountId) : null,
  },
];

/**
 * Run the probe matrix. This is what turns "our graphs are empty" into
 * "these two scopes were never granted", and it is the fastest way for an
 * installing admin to see what still needs approving.
 */
export async function probeScopes(context: ScopeProbeContext): Promise<ScopeProbeResult[]> {
  const results: ScopeProbeResult[] = [];
  for (const definition of PROBES) {
    const scopes = definition.objectTypes
      .map((type) => OBJECT_TYPE_SCOPE[type])
      .filter((scope): scope is GraphScope => Boolean(scope));
    const pending = definition.run(context);
    if (!pending) {
      results.push({
        probe: definition.probe,
        scopes,
        objectTypes: definition.objectTypes,
        state: 'NOT_PROBED',
        rowCount: 0,
        latencyMs: 0,
      });
      continue;
    }
    const read = await pending;
    // Only a permission failure denies a scope. A throttle, a timeout or a backend
    // 5xx leaves the probe INCONCLUSIVE (with its error kept for Diagnostics): the
    // old code recorded every failed read as DENIED, so a rate limit made the
    // Environment Check ask an admin to grant a permission they had already given.
    const state: ScopeState = read.error
      ? (read.error.cause ?? classifyFailure(read.error.status, read.error.message)) ===
        'PERMISSION_DENIED'
        ? 'DENIED'
        : 'INCONCLUSIVE'
      : read.rows.length > 0
        ? 'PROVEN'
        : 'INCONCLUSIVE';
    results.push({
      probe: definition.probe,
      scopes,
      objectTypes: definition.objectTypes,
      state,
      rowCount: read.rows.length,
      latencyMs: read.latencyMs,
      error: read.error,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// The verdict engine
// ---------------------------------------------------------------------------

export type EvidenceStateName = 'VERIFIED' | 'STALE' | 'MISSING' | 'NOT_VISIBLE' | 'INCOMPLETE';

export interface Verdict {
  requirementId: string;
  state: EvidenceStateName;
  /** One sentence a human can act on. Never generated by an LLM. */
  reason: string;
  missingScopes: EvidenceScope[];
  evidenceAri: string | null;
  ageDays: number | null;
  provenance: ProvenanceHop[];
  /** Notes about the read that do not change the state. */
  notes?: string[];
  /** Why the scan could not finish this claim, when it could not. */
  failures?: ObservationFailure[];
  trace: {
    label: string;
    mode: GraphRead<unknown>['mode'];
    queryKey?: string;
    rowCount: number;
    latencyMs: number;
    retries: number;
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function ageInDays(iso: string, now: Date): number | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return null;
  }
  return Math.max(0, Math.floor((now.getTime() - then) / MS_PER_DAY));
}

function newest(candidates: readonly EvidenceCandidate[]): EvidenceCandidate | null {
  let best: EvidenceCandidate | null = null;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const time = Date.parse(candidate.observedAt);
    if (!Number.isNaN(time) && time > bestTime) {
      best = candidate;
      bestTime = time;
    }
  }
  return best;
}

/**
 * How each claim reads in a sentence ("No <noun> was found").
 *
 * `evidence_type.replace(/_/g, ' ')` produced "No approval independence was found",
 * which is not a sentence a person writes or an auditor reads.
 */
const EVIDENCE_NOUN: Readonly<Record<string, string>> = {
  jira_work_item: 'completed change record',
  approval_comment: 'independent approval',
  policy_page: 'governing policy page',
  test_record: 'test or attestation record',
  pull_request: 'linked pull request',
  deployment: 'deployment record',
  approval_independence: 'approver accountable for the policy',
};

function evidenceNoun(type: string): string {
  return EVIDENCE_NOUN[type] ?? type.replace(/_/g, ' ');
}

/** Read one boolean flag out of a rule's JSON without trusting its shape. */
function ruleFlag(requirement: RequirementRow, key: 'everyItem'): boolean {
  try {
    const parsed = JSON.parse(requirement.rule_json) as Record<string, unknown>;
    return parsed?.[key] === true;
  } catch {
    return false;
  }
}

function describeMissingScopes(scopes: readonly GraphScope[]): string {
  return scopes.join(', ');
}

/**
 * Decide the state of one requirement. Pure function: same inputs, same verdict.
 * That is the point — the LLM never decides, it only narrates.
 */
export function judgeRequirement(input: {
  control: ControlRow;
  requirement: RequirementRow;
  observation: EvidenceObservation;
  ledger: ScopeLedger;
  now: Date;
}): Verdict {
  const { control, requirement, observation, ledger, now } = input;
  const scope = observation.scope;
  const failures = observation.failures ?? [];
  const trace = {
    label: observation.read.label,
    mode: observation.read.mode,
    queryKey: observation.read.queryKey,
    rowCount: observation.candidates.length,
    latencyMs: observation.read.latencyMs,
    retries: observation.read.retries ?? 0,
  };
  const base = {
    requirementId: requirement.id,
    provenance: observation.provenance,
    notes: observation.notes ?? [],
    trace,
  };

  const notVisible = (reason: string, scopes: EvidenceScope[]): Verdict => ({
    ...base,
    state: 'NOT_VISIBLE',
    reason,
    missingScopes: scopes,
    evidenceAri: null,
    ageDays: null,
    failures,
  });

  const incomplete = (reason: string): Verdict => ({
    ...base,
    state: 'INCOMPLETE',
    reason,
    missingScopes: [],
    evidenceAri: null,
    ageDays: null,
    failures,
  });

  const denied = failures.filter((failure) => failure.cause === 'PERMISSION_DENIED');
  const retryable = failures.filter((failure) => failure.retryable);
  const unconfigured = failures.filter((failure) => failure.cause === 'UNCONFIGURED');
  const unsupported = failures.filter((failure) => failure.cause === 'UNSUPPORTED');

  // 1. A permission gap is the first thing to report: it is not the user's fault
  //    and it is the one state that must never read as "no evidence".
  if (denied.length > 0) {
    const scopes = [
      ...new Set(
        denied
          .map((failure) => failure.scope)
          .filter((value): value is EvidenceScope => Boolean(value)),
      ),
    ];
    const named = scopes.length > 0 ? `missing scope: ${scopes.join(', ')}` : 'permission denied';
    return notVisible(
      `${denied[0]?.message ?? 'The graph denied the read'} — ${named}. ` +
        `Nothing was assumed about ${control.code}: an object the app cannot see is not evidence that it is absent.`,
      scopes.length > 0 ? scopes : scope ? [scope] : [],
    );
  }

  // 1b. The programme assumes something this site does not hold (a project or a
  //     space). Nothing could be looked at, so this is "not checked" — but the
  //     cause is setup, and saying NOT_VISIBLE would send the user to ask for a
  //     permission they already granted.
  if (unconfigured.length > 0 && !observation.candidates.some((candidate) => candidate.usable)) {
    return incomplete(
      `${control.code} could not be checked: the programme is not set up for this site ` +
        `(${unconfigured[0]?.message ?? 'the project or space it names does not exist here'}). ` +
        `Bind the programme to a project and a space, then rescan.`,
    );
  }

  // 1c. Nothing on this site could ever supply this kind of evidence (no connector
  //     writes linked pull requests or deployment records). That is not a gap in the
  //     control: it is an unsupported claim, and it is kept out of the gap count.
  if (unsupported.length > 0 && observation.candidates.length === 0) {
    return incomplete(
      `${control.code} cannot be judged from this site: ${unsupported[0]?.message ?? 'no connector supplies this evidence'}. ` +
        `This is an unsupported claim here, not missing evidence.`,
    );
  }

  // 2. A throttled, timed-out or failed read means "not checked", never "absent".
  if (observation.read.outcome === 'ERROR') {
    const error = observation.read.error;
    const cause = error?.cause ?? classifyFailure(error?.status, error?.message ?? '');
    const hinted = (error?.scopes ?? []).filter((value): value is GraphScope =>
      (ALL_GRAPH_SCOPES as readonly string[]).includes(value),
    );
    if (cause === 'PERMISSION_DENIED') {
      return notVisible(
        `The graph rejected the read of ${control.code} evidence: ${error?.message ?? 'permission denied'}.`,
        hinted.length > 0 ? hinted : scope ? [scope] : [],
      );
    }
    return incomplete(
      `${control.code} could not be verified in this scan ` +
        `(${cause}: ${error?.message ?? 'unknown error'}). Retry after the read recovers; ` +
        `this is not evidence that the control failed.`,
    );
  }

  // 2b. A cross-product finding: the graph answered, and its answer is the finding.
  //     Only a graph can produce this one (see 'approval_independence'), and it is
  //     STALE rather than MISSING on purpose — the approval exists and is fresh; what
  //     is absent is the relationship that makes it accountable.
  if (observation.crossProductFinding) {
    return {
      ...base,
      state: 'STALE',
      reason: observation.crossProductFinding.reason,
      missingScopes: [],
      evidenceAri: observation.crossProductFinding.evidenceAri ?? null,
      ageDays: null,
      failures,
    };
  }

  const usable = observation.candidates.filter((candidate) => candidate.usable);
  const rejected = observation.candidates.filter((candidate) => !candidate.usable);

  // Population arithmetic. A claim is judged over a set of objects (twelve changes, one
  // policy page), and the verdict has to say how much of that set it read and how many
  // of it qualified. `populationTotal`/`populationJudged` are optional: an observation
  // that does not report them falls back to the old sentence, never to an invented
  // denominator.
  const populationTotal =
    typeof observation.populationTotal === 'number' && observation.populationTotal > 0
      ? observation.populationTotal
      : null;
  const populationJudged =
    populationTotal === null
      ? null
      : typeof observation.populationJudged === 'number'
        ? Math.min(observation.populationJudged, populationTotal)
        : Math.min(observation.candidates.length, populationTotal);
  const everyItem = ruleFlag(requirement, 'everyItem');
  const coverage =
    populationTotal !== null && populationJudged !== null
      ? ` ${usable.length} of ${populationTotal} ${evidenceNoun(requirement.evidence_type)} object(s) qualify` +
        (populationJudged < populationTotal ? ` (${populationJudged} were read)` : '')
      : '';

  // 3. Nothing usable — but is it absent, invisible, or merely unchecked?
  if (usable.length < Math.max(1, requirement.min_count)) {
    if (observation.populationUnread) {
      return incomplete(
        `The population for ${control.code} could not be read at all in this scan, so no claim is made either way.`,
      );
    }
    // An empty project is not a failing control. A judge's fresh site holds no
    // labelled change and no completed change, and the old verdict for that was
    // MISSING — nineteen red rows saying "your controls are failing" about a site
    // where nothing has happened yet. Nothing to judge is a third thing, and it
    // says so.
    if (observation.populationEmpty) {
      return incomplete(
        `Nothing to judge yet for ${control.code}: this project holds no work item with the control's label ` +
          `and no completed change, so there is no population to test. Open or close a change in the project ` +
          `(or label one ${control.jira_label}) and recheck.`,
      );
    }
    if (scope !== null && !scopeIsProven(ledger, scope) && observation.visibilityProven !== true) {
      return notVisible(
        `No usable evidence was returned for ${control.code}, and this scan could not prove read access to ` +
          `${scope}. The graph fails closed, so this may be a permission gap rather than missing evidence. ` +
          `Ask an organisation admin to grant ${scope}.`,
        [scope],
      );
    }
    // A claim the graph answered nothing about is "not checked", not "missing" — but
    // only once the scope question above has had its answer (an unproven scope is
    // NOT_VISIBLE, which names what to grant).
    if (observation.uncheckedReason) {
      return incomplete(observation.uncheckedReason);
    }
    if (retryable.length > 0 || observation.indexingDelay) {
      return incomplete(
        observation.indexingDelay
          ? `${observation.indexingDelay ? 'The object is not in the graph index yet' : 'A read failed'} — ` +
              `${control.code} cannot be judged until the index catches up. Rescan in a few minutes.`
          : `No usable evidence came back for ${control.code}, but ${retryable[0]?.cause ?? 'a read'} ` +
              `prevented part of the scan (${retryable[0]?.message ?? 'no detail'}). ` +
              `An unchecked requirement is not a missing one.`,
      );
    }
    const whyRejected = rejected.length > 0 ? rejected[0]?.unusableReason : undefined;
    // "Nothing was found" is only true when nothing was found. With one of two
    // required objects present, the honest sentence is a shortfall — an audit pack
    // that says "no evidence exists" next to a counted row is the kind of sentence
    // a reviewer stops at.
    const required = Math.max(1, requirement.min_count);
    const shortfall = usable.length > 0 && usable.length < required;
    return {
      ...base,
      state: 'MISSING',
      reason: whyRejected
        ? `${whyRejected} (${rejected.length} object(s) found but none qualified for ${control.code}).`
        : shortfall
          ? `Only ${usable.length} of the ${required} required ${evidenceNoun(requirement.evidence_type)} object(s) ` +
            `qualified for ${control.code}; ${required - usable.length} more ${required - usable.length === 1 ? 'is' : 'are'} needed. ` +
            `This is a shortfall, not an absence of evidence.`
          : `No ${evidenceNoun(requirement.evidence_type)} was found for ${control.code}, and visibility is ` +
            `established — so the evidence really is absent.`,
      missingScopes: [],
      evidenceAri: null,
      ageDays: null,
      failures,
    };
  }

  // 3. A universal claim needs every object to qualify.
  //
  //    "Every production change carries an independent approval" was judged with
  //    `min_count: 1`, so one approved change made the claim true while eleven
  //    unapproved changes sat in the same population. A rule that says `everyItem`
  //    passes only when every object that was read qualified (and, below, only when
  //    the whole population was read).
  if (everyItem && populationTotal !== null && populationJudged !== null) {
    if (observation.truncated === true) {
      return incomplete(
        `${control.code} claims every one of its ${populationTotal} ` +
          `${evidenceNoun(requirement.evidence_type)} object(s), but this run read only ${populationJudged}` +
          `${observation.truncationNote ? ` (${observation.truncationNote})` : ''}. ` +
          `A partial read is not a universal verdict: rescan when the full population can be read.`,
      );
    }
    if (usable.length < populationJudged) {
      const firstFault = rejected[0];
      return {
        ...base,
        state: 'MISSING',
        reason:
          `${control.code} claims every one of its ${populationTotal} ` +
          `${evidenceNoun(requirement.evidence_type)} object(s); ${usable.length} of ${populationJudged} read qualified` +
          `${firstFault ? ` (${firstFault.label ?? firstFault.ari}: ${firstFault.unusableReason ?? 'did not qualify'})` : ''}. ` +
          `The claim is universal, so one object without it is a gap, not a pass.`,
        missingScopes: [],
        evidenceAri: null,
        ageDays: null,
        failures,
      };
    }
  }

  // 3. Freshness.
  const freshest = newest(usable);
  const age = freshest ? ageInDays(freshest.observedAt, now) : null;
  if (age === null) {
    return notVisible(
      `Evidence for ${control.code} exists but carries no readable timestamp, so freshness cannot be established.`,
      scope ? [scope] : [],
    );
  }
  if (age > requirement.max_age_days) {
    return {
      ...base,
      state: 'STALE',
      reason:
        `${freshest?.label ?? 'The evidence'} was last updated ${age} days ago; ${control.code} requires ` +
        `evidence no older than ${requirement.max_age_days} days.`,
      missingScopes: [],
      evidenceAri: freshest?.ari ?? null,
      ageDays: age,
      failures,
    };
  }

  // 4. The graph must name who is accountable. This is the hop that makes the
  //    product a graph product rather than a REST checklist: Confluence can prove a
  //    page exists and how old it is, but only the ownership hop (a Teamwork Graph
  //    traversal) can say who answers for it. With no owner resolved, a policy is
  //    evidence nobody is on the hook for — STALE, with the missing hop named — and
  //    that verdict is what disappears if the graph is taken away.
  //
  //    A hop that could not be *read* is not the same thing, and calling it "nobody is
  //    accountable" asserts something the scan never saw. It is INCOMPLETE, with the
  //    cause, until the read answers.
  if (observation.accountabilityUnread) {
    const failure = failures.find((entry) => entry.cause !== 'UNSUPPORTED');
    const scopeNote = failure?.scope ? ` Scope: ${failure.scope}.` : '';
    return incomplete(
      `${freshest?.label ?? 'The evidence'} for ${control.code} is current (${age} day(s) old), but the ` +
        `ownership hop could not be read (${failure?.cause ?? 'UNKNOWN'}: ${failure?.message ?? 'no detail'}).` +
        `${scopeNote} An unread accountability hop is not “nobody owns it” — rescan when the graph answers.`,
    );
  }
  const unresolvedOwner = usable.find((candidate) => candidate.ownershipResolved === false);
  if (unresolvedOwner) {
    // "Nobody is accountable" may only be said by a scan that has proven it can
    // read ownership at all.
    //
    // The graph fails closed: a scope that was not granted answers with an empty,
    // successful result, which is indistinguishable from a page that really has no
    // owner. Until this rule existed, revoking `read:graph:page:confluence` turned a
    // fresh, owned policy into the finding "nobody is accountable" — the exact
    // opposite of the product's promise. Where the scope is unproven the claim is
    // NOT_VISIBLE and names the scope; where a scan has proven it, an ownerless page
    // is STALE, and that STALE is a real finding.
    if (scope !== null && !scopeIsProven(ledger, scope)) {
      return notVisible(
        `${unresolvedOwner.label ?? 'The evidence'} is current (${age} day(s) old), but this run could not prove it can read ` +
          `${scope}: the ownership hop returned nothing and so did Confluence's own owner fields. The graph fails ` +
          `closed, so an empty answer cannot be read as an ownerless page here. Grant ${scope} and rescan — a proven ` +
          `read that still names nobody is the finding, and it will be reported as stale.`,
        [scope],
      );
    }
    return {
      ...base,
      state: 'STALE',
      reason:
        `${unresolvedOwner.label ?? 'The evidence'} is current (${age} day(s) old), but nobody is named as accountable ` +
        `for it: the ownership hop (confluencePageOwners) named nobody, and Confluence's own owner fields are empty, ` +
        `so nobody is accountable for ${control.code}. REST proves the object exists; the claim needs a named owner.`,
      missingScopes: [],
      evidenceAri: unresolvedOwner.ari,
      ageDays: age,
      failures,
    };
  }

  // 4b. Ownership still alive (only when we actually know).
  const deadOwner = usable.find((candidate) => candidate.ownerActive === false);
  if (deadOwner) {
    return {
      ...base,
      state: 'STALE',
      reason:
        `Evidence for ${control.code} is current, but its owner ${deadOwner.ownerName ?? deadOwner.ownerAccountId ?? '(unknown)'} ` +
        `is deactivated — nobody is accountable for it.`,
      missingScopes: [],
      evidenceAri: deadOwner.ari,
      ageDays: age,
      failures,
    };
  }

  return {
    ...base,
    state: 'VERIFIED',
    reason:
      `Verified:${coverage || ` ${usable.length} qualifying evidence object(s)`}, freshest ${age} day(s) old ` +
      `(limit ${requirement.max_age_days}).` +
      (retryable.length > 0
        ? ` ${retryable.length} read(s) needed a retry, but every object the claim depends on was returned.`
        : '') +
      (observation.truncated === true
        ? ` The read stopped after ${populationJudged ?? usable.length} of ${populationTotal ?? usable.length}` +
          ` object(s)${observation.truncationNote ? ` (${observation.truncationNote})` : ''}; the verdict covers what was read.`
        : ''),
    missingScopes: [],
    evidenceAri: freshest?.ari ?? null,
    ageDays: age,
    failures,
  };
}

export function summarizeVerdicts(verdicts: readonly Verdict[]): {
  VERIFIED: number;
  STALE: number;
  MISSING: number;
  NOT_VISIBLE: number;
  INCOMPLETE: number;
} {
  const counts = { VERIFIED: 0, STALE: 0, MISSING: 0, NOT_VISIBLE: 0, INCOMPLETE: 0 };
  for (const verdict of verdicts) {
    counts[verdict.state] += 1;
  }
  return counts;
}

/** Human-readable label for a scope, used in UI copy and diagnostics tables. */
export function scopeExplanation(scope: EvidenceScope): string {
  switch (scope) {
    case GRAPH_SCOPES.WORK_ITEM:
      return 'Jira work items (read:graph:issue:jira)';
    case GRAPH_SCOPES.COMMENT:
      return 'Jira comments (read:graph:issue-comment:jira)';
    case GRAPH_SCOPES.JIRA_SPACE:
      return 'Jira spaces/projects (read:graph:project:jira)';
    case GRAPH_SCOPES.PAGE:
      return 'Confluence pages (read:graph:page:confluence)';
    case GRAPH_SCOPES.CONFLUENCE_SPACE:
      return 'Confluence spaces (read:graph:space:confluence)';
    case GRAPH_SCOPES.USER:
      return 'Atlassian users (read:graph:user:atlassian)';
    case GRAPH_SCOPES.TEAM:
      return 'Atlassian teams (read:graph:team:atlassian)';
    case REST_SCOPES.JIRA_WORK:
      return 'Jira REST reads — the work item, its comments, remediation writes (read:jira-work)';
    case REST_SCOPES.PAGE:
      return 'Confluence REST page and space reads (read:page:confluence)';
    case REST_SCOPES.CONTENT:
      return 'Confluence content reads (read:confluence-content.all)';
    default:
      return scope;
  }
}

export { describeMissingScopes };
