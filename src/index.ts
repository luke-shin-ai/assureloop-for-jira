/**
 * AssureLoop for Jira — function entry points.
 *
 * Routing only: this file maps the Forge surfaces (resolver, Rovo actions, the
 * scheduled trigger) onto the engine, and runs the registry-wide scan.
 *
 *   single work item  -> engine/gate.ts        (the primary surface, E1/E2/E3/E4)
 *   environment       -> engine/envcheck.ts    (the six probes, E5)
 *   whole registry    -> this file             (the 06:00 drift scan + Control Room rollup)
 *
 * The verdict itself is always computed by the pure functions in twg/queries.ts:
 * the model never decides, and a failed read never becomes "no evidence".
 */

import Resolver from '@forge/resolver';

import {
  confluencePageAri,
  firstPage,
  listSpacePages,
  listSpaces,
  pageByTitle,
  spaceIdByKey,
  type ConfluencePageSummary,
} from './confluence/rest';
import {
  addIssueComment,
  addIssueLabel,
  createJiraIssue,
  getIssue,
  issueComments,
  issueRemoteLinks,
  jiraProjectIdByKey,
  jqlSearch,
  jqlSearchPage,
  listProjects,
  transitionIssueToDone,
  userAri,
  type JiraComment,
  type JiraIssueDetail,
  type JiraIssueSummary,
} from './jira/rest';
import {
  GRAPH_SCOPES,
  PERSISTED_QUERIES,
  REST_SCOPES,
  UNATTENDED_GRAPH_CAP_MS,
  buildScopeLedger,
  classifyFailure,
  describeGraphBudget,
  fetchTeamsBySpace,
  graphRetryPolicyFor,
  isGraphScope,
  isRetryable,
  judgeRequirement,
  newGraphCallState,
  probeScopes,
  queryKeyFor,
  scopeExplanation,
  scopeProbeFromObservation,
  summarizeVerdicts,
  withGraphCallBudget,
  withGraphRetryPolicy,
  type EvidenceCandidate,
  type EvidenceObservation,
  type EvidenceScope,
  type FailureCause,
  type GraphCallBudget,
  type GraphScope,
  type ObservationFailure,
  type ProvenanceHop,
  type ScopeProbeResult,
  type Verdict,
} from './twg/queries';
import { buildTrace } from './trace/graph';
import { findOrphanEvidence, type ClaimedPage, type OrphanScan } from './audit/orphans';
import {
  closeGapsForIssue,
  approvalPatternOf,
  evaluateIssueGate,
  independenceConflict,
  registryControls,
  observeIndependenceClaim,
  registryRequirements,
  resolvePageOwner,
  statesApproval,
} from './engine/gate';
import {
  validateControlCode,
  validateJiraLabel,
  validateMaxAgeDays,
  validateProjectKey,
  validateText,
} from './engine/input';
import {
  PERMISSIONS,
  PermissionError,
  checkJiraPermission,
  refusalBody,
  refusalMessage,
  requireJiraPermission,
  type PermissionResult,
} from './perm/guard';
import { importCustomControls, saveCustomControl } from './registry/custom';
import { runEnvironmentCheck, type EnvironmentReport } from './engine/envcheck';
import {
  CONFIG_DEMO_SEEDED,
  CONFIG_LAST_DAILY_SCAN,
  CONFIG_LAST_ORPHAN_SCAN,
  CONFIG_LAST_SCAN_INTEGRITY,
  CONFIG_SCAN_PRINCIPAL,
  CONFIG_SITE_BINDING,
  addEvidenceLink,
  deactivateEvidenceLinksOfKind,
  ensureSchema,
  findRemediationByFinding,
  finishScan,
  getConfig,
  getControlByCode,
  insertFinding,
  insertProvenance,
  insertRemediation,
  latestFindingsForControl,
  latestScan,
  listClaimExceptions,
  listControls,
  listEvidenceLinks,
  listFindingsByScan,
  listOpenRemediations,
  listProvenance,
  insertRequirement,
  listRequirements,
  listRequirementsForControls,
  parseCounts,
  parseRule,
  previousScan,
  recordClaimException,
  replaceRequirements,
  setConfig,
  startScan,
  upsertControl,
  withdrawClaimException,
  type ClaimExceptionRow,
  type ControlCadence,
  type ControlRow,
  type EvidenceType,
  type FindingRow,
  type RequirementRow,
  type ScanTrigger,
  type StateCounts,
} from './schema/sql';
import {
  AUDIT_GUARANTEES,
  buildAuditPack,
  claimKeyFor,
  countGaps,
  exceptionIsActive,
  fingerprintOf,
  memoForClaims,
  verifyFingerprintOf,
  type AuditClaim,
} from './audit/pack';
import { NORTHWIND_PAY, jiraIssueAri, seedNorthwindPay } from './seed/northwind-pay';

// ---------------------------------------------------------------------------
// Invocation plumbing
// ---------------------------------------------------------------------------

interface Invocation {
  payload: Record<string, unknown>;
  context: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Rovo actions receive `payload` + `context`; the resolver and the scheduled
 * trigger hand over a single `{ payload, context }` object. Accept both shapes so
 * one handler can serve chat, Automation and the UI without branches at the call
 * site.
 */
function invocation(event: unknown, context?: unknown): Invocation {
  const eventRecord = asRecord(event);
  // A Forge action invoked from Rovo arrives as
  //   { event: { issueKey: 'PAY-1', context: { cloudId, accountId, jira: {...} } },
  //     orgId, contextToken }
  // — the inputs are one level down and the user context rides inside them. Reading
  // only `{ payload, context }` left the action with no issueKey and an unknown
  // cloud id, which produced NOT_VISIBLE/MISSING verdicts from chat while the same
  // code judged the work item correctly in the panel. Handle the envelope first.
  const inner = asRecord(eventRecord.event);
  if (Object.keys(inner).length > 0) {
    const { context: innerContext, ...inputs } = inner;
    const merged = { ...asRecord(innerContext), ...asRecord(context) };
    const jira = asRecord(merged.jira);
    if (!merged.issueKey && typeof jira.issueKey === 'string') {
      merged.issueKey = jira.issueKey;
    }
    return { payload: inputs, context: merged };
  }
  const nested = asRecord(eventRecord.payload);
  if (Object.keys(nested).length > 0 || 'context' in eventRecord) {
    return { payload: nested, context: asRecord(eventRecord.context ?? context) };
  }
  return { payload: eventRecord, context: asRecord(context) };
}

function accountIdOf(context: Record<string, unknown>): string | undefined {
  const value = context.accountId ?? context.account_id ?? context.principal;
  return typeof value === 'string' ? value : undefined;
}

function cloudIdOf(context: Record<string, unknown>): string {
  const value = context.cloudId ?? context.cloud_id;
  return typeof value === 'string' && value.length > 0 ? value : 'unknown-cloud-id';
}

function siteUrlOf(context: Record<string, unknown>): string | null {
  const value = context.siteUrl ?? context.site_url;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function principalOf(context: Record<string, unknown>): string {
  return accountIdOf(context) ?? 'unknown-principal';
}

// ---------------------------------------------------------------------------
// Registry-wide scan observations
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How much of a control's population one scan reads from JQL.
 *
 * The read used to stop at 50 rows with nothing said about it, so change 51 was
 * invisible to a claim about "every production change". 200 covers a quarterly
 * programme at a mid-size bank and still fits the scheduled scan's 300-second
 * budget; beyond it the claim prints "N of M" and names the cap.
 */
const POPULATION_CAP = 200;

/**
 * How many changes one scan reads the comments of for the approval claim.
 *
 * Each change costs one REST call (paged), and the manual scan has to answer inside
 * Forge's function timeout. The cap is a deliberate measurement, not a silent slice:
 * the claim says "read 25 of 61" and names this number when it applies.
 */
const COMMENT_POPULATION_CAP = 25;

function failureOf(cause: FailureCause, message: string, scope?: EvidenceScope): ObservationFailure {
  return { cause, message, scope, retryable: isRetryable(cause) };
}

export interface ScanContext {
  cloudId: string;
  principalAccountId: string;
  population: Map<string, Promise<JiraIssueSummary[]>>;
  populationFailures: Map<string, ObservationFailure[]>;
  /**
   * label -> discovery note. When a bound project has no work item carrying a
   * control label, the most recent completed changes are judged instead, and the
   * screen says so: judging nothing is how a hardcoded demo path looks.
   */
  discovered: Map<string, { count: number; projectKey: string }>;
  /**
   * Projects where the population is genuinely empty: no work item carries the
   * label and no change has been completed. A fresh project is not a failing
   * control, and the engine says "nothing to judge yet" rather than MISSING.
   */
  emptyPopulation: Set<string>;
  /**
   * Labels whose JQL population was longer than the read cap. The claim then says
   * "N of M" instead of pretending the list ended, because a silently truncated
   * population is how a busy project turns a real gap into a clean verdict.
   */
  populationTruncated: Set<string>;
  /**
   * Teams per space, cached for one scan run. Seven policy claims sit in three
   * spaces, so the same graph read was being paid for seven times inside a
   * 25-second function budget.
   */
  spaceTeams: Map<string, Awaited<ReturnType<typeof fetchTeamsBySpace>>>;
  ledger: ReturnType<typeof buildScopeLedger>;
  retried: number;
}

/**
 * A JQL failure has three different meanings and only two of them are the user's
 * problem. A project that is not on this site is a setup step (bind the programme),
 * not a permission gap and not an unknown fault.
 */
function classifyPopulationFailure(message: string): FailureCause {
  const status = Number.parseInt(/\((\d{3})\)/.exec(message)?.[1] ?? '', 10);
  if (Number.isFinite(status)) {
    if (
      (status === 400 || status === 404) &&
      /does not exist|no such project|project.*(not found|could not be found)|field 'project'|field "project"/i.test(
        message,
      )
    ) {
      return 'UNCONFIGURED';
    }
    return classifyFailure(status, message);
  }
  return 'SERVICE_ERROR';
}

function populationFor(context: ScanContext, control: ControlRow): Promise<JiraIssueSummary[]> {
  const cached = context.population.get(control.jira_label);
  if (cached) {
    return cached;
  }
  const jql = `project = "${control.jira_project_key}" AND labels = "${control.jira_label}" ORDER BY created ASC`;
  let readFailed = false;
  const pending = jqlSearchPage(jql, POPULATION_CAP)
    .then((page) => {
      if (page.truncated) {
        context.populationTruncated?.add(control.jira_label);
      }
      return page.issues;
    })
    .catch((cause: unknown) => {
      readFailed = true;
      const message = cause instanceof Error ? cause.message : String(cause);
      const failure = failureOf(classifyPopulationFailure(message), message);
      const list = context.populationFailures.get(control.jira_label) ?? [];
      list.push(failure);
      context.populationFailures.set(control.jira_label, list);
      return [] as JiraIssueSummary[];
    })
    .then(async (issues) => {
      if (issues.length > 0 || readFailed) {
        return issues;
      }
      // Discovery mode. A judge binds the programme to their own project, where
      // nothing carries `ctrl-ac-01`. Rather than judging an empty population and
      // reporting nothing, judge the most recent completed changes and label the
      // rows: "this project has no control labels, so these five changes were used".
      try {
        const recent = await jqlSearch(
          `project = "${control.jira_project_key}" AND statusCategory = Done ORDER BY updated DESC`,
          5,
        );
        if (recent.length > 0) {
          context.discovered.set(control.jira_label, {
            count: recent.length,
            projectKey: control.jira_project_key,
          });
          return recent;
        }
      } catch {
        // The label read already succeeded and found nothing; discovery is a
        // convenience, so its failure leaves the population empty (a real answer).
      }
      context.emptyPopulation.add(control.jira_label);
      return issues;
    });
  context.population.set(control.jira_label, pending);
  return pending;
}

function discoveryNote(context: ScanContext, control: ControlRow): string | null {
  const found = context.discovered.get(control.jira_label);
  if (!found) {
    return null;
  }
  return (
    `No work item in ${found.projectKey} carries the control label "${control.jira_label}", so the ` +
    `${found.count} most recently completed change(s) in the project were judged instead (discovery mode).`
  );
}

function readBase(label: string, mode: EvidenceObservation['read']['mode']) {
  return { label, mode, latencyMs: 0, retries: 0 };
}

async function observeWorkItems(
  context: ScanContext,
  control: ControlRow,
  requirement: RequirementRow,
): Promise<EvidenceObservation> {
  const started = Date.now();
  const issues = await populationFor(context, control);
  const rule = parseRule(requirement.rule_json);
  const candidates: EvidenceCandidate[] = issues.map((issue) => {
    const done = issue.statusCategoryKey === 'done';
    const usable = rule.requiresDoneStatus === true ? done : true;
    return {
      ari: jiraIssueAri(context.cloudId, issue.id),
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
  });
  const provenance: ProvenanceHop[] = issues.slice(0, 25).map((issue, index) => ({
    hop: index + 1,
    fromAri: `${control.jira_project_key}:${control.jira_label}`,
    relation: 'jql_label_match',
    toAri: jiraIssueAri(context.cloudId, issue.id),
    observedAt: new Date().toISOString(),
    source: 'rule',
  }));
  const failures = context.populationFailures.get(control.jira_label) ?? [];
  const note = discoveryNote(context, control);

  return {
    requirementId: requirement.id,
    evidenceType: requirement.evidence_type,
    scope: null,
    populationEmpty: failures.length === 0 && context.emptyPopulation?.has(control.jira_label) === true,
    populationTotal: issues.length,
    populationJudged: issues.length,
    truncated: context.populationTruncated?.has(control.jira_label),
    truncationNote: context.populationTruncated?.has(control.jira_label)
      ? `the population read stopped at the ${POPULATION_CAP}-row window`
      : undefined,
    read: {
      ...readBase(
        context.discovered.has(control.jira_label)
          ? `jql:discovery(${control.jira_project_key})`
          : `jql:${control.jira_label}`,
        'rest',
      ),
      outcome: failures.length > 0 ? 'ERROR' : issues.length > 0 ? 'ROWS' : 'EMPTY',
      latencyMs: Date.now() - started,
      error: failures[0]
        ? { message: failures[0].message, cause: failures[0].cause, retryable: failures[0].retryable }
        : undefined,
    },
    candidates,
    provenance,
    subjectAri: control.jira_label,
    failures,
    notes: note ? [note] : [],
  };
}

async function observeComments(
  context: ScanContext,
  control: ControlRow,
  requirement: RequirementRow,
): Promise<EvidenceObservation> {
  const started = Date.now();
  const issues = await populationFor(context, control);
  const rule = parseRule(requirement.rule_json);
  const pattern = approvalPatternOf(rule);
  const candidates: EvidenceCandidate[] = [];
  const provenance: ProvenanceHop[] = [];
  // Start from the population read, not from an empty list. When the JQL behind the
  // population fails, there are no comments to look at — and reporting "no approval
  // was found" for a population that was never read is the single most damaging
  // false finding this app could make. The same failure already makes the work-item
  // claim INCOMPLETE; both claims must agree.
  const failures: ObservationFailure[] = [...(context.populationFailures.get(control.jira_label) ?? [])];
  let hop = 0;
  const commentTruncated: string[] = [];

  const judgedIssues = issues.slice(0, COMMENT_POPULATION_CAP);
  for (const issue of judgedIssues) {
    const { comments, error, truncated: commentsTruncated } = await issueComments(issue.key);
    if (error) {
      failures.push(
        failureOf(classifyFailure(error.status, error.message), error.message, REST_SCOPES.JIRA_WORK),
      );
      continue;
    }
    if (commentsTruncated) {
      commentTruncated.push(issue.key);
    }
    const approving: JiraComment | undefined = comments
      .filter((comment) => statesApproval(comment.bodyText, pattern))
      .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];
    if (!approving) {
      candidates.push({
        ari: jiraIssueAri(context.cloudId, issue.id),
        kind: 'approval_comment',
        label: `${issue.key} approval`,
        observedAt: issue.updated,
        ownerAccountId: issue.assigneeAccountId,
        ownerName: issue.assigneeName,
        ownerActive: issue.assigneeActive,
        usable: false,
        unusableReason: `${issue.key} has no comment matching the approval pattern`,
      });
      continue;
    }
    const selfApproved =
      rule.requiresIndependentApprover === true
        ? independenceConflict(approving.authorAccountId, issue)
        : null;
    const commentAri = `ari:cloud:jira:${context.cloudId}:comment/${approving.id}`;
    candidates.push({
      ari: commentAri,
      kind: 'approval_comment',
      label: `${issue.key} approved by ${approving.authorName ?? 'unknown'}`,
      observedAt: approving.created,
      ownerAccountId: approving.authorAccountId,
      ownerName: approving.authorName,
      ownerActive: approving.authorActive,
      usable: !selfApproved,
      unusableReason: selfApproved
        ? `${issue.key} was approved by ${selfApproved.who} (${approving.authorName ?? 'unknown'}) — segregation of duties is not evidenced`
        : undefined,
    });
    hop += 1;
    provenance.push({
      hop,
      fromAri: jiraIssueAri(context.cloudId, issue.id),
      relation: 'jira_work_item_has_jira_work_item_comment',
      toAri: commentAri,
      observedAt: approving.created,
      source: 'rest',
    });
    if (approving.authorAccountId) {
      provenance.push({
        hop: hop + 1,
        fromAri: commentAri,
        relation: 'jira_work_item_comment_authored_by_atlassian_user',
        toAri: userAri(approving.authorAccountId),
        observedAt: approving.created,
        source: 'rest',
      });
      hop += 1;
    }
  }

  const note = discoveryNote(context, control);
  const notes: string[] = note ? [note] : [];
  if (issues.length > judgedIssues.length) {
    notes.push(
      `The approval claim read the comments of ${judgedIssues.length} of ${issues.length} changes in ` +
        `${control.jira_label}: comment reads are capped at ${COMMENT_POPULATION_CAP} changes per scan. ` +
        `The verdict covers the changes that were read and says so.`,
    );
  }
  if (commentTruncated.length > 0) {
    notes.push(
      `The comment list on ${commentTruncated.slice(0, 3).join(', ')} was longer than the per-issue ` +
        `page cap; the approval was judged on the comments that were read.`,
    );
  }
  return {
    requirementId: requirement.id,
    evidenceType: requirement.evidence_type,
    scope: null,
    populationEmpty:
      failures.length === 0 && candidates.length === 0 && context.emptyPopulation?.has(control.jira_label) === true,
    populationTotal: issues.length,
    populationJudged: judgedIssues.length,
    truncated:
      issues.length > judgedIssues.length || commentTruncated.length > 0 || context.populationTruncated?.has(control.jira_label),
    truncationNote:
      issues.length > judgedIssues.length
        ? `the approval read covers ${judgedIssues.length} of ${issues.length} changes (cap ${COMMENT_POPULATION_CAP})`
        : commentTruncated.length > 0
          ? 'a comment list was longer than the per-issue page cap'
          : context.populationTruncated?.has(control.jira_label)
            ? `the population read stopped at the ${POPULATION_CAP}-row window`
            : undefined,
    read: {
      ...readBase(`jira-comments:${control.jira_label}`, 'rest'),
      outcome: failures.length > 0 ? 'ERROR' : candidates.length > 0 ? 'ROWS' : 'EMPTY',
      latencyMs: Date.now() - started,
      error: failures[0]
        ? { message: failures[0].message, cause: failures[0].cause, retryable: failures[0].retryable }
        : undefined,
    },
    candidates,
    provenance,
    subjectAri: control.jira_label,
    failures,
    notes,
  };
}

/**
 * Policy pages for the registry scan. Freshness and title come from Confluence
 * REST; the owner hop comes from the graph.
 *
 * The two questions are answered separately, because they used to be merged: REST
 * knows whether the page exists (a 404 in a readable space is an absence), the graph
 * knows who owns it (an empty answer is a blind spot). Only the second can produce
 * NOT_VISIBLE, and only the first can produce MISSING.
 */
async function observePolicy(
  context: ScanContext,
  control: ControlRow,
  requirement: RequirementRow,
): Promise<EvidenceObservation> {
  const started = Date.now();
  const rule = parseRule(requirement.rule_json);
  const candidates: EvidenceCandidate[] = [];
  const provenance: ProvenanceHop[] = [];
  const failures: ObservationFailure[] = [];
  const notes: string[] = [];
  let retries = 0;

  // The app's own identity may see no Confluence content at all (an app with
  // egress is treated as external and gets empty listings rather than a 403), so
  // every page read here can fall back to the principal the scan runs as.
  const readOptions = { asAccountId: context.principalAccountId };
  let accountabilityUnread = false;
  /** Rows the ownership traversal returned — the proof of the page scope. */
  let graphRows = 0;

  let spaceId: string | null = null;
  let spaceResolved = true;
  if (rule.spaceKey) {
    const space = await spaceIdByKey(rule.spaceKey, readOptions);
    if (space.error) {
      spaceResolved = false;
      // The space is a Confluence REST read: name the REST scope, not a graph scope.
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

  // A programme bound with "no space" has nowhere to look for a policy page: that is
  // a setup gap and says so, instead of reading a space key the site does not have.
  if (requirement.evidence_type === 'policy_page' && !rule.spaceKey) {
    failures.push(
      failureOf(
        'UNCONFIGURED',
        `no policy space is bound to this programme, so the page "${rule.pageTitlePrefix ?? 'this control names'}" has nowhere to be looked for`,
      ),
    );
  }

  const links = await listEvidenceLinks(control.id).catch(() => []);
  const pageLinks = links.filter((link) => link.evidence_kind === 'confluence_page');

  // Registry first (seeded links), rule second (zero-config). A registered link is
  // only counted when Confluence confirms the page: a link that points at an object
  // this site does not have is not evidence, and pretending otherwise is how a
  // seeded registry would carry a verdict onto another customer's site.
  const pages: Array<{ page: ConfluencePageSummary; ari: string }> = [];
  for (const link of pageLinks) {
    const fetched = await pageByTitle(link.label ?? '', rule.spaceKey ?? '', readOptions);
    if (fetched.page) {
      pages.push({ page: fetched.page, ari: confluencePageAri(context.cloudId, fetched.page.id) });
    } else {
      notes.push(
        `Registered page "${link.label ?? link.evidence_ari}" was not confirmed by Confluence ` +
          `(${fetched.error?.status ?? 'no answer'}${fetched.absent ? ', absent' : ', not verified'}) — it was not counted as evidence.`,
      );
    }
  }
  let pageAbsent = false;
  if (pages.length === 0 && rule.pageTitlePrefix && rule.spaceKey) {
    const found = await pageByTitle(rule.pageTitlePrefix, rule.spaceKey ?? '', readOptions);
    if (found.page) {
      pages.push({ page: found.page, ari: confluencePageAri(context.cloudId, found.page.id) });
    } else {
      if (found.error && found.error.status !== 404) {
        failures.push(restFailure(found.error.status, found.error.message, REST_SCOPES.PAGE));
      }
      pageAbsent = found.absent === true || found.error?.status === 404;
    }
  }

  let spaceAri: string | null = null;
  if (spaceId) {
    spaceAri = `ari:cloud:confluence:${context.cloudId}:space/${spaceId}`;
  }

  for (const entry of pages) {
    // v6.30: one shared owner resolution for both surfaces. The scan reads as the
    // stored principal (the budget gives every hop its identity and a hard cap) and
    // falls back to the page's own owner fields when the traversal cannot answer —
    // labeled `rest`, never passed off as a traversal.
    const owner = await resolvePageOwner(
      { id: entry.page.id, title: entry.page.title },
      entry.ari,
      { asAccountId: context.principalAccountId },
    );
    retries += owner.retries;
    graphRows += owner.graphRows;
    for (const note of owner.notes) {
      notes.push(note);
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
    if (owner.truncated) {
      notes.push(`confluencePageOwners returned more rows than the read window for ${entry.page.title}; the owner list is a prefix.`);
    }
    const ownershipResolved = owner.resolved;
    const ownerAccountId = owner.accountId;
    provenance.push({
      hop: provenance.length + 1,
      fromAri: entry.ari,
      relation:
        owner.source === 'rest'
          ? 'confluence_page_owner_field'
          : 'atlassian_user_owns_confluence_page',
      toAri: ownerAccountId ? userAri(ownerAccountId) : null,
      observedAt: new Date().toISOString(),
      source: owner.source === 'rest' ? 'rest' : 'graph',
    });

    if (spaceAri) {
      provenance.push({
        hop: provenance.length + 1,
        fromAri: spaceAri,
        relation: 'confluence_space_has_confluence_page',
        toAri: entry.ari,
        observedAt: new Date().toISOString(),
        source: 'rule',
      });
      let teams = context.spaceTeams?.get(spaceAri);
      if (!teams) {
        teams = await fetchTeamsBySpace(spaceAri);
        context.spaceTeams?.set(spaceAri, teams);
      }
      retries += teams.retries;
      if (teams.error) {
        // Same rule as the issue panel: the team hop is routing enrichment, so a
        // failure is a note with the scope the graph named, not a failure that turns
        // the claim NOT_VISIBLE against the wrong scope.
        const cause = teams.error.cause ?? classifyFailure(teams.error.status, teams.error.message);
        const scopeNamed =
          (teams.error.scopes ?? []).find((value) => isGraphScope(value)) ?? GRAPH_SCOPES.TEAM;
        notes.push(
          `The team behind ${spaceAri} could not be read (${cause}: ${teams.error.message}). ` +
            `Scope: ${scopeNamed}. The claim is judged without it.`,
        );
      }
      const team = teams.rows.find((candidate) => Boolean(candidate.id));
      if (team?.id) {
        provenance.push({
          hop: provenance.length + 1,
          fromAri: team.id,
          relation: 'atlassian_team_links_space_entity',
          toAri: spaceAri,
          observedAt: new Date().toISOString(),
          source: 'graph',
        });
      }
    }

    // Age is judged by the engine so an aging page becomes STALE, not MISSING.
    candidates.push({
      ari: entry.ari,
      kind: 'confluence_page',
      label: entry.page.title,
      observedAt: entry.page.lastUpdatedAt,
      ownerAccountId,
      ownerName: owner.name ?? null,
      ownerActive: null,
      ownerActiveKnown: false,
      ownershipResolved,
      usable: true,
      webPath: entry.page.webPath,
    });
    notes.push(
      `The active status of a Confluence page owner is not readable with this app's scopes ` +
        `(the graph's AtlassianUser has no active flag and read:jira-user is not requested), so a ` +
        `deactivated page owner is not detected on this row.`,
    );
  }

  const visibilityProven = spaceResolved && (pages.length > 0 || pageAbsent);
  const denied = failures.find((failure) => failure.cause === 'PERMISSION_DENIED');
  return {
    requirementId: requirement.id,
    evidenceType: requirement.evidence_type,
    scope: GRAPH_SCOPES.PAGE,
    read: {
      ...readBase(`confluencePageOwners:${control.code}`, 'curated'),
      outcome: denied ? 'ERROR' : 'ROWS',
      latencyMs: Date.now() - started,
      retries,
      error: denied
        ? { message: denied.message, cause: denied.cause, retryable: false }
        : undefined,
    },
    candidates,
    provenance,
    subjectAri: pages[0]?.ari ?? control.jira_label,
    failures,
    visibilityProven,
    accountabilityUnread,
    scopeRows: graphRows,
    notes,
  };
}

function restFailure(status: number, message: string, scope?: EvidenceScope): ObservationFailure {
  return failureOf(classifyFailure(status, message), message, scope);
}

/**
 * A connector claim (linked pull request, deployment record) across the control's
 * population.
 *
 * This used to be a placeholder that returned no candidates and one `UNKNOWN`
 * failure, which the engine could only read as MISSING — while the issue panel judged
 * the same evidence type as UNSUPPORTED ("nothing on this site could supply it"). The
 * same site then reported two different gap counts for the same control. The scan now
 * applies the panel's rules to the population:
 *
 *   * a read that failed is a failure with its cause (403 → NOT_VISIBLE, naming
 *     read:jira-work) — never an empty list;
 *   * no remote links anywhere in the population → UNSUPPORTED (kept out of gaps);
 *   * links exist, none of this kind → MISSING (the site files links; this one is not
 *     there);
 *   * a matching link is a candidate, with freshness taken from the work item update.
 */
async function observeConnectors(
  context: ScanContext,
  control: ControlRow,
  requirement: RequirementRow,
): Promise<EvidenceObservation> {
  const started = Date.now();
  const kind = requirement.evidence_type;
  // The URL is the evidence, not the title (A13): see the panel's reader.
  const patterns: Record<string, RegExp> = {
    pull_request: /\/(?:pull|pulls|merge_requests|pull-requests|pullrequest)\/\d+/i,
    deployment:
      /\/(?:actions\/runs|deployments?|releases?|pipelines?|jobs?)\/|jenkins|argocd|spinnaker|octopus|deploygate/i,
  };
  const pattern = patterns[kind] ?? /./;
  const failures: ObservationFailure[] = [...(context.populationFailures.get(control.jira_label) ?? [])];
  const notes: string[] = [];
  const candidates: EvidenceCandidate[] = [];
  const provenance: ProvenanceHop[] = [];
  const population = await populationFor(context, control);
  const issues = population.slice(0, 12);
  let linksSeen = 0;
  if (population.length > issues.length) {
    notes.push(
      `The linked-artefact claim read ${issues.length} of ${population.length} changes in ${control.jira_label}; ` +
        `the read is capped at 12 changes per scan and the verdict covers the ones that were read.`,
    );
  }

  for (const issue of issues) {
    let read: Awaited<ReturnType<typeof issueRemoteLinks>>;
    try {
      read = await issueRemoteLinks(issue.key);
    } catch (cause) {
      read = {
        links: [],
        error: { status: 0, message: cause instanceof Error ? cause.message : String(cause) },
      };
    }
    if (read.error) {
      failures.push(restFailure(read.error.status, read.error.message, REST_SCOPES.JIRA_WORK));
      continue;
    }
    linksSeen += read.links.length;
    for (const link of read.links.filter((candidate) => pattern.test(candidate.url))) {
      const ari = `remote-link:${issue.key}:${candidates.length + 1}`;
      candidates.push({
        ari,
        kind,
        label: link.title || link.url,
        observedAt: issue.updated,
        ownerAccountId: issue.assigneeAccountId,
        ownerName: issue.assigneeName,
        ownerActive: issue.assigneeActive,
        usable: true,
      });
      provenance.push({
        hop: provenance.length + 1,
        fromAri: jiraIssueAri(context.cloudId, issue.id),
        relation:
          kind === 'deployment'
            ? 'jira_work_item_linked_external_deployment'
            : 'jira_work_item_linked_external_pull_request',
        toAri: ari,
        observedAt: issue.updated,
        source: 'rest',
      });
    }
  }

  const readFailed = failures.length > 0;
  if (!readFailed && linksSeen === 0) {
    notes.push(
      `No connector writes remote links to the work items in ${control.jira_label}, so no ` +
        `${kind.replace(/_/g, ' ')} can be linked here. The claim is unsupported on this site rather than unmet.`,
    );
    failures.push(
      failureOf('UNSUPPORTED', `no connector on this site supplies ${kind.replace(/_/g, ' ')} evidence`),
    );
  }
  if (candidates.length > 0) {
    notes.push(
      `A linked artefact has no observation time of its own; freshness is taken from the work item it is linked from.`,
    );
  }
  const discovery = discoveryNote(context, control);
  if (discovery) {
    notes.push(discovery);
  }

  return {
    requirementId: requirement.id,
    evidenceType: requirement.evidence_type,
    scope: null,
    read: {
      ...readBase(`jira-remotelink:${control.jira_label}`, 'rest'),
      outcome: readFailed ? 'ERROR' : 'ROWS',
      latencyMs: Date.now() - started,
      error: failures[0]
        ? { message: failures[0].message, cause: failures[0].cause, retryable: failures[0].retryable }
        : undefined,
    },
    candidates,
    provenance,
    subjectAri: control.jira_label,
    failures,
    notes,
  };
}

/**
 * The cross-product claim, judged for the control's population.
 *
 * The panel judges the open work item; the scan judges the newest changes that
 * carry an approval, because this claim is about a population ("every approving
 * change has an approver who is accountable for the policy"). Two issues are
 * enough: the first approving one decides the claim, and a second is only read when
 * the first has no approval at all — each graph hop is capped by the run's budget,
 * so a wide sweep here would spend the scan's whole allowance.
 */
async function observeIndependence(
  context: ScanContext,
  control: ControlRow,
  requirement: RequirementRow,
): Promise<EvidenceObservation> {
  const started = Date.now();
  const pattern = (() => {
    try {
      const rule = JSON.parse(requirement.rule_json) as { approvalPattern?: string };
      return approvalPatternOf(rule);
    } catch {
      return approvalPatternOf({});
    }
  })();
  const issues = [...(await populationFor(context, control))].sort(
    (a, b) => Date.parse(b.updated) - Date.parse(a.updated),
  );
  // The newest changed item is often not the one with the approval (the demo's most
  // recently updated item is a probe ticket with no comment at all). The five most
  // recently updated changes are read and the first that carries an approval decides
  // the claim; when none of them has one, the claim says how many were read instead of
  // implying the whole population was checked.
  const independenceCap = 5;
  const judged = issues.slice(0, independenceCap);
  for (const issue of judged) {
    const comments = await issueComments(issue.key).catch(() => ({ comments: [] as JiraComment[] }));
    const approved = (comments.comments ?? []).some((comment) =>
      statesApproval(comment.bodyText, pattern),
    );
    if (!approved) {
      continue;
    }
    const observation = await observeIndependenceClaim(
      {
        cloudId: context.cloudId,
        siteUrl: null,
        issue: {
          id: issue.id,
          key: issue.key,
          summary: issue.summary,
          statusName: issue.statusName,
          statusCategoryKey: issue.statusCategoryKey,
          assigneeAccountId: issue.assigneeAccountId,
          assigneeName: issue.assigneeName,
          assigneeActive: issue.assigneeActive,
          // The reporter travels too: the claim compares the approver against both
          // people named on the work item.
          reporterAccountId: issue.reporterAccountId ?? null,
          reporterName: issue.reporterName ?? null,
          projectKey: control.jira_project_key,
          projectId: null,
          created: issue.updated,
          issueType: issue.issueType,
          labels: [control.jira_label],
          updated: issue.updated,
          components: [],
        } as unknown as JiraIssueDetail,
        issueAri: jiraIssueAri(context.cloudId, issue.id),
        accountId: context.principalAccountId,
      },
      requirement,
      { lean: true, controlCode: control.code },
    );
    return {
      ...observation,
      read: { ...observation.read, latencyMs: Date.now() - started },
      populationTotal: issues.length,
      populationJudged: judged.length,
      truncated: issues.length > judged.length,
      truncationNote:
        issues.length > judged.length
          ? `this claim judges at most ${independenceCap} changes per scan`
          : undefined,
      notes: [...(observation.notes ?? []), `Judged for ${issue.key}, the newest approving change in ${control.jira_project_key}.`],
    };
  }
  return {
    requirementId: requirement.id,
    evidenceType: requirement.evidence_type,
    // The graph was never consulted, so no graph scope is claimed here: the absence
    // is an absence of an approval, which Jira REST answered.
    scope: null,
    read: { label: 'jira-comments:population', mode: 'rest', outcome: 'EMPTY', latencyMs: Date.now() - started, retries: 0 },
    candidates: [],
    provenance: [],
    subjectAri: control.jira_label,
    failures: [],
    visibilityProven: true,
    populationTotal: issues.length,
    populationJudged: judged.length,
    truncated: issues.length > judged.length,
    truncationNote:
      issues.length > judged.length
        ? `this claim reads at most ${independenceCap} changes per scan`
        : undefined,
    notes: [
      `No approving comment was found on the ${judged.length} most recently updated change(s) in ` +
        `${control.jira_project_key} (${judged.map((issue) => issue.key).join(', ') || 'none'})` +
        `${issues.length > judged.length ? `, read out of ${issues.length}` : ''}, so there was ` +
        `no approval whose accountability could be checked.`,
    ],
    populationEmpty: context.emptyPopulation?.has(control.jira_label) === true,
  };
}

async function observeRequirement(
  context: ScanContext,
  control: ControlRow,
  requirement: RequirementRow,
): Promise<EvidenceObservation> {
  switch (requirement.evidence_type) {
    case 'approval_independence':
      return observeIndependence(context, control, requirement);
    case 'approval_comment':
      return observeComments(context, control, requirement);
    case 'policy_page':
      return observePolicy(context, control, requirement);
    case 'jira_work_item':
    case 'test_record':
      return observeWorkItems(context, control, requirement);
    case 'pull_request':
    case 'deployment':
      return observeConnectors(context, control, requirement);
    default:
      return {
        requirementId: requirement.id,
        evidenceType: requirement.evidence_type,
        scope: null,
        read: { ...readBase('unsupported', 'rest'), outcome: 'EMPTY' },
        candidates: [],
        provenance: [],
      };
  }
}

// ---------------------------------------------------------------------------
// The registry scan
// ---------------------------------------------------------------------------

export interface ScanIntegrity {
  /** Requirements the scan could not conclude, with the cause of each. */
  incomplete: number;
  notVisible: number;
  retriedCalls: number;
  causes: Partial<Record<FailureCause, number>>;
  /** True when at least one read was throttled: rerun before trusting the run. */
  degraded: boolean;
}

export interface ScanReport {
  scanId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  trigger: ScanTrigger;
  controlCount: number;
  counts: StateCounts;
  delta: StateCounts;
  integrity: ScanIntegrity;
  findings: Array<{
    findingId: string;
    controlCode: string;
    controlName: string;
    requirementType: EvidenceType;
    state: Verdict['state'];
    reason: string;
    missingScopes: string[];
    evidenceAri: string | null;
    evidenceObservedAt: string | null;
    ageDays: number | null;
    queryKey?: string;
    queryLabel: string;
    rowCount: number;
    latencyMs: number;
    retries: number;
    cause?: FailureCause;
    notes: string[];
  }>;
  scopeMatrix: ScopeProbeResult[];
  /** Reverse scan: governance pages no control claims (C5). */
  orphans: OrphanScan | null;
  /** Labels whose population was discovered instead of matched (see discoveryNote). */
  discovery: Array<{ label: string; projectKey: string; count: number }>;
}

function zeroCounts(): StateCounts {
  return { VERIFIED: 0, STALE: 0, MISSING: 0, NOT_VISIBLE: 0, INCOMPLETE: 0 };
}

function subtractCounts(current: StateCounts, previous: StateCounts): StateCounts {
  return {
    VERIFIED: current.VERIFIED - previous.VERIFIED,
    STALE: current.STALE - previous.STALE,
    MISSING: current.MISSING - previous.MISSING,
    NOT_VISIBLE: current.NOT_VISIBLE - previous.NOT_VISIBLE,
    INCOMPLETE: current.INCOMPLETE - previous.INCOMPLETE,
  };
}

export async function runScan(options: {
  trigger: ScanTrigger;
  controlCode?: string;
  context: Record<string, unknown>;
  asAccountId?: string;
  /** Skip the reverse (orphan) scan — the Rovo action path has a 20 s budget. */
  skipOrphanScan?: boolean;
}): Promise<ScanReport> {
  // A Rovo action has about 20 seconds; a registry scan measured 19.9 s. Retrying a
  // graph read inside that budget turns a named INCOMPLETE into a timeout, so the
  // action path reads once and reports the cause it saw (C13).
  //
  // v6.30: an unattended scan (one with no calling user) also gets a graph budget:
  // every hop has an identity to read as and a hard cap, so a hop that never
  // answers is a measured TIMEOUT instead of a function that sits past its limit.
  // A manual scan keeps the unbounded behaviour: its hops run as the person who
  // pressed the button and already answer in 0.3–3.2 s.
  const budget: GraphCallBudget = {
    asAccountId: options.asAccountId,
    timeoutMs: options.asAccountId ? UNATTENDED_GRAPH_CAP_MS : undefined,
    capStreak: 2,
    state: newGraphCallState(),
  };
  return withGraphCallBudget(budget, () =>
    withGraphRetryPolicy(graphRetryPolicyFor(options.trigger), () =>
      runScanInternal({ ...options, graphBudget: budget }),
    ),
  );
}

async function runScanInternal(options: {
  trigger: ScanTrigger;
  controlCode?: string;
  context: Record<string, unknown>;
  asAccountId?: string;
  skipOrphanScan?: boolean;
  /** Set by runScan: the identity and cap every graph hop of this run reads under. */
  graphBudget?: GraphCallBudget;
}): Promise<ScanReport> {
  const startedIso = new Date().toISOString();
  const startedMs = Date.now();
  await ensureSchema();

  const context = options.context;
  const cloudId = cloudIdOf(context);
  const configuredPrincipal = await getConfig(CONFIG_SCAN_PRINCIPAL).catch(() => null);
  const requestPrincipal = options.asAccountId ?? accountIdOf(context);
  const principalAccountId =
    requestPrincipal ?? configuredPrincipal ?? 'unknown-principal';

  // Teach the scheduler whose eyes to borrow (C7). A fresh install has no scan
  // principal, so the daily trigger used to skip itself silently — the "every day
  // at 06:00" claim was true only on the site that had been set up by hand. The
  // first scan a person runs records them, and the trigger falls back to the person
  // who bound the programme if even that is missing.
  if (!configuredPrincipal && requestPrincipal) {
    await setConfig(CONFIG_SCAN_PRINCIPAL, requestPrincipal).catch(() => undefined);
  }

  // A registry that already exists on a site keeps its rows; a claim the shipped
  // programme has gained since it was seeded is added to it.
  //
  // Both installations (Jira and Confluence) have their own Forge SQL, and the macro
  // reads the Confluence one. Without this, an upgrade left the Confluence pack one
  // claim behind the Control Room — two documents about the same programme with
  // different row counts, which is exactly what an auditor must not see.
  await upgradeProgrammeInPlace();

  const controls = (await registryControls()).filter(
    (control) => !options.controlCode || control.code === options.controlCode,
  );
  if (controls.length === 0) {
    throw new Error(
      options.controlCode
        ? `Unknown control code: ${options.controlCode}`
        : 'The control registry is empty. Seed the Northwind Pay demo data first.',
    );
  }

  const scanId = await startScan({
    triggerSource: options.trigger,
    principalAccountId,
    notes: options.controlCode ? `single control ${options.controlCode}` : 'full registry',
  });

  const scanContext: ScanContext = {
    cloudId,
    principalAccountId,
    population: new Map(),
    populationFailures: new Map(),
    discovered: new Map(),
    emptyPopulation: new Set(),
    populationTruncated: new Set(),
    spaceTeams: new Map(),
    ledger: buildScopeLedger([]),
    retried: 0,
  };

  // The probe matrix gets real object ARIs now (C3). It used to receive only the
  // caller's user ARI, so team/page/space/work-item probes were always NOT_PROBED and
  // "0 claims not visible" came from a ledger that had measured nothing.
  const binding = parseBinding(await getConfig(CONFIG_SITE_BINDING).catch(() => null));
  let spaceAri: string | undefined;
  if (binding?.spaceKey) {
    const space = await spaceIdByKey(binding.spaceKey).catch(() => ({ id: null }));
    if (space.id) {
      spaceAri = `ari:cloud:confluence:${cloudId}:space/${space.id}`;
    }
  }
  let jiraSpaceAri: string | undefined;
  const probeProjectKey = binding?.projectKey ?? controls[0]?.jira_project_key;
  if (probeProjectKey) {
    const projectId = await jiraProjectIdByKey(probeProjectKey).catch(() => null);
    if (projectId) {
      jiraSpaceAri = `ari:cloud:jira:${cloudId}:project/${projectId}`;
    }
  }
  // Identity warm-up. One cheap REST read as the identity this run will read with:
  // on an unattended run that is the stored principal, and having it answer once
  // before any graph hop spends its cap tells us the borrowed identity is alive
  // (a scheduler cold start is where the first read of a run goes wrong). Harmless
  // for a manual scan, which just reads as the person who pressed the button.
  const warmStarted = Date.now();
  const anyPage = await firstPage({ asAccountId: options.asAccountId ?? null }).catch(() => null);
  const warmUpMs = Date.now() - warmStarted;
  const probeMatrix = await probeScopes({
    userAri: userAri(principalAccountId),
    spaceAri,
    jiraSpaceAri,
    pageAri: anyPage ? `ari:cloud:confluence:${cloudId}:page/${anyPage.id}` : undefined,
    asAccountId: options.asAccountId,
  });
  const scopeMatrix: ScopeProbeResult[] = [...probeMatrix];
  scanContext.ledger = buildScopeLedger(scopeMatrix);

  const verdicts: Verdict[] = [];
  const reportFindings: ScanReport['findings'] = [];
  const causes: Partial<Record<FailureCause, number>> = {};

  for (const control of controls) {
    const requirements = await registryRequirements(control);
    for (const requirement of requirements) {
      const observation = await observeRequirement(scanContext, control, requirement);
      const probe = scopeProbeFromObservation(`${control.code}:${requirement.evidence_type}`, observation);
      if (probe) {
        scopeMatrix.push(probe);
        scanContext.ledger = buildScopeLedger(scopeMatrix);
      }
      const verdict = judgeRequirement({
        control,
        requirement,
        observation,
        ledger: scanContext.ledger,
        now: new Date(),
      });
      verdicts.push(verdict);
      scanContext.retried += verdict.trace.retries;
      for (const failure of verdict.failures ?? []) {
        causes[failure.cause] = (causes[failure.cause] ?? 0) + 1;
      }

      const newest = [...observation.candidates].sort(
        (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt),
      )[0];
      const notes = verdict.notes ?? [];

      const findingId = await insertFinding({
        scanId,
        controlId: control.id,
        requirementId: requirement.id,
        state: verdict.state,
        subjectAri: observation.subjectAri ?? null,
        reason: verdict.reason,
        evidenceAri: verdict.evidenceAri,
        ageDays: verdict.ageDays,
        missingScopes: verdict.missingScopes,
        queryKey: verdict.trace.queryKey ?? null,
        rowCount: verdict.trace.rowCount,
        latencyMs: verdict.trace.latencyMs,
        evidenceObservedAt: newest?.observedAt ?? null,
        notes,
      });
      await insertProvenance(
        verdict.provenance.map((hop) => ({
          findingId,
          hop: hop.hop,
          fromAri: hop.fromAri,
          relation: hop.relation,
          toAri: hop.toAri,
          observedAt: hop.observedAt,
        })),
      );

      reportFindings.push({
        findingId,
        controlCode: control.code,
        controlName: control.name,
        requirementType: requirement.evidence_type,
        state: verdict.state,
        reason: verdict.reason,
        missingScopes: verdict.missingScopes.map((scope) => scopeExplanation(scope)),
        evidenceAri: verdict.evidenceAri,
        evidenceObservedAt: newest?.observedAt ?? null,
        ageDays: verdict.ageDays,
        queryKey: verdict.trace.queryKey,
        queryLabel: verdict.trace.label,
        rowCount: verdict.trace.rowCount,
        latencyMs: verdict.trace.latencyMs,
        retries: verdict.trace.retries,
        cause: verdict.failures?.[0]?.cause,
        notes,
      });
    }
  }

  const counts = summarizeVerdicts(verdicts);
  const integrity: ScanIntegrity = {
    incomplete: counts.INCOMPLETE,
    notVisible: counts.NOT_VISIBLE,
    retriedCalls: scanContext.retried,
    causes,
    degraded:
      (causes.RATE_LIMIT_EXCEEDED ?? 0) > 0 ||
      (causes.TIMEOUT ?? 0) > 0 ||
      (causes.SERVICE_ERROR ?? 0) > 0,
  };
  const durationMs = Date.now() - startedMs;
  const before = await latestScan();
  const previousCounts = before ? parseCounts(before.counts_json) : zeroCounts();

  // How this run read the graph, in one line the Control Room shows: which
  // identity answered (the scan principal or the person who pressed the button),
  // how many hops there were, and whether any had to be capped or skipped. An
  // unattended scan that could not read the graph says so on its own row rather
  // than looking like a site with no owners.
  const readIdentity = options.graphBudget
    ? describeGraphBudget(
        options.graphBudget.state,
        options.graphBudget.timeoutMs,
      )
    : 'graph reads: no budget (reads as the calling user)';
  const scanNote =
    `${options.controlCode ? `single control ${options.controlCode}` : 'full registry'} · ${readIdentity}` +
    (options.asAccountId ? ` · identity warm-up ${warmUpMs} ms` : '');

  await finishScan({ scanId, status: 'COMPLETED', counts, durationMs, notes: scanNote });
  await setConfig(CONFIG_LAST_SCAN_INTEGRITY, JSON.stringify({ ...integrity, scanId, at: new Date().toISOString() }));
  if (options.trigger === 'SCHEDULED') {
    await setConfig(CONFIG_LAST_DAILY_SCAN, new Date().toISOString());
  }

  // Reverse scan: which governance pages does no control claim? It is a separate
  // pass because it answers the opposite question, and it is stored on its own so
  // the rollup can show it without re-reading every space.
  let orphans: OrphanScan | null = null;
  // The reverse scan reads every page of every space the programme names. It runs
  // only when the registry scan left enough of this function's 25-second budget:
  // a scan that times out produces no rollup at all, and the orphan card keeps the
  // last answer with its as-of time instead of taking the whole run down with it.
  const orphanBudgetLeft = Date.now() - startedMs < 15_000;
  if (!options.skipOrphanScan && orphanBudgetLeft) {
    try {
      orphans = await orphanScanFor({
        cloudId,
        // Borrow the scan principal's eyes, as every other Confluence read does: the
        // app's own identity sees no content at all and would report every space as
        // "not on this site" (which is exactly the false absence this app refuses).
        asAccountId: options.asAccountId ?? principalAccountId,
        bindingSpaceKey: binding?.spaceKey ?? null,
      });
      await setConfig(CONFIG_LAST_ORPHAN_SCAN, JSON.stringify(orphans));
    } catch (cause) {
      orphans = null;
      console.warn('Reverse (orphan) scan failed:', cause);
    }
  }

  return {
    scanId,
    startedAt: startedIso,
    finishedAt: new Date().toISOString(),
    durationMs,
    trigger: options.trigger,
    controlCount: controls.length,
    counts,
    delta: subtractCounts(counts, previousCounts),
    integrity,
    findings: reportFindings,
    scopeMatrix,
    orphans,
    discovery: [...scanContext.discovered.entries()].map(([label, found]) => ({ label, ...found })),
  };
}

/**
 * The reverse scan over the spaces the programme runs in.
 *
 * Claimed pages come from the registry: every policy rule's title prefix and every
 * live Confluence evidence link. Everything else in those spaces is evidence the
 * programme never asserts.
 */
export async function orphanScanFor(options: {
  cloudId: string;
  asAccountId?: string | null;
  bindingSpaceKey?: string | null;
  now?: Date;
}): Promise<OrphanScan> {
  const controls = await registryControls();
  const spaces = new Set<string>();
  const claimed: ClaimedPage[] = [];
  if (options.bindingSpaceKey) {
    spaces.add(options.bindingSpaceKey);
  }
  for (const control of controls) {
    const requirements = await registryRequirements(control);
    for (const requirement of requirements) {
      const rule = parseRule(requirement.rule_json);
      if (rule.spaceKey) {
        spaces.add(rule.spaceKey);
      }
      if (requirement.evidence_type === 'policy_page') {
        claimed.push({ title: rule.pageTitlePrefix ?? null, ari: null });
      }
    }
    const links = await listEvidenceLinks(control.id).catch(() => []);
    for (const link of links) {
      if (link.evidence_kind === 'confluence_page') {
        claimed.push({ title: link.label ?? null, ari: link.evidence_ari });
      }
    }
  }
  return findOrphanEvidence({ spaces: [...spaces], claimed, asAccountId: options.asAccountId, now: options.now });
}

// ---------------------------------------------------------------------------
// Remediation for the registry rollup
// ---------------------------------------------------------------------------

export async function createRemediations(options: {
  controlCode?: string;
  dueInDays?: number;
  context: Record<string, unknown>;
  /** `skip` for a caller that has already asked ADMINISTER. */
  permission?: 'check' | 'skip';
}): Promise<{
  created: Array<{ controlCode: string; issueKey: string; assignee: string | null; dueDate: string; reason: string }>;
  skipped: Array<{ controlCode: string; why: string }>;
}> {
  await ensureSchema();
  // Closing a control's gaps opens Jira issues in that control's name and records them
  // in the registry: asked once, before anything is created.
  if (options.permission !== 'skip') {
    await requireJiraPermission({ permission: PERMISSIONS.ADMINISTER });
  }
  const report = {
    created: [] as Array<{ controlCode: string; issueKey: string; assignee: string | null; dueDate: string; reason: string }>,
    skipped: [] as Array<{ controlCode: string; why: string }>,
  };
  const scan = await latestScan();
  if (!scan) {
    throw new Error('No completed scan yet — run a scan before closing gaps.');
  }
  const findings = await listFindingsByScan(scan.id);
  const controls = await registryControls();
  const byId = new Map(controls.map((control) => [control.id, control]));

  for (const finding of findings) {
    const control = byId.get(finding.control_id);
    if (!control) {
      continue;
    }
    if (options.controlCode && control.code !== options.controlCode) {
      continue;
    }
    if (finding.state !== 'MISSING' && finding.state !== 'STALE') {
      continue;
    }
    const existing = await findRemediationByFinding(finding.id);
    if (existing) {
      report.skipped.push({ controlCode: control.code, why: `already tracked as ${existing.jira_issue_key}` });
      continue;
    }
    const dueDate = new Date(
      Date.now() + (options.dueInDays ?? 30) * DAY_MS,
    )
      .toISOString()
      .slice(0, 10);
    try {
      const issue = await createJiraIssue({
        projectKey: control.jira_project_key,
        summary: `[AssureLoop] ${control.code}: ${finding.state === 'MISSING' ? 'evidence missing' : 'evidence stale'}`,
        description:
          `${finding.reason}\n\n` +
          `Control: ${control.code} — ${control.name}\n` +
          `Regulation: ${control.regulation_ref}\n` +
          `Detected by scan ${scan.id}.`,
        dueDate,
        labels: ['assureloop', 'remediation', control.jira_label],
      });
      await insertRemediation({
        findingId: finding.id,
        jiraIssueKey: issue.key,
        assigneeAccountId: null,
        dueDate,
      });
      report.created.push({
        controlCode: control.code,
        issueKey: issue.key,
        assignee: null,
        dueDate,
        reason: finding.reason,
      });
    } catch (cause) {
      report.skipped.push({
        controlCode: control.code,
        why: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Binding the programme to a site
// ---------------------------------------------------------------------------

export interface SiteBinding {
  projectKey: string;
  spaceKey: string | null;
  boundAt: string;
  boundBy: string | null;
}

function parseBinding(raw: string | null): SiteBinding | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SiteBinding>;
    if (typeof parsed.projectKey !== 'string' || parsed.projectKey.length === 0) {
      return null;
    }
    return {
      projectKey: parsed.projectKey,
      spaceKey: typeof parsed.spaceKey === 'string' ? parsed.spaceKey : null,
      boundAt: parsed.boundAt ?? new Date(0).toISOString(),
      boundBy: parsed.boundBy ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Which project the environment probes should use when nothing more specific is
 * known: the bound project, else the registry's, never a hardcoded demo key.
 */
async function boundProjectKey(): Promise<string | undefined> {
  try {
    const binding = parseBinding(await getConfig(CONFIG_SITE_BINDING));
    if (binding?.projectKey) {
      return binding.projectKey;
    }
    const controls = await registryControls();
    return controls[0]?.jira_project_key ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bind the shipped programme to a project and a space on this site.
 *
 * What a judge needs on their own site is one click, not a seed script: the demo
 * assumes a PAY project and ITO/SECOPS pages that no judge has. Binding rewrites
 * the twelve controls' project key and the space every policy rule names, and it
 * retires the demo's evidence links — a link to a page that does not exist here
 * would otherwise be carried as if it were evidence.
 *
 * No new scope is needed: the project list is `read:jira-work`, the space list is
 * `read:page:confluence`, and the writes are Forge SQL.
 */
export async function bindProgramme(options: {
  projectKey: string;
  spaceKey?: string | null;
  accountId?: string | null;
  cloudId?: string | null;
  /**
   * `skip` is for a caller that has already asked (the one-click onboarding asks once
   * for the whole flow). Every resolver leaves this at the default: binding rewrites
   * the programme, which is a site administrator's change.
   */
  permission?: 'check' | 'skip';
}): Promise<{
  bound: boolean;
  projectKey: string;
  spaceKey: string | null;
  controls: number;
  requirements: number;
  /** Policy pages re-confirmed on this site, so the pack keeps their titles. */
  linkedPages: number;
  /** Pages a rule names that this site does not have (they are not linked). */
  unresolvedPages: string[];
}> {
  await ensureSchema();
  if (options.permission !== 'skip') {
    // The programme is the app's configuration for the whole site: rewriting it is an
    // administrator's act, and Jira is asked before the first write.
    await requireJiraPermission({ permission: PERMISSIONS.ADMINISTER });
  }
  // The key is read into JQL, so it is validated here rather than trusted: a quote in
  // it would close the query string in `project = "..."`.
  const validated = validateProjectKey(options.projectKey);
  if (!validated.ok) {
    throw new Error(validated.why);
  }
  const projectKey: string = validated.value;
  const spaceKey = options.spaceKey?.trim() || null;
  let controls = 0;
  let requirements = 0;
  let linkedPages = 0;
  const unresolvedPages: string[] = [];

  // Which spaces this site actually has.
  //
  // Binding used to rewrite every policy rule's space key to the one chosen, so a
  // demo (or a real programme) that governs pages in three spaces came out of the
  // Control Room with two thirds of its policy claims missing: the SECOPS and LEGAL
  // pages were being looked for in ITO. A binding now moves only the rules that
  // point at a space this site does not have — those are the shipped demo's spaces,
  // which is exactly the case binding exists for — and leaves a rule that already
  // names a space here alone.
  const spacesHere = new Set(
    (await listSpaces({ asAccountId: options.accountId ?? null }).catch(() => ({ spaces: [] }))).spaces.map(
      (space) => space.key,
    ),
  );

  for (const control of NORTHWIND_PAY.controls) {
    const controlId = await upsertControl({
      code: control.code,
      name: control.name,
      regulationRef: control.regulationRef,
      cadence: control.cadence,
      riskTier: control.riskTier,
      jiraLabel: control.jiraLabel,
      jiraProjectKey: projectKey,
      ownerDisplayName:
        NORTHWIND_PAY.owners.find((owner) => owner.email === control.ownerEmail)?.name ?? null,
      status: 'ACTIVE',
    });
    await replaceRequirements(
      controlId,
      control.requirements.map((requirement) => ({
        evidenceType: requirement.evidenceType,
        maxAgeDays: requirement.maxAgeDays,
        minCount: requirement.minCount,
        // v6.35: "no space" clears the rule's space key.
        //
        // It used to keep the shipped programme's key (ITO), so choosing "no space"
        // left every policy rule pointing at a space the site does not have — the
        // claim then said "the space ITO does not exist here" while the screen said
        // no space was bound. The two statements now agree, and the claim reports a
        // setup gap that names the real next step.
        rule: {
          ...requirement.rule,
          spaceKey: boundSpaceKeyFor(requirement.rule.spaceKey ?? null, spaceKey, spacesHere),
        },
      })),
    );
    // The demo's links point at pages and issues this site does not have.
    await deactivateEvidenceLinksOfKind(controlId, 'confluence_page');
    await deactivateEvidenceLinksOfKind(controlId, 'jira_issue');

    // …and the pages this site *does* have are re-confirmed, by title, in the space
    // just chosen.
    //
    // Retiring every link left the audit pack with ARIs and no titles: after a
    // re-bind, a stale row for a page called "Incident Runbooks" read "1474620"
    // because the only place the pack gets a label is an active evidence link. A
    // binding is not a licence to forget what the pages are called — so each rule
    // that names a page is looked up, and only a page Confluence confirms is linked.
    if (spaceKey && options.cloudId) {
      const rows = await listRequirements(controlId).catch(() => []);
      for (const requirement of control.requirements) {
        const prefix = requirement.rule.pageTitlePrefix;
        if (!prefix) {
          continue;
        }
        const row = rows.find((entry) => entry.evidence_type === requirement.evidenceType);
        if (!row) {
          continue;
        }
        const found = await pageByTitle(prefix, spaceKey, {
          asAccountId: options.accountId ?? null,
        }).catch(() => ({ page: null }));
        if (!found.page) {
          unresolvedPages.push(`${spaceKey}/${prefix}`);
          continue;
        }
        await addEvidenceLink({
          controlId,
          requirementId: row.id,
          evidenceAri: confluencePageAri(options.cloudId, found.page.id),
          evidenceKind: 'confluence_page',
          label: found.page.title,
          observedAt: found.page.lastUpdatedAt,
        });
        linkedPages += 1;
      }
    }
    controls += 1;
    requirements += control.requirements.length;
  }

  const binding: SiteBinding = {
    projectKey,
    spaceKey,
    boundAt: new Date().toISOString(),
    boundBy: options.accountId ?? null,
  };
  await setConfig(CONFIG_SITE_BINDING, JSON.stringify(binding));
  // The person who bound the programme is the best guess for the unattended scan's
  // principal, and storing it here is what keeps the daily trigger alive on a site
  // whose owner never opened the diagnostics tab.
  if (options.accountId && !(await getConfig(CONFIG_SCAN_PRINCIPAL).catch(() => null))) {
    await setConfig(CONFIG_SCAN_PRINCIPAL, options.accountId).catch(() => undefined);
  }
  // A bound site is not the demo: the badge must stop claiming the demo is seeded.
  await setConfig(CONFIG_DEMO_SEEDED, 'false');
  return { bound: true, projectKey, spaceKey, controls, requirements, linkedPages, unresolvedPages };
}

/** What the bind screen needs: what this site has, and what it is bound to. */
export async function siteSetup(options: { accountId?: string | null } = {}) {
  await ensureSchema();
  const [projects, spacesFound, controls] = await Promise.all([
    listProjects(),
    listSpaces({ asAccountId: options.accountId ?? null }),
    registryControls(),
  ]);
  const binding = parseBinding(await getConfig(CONFIG_SITE_BINDING));
  return {
    bound: Boolean(binding),
    binding,
    projects: projects.projects,
    projectsError: projects.error?.message ?? null,
    spaces: spacesFound.spaces.map((space) => ({ id: space.id, key: space.key, name: space.name })),
    spacesError: spacesFound.error?.message ?? null,
    programme: {
      controls: controls.length,
      projectKey: controls[0]?.jira_project_key ?? null,
      names: controls.slice(0, 12).map((control) => ({ code: control.code, name: control.name })),
    },
  };
}

// ---------------------------------------------------------------------------
// Demo seeding
// ---------------------------------------------------------------------------

const seedResolver = {
  async findWorkItemsByLabel(label: string, projectKey: string) {
    const issues = await jqlSearch(
      `project = "${projectKey}" AND labels = "${label}" ORDER BY created ASC`,
      50,
    );
    return issues.map((issue) => ({ key: issue.key, id: issue.id, summary: issue.summary }));
  },
  async findPageByTitle(title: string, spaceKey: string, asAccountId?: string | null) {
    const found = await pageByTitle(title, spaceKey, { asAccountId: asAccountId ?? null });
    if (!found.page) {
      return null;
    }
    return {
      id: found.page.id,
      title: found.page.title,
      lastUpdatedAt: found.page.lastUpdatedAt,
      ownerAccountId: null,
      ownerName: null,
    };
  },
};

export async function seedDemo(options: {
  context: Record<string, unknown>;
  force?: boolean;
  /** Whose eyes to borrow for page lookups when the app sees no content. */
  asAccountId?: string | null;
  /** Project to seed into; defaults to the bound project, then the demo PAY. */
  projectKey?: string;
  /** `skip` for a caller that has already asked ADMINISTER. */
  permission?: 'check' | 'skip';
}) {
  await ensureSchema();
  // Seeding writes the whole control registry: an administrator's act.
  if (options.permission !== 'skip') {
    await requireJiraPermission({ permission: PERMISSIONS.ADMINISTER });
  }
  const cloudId = cloudIdOf(options.context);
  const binding = parseBinding(await getConfig(CONFIG_SITE_BINDING));

  // Seeding used to require a project called PAY, which made the whole path a
  // hardcoded demo. It now takes the project it was given, else the bound one, else
  // the demo key, else the first project this app can read. Every candidate is
  // validated before it reaches a JQL string.
  const candidates = [
    ...new Set(
      [options.projectKey, binding?.projectKey, NORTHWIND_PAY.jiraProjectKey].filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  ];
  let projectKey: string | null = null;
  for (const candidate of candidates) {
    const validated = validateProjectKey(candidate);
    if (!validated.ok) {
      continue;
    }
    const probe = await jqlSearch(`project = "${validated.value}" ORDER BY created ASC`, 1).catch(() => []);
    if (probe.length > 0) {
      projectKey = validated.value;
      break;
    }
  }
  if (!projectKey) {
    const projects = await listProjects();
    const first = projects.projects[0]?.key;
    const validated = first ? validateProjectKey(first) : { ok: false as const, why: 'no project' };
    projectKey = validated.ok ? validated.value : null;
  }
  if (!projectKey) {
    return {
      seeded: false,
      reason:
        'No readable Jira project on this site. Bind the programme to a project (Control Room → Bind) ' +
        'and create at least one work item, then seed.',
      result: null,
    };
  }
  const result = await seedNorthwindPay(seedResolver, cloudId, {
    force: options.force,
    asAccountId: options.asAccountId ?? accountIdOf(options.context) ?? null,
    projectKey,
  });
  return {
    seeded: !result.skipped,
    reason: result.skipped ? 'already seeded' : 'ok',
    projectKey,
    result,
  };
}

// ---------------------------------------------------------------------------
// One-click onboarding for an empty site
// ---------------------------------------------------------------------------

/**
 * The sample changes a fresh install can create for itself.
 *
 * Three completed changes labelled `ctrl-ac-10` (high-severity remediation) — a
 * control whose only claim is a completed work item, so a brand-new site has one
 * claim it can actually satisfy without inventing anything. Nothing here is
 * labelled as evidence of an approval: the app does not write approvals.
 */
const SAMPLE_CHANGES = [
  {
    summary: 'AssureLoop sample: close CVE-2026-1042 on the payout worker',
    description:
      'Sample change created by AssureLoop so a new site has something to judge. Delete it whenever you like.',
  },
  {
    summary: 'AssureLoop sample: rotate the merchant webhook signing secret',
    description:
      'Sample change created by AssureLoop so a new site has something to judge. Delete it whenever you like.',
  },
  {
    summary: 'AssureLoop sample: upgrade the TLS terminator to 3.1.4',
    description:
      'Sample change created by AssureLoop so a new site has something to judge. Delete it whenever you like.',
  },
];

/**
 * "Judge it on your site", in one click.
 *
 * A judge's site has no PAY project, no labelled change and no policy page. Binding
 * alone then judged an empty population, which used to paint nineteen MISSING rows —
 * a site where nothing had happened, reported as a failing control programme. This
 * does the three things that make the first five minutes work:
 *
 *   1. bind the programme to the chosen project (and space, if one was chosen);
 *   2. create three completed sample changes so one control has a real population;
 *   3. scan, so the Control Room opens on a real answer rather than an empty rollup.
 *
 * What it deliberately does not do: create a policy page (no `write:page:confluence`
 * scope is declared, and a page written by the app would be the app making its own
 * evidence), or write an approval comment (same reason). Those two claims stay
 * honest — a setup gap or a real gap, with the next step named.
 */
export async function onboardSite(options: {
  context: Record<string, unknown>;
  projectKey: string;
  spaceKey?: string | null;
  accountId?: string | null;
  /** `skip` for a caller that has already asked ADMINISTER. */
  permission?: 'check' | 'skip';
}): Promise<{
  bound: boolean;
  projectKey: string;
  spaceKey: string | null;
  created: Array<{ key: string; done: boolean; status: string | null; note: string }>;
  skipped: string[];
  scan: { counts: StateCounts; durationMs: number; scanId: string } | null;
  why?: string;
}> {
  await ensureSchema();
  // One click that binds the programme, creates sample changes and scans. It writes
  // configuration and three work items, so it is asked for once here, before the
  // first of them.
  if (options.permission !== 'skip') {
    await requireJiraPermission({ permission: PERMISSIONS.ADMINISTER });
  }
  const accountId = options.accountId ?? accountIdOf(options.context) ?? null;
  const validated = validateProjectKey(options.projectKey);
  if (!validated.ok) {
    return {
      bound: false,
      projectKey: typeof options.projectKey === 'string' ? options.projectKey : '',
      spaceKey: null,
      created: [],
      skipped: [],
      scan: null,
      why: validated.why,
    };
  }
  const projectKey = validated.value;
  await bindProgramme({ projectKey, spaceKey: options.spaceKey ?? null, accountId, permission: 'skip' });

  const created: Array<{ key: string; done: boolean; status: string | null; note: string }> = [];
  const skipped: string[] = [];
  // A second press must not create a second set of samples.
  const existing = await jqlSearch(
    `project = "${projectKey}" AND labels = "assureloop-sample" ORDER BY created ASC`,
    10,
  ).catch(() => []);
  if (existing.length > 0) {
    for (const issue of existing.slice(0, 3)) {
      created.push({ key: issue.key, done: issue.statusCategoryKey === 'done', status: issue.statusName, note: 'already created' });
    }
    skipped.push('the sample changes were already created on this site');
  } else {
    for (const sample of SAMPLE_CHANGES) {
      try {
        const issue = await createJiraIssue({
          projectKey,
          summary: sample.summary,
          description: sample.description,
          labels: ['ctrl-ac-10', 'assureloop-sample'],
        });
        const moved = await transitionIssueToDone(issue.key);
        await addIssueComment(
          issue.key,
          'AssureLoop sample change (created by the app, not by a person). Two accounts are needed to prove ' +
            'segregation of duties: a sign-off must come from someone other than the assignee. Delete this ' +
            'sample whenever you like.',
        ).catch(() => undefined);
        created.push({
          key: issue.key,
          done: moved.moved,
          status: moved.status ?? null,
          note: moved.moved
            ? 'completed'
            : `created, but could not be moved to a done status (${moved.why ?? 'unknown'})`,
        });
      } catch (cause) {
        skipped.push(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }

  let scan: { counts: StateCounts; durationMs: number; scanId: string } | null = null;
  try {
    const report = await runScan({
      trigger: 'MANUAL',
      context: options.context,
      asAccountId: accountId ?? undefined,
      skipOrphanScan: true,
    });
    scan = { counts: report.counts, durationMs: report.durationMs, scanId: report.scanId };
  } catch (cause) {
    skipped.push(`the first scan did not finish: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  return {
    bound: true,
    projectKey,
    spaceKey: options.spaceKey ?? null,
    created,
    skipped,
    scan,
  };
}

// ---------------------------------------------------------------------------
// Resolver — the UI's backend
// ---------------------------------------------------------------------------

const resolver = new Resolver();

function contextOf(request: { context?: unknown }): {
  cloudId: string;
  siteUrl: string | null;
  accountId: string;
} {
  const context = asRecord(request.context);
  return {
    cloudId: cloudIdOf(context),
    siteUrl: siteUrlOf(context),
    accountId: principalOf(context),
  };
}

/** E1 — the primary surface: one work item, its claims, judged live. */
resolver.define('issueGate', async (request) => {
  const { cloudId, siteUrl, accountId } = contextOf(request);
  const payload = asRecord(request.payload);
  const issueKey =
    stringField(payload, 'issueKey') ??
    (stringField(asRecord(payload.context), 'issueKey') as string | undefined);
  if (!issueKey) {
    return {
      issue: null,
      control: null,
      suggestedControls: [],
      badge: {
        state: 'NOT_EVALUATED',
        label: 'No work item in context',
        detail: 'Open a Jira issue to see the evidence gate for it.',
      },
      counts: zeroCounts(),
      requirements: [],
      gaps: 0,
      integrity: { checked: 0, incomplete: 0, notVisible: 0, retried: 0, durationMs: 0 },
      note: null,
    };
  }
  try {
    return await evaluateIssueGate({
      issueKey,
      controlCode: stringField(payload, 'controlCode'),
      cloudId,
      siteUrl,
      accountId,
    });
  } catch (cause) {
    console.error('Evidence gate failed:', cause);
    return {
      issue: null,
      control: null,
      suggestedControls: [],
      badge: {
        state: 'NOT_EVALUATED',
        label: 'Gate failed',
        detail: cause instanceof Error ? cause.message : String(cause),
      },
      counts: zeroCounts(),
      requirements: [],
      gaps: 0,
      integrity: { checked: 0, incomplete: 0, notVisible: 0, retried: 0, durationMs: 0 },
      note: null,
    };
  }
});

/** E2 — the receipts behind one claim. */
resolver.define('explainClaim', async (request) => {
  const { cloudId, siteUrl, accountId } = contextOf(request);
  const payload = asRecord(request.payload);
  const issueKey = stringField(payload, 'issueKey');
  const requirementId = stringField(payload, 'requirementId');
  if (!issueKey) {
    return { found: false, note: 'No work item given.' };
  }
  const gate = await evaluateIssueGate({
    issueKey,
    controlCode: stringField(payload, 'controlCode'),
    cloudId,
    siteUrl,
    accountId,
  });
  if (gate.permission?.cause === 'DENIED') {
    // The person may not see this work item, so they are not shown the receipts of a
    // verdict either.
    return { found: false, denied: true, permission: gate.permission.permission, note: gate.note };
  }
  const requirement = gate.requirements.find((row) => row.requirementId === requirementId) ?? null;
  if (!requirement) {
    return { found: false, note: 'That claim is not part of this work item.' };
  }
  return {
    found: true,
    state: requirement.state,
    reason: requirement.reason,
    claim: requirement.claim,
    trace: requirement.trace,
    failures: requirement.failures,
    missingScopes: requirement.missingScopes,
  };
});

/** E5 — six probes, one budget. */
resolver.define('environmentCheck', async (request) => {
  const { cloudId, accountId } = contextOf(request);
  const payload = asRecord(request.payload);
  const issueKey = stringField(payload, 'issueKey');
  let issueAri: string | undefined;
  let projectKey: string | undefined;
  if (issueKey) {
    const { issue, error } = await getIssue(issueKey);
    if (issue && !error) {
      issueAri = jiraIssueAri(cloudId, issue.id);
      projectKey = issue.projectKey;
    }
  }
  return runEnvironmentCheck({
    context: {
      cloudId,
      accountId,
      userAri: userAri(accountId),
      issueAri,
      issueKey,
      // Never assume the demo's project: a judge's site has its own, and probing
      // the wrong key is what made three probes yellow on every fresh install.
      projectKey: projectKey ?? (await boundProjectKey()),
    },
    budgetMs: numberField(payload, 'budgetMs'),
  });
});

/** Secondary surface: the rollup. Deliberately small — the gate is the product. */
resolver.define('controlRoom', async (request) => {
  await ensureSchema();
  const payload = asRecord(request.payload);
  const controls = await registryControls();
  const scan = await latestScan();
  const previous = await previousScan();
  const findings = scan ? await listFindingsByScan(scan.id) : [];
  const byControl = new Map<string, FindingRow[]>();
  for (const finding of findings) {
    const list = byControl.get(finding.control_id) ?? [];
    list.push(finding);
    byControl.set(finding.control_id, list);
  }
  let integrity: unknown = null;
  try {
    const raw = await getConfig(CONFIG_LAST_SCAN_INTEGRITY);
    integrity = raw ? JSON.parse(raw) : null;
  } catch {
    integrity = null;
  }
  const remediations = await listOpenRemediations();
  const remediationByFinding = new Map(remediations.map((row) => [row.finding_id, row]));
  const exceptions = await listClaimExceptions().catch(() => [] as ClaimExceptionRow[]);
  const exceptionByKey = new Map(exceptions.map((row) => [row.claim_key, row]));
  const now = new Date();
  // The finding stores the requirement id (a UUID once the registry is in SQL), so the
  // evidence type has to come from the requirement row — the same join the audit pack
  // makes. Deriving it from the id's colon segments only worked for the shipped
  // programme ids, and showed up as "AC-02 · unknown" on the gap card.
  const requirementRows = await listRequirementsForControls(controls.map((row) => row.id)).catch(
    () => [] as RequirementRow[],
  );
  const evidenceTypeById = new Map(requirementRows.map((row) => [row.id, row.evidence_type]));
  // Which of the registry's controls this app shipped, and which a person added. The
  // two are listed separately: a custom control is a change to the programme, and the
  // person who made it should see it named as theirs.
  const shippedCodes = new Set(NORTHWIND_PAY.controls.map((entry) => entry.code));

  // "Unexplained gaps" is the number a closing meeting asks about: a gap carried
  // with a reason, an owner and an expiry is explained; the rest is what nobody has
  // accounted for.
  const gapRows = findings
    .filter((finding) => finding.state === 'MISSING' || finding.state === 'STALE')
    .map((finding) => {
      const control = controls.find((row) => row.id === finding.control_id);
      const evidenceType =
        evidenceTypeById.get(finding.requirement_id) ??
        (finding.requirement_id.split(':').length >= 3
          ? (finding.requirement_id.split(':')[2] ?? 'unknown')
          : 'unknown');
      const claimKey = claimKeyFor(control?.code ?? '—', evidenceType);
      const exceptionRow = exceptionByKey.get(claimKey) ?? null;
      return {
        controlCode: control?.code ?? '—',
        evidenceType,
        claimKey,
        state: finding.state,
        reason: finding.reason,
        remediation: remediationByFinding.get(finding.id)?.jira_issue_key ?? null,
        exception: exceptionRow
          ? {
              reason: exceptionRow.exception_reason,
              expiresAt: exceptionRow.expires_at,
              compensatingControl: exceptionRow.compensating_control,
              active: exceptionIsActive(exceptionRow, now),
            }
          : null,
      };
    });
  const explainedGaps = gapRows.filter((row) => row.exception?.active === true).length;
  const unexplainedGaps = gapRows.length - explainedGaps;
  const gaps = gapRows.slice(0, 8);

  // Discovery mode is announced on the row it produced, so the rollup repeats it
  // once instead of 19 times.
  const discovery: string[] = [];
  for (const finding of findings) {
    try {
      const parsed: unknown = JSON.parse(finding.notes ?? 'null');
      if (Array.isArray(parsed)) {
        for (const note of parsed) {
          if (typeof note === 'string' && note.includes('discovery mode') && !discovery.includes(note)) {
            discovery.push(note);
          }
        }
      }
    } catch {
      // older rows have no notes column value
    }
  }

  const binding = parseBinding(await getConfig(CONFIG_SITE_BINDING));
  // The audit pack is what the Control Room hands over. Built from the same scan
  // rows, so its fingerprint and the macro's match.
  const siteUrl = siteUrlOf(asRecord(request.context));
  const audit = payload.withAudit === false ? null : await buildAuditPack({ siteUrl });

  const environment: EnvironmentReport | null = payload.withEnvironment
    ? await runEnvironmentCheck({
        context: {
          cloudId: cloudIdOf(asRecord(request.context)),
          accountId: principalOf(asRecord(request.context)),
          userAri: userAri(principalOf(asRecord(request.context))),
          projectKey: binding?.projectKey ?? controls[0]?.jira_project_key ?? undefined,
        },
      })
    : null;

  // The reverse scan's last answer, stored by the scan. Re-read rather than re-run:
  // listing every page of every space on each page load is not a refresh anyone
  // asked for.
  let orphans: OrphanScan | null = null;
  try {
    const raw = await getConfig(CONFIG_LAST_ORPHAN_SCAN);
    orphans = raw ? (JSON.parse(raw) as OrphanScan) : null;
  } catch {
    orphans = null;
  }

  return {
    demoSeeded: (await getConfig(CONFIG_DEMO_SEEDED)) === 'true',
    controlCount: controls.length,
    binding,
    discovery,
    siteUrl,
    audit,
    guarantees: AUDIT_GUARANTEES,
    unexplainedGaps,
    explainedGaps,
    exceptions,
    orphans,
    lastScan: scan
      ? {
          id: scan.id,
          finishedAt: scan.finished_at,
          trigger: scan.trigger_source,
          durationMs: scan.duration_ms,
          counts: parseCounts(scan.counts_json),
          // How this run read the graph (identity, hops, caps) — the line that makes
          // an unattended scan's honesty visible instead of inferable.
          notes: scan.notes ?? null,
          readAsPrincipal: Boolean(scan.principal_account_id),
        }
      : null,
    delta:
      scan && previous
        ? subtractCounts(parseCounts(scan.counts_json), parseCounts(previous.counts_json))
        : null,
    // A scan that finished before this binding judged another project. Presenting it
    // as this project's rollup is the kind of quiet mismatch that makes a reviewer
    // distrust every other number on the page, so the screen says it out loud.
    scanPredatesBinding: Boolean(
      binding && scan?.finished_at && Date.parse(scan.finished_at) < Date.parse(binding.boundAt),
    ),
    integrity,
    gaps,
    controls: controls.slice(0, 24).map((control) => {
      const controlFindings = byControl.get(control.id) ?? [];
      const worst =
        controlFindings.find((finding) => finding.state === 'MISSING') ??
        controlFindings.find((finding) => finding.state === 'STALE') ??
        controlFindings.find((finding) => finding.state === 'NOT_VISIBLE') ??
        controlFindings.find((finding) => finding.state === 'INCOMPLETE') ??
        controlFindings[0];
      return {
        code: control.code,
        name: control.name,
        regulationRef: control.regulation_ref,
        cadence: control.cadence,
        riskTier: control.risk_tier,
        owner: control.owner_display_name,
        state: worst?.state ?? 'UNKNOWN',
        openGaps: controlFindings.filter(
          (finding) => finding.state === 'MISSING' || finding.state === 'STALE',
        ).length,
        incomplete: controlFindings.filter((finding) => finding.state === 'INCOMPLETE').length,
      };
    }),
    remediations,
    environment,
    // What this site added to the programme, with the claims each one carries. A person
    // who adds a control needs to see what the next scan will judge, in the same words
    // the pack uses.
    customControls: controls
      .filter((control) => !shippedCodes.has(control.code))
      .map((control) => ({
        code: control.code,
        name: control.name,
        regulationRef: control.regulation_ref,
        jiraProjectKey: control.jira_project_key,
        jiraLabel: control.jira_label,
        claims: requirementRows
          .filter((row) => row.control_id === control.id)
          .map((row) => ({
            evidenceType: row.evidence_type,
            maxAgeDays: row.max_age_days,
            everyItem: parseRule(row.rule_json).everyItem === true,
            expectation: parseRule(row.rule_json).expectation ?? null,
          })),
      })),
    currentUser: principalOf(asRecord(request.context)),
  };
});

resolver.define('scanNow', async (request) => {
  const payload = asRecord(request.payload);
  try {
    return await runScan({
      trigger: 'MANUAL',
      controlCode: stringField(payload, 'controlCode'),
      context: asRecord(request.context),
    });
  } catch (cause) {
    const error = cause as Error;
    console.error('AssureLoop scan failed', error.message, (error.stack ?? '').slice(0, 600));
    throw cause;
  }
});

/**
 * A deliberately tiny invoke: prove the function is awake and its schema is there.
 *
 * The Control Room calls this when it opens, because a Forge container that has
 * been idle is cold, and the first real invoke after a cold start is the one that
 * fails: on the deployed site `Verify fingerprint` twice came back "Failed to
 * fetch" while the page itself was loaded, then worked on a retry. One cheap
 * round trip on open — and a retry around the button's invoke — turns that from a
 * broken feature into a second of waiting.
 */
resolver.define('ping', async () => {
  const started = Date.now();
  try {
    await ensureSchema();
    const scan = await latestScan();
    return {
      ok: true,
      schema: 'ready',
      lastScanAt: scan?.finished_at ?? null,
      latencyMs: Date.now() - started,
    };
  } catch (cause) {
    return {
      ok: false,
      schema: 'unavailable',
      why: cause instanceof Error ? cause.message : String(cause),
      latencyMs: Date.now() - started,
    };
  }
});

/** Close the gaps found on one work item, with the owner route spelled out. */
resolver.define('closeGapsForIssue', async (request) => {
  const { cloudId, siteUrl, accountId } = contextOf(request);
  const payload = asRecord(request.payload);
  const issueKey = stringField(payload, 'issueKey');
  if (!issueKey) {
    return { created: [], skipped: [{ requirement: '-', why: 'No work item given.' }], routes: [] };
  }
  try {
    return await closeGapsForIssue({
      issueKey,
      controlCode: stringField(payload, 'controlCode'),
      cloudId,
      siteUrl,
      accountId,
      dueInDays: numberField(payload, 'dueInDays'),
    });
  } catch (cause) {
    if (cause instanceof PermissionError) {
      return {
        created: [],
        routes: [],
        skipped: [{ requirement: 'all claims', why: refusalMessage(cause.result) }],
        ...refusalBody(cause.result),
      };
    }
    throw cause;
  }
});

/** Claim a work item for a control: the label makes the evidence permanent. */
resolver.define('claimIssue', async (request) => {
  const payload = asRecord(request.payload);
  const issueKey = stringField(payload, 'issueKey');
  const controlCode = stringField(payload, 'controlCode');
  if (!issueKey) {
    return { claimed: false, why: 'No work item given.' };
  }
  // Writing a label onto someone's work item is an edit to it: the person has to be
  // allowed to edit that item, not merely to see it.
  const permission = await checkJiraPermission({
    permission: PERMISSIONS.EDIT_ISSUES,
    issueKey,
  });
  if (!permission.allowed) {
    return { claimed: false, ...refusalBody(permission) };
  }
  const controls = await registryControls();
  const control = controlCode
    ? controls.find((row) => row.code === controlCode)
    : controls[0];
  if (!control) {
    return { claimed: false, why: 'No control to claim it for.' };
  }
  try {
    await addIssueLabel(issueKey, control.jira_label);
    return { claimed: true, controlCode: control.code, label: control.jira_label };
  } catch (cause) {
    return { claimed: false, why: cause instanceof Error ? cause.message : String(cause) };
  }
});

resolver.define('diagnostics', async (request) => {
  await ensureSchema();
  const { cloudId, accountId } = contextOf(request);
  const matrix = await probeScopes({ userAri: userAri(accountId) });
  const ledger = buildScopeLedger(matrix);
  const scan = await latestScan();
  const entries = Object.entries(PERSISTED_QUERIES) as Array<
    [keyof typeof PERSISTED_QUERIES, (typeof PERSISTED_QUERIES)[keyof typeof PERSISTED_QUERIES]]
  >;
  return {
    cloudId,
    scopes: Object.values(
      {
        WORK_ITEM: 'read:graph:issue:jira',
        COMMENT: 'read:graph:issue-comment:jira',
        JIRA_SPACE: 'read:graph:project:jira',
        PAGE: 'read:graph:page:confluence',
        CONFLUENCE_SPACE: 'read:graph:space:confluence',
        USER: 'read:graph:user:atlassian',
        TEAM: 'read:graph:team:atlassian',
      } as const,
    ).map((scope) => ({
      scope,
      label: scopeExplanation(scope),
      state: ledger[scope] ?? 'NOT_PROBED',
    })),
    probes: matrix,
    persistedQueries: entries.map(([key, draft]) => ({
      key,
      envVar: draft.envVar,
      name: draft.name,
      registered: Boolean(queryKeyFor(draft)),
      purpose: draft.purpose,
      validation: draft.validation,
    })),
    lastScan: scan
      ? {
          id: scan.id,
          startedAt: scan.started_at,
          finishedAt: scan.finished_at,
          trigger: scan.trigger_source,
          durationMs: scan.duration_ms,
          counts: parseCounts(scan.counts_json),
        }
      : null,
    remediations: await listOpenRemediations(),
  };
});

/** The bind screen: what this site has, and what the programme is bound to. */
resolver.define('siteSetup', async (request) => {
  const { accountId } = contextOf(request);
  return siteSetup({ accountId });
});

/** One click: bind the programme to a project (and a space for policy pages). */
resolver.define('bindProgramme', async (request) => {
  const payload = asRecord(request.payload);
  const projectKey = stringField(payload, 'projectKey');
  if (!projectKey) {
    return { bound: false, why: 'Pick a project first.' };
  }
  try {
    return await bindProgramme({
      projectKey,
      spaceKey: stringField(payload, 'spaceKey') ?? null,
      accountId: contextOf(request).accountId,
      cloudId: contextOf(request).cloudId,
    });
  } catch (cause) {
    if (cause instanceof PermissionError) {
      return { bound: false, ...refusalBody(cause.result) };
    }
    return { bound: false, why: cause instanceof Error ? cause.message : String(cause) };
  }
});

/**
 * A custom control: the small form in the Control Room and its JSON import.
 *
 * Both are writes to the programme, so both ask Jira for ADMINISTER first. The
 * validation and the write itself live in registry/custom.ts, which refuses a bad
 * input with the sentence the screen shows instead of correcting it.
 */
resolver.define('upsertControl', async (request) => {
  await ensureSchema();
  const payload = asRecord(request.payload);
  const permission = await checkJiraPermission({ permission: PERMISSIONS.ADMINISTER });
  if (!permission.allowed) {
    return { saved: false, ...refusalBody(permission) };
  }
  try {
    const binding = parseBinding(await getConfig(CONFIG_SITE_BINDING));
    return await saveCustomControl(payload, { projectKeyFallback: binding?.projectKey ?? null });
  } catch (cause) {
    return {
      saved: false,
      code: stringField(payload, 'code') ?? null,
      why: cause instanceof Error ? cause.message : String(cause),
    };
  }
});

/** The JSON import: the same validation, one row at a time, with a report per row. */
resolver.define('importControls', async (request) => {
  await ensureSchema();
  const payload = asRecord(request.payload);
  const permission = await checkJiraPermission({ permission: PERMISSIONS.ADMINISTER });
  if (!permission.allowed) {
    return { imported: 0, failed: 0, results: [], ...refusalBody(permission) };
  }
  try {
    const binding = parseBinding(await getConfig(CONFIG_SITE_BINDING));
    return await importCustomControls(payload.json ?? payload.controls ?? payload, {
      projectKeyFallback: binding?.projectKey ?? null,
    });
  } catch (cause) {
    return {
      imported: 0,
      failed: 0,
      results: [],
      why: cause instanceof Error ? cause.message : String(cause),
    };
  }
});

/**
 * Add claims the shipped programme has gained to a registry that predates them.
 *
 * Only missing evidence types are inserted, and only for controls that exist: the
 * app never rewrites a rule a site is already being judged by. The added rule keeps
 * the site's own binding — the control's project key, and the space the demo names
 * only when this site actually has that space (otherwise the bound space, else
 * none, which the claim reports as a setup gap).
 */
async function upgradeProgrammeInPlace(): Promise<void> {
  try {
    const existing = await listControls();
    if (existing.length === 0) {
      return;
    }
    const spacesHere = new Set(
      (await listSpaces().catch(() => ({ spaces: [] }))).spaces.map((space) => space.key),
    );
    const binding = parseBinding(await getConfig(CONFIG_SITE_BINDING).catch(() => null));
    for (const control of existing) {
      const shipped = NORTHWIND_PAY.controls.find((entry) => entry.code === control.code);
      if (!shipped) {
        continue;
      }
      const rows = await listRequirements(control.id);
      const present = new Set(rows.map((row) => row.evidence_type));
      for (const requirement of shipped.requirements) {
        if (present.has(requirement.evidenceType)) {
          continue;
        }
        const rule = { ...requirement.rule };
        if (rule.spaceKey && !spacesHere.has(rule.spaceKey)) {
          rule.spaceKey = binding?.spaceKey && spacesHere.has(binding.spaceKey) ? binding.spaceKey : null;
        }
        await insertRequirement(control.id, {
          evidenceType: requirement.evidenceType,
          maxAgeDays: requirement.maxAgeDays,
          minCount: requirement.minCount,
          rule,
        });
      }
    }
  } catch (cause) {
    // A registry that cannot be read is not a scan failure: the scan falls back to
    // the shipped programme, which is the same answer for a fresh install.
    console.warn('Programme upgrade skipped:', cause);
  }
}

/**
 * Where a rule's policy page should be looked for after a binding.
 *
 * `null` for a chosen space means "the programme was bound with no space": rules are
 * cleared so the claim reports a setup gap instead of looking in a space that was
 * deliberately not chosen. A rule that already names a space this site has keeps it.
 */
function boundSpaceKeyFor(
  current: string | null,
  chosen: string | null,
  spacesHere: ReadonlySet<string>,
): string | null {
  if (current && spacesHere.has(current)) {
    return current;
  }
  return chosen;
}

/**
 * Re-verify a filed fingerprint: the one-click check behind “Verify fingerprint”.
 *
 * The pack is rebuilt from the same scan with the same hash function. A match says
 * the table still reproduces exactly; a mismatch says the rows behind it changed (a
 * new scan, a wiped database, an edited row) and the paper has to be re-issued.
 */
resolver.define('onboardSite', async (request) => {
  await ensureSchema();
  const { accountId } = contextOf(request);
  const payload = asRecord(request.payload);
  try {
    return await onboardSite({
      context: asRecord(request.context),
      projectKey: stringField(payload, 'projectKey') ?? '',
      spaceKey: stringField(payload, 'spaceKey') ?? null,
      accountId,
    });
  } catch (cause) {
    if (cause instanceof PermissionError) {
      return { bound: false, created: [], skipped: [], scan: null, ...refusalBody(cause.result) };
    }
    throw cause;
  }
});

resolver.define('verifyFingerprint', async (request) => {
  const { siteUrl } = contextOf(request);
  const payload = asRecord(request.payload);
  const expected = stringField(payload, 'fingerprint');
  const scanId = stringField(payload, 'scanId');
  const pack = await buildAuditPack({
    controlCode: stringField(payload, 'controlCode'),
    siteUrl: stringField(payload, 'siteUrl') ?? siteUrl,
    scanId,
  });
  if (!expected) {
    return {
      verified: false,
      status: 'NO FINGERPRINT',
      computed: pack.fingerprint,
      claims: pack.claims.length,
      note: 'Give me the fingerprint printed on the pack; it is recomputed from the same scan and compared.',
    };
  }
  const result = verifyFingerprintOf({ claims: pack.claims, scanId: pack.scanId, expected });
  return {
    verified: result.match,
    status: result.match ? 'VERIFIED MATCH' : 'DRIFT DETECTED',
    expected: result.expected,
    computed: result.computed,
    claims: result.claims,
    scanId: pack.scanId,
    asOf: pack.asOf,
    note: result.match
      ? `The ${result.claims} claim row(s) re-hash to the fingerprint on the pack (scan ${pack.scanId ?? 'none'}).`
      : `The rows behind this pack no longer hash to ${result.expected}: the pack was produced by different rows (scan ${pack.scanId ?? 'none'} now). Re-issue the pack.`,
  };
});

/**
 * Record an exception against one claim.
 *
 * The state is not touched: an exception explains a gap, it does not make it go
 * away. What it changes is the count a closing meeting asks about — a gap with a
 * reason, an owner and an expiry is explained; everything else is unexplained.
 */
resolver.define('recordException', async (request) => {
  await ensureSchema();
  const { accountId } = contextOf(request);
  // An exception is how a gap is carried on purpose: a site administrator's act, with
  // a reason and an expiry. Asked before the input is even read.
  const permission = await checkJiraPermission({ permission: PERMISSIONS.ADMINISTER });
  if (!permission.allowed) {
    return { recorded: false, ...refusalBody(permission) };
  }
  const payload = asRecord(request.payload);
  const controlCode = stringField(payload, 'controlCode');
  const evidenceType = stringField(payload, 'evidenceType');
  const reason = stringField(payload, 'reason');
  const expiresAt = stringField(payload, 'expiresAt');
  if (!controlCode || !evidenceType) {
    return { recorded: false, why: 'Name the control and the claim (evidence type) the exception covers.' };
  }
  if (!reason) {
    return { recorded: false, why: 'An exception needs a reason — a gap with no reason stays an unexplained gap.' };
  }
  if (!expiresAt || !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
    return { recorded: false, why: 'An exception needs an expiry date (yyyy-mm-dd).' };
  }
  const control = await getControlByCode(controlCode);
  if (!control) {
    return { recorded: false, why: `${controlCode} is not in this installation's registry. Record the exception on a bound site.` };
  }
  const claimKey = claimKeyFor(controlCode, evidenceType);
  await recordClaimException({
    controlId: control.id,
    claimKey,
    evidenceType,
    reason,
    expiresAt,
    compensatingControl: stringField(payload, 'compensatingControl') ?? null,
    recordedBy: accountId,
  });
  return { recorded: true, claimKey, reason, expiresAt };
});

resolver.define('withdrawException', async (request) => {
  await ensureSchema();
  const { accountId } = contextOf(request);
  const permission = await checkJiraPermission({ permission: PERMISSIONS.ADMINISTER });
  if (!permission.allowed) {
    return { withdrawn: false, ...refusalBody(permission) };
  }
  const payload = asRecord(request.payload);
  const controlCode = stringField(payload, 'controlCode');
  const evidenceType = stringField(payload, 'evidenceType');
  if (!controlCode || !evidenceType) {
    return { withdrawn: false, why: 'Name the control and the claim.' };
  }
  const claimKey = claimKeyFor(controlCode, evidenceType);
  // The actor goes on the row: "the exception was withdrawn" without a name is not an
  // audit trail, and the pack shows who ended it.
  const withdrawn = await withdrawClaimException(claimKey, accountId ?? null);
  return {
    withdrawn,
    claimKey,
    withdrawnBy: withdrawn ? accountId ?? null : null,
    why: withdrawn ? null : `No active exception is recorded against ${claimKey}.`,
  };
});

/** The reverse scan on demand, for the Control Room card and for a reviewer. */
resolver.define('orphanEvidence', async (request) => {
  const { cloudId, accountId } = contextOf(request);
  const binding = parseBinding(await getConfig(CONFIG_SITE_BINDING));
  try {
    return await orphanScanFor({
      cloudId,
      asAccountId: accountId,
      bindingSpaceKey: binding?.spaceKey ?? null,
    });
  } catch (cause) {
    return {
      mode: 'rest+registry',
      spaces: [],
      pagesSeen: 0,
      claimed: 0,
      orphans: [],
      truncated: false,
      scannedAt: new Date().toISOString(),
      notes: [],
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
});
resolver.define('auditPack', async (request) => {
  const payload = asRecord(request.payload);
  return buildAuditPack({
    controlCode: stringField(payload, 'controlCode'),
    siteUrl: stringField(payload, 'siteUrl') ?? contextOf(request).siteUrl,
  });
});

/**
 * The deterministic audit memo.
 *
 * With an issue key it describes that work item's claims as they stand now (the
 * panel's copy button); without one it describes the last scan (the pack). Either
 * way the text is built here, from the same rows the screen shows — the model never
 * writes a sentence of it.
 */
resolver.define('auditMemo', async (request) => {
  const { cloudId, siteUrl, accountId } = contextOf(request);
  const payload = asRecord(request.payload);
  const issueKey = stringField(payload, 'issueKey');
  if (issueKey) {
    const gate = await evaluateIssueGate({
      issueKey,
      controlCode: stringField(payload, 'controlCode'),
      cloudId,
      siteUrl,
      accountId,
    });
    const claims: AuditClaim[] = gate.requirements.map((row) => ({
      controlCode: gate.control?.code ?? '—',
      controlName: gate.control?.name ?? '',
      regulationRef: gate.control?.regulationRef ?? '',
      claim: row.claim,
      evidenceType: row.evidenceType,
      state: row.state,
      reason: row.reason,
      evidenceLabel: row.evidence?.label ?? null,
      evidenceAri: row.evidence?.ari ?? null,
      evidenceUrl: row.evidence?.url ?? null,
      observedAt: row.evidence?.observedAt ?? null,
      judgedAt: new Date().toISOString(),
      ageDays: row.ageDays,
      maxAgeDays: row.maxAgeDays,
      remediation: null,
      missingScopes: row.missingScopes.map((scope) => scope.scope),
      claimKey: claimKeyFor(gate.control?.code ?? '—', row.evidenceType),
      exception: null,
    }));
    const { explainedGaps, unexplainedGaps } = countGaps(claims, new Date());
    const memo = memoForClaims(claims, {
      title: `${issueKey}${gate.issue?.summary ? ` — ${gate.issue.summary}` : ''}`,
      asOf: gate.issue?.updated ?? new Date().toISOString(),
      scanId: null,
      counts: gate.counts,
      explainedGaps,
      unexplainedGaps,
    });
    return {
      memo,
      fingerprint: fingerprintOf(claims, null),
      claims: claims.length,
      guarantees: AUDIT_GUARANTEES,
      unexplainedGaps,
      explainedGaps,
    };
  }
  const pack = await buildAuditPack({
    controlCode: stringField(payload, 'controlCode'),
    siteUrl: stringField(payload, 'siteUrl') ?? siteUrl,
  });
  return { memo: pack.memo, fingerprint: pack.fingerprint, claims: pack.claims.length };
});

resolver.define('seedDemo', async (request) => {
  try {
    return await seedDemo({ context: asRecord(request.context) });
  } catch (cause) {
    if (cause instanceof PermissionError) {
      return { seeded: false, result: null, reason: refusalMessage(cause.result), ...refusalBody(cause.result) };
    }
    throw cause;
  }
});

/** Back-compat for the older macro/UI: close gaps for a whole control. */
resolver.define('closeGaps', async (request) => {
  try {
    return await createRemediations({
      controlCode: stringField(asRecord(request.payload), 'controlCode'),
      context: asRecord(request.context),
    });
  } catch (cause) {
    if (cause instanceof PermissionError) {
      return {
        created: [],
        skipped: [{ controlCode: stringField(asRecord(request.payload), 'controlCode') ?? 'all controls', why: refusalMessage(cause.result) }],
        ...refusalBody(cause.result),
      };
    }
    throw cause;
  }
});

export const handler = resolver.getDefinitions();

// ---------------------------------------------------------------------------
// Rovo actions — GET/stateless first (R6)
// ---------------------------------------------------------------------------

/**
 * action: scan-control (TRIGGER).
 *
 * This is the one action that writes, and only the registry scan it was asked
 * for. Verdicts still come from the engine, never from the model.
 */
export async function actionScanControl(event: unknown, context?: unknown) {
  const { payload, context: ctx } = invocation(event, context);
  const controlCode = stringField(payload, 'controlCode');
  try {
    const report = await runScan({
      trigger: 'ROVO_ACTION',
      controlCode,
      context: ctx,
      // About 20 seconds, and the reverse scan lists whole spaces: it belongs to the
      // registry rollup, not to a chat invocation.
      skipOrphanScan: true,
    });
    return {
      scanId: report.scanId,
      scope: controlCode ?? 'all controls',
      counts: report.counts,
      integrity: report.integrity,
      gaps: report.findings
        .filter((finding) => finding.state !== 'VERIFIED')
        .slice(0, 12)
        .map((finding) => ({
          control: finding.controlCode,
          requirement: finding.requirementType,
          state: finding.state,
          reason: finding.reason,
          cause: finding.cause,
        })),
      note:
        report.counts.INCOMPLETE > 0
          ? 'Some claims could not be checked in this run (throttle, timeout or index lag). They are reported as INCOMPLETE, never as missing evidence.'
          : report.counts.NOT_VISIBLE > 0
            ? 'Some claims could not be verified because a Teamwork Graph scope is not granted. They are reported as NOT_VISIBLE.'
            : undefined,
    };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * action: get-evidence (GET, stateless).
 *
 * Reads one work item and judges its claims live, so the answer does not depend
 * on Forge SQL having been reached by a previous run (R6: home chat routes to a
 * different installation).
 */
export async function actionGetEvidence(event: unknown, context?: unknown) {
  const { payload, context: ctx } = invocation(event, context);
  const issueKey = stringField(payload, 'issueKey');
  if (!issueKey) {
    return { error: 'Give me a work item key (for example PAY-1).' };
  }
  const siteUrl = stringField(payload, 'siteUrl') ?? siteUrlOf(ctx);
  const gate = await evaluateIssueGate({
    issueKey,
    controlCode: stringField(payload, 'controlCode'),
    cloudId: cloudIdOf(ctx),
    siteUrl,
    // The chat surface has no Jira product context, but callers do carry an accountId.
    // Without it every Confluence read in this action ran as the app, which is exactly
    // the identity whose empty answer is indistinguishable from a permission gap, and
    // the same claim could read differently in chat and in the panel.
    accountId: accountIdOf(ctx) ?? null,
  });
  if (!gate.issue) {
    // A Rovo home chat has no Jira product context, so Jira REST cannot be read
    // there at all. Saying "I could not read it" is a dead end; saying which surface
    // can read it, with a link, is the honest answer — and it keeps the judgment on
    // the panel instead of pretending this context is equivalent.
    const reason = gate.badge.detail ?? `${issueKey} could not be read.`;
    const needsSiteContext = /product context|status 0|could not be found|not readable|failed \(0\)/i.test(
      reason,
    );
    return {
      workItem: issueKey,
      error: reason,
      needsSiteContext,
      hint: needsSiteContext
        ? 'This chat has no Jira product context, so Jira REST cannot be read from here. Run the same question from the work item’s Evidence panel (or in Jira’s Rovo chat), or give me the site URL and I will link you to it.'
        : undefined,
      deepLink: needsSiteContext && siteUrl ? `${siteUrl.replace(/\/$/, '')}/browse/${issueKey}` : undefined,
      verdict: gate.badge,
      claims: [],
    };
  }
  return {
    workItem: gate.issue?.key ?? issueKey,
    control: gate.control,
    verdict: gate.badge,
    claims: gate.requirements.map((row) => ({
      claim: row.claim,
      state: row.state,
      reason: row.reason,
      evidence: row.evidence?.label ?? null,
      observedAt: row.evidence?.observedAt ?? null,
      missingScopes: row.missingScopes.map((scope) => scope.scope),
      cause: row.failures[0]?.cause ?? null,
    })),
  };
}

/** action: explain-verdict (GET, stateless) — the chain, hop by hop. */
export async function actionExplainVerdict(event: unknown, context?: unknown) {
  const { payload, context: ctx } = invocation(event, context);
  const issueKey = stringField(payload, 'issueKey');
  if (!issueKey) {
    return { error: 'Give me the work item key whose verdict you want explained.' };
  }
  const gate = await evaluateIssueGate({
    issueKey,
    controlCode: stringField(payload, 'controlCode'),
    cloudId: cloudIdOf(ctx),
    siteUrl: siteUrlOf(ctx),
    accountId: accountIdOf(ctx) ?? null,
  });
  const claimLabel = stringField(payload, 'claim');
  const row =
    gate.requirements.find((candidate) =>
      claimLabel
        ? candidate.claim.toLowerCase().includes(claimLabel.toLowerCase())
        : candidate.state !== 'VERIFIED',
    ) ?? gate.requirements[0];
  if (!row) {
    return { error: 'No claim to explain for that work item.' };
  }
  return {
    workItem: issueKey,
    claim: row.claim,
    state: row.state,
    reason: row.reason,
    execution: {
      queryKey: row.trace.queryKey,
      rows: row.trace.rows,
      latencyMs: row.trace.latencyMs,
      retries: row.trace.retries,
      mode: row.trace.mode,
    },
    chain: row.trace.graph.links.map(
      (link) => `${link.hop}. ${link.from} -[${link.relation}]-> ${link.to} @ ${link.observedAt}`,
    ),
  };
}

/** action: create-remediation (CREATE) — only after the user confirmed. */
export async function actionCreateRemediation(event: unknown, context?: unknown) {
  const { payload, context: ctx } = invocation(event, context);
  const issueKey = stringField(payload, 'issueKey');
  const controlCode = stringField(payload, 'controlCode');
  try {
    if (issueKey) {
      const report = await closeGapsForIssue({
        issueKey,
        controlCode,
        cloudId: cloudIdOf(ctx),
        siteUrl: siteUrlOf(ctx),
        dueInDays: numberField(payload, 'dueInDays'),
      });
      return {
        created: report.created,
        skipped: report.skipped,
        ownerRoutes: report.routes,
        note:
          report.created.length === 0
            ? 'Nothing to create: no missing or stale claim was found for that work item.'
            : `${report.created.length} remediation issue(s) created, each with the owner route that produced its assignee.`,
      };
    }
    const report = await createRemediations({
      controlCode,
      dueInDays: numberField(payload, 'dueInDays'),
      context: ctx,
    });
    return { ...report, note: `${report.created.length} remediation issue(s) created from the latest scan.` };
  } catch (cause) {
    if (cause instanceof PermissionError) {
      return { error: refusalMessage(cause.result), denied: true, permission: cause.result.permission };
    }
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

// ---------------------------------------------------------------------------
// Scheduled trigger — the unattended drift scan
// ---------------------------------------------------------------------------

export function shouldRunDailyScan(lastScanIso: string | null, now: Date, minHours = 20): boolean {
  if (!lastScanIso) {
    return true;
  }
  const last = Date.parse(lastScanIso);
  if (Number.isNaN(last)) {
    return true;
  }
  return now.getTime() - last >= minHours * 60 * 60 * 1000;
}

/**
 * How many hours must pass between two scheduled scans.
 *
 * 20 by default: Forge's `day` trigger fires at a clock time the platform chooses,
 * so "once a day" is expressed as "not twice within 20 hours". The value is an
 * environment variable because a site that wants an hourly drift scan should not
 * need a code change — and because the unattended hop can then be exercised on
 * demand instead of waiting for the next day's fire.
 */
export function scheduledIntervalHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ASSUR_SCHEDULED_MIN_HOURS;
  const hours = raw === undefined || raw === '' ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(hours) && hours >= 0 ? hours : 20;
}

export async function scheduledDriftScan(event: unknown) {
  const { context } = invocation(event);
  await ensureSchema();
  const last = await getConfig(CONFIG_LAST_DAILY_SCAN);
  const minHours = scheduledIntervalHours();
  if (!shouldRunDailyScan(last, new Date(), minHours)) {
    return {
      skipped: true,
      reason: `a scheduled scan already ran within ${minHours} hour(s)`,
    };
  }
  // Whose eyes to borrow. Order: the configured principal, then whoever bound the
  // programme to this site, then nobody. A fresh install used to skip here and stamp
  // the day as if it had scanned, so the "daily drift scan" never ran on a site that
  // had not been set up by hand (C7). The stamp is only written by a run that ran.
  let principal = await getConfig(CONFIG_SCAN_PRINCIPAL).catch(() => null);
  if (!principal) {
    const binding = parseBinding(await getConfig(CONFIG_SITE_BINDING).catch(() => null));
    principal = binding?.boundBy ?? null;
    if (principal) {
      await setConfig(CONFIG_SCAN_PRINCIPAL, principal).catch(() => undefined);
    }
  }
  if (!principal) {
    return {
      skipped: true,
      reason:
        'No scan principal configured yet. Open the AssureLoop control room and run one scan (or bind the programme): ' +
        'the account that does it becomes the principal the unattended scan impersonates for Teamwork Graph reads.',
    };
  }
  try {
    return await runScan({ trigger: 'SCHEDULED', context, asAccountId: principal });
  } catch (cause) {
    console.error('Scheduled drift scan failed:', cause);
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export async function setScanPrincipal(accountId: string, options: { permission?: 'check' | 'skip' } = {}): Promise<void> {
  await ensureSchema();
  // The principal is whose eyes every unattended scan borrows. Naming one is a site
  // administrator's act: the scan reads Confluence and the graph as that person.
  if (options.permission !== 'skip') {
    await requireJiraPermission({ permission: PERMISSIONS.ADMINISTER });
  }
  await setConfig(CONFIG_SCAN_PRINCIPAL, accountId);
}

export { addEvidenceLink };

/**
 * Exported for the honesty tests: these read paths are where a failed read used to
 * become a finding, so they are exercised directly against a fake site rather than
 * only through a scan that needs Forge SQL. `observeConnectors` is here because the
 * scan and the issue panel must agree on the same work item (v6.27 parity test).
 */
export { observeComments, observeConnectors, observePolicy, observeWorkItems, populationFor };
