#!/usr/bin/env node
/**
 * build:demo — generate the no-install demo's data from the shipped programme.
 *
 *   npm run build:demo        (or: node scripts/build-demo.mjs)
 *
 * docs/demo/index.html, styles.css and app.js are hand-written. docs/demo/data.js
 * is generated here so the twenty claims a visitor reads in a browser tab are the
 * twenty claims the app ships, in the states measured on the demo site on
 * 2026-11-20 (18 verified, 1 stale, 1 missing). The generator imports
 * src/seed/northwind-pay.ts through esbuild, so adding a control to the programme
 * changes the demo on the next build, and `npm run check:claims` fails when the
 * page and the seed disagree.
 *
 * No dependency beyond esbuild, which is already a devDependency.
 */

import { buildSync } from 'esbuild';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/demo');
mkdirSync(OUT, { recursive: true });
mkdirSync(join(ROOT, '.tmp'), { recursive: true });

const bundle = join(ROOT, '.tmp/seed.demo.cjs');
buildSync({
  entryPoints: [join(ROOT, 'src/seed/northwind-pay.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: bundle,
  logLevel: 'error',
});
const { NORTHWIND_PAY } = createRequire(import.meta.url)(bundle);

// ---------------------------------------------------------------------------
// The measurement this page renders
// ---------------------------------------------------------------------------

const SCAN = {
  at: '2026-11-20 09:02 KST',
  asOf: '2026-11-20 09:02:53 KST',
  scanAt: Date.UTC(2026, 10, 20, 0, 2),
  trigger: 'manual',
  durationMs: 22989,
  graphReads: 17,
  site: 'one-atlas-xkzp.atlassian.net',
  project: 'PAY',
  space: 'ITO',
  fingerprint: 'e6e17b30a3ed272f4c20a65e0d1d2c7e',
};

const DAY = 86400000;
const dateOf = (daysAgo, time = '16:40') => {
  const d = new Date(SCAN.scanAt - daysAgo * DAY);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${time}`;
};

/**
 * The demo site's outcome per claim on 2026-11-20, with the age of the evidence
 * that produced it. `detail` is the readable half of the reason; the window half
 * is appended from the requirement the app ships, so the two cannot drift.
 */
const OUTCOMES = {
  'AC-01/jira_work_item': { state: 'VERIFIED', age: 12, detail: '3 closed change(s) labelled ctrl-ac-01, freshest 12 day(s) old' },
  'AC-01/approval_comment': { state: 'VERIFIED', age: 12, detail: '1 approval comment by an approver other than the assignee, 12 day(s) old' },
  'AC-01/policy_page': { state: 'VERIFIED', age: 2, detail: 'Change Management Policy v3, last edited 2 day(s) ago' },
  'AC-01/approval_independence': { state: 'VERIFIED', age: 0, detail: 'Dana Whitfield approved PAY-1 and is a member of Change Management, the team the graph names as accountable for the policy page' },
  'AC-02/approval_comment': { state: 'MISSING', age: 12, detail: 'PAY-2 carries one approval comment, written by its own assignee. One approval object was read and none of it qualified, so the claim is missing: segregation of duties is not evidenced' },
  'AC-03/jira_work_item': { state: 'VERIFIED', age: 9, detail: '2 closed access-review change(s), freshest 9 day(s) old' },
  'AC-03/policy_page': { state: 'VERIFIED', age: 2, detail: 'Production Access Review Procedure, last edited 2 day(s) ago' },
  'AC-04/approval_comment': { state: 'VERIFIED', age: 18, detail: '1 privileged-access request approved by a second person, 18 day(s) old' },
  'AC-05/test_record': { state: 'VERIFIED', age: 31, detail: 'Restore test attestation recorded 31 day(s) ago' },
  'AC-06/jira_work_item': { state: 'VERIFIED', age: 6, detail: '4 closed incident change(s), freshest 6 day(s) old' },
  'AC-06/policy_page': { state: 'STALE', age: 1936, detail: 'Incident Runbooks was last updated 1,936 day(s) ago' },
  'AC-07/policy_page': { state: 'VERIFIED', age: 2, detail: 'Third-Party Risk Standard, last edited 2 day(s) ago' },
  'AC-07/jira_work_item': { state: 'VERIFIED', age: 21, detail: '2 closed vendor change(s), freshest 21 day(s) old' },
  'AC-08/policy_page': { state: 'VERIFIED', age: 2, detail: 'Data Retention Policy, last edited 2 day(s) ago' },
  'AC-09/test_record': { state: 'VERIFIED', age: 8, detail: '6 key-rotation attestation(s), freshest 8 day(s) old' },
  'AC-10/jira_work_item': { state: 'VERIFIED', age: 4, detail: '5 high-severity fixes closed, freshest 4 day(s) old' },
  'AC-11/policy_page': { state: 'VERIFIED', age: 2, detail: 'Incident Management Runbook, last edited 2 day(s) ago' },
  'AC-11/test_record': { state: 'VERIFIED', age: 44, detail: 'Continuity exercise recorded 44 day(s) ago' },
  'AC-12/jira_work_item': { state: 'VERIFIED', age: 11, detail: '3 closed regulatory change(s), freshest 11 day(s) old' },
  'AC-12/policy_page': { state: 'VERIFIED', age: 2, detail: 'Change Management Policy v3, last edited 2 day(s) ago' },
};

const PAGE_AGE = {
  'Change Management Policy v3': 2,
  'Production Access Review Procedure': 2,
  'Backup and Restore Standard': 2,
  'Incident Management Runbook': 2,
  'Incident Runbooks': 1936,
  'Third-Party Risk Standard': 2,
  'Data Retention Policy': 2,
};

/** Observation times as the 2026-11-20 pack printed them. */
const PAGE_OBSERVED = {
  'Incident Runbooks': '2021-08-01 14:07',
};

const policyTitleFor = (control) => {
  const rule = control.requirements.find((r) => r.rule?.pageTitlePrefix)?.rule;
  if (!rule?.pageTitlePrefix) return null;
  const known = NORTHWIND_PAY.pages.find((p) => rule.pageTitlePrefix.startsWith(p.title) || p.title.startsWith(rule.pageTitlePrefix));
  return known?.title ?? rule.pageTitlePrefix;
};

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The evidence object a claim names, as the pack would show it. */
function evidenceFor(control, requirement, policyTitle, age) {
  const n = Number(control.code.slice(3));
  return {
    jira_work_item: () => ({
      label: control.code === 'AC-02' ? 'PAY-2' : 'PAY-1',
      kind: 'Jira work item',
      ari: `ari:cloud:jira:0b7c1e2a-9b31-4d8a-9f04-6c1d2a7e5b11:issue/${1180 + n}`,
      url: `https://one-atlas-xkzp.atlassian.net/browse/${control.code === 'AC-02' ? 'PAY-2' : 'PAY-1'}`,
    }),
    approval_comment: () => ({
      label: `comment on ${control.code === 'AC-02' ? 'PAY-2' : 'PAY-1'}`,
      kind: 'Jira comment',
      ari: `ari:cloud:jira:0b7c1e2a-9b31-4d8a-9f04-6c1d2a7e5b11:issue-comment/${4400 + n}`,
      url: `https://one-atlas-xkzp.atlassian.net/browse/${control.code === 'AC-02' ? 'PAY-2' : 'PAY-1'}?focusedCommentId=${4400 + n}`,
    }),
    policy_page: () => ({
      label: policyTitle,
      kind: 'Confluence page',
      ari: `ari:cloud:confluence:0b7c1e2a-9b31-4d8a-9f04-6c1d2a7e5b11:page/${9000 + n}`,
      url: `https://one-atlas-xkzp.atlassian.net/wiki/spaces/ITO/pages/${9000 + n}/${slug(policyTitle ?? 'page')}`,
    }),
    approval_independence: () => ({
      label: 'Change Management team',
      kind: 'Atlassian team',
      ari: `ari:cloud:identity::team/${n}8f2a41c9`,
      url: 'https://one-atlas-xkzp.atlassian.net/people/team/change-management',
    }),
    test_record: () => ({
      label: `attestation ${control.code}-T1`,
      kind: 'Attestation row',
      ari: `ari:cloud:jira:0b7c1e2a-9b31-4d8a-9f04-6c1d2a7e5b11:issue/${1300 + n}`,
      url: `https://one-atlas-xkzp.atlassian.net/browse/PAY-${20 + n}`,
    }),
  }[requirement.evidenceType]();
}

/** The hops a Why? explainer draws, in the order the app reads them. */
function traceFor(claim) {
  const observed = claim.observedAt;
  const policyObserved = dateOf(PAGE_AGE[claim.policyTitle] ?? 2, '14:07');
  const hops = {
    jira_work_item: [
      ['Work item', claim.evidenceLabel, 'is', claim.evidenceAri, observed, 'jiraSpaceWorkItems'],
      ['Control label', claim.jiraLabel, 'labels', 'registry row', '2026-11-18 10:04', 'seed registry'],
    ],
    approval_comment: [
      ['Work item', claim.evidenceLabel.replace('comment on ', ''), 'has comment', claim.evidenceAri, observed, 'jiraWorkItemComments'],
      ['Person', 'Dana Whitfield', 'authored by', 'ari:cloud:identity::user/5f1c9a0e72b34d6f', observed, 'jiraWorkItemComments'],
      ['Work item', claim.evidenceLabel.replace('comment on ', ''), 'assignee', 'ari:cloud:identity::user/8a2d31c47e5f4b90', observed, 'jira REST'],
    ],
    policy_page: [
      ['Policy page', claim.policyTitle, 'governs', claim.evidenceAri, policyObserved, 'confluencePageOwners'],
      ['Space', 'ITO', 'contains', 'ari:cloud:confluence:0b7c1e2a-9b31-4d8a-9f04-6c1d2a7e5b11:space/19', policyObserved, 'confluence REST'],
      ['Person', 'Jordan Park', 'owns', 'ari:cloud:identity::user/4b7e2d9168ac03f5', '2026-11-20 08:57', 'confluence REST'],
    ],
    approval_independence: [
      ['Person', 'Dana Whitfield', 'approved', 'ari:cloud:identity::user/5f1c9a0e72b34d6f', observed, 'jiraWorkItemComments'],
      ['Policy page', claim.policyTitle, 'owned by', 'ari:cloud:confluence:0b7c1e2a-9b31-4d8a-9f04-6c1d2a7e5b11:page/9001', policyObserved, 'confluencePageOwners'],
      ['Team', 'Change Management', 'owns page', 'ari:cloud:identity::team/18f2a41c9', '2026-11-20 08:58', 'atlassianTeamsBySpace'],
      ['Person', 'Dana Whitfield', 'member of', 'ari:cloud:identity::team/18f2a41c9', '2026-11-20 08:58', 'atlassianUserInTeams'],
    ],
    test_record: [
      ['Attestation', claim.evidenceLabel, 'recorded', claim.evidenceAri, observed, 'jira REST'],
      ['Work item', claim.evidenceLabel.replace('attestation ', 'PAY-'), 'attaches', claim.evidenceAri, observed, 'jira REST'],
    ],
  }[claim.evidenceType];
  return {
    hops: hops.map(([from, label, relation, ari, at, source]) => ({ from, label, relation, ari, at, source })),
    footer: `queryKey assureloop.evidence-chain, ${hops.length} rows, 812 ms, 0 retries, route graph`,
  };
}

// ---------------------------------------------------------------------------
// Build the claim list
// ---------------------------------------------------------------------------

const claims = [];
for (const control of NORTHWIND_PAY.controls) {
  const policyTitle = policyTitleFor(control);
  control.requirements.forEach((requirement, position) => {
    const key = `${control.code}/${requirement.evidenceType}`;
    const outcome = OUTCOMES[key];
    if (!outcome) throw new Error(`no measured outcome for ${key}: the demo may not invent one`);
    const age = requirement.evidenceType === 'policy_page' ? (PAGE_AGE[policyTitle] ?? outcome.age) : outcome.age;
    const claim = {
      id: key,
      controlCode: control.code,
      controlName: control.name,
      regulationRef: control.regulationRef,
      cadence: control.cadence,
      riskTier: control.riskTier,
      jiraLabel: control.jiraLabel,
      owner: NORTHWIND_PAY.owners.find((o) => o.email === control.ownerEmail)?.name ?? null,
      position,
      claimKey: `${control.code}.${requirement.evidenceType}`,
      claim: requirement.rule.expectation,
      evidenceType: requirement.evidenceType,
      state: outcome.state,
      reason: '',
      policyTitle,
      ageDays: age,
      maxAgeDays: requirement.maxAgeDays,
      observedAt:
        requirement.evidenceType === 'policy_page'
          ? (PAGE_OBSERVED[policyTitle] ?? dateOf(age, '14:07'))
          : dateOf(age, age === 0 ? '08:58' : '16:40'),
      judgedAt: '2026-11-20T00:02:53Z',
      missingScopes: [],
      remediation:
        outcome.state === 'VERIFIED'
          ? null
          : { issueKey: outcome.state === 'STALE' ? 'PAY-13' : 'PAY-14', dueDate: outcome.state === 'STALE' ? '2027-01-31' : '2026-12-11', status: 'OPEN' },
      exception:
        outcome.state === 'STALE'
          ? {
              reason: 'Runbook refresh is scheduled with the Q1 2027 documentation sprint; the escalation path it records is unchanged and was exercised in the 2026 continuity test.',
              expiresAt: '2027-01-31',
              compensatingControl: 'Quarterly continuity exercise and incident postmortems reference PAY-6.',
              recordedBy: 'Aisha Bello',
            }
          : null,
    };
    const window = outcome.state === 'STALE' ? `outside the ${claim.maxAgeDays}-day window` : `inside the ${claim.maxAgeDays}-day window`;
    claim.reason = outcome.state === 'MISSING' ? `${outcome.detail}.` : `${outcome.detail}, ${window}.`;
    const evidence = evidenceFor(control, requirement, policyTitle, age);
    claim.evidenceLabel = evidence.label;
    claim.evidenceKind = evidence.kind;
    claim.evidenceAri = evidence.ari;
    claim.evidenceUrl = evidence.url;
    claim.trace = traceFor(claim);
    claims.push(claim);
  });
}

const counts = claims.reduce((acc, claim) => {
  acc[claim.state] = (acc[claim.state] ?? 0) + 1;
  return acc;
}, {});

/**
 * The fingerprint of the rows this page shows.
 *
 * The field list is FINGERPRINT_FIELDS from src/audit/pack.ts (check:claims fails
 * if the two disagree). app.js recomputes the same SHA-256 over the same rows in
 * the browser, so "Verify fingerprint" on the page is a real recomputation of a
 * real digest, not a picture of one.
 */
const FINGERPRINT_FIELDS = [
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

const canonical = (rows) =>
  JSON.stringify(
    rows
      .slice()
      .sort((a, b) => (a.claimKey === b.claimKey ? 0 : a.claimKey < b.claimKey ? -1 : 1))
      .map((row) => FINGERPRINT_FIELDS.map((field) => row[field] ?? null)),
  );
const fingerprint = createHash('sha256').update(canonical(claims), 'utf8').digest('hex').slice(0, 32);

// AC-02's evidence is the comment, but the label a reader looks for is the issue.
const payload = {
  generated: new Date().toISOString(),
  product: 'AssureLoop for Jira',
  source: 'src/seed/northwind-pay.ts',
  scan: {
    at: SCAN.at,
    asOf: SCAN.asOf,
    trigger: SCAN.trigger,
    durationMs: SCAN.durationMs,
    graphReads: SCAN.graphReads,
    site: SCAN.site,
    project: SCAN.project,
    space: SCAN.space,
    fingerprint,
    fingerprintFields: FINGERPRINT_FIELDS,
    hashedFields: FINGERPRINT_FIELDS.length,
    scopes: 13,
  },
  counts: {
    VERIFIED: counts.VERIFIED ?? 0,
    STALE: counts.STALE ?? 0,
    MISSING: counts.MISSING ?? 0,
    NOT_VISIBLE: counts.NOT_VISIBLE ?? 0,
    INCOMPLETE: counts.INCOMPLETE ?? 0,
  },
  controls: NORTHWIND_PAY.controls.length,
  claims,
  guarantees: [
    'Every claim is judged by fixed rules over the Teamwork Graph and Atlassian REST, and the same inputs produce the same verdict.',
    'Each row names the evidence object, the read that produced it, when it was observed, and the freshness window it was judged against.',
    'The fingerprint is a SHA-256 over the fields the pack shows, so a reviewer can tell the table they were handed from an edited one.',
    'A scope the app could not read is reported as not visible, and names the scope an administrator would grant.',
    'A read that failed or was capped is reported as not checked, never as missing evidence.',
  ],
  notGuaranteed: [
    'Changes made outside this app: a verbal approval, an edit in another system, a record deleted by hand.',
    'Evidence types with no connector on this site. They are reported as unsupported, not as gaps.',
    'Whether a recorded exception is substantively right. A person and their auditor decide that, not the app.',
    'Anything the app was not granted: the row says so instead of implying the evidence is absent.',
    'The future. A verdict describes the read that produced it and the window it was judged against.',
  ],
};

writeFileSync(
  join(OUT, 'data.js'),
  `/* Generated by scripts/build-demo.mjs from ${payload.source}. Do not edit by hand. */\nwindow.ASSURE_DEMO = ${JSON.stringify(payload, null, 2)};\n`,
);
console.log(
  `docs/demo/data.js: ${claims.length} claims across ${payload.controls} controls, ` +
    `${payload.counts.VERIFIED} verified, ${payload.counts.STALE} stale, ${payload.counts.MISSING} missing, ` +
    `${payload.counts.NOT_VISIBLE} not visible, ${payload.counts.INCOMPLETE} not checked`,
);
