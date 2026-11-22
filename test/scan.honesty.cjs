/**
 * Honesty regression tests — the three places a failed read used to become a
 * finding, against a fake site instead of a real one.
 *
 *   node test/scan.honesty.cjs
 *
 *   1. A policy page that Confluence REST reports as absent in a readable space is
 *      MISSING, not NOT_VISIBLE (the ownership hop returning no rows is irrelevant
 *      to whether the page exists).
 *   2. A population (JQL) failure makes the approval claim INCOMPLETE — never
 *      "no approval was found". This was the most damaging false finding in the app:
 *      it accused a customer of having no approvals on data it never read.
 *   3. A project this site does not have is UNCONFIGURED (not checked, with a bind
 *      instruction), never NOT_VISIBLE.
 *   4. A project with no control labels falls back to discovery mode: the most
 *      recent completed changes are judged, and the rows say so.
 */

const assert = require('node:assert/strict');
const Module = require('node:module');

const state = {
  /** 'ok' | 'project-missing' | 'label-probe-empty' */
  jiraMode: 'ok',
  /** 'page-present' | 'page-absent' */
  pageMode: 'page-present',
  graphMode: 'ok',
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

const DAY = 86400000;
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

const issue = {
  id: '11',
  key: 'OPS-11',
  fields: {
    summary: 'Enable alert routing',
    status: { name: 'Done', statusCategory: { key: 'done' } },
    assignee: { accountId: 'acc-1', displayName: 'A. Owner', active: true },
    updated: daysAgo(2),
    created: daysAgo(5),
    issuetype: { name: 'Task' },
    labels: [],
    project: { key: 'OPS', id: '2001' },
    components: [],
  },
};

const page = {
  id: '501',
  title: 'Change Management Policy v7',
  spaceId: '77',
  version: { createdAt: daysAgo(10), number: 3 },
  _links: { webui: '/spaces/ITO/pages/501/Change+Management+Policy+v7' },
};

const requester = {
  requestJira: async (route, options = {}) => {
    const path = String(route);
    if (/\/search\/jql/.test(path)) {
      const jql = JSON.parse(options.body ?? '{}').jql ?? '';
      if (state.jiraMode === 'project-missing') {
        return json({ errorMessages: ["The value 'NOPE' does not exist for the field 'project'."] }, 400);
      }
      if (/labels =/.test(jql)) {
        return json({ issues: state.jiraMode === 'label-probe-empty' ? [] : [issue] });
      }
      if (/statusCategory = Done/.test(jql)) {
        return json({ issues: [issue] });
      }
      return json({ issues: [issue] });
    }
    if (/\/comment/.test(path)) {
      return json({
        comments: [
          {
            id: '7001',
            author: { accountId: 'acc-2', displayName: 'B. Approver', active: true },
            body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Approved.' }] }] },
            created: daysAgo(3),
          },
        ],
      });
    }
    return json(issue);
  },
  requestConfluence: async (route) => {
    const path = String(route);
    if (/\/spaces/.test(path)) {
      return json({ results: [{ id: '77', key: 'ITO', name: 'ITO' }] });
    }
    if (/title=/.test(path)) {
      return json({ results: state.pageMode === 'page-present' ? [page] : [] });
    }
    if (/space-id=/.test(path)) {
      return json({ results: state.pageMode === 'page-present' ? [page] : [] });
    }
    return json({ results: [] });
  },
  requestTeamworkGraph: async (query) => {
    if (/confluencePageOwners/.test(query)) {
      if (state.graphMode === 'denied') {
        return json({ errors: [{ message: 'Missing scope read:graph:page:confluence' }] });
      }
      // G0 measured this field as empty on the whole site.
      return json({ data: { confluencePageOwners: { edges: [], pageInfo: { hasNextPage: false } } } });
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

const { judgeRequirement } = require('../dist/twg/queries.js');
const { observeComments, observePolicy, observeWorkItems, populationFor } = require('../dist/index.js');

const control = {
  id: 'control-1',
  code: 'AC-01',
  name: 'Every change has an independent approval',
  regulation_ref: 'DORA Art.9',
  cadence: 'CONTINUOUS',
  risk_tier: 'HIGH',
  jira_label: 'ctrl-ac-01',
  jira_project_key: 'OPS',
  owner_account_id: null,
  owner_display_name: null,
  status: 'ACTIVE',
};

const requirement = {
  id: 'req-policy',
  control_id: 'control-1',
  evidence_type: 'policy_page',
  max_age_days: 365,
  min_count: 1,
  rule_json: JSON.stringify({ pageTitlePrefix: 'Change Management Policy', spaceKey: 'ITO' }),
};

const approvalRequirement = {
  ...requirement,
  id: 'req-approval',
  evidence_type: 'approval_comment',
  max_age_days: 30,
  rule_json: JSON.stringify({ approvalPattern: 'approved', requiresIndependentApprover: true }),
};

const workItemRequirement = {
  ...requirement,
  id: 'req-work',
  evidence_type: 'jira_work_item',
  rule_json: JSON.stringify({ requiresDoneStatus: true }),
};

function context() {
  return {
    cloudId: 'cloud-1',
    principalAccountId: 'acc-1',
    population: new Map(),
    populationFailures: new Map(),
    discovered: new Map(),
    ledger: {},
    retried: 0,
  };
}

const now = new Date();
const cases = [];

async function main() {
  // --- 1. an absent page in a readable space is MISSING ---------------------
  state.jiraMode = 'ok';
  state.pageMode = 'page-absent';
  state.graphMode = 'ok';
  {
    const scan = context();
    const observation = await observePolicy(scan, control, requirement);
    const verdict = judgeRequirement({
      control,
      requirement,
      observation,
      ledger: { 'read:graph:page:confluence': 'INCONCLUSIVE' },
      now,
    });
    cases.push(['the space resolved and the page is truly absent', observation.visibilityProven, true]);
    cases.push(['an absent page is MISSING, not NOT_VISIBLE', verdict.state, 'MISSING']);
    cases.push(['the reason says the evidence really is absent', /really is absent/.test(verdict.reason), true]);
  }

  // --- 2a. the page exists and the ownership hop answers with no rows -------
  state.pageMode = 'page-present';
  state.graphMode = 'ok';
  {
    const scan = context();
    const observation = await observePolicy(scan, control, requirement);
    const verdict = judgeRequirement({
      control,
      requirement,
      observation,
      ledger: { 'read:graph:page:confluence': 'PROVEN' },
      now,
    });
    cases.push(['a fresh page whose owner the graph cannot name is STALE, not VERIFIED', verdict.state, 'STALE']);
    cases.push([
      'ownership returning no rows is recorded as a note',
      observation.notes.some((note) => /Ownership unresolved/.test(note)),
      true,
    ]);
    cases.push([
      'the verdict names the graph hop that named nobody',
      /confluencePageOwners/.test(verdict.reason),
      true,
    ]);
    cases.push([
      'the verdict says the page owner fields were empty too (v6.30 fallback checked)',
      /owner fields are empty/.test(verdict.reason),
      true,
    ]);
    cases.push([
      'the verdict says what is missing is a named owner',
      /needs a named owner/.test(verdict.reason),
      true,
    ]);
  }

  // --- 2b. the same page, but the graph denies the page scope ---------------
  state.graphMode = 'denied';
  {
    // A page that exists, with the ownership hop denied.
    state.pageMode = 'page-present';
    const scan = context();
    const observation = await observePolicy(scan, control, requirement);
    const verdict = judgeRequirement({ control, requirement, observation, ledger: {}, now });
    cases.push(['a denied ownership hop is still NOT_VISIBLE', verdict.state, 'NOT_VISIBLE']);
    cases.push([
      'the scope is named',
      verdict.missingScopes.join(','),
      'read:graph:page:confluence',
    ]);
    cases.push([
      'an ownerless page is marked unresolved on the row',
      observation.candidates[0]?.ownershipResolved,
      false,
    ]);
  }

  // --- 3. a population failure makes the approval claim INCOMPLETE -----------
  state.graphMode = 'ok';
  state.pageMode = 'page-absent';
  state.jiraMode = 'project-missing';
  {
    const scan = context();
    const population = await populationFor(scan, control);
    const observation = await observeComments(scan, control, approvalRequirement);
    const verdict = judgeRequirement({ control, requirement: approvalRequirement, observation, ledger: {}, now });
    cases.push(['a missing project yields no population', population.length, 0]);
    cases.push([
      'the population failure is UNCONFIGURED, not a permission gap',
      observation.failures?.[0]?.cause,
      'UNCONFIGURED',
    ]);
    cases.push(['the approval claim is not MISSING', verdict.state === 'MISSING', false]);
    cases.push(['the approval claim is INCOMPLETE', verdict.state, 'INCOMPLETE']);
    cases.push([
      'the reason tells the user to bind the programme',
      /Bind the programme/.test(verdict.reason),
      true,
    ]);
    cases.push([
      'the unconfigured claim names no missing scope',
      verdict.missingScopes.length,
      0,
    ]);
  }

  // --- 4. discovery: no labels, so recent completed changes are judged ------
  state.jiraMode = 'label-probe-empty';
  {
    const scan = context();
    const observation = await observeWorkItems(scan, control, workItemRequirement);
    const verdict = judgeRequirement({ control, requirement: workItemRequirement, observation, ledger: {}, now });
    cases.push(['discovery finds a completed change', observation.candidates.length, 1]);
    cases.push(['the claim is judged from discovery', verdict.state, 'VERIFIED']);
    cases.push([
      'the row says discovery mode was used',
      observation.notes.some((note) => /discovery mode/.test(note)),
      true,
    ]);
    cases.push([
      'the reading label names discovery',
      /discovery/.test(observation.read.label),
      true,
    ]);
  }

  // --- 5. and with labels present, nothing is invented -----------------------
  state.jiraMode = 'ok';
  {
    const scan = context();
    const observation = await observeWorkItems(scan, control, workItemRequirement);
    cases.push(['a labelled population is used as it is', observation.candidates.length, 1]);
    cases.push(['no discovery note when labels matched', observation.notes?.length ?? 0, 0]);
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
  console.error('honesty harness failed:', error);
  process.exit(1);
});
