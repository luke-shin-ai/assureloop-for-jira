/**
 * Custom controls: a programme that is not only the twelve we shipped.
 *
 * The shipped programme answers DORA and SOX change management. A team with a control
 * of its own (a retention rule, a vendor onboarding step) had no way to put it into the
 * app except by editing the seed and redeploying, which is not something an auditor can
 * ask for. This module is the write path behind the Control Room's small form and its
 * JSON import.
 *
 * Three rules, and they are the same three the rest of the app keeps:
 *
 *   1. Refuse rather than rewrite. A code, a label, a window or a project key that does
 *      not match its rule is refused with the reason; nothing is silently corrected,
 *      and a key that could change a JQL query never reaches one.
 *   2. One claim per save. A second save of the same control and evidence type updates
 *      that claim; it does not add a second row for the scanner to judge twice.
 *   3. The rule is written down, not implied. What the claim requires (a done status, an
 *      independent approver, every item) is stored in the same rule_json the shipped
 *      programme uses, so a custom control is judged by the same engine and shows the
 *      same kind of row on the pack.
 */

import { DEFAULT_APPROVAL_PATTERN } from '../engine/gate';
import {
  validateControlCode,
  validateJiraLabel,
  validateMaxAgeDays,
  validateProjectKey,
  validateText,
} from '../engine/input';
import {
  getControlByCode,
  listRequirements,
  parseRule,
  upsertControl,
  upsertRequirement,
  type ControlCadence,
  type EvidenceType,
  type RequirementRule,
  type RiskTier,
} from '../schema/sql';

/** The evidence types a person may choose. Each one is judged by a reader that exists. */
export const CUSTOM_EVIDENCE_TYPES: readonly EvidenceType[] = [
  'jira_work_item',
  'approval_comment',
  'policy_page',
  'test_record',
  'pull_request',
  'deployment',
  'approval_independence',
];

/** What each type claims, in the words the Control Room uses. */
export const EVIDENCE_TYPE_LABEL: Readonly<Record<EvidenceType, string>> = {
  jira_work_item: 'Completed change record',
  approval_comment: 'Independent approval',
  policy_page: 'Governing policy',
  test_record: 'Test or attestation record',
  pull_request: 'Linked pull request',
  deployment: 'Deployment record',
  approval_independence: 'Approval accountability',
};

export interface CustomControlInput {
  code?: unknown;
  name?: unknown;
  evidenceType?: unknown;
  maxAgeDays?: unknown;
  everyItem?: unknown;
  minCount?: unknown;
  jiraLabel?: unknown;
  regulationRef?: unknown;
  expectation?: unknown;
  spaceKey?: unknown;
  pageTitlePrefix?: unknown;
  projectKey?: unknown;
  cadence?: unknown;
  riskTier?: unknown;
}

export interface CustomControlResult {
  saved: boolean;
  code: string | null;
  /** True when this save added the control; false when it updated one already there. */
  created: boolean;
  evidenceType: EvidenceType | null;
  jiraLabel: string | null;
  jiraProjectKey: string | null;
  maxAgeDays: number | null;
  everyItem: boolean;
  controlId: string | null;
  requirementId: string | null;
  why: string | null;
}

function refused(why: string, code: string | null = null): CustomControlResult {
  return {
    saved: false,
    code,
    created: false,
    evidenceType: null,
    jiraLabel: null,
    jiraProjectKey: null,
    maxAgeDays: null,
    everyItem: false,
    controlId: null,
    requirementId: null,
    why,
  };
}

function truthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 'on' || value === 1;
}

function evidenceTypeOf(value: unknown): EvidenceType | null {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (CUSTOM_EVIDENCE_TYPES as readonly string[]).includes(text) ? (text as EvidenceType) : null;
}

/**
 * The rule a saved claim is judged by.
 *
 * `everyItem` is what the form says and nothing else: a control whose sentence is "this
 * quarter has a retention decision" is existential, and the person adding it chooses.
 * The rule records the choice, so the scanner and the panel read the same instruction
 * the person wrote.
 */
function ruleFor(
  evidenceType: EvidenceType,
  options: {
    everyItem: boolean;
    expectation: string;
    spaceKey: string | null;
    pageTitlePrefix: string | null;
  },
): RequirementRule {
  const rule: RequirementRule = { everyItem: options.everyItem, expectation: options.expectation };
  switch (evidenceType) {
    case 'jira_work_item':
      return { ...rule, requiresDoneStatus: true };
    case 'approval_comment':
    case 'approval_independence':
      return {
        ...rule,
        approvalPattern: DEFAULT_APPROVAL_PATTERN,
        requiresIndependentApprover: true,
        ...(evidenceType === 'approval_independence' ? { accountability: 'page_owner_team' as const } : {}),
        ...(options.pageTitlePrefix ? { pageTitlePrefix: options.pageTitlePrefix } : {}),
        ...(options.spaceKey ? { spaceKey: options.spaceKey } : {}),
      };
    case 'policy_page':
      return {
        ...rule,
        ...(options.pageTitlePrefix ? { pageTitlePrefix: options.pageTitlePrefix } : {}),
        ...(options.spaceKey ? { spaceKey: options.spaceKey } : {}),
      };
    default:
      return rule;
  }
}

/**
 * Save one custom control and one claim.
 *
 * `projectKeyFallback` is the site's binding: a custom control that names no project is
 * judged in the project the programme already runs in, which is what the person adding
 * it means. Validating it is still required, because it becomes part of a JQL string.
 */
export async function saveCustomControl(
  input: CustomControlInput,
  options: { projectKeyFallback?: string | null } = {},
): Promise<CustomControlResult> {
  const code = validateControlCode(input.code);
  if (!code.ok) {
    return refused(code.why);
  }
  const name = validateText(input.name, 200);
  if (!name.ok) {
    return refused(name.why, code.value);
  }
  if (!name.value) {
    return refused('A control needs a name: it is the sentence the claim reads on every row.', code.value);
  }
  const evidenceType = evidenceTypeOf(input.evidenceType);
  if (!evidenceType) {
    return refused(
      `Choose one evidence type: ${CUSTOM_EVIDENCE_TYPES.join(', ')}.`,
      code.value,
    );
  }
  const maxAgeDays = validateMaxAgeDays(input.maxAgeDays, 90);
  if (!maxAgeDays.ok) {
    return refused(maxAgeDays.why, code.value);
  }
  const label = validateJiraLabel(
    input.jiraLabel === undefined || input.jiraLabel === null || input.jiraLabel === ''
      ? `ctrl-${code.value.toLowerCase()}`
      : input.jiraLabel,
  );
  if (!label.ok) {
    return refused(label.why, code.value);
  }
  const projectKey = validateProjectKey(
    input.projectKey ?? options.projectKeyFallback ?? '',
  );
  if (!projectKey.ok) {
    return refused(
      `${projectKey.why} Bind the programme to a project first, or name one in the form.`,
      code.value,
    );
  }
  const regulationRef = validateText(input.regulationRef, 120);
  if (!regulationRef.ok) {
    return refused(regulationRef.why, code.value);
  }
  const expectation = validateText(input.expectation, 240);
  if (!expectation.ok) {
    return refused(expectation.why, code.value);
  }
  const pageTitlePrefix = validateText(input.pageTitlePrefix, 200);
  if (!pageTitlePrefix.ok) {
    return refused(pageTitlePrefix.why, code.value);
  }
  const everyItem = truthy(input.everyItem);
  const minRaw = typeof input.minCount === 'number' ? input.minCount : Number.parseInt(String(input.minCount ?? '1'), 10);
  const minCount = Number.isFinite(minRaw) && minRaw >= 1 ? Math.trunc(minRaw) : 1;

  const existing = await getControlByCode(code.value);
  const cadence = typeof input.cadence === 'string' ? input.cadence.trim().toUpperCase() : '';
  const riskTier = typeof input.riskTier === 'string' ? input.riskTier.trim().toUpperCase() : '';
  const controlId = await upsertControl({
    code: code.value,
    name: name.value,
    regulationRef: regulationRef.value ?? '',
    cadence: (['CONTINUOUS', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL'] as const).includes(
      cadence as ControlCadence,
    )
      ? (cadence as ControlCadence)
      : 'QUARTERLY',
    riskTier: (['HIGH', 'MEDIUM', 'LOW'] as const).includes(riskTier as RiskTier)
      ? (riskTier as RiskTier)
      : 'MEDIUM',
    jiraLabel: label.value,
    jiraProjectKey: projectKey.value,
    ownerAccountId: null,
    ownerDisplayName: null,
    status: 'ACTIVE',
  });
  const requirementId = await upsertRequirement(controlId, {
    evidenceType,
    maxAgeDays: maxAgeDays.value,
    minCount,
    rule: ruleFor(evidenceType, {
      everyItem,
      expectation:
        expectation.value ??
        `${name.value} — ${EVIDENCE_TYPE_LABEL[evidenceType]} must be present and within the freshness window.`,
      spaceKey: typeof input.spaceKey === 'string' && input.spaceKey.trim().length > 0 ? input.spaceKey.trim() : null,
      pageTitlePrefix: pageTitlePrefix.value,
    }),
  });

  // A control that was already there keeps the claims it had; the result says which of
  // the two things happened, so the screen can say "added" or "updated" truthfully.
  const requirementCount = (await listRequirements(controlId).catch(() => [])).length;
  return {
    saved: true,
    code: code.value,
    created: existing === null,
    evidenceType,
    jiraLabel: label.value,
    jiraProjectKey: projectKey.value,
    maxAgeDays: maxAgeDays.value,
    everyItem,
    controlId,
    requirementId,
    why:
      existing === null
        ? null
        : `Updated ${code.value}. It now has ${requirementCount} claim(s).`,
  };
}

export interface ImportReport {
  imported: number;
  failed: number;
  results: Array<{
    code: string | null;
    saved: boolean;
    created: boolean;
    evidenceType: EvidenceType | null;
    why: string | null;
  }>;
  /** Set when the pasted text is not a list of controls at all. */
  why: string | null;
}

/**
 * The JSON import: the same validation as the form, item by item.
 *
 * One bad entry does not void the good ones, and the report names each: "imported 2,
 * refused 1" with the sentence for the refused row is more useful than an all-or-nothing
 * answer, and it never claims that a refused row was written.
 */
export async function importCustomControls(
  raw: unknown,
  options: { projectKeyFallback?: string | null } = {},
): Promise<ImportReport> {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      return {
        imported: 0,
        failed: 0,
        results: [],
        why: `That is not JSON (${cause instanceof Error ? cause.message : String(cause)}). Paste an array of controls, or an object with a "controls" array.`,
      };
    }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { controls?: unknown } | null)?.controls)
      ? ((parsed as { controls: unknown[] }).controls)
      : null;
  if (!list) {
    return {
      imported: 0,
      failed: 0,
      results: [],
      why: 'Paste a JSON array of controls, or an object with a "controls" array.',
    };
  }
  if (list.length === 0) {
    return { imported: 0, failed: 0, results: [], why: 'The list is empty: there is nothing to import.' };
  }
  if (list.length > 50) {
    return {
      imported: 0,
      failed: 0,
      results: [],
      why: `That list holds ${list.length} controls; an import is limited to 50 at a time.`,
    };
  }
  const results: ImportReport['results'] = [];
  for (const entry of list) {
    const record = typeof entry === 'object' && entry !== null ? (entry as CustomControlInput) : {};
    const result = await saveCustomControl(record, options);
    results.push({
      code: result.code,
      saved: result.saved,
      created: result.created,
      evidenceType: result.evidenceType,
      why: result.why,
    });
  }
  const imported = results.filter((row) => row.saved).length;
  return { imported, failed: results.length - imported, results, why: null };
}

/** What the Control Room lists: the controls this site added, with their claims. */
export async function describeControl(code: string): Promise<{
  code: string;
  claims: Array<{ evidenceType: string; maxAgeDays: number; everyItem: boolean; expectation: string | null }>;
} | null> {
  const control = await getControlByCode(code);
  if (!control) {
    return null;
  }
  const requirements = await listRequirements(control.id).catch(() => []);
  return {
    code: control.code,
    claims: requirements.map((row) => {
      const rule = parseRule(row.rule_json);
      return {
        evidenceType: row.evidence_type,
        maxAgeDays: row.max_age_days,
        everyItem: rule.everyItem === true,
        expectation: rule.expectation ?? null,
      };
    }),
  };
}
