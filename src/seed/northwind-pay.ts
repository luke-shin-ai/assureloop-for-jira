/**
 * Synthetic demo data set: "Northwind Pay" — a fictional regulated payment
 * institution. Nothing here refers to a real company, product or person; the
 * names, e-mails and issue keys are invented so the demo carries no employer
 * data (Codegeist rules §4 "solely owned", concept §4.9 risk A8).
 *
 * What the data produces on the demo site, once the scan runs:
 *
 *   AC-01  VERIFIED     October changes closed, independently approved, policy current
 *   AC-02  MISSING      one October change was approved by its own assignee
 *   AC-03  VERIFIED     access review procedure linked and current
 *   AC-04  VERIFIED     privileged access approved by a second person
 *   AC-05  VERIFIED     restore test recorded within the quarter
 *   AC-06  STALE        the runbook library was last reviewed in August 2021
 *   AC-07  VERIFIED     third-party standard owned and linked
 *   AC-08  VERIFIED     retention policy linked and current
 *   AC-09  VERIFIED     key rotation attestations collected
 *   AC-10  VERIFIED     high-severity fixes closed inside SLA
 *   AC-11  VERIFIED     continuity runbook linked and current
 *   AC-12  VERIFIED     regulatory assessment linked to the change policy
 *
 * VERIFIED, STALE and MISSING therefore all appear in one scan, which is the
 * point of the demo: the engine does not only say yes and no.
 *
 * STALE cannot be manufactured by writing a policy today. Freshness is the live
 * page's last version, so the only honest way to show an aged policy is to point
 * one control at a page that really is old. AC-06 governs incident postmortems and
 * is tied to the site's own "Incident Runbooks" page (edited 2021-08-01, ~1,900
 * days old against a 180-day window). Every other policy page is one the seed
 * writes, so it starts fresh.
 *
 * NOT_VISIBLE is set up at install time rather than during a recording: install
 * with `read:graph:page:confluence` deliberately not approved (or use a site where
 * the admin withheld it), and a policy claim renders "NOT_VISIBLE - missing scope:
 * read:graph:page:confluence" while every other claim still judges normally.
 * Revoking a scope mid-demo does not reproduce: changes take about a minute to
 * propagate and rows keep coming back after removal.
 *
 * SEVEN CLAIMS ARE UNIVERSAL (`everyItem: true`): AC-01 on the work item and on the
 * approval, AC-02, AC-04, AC-06, AC-07 and AC-10. Their text says "each" or "every",
 * and the scan passes them only when every object it read qualified and the whole
 * population was read; one unqualified object is a gap, a partial read is
 * INCOMPLETE. The other thirteen are existential ("a record exists", "the policy is
 * current") and keep the default reading, because inventing a universal claim over a
 * population the rule never tested is how a spreadsheet gets a green row.
 */

import {
  addEvidenceLink,
  countControls,
  deactivateEvidenceLinksOfKind,
  getConfig,
  listRequirements,
  replaceRequirements,
  setConfig,
  upsertControl,
  CONFIG_DEMO_SEEDED,
  type ControlCadence,
  type EvidenceType,
  type RequirementRule,
  type RiskTier,
} from '../schema/sql';

// ---------------------------------------------------------------------------
// ARI helpers
// ---------------------------------------------------------------------------

/** ari:cloud:jira:<cloudId>:issue/<issueId> — the ARI shape Teamwork Graph uses. */
export function jiraIssueAri(cloudId: string, issueId: string): string {
  return `ari:cloud:jira:${cloudId}:issue/${issueId}`;
}

/** ari:cloud:confluence:<cloudId>:page/<pageId> */
export function confluencePageAri(cloudId: string, pageId: string): string {
  return `ari:cloud:confluence:${cloudId}:page/${pageId}`;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export interface SeedOwner {
  /** Fictional handle; resolved to an accountId at seed time. */
  email: string;
  name: string;
  active: boolean;
  role: string;
}

export interface SeedPage {
  key: string;
  title: string;
  spaceKey: string;
  /** Age in days at seed time, so the demo shows a realistic freshness spread. */
  ageDays: number;
  ownerEmail: string;
}

export interface SeedRequirement {
  evidenceType: EvidenceType;
  maxAgeDays: number;
  minCount: number;
  rule: RequirementRule;
}

export interface SeedControl {
  code: string;
  name: string;
  regulationRef: string;
  cadence: ControlCadence;
  riskTier: RiskTier;
  jiraLabel: string;
  ownerEmail: string;
  requirements: readonly SeedRequirement[];
  /** Page keys this control's evidence should link to. */
  pageKeys?: readonly string[];
}

export interface SeedTeam {
  name: string;
  spaceKey: string;
}

export interface SeedWorkItemSpec {
  key: string;
  summary: string;
  issueType: string;
}

export interface NorthwindPayDataset {
  company: string;
  program: string;
  jiraProjectKey: string;
  teams: readonly SeedTeam[];
  owners: readonly SeedOwner[];
  pages: readonly SeedPage[];
  changeIssues: readonly SeedWorkItemSpec[];
  controls: readonly SeedControl[];
}

export const NORTHWIND_PAY: NorthwindPayDataset = {
  company: 'Northwind Pay',
  program: 'FY26 assurance programme',
  jiraProjectKey: 'PAY',
  teams: [
    { name: 'Northwind Change Advisory', spaceKey: 'ITO' },
    { name: 'Northwind Platform Engineering', spaceKey: 'ITO' },
    { name: 'Northwind Security Operations', spaceKey: 'SECOPS' },
    { name: 'Northwind Risk & Compliance', spaceKey: 'LEGAL' },
  ],
  owners: [
    { email: 'jordan.park@northwindpay.example', name: 'Jordan Park', active: true, role: 'Head of Change Management' },
    { email: 'priya.raman@northwindpay.example', name: 'Priya Raman', active: true, role: 'Platform Engineering Lead' },
    { email: 'marcus.webb@northwindpay.example', name: 'Marcus Webb', active: false, role: 'Former Security Operations Lead' },
    { email: 'aisha.bello@northwindpay.example', name: 'Aisha Bello', active: true, role: 'Risk & Compliance Manager' },
    { email: 'tomas.rivera@northwindpay.example', name: 'Tomas Rivera', active: true, role: 'Third-Party Risk Analyst' },
    { email: 'elena.sokolova@northwindpay.example', name: 'Elena Sokolova', active: true, role: 'Data Governance Lead' },
  ],
  pages: [
    {
      key: 'change-policy',
      title: 'Change Management Policy v3',
      spaceKey: 'ITO',
      ageDays: 412,
      ownerEmail: 'marcus.webb@northwindpay.example',
    },
    {
      key: 'access-review',
      title: 'Production Access Review Procedure',
      spaceKey: 'SECOPS',
      ageDays: 40,
      ownerEmail: 'priya.raman@northwindpay.example',
    },
    {
      key: 'backup-standard',
      title: 'Backup and Restore Standard',
      spaceKey: 'ITO',
      ageDays: 120,
      ownerEmail: 'priya.raman@northwindpay.example',
    },
    {
      key: 'incident-runbook',
      title: 'Incident Management Runbook',
      spaceKey: 'ITO',
      ageDays: 20,
      ownerEmail: 'aisha.bello@northwindpay.example',
    },
    {
      // Not created by the seed: this page already lives in the demo site's IT
      // Operations space and was last edited in August 2021. Pointing a control
      // at it is what makes a real STALE finding possible — every page the seed
      // creates is "today", so a freshly written policy could never age out.
      key: 'incident-runbooks-registry',
      title: 'Incident Runbooks',
      spaceKey: 'ITO',
      ageDays: 1936,
      ownerEmail: 'jordan.park@northwindpay.example',
    },
    {
      key: 'third-party-standard',
      title: 'Third-Party Risk Standard',
      spaceKey: 'LEGAL',
      ageDays: 65,
      ownerEmail: 'tomas.rivera@northwindpay.example',
    },
    {
      key: 'data-retention',
      title: 'Data Retention Policy',
      spaceKey: 'SECOPS',
      ageDays: 500,
      ownerEmail: 'elena.sokolova@northwindpay.example',
    },
  ],
  /**
   * The October change population — the 12 changes in the auditor's request.
   *
   * These are the shapes the demo site actually holds (PAY-1 … PAY-13, created by
   * hand in the site UI); the keys are documentation, not something the seed creates.
   * The conversation starters name PAY-1 for that reason: a starter that points at a
   * key the site does not have fails the first time a judge clicks it.
   */
  changeIssues: [
    { key: 'PAY-1', summary: 'Enable 3-D Secure fallback for card-not-present', issueType: 'Change' },
    { key: 'PAY-2', summary: 'Raise settlement ledger batch size to 5k', issueType: 'Change' },
    { key: 'PAY-3', summary: 'Rotate merchant webhook signing secret', issueType: 'Change' },
    { key: 'PAY-4', summary: 'Add idempotency key to transfer API', issueType: 'Change' },
    { key: 'PAY-5', summary: 'Upgrade payment gateway SDK to 4.12', issueType: 'Change' },
    { key: 'PAY-6', summary: 'Enable read replica for reconciliation queries', issueType: 'Change' },
    { key: 'PAY-7', summary: 'Tighten retry backoff on issuer timeouts', issueType: 'Change' },
    { key: 'PAY-8', summary: 'Add chargeback evidence attachment endpoint', issueType: 'Change' },
    { key: 'PAY-9', summary: 'Move payout scheduler to new worker pool', issueType: 'Change' },
    { key: 'PAY-10', summary: 'Enable FX rate cache invalidation on publish', issueType: 'Change' },
    { key: 'PAY-11', summary: 'Add daily limit check to corporate cards', issueType: 'Change' },
    { key: 'PAY-12', summary: 'Deprecate legacy batch upload endpoint', issueType: 'Change' },
  ],
  controls: [
    {
      code: 'AC-01',
      name: 'Every production change carries an independent approval and a governing policy',
      regulationRef: 'DORA Art.9 / SOX ITGC CM-01',
      cadence: 'QUARTERLY',
      riskTier: 'HIGH',
      jiraLabel: 'ctrl-ac-01',
      ownerEmail: 'jordan.park@northwindpay.example',
      pageKeys: ['change-policy'],
      requirements: [
        {
          evidenceType: 'jira_work_item',
          maxAgeDays: 120,
          minCount: 1,
          rule: {
            requiresDoneStatus: true,
            everyItem: true,
            expectation: 'Each deployed October change is a closed work item labelled ctrl-ac-01.',
          },
        },
        {
          evidenceType: 'approval_comment',
          maxAgeDays: 120,
          minCount: 1,
          rule: {
            // approve / approves / approved, and the noun. The verb form was missing
            // until v6.50, so the plainest approval a reviewer writes, "I approve this
            // change", did not match the programme it was written for.
            approvalPattern: '\\b(approve[sd]?|approval|lgtm)\\b',
            requiresIndependentApprover: true,
            everyItem: true,
            expectation: 'Each change carries a comment approving it, written by someone other than its assignee or its reporter.',
          },
        },
        {
          evidenceType: 'policy_page',
          maxAgeDays: 365,
          minCount: 1,
          rule: {
            pageTitlePrefix: 'Change Management Policy',
            spaceKey: 'ITO',
            expectation: 'The governing change policy is owned, linked and less than a year old.',
          },
        },
        {
          // The cross-product claim: the person who approved the change has to be
          // accountable for the policy that governs it — a member of the team that
          // owns the policy page, or of a team accountable for the policy's space.
          // No Atlassian REST API joins a Jira approver to a Confluence page's owning
          // team, so this claim has no REST fallback: the graph decides it or the
          // claim says it cannot see.
          evidenceType: 'approval_independence',
          maxAgeDays: 120,
          minCount: 1,
          rule: {
            pageTitlePrefix: 'Change Management Policy',
            spaceKey: 'ITO',
            approvalPattern: '\\b(approve[sd]?|approval|lgtm)\\b',
            accountability: 'page_owner_team',
            expectation:
              'The approver is in a team the graph names as accountable for the policy page (or for the space it lives in).',
          },
        },
      ],
    },
    {
      code: 'AC-02',
      name: 'Nobody deploys to production with their own approval',
      regulationRef: 'SOX ITGC CM-03',
      cadence: 'MONTHLY',
      riskTier: 'HIGH',
      jiraLabel: 'ctrl-ac-02',
      ownerEmail: 'priya.raman@northwindpay.example',
      requirements: [
        {
          evidenceType: 'approval_comment',
          maxAgeDays: 60,
          minCount: 1,
          rule: {
            approvalPattern: '\\b(approve[sd]?|approval|lgtm)\\b',
            requiresIndependentApprover: true,
            everyItem: true,
            expectation: 'Approval and execution are separated for every production change.',
          },
        },
      ],
    },
    {
      code: 'AC-03',
      name: 'Quarterly production access review completed and recorded',
      regulationRef: 'ISO 27001 A.9.2 / PCI DSS 7.2',
      cadence: 'QUARTERLY',
      riskTier: 'HIGH',
      jiraLabel: 'ctrl-ac-03',
      ownerEmail: 'priya.raman@northwindpay.example',
      pageKeys: ['access-review'],
      requirements: [
        {
          evidenceType: 'jira_work_item',
          maxAgeDays: 100,
          minCount: 1,
          rule: {
            requiresDoneStatus: true,
            expectation: 'The access review runbook task is closed for this quarter.',
          },
        },
        {
          evidenceType: 'policy_page',
          maxAgeDays: 365,
          minCount: 1,
          rule: {
            pageTitlePrefix: 'Production Access Review Procedure',
            spaceKey: 'SECOPS',
            expectation: 'The review procedure is current.',
          },
        },
      ],
    },
    {
      code: 'AC-04',
      name: 'Privileged access is granted only with a recorded second approval',
      regulationRef: 'PCI DSS 8.3 / DORA Art.9',
      cadence: 'MONTHLY',
      riskTier: 'HIGH',
      jiraLabel: 'ctrl-ac-04',
      ownerEmail: 'marcus.webb@northwindpay.example',
      requirements: [
        {
          evidenceType: 'approval_comment',
          maxAgeDays: 45,
          minCount: 1,
          rule: {
            approvalPattern: '\\b(approved|granted|authorised|authorized)\\b',
            requiresIndependentApprover: true,
            everyItem: true,
            expectation: 'Each privileged grant shows a second approver.',
          },
        },
      ],
    },
    {
      code: 'AC-05',
      name: 'Backup restore tested within the quarter',
      regulationRef: 'ISO 27001 A.8.13 / DORA Art.11',
      cadence: 'QUARTERLY',
      riskTier: 'MEDIUM',
      jiraLabel: 'ctrl-ac-05',
      ownerEmail: 'priya.raman@northwindpay.example',
      pageKeys: ['backup-standard'],
      requirements: [
        {
          evidenceType: 'test_record',
          maxAgeDays: 95,
          minCount: 1,
          rule: {
            requiresDoneStatus: true,
            expectation: 'A restore test record exists with a passing result.',
          },
        },
      ],
    },
    {
      code: 'AC-06',
      name: 'Incident postmortem completed within five business days',
      regulationRef: 'DORA Art.17',
      cadence: 'CONTINUOUS',
      riskTier: 'HIGH',
      jiraLabel: 'ctrl-ac-06',
      ownerEmail: 'aisha.bello@northwindpay.example',
      pageKeys: ['incident-runbooks-registry'],
      requirements: [
        {
          evidenceType: 'jira_work_item',
          maxAgeDays: 30,
          minCount: 1,
          rule: {
            requiresDoneStatus: true,
            everyItem: true,
            expectation: 'Every incident has a linked postmortem closed inside the window.',
          },
        },
        {
          evidenceType: 'policy_page',
          maxAgeDays: 180,
          minCount: 1,
          rule: {
            pageTitlePrefix: 'Incident Runbooks',
            spaceKey: 'ITO',
            expectation: 'The runbook library has been reviewed inside the last 180 days.',
          },
        },
      ],
    },
    {
      code: 'AC-07',
      name: 'Critical third parties reviewed before contract renewal',
      regulationRef: 'DORA Art.28-30',
      cadence: 'ANNUAL',
      riskTier: 'MEDIUM',
      jiraLabel: 'ctrl-ac-07',
      ownerEmail: 'tomas.rivera@northwindpay.example',
      pageKeys: ['third-party-standard'],
      requirements: [
        {
          evidenceType: 'policy_page',
          maxAgeDays: 365,
          minCount: 1,
          rule: {
            pageTitlePrefix: 'Third-Party Risk Standard',
            spaceKey: 'LEGAL',
            expectation: 'The due-diligence standard is owned and less than a year old.',
          },
        },
        {
          evidenceType: 'jira_work_item',
          maxAgeDays: 365,
          minCount: 1,
          rule: {
            requiresDoneStatus: true,
            everyItem: true,
            expectation: 'A due-diligence record exists for each critical vendor.',
          },
        },
      ],
    },
    {
      code: 'AC-08',
      name: 'Data retention schedules reviewed annually',
      regulationRef: 'ISO 27001 A.18.1 / PCI DSS 3.2',
      cadence: 'ANNUAL',
      riskTier: 'MEDIUM',
      jiraLabel: 'ctrl-ac-08',
      ownerEmail: 'elena.sokolova@northwindpay.example',
      pageKeys: ['data-retention'],
      requirements: [
        {
          evidenceType: 'policy_page',
          maxAgeDays: 365,
          minCount: 1,
          rule: {
            pageTitlePrefix: 'Data Retention Policy',
            spaceKey: 'SECOPS',
            expectation: 'The retention policy has been reviewed in the last year.',
          },
        },
      ],
    },
    {
      code: 'AC-09',
      name: 'Encryption keys rotated on schedule with attestation',
      regulationRef: 'PCI DSS 3.6',
      cadence: 'QUARTERLY',
      riskTier: 'HIGH',
      jiraLabel: 'ctrl-ac-09',
      ownerEmail: 'marcus.webb@northwindpay.example',
      requirements: [
        {
          evidenceType: 'test_record',
          maxAgeDays: 95,
          minCount: 1,
          rule: {
            requiresDoneStatus: true,
            expectation: 'A rotation attestation exists for the quarter.',
          },
        },
      ],
    },
    {
      code: 'AC-10',
      name: 'High-severity vulnerabilities remediated within SLA',
      regulationRef: 'ISO 27001 A.8.8 / DORA Art.9',
      cadence: 'WEEKLY',
      riskTier: 'HIGH',
      jiraLabel: 'ctrl-ac-10',
      ownerEmail: 'priya.raman@northwindpay.example',
      requirements: [
        {
          evidenceType: 'jira_work_item',
          maxAgeDays: 30,
          minCount: 1,
          rule: {
            requiresDoneStatus: true,
            everyItem: true,
            expectation: 'Every high-severity finding has a closed remediation item within SLA.',
          },
        },
      ],
    },
    {
      code: 'AC-11',
      name: 'Business continuity exercise evidenced for the year',
      regulationRef: 'DORA Art.11-12',
      cadence: 'ANNUAL',
      riskTier: 'MEDIUM',
      jiraLabel: 'ctrl-ac-11',
      ownerEmail: 'aisha.bello@northwindpay.example',
      pageKeys: ['incident-runbook'],
      requirements: [
        {
          evidenceType: 'policy_page',
          maxAgeDays: 365,
          minCount: 1,
          rule: {
            pageTitlePrefix: 'Incident Management Runbook',
            spaceKey: 'ITO',
            expectation: 'The continuity runbook is linked and current.',
          },
        },
        {
          evidenceType: 'test_record',
          maxAgeDays: 365,
          minCount: 1,
          rule: {
            requiresDoneStatus: true,
            expectation: 'The annual exercise record is closed.',
          },
        },
      ],
    },
    {
      code: 'AC-12',
      name: 'Regulatory change assessed against affected systems',
      regulationRef: 'DORA Art.6 / internal policy',
      cadence: 'QUARTERLY',
      riskTier: 'MEDIUM',
      jiraLabel: 'ctrl-ac-12',
      ownerEmail: 'aisha.bello@northwindpay.example',
      pageKeys: ['change-policy'],
      requirements: [
        {
          evidenceType: 'jira_work_item',
          maxAgeDays: 120,
          minCount: 1,
          rule: {
            requiresDoneStatus: true,
            expectation: 'A regulatory impact assessment is closed for the quarter.',
          },
        },
        {
          evidenceType: 'policy_page',
          maxAgeDays: 365,
          minCount: 1,
          rule: {
            pageTitlePrefix: 'Change Management Policy',
            spaceKey: 'ITO',
            expectation: 'The change policy the assessment relies on is current.',
          },
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Everything the seed needs from the live site. Implemented in src/index.ts with
 * Jira REST (JQL by label) and Confluence REST (page by title in space), so this
 * module stays pure data plus SQL writes and can be exercised without a site.
 */
export interface SeedResolver {
  findWorkItemsByLabel(label: string, projectKey: string): Promise<Array<{ key: string; id: string; summary: string }>>;
  findPageByTitle(title: string, spaceKey: string, asAccountId?: string | null): Promise<{
    id: string;
    title: string;
    lastUpdatedAt: string;
    ownerAccountId: string | null;
    ownerName: string | null;
  } | null>;
  findUserByEmail?(email: string): Promise<{ accountId: string; name: string; active: boolean } | null>;
}

export interface SeedResult {
  skipped: boolean;
  controls: number;
  requirements: number;
  evidenceLinks: number;
  unresolvedPages: string[];
  missingIssues: string[];
}

/**
 * Create the Northwind Pay registry. Idempotent: controls are upserted by code,
 * requirements are replaced, and the whole run is skipped unless `force` is set
 * or the registry is still empty.
 *
 * `MAX_PAGES_PER_CONTROL` keeps Rust-less demo runs predictable: each control
 * resolves at most a handful of pages, and unresolved pages are reported rather
 * than invented. A page that cannot be found must not become fake evidence.
 */
export async function seedNorthwindPay(
  resolver: SeedResolver,
  cloudId: string,
  options: {
    force?: boolean;
    labelWindowDays?: number;
    asAccountId?: string | null;
    /** The project this site will hold the programme in; defaults to the demo PAY. */
    projectKey?: string;
  } = {},
): Promise<SeedResult> {
  const projectKey = options.projectKey?.trim() || NORTHWIND_PAY.jiraProjectKey;
  const alreadySeeded = (await getConfig(CONFIG_DEMO_SEEDED)) === 'true';
  const existingControls = await countControls();
  if (!options.force && alreadySeeded && existingControls > 0) {
    return {
      skipped: true,
      controls: existingControls,
      requirements: 0,
      evidenceLinks: 0,
      unresolvedPages: [],
      missingIssues: [],
    };
  }

  const result: SeedResult = {
    skipped: false,
    controls: 0,
    requirements: 0,
    evidenceLinks: 0,
    unresolvedPages: [],
    missingIssues: [],
  };

  for (const control of NORTHWIND_PAY.controls) {
    const owner = await resolveOwner(resolver, control.ownerEmail);
    const controlId = await upsertControl({
      code: control.code,
      name: control.name,
      regulationRef: control.regulationRef,
      cadence: control.cadence,
      riskTier: control.riskTier,
      jiraLabel: control.jiraLabel,
      jiraProjectKey: projectKey,
      ownerAccountId: owner?.accountId ?? null,
      ownerDisplayName: owner?.name ?? displayNameFor(control.ownerEmail),
      status: 'ACTIVE',
    });
    result.controls += 1;

    await replaceRequirements(
      controlId,
      control.requirements.map((requirement) => ({
        evidenceType: requirement.evidenceType,
        maxAgeDays: requirement.maxAgeDays,
        minCount: requirement.minCount,
        rule: requirement.rule,
      })),
    );
    result.requirements += control.requirements.length;

    // A re-seed replaces this control's links instead of stacking a second set on
    // top of the first: the oldest live policy page must not be shadowed by a
    // fresh duplicate of itself.
    await deactivateEvidenceLinksOfKind(controlId, 'confluence_page');
    await deactivateEvidenceLinksOfKind(controlId, 'jira_issue');

    // Resolve policy pages into evidence_links. These are the "known good"
    // starting points of the graph; the scan then proves the hops from them.
    for (const pageKey of control.pageKeys ?? []) {
      const page = NORTHWIND_PAY.pages.find((candidate) => candidate.key === pageKey);
      if (!page) {
        continue;
      }
      const requirement = control.requirements.find(
        (candidate) => candidate.rule.pageTitlePrefix === page.title,
      );
      const found = await resolver.findPageByTitle(page.title, page.spaceKey, options.asAccountId);
      if (!found) {
        result.unresolvedPages.push(`${page.spaceKey}/${page.title}`);
        continue;
      }
      if (!requirement) {
        continue;
      }
      const requirementRow = await findRequirementId(controlId, requirement.evidenceType);
      if (!requirementRow) {
        continue;
      }
      await addEvidenceLink({
        controlId,
        requirementId: requirementRow,
        evidenceAri: confluencePageAri(cloudId, found.id),
        evidenceKind: 'confluence_page',
        label: found.title,
        observedAt: found.lastUpdatedAt,
      });
      result.evidenceLinks += 1;
    }

    // Resolve the work-item population for controls tested against tickets.
    const needsWorkItems = control.requirements.some(
      (requirement) => requirement.evidenceType === 'jira_work_item' || requirement.evidenceType === 'test_record',
    );
    if (needsWorkItems) {
      const issues = await resolver.findWorkItemsByLabel(control.jiraLabel, projectKey);
      if (issues.length === 0) {
        result.missingIssues.push(control.jiraLabel);
      }
      const workItemRequirement = await findRequirementId(controlId, 'jira_work_item');
      for (const issue of issues) {
        if (!workItemRequirement) {
          break;
        }
        await addEvidenceLink({
          controlId,
          requirementId: workItemRequirement,
          evidenceAri: jiraIssueAri(cloudId, issue.id),
          evidenceKind: 'jira_issue',
          label: issue.key,
          observedAt: new Date().toISOString(),
        });
        result.evidenceLinks += 1;
      }
    }
  }

  await setConfig(CONFIG_DEMO_SEEDED, 'true');
  return result;
}

async function resolveOwner(
  resolver: SeedResolver,
  email: string,
): Promise<{ accountId: string; name: string; active: boolean } | null> {
  if (!resolver.findUserByEmail) {
    return null;
  }
  return resolver.findUserByEmail(email);
}

function displayNameFor(email: string): string {
  const owner = NORTHWIND_PAY.owners.find((candidate) => candidate.email === email);
  return owner?.name ?? email;
}

/**
 * The requirement row is created by replaceRequirements() with a generated id,
 * so it has to be read back by type. Kept here (rather than in sql.ts) because
 * it is a seeding-specific concern: a control may legitimately have two
 * requirements of the same type later, at which point seeding will need keys.
 */
async function findRequirementId(controlId: string, evidenceType: EvidenceType): Promise<string | null> {
  const requirements = await listRequirements(controlId);
  const match = requirements.find((requirement) => requirement.evidence_type === evidenceType);
  return match?.id ?? null;
}
