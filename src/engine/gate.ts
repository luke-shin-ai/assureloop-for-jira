/**
 * The Evidence Gate: one work item, its control, its claims — judged live.
 *
 * This is the product's front door (E1). Opening an issue must not need a scan
 * button, a seed script or a dashboard: the panel asks the graph and REST for
 * what this specific change must prove, and shows the verdict per claim with the
 * receipts behind it.
 *
 * Three rules decide the code here:
 *   1. Never invent visibility. A read that failed is reported with its cause.
 *   2. Never call an unchecked claim missing (E4): throttle, timeout, index lag
 *      and backend 403 are INCOMPLETE, and permission gaps are NOT_VISIBLE.
 *   3. Every verdict carries its chain, so "why?" is answerable without a call
 *      to an LLM (E2).
 *
 * It deliberately does not depend on Forge SQL: the gate is also what the Rovo
 * actions call, and agent invocations can land on an installation whose SQL is
 * not reachable (home chat routing). Persistence is an optimisation, not a
 * prerequisite.
 */

import {
  confluencePageAri,
  pageByTitle,
  pageOwner,
  spaceIdByKey,
  spaceAri as confluenceSpaceAri,
  type ConfluencePageSummary,
} from '../confluence/rest';
import {
  getIssue,
  issueComments,
  issueRemoteLinks,
  jqlSearch,
  userAri,
  type JiraComment,
  type JiraIssueDetail,
  type JiraUser,
} from '../jira/rest';
import {
  ACTION_RETRY_POLICY,
  GRAPH_SCOPES,
  PERSISTED_QUERIES,
  REST_SCOPES,
  buildScopeLedger,
  classifyFailure,
  executePersistedQuery,
  fetchPageOwners,
  fetchTeamMembers,
  fetchTeamsBySpace,
  fetchUserTeams,
  isGraphScope,
  isRetryable,
  judgeRequirement,
  queryKeyFor,
  scopeExplanation,
  scopeProbeFromObservation,
  summarizeVerdicts,
  type EvidenceCandidate,
  type EvidenceObservation,
  type EvidenceScope,
  type EvidenceStateName,
  type FailureCause,
  type GraphScope,
  type ObservationFailure,
  type ProvenanceHop,
  type ScopeLedger,
  type ScopeProbeResult,
  type Verdict,
} from '../twg/queries';
import { buildTrace, type TraceGraph } from '../trace/graph';
import {
  getControlByCode,
  listControls,
  listRequirements,
  parseRule,
  type ControlRow,
  type EvidenceType,
  type RequirementRow,
  type StateCounts,
} from '../schema/sql';
import { NORTHWIND_PAY, jiraIssueAri } from '../seed/northwind-pay';
import { AUDIT_GUARANTEES } from '../audit/pack';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Registry access — SQL first, shipped programme second
// ---------------------------------------------------------------------------

/**
 * The control registry, from Forge SQL when it answers, from the shipped
 * programme when it does not.
 *
 * The fallback is what makes the gate zero-config and stateless: a fresh install
 * with an empty database still knows what AC-01 claims, because the programme is
 * part of the app. A Rovo action invoked from home chat (where Forge SQL may not
 * be reachable) gets the same answer as the panel.
 */
export async function registryControls(): Promise<ControlRow[]> {
  try {
    const { ensureSchema } = await import('../schema/sql');
    await ensureSchema();
    const rows = await listControls();
    if (rows.length > 0) {
      return rows;
    }
  } catch {
    // No Forge SQL on this invocation (or the installation is not migrated yet):
    // the shipped programme is the stateless answer.
  }
  return NORTHWIND_PAY.controls.map((control, index) => ({
    id: `programme:${control.code}`,
    code: control.code,
    name: control.name,
    regulation_ref: control.regulationRef,
    cadence: control.cadence,
    risk_tier: control.riskTier,
    jira_label: control.jiraLabel,
    jira_project_key: NORTHWIND_PAY.jiraProjectKey,
    owner_account_id: null,
    owner_display_name:
      NORTHWIND_PAY.owners.find((owner) => owner.email === control.ownerEmail)?.name ?? null,
    status: 'ACTIVE' as const,
    _index: index,
  })) as ControlRow[];
}

/** Requirements for a control, with the same fallback. */
export async function registryRequirements(control: ControlRow): Promise<RequirementRow[]> {
  try {
    const { ensureSchema } = await import('../schema/sql');
    await ensureSchema();
    const rows = await listRequirements(control.id);
    if (rows.length > 0) {
      return rows;
    }
  } catch {
    // Same fallback as above: the programme is part of the app.
  }
  const programme = NORTHWIND_PAY.controls.find((entry) => entry.code === control.code);
  return (programme?.requirements ?? []).map((requirement, index) => ({
    id: `programme:${control.code}:${requirement.evidenceType}:${index}`,
    control_id: control.id,
    evidence_type: requirement.evidenceType,
    max_age_days: requirement.maxAgeDays,
    min_count: requirement.minCount,
    rule_json: JSON.stringify(requirement.rule),
  }));
}

export interface GateEvidence {
  ari: string | null;
  label: string | null;
  observedAt: string | null;
  url: string | null;
  owner: string | null;
  /** False when the ownership hop named nobody; null when it was not attempted. */
  ownerResolved?: boolean | null;
}

export interface GateRequirement {
  requirementId: string;
  evidenceType: EvidenceType;
  /** Short, human name of what is claimed. */
  claim: string;
  expectation: string | null;
  maxAgeDays: number;
  state: EvidenceStateName;
  reason: string;
  ageDays: number | null;
  evidence: GateEvidence | null;
  missingScopes: Array<{ scope: string; explanation: string }>;
  failures: Array<{ cause: FailureCause; message: string; scope?: EvidenceScope }>;
  /** Notes about the read that do not change the state (e.g. persisted fallback). */
  notes: string[];
  trace: {
    graph: TraceGraph;
    queryKey: string | null;
    rows: number;
    latencyMs: number;
    retries: number;
    mode: string;
    label: string;
    notes: string[];
    /**
     * The persisted Cypher traversal, when it ran. It is a second read with its own
     * row count and latency, so it is reported as one instead of being folded into
     * the curated numbers above.
     */
    persisted?: {
      used: boolean;
      rows: number;
      latencyMs: number;
      queryKey: string | null;
    };
  };
}

export type GateBadge = 'PASS' | 'GAPS' | 'UNVERIFIABLE' | 'PARTIAL' | 'NOT_EVALUATED';

export interface IssueGate {
  /** What the pack this gate feeds guarantees, and what it does not. */
  guarantees?: { does: string[]; doesNot: string[] };
  issue: {
    key: string;
    id: string;
    summary: string;
    status: string;
    statusCategory: string;
    assignee: { accountId: string; name: string; active: boolean } | null;
    projectKey: string;
    labels: string[];
    updated: string;
    webUrl: string | null;
  } | null;
  control: {
    code: string;
    name: string;
    regulationRef: string;
    cadence: string;
    riskTier: string;
    owner: string | null;
    claimed: boolean;
  } | null;
  /** Controls that could claim this issue but have not been linked to it yet. */
  suggestedControls: Array<{ code: string; name: string }>;
  badge: { state: GateBadge; label: string; detail: string };
  counts: StateCounts;
  requirements: GateRequirement[];
  gaps: number;
  integrity: { checked: number; incomplete: number; notVisible: number; retried: number; durationMs: number };
  note: string | null;
}

const CLAIM_LABEL: Readonly<Record<EvidenceType, string>> = {
  jira_work_item: 'Completed change record',
  approval_comment: 'Independent approval',
  policy_page: 'Governing policy',
  test_record: 'Test or attestation record',
  pull_request: 'Linked pull request',
  deployment: 'Deployment record',
  approval_independence: 'Approval accountability',
};

function failureOf(
  cause: FailureCause,
  message: string,
  scope?: EvidenceScope,
): ObservationFailure {
  return { cause, message, scope, retryable: isRetryable(cause) };
}

function restFailure(status: number, message: string, scope?: EvidenceScope): ObservationFailure {
  const cause = classifyFailure(status, message);
  return failureOf(cause, message, scope);
}

// ---------------------------------------------------------------------------
// Approval language: an approval that is stated, not one that is mentioned
/// ---------------------------------------------------------------------------

/**
 * "Approved" and "not approved" are the same word to a regex, and an audit claim
 * cannot afford that: a comment saying "this is not approved yet" or "approval was
 * rejected" used to satisfy the independent-approval claim. A match only counts when
 * nothing immediately before or after it withdraws or postpones it.
 *
 * Phrases that are approvals in plain English but contain a negation word are
 * neutralised first ("no objections — approved").
 *
 * v6.35: a request is not an approval either. v6.34 and earlier accepted
 * "Seeking approval from legal", "Requesting approval before deploy", "Approval not
 * granted" and "approved? no" as approvals, because the guard only looked for
 * negations. Requests and approvals-in-progress are excluded now, and the eight
 * cases in that table are pinned by test/v635.regressions.cjs.
 *
 * v6.49: the guard looked only at what came *immediately* after the approval word, so
 * "Approval from Legal pending", "Approval requested from security", "Approval was
 * sought", "Approval deferred", "Approval: none", "Approval to deploy: not yet",
 * "Tentatively approved" and "approved, but not for prod" all counted as approvals: the
 * word order was reversed, and a noun phrase in between was enough to hide the state.
 * The rule is now two-sided and clause-wide: a state word anywhere in the clause that
 * follows the approval word (up to the sentence end) withdraws it, and the words that
 * precede it are read the same way. test/v640.regressions.cjs pins the 17 cases.
 */
const AFFIRMATIVE_EXCEPTIONS = /\bno\s+(?:objections?|concerns?|blockers?|issues?|problem)\b/gi;

/**
 * Words that turn the approval word into something that has not happened yet.
 *
 * "Seeking approval from legal", "Requesting approval before deploy", "awaiting
 * approval", "for approval", "approval required" are all requests or requirements.
 * They were read as approvals because the negation list only held negations; a
 * request is not a negation, and the most important evidence in a bank change
 * process (an independent approval) was being satisfied by a comment asking for
 * one.
 */
const REQUEST_BEFORE =
  /\b(?:seek(?:s|ing)?|sought|request(?:s|ed|ing)?|ask(?:s|ed|ing)?|await(?:s|ed|ing)?|pending|waiting|for|need(?:s|ed)?|requir(?:e|es|ed|ing)|rais(?:e|ed|ing)|draft(?:s|ed|ing)?|propos(?:e|ed|es|ing)|intend(?:s|ed|ing)?|consider(?:s|ed|ing)?|tentative(?:ly)?|provisional(?:ly)?|conditionally|possibly|maybe|perhaps|subject\s+to|conditional\s+on|prior\s+to|before|until)\b[^.!?\n]{0,40}$/i;

const NEGATION_BEFORE =
  /\b(?:not|no|never|cannot|can't|isn't|wasn't|aren't|without|reject(?:ed|s|ing)?|declin(?:ed|es|ing)|deni(?:ed|es|ing)|withheld|withdrawn|withdraw|revoked|revoke|lack(?:s|ing)?|fail(?:ed|s)?|miss(?:ed|ing)?)\b[^.!?\n]{0,48}$/i;

/**
 * What follows the approval word. A question mark and a "no" after it counts
 * ("approved? no"), and so does anything that makes the approval a state rather
 * than an event ("approval not granted", "approval was denied", "approved
 * subject to sign-off").
 */
const NEGATION_AFTER =
  /^\s*[?.!,;:—–\-\s]*(?:(?:was|is|are|has\s+been|had\s+been|been|were|will\s+be)\s+)?(?:not\b|no\b|never\b|n't\b|rejected|declined|denied|withdrawn|revoked|withheld|pending|missing|required|needed|outstanding|none|deferred|subject\s+to|conditional\s+on)\b/i;

/**
 * The clause after the approval word, up to the end of that sentence.
 *
 * A state can sit behind a noun phrase ("Approval from Legal pending") or behind a
 * copula ("Approval was sought"), so an anchored pattern is not enough. These are the
 * phrasings that describe an approval that has not happened, is not wanted, or is only
 * hoped for. They are deliberately specific: "Approved, and no further review is
 * needed" must stay an approval, so a bare "no" or "needed" is not on this list.
 */
const APPROVAL_STATE_AFTER = new RegExp(
  [
    '\\b(?:is|are|was|were|remains?|still|currently)\\s+pending\\b',
    '\\bpending\\b',
    '\\b(?:was|were|is|are|has been|had been|been)\\s+(?:requested|sought|deferred|declined|denied|withdrawn|withheld|revoked|rejected)\\b',
    '\\b(?:requested|sought|deferred|declined|denied|withdrawn|withheld|revoked|rejected)\\b',
    '\\bnot\\s+yet\\b',
    '\\bnot\\s+for\\s+(?:prod|production|release)\\b',
    '\\bnot\\s+(?:granted|given|signed\\s+off|obtained|received|in\\s+place)\\b',
    '\\bnone\\b',
    '\\bon\\s+hold\\b',
    '\\bawaiting\\b',
    '\\boutstanding\\b',
    '\\bsubject\\s+to\\b',
    '\\bconditional\\s+on\\b',
    '\\bto\\s+be\\s+(?:approved|confirmed|sought|requested)\\b',
    '^\\s*[?.!,;:\\s]*please\\b[\\s?!.]*$',
    '^\\s*[?.!,;:\\s]*(?:tbd|n/?a|unknown)\\b',
  ].join('|'),
  'i',
);

/**
 * Where the sentence around an approval word ends. A full stop, a semicolon or a line
 * break ends it; a question or exclamation mark does not, because "approved? no" is
 * one thought and the `no` is what withdraws it.
 */
const SENTENCE_END = /[.;\n]/;

/**
 * True when the comment body *states* an approval the rule accepts.
 *
 * Deterministic and rule-only: the pattern comes from the requirement, the negation
 * handling is fixed here, and no model reads the comment.
 */
export function statesApproval(text: string, pattern: RegExp): boolean {
  if (!text) {
    return false;
  }
  const cleaned = text.replace(AFFIRMATIVE_EXCEPTIONS, ' ');
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  let scanning: RegExp;
  try {
    scanning = new RegExp(pattern.source, flags);
  } catch {
    scanning = new RegExp(pattern.source, 'gi');
  }
  for (const match of cleaned.matchAll(scanning)) {
    const index = match.index ?? 0;
    if (match[0].length === 0) {
      continue;
    }
    const before = cleaned.slice(Math.max(0, index - 64), index);
    // The rest of the sentence, not the rest of the comment: a later sentence that
    // discusses pending work must not withdraw an approval stated in this one.
    const rest = cleaned.slice(index + match[0].length);
    const end = rest.search(SENTENCE_END);
    const clause = (end === -1 ? rest : rest.slice(0, end)).slice(0, 120);
    const after = clause.slice(0, 48);
    if (
      NEGATION_BEFORE.test(before) ||
      REQUEST_BEFORE.test(before) ||
      NEGATION_AFTER.test(after) ||
      APPROVAL_STATE_AFTER.test(clause)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/** A stable, honest URL for the evidence, when the site context gives us one. */
function evidenceUrl(siteUrl: string | null, webPath: string | null): string | null {
  if (!webPath) {
    return null;
  }
  if (/^https?:\/\//.test(webPath)) {
    return webPath;
  }
  return siteUrl ? `${siteUrl.replace(/\/$/, '')}${webPath}` : null;
}

// ---------------------------------------------------------------------------
// Observations for one work item
// ---------------------------------------------------------------------------

interface ObservationContext {
  cloudId: string;
  siteUrl: string | null;
  issue: JiraIssueDetail;
  issueAri: string;
  /** Whose eyes to borrow when the app's own identity cannot see Confluence. */
  accountId?: string | null;
}

async function observeWorkItemClaim(
  context: ObservationContext,
  requirement: RequirementRow,
): Promise<EvidenceObservation> {
  const started = Date.now();
  const rule = parseRule(requirement.rule_json);
  const issue = context.issue;
  const done = issue.statusCategoryKey === 'done';
  const usable = rule.requiresDoneStatus === true ? done : true;
  const candidate: EvidenceCandidate = {
    ari: context.issueAri,
    kind: 'jira_issue',
    label: issue.key,
    observedAt: issue.updated,
    ownerAccountId: issue.assigneeAccountId,
    ownerName: issue.assigneeName,
    ownerActive: issue.assigneeActive,
    usable,
    unusableReason: usable
      ? undefined
      : `${issue.key} is still ${issue.statusName} — the change was not completed`,
  };
  return {
    requirementId: requirement.id,
    evidenceType: requirement.evidence_type,
    scope: null,
    read: {
      label: `jira:${issue.key}`,
      mode: 'rest',
      outcome: 'ROWS',
      latencyMs: Date.now() - started,
      retries: 0,
    },
    candidates: [candidate],
    provenance: [
      {
        hop: 1,
        fromAri: `${issue.projectKey}:work-items`,
        relation: 'jira_work_item_in_project',
        toAri: context.issueAri,
        observedAt: issue.updated,
        source: 'rest',
      },
    ],
    subjectAri: context.issueAri,
    failures: [],
  };
}

async function observeApprovalClaim(
  context: ObservationContext,
  requirement: RequirementRow,
): Promise<EvidenceObservation> {
  const started = Date.now();
  const rule = parseRule(requirement.rule_json);
  const pattern = new RegExp(rule.approvalPattern ?? '\\b(approved|approval|lgtm)\\b', 'i');
  const { comments, error } = await issueComments(context.issue.key);
  const failures: ObservationFailure[] = [];
  if (error) {
    // An approval lives in Jira REST, so the permission that unblocks it is the
    // Jira REST scope — not a graph scope. Naming a graph scope here sent the admin
    // to a toggle that could not help (C10).
    failures.push(restFailure(error.status, error.message, REST_SCOPES.JIRA_WORK));
  }
  const approving: JiraComment | undefined = comments
    .filter((comment) => statesApproval(comment.bodyText, pattern))
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];

  const candidates: EvidenceCandidate[] = [];
  const provenance: ProvenanceHop[] = [];

  if (approving) {
    const selfApproved =
      rule.requiresIndependentApprover === true &&
      approving.authorAccountId !== null &&
      approving.authorAccountId === context.issue.assigneeAccountId;
    const commentAri = `ari:cloud:jira:${context.cloudId}:comment/${approving.id}`;
    candidates.push({
      ari: commentAri,
      kind: 'approval_comment',
      label: `Approval by ${approving.authorName ?? 'unknown'}`,
      observedAt: approving.created,
      ownerAccountId: approving.authorAccountId,
      ownerName: approving.authorName,
      ownerActive: approving.authorActive,
      usable: !selfApproved,
      unusableReason: selfApproved
        ? `${context.issue.key} was approved by its own assignee (${approving.authorName ?? 'unknown'}) — segregation of duties is not evidenced`
        : undefined,
    });
    provenance.push({
      hop: 1,
      fromAri: context.issueAri,
      relation: 'jira_work_item_has_jira_work_item_comment',
      toAri: commentAri,
      observedAt: approving.created,
      source: 'rest',
    });
    if (approving.authorAccountId) {
      provenance.push({
        hop: 2,
        fromAri: commentAri,
        relation: 'jira_work_item_comment_authored_by_atlassian_user',
        toAri: userAri(approving.authorAccountId),
        observedAt: approving.created,
        source: 'rest',
      });
    }
  } else if (!error) {
    // An issue with no approving comment is a real gap, not a blind spot: the
    // comments were read successfully and none qualified.
    candidates.push({
      ari: context.issueAri,
      kind: 'approval_comment',
      label: `${context.issue.key} approval`,
      observedAt: context.issue.updated,
      ownerAccountId: context.issue.assigneeAccountId,
      ownerName: context.issue.assigneeName,
      ownerActive: context.issue.assigneeActive,
      usable: false,
      unusableReason: `${context.issue.key} has no comment matching the approval pattern`,
    });
  }

  return {
    requirementId: requirement.id,
    evidenceType: requirement.evidence_type,
    scope: null,
    read: {
      label: `jira-comments:${context.issue.key}`,
      mode: 'rest',
      outcome: error ? 'ERROR' : 'ROWS',
      latencyMs: Date.now() - started,
      error: error
        ? {
            message: error.message,
            status: error.status,
            cause: classifyFailure(error.status, error.message),
          }
        : undefined,
      retries: 0,
    },
    candidates,
    provenance,
    subjectAri: context.issueAri,
    failures,
  };
}

/**
 * Evidence a connector has to supply: a linked pull request or a deployment record.
 *
 * These claims used to be judged by reading the work item itself, so "Linked pull
 * request" was evidenced by `jira:PAY-1` — an inspector clicking "explain" saw the
 * change ticket presented as its own pull request. The honest read is the work
 * item's remote links, which is where Bitbucket, GitHub and deployment apps put
 * their artefacts:
 *
 *   * a matching link exists  -> usable evidence (the link carries no time of its
 *     own, so freshness is taken from the work item's last update and said so);
 *   * links exist, none of this kind -> MISSING (the site files links, this one is
 *     not there);
 *   * no remote links at all -> UNSUPPORTED: nothing on this site writes them, so
 *     the claim can never be satisfied here and is kept out of the gap count.
 */
async function observeConnectorClaim(
  context: ObservationContext,
  requirement: RequirementRow,
): Promise<EvidenceObservation> {
  const started = Date.now();
  const kind = requirement.evidence_type;
  // The URL decides, not the title.
  //
  // A remote link carries a title and a URL. Matching the title made "Pull request
  // for the payout fix" a linked pull request with no pull request behind it, and
  // the work item's own update time stood in as the artefact's observation time —
  // two hops of invention in one row. Only a URL that belongs to a connector is
  // counted now; a title that merely says so is not evidence (A13).
  const patterns: Record<string, RegExp> = {
    pull_request:
      /\/(?:pull|pulls|merge_requests|pull-requests|pullrequest)\/\d+/i,
    deployment:
      /\/(?:actions\/runs|deployments?|releases?|pipelines?|jobs?)\/|jenkins|argocd|spinnaker|octopus|deploygate/i,
  };
  const pattern = patterns[kind] ?? /./;
  const failures: ObservationFailure[] = [];
  const notes: string[] = [];
  let links: Awaited<ReturnType<typeof issueRemoteLinks>>['links'] = [];
  let readError: { status: number; message: string } | undefined;
  try {
    const read = await issueRemoteLinks(context.issue.key);
    links = read.links;
    readError = read.error;
  } catch (cause) {
    readError = { status: 0, message: cause instanceof Error ? cause.message : String(cause) };
  }
  if (readError) {
    // A 403 here used to be swallowed into "no links", which the gate then read as
    // "no connector writes links on this site" — a permission gap reported as an
    // unsupported claim. The status now travels: 401/403 is NOT_VISIBLE naming
    // read:jira-work, everything else is INCOMPLETE with its cause.
    failures.push(restFailure(readError.status, readError.message, REST_SCOPES.JIRA_WORK));
  } else if (links.length === 0) {
    notes.push(
      `No connector writes remote links to ${context.issue.key}, so no ${kind.replace(/_/g, ' ')} can be linked here. ` +
        `The claim is unsupported on this site rather than unmet.`,
    );
    failures.push(
      failureOf('UNSUPPORTED', `no connector on this site supplies ${kind.replace(/_/g, ' ')} evidence`),
    );
  }

  const matching = links.filter((link) => pattern.test(link.url));
  if (links.length > 0 && matching.length === 0) {
    notes.push(
      `${context.issue.key} has ${links.length} remote link(s), none of them a ${kind.replace(/_/g, ' ')} URL. ` +
        `A link title that names one is not counted: the URL is the evidence.`,
    );
  }
  const candidates: EvidenceCandidate[] = matching.map((link, index) => ({
    ari: `remote-link:${context.issue.key}:${index + 1}`,
    kind,
    label: link.title || link.url,
    // A remote link has no timestamp of its own; the work item's last update is
    // the only observation time this site can prove, and the row says so.
    observedAt: context.issue.updated,
    ownerAccountId: context.issue.assigneeAccountId,
    ownerName: context.issue.assigneeName,
    ownerActive: context.issue.assigneeActive,
    usable: true,
  }));
  if (matching.length > 0) {
    notes.push(
      `The linked artefact has no observation time of its own; freshness is taken from the work item's last update.`,
    );
  }

  const provenance: ProvenanceHop[] = matching.map((link, index) => ({
    hop: index + 1,
    fromAri: context.issueAri,
    relation: kind === 'deployment' ? 'jira_work_item_linked_external_deployment' : 'jira_work_item_linked_external_pull_request',
    toAri: `remote-link:${context.issue.key}:${index + 1}`,
    observedAt: context.issue.updated,
    source: 'rest',
  }));

  return {
    requirementId: requirement.id,
    evidenceType: requirement.evidence_type,
    scope: null,
    read: {
      label: `jira-remotelink:${context.issue.key}`,
      mode: 'rest',
      outcome: readError ? 'ERROR' : 'ROWS',
      latencyMs: Date.now() - started,
      error: readError
        ? { message: readError.message, status: readError.status, cause: classifyFailure(readError.status, readError.message) }
        : undefined,
      retries: 0,
    },
    candidates,
    provenance,
    subjectAri: context.issueAri,
    failures,
    notes,
  };
}

/**
 * A test or attestation record for the control's population.
 *
 * The registry scan counts record work items carrying the control label; the panel
 * used to count the open change ticket itself, which made one work item stand in as
 * its own test record. This reads the same population the scan does — record work
 * items for this control in this project — and reports MISSING only when that read
 * succeeded and found none.
 */
async function observeTestRecordClaim(
  context: ObservationContext,
  control: ControlRow,
  requirement: RequirementRow,
): Promise<EvidenceObservation> {
  const started = Date.now();
  const jql = `project = "${context.issue.projectKey}" AND labels = "${control.jira_label}" AND statusCategory = Done ORDER BY updated DESC`;
  const failures: ObservationFailure[] = [];
  let records: Awaited<ReturnType<typeof jqlSearch>> = [];
  try {
    records = await jqlSearch(jql, 5);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const status = Number.parseInt(/\((\d{3})\)/.exec(message)?.[1] ?? '', 10);
    failures.push(restFailure(Number.isFinite(status) ? status : 0, message, REST_SCOPES.JIRA_WORK));
  }
  const candidates: EvidenceCandidate[] = records.map((record) => ({
    ari: `ari:cloud:jira:${context.cloudId}:issue/${record.id}`,
    kind: 'test_record',
    label: record.key,
    observedAt: record.updated,
    ownerAccountId: record.assigneeAccountId,
    ownerName: record.assigneeName,
    ownerActive: record.assigneeActive,
    usable: true,
  }));
  return {
    requirementId: requirement.id,
    evidenceType: requirement.evidence_type,
    scope: null,
    read: {
      label: `jql:records(${control.jira_label})`,
      mode: 'rest',
      outcome: failures.length > 0 ? 'ERROR' : 'ROWS',
      latencyMs: Date.now() - started,
      error: failures[0]
        ? { message: failures[0].message, cause: failures[0].cause, retryable: failures[0].retryable }
        : undefined,
      retries: 0,
    },
    candidates,
    provenance: candidates.map((candidate, index) => ({
      hop: index + 1,
      fromAri: `${control.jira_project_key}:${control.jira_label}`,
      relation: 'jql_record_match',
      toAri: candidate.ari,
      observedAt: candidate.observedAt,
      source: 'rule' as const,
    })),
    subjectAri: control.jira_label,
    failures,
    notes:
      records.length > 0
        ? [`Read the control's record population (${records.length} completed record(s) labelled ${control.jira_label}).`]
        : [],
  };
}

/**
 * Who answers for a policy page — the graph first, Confluence's own owner fields
 * second.
 *
 * The graph traversal (`confluencePageOwners`) is the accountability hop this
 * product is built on: it follows ownership as Atlassian models it, not as one
 * page's metadata happens to be filled in. It is also a graph read, and an
 * unattended scan has no user of its own to read as — its graph hops can fail or
 * stall where its REST hops answer (the scheduled scan proved that: 14 graph hops
 * failed while the same pages were listed over REST).
 *
 * So the hop has two answers, and the observation always says which one it got:
 *
 *   * `graph`  — the traversal named the owner (the normal path);
 *   * `rest`   — the traversal could not be read, and the page's own `ownerId` /
 *                `lastOwnerId` / `authorId` named the person (disclosed, not
 *                passed off as a traversal);
 *   * nothing  — neither named anyone. That is the only case where the claim may
 *                say "nobody is accountable", and it is reported as INCOMPLETE
 *                when the graph hop itself was unreadable, STALE when it answered
 *                with no rows.
 *
 * Both surfaces use this one function, so the panel and the rollup cannot disagree
 * about the same page (the v6.27 parity rule).
 */
export interface PageOwnerResolution {
  accountId: string | null;
  /** Display name, when the source could supply one (only the graph does). */
  name?: string | null;
  resolved: boolean;
  /** Where the name came from, for the row's provenance source. */
  source: 'graph' | 'rest' | null;
  /** Which Confluence property answered, when the source is REST. */
  restField?: 'owner' | 'lastOwner' | 'author';
  /** The graph hop's failure, when it had one (kept as a note, not a verdict). */
  graphError?: { message: string; cause: FailureCause; scope?: EvidenceScope };
  /** True when the graph hop was attempted and could not be read at all. */
  graphUnread: boolean;
  /** True when the graph answered but named nobody. */
  graphEmpty: boolean;
  /**
   * How many rows the ownership traversal itself returned. A scope is proven only
   * by rows that came back through it; the policy page's REST evidence proves the
   * page exists, not that the graph can read page owners (A7).
   */
  graphRows: number;
  notes: string[];
  /** Graph hops that needed a retry, for the trace's latency/retry count. */
  retries: number;
  truncated: boolean;
}

export async function resolvePageOwner(
  page: { id: string; title: string },
  ari: string,
  options: { asAccountId?: string | null } = {},
): Promise<PageOwnerResolution> {
  const notes: string[] = [];
  const owners = await fetchPageOwners(ari, options.asAccountId ?? undefined);
  const named = owners.rows.find((user) => Boolean(user.accountId));
  const graphError = owners.error
    ? {
        message: owners.error.message,
        cause:
          owners.error.cause ?? classifyFailure(owners.error.status, owners.error.message),
      }
    : undefined;
  const graphUnread = Boolean(owners.error);
  const graphEmpty = !owners.error && !named?.accountId;

  if (named?.accountId) {
    return {
      accountId: named.accountId,
      name: named.name ?? null,
      resolved: true,
      source: 'graph',
      graphUnread: false,
      graphEmpty: false,
      graphRows: owners.rows.length,
      notes,
      retries: owners.retries,
      truncated: owners.truncated === true,
    };
  }

  // The traversal did not name anyone. Ask the page itself before calling the
  // accountability unanswered.
  const rest = await pageOwner(page.id, { asAccountId: options.asAccountId ?? null });
  if (rest.accountId) {
    notes.push(
      `Owner from Confluence REST, not the graph: the ownership traversal ` +
        (graphUnread ? `could not be read (${graphError?.cause ?? 'UNKNOWN'})` : 'returned no rows') +
        `, so the page's own ${rest.field ?? 'owner'} field (${rest.accountId}) carries this row. ` +
        `Provenance source: rest.`,
    );
    return {
      accountId: rest.accountId,
      resolved: true,
      source: 'rest',
      restField: rest.field ?? undefined,
      graphError,
      graphUnread,
      graphEmpty,
      graphRows: owners.rows.length,
      notes,
      retries: owners.retries,
      truncated: owners.truncated === true,
    };
  }

  if (graphUnread) {
    notes.push(
      `The ownership hop could not be read (${graphError?.cause ?? 'UNKNOWN'}: ${graphError?.message ?? 'no detail'}) ` +
        `and Confluence's own owner fields named nobody for ${page.title}.`,
    );
  } else if (graphEmpty) {
    notes.push(
      `Ownership unresolved: confluencePageOwners returned no rows for ${page.title}, and Confluence's own ` +
        `owner fields are empty. The evidence stays usable; the verdict is STALE because the graph named ` +
        `nobody accountable for it.`,
    );
  }
  return {
    accountId: null,
    resolved: false,
    source: null,
    graphError,
    graphUnread,
    graphEmpty,
    graphRows: owners.rows.length,
    notes,
    retries: owners.retries,
    truncated: owners.truncated === true,
  };
}

/**
 * Policy claim. Three independent facts have to line up: the space is readable,
 * a page matching the rule exists and is fresh, and the graph can name its owner
 * and the team behind the space.
 *
 * The third hop is where NOT_VISIBLE was born, and it is also where the app used
 * to lie: a policy page that Confluence REST had already reported as absent was
 * still called "cannot be seen", because the ownership hop returned no rows and
 * the scan never asked REST whether it had actually looked. The two questions are
 * now kept apart — REST answers "is there a page?" (a 404 is an absence), the
 * graph answers "who owns it?" (an empty answer is a blind spot) — and only the
 * second one can produce NOT_VISIBLE.
 */
async function observePolicyClaim(
  context: ObservationContext,
  requirement: RequirementRow,
): Promise<EvidenceObservation> {
  const started = Date.now();
  const rule = parseRule(requirement.rule_json);
  const failures: ObservationFailure[] = [];
  const notes: string[] = [];
  const provenance: ProvenanceHop[] = [];
  const candidates: EvidenceCandidate[] = [];
  let retries = 0;
  let accountabilityUnread = false;
  // Rows the ownership traversal itself returned: the only thing that can prove
  // `read:graph:page:confluence` (see scopeProbeFromObservation).
  let graphRows = 0;

  // 1. Where the policy is supposed to live. A space this site does not have is a
  //    setup problem (bind the programme), not a permission problem: saying
  //    NOT_VISIBLE would send the user to ask for a scope they already granted.
  let spaceId: string | null = null;
  let spaceResolved = true;
  const readOptions = { asAccountId: context.accountId ?? null };
  if (rule.spaceKey) {
    const space = await spaceIdByKey(rule.spaceKey, readOptions);
    if (space.error) {
      spaceResolved = false;
      failures.push(restFailure(space.error.status, space.error.message, REST_SCOPES.PAGE));
    } else if (!space.id) {
      spaceResolved = false;
      failures.push(
        failureOf('UNCONFIGURED', `the space ${rule.spaceKey} this control names does not exist on this site`),
      );
    } else {
      spaceId = space.id;
    }
  }

  // 2. The page itself, from REST, which knows exactly whether it is there.
  //
  // A programme bound with "no space" has no place to look: that is a setup step,
  // not a permission gap and not an absence, so it is named as one (UNCONFIGURED)
  // before any page read is attempted.
  const noSpaceBound = Boolean(rule.pageTitlePrefix) && !rule.spaceKey;
  if (noSpaceBound) {
    failures.push(
      failureOf(
        'UNCONFIGURED',
        `no policy space is bound to this programme, so the page "${rule.pageTitlePrefix}" has nowhere to be looked for`,
      ),
    );
  }
  const found: { page: ConfluencePageSummary | null; error?: { status: number; message: string }; absent?: boolean } =
    rule.pageTitlePrefix && rule.spaceKey
      ? await pageByTitle(rule.pageTitlePrefix, rule.spaceKey, readOptions)
      : {
          page: null,
          error: { status: 404, message: 'The requirement names no policy page' },
          absent: false,
        };

  const pages: ConfluencePageSummary[] = found.page ? [found.page] : [];
  if (found.error && found.error.status !== 404) {
    failures.push(restFailure(found.error.status, found.error.message, REST_SCOPES.PAGE));
  }

  // REST settled it: the space was readable and the page is there, or the listing
  // answered cleanly and the page really is not. From here an empty candidate list
  // is a true absence (MISSING), not an invisible one.
  const visibilityProven =
    spaceResolved && (pages.length > 0 || found.absent === true || found.error?.status === 404);

  for (const page of pages) {
    const ari = confluencePageAri(context.cloudId, page.id);

    // The claim is "a governed, fresh policy page exists". Age is judged by the
    // engine (it becomes STALE), so an aging page stays usable here: calling it
    // unusable would turn every stale policy into a "missing" finding.
    provenance.push({
      hop: provenance.length + 1,
      fromAri: context.issueAri,
      relation: 'policy_required_by_control',
      toAri: ari,
      observedAt: new Date().toISOString(),
      source: 'rule',
    });

    // 3. Ownership — the hop that makes this a graph product, with the page's own
    //    owner fields as the disclosed fallback (see resolvePageOwner). v6.30 gives
    //    the hop an explicit identity only when the calling surface has none: the
    //    panel reads as the person looking, the unattended scan as the stored
    //    principal (bounded by the scan's graph budget).
    const owner = await resolvePageOwner(page, ari, { asAccountId: context.accountId ?? null });
    retries += owner.retries;
    graphRows += owner.graphRows;
    for (const note of owner.notes) {
      notes.push(note);
    }
    if (owner.truncated) {
      notes.push(
        `confluencePageOwners returned more rows than the read window; the owner list is a prefix.`,
      );
    }
    if (owner.graphUnread && !owner.resolved && owner.graphError) {
      accountabilityUnread = true;
      failures.push(
        failureOf(
          owner.graphError.cause,
          owner.graphError.message,
          owner.graphError.cause === 'PERMISSION_DENIED' ? GRAPH_SCOPES.PAGE : undefined,
        ),
      );
    }
    const ownerAccountId = owner.accountId;
    // The row shows where the name came from; `accountabilityUnread` decides that
    // the reason is a blind spot (INCOMPLETE) rather than a finding (STALE).
    const ownershipResolved = owner.resolved;
    provenance.push({
      hop: provenance.length + 1,
      fromAri: ari,
      relation:
        owner.source === 'rest'
          ? 'confluence_page_owner_field'
          : 'atlassian_user_owns_confluence_page',
      toAri: ownerAccountId ? userAri(ownerAccountId) : null,
      observedAt: new Date().toISOString(),
      source: owner.source === 'rest' ? 'rest' : 'graph',
    });

    if (spaceId) {
      const space = confluenceSpaceAri(context.cloudId, spaceId);
      provenance.push({
        hop: provenance.length + 1,
        fromAri: space,
        relation: 'confluence_space_has_confluence_page',
        toAri: ari,
        observedAt: new Date().toISOString(),
        source: 'rule',
      });
      const teams = await fetchTeamsBySpace(space);
      retries += teams.retries;
      if (teams.error) {
        // The team hop is routing enrichment, not one of the three facts the claim
        // needs (space readable, page present and fresh, owner named). Folding it
        // into `failures` made a team-scope denial flip the whole claim to
        // NOT_VISIBLE naming the *page* scope — the wrong permission on the wrong
        // row. It is recorded as a note instead, with the scope the graph named.
        const cause = teams.error.cause ?? classifyFailure(teams.error.status, teams.error.message);
        const scopeNamed =
          (teams.error.scopes ?? []).find((value) => isGraphScope(value)) ??
          GRAPH_SCOPES.TEAM;
        notes.push(
          `The team behind ${space} could not be read (${cause}: ${teams.error.message}). ` +
            `Scope: ${scopeNamed}. The claim is judged without it; owner routing stays with the page owner.`,
        );
      }
      const team = teams.rows.find((candidate) => Boolean(candidate.id));
      if (teams.truncated) {
        notes.push(`atlassianTeamsBySpace returned more teams than were read; the first team is used.`);
      }
      if (team?.id) {
        provenance.push({
          hop: provenance.length + 1,
          fromAri: team.id,
          relation: 'atlassian_team_links_space_entity',
          toAri: space,
          observedAt: new Date().toISOString(),
          source: 'graph',
        });
      }
    }

    candidates.push({
      ari,
      kind: 'confluence_page',
      label: page.title,
      observedAt: page.lastUpdatedAt,
      ownerAccountId,
      // REST names the account but not a display name (the user directory is a
      // separate read), so a REST-sourced row carries the id and the note says why.
      ownerName: owner.name ?? null,
      // The active flag is not readable for a page owner with these scopes, so the
      // engine may not claim it: `ownerActiveKnown` makes that explicit and the note
      // below tells the reader what is therefore not detected.
      ownerActive: null,
      ownerActiveKnown: false,
      ownershipResolved,
      usable: true,
      webPath: page.webPath,
    });
    notes.push(
      `The active status of a Confluence page owner is not readable with this app's scopes ` +
        `(the graph's AtlassianUser has no active flag and read:jira-user is not requested), so a ` +
        `deactivated page owner is not detected on this row. Active-owner detection applies to Jira ` +
        `assignees and approval comment authors, whose flag comes from Jira REST.`,
    );
  }

  const outcome: EvidenceObservation['read']['outcome'] = failures.some(
    (failure) => failure.cause === 'PERMISSION_DENIED',
  )
    ? 'ERROR'
    : 'ROWS';
  const deniedFailure = failures.find((failure) => failure.cause === 'PERMISSION_DENIED');

  return {
    requirementId: requirement.id,
    evidenceType: requirement.evidence_type,
    scope: GRAPH_SCOPES.PAGE,
    read: {
      label: `confluence:${rule.spaceKey ?? 'space'}:${rule.pageTitlePrefix ?? 'policy'} + confluencePageOwners`,
      mode: 'curated',
      outcome,
      latencyMs: Date.now() - started,
      error: deniedFailure
        ? { message: deniedFailure.message, cause: deniedFailure.cause, retryable: false }
        : undefined,
      retries,
    },
    candidates,
    provenance,
    subjectAri: pages[0] ? confluencePageAri(context.cloudId, pages[0].id) : context.issueAri,
    failures,
    visibilityProven,
    accountabilityUnread,
    scopeRows: graphRows,
    notes,
  };
}

/**
 * Approval accountability — the claim that needs the graph and nothing else.
 *
 * "The approver must be accountable for the policy this change is governed by":
 * a member of the team that owns the policy page, or of a team accountable for the
 * space the policy lives in.
 *
 * Why this is a graph claim: it joins four Atlassian objects across two products —
 * a Jira comment's author, a Confluence page, the space behind it, and the teams
 * those belong to. No Atlassian REST API answers that join (Jira REST has no team
 * concept and Confluence page metadata names one owner, not a team), so there is
 * deliberately **no REST fallback** here: a fallback would turn the one relation
 * that needs the graph into another REST check. When the graph cannot answer, the
 * claim says NOT_VISIBLE and names the scope — it never guesses an owner, and it
 * never passes the approval on the strength of the comment alone.
 *
 * Three answers, three states:
 *   * approver is in a team the graph names   -> a usable candidate (VERIFIED)
 *   * teams read, approver in none of them    -> crossProductFinding (STALE: an
 *     approval from outside the accountable team is a segregation finding)
 *   * teams could not be read                 -> no candidate, TEAM scope named
 *     (NOT_VISIBLE)
 */
async function observeIndependenceClaim(
  context: ObservationContext,
  requirement: RequirementRow,
  options: { lean?: boolean; controlCode?: string } = {},
): Promise<EvidenceObservation> {
  // The claim's name in its own sentence. It used to be the literal "AC-01", so any
  // other control that used the same evidence type printed the wrong code.
  const claimCode = options.controlCode ?? 'this control';
  const started = Date.now();
  const rule = parseRule(requirement.rule_json);
  const notes: string[] = [];
  const failures: ObservationFailure[] = [];
  const provenance: ProvenanceHop[] = [];
  const readOptions = { asAccountId: context.accountId ?? null };
  let retries = 0;
  let graphRows = 0;

  // 1. The approval itself — a Jira comment, REST, the only REST fact this claim uses.
  const pattern = new RegExp(rule.approvalPattern ?? '\\b(approved|approval|lgtm)\\b', 'i');
  const { comments, error } = await issueComments(context.issue.key);
  if (error) {
    failures.push(restFailure(error.status, error.message, REST_SCOPES.JIRA_WORK));
  }
  const approving = comments
    .filter((comment) => statesApproval(comment.bodyText, pattern))
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];
  if (!approving) {
    return {
      requirementId: requirement.id,
      evidenceType: requirement.evidence_type,
      scope: GRAPH_SCOPES.TEAM,
      read: {
        label: `jira-comments:${context.issue.key} + page/space teams`,
        mode: 'curated',
        outcome: 'ROWS',
        latencyMs: Date.now() - started,
        retries,
      },
      candidates: [],
      provenance,
      subjectAri: context.issueAri,
      failures,
      notes,
      scopeRows: 0,
    };
  }
  const commentAri = `ari:cloud:jira:${context.cloudId}:comment/${approving.id}`;
  provenance.push({
    hop: 1,
    fromAri: context.issueAri,
    relation: 'jira_work_item_has_jira_work_item_comment',
    toAri: commentAri,
    observedAt: approving.created,
    source: 'rest',
  });

  // 2. The policy the change is governed by — REST, the page the rule names.
  let pageAri: string | null = null;
  let spaceAriValue: string | null = null;
  if (rule.pageTitlePrefix) {
    const found = await pageByTitle(rule.pageTitlePrefix, rule.spaceKey ?? '', readOptions);
    if (found.page) {
      pageAri = confluencePageAri(context.cloudId, found.page.id);
      provenance.push({
        hop: 2,
        fromAri: context.issueAri,
        relation: 'policy_required_by_control',
        toAri: pageAri,
        observedAt: found.page.lastUpdatedAt,
        source: 'rule',
      });
    } else if (found.error && found.error.status !== 404) {
      failures.push(restFailure(found.error.status, found.error.message, REST_SCOPES.PAGE));
    } else {
      notes.push(
        `No page titled "${rule.pageTitlePrefix}" is in ${rule.spaceKey ?? 'the bound space'}, so the team that answers for the policy cannot be named.`,
      );
    }
  }
  if (rule.spaceKey) {
    const space = await spaceIdByKey(rule.spaceKey, readOptions);
    if (space.id) {
      spaceAriValue = confluenceSpaceAri(context.cloudId, space.id);
    }
  }

  // 3. The accountability set, from the graph: the page owner's teams, and the teams
  //    linked to the policy's space. Two relations, both graph-only.
  const teams = new Map<string, { id: string; name: string; via: string }>();
  let matchedTeam: { id: string; name: string; via: string } | null = null;
  let pageOwnerAccountId: string | null = null;
  const ownerRead = pageAri
    ? await fetchPageOwners(pageAri, context.accountId ?? undefined)
    : null;
  if (ownerRead) {
    retries += ownerRead.retries;
    graphRows += ownerRead.rows.length;
    const owner = ownerRead.rows.find((row) => Boolean(row.accountId));
    // The owner's teams are the tighter relation (the team the person who answers
    // for the page sits in). The unattended scan keeps this hop and skips the space
    // teams instead: it runs inside a 25-second function budget, and one relation
    // read honestly beats two read halfway.
    if (owner?.accountId) {
      provenance.push({
        hop: 3,
        fromAri: pageAri,
        relation: 'atlassian_user_owns_confluence_page',
        toAri: userAri(owner.accountId),
        observedAt: new Date().toISOString(),
        source: 'graph',
      });
      const ownerTeams = await fetchUserTeams(userAri(owner.accountId), context.accountId ?? undefined);
      retries += ownerTeams.retries;
      graphRows += ownerTeams.rows.length;
      // The teams are kept for the membership test, not drawn one by one: a person
      // sits in twenty teams on this site, and one column per team made a diagram
      // wider than the panel that held it. Only the team that answers the claim is a
      // hop in the trace (added below, when the match is found).
      for (const team of ownerTeams.rows) {
        if (team.id) {
          teams.set(team.id, { id: team.id, name: team.displayName ?? team.id, via: 'page owner' });
        }
      }
      pageOwnerAccountId = owner.accountId;
      if (ownerTeams.error && (ownerTeams.error.cause ?? classifyFailure(ownerTeams.error.status, ownerTeams.error.message)) === 'PERMISSION_DENIED') {
        failures.push(
          failureOf('PERMISSION_DENIED', ownerTeams.error.message, GRAPH_SCOPES.TEAM),
        );
      }
    } else if (ownerRead.error) {
      const cause = ownerRead.error.cause ?? classifyFailure(ownerRead.error.status, ownerRead.error.message);
      if (cause === 'PERMISSION_DENIED') {
        failures.push(failureOf(cause, ownerRead.error.message, GRAPH_SCOPES.PAGE));
      }
    } else {
      notes.push(
        `The graph named no owner for the policy page, so its owner's teams are not in this claim's ${'accountability set'}.`,
      );
    }
  }
  if (spaceAriValue && !options.lean) {
    const spaceTeams = await fetchTeamsBySpace(spaceAriValue, context.accountId ?? undefined);
    retries += spaceTeams.retries;
    graphRows += spaceTeams.rows.length;
    for (const team of spaceTeams.rows) {
      if (!team.id || teams.has(team.id)) {
        continue;
      }
      teams.set(team.id, { id: team.id, name: team.displayName ?? team.id, via: 'policy space' });
    }
    if (spaceTeams.error) {
      const cause = spaceTeams.error.cause ?? classifyFailure(spaceTeams.error.status, spaceTeams.error.message);
      if (cause === 'PERMISSION_DENIED') {
        failures.push(failureOf(cause, spaceTeams.error.message, GRAPH_SCOPES.TEAM));
      }
    }
  }

  // 4. Membership: is the approver in one of those teams? This is the hop REST
  //    cannot make.
  let membershipRead = false;
  let memberOf: string | null = null;
  // A scan checks the first two accountable teams; the panel checks them all.
  const teamList = [...teams.values()].slice(0, options.lean ? 2 : 25);
  for (const team of teamList) {
    const members = await fetchTeamMembers(team.id, context.accountId ?? undefined);
    retries += members.retries;
    graphRows += members.rows.length;
    if (members.error) {
      const cause = members.error.cause ?? classifyFailure(members.error.status, members.error.message);
      if (cause === 'PERMISSION_DENIED') {
        failures.push(failureOf(cause, members.error.message, GRAPH_SCOPES.TEAM));
      }
      continue;
    }
    membershipRead = true;
    const match = members.rows.find(
      (member) => member.accountId && member.accountId === approving.authorAccountId,
    );
    if (match) {
      memberOf = team.name;
      matchedTeam = team;
      // A team that answers through the policy's space needs the two edges that
      // connect it to the page, or the trace would show a member hop floating free
      // of the policy it is supposed to be accountable for.
      if (team.via === 'policy space' && spaceAriValue && pageAri) {
        provenance.push({
          hop: provenance.length + 1,
          fromAri: spaceAriValue,
          relation: 'confluence_space_has_confluence_page',
          toAri: pageAri,
          observedAt: new Date().toISOString(),
          source: 'rule',
        });
        provenance.push({
          hop: provenance.length + 1,
          fromAri: team.id,
          relation: 'atlassian_team_links_space_entity',
          toAri: spaceAriValue,
          observedAt: new Date().toISOString(),
          source: 'graph',
        });
      }
      // The one edge that decides the claim, drawn from the team that answered it.
      provenance.push({
        hop: provenance.length + 1,
        fromAri: team.id,
        relation: 'atlassian_team_member_is_atlassian_user',
        toAri: userAri(approving.authorAccountId as string),
        observedAt: new Date().toISOString(),
        source: 'graph',
      });
      break;
    }
  }

  const baseObservation = {
    requirementId: requirement.id,
    evidenceType: requirement.evidence_type,
    scope: GRAPH_SCOPES.TEAM,
    read: {
      label: `confluencePageOwners + atlassianUserInTeams + atlassianTeamsBySpace + atlassianTeamMembers`,
      mode: 'curated' as const,
      outcome: (failures.some((failure) => failure.cause === 'PERMISSION_DENIED') ? 'ERROR' : 'ROWS') as 'ERROR' | 'ROWS',
      latencyMs: Date.now() - started,
      retries,
      error: failures.find((failure) => failure.cause === 'PERMISSION_DENIED')
        ? {
            message: failures.find((failure) => failure.cause === 'PERMISSION_DENIED')?.message ?? '',
            cause: 'PERMISSION_DENIED' as const,
            retryable: false,
          }
        : undefined,
    },
    subjectAri: pageAri ?? context.issueAri,
    failures,
    notes,
    scopeRows: graphRows,
  };

  if (memberOf) {
    return {
      ...baseObservation,
      provenance,
      candidates: [
        {
          ari: commentAri,
          kind: 'approval_comment',
          label: `Approval by ${approving.authorName ?? 'unknown'} — member of ${memberOf}`,
          observedAt: approving.created,
          ownerAccountId: approving.authorAccountId,
          ownerName: approving.authorName,
          ownerActive: approving.authorActive,
          usable: true,
        },
      ],
    };
  }

  // The graph answered and the approver is outside every accountable team: that is
  // the finding this claim exists for. It is only reachable when the graph could be
  // read — an empty answer is NOT_VISIBLE (no candidates, TEAM scope named), never
  // this.
  if (membershipRead && teams.size > 0) {
    const names = [...teams.values()].map((team) => `${team.name} (${team.via})`);
    return {
      ...baseObservation,
      provenance,
      candidates: [
        {
          ari: commentAri,
          kind: 'approval_comment',
          label: `Approval by ${approving.authorName ?? 'unknown'}`,
          observedAt: approving.created,
          ownerAccountId: approving.authorAccountId,
          ownerName: approving.authorName,
          ownerActive: approving.authorActive,
          usable: false,
          unusableReason: `${approving.authorName ?? 'The approver'} is not a member of any team accountable for the policy.`,
        },
      ],
      crossProductFinding: {
        relation: 'approver_in_page_owner_team',
        reason:
          `Approved by ${approving.authorName ?? 'an unnamed account'} — who is not in ${names.join(', ')}, the team(s) ` +
          `the graph names as accountable for the policy this change is governed by. The approval exists and is fresh; ` +
          `what is missing is the accountability the control requires.`,
        evidenceAri: commentAri,
      },
    };
  }

  // The graph answered about this page but named no team at all: the accountability
  // the claim needs does not exist. That is a finding (STALE), not a blind spot —
  // the alternative reading is only chosen when the graph returned nothing at all.
  if (graphRows > 0) {
    return {
      ...baseObservation,
      provenance,
      candidates: [],
      crossProductFinding: {
        relation: 'policy_page_has_accountable_team',
        reason:
          `The graph answered about this policy and named no team accountable for it: ` +
          (pageAri
            ? `the page exists, but no owner's team and no team linked to its space came back`
            : `the page the control names was not found, so there was no page to read teams from`) +
          (options.lean ? ' (this unattended scan reads the page owner\'s teams; the issue panel reads the space teams as well)' : '') +
          `. The approval exists and is fresh; what nothing in the graph names is whose approval it is.`,
        evidenceAri: commentAri,
      },
    };
  }

  // The graph could not answer. No owner was invented and no approval was passed on
  // the comment alone: the claim is not visible, and it names the scope.
  notes.push(
    teams.size === 0
      ? 'The graph named no team for the policy page or its space, so there is nothing to check membership against. This is reported as not visible rather than as an unaccountable approval: an empty graph answer and a withheld scope are the same shape.'
      : 'Team membership could not be read for any of the accountable teams, so the approver was not checked against them.',
  );
  return {
    ...baseObservation,
    provenance,
    candidates: [],
    // Neither the cross-product finding nor a blind spot could be concluded: the graph
    // answered nothing about the teams, so the claim is "not checked" — and says why.
    uncheckedReason:
      `The graph named no team for ${pageAri ? 'the policy page or its space' : 'the policy the control names'}, so ` +
      `whether the approver is accountable for the policy could not be checked (${claimCode}). An unread team is not an ` +
      `unaccountable approver: this claim is reported as not checked, not as missing.`,
  };
}

/**
 * The persisted traversal, when it is registered: work item -> linked policy page
 * -> space -> team. One call, and every hop it returns is a real graph edge
 * rather than a rule-derived match, which is what the trace diagram shows.
 *
 * A failure here is NOT an observation failure. The persisted query is an optional
 * enrichment: when it is not registered, not enabled for the environment, or
 * throttled, the claim is still judged from REST + curated hops. Pushing its error
 * into `failures` used to be able to turn a genuine MISSING into INCOMPLETE — an
 * enrichment changing the verdict, which is the opposite of what this engine is
 * for. The error is returned as a note and shown next to the trace instead.
 */
async function persistedChainHops(context: ObservationContext): Promise<{
  hops: ProvenanceHop[];
  queryKey: string | null;
  rows: number;
  latencyMs: number;
  retries: number;
  note?: string;
}> {
  const draft = PERSISTED_QUERIES.evidenceChain;
  const queryKey = queryKeyFor(draft);
  if (!queryKey) {
    // Silently returning here left the "View query" frame empty on any site whose
    // environment has no query key, with nothing on screen saying why. The chain is
    // still built — from curated hops and REST — and the row now says so.
    return {
      hops: [],
      queryKey: null,
      rows: 0,
      latencyMs: 0,
      retries: 0,
      note:
        `Persisted Cypher is not registered for this environment (forge variable ${draft.envVar} is unset): ` +
        `the chain was built from curated graph hops and REST. Register the query and set the variable to add the ` +
        `single-hop work item → policy page → space → team traversal.`,
    };
  }
  const chain = await executePersistedQuery('evidence-chain', queryKey, { issueAri: context.issueAri }, undefined, context.cloudId);
  if (chain.error) {
    return {
      hops: [],
      queryKey,
      rows: 0,
      latencyMs: chain.latencyMs,
      retries: chain.retries,
      note:
        `Persisted Cypher did not answer (${chain.error.cause ?? classifyFailure(chain.error.status, chain.error.message)}: ` +
        `${chain.error.message}) — the verdict was reached without it, on curated and REST hops.`,
    };
  }
  const hops: ProvenanceHop[] = [];
  for (const row of chain.rows) {
    const pageAriValue = row['pageAri'];
    const spaceValue = row['spaceAri'];
    const teamValue = row['teamAri'];
    if (pageAriValue) {
      hops.push({
        hop: hops.length + 1,
        fromAri: row['itemAri'] ?? context.issueAri,
        relation: 'content_entity_links_entity',
        toAri: pageAriValue,
        observedAt: new Date().toISOString(),
        source: 'persisted',
      });
    }
    if (spaceValue) {
      hops.push({
        hop: hops.length + 1,
        fromAri: spaceValue,
        relation: 'confluence_space_has_confluence_page',
        toAri: pageAriValue ?? null,
        observedAt: new Date().toISOString(),
        source: 'persisted',
      });
    }
    if (teamValue) {
      hops.push({
        hop: hops.length + 1,
        fromAri: teamValue,
        relation: 'atlassian_team_links_space_entity',
        toAri: spaceValue ?? null,
        observedAt: new Date().toISOString(),
        source: 'persisted',
      });
    }
  }
  return {
    hops,
    queryKey,
    rows: chain.rows.length,
    latencyMs: chain.latencyMs,
    retries: chain.retries,
    note: chain.truncated
      ? `The persisted traversal stopped at the ${chain.pages * 25}-row read window while the API still had more; ` +
        `the chain shown is a prefix of it, not the whole traversal.`
      : undefined,
  };
}

async function observeRequirement(
  context: ObservationContext,
  control: ControlRow,
  requirement: RequirementRow,
): Promise<{ observation: EvidenceObservation; persisted: Awaited<ReturnType<typeof persistedChainHops>> }> {
  switch (requirement.evidence_type) {
    case 'approval_comment':
      return {
        observation: await observeApprovalClaim(context, requirement),
        persisted: { hops: [], queryKey: null, rows: 0, latencyMs: 0, retries: 0 },
      };
    case 'policy_page': {
      const persisted = await persistedChainHops(context);
      const observation = await observePolicyClaim(context, requirement);
      // Graph-verified link hops come first: they are the stronger evidence that
      // this policy page belongs to this change.
      if (persisted.hops.length > 0) {
        observation.provenance = [...persisted.hops, ...observation.provenance].map((hop, index) => ({
          ...hop,
          hop: index + 1,
        }));
      }
      if (persisted.note) {
        observation.notes = [...(observation.notes ?? []), persisted.note];
      }
      return { observation, persisted };
    }
    case 'approval_independence':
      return {
        observation: await observeIndependenceClaim(context, requirement, { controlCode: control.code }),
        persisted: { hops: [], queryKey: null, rows: 0, latencyMs: 0, retries: 0 },
      };
    case 'test_record':
      return {
        observation: await observeTestRecordClaim(context, control, requirement),
        persisted: { hops: [], queryKey: null, rows: 0, latencyMs: 0, retries: 0 },
      };
    case 'pull_request':
    case 'deployment':
      return {
        observation: await observeConnectorClaim(context, requirement),
        persisted: { hops: [], queryKey: null, rows: 0, latencyMs: 0, retries: 0 },
      };
    case 'jira_work_item':
      return {
        observation: await observeWorkItemClaim(context, requirement),
        persisted: { hops: [], queryKey: null, rows: 0, latencyMs: 0, retries: 0 },
      };
    default:
      return {
        observation: {
          requirementId: requirement.id,
          evidenceType: requirement.evidence_type,
          scope: null,
          read: { label: 'unsupported', mode: 'rest', outcome: 'EMPTY', latencyMs: 0, retries: 0 },
          candidates: [],
          provenance: [],
        },
        persisted: { hops: [], queryKey: null, rows: 0, latencyMs: 0, retries: 0 },
      };
  }
}

// ---------------------------------------------------------------------------
// Control resolution
// ---------------------------------------------------------------------------

interface ControlResolution {
  control: ControlRow | null;
  claimed: boolean;
  suggested: ControlRow[];
}

/**
 * Which control claims this work item?
 *
 *  1. an explicit label match (`ctrl-ac-01`) — the seeded path;
 *  2. the control whose project contains the issue and whose cadence fits a
 *     change — the zero-config path, offered as a suggestion, never asserted.
 */
async function resolveControl(issue: JiraIssueDetail, controlCode?: string): Promise<ControlResolution> {
  const controls = (await registryControls()).filter((control) => control.status === 'ACTIVE');
  if (controlCode) {
    const control = controls.find((row) => row.code === controlCode) ?? null;
    // Naming a control is a *template* choice, not a claim. Returning `claimed: true`
    // here let a Rovo agent (or anyone with the control code) raise remediation
    // issues against a work item nobody had claimed for that control — the guard in
    // closeGapsForIssue was bypassed by the caller's own argument. The work item's
    // label is the only thing that claims it.
    const claimed = Boolean(control) && issue.labels.includes(control?.jira_label ?? '\u0000');
    return { control, claimed, suggested: [] };
  }
  const labelled = controls.filter((control) => issue.labels.includes(control.jira_label));
  if (labelled.length > 0) {
    const [first, ...rest] = labelled;
    return { control: first ?? null, claimed: true, suggested: rest };
  }
  const inProject = controls.filter(
    (control) => control.jira_project_key.toUpperCase() === issue.projectKey.toUpperCase(),
  );
  return { control: inProject[0] ?? null, claimed: false, suggested: inProject.slice(1) };
}

function badgeFor(
  counts: StateCounts,
  requirements: readonly GateRequirement[] = [],
): IssueGate['badge'] {
  // Nothing could be looked at because the programme names a project or space this
  // site does not have. That is a setup step, not a permission gap, and not a gap
  // in the evidence: saying one of those would be wrong twice over.
  const unconfigured = requirements.filter((row) =>
    row.failures.some((failure) => failure.cause === 'UNCONFIGURED'),
  );
  if (requirements.length > 0 && unconfigured.length === requirements.length) {
    return {
      state: 'NOT_EVALUATED',
      label: 'Programme not bound to this site',
      detail:
        'This programme judges a project and a space that do not exist here. Bind it to one of this site’s projects and spaces in the AssureLoop control room, then recheck — every claim above is “not checked”, not “missing”.',
    };
  }
  if (counts.NOT_VISIBLE > 0) {
    return {
      state: 'UNVERIFIABLE',
      label: 'Cannot be fully verified',
      detail: `${counts.NOT_VISIBLE} claim(s) need a permission the app does not have — that is not the same as failing evidence.`,
    };
  }
  if (counts.MISSING > 0 || counts.STALE > 0) {
    return {
      state: 'GAPS',
      label: 'Gaps found',
      detail:
        `${counts.MISSING} missing, ${counts.STALE} stale — close the gaps before this ships.` +
        (counts.INCOMPLETE > 0 ? ` ${counts.INCOMPLETE} other claim(s) could not be checked.` : ''),
    };
  }
  if (counts.INCOMPLETE > 0) {
    return {
      state: 'PARTIAL',
      label: 'Partly checked',
      detail: `${counts.INCOMPLETE} claim(s) could not be checked in this pass (throttle, timeout or index lag). Rescan before drawing a conclusion.`,
    };
  }
  if (counts.VERIFIED > 0) {
    return {
      state: 'PASS',
      label: 'Evidence complete',
      detail: `All ${counts.VERIFIED} claim(s) are backed by evidence the graph could see.`,
    };
  }
  return { state: 'NOT_EVALUATED', label: 'Not evaluated', detail: 'No claims were judged for this work item.' };
}

export interface GateOptions {
  issueKey: string;
  controlCode?: string;
  cloudId: string;
  siteUrl?: string | null;
  now?: Date;
  /** The person looking at the gate; Confluence reads fall back to them. */
  accountId?: string | null;
}

/** Read one work item and judge every claim of the control that owns it. */
export async function evaluateIssueGate(options: GateOptions): Promise<IssueGate> {
  const started = Date.now();
  const { issue, error } = await getIssue(options.issueKey);
  if (!issue || error) {
    return {
      issue: null,
      control: null,
      suggestedControls: [],
      badge: {
        state: 'NOT_EVALUATED',
        label: 'Work item not readable',
        detail: error?.message ?? `${options.issueKey} could not be read.`,
      },
      counts: { VERIFIED: 0, STALE: 0, MISSING: 0, NOT_VISIBLE: 0, INCOMPLETE: 0 },
      requirements: [],
      gaps: 0,
      integrity: { checked: 0, incomplete: 0, notVisible: 0, retried: 0, durationMs: Date.now() - started },
      note: error?.message ?? null,
    };
  }

  const resolution = await resolveControl(issue, options.controlCode);
  const control = resolution.control;
  if (!control) {
    // Nothing claims this project: offer the programme as templates rather than
    // judging a control that has nothing to do with the change.
    const templates = (await registryControls()).slice(0, 3).map((row) => ({ code: row.code, name: row.name }));
    return {
      guarantees: AUDIT_GUARANTEES,
      issue: summarizeIssue(issue),
      control: null,
      suggestedControls: templates,
      badge: {
        state: 'NOT_EVALUATED',
        label: 'No control claims this item',
        detail:
          'No control registry entry covers this project. Seed the demo programme, label the issue with a control label, or evaluate it against a control as a template.',
      },
      counts: { VERIFIED: 0, STALE: 0, MISSING: 0, NOT_VISIBLE: 0, INCOMPLETE: 0 },
      requirements: [],
      gaps: 0,
      integrity: { checked: 0, incomplete: 0, notVisible: 0, retried: 0, durationMs: Date.now() - started },
      note: null,
    };
  }

  // Requirements come from the registry when the database is reachable, from the
  // shipped programme otherwise. Either way the gate has claims to judge.
  let requirements: RequirementRow[] = [];
  try {
    requirements = await registryRequirements(control);
  } catch (cause) {
    console.warn('Requirement lookup failed; gate will report no claims:', cause);
  }

  const context: ObservationContext = {
    cloudId: options.cloudId,
    siteUrl: options.siteUrl ?? null,
    issue,
    issueAri: `ari:cloud:jira:${options.cloudId}:issue/${issue.id}`,
    accountId: options.accountId ?? null,
  };

  const probeRows: ScopeProbeResult[] = [];
  let ledger: ScopeLedger = buildScopeLedger(probeRows);
  const verdicts: Verdict[] = [];
  const gateRequirements: GateRequirement[] = [];
  let retried = 0;

  for (const requirement of requirements) {
    const { observation, persisted } = await observeRequirement(context, control, requirement);
    // The ledger is a measurement of what this pass actually read (C3): the gate's
    // previous `buildScopeLedger([])` judged every claim against an empty ledger, so
    // "no rows" was promoted to PROVEN by the caller as long as a candidate existed.
    const probe = scopeProbeFromObservation(`gate:${requirement.evidence_type}`, observation);
    if (probe) {
      probeRows.push(probe);
      ledger = buildScopeLedger(probeRows);
    }
    retried += observation.read.retries ?? 0;
    const verdict = judgeRequirement({
      control,
      requirement,
      observation,
      ledger,
      now: options.now ?? new Date(),
    });
    verdicts.push(verdict);

    const newest = [...observation.candidates].sort(
      (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt),
    )[0];
    gateRequirements.push({
      requirementId: requirement.id,
      evidenceType: requirement.evidence_type,
      claim: CLAIM_LABEL[requirement.evidence_type] ?? requirement.evidence_type,
      expectation: parseRule(requirement.rule_json).expectation ?? null,
      maxAgeDays: requirement.max_age_days,
      state: verdict.state,
      reason: verdict.reason,
      ageDays: verdict.ageDays,
      evidence: newest
        ? {
            ari: newest.ari,
            label: newest.label ?? null,
            observedAt: newest.observedAt,
            url: evidenceUrl(context.siteUrl, newest.webPath ?? null),
            owner: newest.ownerName ?? null,
            ownerResolved:
              newest.kind === 'confluence_page' ? (newest.ownershipResolved ?? null) : null,
          }
        : null,
      missingScopes: verdict.missingScopes.map((scope) => ({
        scope,
        explanation: scopeExplanation(scope),
      })),      failures: (verdict.failures ?? []).map((failure) => ({
        cause: failure.cause,
        message: failure.message,
        scope: failure.scope,
      })),
      notes: verdict.notes ?? [],
      trace: {
        graph: buildTrace(
          { ari: context.issueAri, label: issue.key, kind: 'issue' },
          verdict.provenance,
          nameMap(observation),
        ),
        // One number per read, never a blend of two.
        //
        // The footer used to print `rows: max(curated, persisted)` and
        // `latencyMs: curated + persisted`, labelled `via curated`: three different
        // reads reported as one, which is the opposite of what a trace is for. The
        // primary numbers are now the verdict's own read; the persisted traversal is
        // reported beside it, and only when it actually ran.
        queryKey: verdict.trace.queryKey ?? persisted.queryKey,
        rows: verdict.trace.rowCount,
        latencyMs: verdict.trace.latencyMs,
        retries: verdict.trace.retries,
        mode: verdict.trace.mode,
        label: verdict.trace.label,
        persisted: {
          used: persisted.rows > 0 || persisted.hops.length > 0,
          rows: persisted.rows,
          latencyMs: persisted.latencyMs,
          queryKey: persisted.queryKey,
        },
        notes: verdict.notes ?? [],
      },
    });
  }

  const counts = summarizeVerdicts(verdicts);
  // A14: a template is not a finding.
  //
  // An item with no control label is judged against the control that covers its
  // project so a judge's click produces something real, but the badge used to read
  // "Gaps found" — a finding about their site, raised by a row nothing claimed. The
  // rows stay (they are what the control would require), the badge says what they
  // are, and no gap is offered for closure until the item is claimed.
  const badge = resolution.claimed
    ? badgeFor(counts, gateRequirements)
    : {
        state: 'NOT_EVALUATED' as const,
        label: `Template — ${control.code} is not claimed`,
        detail:
          `The rows below are what ${control.code} would require of this item, judged live. None of them is a ` +
          `finding yet: no work item carries a control label, so nothing can be closed and nothing is counted ` +
          `against the control. Claim the item for ${control.code} to turn this into a judgement.`,
      };
  const gaps = resolution.claimed ? counts.MISSING + counts.STALE : 0;

  return {
    guarantees: AUDIT_GUARANTEES,
    issue: summarizeIssue(issue),
    control: {
      code: control.code,
      name: control.name,
      regulationRef: control.regulation_ref,
      cadence: control.cadence,
      riskTier: control.risk_tier,
      owner: control.owner_display_name,
      claimed: resolution.claimed,
    },
    suggestedControls: resolution.suggested.map((row) => ({ code: row.code, name: row.name })),
    badge,
    counts,
    requirements: gateRequirements,
    gaps,
    integrity: {
      checked: verdicts.length,
      incomplete: counts.INCOMPLETE,
      notVisible: counts.NOT_VISIBLE,
      retried,
      durationMs: Date.now() - started,
    },
    note: resolution.claimed
      ? null
      : `No control label is on ${issue.key}; showing ${control.code} as a template because ` +
        (options.controlCode
          ? `it was named explicitly${resolution.suggested.length > 0 ? '' : ''}`
          : `it covers project ${issue.projectKey}`) +
        `. Nothing is permanent until the work item is claimed, and remediation issues cannot be raised from a template evaluation.`,
  };
}

function nameMap(observation: EvidenceObservation): Record<string, string> {
  const names: Record<string, string> = {};
  for (const candidate of observation.candidates) {
    if (candidate.ownerAccountId && candidate.ownerName) {
      names[`ari:cloud:identity::user/${candidate.ownerAccountId}`] = candidate.ownerName;
    }
  }
  return names;
}

function summarizeIssue(issue: JiraIssueDetail): IssueGate['issue'] {
  return {
    key: issue.key,
    id: issue.id,
    summary: issue.summary,
    status: issue.statusName,
    statusCategory: issue.statusCategoryKey,
    assignee: issue.assigneeAccountId
      ? {
          accountId: issue.assigneeAccountId,
          name: issue.assigneeName ?? issue.assigneeAccountId,
          active: issue.assigneeActive !== false,
        }
      : null,
    projectKey: issue.projectKey,
    labels: issue.labels,
    updated: issue.updated,
    webUrl: null,
  };
}

// ---------------------------------------------------------------------------
// Closing gaps, with the fallback route spelled out (E4 / R7)
// ---------------------------------------------------------------------------

export type OwnerRoute =
  | 'graph_page_owner'
  | 'page_owner_rest'
  | 'space_owner'
  | 'issue_assignee'
  | 'component_lead'
  | 'control_owner'
  | 'none';

export interface GapClosure {
  requirement: string;
  claim: string;
  createdIssue: string | null;
  assignee: string | null;
  route: OwnerRoute;
  hint: string;
  error?: string;
}

export interface CloseGapsReport {
  created: GapClosure[];
  skipped: Array<{ requirement: string; why: string }>;
  routes: Array<{ requirement: string; route: OwnerRoute; assignee: string | null; hint: string }>;
}

/** Order of fallbacks when a team cannot be read: the graph 403s are real. */
async function routeOwner(
  context: ObservationContext,
  requirement: RequirementRow,
  control: ControlRow,
): Promise<{ user: JiraUser | null; route: OwnerRoute; hint: string }> {
  const rule = parseRule(requirement.rule_json);
  /**
   * Why the policy-owner hop did not answer, in the terms of what actually happened.
   *
   * The fallback hint used to be the fixed sentence "Team lookup unavailable" whatever
   * the cause: a page that was found with no owner named, and a lookup that threw, read
   * the same. The identity was missing here too — `fetchPageOwners(ari)` ran without the
   * caller's account, so the hop that names the policy owner answered as the app.
   */
  let ownerHopMiss = 'no policy page is named by this claim';

  if (rule.pageTitlePrefix && rule.spaceKey) {
    const page = await pageByTitle(rule.pageTitlePrefix, rule.spaceKey, {
      asAccountId: context.accountId ?? null,
    });
    if (page.page) {
      const ari = confluencePageAri(context.cloudId, page.page.id);
      const owners = await fetchPageOwners(ari, context.accountId ?? undefined);
      const owner = owners.rows.find((candidate) => Boolean(candidate.accountId));
      if (owner?.accountId) {
        return {
          user: { accountId: owner.accountId, name: owner.name ?? owner.accountId, active: true },
          route: 'graph_page_owner',
          hint: `Policy owner via confluencePageOwners (${page.page.title}).`,
        };
      }
      ownerHopMiss = owners.error
        ? `the owner lookup on "${page.page.title}" failed (${owners.error.message})`
        : `the graph named no owner for the policy page "${page.page.title}"`;
      if (owners.error) {
        const cause = owners.error.cause ?? classifyFailure(owners.error.status, owners.error.message);
        if (cause === 'SERVICE_ERROR' || cause === 'RATE_LIMIT_EXCEEDED') {
          // Keep going: the fallback chain exists precisely for this.
          console.warn('Owner lookup degraded, falling back:', owners.error.message);
        }
      }
    } else {
      ownerHopMiss = page.error
        ? `the policy page "${rule.pageTitlePrefix}" could not be read (${page.error.message})`
        : `the policy page "${rule.pageTitlePrefix}" was not found in ${rule.spaceKey}`;
    }
  }

  if (context.issue.assigneeAccountId) {
    const assignee: JiraUser = {
      accountId: context.issue.assigneeAccountId,
      name: context.issue.assigneeName ?? context.issue.assigneeAccountId,
      active: context.issue.assigneeActive !== false,
    };
    if (assignee.active) {
      return {
        user: assignee,
        route: 'issue_assignee',
        hint: `No policy owner was resolved (${ownerHopMiss}), so the gap was routed to the change assignee.`,
      };
    }
  }

  for (const component of context.issue.components) {
    if (component.lead?.active && component.lead.accountId) {
      return {
        user: component.lead,
        route: 'component_lead',
        hint: `Routed to the ${component.name} component lead.`,
      };
    }
  }

  if (control.owner_account_id) {
    return {
      user: {
        accountId: control.owner_account_id,
        name: control.owner_display_name ?? control.owner_account_id,
        active: true,
      },
      route: 'control_owner',
      hint: 'Routed to the control owner from the registry.',
    };
  }

  return { user: null, route: 'none', hint: 'No owner could be resolved; the issue was left unassigned.' };
}

/**
 * The stable token that identifies one finding inside a Jira issue summary.
 *
 * The remediation guard used to compare the summary's `[AssureLoop] AC-01` prefix
 * only, so the *second* gap of the same control was treated as "already tracked" and
 * silently skipped. The token is derived from the finding key (work item +
 * requirement) and is short enough to read in a Jira list.
 */
export function remediationToken(findingKey: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < findingKey.length; index += 1) {
    hash ^= findingKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `AL-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Is a remediation for this gap already open?
 *
 * Forge SQL answers cheapest when it is reachable; a Rovo action can land on an
 * installation whose database is not, so Jira is asked as well. The Jira check is
 * the durable one — it survives a wiped database and a customer who filed the issue
 * by hand from a previous week.
 *
 * The Jira check matches the finding token first. Summaries written before v6.27
 * carry no token, so those are matched on `[AssureLoop] <code> · <claim>` — the same
 * claim of the same control, never another claim of that control.
 */
async function existingRemediation(
  projectKey: string,
  controlCode: string,
  claim: string,
  findingKey: string,
): Promise<{ key: string | null; checked: boolean; why?: string }> {
  try {
    const { ensureSchema, findRemediationByFinding } = await import('../schema/sql');
    await ensureSchema();
    const row = await findRemediationByFinding(findingKey);
    if (row) {
      return { key: row.jira_issue_key, checked: true };
    }
  } catch {
    // No SQL on this invocation: the Jira check below is the guard.
  }
  try {
    const open = await jqlSearch(
      `project = "${projectKey}" AND labels = "assureloop" AND labels = "remediation" AND statusCategory != Done ORDER BY created DESC`,
      50,
    );
    const token = remediationToken(findingKey);
    const tokenMatch = open.find((issue) => issue.summary.includes(token));
    if (tokenMatch) {
      return { key: tokenMatch.key, checked: true };
    }
    const legacyPrefix = `[AssureLoop] ${controlCode} · ${claim}`;
    const legacy = open.find(
      (issue) => !/\bAL-[0-9a-f]{8}\b/.test(issue.summary) && issue.summary.startsWith(legacyPrefix),
    );
    return { key: legacy?.key ?? null, checked: true };
  } catch (cause) {
    // Fail closed. The old `catch { return null }` meant "no guard ran, so create one",
    // and a transient JQL or SQL error produced a second issue for the same gap. If the
    // guard cannot read, the honest action is to raise nothing and say why: a finding
    // that is missing a remediation issue is visible and fixable, a duplicate is not.
    return {
      key: null,
      checked: false,
      why: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export async function closeGapsForIssue(options: {
  issueKey: string;
  controlCode?: string;
  cloudId: string;
  siteUrl?: string | null;
  /** The person asking; Confluence reads fall back to them. */
  accountId?: string | null;
  /** Window for the remediation due date. The action's input is honoured now. */
  dueInDays?: number;
  createIssue?: (input: {
    projectKey: string;
    summary: string;
    description: string;
    assigneeAccountId?: string | null;
    dueDate?: string;
    labels: readonly string[];
  }) => Promise<{ key: string; id: string }>;
}): Promise<CloseGapsReport> {
  const { createJiraIssue } = await import('../jira/rest');
  const create = options.createIssue ?? createJiraIssue;
  const dueInDays = Number.isFinite(options.dueInDays) && (options.dueInDays ?? 0) > 0 ? Math.trunc(options.dueInDays as number) : 14;
  const gate = await evaluateIssueGate({
    issueKey: options.issueKey,
    controlCode: options.controlCode,
    cloudId: options.cloudId,
    siteUrl: options.siteUrl,
    // C: the person asking was dropped here, so Confluence reads fell back to the
    // app's own identity — which sees no Confluence content at all. A policy claim
    // could then read as "no policy" and decide whether a remediation issue was
    // created on that basis. The caller's identity travels now, as it does in the
    // panel.
    accountId: options.accountId ?? null,
  });
  const report: CloseGapsReport = { created: [], skipped: [], routes: [] };
  if (!gate.issue || !gate.control) {
    return report;
  }
  // A control this work item does not claim is a template, not a finding. Raising
  // "[AssureLoop] AC-01 …" against an unlabelled ticket turns a judge's exploratory
  // click into a false audit finding in their own project, so it is refused with the
  // one action that fixes it (claim the work item first).
  if (!gate.control.claimed) {
    report.skipped.push({
      requirement: 'all claims',
      why: `No control label is on ${gate.issue.key}, so the control is a template rather than a finding — claim the work item for ${gate.control.code} first.`,
    });
    return report;
  }
  let control: ControlRow | null = null;
  try {
    control = await getControlByCode(gate.control.code);
  } catch {
    control = null;
  }
  const fallbackControl: ControlRow = control ?? {
    id: gate.control.code,
    code: gate.control.code,
    name: gate.control.name,
    regulation_ref: gate.control.regulationRef,
    cadence: gate.control.cadence as ControlRow['cadence'],
    risk_tier: gate.control.riskTier as ControlRow['risk_tier'],
    jira_label: `ctrl-${gate.control.code.toLowerCase()}`,
    jira_project_key: gate.issue.projectKey,
    owner_account_id: null,
    owner_display_name: gate.control.owner,
    status: 'ACTIVE',
  };
  const issue = await getIssue(options.issueKey);
  if (!issue.issue) {
    return report;
  }
  const requirements = await registryRequirements(fallbackControl);
  const context: ObservationContext = {
    cloudId: options.cloudId,
    siteUrl: options.siteUrl ?? null,
    issue: issue.issue,
    issueAri: `ari:cloud:jira:${options.cloudId}:issue/${issue.issue.id}`,
    accountId: options.accountId ?? null,
  };

  for (const row of gate.requirements) {
    if (row.state !== 'MISSING' && row.state !== 'STALE') {
      report.skipped.push({ requirement: row.claim, why: `${row.state.toLowerCase()} — nothing to close` });
      continue;
    }
    const requirement = requirements.find((candidate) => candidate.id === row.requirementId);
    if (!requirement) {
      continue;
    }
    const route = await routeOwner(context, requirement, fallbackControl);
    report.routes.push({
      requirement: row.claim,
      route: route.route,
      assignee: route.user?.name ?? null,
      hint: route.hint,
    });
    // Closing the same gap twice used to create two issues. The registry path
    // already guarded on the finding id; this path now guards on the same key and,
    // because Forge SQL may be unreachable from a chat invocation, also asks Jira
    // whether a remediation for this control is already open in the project.
    const findingKey = `${gate.issue.key}:${row.requirementId}`;
    const alreadyTracked = await existingRemediation(
      gate.issue.projectKey,
      fallbackControl.code,
      row.claim,
      findingKey,
    );
    if (!alreadyTracked.checked) {
      report.skipped.push({
        requirement: row.claim,
        why:
          `could not check whether this gap is already tracked (${alreadyTracked.why ?? 'read failed'}), ` +
          `so no issue was created. Nothing was duplicated; close the gaps again when the read answers.`,
      });
      continue;
    }
    if (alreadyTracked.key) {
      report.skipped.push({ requirement: row.claim, why: `already tracked as ${alreadyTracked.key}` });
      continue;
    }
    const dueDate = new Date(Date.now() + dueInDays * DAY_MS).toISOString().slice(0, 10);
    try {
      const created = await create({
        projectKey: gate.issue.projectKey,
        summary:
          `[AssureLoop] ${fallbackControl.code} · ${row.claim} [${remediationToken(findingKey)}] — ` +
          `${row.state === 'MISSING' ? 'evidence missing' : 'evidence stale'}`,
        description:
          `${row.reason}\n\n` +
          `Work item: ${gate.issue.key} — ${gate.issue.summary}\n` +
          `Control: ${fallbackControl.code} — ${fallbackControl.name}\n` +
          `Requirement: ${row.requirementId}\n` +
          `Finding: ${findingKey}\n` +
          `Regulation: ${fallbackControl.regulation_ref}\n` +
          `Owner route: ${route.route}${route.user ? ` (${route.user.name})` : ''}\n` +
          `Raised by the AssureLoop evidence gate.`,
        assigneeAccountId: route.user?.accountId ?? null,
        dueDate,
        labels: ['assureloop', 'remediation', fallbackControl.jira_label],
      });
      report.created.push({
        requirement: row.claim,
        claim: row.claim,
        createdIssue: created.key,
        assignee: route.user?.name ?? null,
        route: route.route,
        hint: route.hint,
      });
      // Persistence is best-effort: the issue exists whether or not SQL answers.
      try {
        const { ensureSchema, insertRemediation } = await import('../schema/sql');
        await ensureSchema();
        await insertRemediation({
          findingId: findingKey,
          jiraIssueKey: created.key,
          assigneeAccountId: route.user?.accountId ?? null,
          dueDate,
        });
      } catch {
        // ignore: the remediation table is an index, not the source of truth
      }
    } catch (cause) {
      report.skipped.push({
        requirement: row.claim,
        why: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return report;
}

/**
 * Exported for the regression tests: the two claim readers whose honesty is the
 * point (an artefact a connector must supply, and a record population), so they can
 * be exercised against a fake site rather than only through a full gate.
 */
export type { ObservationContext };
export { observeConnectorClaim, observePolicyClaim, observeTestRecordClaim, observeIndependenceClaim };
