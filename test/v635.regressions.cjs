/**
 * v6.35 regressions — the honesty core of the verdict engine.
 *
 *   node test/v635.regressions.cjs
 *
 * Every case here is a defect the v6.34 cross-review found by running the compiled
 * code, and each one is pinned so it cannot come back:
 *
 *   1. `statesApproval` accepted a *request* for approval as an approval:
 *      "Seeking approval from legal", "Requesting approval before deploy",
 *      "Approval not granted", "approved? no" all read as VERIFIED and were
 *      printed on the audit pack as an independent approval.
 *   2. A revoked (empty) ownership hop produced STALE ("nobody is accountable")
 *      instead of NOT_VISIBLE ("we were not allowed to look"), which is the exact
 *      opposite of the product's promise, and it was reachable by revoking one
 *      scope.
 *   3. A REST candidate outvoted a graph denial in the scope ledger (A7), so
 *      "0 not visible" could be claimed without a single graph row.
 *   4. A fresh project's empty population was reported as MISSING.
 *   5. A remote link whose *title* said "pull request" counted as one (A13).
 *   6. The audit pack displayed `regulationRef` per row but did not hash it (A4).
 */

const assert = require('node:assert/strict');
const Module = require('node:module');

const state = {
  /** 'ok' | 'empty' | 'denied' */
  graph: 'ok',
  rest: { ownerId: null, lastOwnerId: null, authorId: null },
  /** For the cross-product claim: does the approving account sit in the team? */
  teamMemberId: 'acc-approver',
};

const DAY = 86400000;
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  };
}

const page = {
  id: '501',
  title: 'Change Management Policy v7',
  spaceId: '77',
  version: { createdAt: daysAgo(10), number: 3 },
  _links: { webui: '/spaces/ITO/pages/501/Change+Management+Policy+v7' },
};

const remoteLinks = { links: [] };

const jira = {
  requestJira: async (route) => {
    const path = String(route);
    if (/remotelink/.test(path)) {
      return json(remoteLinks.links);
    }
    if (/\/comment/.test(path)) {
      return json({
        comments: [
          {
            id: '9001',
            author: { accountId: 'acc-approver', displayName: 'Jordan Park', active: true },
            body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Approved — independent of the executor.' }] }] },
            created: daysAgo(4),
          },
        ],
      });
    }
    return json({ issues: [] });
  },
  requestConfluence: async (route) => {
    const path = String(route);
    if (/\/spaces/.test(path)) {
      return json({ results: [{ id: '77', key: 'ITO', name: 'ITO' }] });
    }
    if (/\/pages\/501\b/.test(path)) {
      return json({ id: '501', title: page.title, ...state.rest });
    }
    if (/title=|space-id=/.test(path)) {
      return json({ results: [page] });
    }
    return json({ results: [] });
  },
  requestTeamworkGraph: async (query) => {
    if (state.graph === 'denied') {
      return json({ errors: [{ message: 'Missing scope read:graph:page:confluence' }] });
    }
    if (/confluencePageOwners/.test(query)) {
      if (state.graph === 'empty') {
        return json({ data: { confluencePageOwners: { edges: [], pageInfo: { hasNextPage: false } } } });
      }
      return json({
        data: {
          confluencePageOwners: {
            edges: [{ node: { __typename: 'AtlassianUser', accountId: 'acc-owner', name: 'Jordan Park' } }],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    }
    if (state.graph === 'empty') {
      return json({ data: {} });
    }
    if (/atlassianUserInTeams|atlassianTeamsBySpace/.test(query)) {
      return json({
        data: {
          atlassianTeamsBySpace: {
            edges: [{ node: { __typename: 'AtlassianTeam', id: 'ari:cloud:identity::team/t1', displayName: 'Change Advisory' } }],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    }
    if (/atlassianTeamMembers/.test(query)) {
      return json({
        data: {
          atlassianTeamMembers: {
            edges: [{ node: { __typename: 'AtlassianUser', accountId: state.teamMemberId, name: 'Member' } }],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    }
    return json({ data: {} });
  },
};

const fakeApi = {
  asApp: () => jira,
  asUser: () => jira,
  route(strings, ...values) {
    return strings.reduce((acc, part, index) => acc + part + (values[index] ?? ''), '');
  },
};

const fakeSql = {
  prepare: () => ({
    bindParams: () => ({
      execute: async () => {
        throw new Error('no database in this test');
      },
    }),
  }),
  migrationRunner: { enqueue: () => {}, run: async () => {} },
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

const { GRAPH_SCOPES, judgeRequirement, scopeProbeFromObservation } = require('../dist/twg/queries.js');
const { statesApproval } = require('../dist/engine/gate.js');
const { FINGERPRINT_FIELDS, fingerprintRow } = require('../dist/audit/pack.js');

const control = {
  id: 'control-1',
  code: 'AC-01',
  name: 'Every change has an independent approval',
  regulation_ref: 'DORA Art.9',
  cadence: 'CONTINUOUS',
  risk_tier: 'HIGH',
  jira_label: 'ctrl-ac-01',
  jira_project_key: 'PAY',
  owner_account_id: null,
  owner_display_name: null,
  status: 'ACTIVE',
};

const policyRequirement = {
  id: 'req-policy',
  control_id: 'control-1',
  evidence_type: 'policy_page',
  max_age_days: 365,
  min_count: 1,
  rule_json: JSON.stringify({ pageTitlePrefix: 'Change Management Policy', spaceKey: 'ITO' }),
};

const workItemRequirement = {
  id: 'req-work',
  control_id: 'control-1',
  evidence_type: 'jira_work_item',
  max_age_days: 120,
  min_count: 1,
  rule_json: JSON.stringify({ requiresDoneStatus: true }),
};

const cases = [];
const check = (name, actual, expected) => cases.push([name, actual, expected]);
const now = new Date();

function observationFor(overrides = {}) {
  return {
    requirementId: 'req-policy',
    evidenceType: 'policy_page',
    scope: GRAPH_SCOPES.PAGE,
    read: { label: 'owners', mode: 'curated', outcome: 'ROWS', latencyMs: 12, retries: 0 },
    candidates: [
      {
        ari: 'ari:cloud:confluence:cloud-1:page/501',
        kind: 'confluence_page',
        label: page.title,
        observedAt: daysAgo(10),
        ownerAccountId: null,
        ownerActive: null,
        ownershipResolved: false,
        usable: true,
      },
    ],
    provenance: [],
    failures: [],
    visibilityProven: true,
    ...overrides,
  };
}

async function main() {
  // --- 1. an approval is a statement, not a request ------------------------
  const pattern = /\b(approved|approval|lgtm)\b/i;
  const approvals = [
    ['Approved by Jane', true],
    ['No objections — approved', true],
    ['LGTM, ship it', true],
    ['Approval pending', false],
    ['not approved', false],
    ['Seeking approval from legal', false],
    ['Requesting approval before deploy', false],
    ['Approval not granted', false],
    ['approved? no', false],
    ['Awaiting approval from the change board', false],
    ['Sent for approval to the CAB', false],
    ['Approval required before the release window', false],
    ['Approved, and no further review is needed', true],
    ['Jordan reviewed the plan and approved it', true],
    ['We are not seeking approval for this one', false],
  ];
  for (const [text, expected] of approvals) {
    check(`"${text}" is ${expected ? 'an approval' : 'not an approval'}`, statesApproval(text, pattern), expected);
  }

  // --- 2. a revoked ownership hop is not "nobody accountable" --------------
  state.rest = { ownerId: null, lastOwnerId: null, authorId: null };
  state.graph = 'empty';
  const { observePolicy } = require('../dist/index.js');
  const scanContext = {
    cloudId: 'cloud-1',
    principalAccountId: 'acc-principal',
    population: new Map(),
    populationFailures: new Map(),
    discovered: new Map(),
    emptyPopulation: new Set(),
    ledger: {},
    retried: 0,
  };

  const unproven = await observePolicy(scanContext, control, policyRequirement);
  const unprovenVerdict = judgeRequirement({
    control,
    requirement: policyRequirement,
    observation: unproven,
    ledger: {},
    now,
  });
  check('an ownerless page on an unproven page scope is NOT_VISIBLE', unprovenVerdict.state, 'NOT_VISIBLE');
  check('it names the scope to grant', unprovenVerdict.missingScopes.join(','), GRAPH_SCOPES.PAGE);
  check(
    'it does not say nobody is accountable',
    /nobody is accountable/i.test(unprovenVerdict.reason),
    false,
  );
  check('its probe is inconclusive, not PROVEN', scopeProbeFromObservation('scan', unproven)?.state, 'INCONCLUSIVE');

  const provenVerdict = judgeRequirement({
    control,
    requirement: policyRequirement,
    observation: unproven,
    ledger: { [GRAPH_SCOPES.PAGE]: 'PROVEN' },
    now,
  });
  check('a proven page scope that names nobody is STALE', provenVerdict.state, 'STALE');
  check(
    'the STALE sentence says the hop named nobody',
    /nobody is named as accountable|no rows/i.test(provenVerdict.reason),
    true,
  );

  state.graph = 'ok';
  const resolved = await observePolicy(scanContext, control, policyRequirement);
  const resolvedVerdict = judgeRequirement({
    control,
    requirement: policyRequirement,
    observation: resolved,
    ledger: {},
    now,
  });
  check('a graph-named owner verifies the policy claim', resolvedVerdict.state, 'VERIFIED');
  check('rows through the scope prove it', scopeProbeFromObservation('scan', resolved)?.state, 'PROVEN');
  check('the owner came from the graph', resolved.candidates[0]?.ownerAccountId, 'acc-owner');

  // --- 3. the ledger: a denial outranks a REST candidate (A7) --------------
  const deniedProbe = scopeProbeFromObservation(
    'gate',
    observationFor({
      failures: [
        { cause: 'PERMISSION_DENIED', message: 'status code is: 403', scope: GRAPH_SCOPES.PAGE, retryable: false },
      ],
      scopeRows: 0,
    }),
  );
  check('a denial is DENIED even with a REST candidate', deniedProbe?.state, 'DENIED');
  const rowsProbe = scopeProbeFromObservation('gate', observationFor({ scopeRows: 3 }));
  check('graph rows prove the scope', rowsProbe?.state, 'PROVEN');

  // --- 4. an empty project is not a failed control -------------------------
  const emptyProjectObservation = {
    requirementId: 'req-work',
    evidenceType: 'jira_work_item',
    scope: null,
    read: { label: 'jql:ctrl-ac-01', mode: 'rest', outcome: 'EMPTY', latencyMs: 30, retries: 0 },
    candidates: [],
    provenance: [],
    failures: [],
    populationEmpty: true,
  };
  const emptyVerdict = judgeRequirement({
    control,
    requirement: workItemRequirement,
    observation: emptyProjectObservation,
    ledger: {},
    now,
  });
  check('nothing to judge is INCOMPLETE', emptyVerdict.state, 'INCOMPLETE');
  check('and it says there is nothing to judge yet', /nothing to judge yet/i.test(emptyVerdict.reason), true);

  const absentVerdict = judgeRequirement({
    control,
    requirement: workItemRequirement,
    observation: { ...emptyProjectObservation, populationEmpty: false },
    ledger: {},
    now,
  });
  check('a populated project with no evidence is still MISSING', absentVerdict.state, 'MISSING');

  // --- 5. a link title is not a pull request (A13) -------------------------
  const { observeConnectorClaim } = require('../dist/engine/gate.js');
  const connectorRequirement = {
    id: 'req-pr',
    control_id: 'control-1',
    evidence_type: 'pull_request',
    max_age_days: 120,
    min_count: 1,
    rule_json: JSON.stringify({}),
  };
  const connectorContext = {
    cloudId: 'cloud-1',
    siteUrl: 'https://example.atlassian.net',
    issue: {
      id: '10001',
      key: 'PAY-1',
      summary: 'Enable 3-D Secure fallback',
      statusName: 'Done',
      statusCategoryKey: 'done',
      assigneeAccountId: 'acc-assignee',
      assigneeName: 'Priya Raman',
      assigneeActive: true,
      projectKey: 'PAY',
      labels: ['ctrl-ac-01'],
      updated: daysAgo(3),
      components: [],
    },
    issueAri: 'ari:cloud:jira:cloud-1:issue/10001',
  };

  remoteLinks.links = [
    { object: { url: 'https://wiki.example.test/display/PAY/payout-fix', title: 'Pull request for the payout fix' } },
  ];
  const titleOnly = await observeConnectorClaim(connectorContext, connectorRequirement);
  check('a title that says "pull request" yields no candidate', titleOnly.candidates.length, 0);
  check(
    'the row says the title is not the evidence',
    titleOnly.notes.some((note) => /URL is the evidence/.test(note)),
    true,
  );
  const titleOnlyVerdict = judgeRequirement({
    control,
    requirement: connectorRequirement,
    observation: titleOnly,
    ledger: {},
    now,
  });
  check('it is not verified by its title', titleOnlyVerdict.state, 'MISSING');

  remoteLinks.links = [{ object: { url: 'https://github.com/northwind/pay/pull/42', title: 'Payout fix' } }];
  const realLink = await observeConnectorClaim(connectorContext, connectorRequirement);
  check('a connector URL is a candidate', realLink.candidates.length, 1);

  // --- 5b. the cross-product claim needs the graph, and only the graph -------
  const { observeIndependenceClaim } = require('../dist/engine/gate.js');
  const independenceRequirement = {
    id: 'req-independence',
    control_id: 'control-1',
    evidence_type: 'approval_independence',
    max_age_days: 120,
    min_count: 1,
    rule_json: JSON.stringify({
      pageTitlePrefix: 'Change Management Policy',
      spaceKey: 'ITO',
      approvalPattern: '\\b(approved|approval|lgtm)\\b',
    }),
  };
  const independenceContext = {
    cloudId: 'cloud-1',
    siteUrl: 'https://example.atlassian.net',
    issue: {
      id: '10001',
      key: 'PAY-1',
      summary: 'Enable 3-D Secure fallback',
      statusName: 'Done',
      statusCategoryKey: 'done',
      assigneeAccountId: 'acc-assignee',
      assigneeName: 'Priya Raman',
      assigneeActive: true,
      projectKey: 'PAY',
      labels: ['ctrl-ac-01'],
      updated: daysAgo(3),
      components: [],
    },
    issueAri: 'ari:cloud:jira:cloud-1:issue/10001',
  };

  state.teamMemberId = 'acc-approver';
  const inTeam = await observeIndependenceClaim(independenceContext, independenceRequirement);
  const inTeamVerdict = judgeRequirement({
    control,
    requirement: independenceRequirement,
    observation: inTeam,
    ledger: { [GRAPH_SCOPES.TEAM]: 'PROVEN' },
    now,
  });
  check('an approver in the accountable team is VERIFIED', inTeamVerdict.state, 'VERIFIED');
  check(
    'the row says which team the approver answers in',
    /member of Change Advisory/.test(inTeam.candidates[0]?.label ?? ''),
    true,
  );
  check(
    'the trace names the membership hop',
    inTeam.provenance.some((hop) => hop.relation === 'atlassian_team_member_is_atlassian_user'),
    true,
  );

  state.teamMemberId = 'acc-someone-else';
  const outside = await observeIndependenceClaim(independenceContext, independenceRequirement);
  const outsideVerdict = judgeRequirement({
    control,
    requirement: independenceRequirement,
    observation: outside,
    ledger: { [GRAPH_SCOPES.TEAM]: 'PROVEN' },
    now,
  });
  check('an approver outside every accountable team is STALE', outsideVerdict.state, 'STALE');
  check(
    'the STALE sentence names the team the approver is not in',
    /not in .*Change Advisory/.test(outsideVerdict.reason),
    true,
  );

  // The same claim with no graph at all: no REST fallback, and no invented owner.
  state.graph = 'empty';
  state.teamMemberId = 'acc-approver';
  const noGraph = await observeIndependenceClaim(independenceContext, independenceRequirement);
  const noGraphVerdict = judgeRequirement({
    control,
    requirement: independenceRequirement,
    observation: noGraph,
    ledger: {},
    now,
  });
  check('without the graph the claim is NOT_VISIBLE', noGraphVerdict.state, 'NOT_VISIBLE');
  check('and it names the team scope', noGraphVerdict.missingScopes.join(','), GRAPH_SCOPES.TEAM);
  state.graph = 'ok';

  // --- 5c. "no space" is a setup gap, not a missing page -------------------
  const noSpaceRequirement = {
    ...policyRequirement,
    rule_json: JSON.stringify({ pageTitlePrefix: 'Change Management Policy', spaceKey: null }),
  };
  state.graph = 'ok';
  const noSpace = await observePolicy(scanContext, control, noSpaceRequirement);
  const noSpaceVerdict = judgeRequirement({
    control,
    requirement: noSpaceRequirement,
    observation: noSpace,
    ledger: {},
    now,
  });
  check('a programme with no space bound is not checked', noSpaceVerdict.state, 'INCOMPLETE');
  check(
    'and it says no policy space is bound',
    /no policy space is bound/i.test(noSpaceVerdict.reason),
    true,
  );

  // --- 6. the fingerprint covers the regulation reference (A4) -------------
  check('regulationRef is hashed', FINGERPRINT_FIELDS.includes('regulationRef'), true);
  const row = fingerprintRow({
    controlCode: 'AC-01',
    controlName: 'Change',
    regulationRef: 'DORA Art.9',
    claim: 'Governing policy',
    evidenceType: 'policy_page',
    state: 'VERIFIED',
    reason: 'ok',
  });
  check('the hashed row carries it', row.regulationRef, 'DORA Art.9');
  const other = fingerprintRow({
    controlCode: 'AC-01',
    controlName: 'Change',
    regulationRef: 'SOX ITGC CM-01',
    claim: 'Governing policy',
    evidenceType: 'policy_page',
    state: 'VERIFIED',
    reason: 'ok',
  });
  check('changing it changes the hashed row', JSON.stringify(row) === JSON.stringify(other), false);

  let failed = 0;
  for (const [name, actual, expected] of cases) {
    try {
      assert.deepEqual(actual, expected);
      console.log(`  ok   ${name}`);
    } catch {
      failed += 1;
      console.log(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} assertions passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('v6.35 regression harness failed:', error);
  process.exit(1);
});
