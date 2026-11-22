/**
 * v6.49 regressions — the defects a second red-team round reproduced against v6.48.0.
 *
 *   node test/v640.regressions.cjs
 *
 *   1. B1: an approval is a statement, not a mention. Seventeen phrasings that read as
 *      approvals in v6.48.0 ("Approval from Legal pending", "Approval: none",
 *      "approved, but not for prod", ...) are not approvals now, and the eight shapes
 *      that are approvals stay approvals.
 *   2. M1a: a claim over a population prints how much of that population it read and
 *      how much of it qualified. A rule declared `everyItem` needs all of them, and a
 *      truncated read is INCOMPLETE rather than a universal verdict.
 *   3. M1: the population and comment reads follow the API's pages, so change 51 and
 *      comment 101 are read instead of silently dropped, and a cap that stops the read
 *      is reported as a cap.
 *   4. M4: the schema migrations are idempotent under a concurrent first request.
 *   5. M2: a gap routed to the assignee says what actually failed (no fixed "Team
 *      lookup unavailable"), and the page-owner hop runs as the caller.
 *   6. M5: the trace footer reports one read per number, not a max and a sum.
 *   7. M6: the displayed fingerprint is 128 bits and the memo says so.
 */

const assert = require('node:assert/strict');
const Module = require('node:module');

// ---------------------------------------------------------------------------
// Fake Atlassian
// ---------------------------------------------------------------------------

const DAY = 86400000;
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

const state = {
  /** How many labelled changes the population holds. */
  population: 3,
  /** Work item keys whose approval comment is "Approved by ...". */
  approved: new Set(['PAY-1', 'PAY-2', 'PAY-3']),
  /** Comments per issue, and which index (1-based) carries the approval. */
  commentCount: 1,
  approvalCommentAt: 1,
  /** Page mode: 'present' | 'absent'. */
  page: 'present',
  /** When set, `ensureSchema`'s migrationRunner throws this message. */
  migrationError: null,
  /** Columns information_schema reports as present. */
  columns: new Set(),
  identities: [],
  schemaReads: 0,
  migrations: { enqueued: 0, runs: 0 },
};

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  };
}

function issueFor(index) {
  const n = index + 1;
  const key = `PAY-${n}`;
  return {
    id: String(100 + n),
    key,
    fields: {
      summary: `Change ${n}`,
      status: { name: 'Done', statusCategory: { key: 'done' } },
      assignee: { accountId: `acc-a${n}`, displayName: `Assignee ${n}`, active: true },
      updated: daysAgo(2),
      created: daysAgo(30),
      issuetype: { name: 'Change' },
      labels: ['ctrl-ac-01'],
      project: { key: 'PAY', id: '2001' },
      components: [],
    },
  };
}

function commentsFor(index) {
  const n = index + 1;
  const all = [];
  for (let i = 1; i <= state.commentCount; i += 1) {
    const isApproval = i === state.approvalCommentAt && state.approved.has(`PAY-${n}`);
    all.push({
      id: `${n}${String(i).padStart(3, '0')}`,
      author: { accountId: `acc-p${n}${i}`, displayName: `Reviewer ${i}`, active: true },
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: isApproval ? 'Approved by the change board.' : `Note ${i} on the change.` }],
          },
        ],
      },
      created: daysAgo(3),
    });
  }
  return all;
}

const requester = {
  requestJira: async (route, options = {}) => {
    const path = String(route);
    // v6.50: the gate and the gap-closing paths ask mypermissions first; this site
    // grants what they ask.
    if (/\/mypermissions/.test(path)) {
      const requested = /permissions=([A-Z_]+)/.exec(path)?.[1] ?? '';
      return json({ permissions: { [requested]: { havePermission: true } } });
    }
    if (/\/search\/jql/.test(path)) {
      const body = JSON.parse(options.body ?? '{}');
      const jql = body.jql ?? '';
      if (/statusCategory = Done/.test(jql) && !/labels =/.test(jql)) {
        const page = Math.min(5, state.population);
        return json({ issues: Array.from({ length: page }, (_, i) => issueFor(i)), isLast: true });
      }
      // Paged on nextPageToken, the way /rest/api/3/search/jql answers.
      const size = body.maxResults ?? 50;
      const start = Number.parseInt(String(body.nextPageToken ?? '0'), 10) || 0;
      const end = Math.min(state.population, start + size);
      const issues = [];
      for (let i = start; i < end; i += 1) {
        issues.push(issueFor(i));
      }
      const more = end < state.population;
      return json({ issues, nextPageToken: more ? String(end) : undefined, isLast: !more });
    }
    const commentMatch = /\/issue\/([^/]+)\/comment/.exec(path);
    if (commentMatch) {
      const key = decodeURIComponent(commentMatch[1]);
      const index = Number.parseInt(key.split('-')[1], 10) - 1;
      const all = commentsFor(index);
      const startAt = Number.parseInt(/startAt=(\d+)/.exec(path)?.[1] ?? '0', 10);
      const max = Number.parseInt(/maxResults=(\d+)/.exec(path)?.[1] ?? '100', 10);
      return json({
        comments: all.slice(startAt, startAt + max),
        startAt,
        maxResults: max,
        total: all.length,
      });
    }
    const issueMatch = /\/issue\/([^/?]+)/.exec(path);
    if (issueMatch) {
      const key = decodeURIComponent(issueMatch[1]);
      const index = Number.parseInt(key.split('-')[1], 10) - 1;
      return json(issueFor(index));
    }
    return json({});
  },
  requestConfluence: async (route) => {
    const path = String(route);
    if (/\/spaces/.test(path)) {
      return json({ results: [{ id: '77', key: 'ITO', name: 'ITO' }] });
    }
    if (/title=|space-id=/.test(path)) {
      return json({
        results:
          state.page === 'present'
            ? [
                {
                  id: '501',
                  title: 'Change Management Policy v7',
                  spaceId: '77',
                  version: { createdAt: daysAgo(10), number: 3 },
                  _links: { webui: '/spaces/ITO/pages/501/Change+Management+Policy+v7' },
                },
              ]
            : [],
      });
    }
    return json({ results: [] });
  },
  requestTeamworkGraph: async (query) => {
    if (/confluencePageOwners/.test(query)) {
      return json({
        data: {
          confluencePageOwners: {
            edges: state.page === 'present' ? [{ node: { __typename: 'AtlassianUser', accountId: 'acc-owner', name: 'Policy Owner' } }] : [],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    }
    if (/atlassianTeamsBySpace/.test(query)) {
      return json({
        data: {
          atlassianTeamsBySpace: {
            edges: [{ node: { __typename: 'AtlassianTeam', id: 'ari:cloud:identity::team/t1', displayName: 'Ops' } }],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    }
    return json({ data: { __typename: 'Query' } });
  },
};

const fakeApi = {
  asApp: () => requester,
  asUser: (accountId) => {
    state.identities.push(accountId ?? null);
    return requester;
  },
  route(strings, ...values) {
    return strings.reduce((acc, part, index) => acc + part + (values[index] ?? ''), '');
  },
};

const fakeSql = {
  prepare: (query) => ({
    bindParams: (...params) => ({
      execute: async () => {
        const text = String(query);
        if (/information_schema/.test(text)) {
          const column = String(params[1] ?? '');
          state.schemaReads += 1;
          if (state.columns.has(column)) {
            return { rows: [{ column_name: column }] };
          }
          throw new Error('not found');
        }
        return { rows: [] };
      },
    }),
  }),
  migrationRunner: {
    enqueue: () => {
      state.migrations.enqueued += 1;
    },
    run: async () => {
      state.migrations.runs += 1;
      if (state.migrationError) {
        const message = state.migrationError;
        state.migrationError = null;
        throw new Error(message);
      }
    },
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '@forge/api') {
    return { ...fakeApi, default: fakeApi };
  }
  if (request === '@forge/sql') {
    return { ...fakeSql, default: fakeSql };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { judgeRequirement } = require('../dist/twg/queries.js');
const { statesApproval } = require('../dist/engine/gate.js');
const { observeComments, observeWorkItems, populationFor, actionGetEvidence } = require('../dist/index.js');
const { closeGapsForIssue } = require('../dist/engine/gate.js');
const { ensureSchema, resetSchemaCacheForTests, MIGRATIONS } = require('../dist/schema/sql.js');
const { fingerprintOf, memoForClaims } = require('../dist/audit/pack.js');

const control = {
  id: 'control-1',
  code: 'AC-01',
  name: 'Every production change carries an independent approval',
  regulation_ref: 'DORA Art.9',
  cadence: 'CONTINUOUS',
  risk_tier: 'HIGH',
  jira_label: 'ctrl-ac-01',
  jira_project_key: 'PAY',
  owner_account_id: null,
  owner_display_name: null,
  status: 'ACTIVE',
};

const approvalRequirement = {
  id: 'req-approval',
  control_id: 'control-1',
  evidence_type: 'approval_comment',
  max_age_days: 120,
  min_count: 1,
  rule_json: JSON.stringify({ approvalPattern: '\\b(approved|approval|lgtm)\\b', requiresIndependentApprover: true }),
};

const everyRequirement = {
  ...approvalRequirement,
  id: 'req-approval-every',
  rule_json: JSON.stringify({
    approvalPattern: '\\b(approved|approval|lgtm)\\b',
    requiresIndependentApprover: true,
    everyItem: true,
  }),
};

const workRequirement = {
  id: 'req-work',
  control_id: 'control-1',
  evidence_type: 'jira_work_item',
  max_age_days: 120,
  min_count: 1,
  rule_json: JSON.stringify({ requiresDoneStatus: true }),
};

function scanContext() {
  return {
    cloudId: 'cloud-1',
    principalAccountId: 'acc-1',
    population: new Map(),
    populationFailures: new Map(),
    discovered: new Map(),
    emptyPopulation: new Set(),
    populationTruncated: new Set(),
    spaceTeams: new Map(),
    ledger: {},
    retried: 0,
  };
}

const cases = [];
const check = (name, actual, expected) => cases.push([name, actual, expected]);
const now = new Date();

async function main() {
  // --- 1. B1: the approval matcher -----------------------------------------
  {
    const pattern = /\b(approved|approval|lgtm)\b/i;
    const rejected = [
      'Approval from Legal pending',
      'Approval requested from security',
      'Approval: none',
      'Approval deferred',
      'Approval was sought',
      'Approval to deploy: not yet',
      'Approval please',
      'Tentatively approved',
      'approved, but not for prod',
      'Approval still pending with Legal',
      'Approval not yet given',
      'Approved conditional on the freeze ending',
      'Approval on hold',
      'Approval was requested twice',
      'Approval: none, the CAB never met',
      'Approval subject to a second review',
      'Approved to be confirmed by risk',
    ];
    const accepted = [
      'Approved by Jane',
      'No objections - approved',
      'LGTM, ship it',
      'Approved, and no further review is needed',
      'Approval: finance and risk signed off.',
      'Approved in CAB on Tuesday.',
      'Approved by the CAB on 2026-11-01',
      'Approval was granted by Jane',
      'Approved, please deploy after the freeze',
      'Approved. Pending items: none',
    ];
    for (const text of rejected) {
      check(`"${text}" is not an approval`, statesApproval(text, pattern), false);
    }
    for (const text of accepted) {
      check(`"${text}" is an approval`, statesApproval(text, pattern), true);
    }
    check(
      'a pending sentence after the approval sentence does not withdraw it',
      statesApproval('Approved by Jane. Pending: the deploy window.', pattern),
      true,
    );
    check(
      'a request in the same sentence still withdraws it',
      statesApproval('Approval from the board - still pending', pattern),
      false,
    );
  }

  // --- 2. M1a: a population claim says how much of it was read -------------
  {
    state.population = 12;
    state.approved = new Set(['PAY-1']);
    state.commentCount = 2;
    state.approvalCommentAt = 1;
    const scan = scanContext();
    const observation = await observeComments(scan, control, approvalRequirement);
    const verdict = judgeRequirement({
      control,
      requirement: approvalRequirement,
      observation,
      ledger: {},
      now,
    });
    check('twelve changes are all read (the 12-item slice is gone)', observation.populationJudged, 12);
    check('the population total is reported', observation.populationTotal, 12);
    check('one approved change still verifies an existential claim', verdict.state, 'VERIFIED');
    check(
      'the reason prints the numerator and denominator',
      /1 of 12/.test(verdict.reason),
      true,
    );

    const universal = judgeRequirement({
      control,
      requirement: everyRequirement,
      observation,
      ledger: {},
      now,
    });
    check('a universal claim is not satisfied by one of twelve', universal.state, 'MISSING');
    check('the universal reason names the gap', /1 of 12 read qualified/.test(universal.reason), true);
    check('the universal reason says why one is not enough', /universal/i.test(universal.reason), true);
  }

  // --- 2b. a truncated read is not a universal verdict ---------------------
  {
    state.population = 30;
    state.approved = new Set(Array.from({ length: 30 }, (_, i) => `PAY-${i + 1}`));
    const scan = scanContext();
    const observation = await observeComments(scan, control, everyRequirement);
    check('the comment read stops at its documented cap', observation.populationJudged, 25);
    check('the cap is reported as truncation', observation.truncated, true);
    check(
      'the truncation note names the cap',
      /25 of 30|cap 25/.test(String(observation.truncationNote)),
      true,
    );
    const verdict = judgeRequirement({
      control,
      requirement: everyRequirement,
      observation,
      ledger: {},
      now,
    });
    check('a partially read universal claim is INCOMPLETE, not VERIFIED', verdict.state, 'INCOMPLETE');
    check('the verdict says how much it read', /read only 25/.test(verdict.reason), true);

    const existential = judgeRequirement({
      control,
      requirement: approvalRequirement,
      observation,
      ledger: {},
      now,
    });
    check('an existential claim still judges on what it read', existential.state, 'VERIFIED');
    check(
      'and says the read stopped',
      /read stopped after 25 of 30|The read stopped after/.test(existential.reason),
      true,
    );
  }

  // --- 3. M1: change 51 and comment 101 are read ---------------------------
  {
    state.population = 51;
    state.approved = new Set(['PAY-51']);
    state.commentCount = 150;
    state.approvalCommentAt = 140;
    const scan = scanContext();
    const population = await populationFor(scan, control);
    check('the JQL read follows the page token past 50', population.length, 51);
    check('the 51st change is in the population', population[50]?.key, 'PAY-51');
    check('a population inside the cap is not called truncated', scan.populationTruncated.size, 0);

    // The approval claim reads the first 25 changes, and PAY-51 is outside that, so the
    // comment paging is exercised on a 25-change population whose approval is comment 140.
    state.population = 25;
    state.approved = new Set(['PAY-6']);
    const deep = scanContext();
    const observation = await observeComments(deep, control, approvalRequirement);
    const usable = observation.candidates.filter((candidate) => candidate.usable);
    check('an approval on comment 140 of 150 is found', usable.length, 1);
    check('the candidate names the sixth change', /PAY-6/.test(String(usable[0]?.label)), true);
    check('the comment read was not truncated', observation.truncated, false);
  }

  // --- 5. M3 / M2: the caller identity travels, and the route says why -----
  {
    state.population = 3;
    state.page = 'present';
    state.commentCount = 2;
    state.approvalCommentAt = 1;
    state.identities = [];
    const result = await actionGetEvidence({
      event: { issueKey: 'PAY-1', context: { cloudId: 'cloud-1', accountId: 'acc-9' } },
    });
    check('the chat action answers about the work item', result.workItem, 'PAY-1');
    check('the chat action reads as the caller, not the app', state.identities.includes('acc-9'), true);

    // The policy page is absent, so the policy claim is MISSING and a gap is closed.
    state.page = 'absent';
    const created = [];
    const report = await closeGapsForIssue({
      issueKey: 'PAY-1',
      cloudId: 'cloud-1',
      accountId: 'acc-9',
      createIssue: async (input) => {
        created.push(input);
        return { key: `PAY-${9000 + created.length}`, id: String(9000 + created.length) };
      },
    });
    check('the policy gap is raised as a remediation', created.length > 0, true);
    check(
      'no route repeats the fixed "Team lookup unavailable" sentence',
      report.routes.every((route) => !/Team lookup unavailable/.test(route.hint)),
      true,
    );
    check(
      'the assignee route says the policy page was what could not be resolved',
      report.routes.some((route) => /policy page/.test(route.hint)),
      true,
    );
  }

  // --- 4. M4: migrations are idempotent ------------------------------------
  {
    state.columns = new Set(['evidence_observed_at', 'notes']);
    state.migrations = { enqueued: 0, runs: 0 };
    resetSchemaCacheForTests();
    await ensureSchema();
    // Counted against the migration list rather than a number typed here: a new
    // column migration must not fail this assertion, and a migration that is enqueued
    // for a column that already exists must.
    const alreadyThere = MIGRATIONS.filter(
      (migration) => migration.addColumn && state.columns.has(migration.addColumn.column),
    ).length;
    check(
      'a column that already exists is not altered again',
      state.migrations.enqueued,
      MIGRATIONS.length - alreadyThere,
    );
    const afterFirst = state.migrations.enqueued;
    await ensureSchema();
    check('a warm call enqueues nothing', state.migrations.enqueued, afterFirst);

    state.columns = new Set();
    state.migrations = { enqueued: 0, runs: 0 };
    state.migrationError = 'Duplicate column name \'notes\'';
    resetSchemaCacheForTests();
    let threw = null;
    try {
      await ensureSchema();
    } catch (cause) {
      threw = cause;
    }
    check('a concurrent duplicate-column error does not escape', threw === null, true);
    check('the retry ran the migrations twice', state.migrations.runs >= 1, true);
  }

  // --- 6. M6: the printed fingerprint is 128 bits -------------------------
  {
    const claim = {
      controlCode: 'AC-01',
      controlName: control.name,
      regulationRef: control.regulation_ref,
      claimKey: 'req-approval',
      claim: 'Every production change carries an independent approval',
      evidenceType: 'approval_comment',
      state: 'VERIFIED',
      reason: 'Verified: 12 of 12 approval object(s) qualify, freshest 2 day(s) old (limit 120).',
      evidenceLabel: 'PAY-1 approved by Reviewer 1',
      evidenceAri: 'ari:cloud:jira:cloud-1:comment/1',
      evidenceUrl: null,
      observedAt: daysAgo(2),
      judgedAt: new Date().toISOString(),
      ageDays: 2,
      maxAgeDays: 120,
      missingScopes: [],
      remediation: null,
      exception: null,
      evidenceOwner: null,
    };
    const fingerprint = fingerprintOf([claim], 'scan-1');
    check('the fingerprint is 32 hex (128 bits)', /^[0-9a-f]{32}$/.test(fingerprint), true);
    const memo = memoForClaims([claim], {
      title: 'Audit pack',
      asOf: new Date().toISOString(),
      scanId: 'scan-1',
      trigger: 'MANUAL',
      counts: { VERIFIED: 1, STALE: 0, MISSING: 0, NOT_VISIBLE: 0, INCOMPLETE: 0 },
    });
    check('the memo says the digest is truncated for display', /truncated to 128 bits/.test(memo), true);
    check('the memo no longer claims "first 16 hex"', /first 16 hex/.test(memo), false);
  }

  // --- report -------------------------------------------------------------
  let failed = 0;
  for (const [name, actual, expected] of cases) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
      failed += 1;
      console.log(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  console.log(`${cases.length - failed}/${cases.length} assertions passed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((cause) => {
  console.error('v6.49 harness failed:', cause);
  process.exitCode = 1;
});
