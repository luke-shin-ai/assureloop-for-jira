/**
 * Forge SQL schema + query helpers for AssureLoop.
 *
 * Storage model (see final-concept.md §4.6):
 *   controls              – the control registry (what must be proven)
 *   evidence_requirements – per control, what counts as evidence and how fresh
 *   evidence_links        – evidence objects (ARI) attached to a control
 *   scans                 – one row per scan run (history, delta, duration)
 *   findings              – one row per requirement per scan (the 4-state verdict)
 *   provenance            – the hop-by-hop chain behind every finding
 *   remediations          – the Jira issue created to close a gap
 *   app_config            – small key/value settings (scan principal, demo mode)
 *
 * Deliberate choices:
 *   * Timestamps are stored as ISO-8601 UTC strings (VARCHAR(32)) rather than
 *     DATETIME. Forge SQL is a hosted MySQL/TiDB flavour; strings keep every
 *     comparison in the app's own time zone logic and survive round-trips
 *     without driver-level conversion.
 *   * No foreign keys — Forge SQL does not support them (official limitation).
 *     Referential integrity is enforced by the insert helpers below.
 *   * Every DDL statement is idempotent (`CREATE TABLE IF NOT EXISTS`) and one
 *     statement per call, so `migrationRunner` retries are safe.
 */

import sql, { migrationRunner, type Result } from '@forge/sql';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskTier = 'HIGH' | 'MEDIUM' | 'LOW';
export type ControlCadence = 'CONTINUOUS' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type ControlStatus = 'ACTIVE' | 'DRAFT' | 'RETIRED';

export type EvidenceType =
  | 'jira_work_item'      // a work item must exist for each subject in the population
  | 'approval_comment'    // a comment matching an approval pattern must exist
  | 'policy_page'         // a governance page must be owned, linked and fresh
  | 'test_record'         // a test/attestation record plus its outcome
  | 'pull_request'        // an external PR linked to the work item (if connectors exist)
  | 'deployment'          // an external deployment linked to the work item
  /**
   * The approver must be accountable for the policy the change is governed by:
   * a member of the team that owns the policy page (or of a team accountable for
   * the space it lives in). Team membership is a Teamwork Graph fact — no Atlassian
   * REST API joins a Jira approver to a Confluence page's owning team — so this
   * claim has no REST fallback and is the app's proof that the graph decides a
   * verdict rather than decorating one.
   */
  | 'approval_independence';

export type EvidenceState = 'VERIFIED' | 'STALE' | 'MISSING' | 'NOT_VISIBLE' | 'INCOMPLETE';
export type ScanTrigger = 'MANUAL' | 'SCHEDULED' | 'ROVO_ACTION' | 'INSTALL';
export type ScanStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'DEFERRED';

export interface ControlRow {
  id: string;
  code: string;
  name: string;
  regulation_ref: string;
  cadence: ControlCadence;
  risk_tier: RiskTier;
  jira_label: string;
  jira_project_key: string;
  owner_account_id: string | null;
  owner_display_name: string | null;
  status: ControlStatus;
}

export interface RequirementRow {
  id: string;
  control_id: string;
  evidence_type: EvidenceType;
  max_age_days: number;
  min_count: number;
  rule_json: string;
}

/** Decoded form of requirement.rule_json. */
export interface RequirementRule {
  /** Only count work items whose status category is done. */
  requiresDoneStatus?: boolean;
  /** Regex (case-insensitive) an approval comment must match. */
  approvalPattern?: string;
  /** Comment must be authored by someone other than the assignee (segregation of duties). */
  requiresIndependentApprover?: boolean;
  /** Page title (or title prefix) that must exist and be fresh. */
  pageTitlePrefix?: string;
  /**
   * Confluence space key that should hold the policy page. `null` is a real value:
   * the programme is bound with "no space", and the claim then reports a setup gap
   * instead of looking for a page in a space that was deliberately not chosen.
   */
  spaceKey?: string | null;
  /** Free-text expectation shown in the UI when the requirement fails. */
  expectation?: string;
  /**
   * For `approval_independence`: how much of the graph the claim must read.
   * Kept explicit so the rule still describes itself when read from the database.
   */
  accountability?: 'page_owner_team';
  /**
   * A universal claim: every object in the population must carry a qualifying
   * object, not just one of them.
   *
   * The shipped rules ask for a claim of the shape "every production change carries
   * an independent approval" and were judged with `min_count: 1`, which made the
   * verdict true once a single change was approved. `everyItem: true` says what the
   * sentence says: the claim passes only when every object that was read qualified,
   * and only when every object in the population was read. Default off, because most
   * claims really are existential ("this control has a current policy") and turning a
   * one-page claim into a universal one would be just as wrong in the other direction.
   */
  everyItem?: boolean;
}

export interface EvidenceLinkRow {
  id: string;
  control_id: string;
  requirement_id: string;
  evidence_ari: string;
  evidence_kind: string;
  label: string | null;
  observed_at: string;
  active: number;
}

export interface ScanRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger_source: ScanTrigger;
  status: ScanStatus;
  principal_account_id: string | null;
  counts_json: string | null;
  duration_ms: number | null;
  notes: string | null;
}

export interface FindingRow {
  id: string;
  scan_id: string;
  control_id: string;
  requirement_id: string;
  state: EvidenceState;
  subject_ari: string | null;
  reason: string;
  evidence_ari: string | null;
  age_days: number | null;
  missing_scopes: string | null;
  query_key: string | null;
  row_count: number | null;
  latency_ms: number | null;
  /** When the evidence object was last touched; null for rows written before v017. */
  evidence_observed_at?: string | null;
  /** Deterministic notes about the read (persisted fallback, discovery mode). */
  notes?: string | null;
  created_at: string;
}

export interface ProvenanceRow {
  id: string;
  finding_id: string;
  hop: number;
  from_ari: string | null;
  relation: string;
  to_ari: string | null;
  observed_at: string;
}

export interface RemediationRow {
  id: string;
  finding_id: string;
  jira_issue_key: string;
  assignee_account_id: string | null;
  due_date: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  created_at: string;
}

export interface ClaimExceptionRow {
  id: string;
  control_id: string;
  /** control code + evidence type: stable across scans and re-seeds. */
  claim_key: string;
  evidence_type: string;
  exception_reason: string;
  /** yyyy-mm-dd; the exception lapses at the end of that day. */
  expires_at: string;
  compensating_control: string | null;
  recorded_by: string | null;
  recorded_at: string;
  active: number;
}

export interface StateCounts {
  VERIFIED: number;
  STALE: number;
  MISSING: number;
  NOT_VISIBLE: number;
  /** Checked but not concluded: throttle, timeout, index lag, backend failure. */
  INCOMPLETE: number;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

interface Migration {
  name: string;
  statement: string;
  /**
   * Set on `ALTER TABLE ... ADD COLUMN` migrations. MySQL has no `IF NOT EXISTS` for a
   * column, so the runner reads `information_schema` first and retries around the
   * duplicate-column error a concurrent first request produces.
   */
  addColumn?: { table: string; column: string };
}

export const MIGRATIONS: readonly Migration[] = [
  {
    name: 'v001_create_controls',
    statement: `
      CREATE TABLE IF NOT EXISTS controls (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        code VARCHAR(32) NOT NULL,
        name VARCHAR(255) NOT NULL,
        regulation_ref VARCHAR(255) NOT NULL DEFAULT '',
        cadence VARCHAR(16) NOT NULL DEFAULT 'QUARTERLY',
        risk_tier VARCHAR(8) NOT NULL DEFAULT 'MEDIUM',
        jira_label VARCHAR(128) NOT NULL,
        jira_project_key VARCHAR(32) NOT NULL,
        owner_account_id VARCHAR(128) NULL,
        owner_display_name VARCHAR(128) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
      )
    `,
  },
  {
    name: 'v002_index_controls_code',
    statement: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_controls_code ON controls (code)',
  },
  {
    name: 'v003_create_evidence_requirements',
    statement: `
      CREATE TABLE IF NOT EXISTS evidence_requirements (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        control_id VARCHAR(64) NOT NULL,
        evidence_type VARCHAR(32) NOT NULL,
        max_age_days INT NOT NULL DEFAULT 90,
        min_count INT NOT NULL DEFAULT 1,
        rule_json TEXT NOT NULL
      )
    `,
  },
  {
    name: 'v004_index_evidence_requirements_control',
    statement:
      'CREATE INDEX IF NOT EXISTS idx_req_control ON evidence_requirements (control_id)',
  },
  {
    name: 'v005_create_evidence_links',
    statement: `
      CREATE TABLE IF NOT EXISTS evidence_links (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        control_id VARCHAR(64) NOT NULL,
        requirement_id VARCHAR(64) NOT NULL,
        evidence_ari VARCHAR(512) NOT NULL,
        evidence_kind VARCHAR(64) NOT NULL,
        label VARCHAR(255) NULL,
        observed_at VARCHAR(32) NOT NULL,
        active TINYINT NOT NULL DEFAULT 1
      )
    `,
  },
  {
    name: 'v006_index_evidence_links_control',
    statement: 'CREATE INDEX IF NOT EXISTS idx_links_control ON evidence_links (control_id)',
  },
  {
    name: 'v007_create_scans',
    statement: `
      CREATE TABLE IF NOT EXISTS scans (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        started_at VARCHAR(32) NOT NULL,
        finished_at VARCHAR(32) NULL,
        trigger_source VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL,
        principal_account_id VARCHAR(128) NULL,
        counts_json TEXT NULL,
        duration_ms INT NULL,
        notes TEXT NULL
      )
    `,
  },
  {
    name: 'v008_index_scans_started',
    statement: 'CREATE INDEX IF NOT EXISTS idx_scans_started ON scans (started_at)',
  },
  {
    name: 'v009_create_findings',
    statement: `
      CREATE TABLE IF NOT EXISTS findings (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        scan_id VARCHAR(64) NOT NULL,
        control_id VARCHAR(64) NOT NULL,
        requirement_id VARCHAR(64) NOT NULL,
        state VARCHAR(16) NOT NULL,
        subject_ari VARCHAR(512) NULL,
        reason TEXT NOT NULL,
        evidence_ari VARCHAR(512) NULL,
        age_days INT NULL,
        missing_scopes TEXT NULL,
        query_key VARCHAR(128) NULL,
        row_count INT NULL,
        latency_ms INT NULL,
        created_at VARCHAR(32) NOT NULL
      )
    `,
  },
  {
    name: 'v010_index_findings_scan',
    statement: 'CREATE INDEX IF NOT EXISTS idx_findings_scan ON findings (scan_id)',
  },
  {
    name: 'v011_index_findings_control',
    statement: 'CREATE INDEX IF NOT EXISTS idx_findings_control ON findings (control_id)',
  },
  {
    name: 'v012_create_provenance',
    statement: `
      CREATE TABLE IF NOT EXISTS provenance (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        finding_id VARCHAR(64) NOT NULL,
        hop INT NOT NULL,
        from_ari VARCHAR(512) NULL,
        relation VARCHAR(128) NOT NULL,
        to_ari VARCHAR(512) NULL,
        observed_at VARCHAR(32) NOT NULL
      )
    `,
  },
  {
    name: 'v013_index_provenance_finding',
    statement: 'CREATE INDEX IF NOT EXISTS idx_prov_finding ON provenance (finding_id)',
  },
  {
    name: 'v014_create_remediations',
    statement: `
      CREATE TABLE IF NOT EXISTS remediations (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        finding_id VARCHAR(64) NOT NULL,
        jira_issue_key VARCHAR(32) NOT NULL,
        assignee_account_id VARCHAR(128) NULL,
        due_date VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
        created_at VARCHAR(32) NOT NULL
      )
    `,
  },
  {
    name: 'v015_index_remediations_issue',
    statement: 'CREATE INDEX IF NOT EXISTS idx_rem_issue ON remediations (jira_issue_key)',
  },
  {
    name: 'v016_create_app_config',
    statement: `
      CREATE TABLE IF NOT EXISTS app_config (
        config_key VARCHAR(64) NOT NULL PRIMARY KEY,
        config_value TEXT NOT NULL,
        updated_at VARCHAR(32) NOT NULL
      )
    `,
  },
  {
    // The audit pack needs the observation date of the evidence object (when the
    // page version or the issue was last touched), which is not the scan time.
    name: 'v017_findings_evidence_observed',
    statement: 'ALTER TABLE findings ADD COLUMN evidence_observed_at VARCHAR(32) NULL',
    // MySQL has no `ADD COLUMN IF NOT EXISTS`, so idempotency is a read before the
    // write (see ensureSchema). Two entry points can hit a fresh install at once.
    addColumn: { table: 'findings', column: 'evidence_observed_at' },
  },
  {
    // Notes explain a read without changing a verdict (e.g. a persisted query that
    // did not answer). They belong next to the finding, not in its reason.
    name: 'v018_findings_notes',
    statement: 'ALTER TABLE findings ADD COLUMN notes TEXT NULL',
    addColumn: { table: 'findings', column: 'notes' },
  },
  {
    // An exception is how a gap is carried on purpose: a reason, an expiry and the
    // compensating control, recorded by a person. It never changes a verdict — it
    // makes the gap explained, and a gap with no reason on record is counted as
    // unexplained.
    name: 'v019_create_claim_exceptions',
    statement: `
      CREATE TABLE IF NOT EXISTS claim_exceptions (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        control_id VARCHAR(64) NOT NULL,
        claim_key VARCHAR(96) NOT NULL,
        evidence_type VARCHAR(32) NOT NULL,
        exception_reason TEXT NOT NULL,
        expires_at VARCHAR(16) NOT NULL,
        compensating_control VARCHAR(255) NULL,
        recorded_by VARCHAR(128) NULL,
        recorded_at VARCHAR(32) NOT NULL,
        active TINYINT NOT NULL DEFAULT 1
      )
    `,
  },
  {
    name: 'v020_index_claim_exceptions_key',
    statement: 'CREATE INDEX IF NOT EXISTS idx_exceptions_key ON claim_exceptions (claim_key)',
  },
];

let schemaReady = false;
/** One migration run per instance, even when several claims ask at once. */
let schemaInFlight: Promise<void> | null = null;
/** When the schema was last confirmed present on this instance. */
let schemaCheckedAt = 0;
/**
 * A warm instance re-confirms with one cheap read, because the flag is per process
 * and one process can serve both products. That read does not need to happen on
 * every claim the panel judges — a minute of trust is plenty for a container that
 * lives for minutes.
 */
const SCHEMA_RECHECK_MS = 60_000;

/**
 * Apply the schema. Safe to call from every entry point: `migrationRunner`
 * records applied versions and skips them, and the in-memory flag keeps a warm
 * function from re-checking on every invocation.
 *
 * Forge recommends orchestrating migrations from an async event consumer so a
 * single run has up to 15 minutes. This skeleton calls it lazily from the
 * resolver, the actions and the scheduled trigger instead, so that no extra
 * module is required before G0. Move it to an `avi:ecosystem:installed:app`
 * consumer in W1 if the DDL set grows.
 */
/**
 * Does this execution context really have the schema?
 *
 * The "already migrated" flag is per running instance, and one instance can serve
 * more than one product for the same app: the macro runs its resolver on the
 * Confluence side while the control room runs it on the Jira side, and the two do
 * not necessarily share a database. Trusting the flag alone made the macro fail
 * with `Table 'scans' doesn't exist` after any Jira request had warmed the
 * instance, so the flag is confirmed with one cheap read before it is believed.
 */
async function schemaPresent(): Promise<boolean> {
  try {
    await rows('SELECT 1 FROM controls LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

export async function ensureSchema(): Promise<void> {
  if (schemaReady && Date.now() - schemaCheckedAt < SCHEMA_RECHECK_MS) {
    return;
  }
  if (schemaInFlight) {
    return schemaInFlight;
  }
  schemaInFlight = (async () => {
    if (schemaReady && (await schemaPresent())) {
      schemaCheckedAt = Date.now();
      return;
    }
    schemaReady = false;
    for (const migration of MIGRATIONS) {
      if (migration.addColumn && (await columnExists(migration.addColumn.table, migration.addColumn.column))) {
        continue;
      }
      migrationRunner.enqueue(migration.name, migration.statement);
    }
    try {
      await migrationRunner.run();
    } catch (error) {
      // The first request to a fresh install can race another one: both see no schema,
      // both run the DDL, and the loser gets `duplicate column` (or `table already
      // exists`). That is not a failure of the install, it is a second writer of the
      // same DDL, so the schema is re-checked before the error is allowed to escape.
      // Before this, the demo site's first install logged two failed migrations before
      // one run went through.
      if (await schemaPresent()) {
        schemaReady = true;
        schemaCheckedAt = Date.now();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column|already exists|Duplicate column/i.test(message)) {
        throw error;
      }
      // A benign duplicate on one column: retry once with the now-present columns skipped.
      for (const migration of MIGRATIONS) {
        if (migration.addColumn && (await columnExists(migration.addColumn.table, migration.addColumn.column))) {
          continue;
        }
        migrationRunner.enqueue(migration.name, migration.statement);
      }
      await migrationRunner.run();
    }
    schemaReady = true;
    schemaCheckedAt = Date.now();
  })().finally(() => {
    schemaInFlight = null;
  });
  return schemaInFlight;
}

/**
 * Does this column exist already?
 *
 * `information_schema` answers on Forge SQL's MySQL/TiDB; a read that fails answers
 * false, which leaves the migration in the list: the ALTER is then attempted and its
 * duplicate error is handled by the caller.
 */
async function columnExists(table: string, column: string): Promise<boolean> {
  try {
    const found = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = ? AND column_name = ? LIMIT 1`,
      [table, column],
    );
    return found.length > 0;
  } catch {
    return false;
  }
}

/** Test-only hook so a warm instance can re-run migrations after a manual wipe. */
export function resetSchemaCacheForTests(): void {
  schemaReady = false;
  schemaInFlight = null;
  schemaCheckedAt = 0;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

async function rows<T>(query: string, params: unknown[] = []): Promise<T[]> {
  const result: Result<T> = await sql.prepare<T>(query).bindParams(...params).execute();
  return result.rows as T[];
}

async function first<T>(query: string, params: unknown[] = []): Promise<T | null> {
  const found = await rows<T>(query, params);
  return found.length > 0 ? (found[0] as T) : null;
}

async function mutate(query: string, params: unknown[] = []): Promise<void> {
  await sql.prepare(query).bindParams(...params).execute();
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

export interface ControlInput {
  code: string;
  name: string;
  regulationRef?: string;
  cadence?: ControlCadence;
  riskTier?: RiskTier;
  jiraLabel: string;
  jiraProjectKey: string;
  ownerAccountId?: string | null;
  ownerDisplayName?: string | null;
  status?: ControlStatus;
}

export async function upsertControl(input: ControlInput): Promise<string> {
  const existing = await getControlByCode(input.code);
  if (existing) {
    await mutate(
      `UPDATE controls
          SET name = ?, regulation_ref = ?, cadence = ?, risk_tier = ?,
              jira_label = ?, jira_project_key = ?, owner_account_id = ?,
              owner_display_name = ?, status = ?
        WHERE id = ?`,
      [
        input.name,
        input.regulationRef ?? '',
        input.cadence ?? 'QUARTERLY',
        input.riskTier ?? 'MEDIUM',
        input.jiraLabel,
        input.jiraProjectKey,
        input.ownerAccountId ?? null,
        input.ownerDisplayName ?? null,
        input.status ?? 'ACTIVE',
        existing.id,
      ],
    );
    return existing.id;
  }
  const id = newId();
  await mutate(
    `INSERT INTO controls
       (id, code, name, regulation_ref, cadence, risk_tier, jira_label,
        jira_project_key, owner_account_id, owner_display_name, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.code,
      input.name,
      input.regulationRef ?? '',
      input.cadence ?? 'QUARTERLY',
      input.riskTier ?? 'MEDIUM',
      input.jiraLabel,
      input.jiraProjectKey,
      input.ownerAccountId ?? null,
      input.ownerDisplayName ?? null,
      input.status ?? 'ACTIVE',
    ],
  );
  return id;
}

export async function listControls(): Promise<ControlRow[]> {
  return rows<ControlRow>('SELECT * FROM controls ORDER BY code ASC');
}

export async function getControlByCode(code: string): Promise<ControlRow | null> {
  return first<ControlRow>('SELECT * FROM controls WHERE code = ?', [code]);
}

export async function getControlById(id: string): Promise<ControlRow | null> {
  return first<ControlRow>('SELECT * FROM controls WHERE id = ?', [id]);
}

export async function countControls(): Promise<number> {
  const row = await first<{ total: number }>('SELECT COUNT(*) AS total FROM controls');
  return Number(row?.total ?? 0);
}

// ---------------------------------------------------------------------------
// evidence_requirements
// ---------------------------------------------------------------------------

export interface RequirementInput {
  controlId: string;
  evidenceType: EvidenceType;
  maxAgeDays: number;
  minCount: number;
  rule?: RequirementRule;
}

export async function replaceRequirements(
  controlId: string,
  requirements: readonly Omit<RequirementInput, 'controlId'>[],
): Promise<void> {
  await mutate('DELETE FROM evidence_requirements WHERE control_id = ?', [controlId]);
  for (const requirement of requirements) {
    await mutate(
      `INSERT INTO evidence_requirements
         (id, control_id, evidence_type, max_age_days, min_count, rule_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        controlId,
        requirement.evidenceType,
        requirement.maxAgeDays,
        requirement.minCount,
        JSON.stringify(requirement.rule ?? {}),
      ],
    );
  }
}

/**
 * Add one requirement row without touching the others.
 *
 * Used when the shipped programme gains a claim (v6.35's approval accountability):
 * a registry that already exists on a site keeps its rows, and the new claim is
 * added to it. Rewriting the whole set instead would let the app silently change the
 * rules a customer is being judged by on an upgrade.
 */
export async function insertRequirement(
  controlId: string,
  requirement: Omit<RequirementInput, 'controlId'>,
): Promise<void> {
  await mutate(
    `INSERT INTO evidence_requirements
       (id, control_id, evidence_type, max_age_days, min_count, rule_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      controlId,
      requirement.evidenceType,
      requirement.maxAgeDays,
      requirement.minCount,
      JSON.stringify(requirement.rule ?? {}),
    ],
  );
}

export async function listRequirements(controlId: string): Promise<RequirementRow[]> {
  return rows<RequirementRow>(
    'SELECT * FROM evidence_requirements WHERE control_id = ? ORDER BY evidence_type ASC',
    [controlId],
  );
}

export async function listRequirementsForControls(
  controlIds: readonly string[],
): Promise<RequirementRow[]> {
  if (controlIds.length === 0) {
    return [];
  }
  const placeholders = controlIds.map(() => '?').join(', ');
  return rows<RequirementRow>(
    `SELECT * FROM evidence_requirements WHERE control_id IN (${placeholders})`,
    [...controlIds],
  );
}

export function parseRule(ruleJson: string): RequirementRule {
  try {
    const parsed: unknown = JSON.parse(ruleJson);
    return typeof parsed === 'object' && parsed !== null ? (parsed as RequirementRule) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// evidence_links
// ---------------------------------------------------------------------------

export interface EvidenceLinkInput {
  controlId: string;
  requirementId: string;
  evidenceAri: string;
  evidenceKind: string;
  label?: string | null;
  observedAt?: string;
}

export async function addEvidenceLink(input: EvidenceLinkInput): Promise<string> {
  const id = newId();
  await mutate(
    `INSERT INTO evidence_links
       (id, control_id, requirement_id, evidence_ari, evidence_kind, label, observed_at, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      id,
      input.controlId,
      input.requirementId,
      input.evidenceAri,
      input.evidenceKind,
      input.label ?? null,
      input.observedAt ?? nowIso(),
    ],
  );
  return id;
}

export async function listEvidenceLinks(controlId: string): Promise<EvidenceLinkRow[]> {
  return rows<EvidenceLinkRow>(
    'SELECT * FROM evidence_links WHERE control_id = ? AND active = 1 ORDER BY observed_at DESC',
    [controlId],
  );
}

/** Every live evidence link, for the audit pack's evidence labels and links. */
export async function listAllEvidenceLinks(): Promise<EvidenceLinkRow[]> {
  return rows<EvidenceLinkRow>('SELECT * FROM evidence_links WHERE active = 1 ORDER BY observed_at DESC');
}

/**
 * Retire one kind of link for a control.
 *
 * A re-seed writes the control's page and work-item links again, so the old rows
 * have to stop counting first: two live policy candidates would let a fresh page
 * outrank an aged one and hide the STALE the demo is showing on purpose.
 */
export async function deactivateEvidenceLinksOfKind(
  controlId: string,
  evidenceKind: string,
): Promise<void> {
  await mutate('UPDATE evidence_links SET active = 0 WHERE control_id = ? AND evidence_kind = ?', [
    controlId,
    evidenceKind,
  ]);
}

/** Mark links that the latest scan no longer sees, so the registry does not drift. */
export async function deactivateEvidenceLinks(controlId: string, keepArs: readonly string[]): Promise<void> {
  if (keepArs.length === 0) {
    await mutate('UPDATE evidence_links SET active = 0 WHERE control_id = ?', [controlId]);
    return;
  }
  const placeholders = keepArs.map(() => '?').join(', ');
  await mutate(
    `UPDATE evidence_links SET active = 0
      WHERE control_id = ? AND evidence_ari NOT IN (${placeholders})`,
    [controlId, ...keepArs],
  );
}

// ---------------------------------------------------------------------------
// scans
// ---------------------------------------------------------------------------

export async function startScan(input: {
  triggerSource: ScanTrigger;
  principalAccountId?: string | null;
  notes?: string | null;
}): Promise<string> {
  const id = newId();
  await mutate(
    `INSERT INTO scans
       (id, started_at, finished_at, trigger_source, status, principal_account_id, counts_json, duration_ms, notes)
     VALUES (?, ?, NULL, ?, 'RUNNING', ?, NULL, NULL, ?)`,
    [id, nowIso(), input.triggerSource, input.principalAccountId ?? null, input.notes ?? null],
  );
  return id;
}

export async function finishScan(input: {
  scanId: string;
  status: ScanStatus;
  counts: StateCounts;
  durationMs: number;
  notes?: string | null;
}): Promise<void> {
  await mutate(
    `UPDATE scans
        SET finished_at = ?, status = ?, counts_json = ?, duration_ms = ?, notes = ?
      WHERE id = ?`,
    [
      nowIso(),
      input.status,
      JSON.stringify(input.counts),
      input.durationMs,
      input.notes ?? null,
      input.scanId,
    ],
  );
}

export async function getScan(scanId: string): Promise<ScanRow | null> {
  return first<ScanRow>('SELECT * FROM scans WHERE id = ?', [scanId]);
}

export async function latestScan(): Promise<ScanRow | null> {
  return first<ScanRow>(
    "SELECT * FROM scans WHERE status = 'COMPLETED' ORDER BY started_at DESC LIMIT 1",
  );
}

/** The previous completed scan, used for the "new gaps since yesterday" delta. */
export async function previousScan(): Promise<ScanRow | null> {
  return first<ScanRow>(
    "SELECT * FROM scans WHERE status = 'COMPLETED' ORDER BY started_at DESC LIMIT 1 OFFSET 1",
  );
}

export function parseCounts(countsJson: string | null): StateCounts {
  const empty: StateCounts = { VERIFIED: 0, STALE: 0, MISSING: 0, NOT_VISIBLE: 0, INCOMPLETE: 0 };
  if (!countsJson) {
    return empty;
  }
  try {
    const parsed = JSON.parse(countsJson) as Partial<StateCounts>;
    return {
      VERIFIED: Number(parsed.VERIFIED ?? 0),
      STALE: Number(parsed.STALE ?? 0),
      MISSING: Number(parsed.MISSING ?? 0),
      NOT_VISIBLE: Number(parsed.NOT_VISIBLE ?? 0),
      INCOMPLETE: Number(parsed.INCOMPLETE ?? 0),
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------

export interface FindingInput {
  scanId: string;
  controlId: string;
  requirementId: string;
  state: EvidenceState;
  subjectAri?: string | null;
  reason: string;
  evidenceAri?: string | null;
  ageDays?: number | null;
  missingScopes?: readonly string[];
  queryKey?: string | null;
  rowCount?: number | null;
  latencyMs?: number | null;
  evidenceObservedAt?: string | null;
  notes?: readonly string[];
}

export async function insertFinding(input: FindingInput): Promise<string> {
  const id = newId();
  await mutate(
    `INSERT INTO findings
       (id, scan_id, control_id, requirement_id, state, subject_ari, reason, evidence_ari,
        age_days, missing_scopes, query_key, row_count, latency_ms, evidence_observed_at, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.scanId,
      input.controlId,
      input.requirementId,
      input.state,
      input.subjectAri ?? null,
      input.reason,
      input.evidenceAri ?? null,
      input.ageDays ?? null,
      input.missingScopes && input.missingScopes.length > 0
        ? JSON.stringify(input.missingScopes)
        : null,
      input.queryKey ?? null,
      input.rowCount ?? null,
      input.latencyMs ?? null,
      input.evidenceObservedAt ?? null,
      input.notes && input.notes.length > 0 ? JSON.stringify(input.notes) : null,
      nowIso(),
    ],
  );
  return id;
}

export async function listFindingsByScan(scanId: string): Promise<FindingRow[]> {
  return rows<FindingRow>(
    'SELECT * FROM findings WHERE scan_id = ? ORDER BY state ASC, created_at ASC',
    [scanId],
  );
}

export async function getFinding(findingId: string): Promise<FindingRow | null> {
  return first<FindingRow>('SELECT * FROM findings WHERE id = ?', [findingId]);
}

export async function latestFindingsForControl(controlId: string): Promise<FindingRow[]> {
  const scan = await latestScan();
  if (!scan) {
    return [];
  }
  return rows<FindingRow>('SELECT * FROM findings WHERE scan_id = ? AND control_id = ?', [
    scan.id,
    controlId,
  ]);
}

export async function latestFindingsForRequirement(requirementId: string): Promise<FindingRow | null> {
  return first<FindingRow>(
    'SELECT * FROM findings WHERE requirement_id = ? ORDER BY created_at DESC LIMIT 1',
    [requirementId],
  );
}

export async function countFindingsByState(scanId: string): Promise<StateCounts> {
  const found = await rows<{ state: EvidenceState; total: number }>(
    'SELECT state, COUNT(*) AS total FROM findings WHERE scan_id = ? GROUP BY state',
    [scanId],
  );
  const counts: StateCounts = { VERIFIED: 0, STALE: 0, MISSING: 0, NOT_VISIBLE: 0, INCOMPLETE: 0 };
  for (const row of found) {
    counts[row.state] = Number(row.total);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------

export interface ProvenanceInput {
  findingId: string;
  hop: number;
  fromAri: string | null;
  relation: string;
  toAri: string | null;
  observedAt: string;
}

export async function insertProvenance(hops: readonly ProvenanceInput[]): Promise<void> {
  for (const hop of hops) {
    await mutate(
      `INSERT INTO provenance (id, finding_id, hop, from_ari, relation, to_ari, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId(), hop.findingId, hop.hop, hop.fromAri, hop.relation, hop.toAri, hop.observedAt],
    );
  }
}

export async function listProvenance(findingId: string): Promise<ProvenanceRow[]> {
  return rows<ProvenanceRow>(
    'SELECT * FROM provenance WHERE finding_id = ? ORDER BY hop ASC',
    [findingId],
  );
}

// ---------------------------------------------------------------------------
// remediations
// ---------------------------------------------------------------------------

export interface RemediationInput {
  findingId: string;
  jiraIssueKey: string;
  assigneeAccountId?: string | null;
  dueDate: string;
}

export async function insertRemediation(input: RemediationInput): Promise<string> {
  const id = newId();
  await mutate(
    `INSERT INTO remediations
       (id, finding_id, jira_issue_key, assignee_account_id, due_date, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'OPEN', ?)`,
    [
      id,
      input.findingId,
      input.jiraIssueKey,
      input.assigneeAccountId ?? null,
      input.dueDate,
      nowIso(),
    ],
  );
  return id;
}

export async function listOpenRemediations(): Promise<RemediationRow[]> {
  return rows<RemediationRow>(
    "SELECT * FROM remediations WHERE status = 'OPEN' ORDER BY due_date ASC",
  );
}

/** Every remediation, so the audit pack can show closed ones too. */
export async function listRemediations(): Promise<RemediationRow[]> {
  return rows<RemediationRow>('SELECT * FROM remediations ORDER BY due_date ASC');
}

/** True when a remediation issue was already created for the finding (idempotent closing). */
export async function findRemediationByFinding(findingId: string): Promise<RemediationRow | null> {
  return first<RemediationRow>('SELECT * FROM remediations WHERE finding_id = ?', [findingId]);
}

// ---------------------------------------------------------------------------
// app_config
// ---------------------------------------------------------------------------

export async function getConfig(key: string): Promise<string | null> {
  const row = await first<{ config_value: string }>(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    [key],
  );
  return row?.config_value ?? null;
}

export async function setConfig(key: string, value: string): Promise<void> {
  const existing = await getConfig(key);
  if (existing === null) {
    await mutate('INSERT INTO app_config (config_key, config_value, updated_at) VALUES (?, ?, ?)', [
      key,
      value,
      nowIso(),
    ]);
    return;
  }
  await mutate('UPDATE app_config SET config_value = ?, updated_at = ? WHERE config_key = ?', [
    value,
    nowIso(),
    key,
  ]);
}

export const CONFIG_SCAN_PRINCIPAL = 'scan_principal_account_id';
export const CONFIG_DEMO_SEEDED = 'northwind_pay_seeded';
export const CONFIG_LAST_DAILY_SCAN = 'last_daily_scan_at';
/** Integrity of the last completed scan: retries, degraded reads, INCOMPLETE rows. */
export const CONFIG_LAST_SCAN_INTEGRITY = 'last_scan_integrity';
/**
 * Where this installation's programme is bound: the project whose work items are
 * judged and the space that holds the policy pages. Written by the one-click bind
 * step; read by the scan and by the Control Room's empty state.
 */
export const CONFIG_SITE_BINDING = 'site_binding';
/** Last reverse scan for evidence no control claims (the orphan scan). */
export const CONFIG_LAST_ORPHAN_SCAN = 'last_orphan_scan';

// ---------------------------------------------------------------------------
// claim_exceptions
// ---------------------------------------------------------------------------

export interface ClaimExceptionInput {
  controlId: string;
  claimKey: string;
  evidenceType: string;
  reason: string;
  expiresAt: string;
  compensatingControl?: string | null;
  recordedBy?: string | null;
}

/** Record (or replace) the exception for one claim. A reason is mandatory. */
export async function recordClaimException(input: ClaimExceptionInput): Promise<string> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error('An exception needs a reason: a gap with no reason is an unexplained gap.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt)) {
    throw new Error('An exception needs an expiry date (yyyy-mm-dd).');
  }
  const existing = await first<ClaimExceptionRow>(
    'SELECT * FROM claim_exceptions WHERE claim_key = ? AND active = 1',
    [input.claimKey],
  );
  if (existing) {
    await mutate(
      `UPDATE claim_exceptions
          SET exception_reason = ?, expires_at = ?, compensating_control = ?, recorded_by = ?, recorded_at = ?
        WHERE id = ?`,
      [
        reason,
        input.expiresAt,
        input.compensatingControl ?? null,
        input.recordedBy ?? null,
        nowIso(),
        existing.id,
      ],
    );
    return existing.id;
  }
  const id = newId();
  await mutate(
    `INSERT INTO claim_exceptions
       (id, control_id, claim_key, evidence_type, exception_reason, expires_at,
        compensating_control, recorded_by, recorded_at, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      id,
      input.controlId,
      input.claimKey,
      input.evidenceType,
      reason,
      input.expiresAt,
      input.compensatingControl ?? null,
      input.recordedBy ?? null,
      nowIso(),
    ],
  );
  return id;
}

export async function listClaimExceptions(): Promise<ClaimExceptionRow[]> {
  return rows<ClaimExceptionRow>(
    'SELECT * FROM claim_exceptions WHERE active = 1 ORDER BY expires_at ASC',
  );
}

export async function getClaimException(claimKey: string): Promise<ClaimExceptionRow | null> {
  return first<ClaimExceptionRow>(
    'SELECT * FROM claim_exceptions WHERE claim_key = ? AND active = 1',
    [claimKey],
  );
}

/** Withdraw an exception: the gap becomes unexplained again from now on. */
export async function withdrawClaimException(claimKey: string): Promise<boolean> {
  const existing = await getClaimException(claimKey);
  if (!existing) {
    return false;
  }
  await mutate('UPDATE claim_exceptions SET active = 0 WHERE id = ?', [existing.id]);
  return true;
}
