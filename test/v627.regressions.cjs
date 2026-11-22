/**
 * v6.27 regression tests — the defects the GCP Hermes cross-review (v6.26) found,
 * pinned so they cannot come back.
 *
 *   node test/v627.regressions.cjs
 *
 * Each case names the finding it covers:
 *
 *   A5  a message that merely mentions "scope" is not a permission gap
 *   A6  a throttled probe is INCONCLUSIVE, not DENIED
 *   A7  a REST read does not promote a graph scope to PROVEN
 *   A8  the second gap of one control is not swallowed by the first issue
 *   A9  a retry policy belongs to one call chain, not to the module
 *   A10 a truncated persisted traversal says so
 *   A12 "not approved" / "approval rejected" do not satisfy an approval claim
 *   B1  the registry scan and the issue panel judge the same evidence the same way
 *   B2  a 403 on remote links is NOT_VISIBLE, not "no connector on this site"
 *   B3  the caller's account reaches the Confluence reads behind remediation
 *   B4  naming a control code does not claim an unlabelled work item
 */

const assert = require('node:assert/strict');
const Module = require('node:module');

const DAY = 86400000;
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

// ---------------------------------------------------------------------------
// The fake site
// ---------------------------------------------------------------------------

const state = {
  linksStatus: 200,
  links: [],
  commentText: 'Approved — independent of the executor.',
  /** Issues the remediation guard should see as already open. */
  remediationIssues: [],
  /** How the persisted graph answers customQuery. */
  persisted: 'unset',
  /** 'ok' | 'no-identity' — how confluencePageOwners answers. */
  owners: 'ok',
  userCalls: [],
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
    components: [],
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
    if (state.persisted === 'truncated') {
      return json({
        data: {
          customQuery: {
            edges: [
              {
                node: {
                  columns: [
                    {
                      key: 'pageAri',
                      value: { __typename: 'CypherQueryResultNode', id: '1001', data: { __typename: 'ConfluencePage', id: '1001', title: 'Change Management Policy v3' } },
                    },
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
          },
        },
      });
    }
    return json({ data: { customQuery: { edges: [], pageInfo: { hasNextPage: false } } } });
  }
  if (/confluencePageOwners/.test(query)) {
    if (state.owners === 'no-identity') {
      // What an unattended invocation produces: no user to impersonate, so the
      // request fails with a message that classifies as UNKNOWN.
      return json({ errors: [{ message: 'No user is available for asUser() in this invocation' }] });
    }
    return json({
      data: {
        confluencePageOwners: {
          edges: [{ node: { __typename: 'AtlassianUser', accountId: 'acc-marcus', name: 'Marcus Webb' } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }
  if (/atlassianTeamsBySpace/.test(query)) {
    return json({
      data: {
        atlassianTeamsBySpace: {
          edges: [{ node: { __typename: 'AtlassianTeam', id: 'ari:cloud:identity::team/t1', displayName: 'Change Advisory' } }],
          pageInfo: { hasNextPage: false },
        },
      },
    });
  }
  return json({ data: { __typename: 'Query' } });
}

const requester = {
  requestJira: async (route, options = {}) => {
    const path = String(route);
    if (/\/search\/jql/.test(path)) {
      const jql = JSON.parse(options.body ?? '{}').jql ?? '';
      if (/labels = "assureloop"/.test(jql)) {
        return json({ issues: state.remediationIssues });
      }
      return json({ issues: [issueBody] });
    }
    if (/\/comment/.test(path)) {
      return json({
        comments: [
          {
            id: '9001',
            author: { accountId: 'acc-jordan', displayName: 'Jordan Park', active: true },
            body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: state.commentText }] }] },
            created: daysAgo(4),
          },
        ],
      });
    }
    if (/\/remotelink/.test(path)) {
      if (state.linksStatus !== 200) {
        return json({ errorMessages: ['denied'] }, state.linksStatus);
      }
      return json(state.links);
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
      const title = decodeURIComponent(/title=([^&]*)/.exec(path)?.[1] ?? '');
      return json({ results: title === pageBody.title ? [pageBody] : [] });
    }
    return json({ results: [pageBody] });
  },
  requestTeamworkGraph: async (query) => graphResponse(query),
};

const fakeApi = {
  asApp: () => requester,
  asUser: (accountId) => {
    state.userCalls.push(accountId ?? null);
    return requester;
  },
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

const {
  ACTION_RETRY_POLICY,
  GRAPH_RETRY_POLICY,
  activeGraphRetryPolicy,
  buildScopeLedger,
  classifyFailure,
  judgeRequirement,
  scopeProbeFromObservation,
  withGraphRetryPolicy,
} = require('../dist/twg/queries.js');
const { statesApproval, evaluateIssueGate, closeGapsForIssue, observeConnectorClaim, observePolicyClaim, remediationToken } = require('../dist/engine/gate.js');
const { observeConnectors, observePolicy } = require('../dist/index.js');
const { getIssue } = require('../dist/jira/rest.js');

const control = {
  id: 'control-1',
  code: 'AC-01',
  name: 'Every production change carries an independent approval and a governing policy',
  regulation_ref: 'DORA Art.9 / SOX ITGC CM-01',
  cadence: 'QUARTERLY',
  risk_tier: 'HIGH',
  jira_label: 'ctrl-ac-01',
  jira_project_key: 'PAY',
  owner_account_id: null,
  owner_display_name: null,
  status: 'ACTIVE',
};

const prRequirement = {
  id: 'req-pr',
  control_id: 'control-1',
  evidence_type: 'pull_request',
  max_age_days: 30,
  min_count: 1,
  rule_json: '{}',
};

const cases = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // --- A5: a message that mentions "scope" is not a permission gap ----------
  cases.push([
    'a service error that mentions a scope is not a permission gap',
    classifyFailure(undefined, 'The requested query scope is unavailable right now'),
    'UNKNOWN',
  ]);
  cases.push([
    'a missing scope is still a permission gap',
    classifyFailure(undefined, 'The app lacks the scope read:graph:page:confluence'),
    'PERMISSION_DENIED',
  ]);
  cases.push([
    'a bare 403 is still a permission gap',
    classifyFailure(403, 'Request failed for confluencePageOwners: status code is: 403'),
    'PERMISSION_DENIED',
  ]);
  cases.push([
    'a 500 that mentions permissions of a backend is not the caller',
    classifyFailure(500, 'upstream service failed'),
    'SERVICE_ERROR',
  ]);

  // --- A6 / A7: the ledger is a measurement ---------------------------------
  {
    const viaRest = scopeProbeFromObservation('gate:policy_page', {
      requirementId: 'r1',
      evidenceType: 'policy_page',
      scope: 'read:graph:page:confluence',
      read: { label: 'owners', mode: 'curated', outcome: 'ROWS', latencyMs: 9, retries: 0 },
      candidates: [],
      provenance: [],
      failures: [],
      visibilityProven: true,
    });
    cases.push([
      'a REST read does not prove a graph scope',
      viaRest?.state,
      'INCONCLUSIVE',
    ]);
    cases.push([
      'a denial beats an inconclusive probe in either order',
      [
        buildScopeLedger([viaRest, { ...viaRest, state: 'DENIED' }])['read:graph:page:confluence'],
        buildScopeLedger([{ ...viaRest, state: 'DENIED' }, viaRest])['read:graph:page:confluence'],
      ].join(','),
      'DENIED,DENIED',
    ]);
    const denied = { ...viaRest, state: 'DENIED' };
    const proven = {
      ...viaRest,
      state: 'PROVEN',
      candidates: [{ ari: 'ari:x', kind: 'confluence_page', observedAt: daysAgo(1), usable: true }],
    };
    cases.push([
      'rows prove the scope and stay proven against a later denial',
      [
        buildScopeLedger([denied, proven])['read:graph:page:confluence'],
        buildScopeLedger([proven, denied])['read:graph:page:confluence'],
      ].join(','),
      'PROVEN,PROVEN',
    ]);
    cases.push([
      'a throttled read does not deny a scope',
      buildScopeLedger([
        {
          ...viaRest,
          state: 'INCONCLUSIVE',
          error: { message: 'Too many requests', cause: 'RATE_LIMIT_EXCEEDED' },
        },
      ])['read:graph:page:confluence'],
      'INCONCLUSIVE',
    ]);
  }

  // --- A9: the retry policy belongs to one call chain -----------------------
  {
    const seen = [];
    await Promise.all([
      withGraphRetryPolicy(ACTION_RETRY_POLICY, async () => {
        await sleep(15);
        seen.push(`action:${activeGraphRetryPolicy().attempts}`);
      }),
      withGraphRetryPolicy(GRAPH_RETRY_POLICY, async () => {
        seen.push(`scan-first:${activeGraphRetryPolicy().attempts}`);
        await sleep(30);
        seen.push(`scan-after:${activeGraphRetryPolicy().attempts}`);
      }),
    ]);
    cases.push([
      'a concurrent action does not inherit the scan policy',
      seen.sort().join(' '),
      'action:1 scan-after:3 scan-first:3',
    ]);
    cases.push([
      'outside any scope the default policy is the scan policy',
      activeGraphRetryPolicy().attempts,
      GRAPH_RETRY_POLICY.attempts,
    ]);
  }

  // --- A12: an approval is stated, not mentioned ----------------------------
  {
    const pattern = /\b(approved|approval|lgtm)\b/i;
    const positives = [
      'Approved — independent of the executor.',
      'LGTM, approved by the change board.',
      'Approval: finance and risk signed off.',
      'No objections — approved.',
      'Approved in CAB on Tuesday.',
    ];
    const negatives = [
      'This is not approved yet.',
      'Approval was rejected by the risk team.',
      'Approval rejected — pending a control owner.',
      "Can't be approved until the policy is current.",
      'Pending approval from security.',
      'Approval withdrawn on Friday.',
    ];
    for (const text of positives) {
      cases.push([`states an approval: "${text}"`, statesApproval(text, pattern), true]);
    }
    for (const text of negatives) {
      cases.push([`does not state an approval: "${text}"`, statesApproval(text, pattern), false]);
    }
  }

  // --- B2: a 403 on remote links is a permission gap ------------------------
  {
    const { issue } = await getIssue('PAY-1183');
    const context = {
      cloudId: 'cloud-1',
      siteUrl: null,
      issue,
      issueAri: 'ari:cloud:jira:cloud-1:issue/1183',
      accountId: null,
    };
    state.linksStatus = 403;
    const denied = await observeConnectorClaim(context, prRequirement);
    cases.push(['a 403 is not read as "no links"', denied.failures?.[0]?.cause, 'PERMISSION_DENIED']);
    cases.push([
      'the scope that unblocks it is named',
      denied.failures?.[0]?.scope,
      'read:jira-work',
    ]);
    const deniedVerdict = judgeRequirement({
      control,
      requirement: prRequirement,
      observation: denied,
      ledger: {},
      now: new Date(),
    });
    cases.push(['a denied remote-link read is NOT_VISIBLE', deniedVerdict.state, 'NOT_VISIBLE']);
    cases.push([
      'the verdict names the REST scope, not a graph scope',
      deniedVerdict.missingScopes.join(','),
      'read:jira-work',
    ]);
    state.linksStatus = 200;
  }

  // --- B1: the scan and the panel judge the same work item the same way ----
  {
    const { issue } = await getIssue('PAY-1183');
    const panelContext = {
      cloudId: 'cloud-1',
      siteUrl: null,
      issue,
      issueAri: 'ari:cloud:jira:cloud-1:issue/1183',
      accountId: null,
    };
    const scanContext = () => ({
      cloudId: 'cloud-1',
      principalAccountId: 'acc-priya',
      population: new Map(),
      populationFailures: new Map(),
      discovered: new Map(),
      ledger: {},
      retried: 0,
    });
    const judge = (observation) =>
      judgeRequirement({ control, requirement: prRequirement, observation, ledger: {}, now: new Date() });

    const compare = async (label) => {
      const panel = judge(await observeConnectorClaim(panelContext, prRequirement));
      const scan = judge(await observeConnectors(scanContext(), control, prRequirement));
      cases.push([`${label}: panel state`, panel.state, scan.state]);
      return { panel, scan };
    };

    state.links = [];
    const unsupported = await compare('no remote links anywhere');
    cases.push(['no remote links is not a gap', unsupported.panel.state === 'MISSING', false]);
    cases.push([
      'the cause is UNSUPPORTED on both paths',
      `${unsupported.panel.failures?.[0]?.cause}/${unsupported.scan.failures?.[0]?.cause}`,
      'UNSUPPORTED/UNSUPPORTED',
    ]);

    state.links = [{ object: { url: 'https://example.com/wiki/runbook', title: 'Deployment runbook' } }];
    const unmatched = await compare('links exist, none of this kind');
    cases.push(['links that do not match are MISSING on the panel', unmatched.panel.state, 'MISSING']);

    state.links = [{ object: { url: 'https://github.com/northwind/pay/pull/412', title: 'PR #412' } }];
    const matched = await compare('a matching pull request');
    cases.push(['a linked pull request is VERIFIED on the panel', matched.panel.state, 'VERIFIED']);

    state.linksStatus = 403;
    const bothDenied = await compare('a denied remote-link read');
    cases.push(['a denied read is NOT_VISIBLE on both paths', bothDenied.panel.state, 'NOT_VISIBLE']);
    state.linksStatus = 200;
    state.links = [];
  }

  // --- A8 / B4 / B3: remediation guards ------------------------------------
  {
    const created = [];
    const createIssue = async (input) => {
      const key = `PAY-${9000 + created.length}`;
      created.push(input);
      // The Jira the guard reads on the next call: what this app just filed.
      state.remediationIssues.push({
        id: String(9000 + created.length),
        key,
        fields: {
          summary: input.summary,
          status: { name: 'To Do', statusCategory: { key: 'new' } },
          labels: ['assureloop', 'remediation'],
          project: { key: 'PAY', id: '10001' },
          updated: new Date().toISOString(),
        },
      });
      return { key, id: String(9000 + created.length) };
    };

    // Two gaps on one control: the policy is 412 days old and the only approval
    // comment withdraws the approval it mentions.
    state.commentText = 'This is not approved yet — policy update first.';
    state.userCalls = [];
    const first = await closeGapsForIssue({
      issueKey: 'PAY-1183',
      cloudId: 'cloud-1',
      accountId: 'acc-priya',
      dueInDays: 7,
      createIssue,
    });
    cases.push(['the same control can have two gaps', first.created.length, 2]);
    cases.push([
      'each gap carries its own finding token',
      new Set(created.map((input) => /\[(AL-[0-9a-f]{8})\]/.exec(input.summary)?.[1]).filter(Boolean)).size,
      2,
    ]);
    cases.push([
      'the second gap is not reported as already tracked',
      first.skipped.some((entry) => /already tracked/.test(entry.why)),
      false,
    ]);
    cases.push([
      'the caller account reaches the Confluence read',
      state.userCalls.includes('acc-priya'),
      true,
    ]);

    const before = created.length;
    const again = await closeGapsForIssue({
      issueKey: 'PAY-1183',
      cloudId: 'cloud-1',
      accountId: 'acc-priya',
      createIssue,
    });
    cases.push(['a second click creates nothing', created.length - before, 0]);
    cases.push([
      'both gaps are recognised as tracked',
      again.skipped.filter((entry) => /already tracked/.test(entry.why)).length,
      2,
    ]);

    // B4: naming a control code is not a claim.
    const unlabelled = { ...issueBody, fields: { ...issueBody.fields, labels: [] } };
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
    created.length = 0;
    const bypass = await closeGapsForIssue({
      issueKey: 'PAY-1183',
      controlCode: 'AC-01',
      cloudId: 'cloud-1',
      createIssue,
    });
    cases.push(['a named control code cannot claim an unlabelled work item', created.length, 0]);
    cases.push([
      'the refusal is the claim-first message',
      (bypass.skipped[0]?.why ?? '').includes('claim the work item'),
      true,
    ]);
    const template = await evaluateIssueGate({
      issueKey: 'PAY-1183',
      controlCode: 'AC-01',
      cloudId: 'cloud-1',
    });
    cases.push(['the panel shows the control as unclaimed', template.control?.claimed, false]);
    cases.push([
      'the template note says nothing is permanent',
      /template/.test(template.note ?? ''),
      true,
    ]);
    requester.requestJira = original;
    state.commentText = 'Approved — independent of the executor.';
    state.remediationIssues = [];
  }

  // --- A8 helper: the token is stable --------------------------------------
  cases.push([
    'the finding token is deterministic',
    remediationToken('PAY-1183:programme:AC-01:policy_page:2'),
    remediationToken('PAY-1183:programme:AC-01:policy_page:2'),
  ]);
  cases.push([
    'two findings of one control get different tokens',
    remediationToken('PAY-1183:req-policy') === remediationToken('PAY-1183:req-approval'),
    false,
  ]);

  // --- A3 / A10: persisted-query notes ------------------------------------
  {
    delete process.env.ASSUR_QUERY_KEY_EVIDENCE_CHAIN;
    const absent = await evaluateIssueGate({ issueKey: 'PAY-1183', cloudId: 'cloud-1' });
    const policyAbsent = absent.requirements.find((row) => row.evidenceType === 'policy_page');
    cases.push([
      'an unregistered persisted query is explained, not silent',
      (policyAbsent?.notes ?? []).some((note) => /not registered for this environment/.test(note)),
      true,
    ]);

    process.env.ASSUR_QUERY_KEY_EVIDENCE_CHAIN = 'qk-truncated';
    state.persisted = 'truncated';
    const truncated = await evaluateIssueGate({ issueKey: 'PAY-1183', cloudId: 'cloud-1' });
    const policyTruncated = truncated.requirements.find((row) => row.evidenceType === 'policy_page');
    cases.push([
      'a truncated persisted traversal says it is a prefix',
      (policyTruncated?.notes ?? []).some((note) => /prefix of it/.test(note)),
      true,
    ]);
    cases.push([
      'the truncated chain did not change the verdict',
      policyTruncated?.state,
      policyAbsent?.state,
    ]);
    delete process.env.ASSUR_QUERY_KEY_EVIDENCE_CHAIN;
    state.persisted = 'unset';
  }

  // --- the ownership hop: unread is not unowned ---------------------------
  {
    const policyRequirement = {
      id: 'req-policy',
      control_id: 'control-1',
      evidence_type: 'policy_page',
      // Ten years: this fixture page is 412 days old, and these cases are about the
      // ownership hop, not about freshness (which has its own cases).
      max_age_days: 3650,
      min_count: 1,
      rule_json: JSON.stringify({ pageTitlePrefix: 'Change Management Policy', spaceKey: 'ITO' }),
    };
    const scanContext = {
      cloudId: 'cloud-1',
      principalAccountId: 'acc-scan-principal',
      population: new Map(),
      populationFailures: new Map(),
      discovered: new Map(),
      ledger: {},
      retried: 0,
    };

    state.owners = 'ok';
    state.userCalls = [];
    const answered = await observePolicy(scanContext, control, policyRequirement);
    cases.push(['an answered hop resolves the owner', answered.candidates[0]?.ownershipResolved, true]);
    const answeredVerdict = judgeRequirement({
      control,
      requirement: policyRequirement,
      observation: answered,
      ledger: { 'read:graph:page:confluence': 'PROVEN' },
      now: new Date(),
    });
    cases.push(['an owned, current policy is VERIFIED', answeredVerdict.state, 'VERIFIED']);

    state.owners = 'no-identity';
    state.userCalls = [];
    const unread = await observePolicy(scanContext, control, policyRequirement);
    cases.push(['a failed ownership read is flagged', unread.accountabilityUnread, true]);
    const unreadVerdict = judgeRequirement({
      control,
      requirement: policyRequirement,
      observation: unread,
      ledger: { 'read:graph:page:confluence': 'PROVEN' },
      now: new Date(),
    });
    cases.push([
      'an unread ownership hop is INCOMPLETE, not "nobody is accountable"',
      unreadVerdict.state,
      'INCOMPLETE',
    ]);
    cases.push([
      'the verdict says the hop could not be read',
      /ownership hop could not be read/.test(unreadVerdict.reason),
      true,
    ]);

    // The same failure through the issue panel must agree with the scan.
    const { issue } = await getIssue('PAY-1183');
    const panel = judgeRequirement({
      control,
      requirement: policyRequirement,
      observation: await observePolicyClaim(
        { cloudId: 'cloud-1', siteUrl: null, issue, issueAri: 'ari:cloud:jira:cloud-1:issue/1183', accountId: null },
        policyRequirement,
      ),
      ledger: { 'read:graph:page:confluence': 'PROVEN' },
      now: new Date(),
    });
    cases.push(['the panel agrees with the scan on an unread hop', panel.state, 'INCOMPLETE']);
    state.owners = 'ok';
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

main().catch((error) => {
  console.error('v6.27 regression harness failed:', error);
  process.exit(1);
});
