/**
 * Jira REST: the enumeration half of the hybrid query design.
 *
 * JQL is cheaper and exact for "which work items are in this population", and a
 * 200 here also proves the caller can see the project — which is what makes an
 * empty population meaningful. Relationships (who approved, who owns the policy,
 * which team) come from the Teamwork Graph instead.
 */

import api, { route } from '@forge/api';
import { noteRestCall } from '../g0/counters';

export interface JiraUser {
  accountId: string;
  name: string;
  active: boolean;
}

export interface JiraIssueSummary {
  id: string;
  key: string;
  summary: string;
  statusName: string;
  statusCategoryKey: string;
  assigneeAccountId: string | null;
  assigneeName: string | null;
  assigneeActive: boolean | null;
  /**
   * Who raised the work item. Read for one reason: segregation of duties.
   *
   * A sign-off from the person who reported the change is the same pair of hands the
   * independent-approval claim exists to keep apart, so the claim compares the
   * approver against the reporter as well as against the assignee.
   */
  reporterAccountId: string | null;
  reporterName: string | null;
  updated: string;
  issueType: string;
}

export interface JiraComponent {
  id: string;
  name: string;
  lead: JiraUser | null;
}

export interface JiraIssueDetail extends JiraIssueSummary {
  projectKey: string;
  projectId: string | null;
  labels: string[];
  components: JiraComponent[];
  created: string;
}

export interface JiraComment {
  id: string;
  authorAccountId: string | null;
  authorName: string | null;
  authorActive: boolean;
  bodyText: string;
  created: string;
}

export interface RemoteLink {
  url: string;
  title: string;
}

export interface JiraReadError {
  status: number;
  message: string;
}

/** Flatten Atlassian Document Format into plain text, so rules stay deterministic. */
export function adfToText(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(adfToText).join(' ');
  }
  if (typeof node !== 'object' || node === null) {
    return '';
  }
  const record = node as { text?: unknown; content?: unknown };
  const own = typeof record.text === 'string' ? record.text : '';
  const children = Array.isArray(record.content) ? record.content.map(adfToText).join(' ') : '';
  return `${own} ${children}`.trim();
}

/** ari:cloud:identity::user/<accountId> — the user ARI shape the graph expects. */
export function userAri(accountId: string): string {
  return `ari:cloud:identity::user/${accountId}`;
}

interface RawIssueFields {
  summary?: string;
  updated?: string;
  created?: string;
  status?: { name?: string; statusCategory?: { key?: string } };
  assignee?: { accountId?: string; displayName?: string; active?: boolean } | null;
  reporter?: { accountId?: string; displayName?: string; active?: boolean } | null;
  issuetype?: { name?: string };
  labels?: string[];
  project?: { key?: string; id?: string };
  components?: Array<{
    id?: string;
    name?: string;
    lead?: { accountId?: string; displayName?: string; active?: boolean } | null;
  }>;
}

function mapIssue(issue: { id: string; key: string; fields?: RawIssueFields }): JiraIssueDetail {
  const fields = issue.fields ?? {};
  const assignee = fields.assignee;
  const reporter = fields.reporter;
  return {
    id: issue.id,
    key: issue.key,
    summary: fields.summary ?? '',
    statusName: fields.status?.name ?? 'Unknown',
    statusCategoryKey: fields.status?.statusCategory?.key ?? '',
    assigneeAccountId: assignee?.accountId ?? null,
    assigneeName: assignee?.displayName ?? null,
    assigneeActive: typeof assignee?.active === 'boolean' ? assignee.active : null,
    reporterAccountId: reporter?.accountId ?? null,
    reporterName: reporter?.displayName ?? null,
    updated: fields.updated ?? new Date().toISOString(),
    created: fields.created ?? fields.updated ?? new Date().toISOString(),
    issueType: fields.issuetype?.name ?? 'Task',
    projectKey: fields.project?.key ?? '',
    projectId: fields.project?.id ?? null,
    labels: fields.labels ?? [],
    components: (fields.components ?? []).map((component) => ({
      id: component.id ?? '',
      name: component.name ?? '',
      lead: component.lead?.accountId
        ? {
            accountId: component.lead.accountId,
            name: component.lead.displayName ?? component.lead.accountId,
            active: component.lead.active !== false,
          }
        : null,
    })),
  };
}

const ISSUE_FIELDS = [
  'summary',
  'status',
  'assignee',
  'reporter',
  'updated',
  'created',
  'issuetype',
  'labels',
  'project',
  'components',
];

/**
 * Search with JQL, following the endpoint's page token up to `maxResults`.
 *
 * The old call asked for one page of 50 and returned it. On a site with 51 labelled
 * changes the 51st was never read and nothing said so, which is exactly the shape of
 * claim this product must not make ("the population was read" when it was not). The
 * loop below reads the whole answer up to the cap, and a caller that hits the cap can
 * see it: `jqlSearchPage` reports `truncated`.
 */
export async function jqlSearch(jql: string, maxResults = 50): Promise<JiraIssueSummary[]> {
  const page = await jqlSearchPage(jql, maxResults);
  return page.issues;
}

export async function jqlSearchPage(
  jql: string,
  maxResults = 50,
): Promise<{ issues: JiraIssueSummary[]; truncated: boolean }> {
  const collected: JiraIssueSummary[] = [];
  let nextPageToken: string | undefined;
  let truncated = false;
  // The endpoint caps a page at 100; asking for the remainder keeps the last call small.
  for (let guard = 0; guard < 20 && collected.length < maxResults; guard += 1) {
    const pageSize = Math.max(1, Math.min(100, maxResults - collected.length));
    noteRestCall();
    const response = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jql,
        maxResults: pageSize,
        fields: ISSUE_FIELDS,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`JQL failed (${response.status}): ${await response.text()}`);
    }
    const body = (await response.json()) as {
      issues?: Array<{ id: string; key: string; fields?: RawIssueFields }>;
      nextPageToken?: string;
      isLast?: boolean;
    };
    for (const issue of body.issues ?? []) {
      const detail = mapIssue(issue);
      collected.push({
        id: detail.id,
        key: detail.key,
        summary: detail.summary,
        statusName: detail.statusName,
        statusCategoryKey: detail.statusCategoryKey,
        assigneeAccountId: detail.assigneeAccountId,
        assigneeName: detail.assigneeName,
        assigneeActive: detail.assigneeActive,
        reporterAccountId: detail.reporterAccountId,
        reporterName: detail.reporterName,
        updated: detail.updated,
        issueType: detail.issueType,
      });
    }
    nextPageToken = body.nextPageToken;
    if (body.isLast === true || !nextPageToken) {
      break;
    }
    if (collected.length >= maxResults) {
      // Rows remain and the caller's cap is reached: say so rather than pretend the
      // list ended.
      truncated = true;
    }
  }
  if (collected.length > maxResults) {
    collected.length = maxResults;
  }
  if (collected.length === maxResults && nextPageToken && !truncated) {
    truncated = true;
  }
  return { issues: collected, truncated };
}

export async function getIssue(issueKey: string): Promise<{ issue: JiraIssueDetail | null; error?: JiraReadError }> {
  noteRestCall();
  try {
    const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return {
        issue: null,
        error: { status: response.status, message: `GET issue ${issueKey} failed (${response.status})` },
      };
    }
    const body = (await response.json()) as { id: string; key: string; fields?: RawIssueFields };
    return { issue: mapIssue(body) };
  } catch (cause) {
    return {
      issue: null,
      error: {
        status: 0,
        message: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
}

/**
 * Every comment on the work item, page by page.
 *
 * One request of 100 used to be the whole answer, so on a long-running ticket the
 * approval on comment 101 was invisible and the claim said "no approval" about a
 * conversation that had one. The loop below follows `startAt`/`total` up to a cap and
 * sets `truncated` when the cap is what stopped it, so a caller can say "read 500 of
 * 780" instead of implying it saw everything.
 */
export async function issueComments(
  issueKey: string,
  maxResults = 500,
): Promise<{ comments: JiraComment[]; error?: JiraReadError; truncated?: boolean }> {
  const comments: JiraComment[] = [];
  let startAt = 0;
  let total = 0;
  let pages = 0;
  try {
    do {
      noteRestCall();
      const pageSize = Math.max(1, Math.min(100, maxResults - comments.length));
      const response = await api
        .asApp()
        .requestJira(
          route`/rest/api/3/issue/${issueKey}/comment?startAt=${startAt}&maxResults=${pageSize}`,
          { headers: { Accept: 'application/json' } },
        );
      if (!response.ok) {
        return {
          comments,
          error: { status: response.status, message: `GET comments for ${issueKey} failed (${response.status})` },
        };
      }
      const body = (await response.json()) as {
        comments?: Array<{
          id: string;
          author?: { accountId?: string; displayName?: string; active?: boolean };
          body?: unknown;
          created?: string;
        }>;
        startAt?: number;
        maxResults?: number;
        total?: number;
      };
      const page = body.comments ?? [];
      for (const comment of page) {
        comments.push({
          id: comment.id,
          authorAccountId: comment.author?.accountId ?? null,
          authorName: comment.author?.displayName ?? null,
          authorActive: comment.author?.active !== false,
          bodyText: adfToText(comment.body),
          created: comment.created ?? new Date().toISOString(),
        });
      }
      total = body.total ?? comments.length;
      startAt += page.length;
      pages += 1;
      if (page.length === 0) {
        break;
      }
    } while (startAt < total && comments.length < maxResults && pages < 10);
    return { comments, truncated: comments.length < total };
  } catch (cause) {
    return {
      comments,
      error: { status: 0, message: cause instanceof Error ? cause.message : String(cause) },
    };
  }
}

/**
 * Remote links on a work item — where connector apps put pull requests and
 * deployments.
 *
 * The status travels with the answer instead of being swallowed. Returning `[]` for
 * a 403 made the gate conclude "nothing on this site writes remote links", i.e. it
 * reported a permission gap as "unsupported claim" — the single misclassification
 * this product exists to avoid. A caller that gets `error` must treat the read as
 * unchecked, not as an empty list.
 */
export async function issueRemoteLinks(
  issueKey: string,
): Promise<{ links: RemoteLink[]; error?: JiraReadError }> {
  noteRestCall();
  try {
    const response = await api
      .asApp()
      .requestJira(route`/rest/api/3/issue/${issueKey}/remotelink`, {
        headers: { Accept: 'application/json' },
      });
    if (!response.ok) {
      return {
        links: [],
        error: {
          status: response.status,
          message: `GET remote links for ${issueKey} failed (${response.status})`,
        },
      };
    }
    const body = (await response.json()) as Array<{ object?: { url?: string; title?: string } }>;
    return {
      links: body
        .map((entry) => ({ url: entry.object?.url ?? '', title: entry.object?.title ?? '' }))
        .filter((entry) => entry.url.length > 0),
    };
  } catch (cause) {
    return {
      links: [],
      error: { status: 0, message: cause instanceof Error ? cause.message : String(cause) },
    };
  }
}

export async function jiraProjectIdByKey(projectKey: string): Promise<string | null> {
  noteRestCall();
  const response = await api
    .asApp()
    .requestJira(route`/rest/api/3/project/${projectKey}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as { id?: string };
  return body.id ?? null;
}

/** Add one label without clearing the others — the claim action. */
export async function addIssueLabel(issueKey: string, label: string): Promise<void> {
  noteRestCall();
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ update: { labels: [{ add: label }] } }),
  });
  if (!response.ok) {
    throw new Error(`Label update failed (${response.status}): ${await response.text()}`);
  }
}

export async function createJiraIssue(input: {
  projectKey: string;
  summary: string;
  description: string;
  assigneeAccountId?: string | null;
  dueDate?: string;
  labels: readonly string[];
}): Promise<{ key: string; id: string }> {
  noteRestCall();
  const description = {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: input.description }] }],
  };
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    summary: input.summary,
    description,
    issuetype: { name: 'Task' },
    labels: [...input.labels],
  };
  if (input.assigneeAccountId) {
    fields.assignee = { id: input.assigneeAccountId };
  }
  if (input.dueDate) {
    fields.duedate = input.dueDate;
  }
  const response = await api.asApp().requestJira(route`/rest/api/3/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) {
    throw new Error(`Issue creation failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { id: string; key: string };
  return { key: body.key, id: body.id };
}

/**
 * Add a plain-text comment as the app.
 *
 * Used by the one-click onboarding to leave a note on the sample changes it
 * creates. The app never writes an *approval*: an approval the app wrote itself
 * would be the app manufacturing its own evidence, which is exactly what this
 * product refuses to do.
 */
export async function addIssueComment(issueKey: string, text: string): Promise<void> {
  noteRestCall();
  const body = {
    body: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    },
  };
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Comment failed (${response.status}): ${await response.text()}`);
  }
}

/**
 * Move an issue to the first transition whose target is in the `done` category.
 *
 * A sample change that stays in To Do is not a completed change, and the work-item
 * claim would (correctly) report it missing — but the point of onboarding is to
 * land the judge on a working example, so the transition is attempted and its
 * failure is reported rather than hidden.
 */
export async function transitionIssueToDone(
  issueKey: string,
): Promise<{ moved: boolean; status?: string; why?: string }> {
  noteRestCall();
  try {
    const listing = await api
      .asApp()
      .requestJira(route`/rest/api/3/issue/${issueKey}/transitions`, {
        headers: { Accept: 'application/json' },
      });
    if (!listing.ok) {
      return { moved: false, why: `transitions unreadable (${listing.status})` };
    }
    const body = (await listing.json()) as {
      transitions?: Array<{ id?: string; name?: string; to?: { name?: string; statusCategory?: { key?: string } } }>;
    };
    const done = (body.transitions ?? []).find(
      (transition) => transition.to?.statusCategory?.key === 'done',
    );
    if (!done?.id) {
      return { moved: false, why: 'this workflow has no transition to a done status' };
    }
    const applied = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/transitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ transition: { id: done.id } }),
    });
    if (!applied.ok) {
      return { moved: false, why: `status ${applied.status}` };
    }
    return { moved: true, status: done.to?.name };
  } catch (cause) {
    return { moved: false, why: cause instanceof Error ? cause.message : String(cause) };
  }
}

export interface JiraProjectSummary {
  key: string;
  name: string;
  id: string;
}

/**
 * Projects this app can read, for the one-click bind step.
 *
 * Returns an error rather than an empty list when the read fails: "no projects"
 * and "cannot read projects" lead to different next steps for an installer.
 */
export async function listProjects(): Promise<{ projects: JiraProjectSummary[]; error?: JiraReadError }> {
  noteRestCall();
  try {
    const response = await api
      .asApp()
      .requestJira(route`/rest/api/3/project/search?maxResults=50&orderBy=name`, {
        headers: { Accept: 'application/json' },
      });
    if (!response.ok) {
      return {
        projects: [],
        error: { status: response.status, message: `Project list failed (${response.status})` },
      };
    }
    const body = (await response.json()) as {
      values?: Array<{ id?: string; key?: string; name?: string }>;
    };
    return {
      projects: (body.values ?? [])
        .filter((project) => Boolean(project.key))
        .map((project) => ({
          key: String(project.key),
          name: project.name ?? String(project.key),
          id: String(project.id ?? ''),
        })),
    };
  } catch (cause) {
    return {
      projects: [],
      error: { status: 0, message: cause instanceof Error ? cause.message : String(cause) },
    };
  }
}
