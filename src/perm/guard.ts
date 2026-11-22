/**
 * Who is allowed to do what.
 *
 * Every surface of this app that writes asks Jira first, as the person pressing the
 * button: `GET /rest/api/3/mypermissions?permissions=<name>&issueKey=<key>` read as
 * the user. The answer is the platform's, not ours, and it is about that person on
 * that site - not about the app's own identity, which can hold far more than the
 * person in front of the screen.
 *
 * Three outcomes, and they are not interchangeable:
 *
 *   GRANTED        Jira says the account holds the permission. The write proceeds.
 *   DENIED         Jira says it does not. The write is refused, before any change.
 *   UNESTABLISHED  The check itself did not answer (a 4xx/5xx, a transport failure,
 *                  an answer that does not state the permission). A write is
 *                  refused here too: "I could not ask" is not "yes".
 *
 * A read is treated differently on purpose. A confirmed denial stops the read before
 * a verdict is computed, because a verdict about a work item the person may not see
 * is not theirs to have. A read that cannot be confirmed proceeds: the read itself
 * is the authority on visibility, and the engine already reports a 403 as
 * NOT_VISIBLE with the scope that would fix it - refusing to judge because the
 * permission probe failed would turn a working panel into an empty one.
 *
 * No new Forge scope is used: mypermissions is part of read:jira-work, which the app
 * already declares, and it is called as the user rather than as the app.
 */

import api, { route } from '@forge/api';

export type PermissionCause = 'GRANTED' | 'DENIED' | 'UNESTABLISHED';

export interface PermissionResult {
  /** True only for GRANTED: an unanswered check is not a yes. */
  allowed: boolean;
  permission: string;
  /** The work item the question was asked about, when it was scoped to one. */
  issueKey: string | null;
  cause: PermissionCause;
  /** What Jira said, in one sentence, for the screen and the log. */
  detail: string;
}

export const PERMISSIONS = {
  /** Site administration: the programme, the registry, exceptions, seeding. */
  ADMINISTER: 'ADMINISTER',
  /** Editing one work item: claiming it for a control, closing its gaps. */
  EDIT_ISSUES: 'EDIT_ISSUES',
  /** Seeing one work item at all: the precondition of judging it. */
  BROWSE_PROJECTS: 'BROWSE_PROJECTS',
} as const;

/** Raised by the domain functions so a caller cannot forget to look. */
export class PermissionError extends Error {
  readonly result: PermissionResult;

  constructor(result: PermissionResult, action: 'write' | 'read' = 'write') {
    super(refusalMessage(result, action));
    this.name = 'PermissionError';
    this.result = result;
  }
}

/**
 * The sentence a person reads when they are refused.
 *
 * It names the permission, what did not happen, and the one step that would change
 * it - the same shape the app uses for a missing graph scope.
 */
export function refusalMessage(result: PermissionResult, action: 'write' | 'read' = 'write'): string {
  const where = result.issueKey ? ` on ${result.issueKey}` : ' on this site';
  if (result.cause === 'GRANTED') {
    return `${result.permission} is granted${where}.`;
  }
  if (result.cause === 'DENIED') {
    if (result.permission === PERMISSIONS.BROWSE_PROJECTS) {
      return (
        `Your Jira account cannot browse ${result.issueKey ?? 'this work item'}, so it was not judged. ` +
        'Ask a project administrator for Browse projects on its project.'
      );
    }
    if (result.permission === PERMISSIONS.EDIT_ISSUES) {
      return (
        `Your Jira account cannot edit ${result.issueKey ?? 'that work item'}, so nothing was written. ` +
        'Ask a project administrator for Edit issues, or have someone who holds it make the change.'
      );
    }
    return (
      `Your Jira account does not hold ${result.permission}${where}, so nothing was written. ` +
      'Ask a site administrator to grant it, or have an administrator make the change.'
    );
  }
  return action === 'read'
    ? `Jira did not confirm ${result.permission}${where} (${result.detail}). The read went ahead, and what it could not see is reported as not visible.`
    : `Jira did not confirm ${result.permission}${where} (${result.detail}). ` +
        'Nothing was written: a change is refused until Jira confirms the permission.';
}

/**
 * Ask Jira, as the calling user, whether the account holds one permission.
 *
 * Never throws: every way the check can fail becomes an UNESTABLISHED answer, so the
 * caller's decision is only ever GRANTED / DENIED / UNESTABLISHED.
 */
export async function checkJiraPermission(input: {
  permission: string;
  /** Scope the question to one work item (EDIT_ISSUES, BROWSE_PROJECTS). */
  issueKey?: string | null;
}): Promise<PermissionResult> {
  const permission = input.permission;
  const issueKey = input.issueKey ?? null;
  const path = issueKey
    ? route`/rest/api/3/mypermissions?permissions=${permission}&issueKey=${issueKey}`
    : route`/rest/api/3/mypermissions?permissions=${permission}`;
  try {
    const response = await api.asUser().requestJira(path, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      return {
        allowed: false,
        permission,
        issueKey,
        cause: 'UNESTABLISHED',
        detail: `the permission check answered HTTP ${response.status}`,
      };
    }
    const body = (await response.json()) as {
      permissions?: Record<string, { havePermission?: boolean } | undefined>;
    };
    const entry = body.permissions?.[permission];
    if (!entry || typeof entry.havePermission !== 'boolean') {
      return {
        allowed: false,
        permission,
        issueKey,
        cause: 'UNESTABLISHED',
        detail: 'the answer did not state whether the permission is held',
      };
    }
    return entry.havePermission
      ? {
          allowed: true,
          permission,
          issueKey,
          cause: 'GRANTED',
          detail: `Jira reports ${permission} granted${issueKey ? ` on ${issueKey}` : ' on this site'}`,
        }
      : {
          allowed: false,
          permission,
          issueKey,
          cause: 'DENIED',
          detail: `Jira reports ${permission} not granted${issueKey ? ` on ${issueKey}` : ' on this site'}`,
        };
  } catch (cause) {
    return {
      allowed: false,
      permission,
      issueKey,
      cause: 'UNESTABLISHED',
      detail: `the permission check could not be made (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }
}

/**
 * A write's precondition, as one call: throws PermissionError unless Jira confirms
 * the permission for this account.
 */
export async function requireJiraPermission(input: {
  permission: string;
  issueKey?: string | null;
}): Promise<PermissionResult> {
  const result = await checkJiraPermission(input);
  if (!result.allowed) {
    throw new PermissionError(result, 'write');
  }
  return result;
}

/** The shape a resolver returns when it refused, so a screen can say why. */
export function refusalBody(result: PermissionResult, action: 'write' | 'read' = 'write') {
  return {
    denied: true,
    permission: result.permission,
    permissionCause: result.cause,
    why: refusalMessage(result, action),
  };
}

/** True for a gate whose verdict was suppressed by a confirmed denial. */
export function isDenial(result: PermissionResult | null | undefined): boolean {
  return result?.cause === 'DENIED';
}
