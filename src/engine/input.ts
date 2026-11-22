/**
 * Input that reaches a JQL string, a Jira label or the registry.
 *
 * A project key is interpolated into JQL (`project = "PAY"`), so it is the one input
 * in this app that can change what a query means. Jira's own keys are capital
 * letters, digits and underscores; anything else (a quote, a space, a bracket, an
 * `OR`) is not a key on any site, and passing it through would let a caller close
 * the quoted string and append a clause. The rule is a whitelist, not an escape: a
 * value that does not match is refused with the reason, never rewritten.
 *
 * The same discipline applies to a control code and a Jira label, which are written
 * into the registry and then into a JQL label match.
 */

export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]+$/;
export const CONTROL_CODE_PATTERN = /^[A-Z][A-Z0-9_-]{1,23}$/;
export const JIRA_LABEL_PATTERN = /^[a-z][a-z0-9_-]{1,39}$/;

export interface Invalid {
  ok: false;
  why: string;
}

export type Valid<T> = { ok: true; value: T } | Invalid;

/**
 * A Jira project key: starts with a capital letter, then capital letters, digits
 * or underscores. Between 2 and 32 characters, which covers every real key.
 */
export function validateProjectKey(raw: unknown): Valid<string> {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0) {
    return { ok: false, why: 'A project key is required.' };
  }
  if (value.length > 32) {
    return { ok: false, why: `A project key is at most 32 characters; "${value.slice(0, 12)}..." is longer.` };
  }
  if (!PROJECT_KEY_PATTERN.test(value)) {
    return {
      ok: false,
      why:
        `"${value.slice(0, 40)}" is not a Jira project key. A key starts with a capital letter and ` +
        'contains only capital letters, digits and underscores (for example PAY or PAY_CORE); ' +
        'quotes, spaces and other characters are refused because the key is read into a JQL query.',
    };
  }
  return { ok: true, value };
}

/** A control code: AC-13, AC_C1, RISK2. Written to the registry, shown on every row. */
export function validateControlCode(raw: unknown): Valid<string> {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (value.length === 0) {
    return { ok: false, why: 'A control code is required (for example AC-13).' };
  }
  if (!CONTROL_CODE_PATTERN.test(value)) {
    return {
      ok: false,
      why:
        'A control code starts with a letter and holds 2 to 24 characters: capital letters, digits, ' +
        'hyphens and underscores. It is shown on every claim row, so it may not carry spaces.',
    };
  }
  return { ok: true, value };
}

/**
 * A Jira label. Lowercase, no spaces: Jira lowercases labels and splits on spaces, so
 * "Ctrl AC 13" would silently become three labels and match nothing.
 */
export function validateJiraLabel(raw: unknown): Valid<string> {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value.length === 0) {
    return { ok: false, why: 'A Jira label is required: it is how a work item becomes evidence for this control.' };
  }
  if (!JIRA_LABEL_PATTERN.test(value)) {
    return {
      ok: false,
      why:
        'A Jira label starts with a letter and holds 2 to 40 characters: lowercase letters, digits, ' +
        'hyphens and underscores. Jira splits a label on spaces, so a label with a space would never match.',
    };
  }
  return { ok: true, value };
}

/** A freshness window in days: a positive whole number, at most ten years. */
export function validateMaxAgeDays(raw: unknown, fallback = 90): Valid<number> {
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim().length > 0
        ? Number.parseInt(raw.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(value)) {
    // The shipped programme's default window, when a caller says nothing at all.
    return fallback > 0 ? { ok: true, value: fallback } : { ok: false, why: 'A freshness window is required.' };
  }
  const days = Math.trunc(value);
  if (days < 1 || days > 3650) {
    return { ok: false, why: `A freshness window is a whole number of days between 1 and 3650; ${days} is outside that.` };
  }
  return { ok: true, value: days };
}

/** A single line of text with a maximum length, trimmed. Empty becomes null. */
export function validateText(raw: unknown, maxLength: number): Valid<string | null> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, why: 'That field holds text; the value given is not text.' };
  }
  const value = raw.replace(/\s+/g, ' ').trim();
  if (value.length === 0) {
    return { ok: true, value: null };
  }
  if (value.length > maxLength) {
    return { ok: false, why: `That field is at most ${maxLength} characters; it is ${value.length}.` };
  }
  return { ok: true, value };
}
