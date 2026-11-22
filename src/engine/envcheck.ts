/**
 * Environment Check (E5): six probes, one budget, answered in seconds.
 *
 * Why this exists: the Teamwork Graph fails closed (a scope the admin did not
 * grant returns an empty, successful result) and it fails *partially*
 * (`teamsV2` answers 403 while everything else is fine). Without a check the
 * first thing an installer sees is an empty panel, which reads as "broken app".
 * This turns the app's own blind spots into the first screen: what it can see,
 * what it cannot, and what to approve.
 *
 * Everything here is read-only and stateless — no Forge SQL, no writes — so the
 * same code answers from the issue panel, the Control Room, and a Rovo action.
 */

import { firstPage } from '../confluence/rest';
import { jqlSearch, jiraProjectIdByKey } from '../jira/rest';
import {
  GRAPH_SCOPES,
  PERSISTED_QUERIES,
  classifyFailure,
  executePersistedQuery,
  fetchPageOwners,
  fetchSpaceWorkItems,
  fetchTeamsBySpace,
  fetchUserTeams,
  fetchWorkItemComments,
  queryKeyFor,
  runGraphQL,
  scopeExplanation,
  type GraphError,
  type GraphRead,
  type GraphScope,
} from '../twg/queries';

export type ProbeState = 'GREEN' | 'YELLOW' | 'RED';

export type ProbeId = 'connection' | 'issue' | 'comment' | 'policy' | 'people' | 'persisted';

export interface EnvironmentProbe {
  id: ProbeId;
  label: string;
  state: ProbeState;
  /** One line the installer can act on. */
  detail: string;
  scopes: GraphScope[];
  /** What to approve when this is not green. */
  remedy: string;
  latencyMs: number;
  error?: string;
}

export interface EnvironmentReport {
  checkedAt: string;
  durationMs: number;
  budgetMs: number;
  probes: EnvironmentProbe[];
  summary: { green: number; yellow: number; red: number };
  /** The objects the probes used, so a red result is reproducible. */
  fixtures: { issueKey: string | null; pageAri: string | null; spaceAri: string | null; userAri: string };
}

const DEFAULT_BUDGET_MS = 5_000;

export interface ProbeContext {
  cloudId: string;
  accountId: string;
  userAri: string;
  /** A Jira work item to read; discovered from JQL when not supplied. */
  issueAri?: string;
  issueKey?: string;
  projectKey?: string;
  projectId?: string;
  pageAri?: string;
  spaceAri?: string;
}

/** Race a probe against the remaining budget so one slow call cannot eat all six. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<{ value: T | null; timedOut: boolean }> {
  if (ms <= 0) {
    return { value: null, timedOut: true };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ value: null; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ value: null, timedOut: true }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ value, timedOut: false })), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function stateOf(read: GraphRead<unknown> | null, timedOut: boolean): ProbeState {
  if (timedOut) {
    return 'YELLOW';
  }
  if (!read) {
    return 'YELLOW';
  }
  if (read.outcome === 'ERROR') {
    const cause = read.error?.cause ?? classifyFailure(read.error?.status, read.error?.message ?? '');
    if (cause === 'PERMISSION_DENIED') {
      return 'RED';
    }
    // Unknown probe fields and throttling are not permission problems; they are
    // "cannot tell from here", which is yellow.
    return 'YELLOW';
  }
  return read.rows.length > 0 ? 'GREEN' : 'YELLOW';
}

function scopeRemedy(scopes: readonly GraphScope[]): string {
  if (scopes.length === 0) {
    return 'No action needed.';
  }
  return `Ask an organisation admin to approve ${scopes.join(', ')} for this app (Apps → Manage apps → AssureLoop → Permissions).`;
}

function describeRead(read: GraphRead<unknown> | null, timedOut: boolean, rows: number): string {
  if (timedOut) {
    return 'The probe did not answer inside the time budget.';
  }
  if (!read) {
    return 'The probe could not run: no object of this type was found on the site.';
  }
  if (read.outcome === 'ERROR') {
    const cause = read.error?.cause ?? 'UNKNOWN';
    if (read.error?.message && /unknown|not found|no such field|cannot query/i.test(read.error.message)) {
      return `This site does not expose the probe field (${read.error.message}). Not a permission problem.`;
    }
    return `${cause}: ${read.error?.message ?? 'read failed'}`;
  }
  if (rows > 0) {
    return `${rows} row(s) returned in ${read.latencyMs} ms.`;
  }
  return 'The read succeeded but returned no rows: either the site has no data of this type, or the scope was not granted. The graph cannot tell the two apart.';
}

/**
 * Run the six probes. Never throws: a probe that explodes becomes a RED or
 * YELLOW row, because a broken check that hides itself is worse than no check.
 */
export async function runEnvironmentCheck(options: {
  context: ProbeContext;
  budgetMs?: number;
}): Promise<EnvironmentReport> {
  const started = Date.now();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = started + budgetMs;
  const probing = options.context;

  // Fixtures first, but inside the budget: a site with no work item or page is a
  // legitimate answer ("nothing to read yet"), not a failure.
  const fixtureWork = (async () => {
    let issueAri = probing.issueAri;
    let issueKey = probing.issueKey;
    let projectId = probing.projectId;
    if (!issueAri) {
      try {
        const projectKey = probing.projectKey;
        const jql = projectKey ? `project = "${projectKey}" ORDER BY updated DESC` : 'ORDER BY updated DESC';
        const issues = await jqlSearch(jql, 1);
        const issue = issues[0];
        if (issue) {
          issueAri = `ari:cloud:jira:${probing.cloudId}:issue/${issue.id}`;
          issueKey = issue.key;
        }
      } catch {
        // No project / no permission: the issue probe reports that below.
      }
    }
    if (!projectId && probing.projectKey) {
      projectId = (await jiraProjectIdByKey(probing.projectKey).catch(() => null)) ?? undefined;
    }
    let pageAri = probing.pageAri;
    let spaceAri = probing.spaceAri;
    if (!pageAri) {
      const page = await firstPage({ asAccountId: probing.accountId }).catch(() => null);
      if (page) {
        pageAri = `ari:cloud:confluence:${probing.cloudId}:page/${page.id}`;
        if (page.spaceId) {
          spaceAri = `ari:cloud:confluence:${probing.cloudId}:space/${page.spaceId}`;
        }
      }
    }
    return { issueAri, issueKey, projectId, pageAri, spaceAri };
  })();

  const fixtures = await withDeadline(fixtureWork, Math.min(2_000, deadline - Date.now()));
  const resolved = fixtures.value ?? {
    issueAri: undefined,
    issueKey: undefined,
    projectId: undefined,
    pageAri: undefined,
    spaceAri: undefined,
  };
  const jiraSpaceAri =
    resolved.projectId !== undefined
      ? `ari:cloud:jira:${probing.cloudId}:project/${resolved.projectId}`
      : undefined;

  const remaining = () => Math.max(0, deadline - Date.now());

  const probes: Array<Promise<EnvironmentProbe>> = [];

  // 1. Connectivity: a valid GraphQL query with no data dependency.
  probes.push(
    (async (): Promise<EnvironmentProbe> => {
      const at = Date.now();
      const pending = runGraphQL('query AssureLoop_echo { __typename }', {});
      const { value, timedOut } = await withDeadline(pending, remaining());
      const state: ProbeState = timedOut ? 'YELLOW' : value?.error ? 'RED' : 'GREEN';
      return {
        id: 'connection',
        label: 'Connection (echo)',
        state,
        detail: timedOut
          ? 'The Teamwork Graph did not answer in time.'
          : value?.error
            ? `${value.error.cause ?? 'ERROR'}: ${value.error.message}`
            : 'The Teamwork Graph answered a minimal query.',
        scopes: [],
        remedy: state === 'GREEN' ? 'No action needed.' : 'Check that the site has Teamwork Graph (Rovo) enabled.',
        latencyMs: Date.now() - at,
        error: value?.error?.message,
      };
    })(),
  );

  // 2. Issue scope: work items in a project space.
  probes.push(
    (async (): Promise<EnvironmentProbe> => {
      const at = Date.now();
      const scopes = [GRAPH_SCOPES.WORK_ITEM, GRAPH_SCOPES.JIRA_SPACE];
      if (!jiraSpaceAri) {
        return {
          id: 'issue',
          label: 'Work item scope',
          state: 'YELLOW',
          detail: 'No Jira project could be resolved, so work-item visibility was not probed.',
          scopes,
          remedy: 'Open any Jira issue, then re-run the check.',
          latencyMs: Date.now() - at,
        };
      }
      const pending = fetchSpaceWorkItems(jiraSpaceAri);
      const { value, timedOut } = await withDeadline(pending, remaining());
      const state = stateOf(value ?? null, timedOut);
      return {
        id: 'issue',
        label: 'Work item scope',
        state,
        detail: describeRead(value ?? null, timedOut, value?.rows.length ?? 0),
        scopes,
        remedy: state === 'GREEN' ? 'No action needed.' : scopeRemedy(scopes),
        latencyMs: Date.now() - at,
        error: value?.error?.message,
      };
    })(),
  );

  // 3. Comment scope: the hop an approval claim rests on.
  probes.push(
    (async (): Promise<EnvironmentProbe> => {
      const at = Date.now();
      const scopes = [GRAPH_SCOPES.COMMENT, GRAPH_SCOPES.WORK_ITEM];
      if (!resolved.issueAri) {
        return {
          id: 'comment',
          label: 'Comment scope',
          state: 'YELLOW',
          detail: 'No work item was available, so comment visibility was not probed.',
          scopes,
          remedy: 'Open any Jira issue, then re-run the check.',
          latencyMs: Date.now() - at,
        };
      }
      const pending = fetchWorkItemComments(resolved.issueAri);
      const { value, timedOut } = await withDeadline(pending, remaining());
      const state = stateOf(value ?? null, timedOut);
      return {
        id: 'comment',
        label: 'Comment scope',
        state,
        detail: describeRead(value ?? null, timedOut, value?.rows.length ?? 0),
        scopes,
        remedy: state === 'GREEN' ? 'No action needed.' : scopeRemedy(scopes),
        latencyMs: Date.now() - at,
        error: value?.error?.message,
      };
    })(),
  );

  // 4. Page / space scope: policy ownership and the space behind it.
  probes.push(
    (async (): Promise<EnvironmentProbe> => {
      const at = Date.now();
      const scopes = [GRAPH_SCOPES.PAGE, GRAPH_SCOPES.CONFLUENCE_SPACE, GRAPH_SCOPES.USER];
      if (!resolved.pageAri) {
        return {
          id: 'policy',
          label: 'Page / space scope',
          state: 'YELLOW',
          detail: 'No Confluence page was visible to this app, so policy ownership was not probed.',
          scopes,
          remedy: 'Install the app on a site with at least one Confluence space, or grant read:page:confluence.',
          latencyMs: Date.now() - at,
        };
      }
      const pending = (async () => {
        const owners = await fetchPageOwners(resolved.pageAri as string);
        const teams = resolved.spaceAri ? await fetchTeamsBySpace(resolved.spaceAri) : null;
        return { owners, teams };
      })();
      const { value, timedOut } = await withDeadline(pending, remaining());
      const owners = value?.owners ?? null;
      const state = stateOf(owners, timedOut);
      const teamNote =
        value?.teams?.error !== undefined
          ? ` Team lookup failed (${value.teams.error.cause ?? 'ERROR'}), so owner routing falls back to page owner.`
          : '';
      return {
        id: 'policy',
        label: 'Page / space scope',
        state,
        detail: `${describeRead(owners, timedOut, owners?.rows.length ?? 0)}${teamNote}`,
        scopes,
        remedy: state === 'GREEN' ? 'No action needed.' : scopeRemedy(scopes),
        latencyMs: Date.now() - at,
        error: owners?.error?.message,
      };
    })(),
  );

  // 5. User / team scope: the route that assigns a gap to a person.
  probes.push(
    (async (): Promise<EnvironmentProbe> => {
      const at = Date.now();
      const scopes = [GRAPH_SCOPES.USER, GRAPH_SCOPES.TEAM];
      const pending = fetchUserTeams(probing.userAri);
      const { value, timedOut } = await withDeadline(pending, remaining());
      const read = value ?? null;
      const state = stateOf(read, timedOut);
      const known = read?.error?.message && /teamsV2|status code is: 403/i.test(read.error.message);
      return {
        id: 'people',
        label: 'User / team scope',
        state: known ? 'YELLOW' : state,
        detail: known
          ? 'The graph answered 403 from teamsV2, so team membership is unavailable even though scopes are granted. Remediation routes fall back to the space owner, then the issue assignee, then the component lead.'
          : describeRead(read, timedOut, read?.rows.length ?? 0),
        scopes,
        remedy:
          state === 'GREEN'
            ? 'No action needed.'
            : known
              ? 'No permission change will fix this; the app records the fallback route it used.'
              : scopeRemedy(scopes),
        latencyMs: Date.now() - at,
        error: read?.error?.message,
      };
    })(),
  );

  // 6. Persisted query state: registered, executable, or unavailable here.
  probes.push(
    (async (): Promise<EnvironmentProbe> => {
      const at = Date.now();
      const draft = PERSISTED_QUERIES.evidenceChain;
      const key = queryKeyFor(draft);
      if (!key) {
        return {
          id: 'persisted',
          label: 'Persisted query',
          state: 'YELLOW',
          detail:
            'No queryKey is configured, so the app runs on curated queries only. Multi-hop chains that the catalog cannot express are shown as their REST hops instead.',
          scopes: [],
          remedy: `Register ${draft.name} and set ${draft.envVar} to the returned queryKey (see README §6.2).`,
          latencyMs: Date.now() - at,
        };
      }
      if (!resolved.issueAri) {
        return {
          id: 'persisted',
          label: 'Persisted query',
          state: 'YELLOW',
          detail: `queryKey ${key} is configured, but there was no work item to execute it against.`,
          scopes: [],
          remedy: 'Open any Jira issue, then re-run the check.',
          latencyMs: Date.now() - at,
        };
      }
      const pending = executePersistedQuery('environment-check', key, { issueAri: resolved.issueAri });
      const { value, timedOut } = await withDeadline(pending, remaining());
      const state = stateOf(value ?? null, timedOut);
      return {
        id: 'persisted',
        label: 'Persisted query',
        state,
        detail: timedOut
          ? 'The persisted query did not answer in time.'
          : value?.error
            ? `${value.error.cause ?? 'ERROR'}: ${value.error.message}`
            : `queryKey ${key} executed (${value?.rows.length ?? 0} row(s), ${value?.latencyMs ?? 0} ms).`,
        scopes: [],
        remedy:
          state === 'GREEN'
            ? 'No action needed.'
            : 'If this reads FEATURE_UNAVAILABLE or NOT_FOUND, persisted Cypher is not enabled for this environment; the app keeps working on curated queries.',
        latencyMs: Date.now() - at,
        error: value?.error?.message,
      };
    })(),
  );

  const settled = await Promise.all(
    probes.map((probe) =>
      probe.catch(
        (cause: unknown): EnvironmentProbe => ({
          id: 'connection',
          label: 'Probe failed',
          state: 'RED',
          detail: cause instanceof Error ? cause.message : String(cause),
          scopes: [],
          remedy: 'Re-run the check. If it repeats, report the detail with a screenshot.',
          latencyMs: 0,
        }),
      ),
    ),
  );

  const summary = {
    green: settled.filter((probe) => probe.state === 'GREEN').length,
    yellow: settled.filter((probe) => probe.state === 'YELLOW').length,
    red: settled.filter((probe) => probe.state === 'RED').length,
  };

  return {
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    budgetMs,
    probes: settled,
    summary,
    fixtures: {
      issueKey: resolved.issueKey ?? null,
      pageAri: resolved.pageAri ?? null,
      spaceAri: resolved.spaceAri ?? null,
      userAri: probing.userAri,
    },
  };
}

/** Re-exported for the Control Room's scope table. */
export { scopeExplanation };
export type { GraphError };
