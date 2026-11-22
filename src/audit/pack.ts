/**
 * The audit pack: the last scan turned into something an auditor can file.
 *
 * The Control Room and the issue panel answer "what is true right now". An audit
 * workpaper needs a different thing: a table of claims with the evidence object,
 * when it was observed, what state it was in — plus a way to prove that the table
 * handed over has not been edited since.
 *
 * Three decisions carry the honesty of this module:
 *
 *   1. `as of` is the scan's finish time, not the time the page was opened. The page
 *      is a view that re-renders from the stored scan, so it is **reproducible, not
 *      frozen**: the same scan rebuilds the same rows and therefore the same
 *      fingerprint, and the fingerprint is what proves the table handed over was not
 *      edited. A later scan changes the numbers, which is why the pack carries its
 *      scan id and as-of stamp.
 *   2. The fingerprint is SHA-256 over the claim rows, computed here with Node's
 *      crypto. Rebuilding the pack from the same scan yields the same string, so a
 *      reviewer can check it. Nothing leaves Atlassian.
 *   3. The memo text is produced deterministically from the same rows, so the
 *      issue panel, the Confluence macro and the Control Room can all say the same
 *      sentence — and no model writes it.
 */

import { createHash } from 'node:crypto';

import {
  ensureSchema,
  getScan,
  latestScan,
  listAllEvidenceLinks,
  listClaimExceptions,
  listControls,
  listFindingsByScan,
  listRemediations,
  listRequirementsForControls,
  previousScan,
  parseCounts,
  parseRule,
  type ClaimExceptionRow,
  type ControlRow,
  type FindingRow,
  type RemediationRow,
  type RequirementRow,
  type StateCounts,
} from '../schema/sql';

/**
 * What an audit pack from this app does and does not guarantee.
 *
 * Stated on every surface and in the memo itself. An evidence pack that silently
 * implies "nothing outside the app happened" is the one an auditor rejects once and
 * never trusts again; naming the boundary is what makes the rest of it usable.
 */
export const AUDIT_GUARANTEES: { does: string[]; doesNot: string[] } = {
  does: [
    'Deterministic observation inside the app’s scope: every claim is judged by fixed rules over Teamwork Graph and Atlassian REST reads, and the same inputs produce the same verdict.',
    'Hash equality: the fingerprint is SHA-256 over every field the pack shows — claim, state, reason, evidence label and link, observation time, age and window, missing scopes, remediation and any recorded exception — so anyone holding the pack can recompute it (Verify fingerprint) and show the table was not edited after it was filed.',
    'Named blind spots: a read the app could not make is reported NOT_VISIBLE or INCOMPLETE with the permission that would fix it, never as missing evidence.',
  ],
  doesNot: [
    'Changes made outside this app: a page edited, an approval given verbally, a deployment recorded in another system, or a record deleted by hand is not observed and cannot be asserted.',
    'Systems the app does not watch: evidence types with no connector on this site are reported as unsupported, not as gaps, and nothing is claimed about them.',
    'Whether an exception is substantively right: a recorded exception is disclosed with its author, expiry and compensating control, but a person and the auditor decide whether it is acceptable.',
  ],
};

/** Stable identity of a claim across scans: control code + evidence type. */
export function claimKeyFor(controlCode: string, evidenceType: string): string {
  return `${controlCode}:${evidenceType}`;
}

/** The claim name a human reads, per evidence type. Shared with the issue panel. */
export const CLAIM_LABEL: Readonly<Record<string, string>> = {
  jira_work_item: 'Completed change record',
  approval_comment: 'Independent approval',
  policy_page: 'Governing policy',
  test_record: 'Test or attestation record',
  pull_request: 'Linked pull request',
  deployment: 'Deployment record',
  approval_independence: 'Approval accountability',
};

export interface AuditClaim {
  controlCode: string;
  controlName: string;
  regulationRef: string;
  claim: string;
  evidenceType: string;
  state: string;
  reason: string;
  /** Evidence object, human name (page title or work item key). */
  evidenceLabel: string | null;
  evidenceAri: string | null;
  /** Absolute link, when the site URL is known. */
  evidenceUrl: string | null;
  /** When the evidence object itself was last touched (page version, issue update). */
  observedAt: string | null;
  /** When the scan judged it. */
  judgedAt: string | null;
  ageDays: number | null;
  maxAgeDays: number | null;
  /** Open remediation issue raised for this finding, if any. */
  remediation: { issueKey: string; dueDate: string; status: string } | null;
  missingScopes: string[];
  /** Stable claim identity (control code + evidence type), the exception key. */
  claimKey: string;
  /**
   * A recorded exception for this claim. An exception never changes a verdict — the
   * state stays what was measured — it explains why the gap is being carried, and
   * it is disclosed with the person who recorded it and the date it lapses.
   */
  exception: {
    reason: string;
    expiresAt: string;
    compensatingControl: string | null;
    recordedBy: string | null;
    recordedAt: string;
    active: boolean;
  } | null;
}

export interface AuditPack {
  title: string;
  asOf: string | null;
  scanId: string | null;
  trigger: string | null;
  counts: StateCounts;
  claims: AuditClaim[];
  fingerprint: string;
  fingerprintBasis: string;
  memo: string;
  notes: string[];
  /** The boundary of the assurance, stated on every surface and in the memo. */
  guarantees: { does: string[]; doesNot: string[] };
  /** Gaps carried with a recorded, unexpired exception. */
  explainedGaps: number;
  /** Gaps with no reason on record: the number a closing meeting asks about. */
  unexplainedGaps: number;
  /** What the previous completed scan counted, for the before/after line. */
  previousCounts: StateCounts | null;
  delta: StateCounts | null;
  signoff: { preparedBy: string | null; reviewedBy: string | null; declaration: string };
}

export interface AuditMeta {
  title: string;
  asOf: string | null;
  scanId: string | null;
  trigger?: string | null;
  counts?: StateCounts;
  unexplainedGaps?: number;
  explainedGaps?: number;
}

/** SHA-256 hex. Exported so the tests can pin the exact function used in the pack. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Fingerprint of a claim table.
 *
 * The seed is a normalised, one-JSON-object-per-claim string covering **everything the
 * pack shows**: the claim identity and label, the state and the sentence explaining it,
 * the evidence object (label, ARI and link), when it was observed and judged, the age
 * and the freshness window, the scopes an admin would have to grant, the remediation
 * issue raised for it, and a recorded exception with its reason, expiry, compensating
 * control and author.
 *
 * v6.35 adds `regulationRef`, which the macro shows per row and the hash did not
 * cover (A4).
 *
 * The first version hashed only control, claim, state, ARI, observed time, age and
 * reason, so editing an evidence label, a link, an exception's reason or its expiry
 * left the fingerprint matching — and "this table has not changed since it was filed"
 * was a claim a reviewer could refute in one click. Fields derived from the clock
 * (`exception.active`, "expired" wording) are deliberately excluded: they describe when
 * the pack is read, not what was filed.
 *
 * Rows are sorted by claim identity, so the fingerprint does not depend on the order
 * the rows happen to arrive in. The displayed value is the SHA-256 digest cut to 128
 * bits (32 hex) and labelled as such: it used to be cut to 64 bits while the text said
 * "SHA-256", which claims a collision resistance the printed value does not have.
 * `sha256Hex` still returns the full 64-hex digest for anyone who wants to compare one.
 */
export const FINGERPRINT_FIELDS: readonly string[] = [
  'controlCode',
  'controlName',
  'regulationRef',
  'claimKey',
  'claim',
  'evidenceType',
  'state',
  'reason',
  'evidenceLabel',
  'evidenceAri',
  'evidenceUrl',
  'observedAt',
  'judgedAt',
  'ageDays',
  'maxAgeDays',
  'missingScopes',
  'remediation',
  'exception',
];

/** One claim as the exact object the fingerprint hashes. */
export function fingerprintRow(claim: AuditClaim): Record<string, unknown> {
  return {
    controlCode: claim.controlCode,
    controlName: claim.controlName ?? null,
    // v6.35 (A4): the macro shows `regulationRef` on every claim row, so the
    // fingerprint has to cover it — a pack whose displayed text can change while the
    // hash still matches is not a pack.
    regulationRef: claim.regulationRef ?? null,
    claimKey: claim.claimKey ?? claimKeyFor(claim.controlCode, claim.evidenceType ?? 'unknown'),
    claim: claim.claim,
    evidenceType: claim.evidenceType ?? null,
    state: claim.state,
    reason: claim.reason,
    evidenceLabel: claim.evidenceLabel ?? null,
    evidenceAri: claim.evidenceAri ?? null,
    evidenceUrl: claim.evidenceUrl ?? null,
    observedAt: claim.observedAt ?? null,
    judgedAt: claim.judgedAt ?? null,
    ageDays: claim.ageDays ?? null,
    maxAgeDays: claim.maxAgeDays ?? null,
    missingScopes: [...(claim.missingScopes ?? [])].sort(),
    remediation: claim.remediation
      ? {
          issueKey: claim.remediation.issueKey,
          dueDate: claim.remediation.dueDate,
          status: claim.remediation.status,
        }
      : null,
    exception: claim.exception
      ? {
          reason: claim.exception.reason,
          expiresAt: claim.exception.expiresAt,
          compensatingControl: claim.exception.compensatingControl ?? null,
          recordedBy: claim.exception.recordedBy ?? null,
          recordedAt: claim.exception.recordedAt ?? null,
        }
      : null,
  };
}

export function fingerprintOf(claims: readonly AuditClaim[], scanId: string | null): string {
  const rows = claims
    .map(fingerprintRow)
    .sort((a, b) =>
      `${a.controlCode}~${a.claimKey}~${a.claim}~${a.evidenceAri}`.localeCompare(
        `${b.controlCode}~${b.claimKey}~${b.claim}~${b.evidenceAri}`,
      ),
    )
    .map((row) => JSON.stringify(row));
  const seed = [`scan=${scanId ?? 'none'}`, ...rows].join('\n');
  return sha256Hex(seed).slice(0, FINGERPRINT_HEX_LENGTH);
}

/**
 * How much of the SHA-256 digest is printed: 32 hex = 128 bits.
 *
 * 16 hex is 64 bits, which is 2^32 work to collide - fine for a typo check, not for
 * "a reviewer cannot alter this table". The full digest stays available through
 * `sha256Hex`; the printed value says what it is.
 */
export const FINGERPRINT_HEX_LENGTH = 32;

function countLine(counts: StateCounts): string {
  return (
    `${counts.VERIFIED} verified, ${counts.STALE} stale, ${counts.MISSING} missing, ` +
    `${counts.NOT_VISIBLE} not visible, ${counts.INCOMPLETE} not checked`
  );
}

/** One claim as a single deterministic line: what gets pasted into a ticket. */
export function claimMemoLine(claim: AuditClaim): string {
  const parts = [
    claim.controlCode,
    claim.claim,
    claim.state,
    claim.evidenceLabel ?? claim.evidenceAri ?? 'no evidence object',
  ];
  if (claim.observedAt) {
    parts.push(`observed ${claim.observedAt}`);
  }
  if (claim.ageDays !== null) {
    parts.push(
      `age ${claim.ageDays}d${claim.maxAgeDays === null ? '' : ` / window ${claim.maxAgeDays}d`}`,
    );
  }
  if (claim.evidenceUrl) {
    parts.push(claim.evidenceUrl);
  }
  if (claim.remediation) {
    parts.push(`remediation ${claim.remediation.issueKey} due ${claim.remediation.dueDate}`);
  }
  if (claim.exception) {
    parts.push(
      `exception${claim.exception.active ? '' : ' (expired)'} ${claim.exception.reason} — until ${claim.exception.expiresAt}` +
        (claim.exception.compensatingControl ? `, compensating ${claim.exception.compensatingControl}` : ''),
    );
  }
  parts.push(claim.reason);
  return parts.join(' | ');
}

/**
 * The memo. Deterministic: same claims and meta, same text — which is the point,
 * because it is what proves the narrative was not written by a model.
 */
export function memoForClaims(claims: readonly AuditClaim[], meta: AuditMeta): string {
  const fingerprint = fingerprintOf(claims, meta.scanId);
  const header = [
    `AssureLoop audit pack — ${meta.title}`,
    `As of ${meta.asOf ?? 'no completed scan'}` +
      (meta.scanId ? ` · scan ${meta.scanId}` : '') +
      (meta.trigger ? ` · trigger ${meta.trigger.toLowerCase()}` : ''),
    meta.counts
      ? `${claims.length} claim(s): ${countLine(meta.counts)}`
      : `${claims.length} claim(s)`,
    `Fingerprint ${fingerprint} — SHA-256 over the ${claims.length} claim row(s) below ` +
      `(claim, state, reason, evidence label and link, observation time, age and window, missing scopes, remediation, exception), digest truncated to 128 bits (32 hex) for display`,
    '',
  ];
  const body = claims.map((claim) => claimMemoLine(claim));
  const guaranteeBlock = [
    '',
    'What this pack guarantees:',
    ...AUDIT_GUARANTEES.does.map((line) => `  - ${line}`),
    '',
    'What this pack does NOT guarantee:',
    ...AUDIT_GUARANTEES.doesNot.map((line) => `  - ${line}`),
    '',
    meta.unexplainedGaps === undefined
      ? ''
      : `Unexplained gaps: ${meta.unexplainedGaps}` +
        (meta.explainedGaps ? ` (${meta.explainedGaps} further gap(s) carry a recorded exception)` : '') +
        ' — a gap counts as unexplained when no reason, owner and expiry are on record for it.',
  ];
  const footer = [
    '',
    'Every row above was produced by the deterministic rule engine from the Teamwork Graph and',
    'Atlassian REST at scan time. No generative model decided a state or wrote this text.',
    'Prepared by: ______________   Reviewed by: ______________',
  ];
  return [...header, ...body, ...guaranteeBlock, ...footer].join('\n');
}

/**
 * Re-verify a filed fingerprint.
 *
 * Rebuilding the claims from the same scan and hashing them with the same function
 * must give back the string that was handed over. `match` is what the button shows: a
 * match means the table still reproduces exactly; a mismatch means the rows behind it
 * changed (or the pack came from a different scan) and the paper must be re-issued.
 */
export function verifyFingerprintOf(input: {
  claims: readonly AuditClaim[];
  scanId: string | null;
  expected: string;
}): { match: boolean; expected: string; computed: string; claims: number } {
  const computed = fingerprintOf(input.claims, input.scanId);
  return {
    match: computed === input.expected.trim().toLowerCase(),
    expected: input.expected.trim().toLowerCase(),
    computed,
    claims: input.claims.length,
  };
}

/** ARI -> an absolute link, using only what the ARI and the label already say. */
export function evidenceUrlFor(
  siteUrl: string | null | undefined,
  ari: string | null,
  label: string | null,
): string | null {
  if (!siteUrl || !ari) {
    return null;
  }
  const base = siteUrl.replace(/\/$/, '');
  const page = /:page\/(\d+)/.exec(ari);
  if (page?.[1]) {
    return `${base}/wiki/pages/viewpage.action?pageId=${page[1]}`;
  }
  const issue = /:issue\/(\d+)/.exec(ari);
  if (issue?.[1]) {
    // Jira's browse route takes the issue *key*, not its numeric id. Without a key
    // there is no honest link, and a link that 404s is worse than no link.
    return label && /^[A-Z][A-Z0-9_]*-\d+$/.test(label) ? `${base}/browse/${label}` : null;
  }
  const space = /:space\/(\d+)/.exec(ari);
  if (space?.[1]) {
    return `${base}/wiki/spaces/${space[1]}`;
  }
  return null;
}

function parseScopes(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Build the pack from the latest completed scan.
 *
 * Missing evidence is never invented: a finding with no evidence ARI gets no link,
 * and a site with no completed scan gets a pack that says so.
 */
export async function buildAuditPack(options: {
  controlCode?: string;
  siteUrl?: string | null;
  title?: string;
  /** Build the pack for one scan instead of the latest (used by Verify fingerprint). */
  scanId?: string;
  now?: Date;
} = {}): Promise<AuditPack> {
  await ensureSchema();
  const scan = options.scanId ? await getScan(options.scanId) : await latestScan();
  const controls = await listControls();
  const byControl = new Map<string, ControlRow>(controls.map((row) => [row.id, row]));
  const requirements = await listRequirementsForControls(controls.map((row) => row.id));
  const byRequirement = new Map<string, RequirementRow>(
    requirements.map((row) => [row.id, row]),
  );
  const findings = scan ? await listFindingsByScan(scan.id) : [];
  const remediations = await listRemediations();
  const remediationByFinding = new Map<string, RemediationRow>(
    remediations.map((row) => [row.finding_id, row]),
  );
  const exceptions = await listClaimExceptions().catch(() => [] as ClaimExceptionRow[]);
  const exceptionByKey = new Map<string, ClaimExceptionRow>(
    exceptions.map((row) => [row.claim_key, row]),
  );
  const now = options.now ?? new Date();
  // The finding stores the evidence ARI; the registry's links know the human name
  // (a page title, a work item key). Without this the pack would show a numeric id
  // and, for an issue, build a browse link that does not resolve.
  const labelByAri = new Map<string, string>();
  try {
    for (const link of await listAllEvidenceLinks()) {
      if (link.label && !labelByAri.has(link.evidence_ari)) {
        labelByAri.set(link.evidence_ari, link.label);
      }
    }
  } catch {
    // The pack still works without labels; it just shows ARI tails.
  }

  const notes: string[] = [];
  if (!scan) {
    notes.push('No completed scan on this installation yet — there is nothing to file. Run a scan first.');
  }

  const claims: AuditClaim[] = [];
  for (const finding of findings) {
    const control = byControl.get(finding.control_id);
    if (!control) {
      continue;
    }
    if (options.controlCode && control.code !== options.controlCode) {
      continue;
    }
    const requirement = byRequirement.get(finding.requirement_id);
    const evidenceArI = finding.evidence_ari;
    const evidenceLabel = labelFor(finding, requirement, labelByAri);
    const remediation = remediationByFinding.get(finding.id);
    const evidenceType = findingRequirementType(finding, requirement);
    const claimKey = claimKeyFor(control.code, evidenceType);
    const exceptionRow = exceptionByKey.get(claimKey);
    claims.push({
      controlCode: control.code,
      controlName: control.name,
      regulationRef: control.regulation_ref,
      claim: CLAIM_LABEL[evidenceType] ?? 'Claim',
      evidenceType,
      state: finding.state,
      reason: finding.reason,
      evidenceLabel,
      evidenceAri: evidenceArI,
      evidenceUrl: evidenceUrlFor(options.siteUrl, evidenceArI, evidenceLabel),
      observedAt: finding.evidence_observed_at ?? null,
      judgedAt: finding.created_at,
      ageDays: finding.age_days,
      maxAgeDays: requirement?.max_age_days ?? null,
      remediation: remediation
        ? { issueKey: remediation.jira_issue_key, dueDate: remediation.due_date, status: remediation.status }
        : null,
      missingScopes: parseScopes(finding.missing_scopes),
      claimKey,
      exception: exceptionRow
        ? {
            reason: exceptionRow.exception_reason,
            expiresAt: exceptionRow.expires_at,
            compensatingControl: exceptionRow.compensating_control,
            recordedBy: exceptionRow.recorded_by,
            recordedAt: exceptionRow.recorded_at,
            active: exceptionIsActive(exceptionRow, now),
          }
        : null,
    });
  }
  claims.sort(
    (a, b) => a.controlCode.localeCompare(b.controlCode) || a.claim.localeCompare(b.claim),
  );

  const counts = scan ? parseCounts(scan.counts_json) : zeroCounts();
  const title = options.title ?? (options.controlCode ? `${options.controlCode}` : 'programme wide');
  const asOf = scan?.finished_at ?? null;
  const fingerprintBasis = `${claims.length} claim row(s) · ${FINGERPRINT_FIELDS.length} hashed fields · scan ${scan?.id ?? 'none'}`;
  const previous = options.scanId ? null : await previousScan();
  const previousCounts = previous ? parseCounts(previous.counts_json) : null;
  const { explainedGaps, unexplainedGaps } = countGaps(claims, now);
  const meta: AuditMeta = {
    title,
    asOf,
    scanId: scan?.id ?? null,
    trigger: scan?.trigger_source ?? null,
    counts,
    explainedGaps,
    unexplainedGaps,
  };

  return {
    title,
    asOf,
    scanId: scan?.id ?? null,
    trigger: scan?.trigger_source ?? null,
    counts,
    claims,
    fingerprint: fingerprintOf(claims, scan?.id ?? null),
    fingerprintBasis,
    memo: memoForClaims(claims, meta),
    notes,
    guarantees: AUDIT_GUARANTEES,
    explainedGaps,
    unexplainedGaps,
    previousCounts,
    delta: previousCounts ? subtract(previousCounts, counts) : null,
    signoff: {
      preparedBy: null,
      reviewedBy: null,
      declaration:
        'The app prepares the evidence table; a person signs it. Signing is deliberately not automated.',
    },
  };
}

/** A gap is a claim whose state is STALE or MISSING. */
export function isGap(claim: Pick<AuditClaim, 'state'>): boolean {
  return claim.state === 'STALE' || claim.state === 'MISSING';
}

/** An exception is live only while it has a reason and has not lapsed. */
export function exceptionIsActive(
  exception: { exception_reason?: string | null; reason?: string | null; expires_at?: string | null; expiresAt?: string | null },
  now: Date,
): boolean {
  const reason = (exception.exception_reason ?? exception.reason ?? '').trim();
  const expires = exception.expires_at ?? exception.expiresAt ?? '';
  if (reason.length === 0 || expires.length < 10) {
    return false;
  }
  const until = Date.parse(`${expires.slice(0, 10)}T23:59:59Z`);
  return Number.isFinite(until) ? until >= now.getTime() : false;
}

/**
 * "Unexplained gaps: N" — the number a closing meeting asks about.
 *
 * A gap with a recorded, unexpired exception is explained (and disclosed row by
 * row); a gap with no reason on record is what nobody can account for.
 */
export function countGaps(
  claims: readonly Pick<AuditClaim, 'state' | 'exception'>[],
  now: Date,
): { gaps: number; explainedGaps: number; unexplainedGaps: number } {
  let gaps = 0;
  let explainedGaps = 0;
  for (const claim of claims) {
    if (!isGap(claim)) {
      continue;
    }
    gaps += 1;
    if (claim.exception && claim.exception.active) {
      explainedGaps += 1;
    }
  }
  return { gaps, explainedGaps, unexplainedGaps: gaps - explainedGaps };
}

function subtract(previous: StateCounts, current: StateCounts): StateCounts {
  return {
    VERIFIED: current.VERIFIED - previous.VERIFIED,
    STALE: current.STALE - previous.STALE,
    MISSING: current.MISSING - previous.MISSING,
    NOT_VISIBLE: current.NOT_VISIBLE - previous.NOT_VISIBLE,
    INCOMPLETE: current.INCOMPLETE - previous.INCOMPLETE,
  };
}

function zeroCounts(): StateCounts {
  return { VERIFIED: 0, STALE: 0, MISSING: 0, NOT_VISIBLE: 0, INCOMPLETE: 0 };
}

/**
 * Which claim this finding is. The finding stores the requirement id, so the
 * evidence type comes from the requirement row; older rows without one fall back
 * to the colon-encoded programme id (`programme:AC-01:policy_page:0`).
 */
function findingRequirementType(finding: FindingRow, requirement: RequirementRow | undefined): string {
  if (requirement) {
    return requirement.evidence_type;
  }
  const parts = finding.requirement_id.split(':');
  return parts.length >= 3 ? (parts[2] ?? 'unknown') : 'unknown';
}

/**
 * The evidence object's human name. A finding stores the ARI, not the title, so
 * the name is recovered from the requirement rule (a page title prefix) or the ARI
 * tail. Nothing is invented: an unknown object shows its ARI tail.
 */
function labelFor(
  finding: FindingRow,
  requirement: RequirementRow | undefined,
  labels?: ReadonlyMap<string, string>,
): string | null {
  if (!finding.evidence_ari) {
    return null;
  }
  const linked = labels?.get(finding.evidence_ari);
  if (linked) {
    return linked;
  }
  const rule = requirement ? parseRule(requirement.rule_json) : {};
  if (rule.pageTitlePrefix) {
    return rule.pageTitlePrefix;
  }
  const tail = finding.evidence_ari.split('/').pop() ?? null;
  return tail;
}
