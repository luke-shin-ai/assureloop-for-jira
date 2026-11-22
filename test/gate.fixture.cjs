/**
 * Gate fixture test — the whole panel path, against a fake Atlassian.
 *
 *   node test/gate.fixture.cjs
 *
 * `judge.smoke.cjs` tests the engine as pure functions. This one wires a fake
 * `@forge/api` underneath `engine/gate.ts` and checks what the panel would
 * actually render: a passing work item, a work item whose policy ownership the
 * graph refuses (NOT_VISIBLE), and one where the comment read is throttled
 * (INCOMPLETE). No site, no Forge runtime, no network.
 */

const assert = require('node:assert/strict');
const Module = require('node:module');

const now = Date.now();
const daysAgo = (days) => new Date(now - days * 86400000).toISOString();

// ---------------------------------------------------------------------------
// The fake Atlassian
// ---------------------------------------------------------------------------

const state = { graphMode: 'ok', commentsStatus: 200, persistedMode: 'error', remoteLinks: [], remediationIssue: null };

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  };
}

const issueBody = {
  id: '1183',
  key: 'PAY-1183',
  fields: {
    summary: 'Rotate merchant webhook signing secret',
    status: { name: 'Done', statusCategory: { key: 'done' } },
    assignee: { accountId: 'acc-priya', displayName: 'Priya Raman', active: true },
    updated: daysAgo(3),
    created: daysAgo(9),
    issuetype: { name: 'Change' },
    labels: ['ctrl-ac-01'],
    project: { key: 'PAY', id: '10001' },
    components: [{ id: '9', name: 'Payments', lead: { accountId: 'acc-jordan', displayName: 'Jordan Park', active: true } }],
  },
};

const pageBody = {
  id: '1001',
  title: 'Change Management Policy v3',
  spaceId: '77',
  version: { createdAt: daysAgo(412), number: 12 },
  _links: { webui: '/spaces/CM/pages/1001/Change+Management+Policy+v3' },
};

function graphResponse(query) {
  if (/customQuery/.test(query)) {
    // A registered persisted query that this environment cannot run (feature
    // unavailable). The verdict must not move because of it.
    if (state.persistedMode === 'error') {
      return json({ errors: [{ message: 'FEATURE_UNAVAILABLE: persisted query is not enabled here' }] });
    }
    return json({ data: { customQuery: { edges: [], pageInfo: { hasNextPage: false } } } });
  }
  if (state.graphMode === 'denied' && /confluencePageOwners/.test(query)) {
    return json({
      errors: [{ message: 'The app lacks the scope read:graph:page:confluence' }],
    }, 200);
  }
  // C1's exact shape: a 403 phrased in the graph's own words. This used to be
  // classified as a service error, retried three times and reported "partly checked".
  if (state.graphMode === 'denied403' && /confluencePageOwners/.test(query)) {
    return json({
      errors: [{ message: 'Request failed for confluencePageOwners: status code is: 403' }],
    }, 200);
  }
  if (state.graphMode === 'truncated' && /confluencePageOwners/.test(query)) {
    return json({
      data: {
        confluencePageOwners: {
          edges: [{ node: { __typename: 'AtlassianUser', accountId: 'acc-marcus', name: 'Marcus Webb' } }],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
        },
      },
    });
  }
  if (/atlassianTeamMembers/.test(query)) {
    // The approver (acc-jordan) is a member of the team the graph links to the
    // policy's space — the cross-product claim's happy path.
    return json({
      data: {
        atlassianTeamMembers: {
          edges: [
            { node: { __typename: 'AtlassianUser', accountId: 'acc-jordan', name: 'Jordan Park' } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }
  if (!/confluencePageOwners|atlassianTeamsBySpace|atlassianUserInTeams|jiraSpaceWorkItems/.test(query)) {
    return json({ data: { __typename: 'Query' } });
  }
  if (/confluencePageOwners/.test(query)) {
    return json({
      data: {
        confluencePageOwners: {
          edges: [{ node: { __typename: 'AtlassianUser', accountId: 'acc-marcus', name: 'Marcus Webb' } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }
  return json({
    data: {
      atlassianTeamsBySpace: {
        edges: [{ node: { __typename: 'AtlassianTeam', id: 'ari:cloud:identity::team/team-1', displayName: 'Change Advisory' } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  });
}

const requester = {
  requestJira: async (route, options = {}) => {
    const path = String(route);
    if (/\/search\/jql/.test(path)) {
      const jql = JSON.parse(options.body ?? '{}').jql ?? '';
      if (/labels = "assureloop"/.test(jql)) {
        return json({ issues: state.remediationIssue ? [state.remediationIssue] : [] });
      }
      return json({ issues: [issueBody] });
    }
    if (/\/comment/.test(path)) {
      if (state.commentsStatus !== 200) {
        return json({ message: 'Too many requests' }, state.commentsStatus);
      }
      return json({
        comments: [
          {
            id: '9001',
            author: { accountId: 'acc-jordan', displayName: 'Jordan Park', active: true },
            body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Approved — independent of the executor.' }] }] },
            created: daysAgo(4),
          },
        ],
      });
    }
    if (/\/remotelink/.test(path)) {
      return json(state.remoteLinks);
    }
    if (/\/project\//.test(path)) {
      return json({ id: '10001' });
    }
    return json(issueBody);
  },
  requestConfluence: async (route) => {
    const path = String(route);
    if (/\/spaces/.test(path)) {
      return json({ results: [{ id: '77' }] });
    }
    if (/title=/.test(path)) {
      // v2's title filter is exact; the fixture honours that so the prefix
      // fallback below is genuinely exercised.
      const title = decodeURIComponent(/title=([^&]*)/.exec(path)?.[1] ?? '');
      return json({ results: title === pageBody.title ? [pageBody] : [] });
    }
    if (/space-id=/.test(path)) {
      return json({ results: [pageBody] });
    }
    if (/\/pages/.test(path)) {
      return json({ results: [pageBody] });
    }
    return json({ results: [] });
  },
  requestTeamworkGraph: async (query) => graphResponse(query),
};

const fakeApi = {
  asApp: () => requester,
  asUser: () => requester,
  route(strings, ...values) {
    return strings.reduce((acc, part, index) => acc + part + (values[index] ?? ''), '');
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '@forge/api') {
    return { ...fakeApi, default: fakeApi };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const { evaluateIssueGate } = require('../dist/engine/gate.js');

const cases = [];

async function run() {
  state.graphMode = 'ok';
  state.commentsStatus = 200;
  const pass = await evaluateIssueGate({ issueKey: 'PAY-1183', cloudId: 'cloud-1', siteUrl: 'https://northwind.atlassian.net' });
  cases.push(['the work item is read', pass.issue?.key, 'PAY-1183']);
  cases.push(['its control comes from the label', pass.control?.code, 'AC-01']);
  cases.push(['the control is claimed', pass.control?.claimed, true]);
  cases.push(['claims are judged without a scan', pass.requirements.length >= 3, true]);
  cases.push(['the control name travels with the gate', pass.control?.regulationRef, 'DORA Art.9 / SOX ITGC CM-01']);

  const approval = pass.requirements.find((row) => row.evidenceType === 'approval_comment');
  cases.push(['the approval claim is VERIFIED', approval?.state, 'VERIFIED']);
  cases.push(['the approval claim shows its evidence', Boolean(approval?.evidence?.label), true]);
  cases.push(['the approval trace starts at the issue', approval?.trace.graph.root, 'ari:cloud:jira:cloud-1:issue/1183']);
  cases.push(['the approval trace has a comment node', approval?.trace.graph.nodes.some((node) => node.kind === 'comment'), true]);
  cases.push(['the approval trace has the approver', approval?.trace.graph.nodes.some((node) => node.kind === 'user'), true]);
  cases.push(['the trace reports rows and latency', typeof approval?.trace.rows === 'number' && typeof approval.trace.latencyMs === 'number', true]);

  const workItem = pass.requirements.find((row) => row.evidenceType === 'jira_work_item');
  cases.push(['the completed change claim is VERIFIED', workItem?.state, 'VERIFIED']);

  const policy = pass.requirements.find((row) => row.evidenceType === 'policy_page');
  cases.push(['a 412-day-old policy is STALE, not MISSING', policy?.state, 'STALE']);
  cases.push(['the policy title prefix resolves to the v3 page', policy?.evidence?.label, 'Change Management Policy v3']);
  cases.push(['the policy links to the page', policy?.evidence?.url, 'https://northwind.atlassian.net/spaces/CM/pages/1001/Change+Management+Policy+v3']);
  cases.push(['the policy trace names the owning user', policy?.trace.graph.nodes.some((node) => node.label === 'Marcus Webb'), true]);
  cases.push(['the policy trace names the team', policy?.trace.graph.nodes.some((node) => node.kind === 'team'), true]);
  cases.push([
    'the rule-derived hop says it was derived here',
    policy?.trace.graph.links.find((link) => link.relation === 'policy_required_by_control')?.source,
    'rule',
  ]);
  cases.push([
    'the ownership hop says it came from the graph',
    policy?.trace.graph.links.find((link) => link.relation === 'atlassian_user_owns_confluence_page')?.source,
    'graph',
  ]);
  cases.push(['the badge reflects the stale claim', pass.badge.state, 'GAPS']);
  // B1: the gate that feeds the pack carries the trust boundary, so every surface
  // can state what the evidence does and does not guarantee.
  cases.push(['the gate carries what the pack guarantees', pass.guarantees?.does?.length > 0, true]);
  cases.push(['the gate carries what the pack does NOT guarantee', pass.guarantees?.doesNot?.length > 0, true]);
  cases.push([
    'the boundary names changes outside the app',
    (pass.guarantees?.doesNot ?? []).some((line) => /outside this app/.test(line)),
    true,
  ]);

  // Graph denies the ownership hop: the claim must say so, not call it missing.
  state.graphMode = 'denied';
  const denied = await evaluateIssueGate({ issueKey: 'PAY-1183', cloudId: 'cloud-1' });
  const deniedPolicy = denied.requirements.find((row) => row.evidenceType === 'policy_page');
  cases.push(['a denied ownership hop is NOT_VISIBLE', deniedPolicy?.state, 'NOT_VISIBLE']);
  cases.push([
    'the missing scope is named for the admin',
    deniedPolicy?.missingScopes.map((scope) => scope.scope).join(','),
    'read:graph:page:confluence',
  ]);
  cases.push(['the panel badge says it cannot verify', denied.badge.state, 'UNVERIFIABLE']);

  // Comment read throttled: "not checked", never "no approval".
  state.graphMode = 'ok';
  state.commentsStatus = 429;
  const throttled = await evaluateIssueGate({ issueKey: 'PAY-1183', cloudId: 'cloud-1' });
  const throttledApproval = throttled.requirements.find((row) => row.evidenceType === 'approval_comment');
  cases.push(['a throttled comment read is INCOMPLETE', throttledApproval?.state, 'INCOMPLETE']);
  cases.push([
    'the cause is RATE_LIMIT_EXCEEDED',
    throttledApproval?.failures[0]?.cause,
    'RATE_LIMIT_EXCEEDED',
  ]);
  cases.push(['integrity counts the incomplete claim', throttled.integrity.incomplete, 1]);

  // --- the persisted query is optional enrichment, never a verdict input -----
  process.env.ASSUR_QUERY_KEY_EVIDENCE_CHAIN = 'qk-fixture';
  state.graphMode = 'ok';
  state.commentsStatus = 200;
  state.persistedMode = 'error';
  {
    const withPersisted = await evaluateIssueGate({ issueKey: 'PAY-1183', cloudId: 'cloud-1' });
    const policyWithPersisted = withPersisted.requirements.find((row) => row.evidenceType === 'policy_page');
    cases.push([
      'a failing persisted query does not change the verdict',
      policyWithPersisted?.state,
      policy?.state,
    ]);
    cases.push([
      'the persisted failure is not an observation failure',
      (policyWithPersisted?.failures ?? []).some((failure) => /persisted|FEATURE_UNAVAILABLE/i.test(failure.message)),
      false,
    ]);
    cases.push([
      'the persisted failure is recorded as a note',
      (policyWithPersisted?.notes ?? []).some((note) => /Persisted Cypher/.test(note)),
      true,
    ]);
    cases.push([
      'the trace footer carries the same note',
      (policyWithPersisted?.trace.notes ?? []).some((note) => /Persisted Cypher/.test(note)),
      true,
    ]);
    cases.push(['the query key is reported so a reviewer can check it', policyWithPersisted?.trace.queryKey, 'qk-fixture']);
  }
  delete process.env.ASSUR_QUERY_KEY_EVIDENCE_CHAIN;

  // --- C1 end to end: the graph's own 403 phrasing must flip to NOT_VISIBLE ---
  state.graphMode = 'denied403';
  state.commentsStatus = 200;
  {
    const deniedByMessage = await evaluateIssueGate({ issueKey: 'PAY-1183', cloudId: 'cloud-1' });
    const policyRow = deniedByMessage.requirements.find((row) => row.evidenceType === 'policy_page');
    cases.push(['a "status code is: 403" denial is NOT_VISIBLE, not partly checked', policyRow?.state, 'NOT_VISIBLE']);
    cases.push([
      'the 403 is not retried three times',
      policyRow?.trace.retries,
      0,
    ]);
    cases.push([
      'the panel names the scope to grant',
      policyRow?.missingScopes.map((scope) => scope.scope).join(','),
      'read:graph:page:confluence',
    ]);
    cases.push(['the badge says it cannot verify', deniedByMessage.badge.state, 'UNVERIFIABLE']);
  }

  // --- C11: a truncated ownership read says so -------------------------------
  state.graphMode = 'truncated';
  {
    const truncated = await evaluateIssueGate({ issueKey: 'PAY-1183', cloudId: 'cloud-1' });
    const policyRow = truncated.requirements.find((row) => row.evidenceType === 'policy_page');
    cases.push([
      'a truncated read is announced, not silent',
      (policyRow?.notes ?? []).some((note) => /more rows than/.test(note)),
      true,
    ]);
  }

  // --- C4: PR/deployment claims are read from remote links, not the issue -----
  state.graphMode = 'ok';
  {
    const { observeConnectorClaim } = require('../dist/engine/gate.js');
    const { getIssue } = require('../dist/jira/rest.js');
    const { issue } = await getIssue('PAY-1183');
    const context = {
      cloudId: 'cloud-1',
      siteUrl: null,
      issue,
      issueAri: 'ari:cloud:jira:cloud-1:issue/1183',
      accountId: null,
    };
    const requirement = {
      id: 'req-pr',
      control_id: 'control-1',
      evidence_type: 'pull_request',
      max_age_days: 30,
      min_count: 1,
      rule_json: '{}',
    };
    const none = await observeConnectorClaim(context, requirement);
    cases.push(['no remote links at all is UNSUPPORTED', none.failures?.[0]?.cause, 'UNSUPPORTED']);
    cases.push(['the read is not the work item itself', none.candidates.length, 0]);
    cases.push([
      'the note says no connector writes links here',
      (none.notes ?? []).some((note) => /No connector writes remote links/.test(note)),
      true,
    ]);
    state.remoteLinks = [
      { object: { url: 'https://github.com/northwind/pay/pull/412', title: 'PR #412 rotate signing secret' } },
    ];
    const linked = await observeConnectorClaim(context, requirement);
    cases.push(['a linked pull request is found', linked.candidates.length, 1]);
    cases.push(['its label is the link title', linked.candidates[0]?.label, 'PR #412 rotate signing secret']);
    cases.push(['its hop is a rest link, not a rule match', linked.provenance[0]?.source, 'rest']);
    cases.push([
      'the freshness source is disclosed',
      (linked.notes ?? []).some((note) => /no observation time of its own/.test(note)),
      true,
    ]);
    state.remoteLinks = [];
  }

  // --- C6 / M4 / C13: closing gaps is idempotent and refuses a template ------
  {
    const { closeGapsForIssue } = require('../dist/engine/gate.js');
    const created = [];
    const createIssue = async (input) => {
      created.push(input);
      return { key: `PAY-9${created.length}`, id: `900${created.length}` };
    };
    const first = await closeGapsForIssue({
      issueKey: 'PAY-1183',
      cloudId: 'cloud-1',
      dueInDays: 7,
      createIssue,
    });
    cases.push(['the stale claim is closed once', first.created.length, 1]);
    cases.push([
      'the due date honours dueInDays instead of a hardcoded window',
      created[0]?.dueDate,
      new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    ]);
    cases.push([
      'the remediation carries the audit labels',
      created[0]?.labels.includes('remediation'),
      true,
    ]);

    // Jira now holds an open remediation for this control: closing again must skip.
    state.remediationIssue = {
      id: '777',
      key: 'PAY-77',
      fields: {
        summary: '[AssureLoop] AC-01 · Governing policy — evidence stale',
        status: { name: 'To Do', statusCategory: { key: 'new' } },
        labels: ['assureloop', 'remediation'],
        project: { key: 'PAY', id: '10001' },
        updated: new Date().toISOString(),
      },
    };
    const second = await closeGapsForIssue({
      issueKey: 'PAY-1183',
      cloudId: 'cloud-1',
      createIssue,
    });
    cases.push(['the second click creates nothing', second.created.length, 0]);
    cases.push([
      'the skip names the issue that already tracks it',
      second.skipped.some((entry) => /already tracked as PAY-77/.test(entry.why)),
      true,
    ]);
    state.remediationIssue = null;
  }

  // --- M4: an unclaimed control is a template, not a finding -----------------
  {
    const { closeGapsForIssue } = require('../dist/engine/gate.js');
    const created = [];
    const unlabelled = { ...issueBody, fields: { ...issueBody.fields, labels: [] } };
    // Serve an unlabelled issue for this one call.
    const original = requester.requestJira;
    requester.requestJira = async (route, options) => {
      const path = String(route);
      if (/\/search\/jql/.test(path)) {
        return json({ issues: [unlabelled] });
      }
      if (/\/issue\/PAY-1183$/.test(path)) {
        return json(unlabelled);
      }
      return original(route, options);
    };
    const report = await closeGapsForIssue({
      issueKey: 'PAY-1183',
      cloudId: 'cloud-1',
      createIssue: async (input) => {
        created.push(input);
        return { key: 'PAY-99', id: '990' };
      },
    });
    requester.requestJira = original;
    cases.push(['an unclaimed control creates no remediation', created.length, 0]);
    cases.push([
      'the refusal tells the user to claim the work item first',
      (report.skipped[0]?.why ?? '').includes('claim the work item'),
      true,
    ]);
  }

  let failures = 0;
  for (const [name, actual, expected] of cases) {
    try {
      assert.deepEqual(actual, expected);
      console.log(`  ok   ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  console.log(`\n${cases.length - failures}/${cases.length} assertions passed`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error('fixture harness failed:', error);
  process.exit(1);
});
