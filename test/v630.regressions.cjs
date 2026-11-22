/**
 * v6.30 regressions — the unattended scan's ownership hop, its graph budget, and
 * the cold-start schema guard.
 *
 *   node test/v630.regressions.cjs
 *
 *   1. A graph hop that never answers is capped: TIMEOUT inside the cap, not
 *      retried, and the run records that impersonation was abandoned.
 *   2. Two caps in a row write the graph off for the rest of the run, and the
 *      skipped hop still reports TIMEOUT with "unchecked, not missing".
 *   3. After impersonation is abandoned, the next hop reads as the ambient
 *      identity instead of borrowing the principal again.
 *   4. When the traversal cannot name an owner, the page's own owner fields answer
 *      — labeled `rest` in provenance, disclosed in a note, and the claim is
 *      VERIFIED rather than NOT_VISIBLE / STALE.
 *   5. When neither answers, the old honesty rules still hold: denied graph with
 *      no owner is NOT_VISIBLE, empty graph with no owner is STALE.
 *   6. ensureSchema migrates once for concurrent callers on the same instance.
 */

const assert = require('node:assert/strict');
const Module = require('node:module');

const state = {
  /** 'hang' | 'ok' | 'denied' | 'empty' */
  graph: 'ok',
  /** Page owner fields the REST read returns. */
  rest: { ownerId: null, lastOwnerId: null, authorId: null },
  /** Identities passed to api.asUser(), in order. */
  identities: [],
  graphCalls: 0,
  migrations: { enqueued: 0, runs: 0, selects: 0 },
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

const page = {
  id: '501',
  title: 'Change Management Policy v7',
  spaceId: '77',
  version: { createdAt: daysAgo(10), number: 3 },
  _links: { webui: '/spaces/ITO/pages/501/Change+Management+Policy+v7' },
};

const jira = {
  requestJira: async () => json({ issues: [] }),
  requestConfluence: async (route) => {
    const path = String(route);
    if (/\/spaces/.test(path)) {
      return json({ results: [{ id: '77', key: 'ITO', name: 'ITO' }] });
    }
    // GET /wiki/api/v2/pages/{id} — the owner fields.
    if (/\/pages\/501\b/.test(path)) {
      return json({ id: '501', title: page.title, ...state.rest });
    }
    if (/title=|space-id=/.test(path)) {
      return json({ results: [page] });
    }
    return json({ results: [] });
  },
  requestTeamworkGraph: async (query) => {
    state.graphCalls += 1;
    if (state.graph === 'hang') {
      return new Promise(() => {});
    }
    if (state.graph === 'denied') {
      return json({ errors: [{ message: 'Missing scope read:graph:page:confluence' }] });
    }
    if (/confluencePageOwners/.test(query)) {
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
    return json({ data: {} });
  },
};

const requester = jira;

const fakeApi = {
  asApp: () => requester,
  // The identity is the point of these tests: record it instead of ignoring it.
  asUser: (accountId) => {
    state.identities.push(accountId ?? null);
    return requester;
  },
  route(strings, ...values) {
    return strings.reduce((acc, part, index) => acc + part + (values[index] ?? ''), '');
  },
};

const fakeSql = {
  prepare: () => ({
    bindParams: () => ({
      execute: async () => {
        state.migrations.selects += 1;
        throw new Error('no database in this test');
      },
    }),
  }),
  migrationRunner: {
    enqueue: () => {
      state.migrations.enqueued += 1;
    },
    run: async () => {
      state.migrations.runs += 1;
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

const {
  GRAPH_SCOPES,
  describeGraphBudget,
  judgeRequirement,
  newGraphCallState,
  runGraphQL,
  withGraphCallBudget,
} = require('../dist/twg/queries.js');
const { observePolicy } = require('../dist/index.js');
const { resolvePageOwner } = require('../dist/engine/gate.js');
const { ensureSchema, resetSchemaCacheForTests } = require('../dist/schema/sql.js');

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

const requirement = {
  id: 'req-policy',
  control_id: 'control-1',
  evidence_type: 'policy_page',
  max_age_days: 365,
  min_count: 1,
  rule_json: JSON.stringify({ pageTitlePrefix: 'Change Management Policy', spaceKey: 'ITO' }),
};

function scanContext(principal = 'acc-principal') {
  return {
    cloudId: 'cloud-1',
    principalAccountId: principal,
    population: new Map(),
    populationFailures: new Map(),
    discovered: new Map(),
    ledger: {},
    retried: 0,
  };
}

function budget(overrides = {}) {
  return {
    asAccountId: 'acc-principal',
    timeoutMs: 150,
    capStreak: 2,
    state: newGraphCallState(),
    ...overrides,
  };
}

const cases = [];
const check = (name, actual, expected) => cases.push([name, actual, expected]);
const now = new Date();

async function main() {
  // --- 1. a hop that never answers is capped -------------------------------
  state.graph = 'hang';
  {
    const b = budget();
    const started = Date.now();
    const result = await withGraphCallBudget(b, () => runGraphQL('query { x }', {}));
    const elapsed = Date.now() - started;
    check('a hung hop returns instead of blocking', elapsed < 2000, true);
    check('a capped hop is TIMEOUT', result.error?.cause, 'TIMEOUT');
    check('a capped hop is not retried', result.error?.retryable, false);
    check('the cap is counted', b.state.capped, 1);
    check('the reason names the cap', /did not answer within 150 ms/.test(result.error?.message ?? ''), true);
    check('impersonation is abandoned after its first cap', b.state.impersonationRejected, true);
    check('the hung hop is attributed to the principal', b.state.impersonated, 1);
  }

  // --- 2. two caps write the graph off -------------------------------------
  {
    const b = budget({ capStreak: 2 });
    await withGraphCallBudget(b, () => runGraphQL('query { a }', {}));
    const second = await withGraphCallBudget(b, () => runGraphQL('query { b }', {}));
    check('the second cap is still TIMEOUT', second.error?.cause, 'TIMEOUT');
    check('two caps open the breaker', b.state.breakerOpen, true);
    const callsBefore = state.graphCalls;
    const third = await withGraphCallBudget(b, () => runGraphQL('query { c }', {}));
    check('a skipped hop sends no request', state.graphCalls, callsBefore);
    check('a skipped hop is still TIMEOUT', third.error?.cause, 'TIMEOUT');
    check(
      'a skipped hop says it is unchecked, not missing',
      /unchecked, not missing/.test(third.error?.message ?? ''),
      true,
    );
    check('the skipped hop costs no latency', third.latencyMs, 0);
    check('the scan note reports the write-off', /written off/.test(describeGraphBudget(b.state, 150)), true);
  }

  // --- 3. identity: principal first, ambient after the cap ------------------
  state.graph = 'hang';
  {
    state.identities = [];
    const b = budget({ timeoutMs: 100 });
    await withGraphCallBudget(b, () => runGraphQL('query { d }', {}));
    check('the first hop borrows the principal', state.identities[0], 'acc-principal');
    await withGraphCallBudget(b, () => runGraphQL('query { e }', {}));
    check('after the cap it reads as the ambient identity', state.identities[1], null);
    state.identities = [];
    // Outside a budget nothing changes: an explicit identity is still honoured.
    state.graph = 'ok';
    await runGraphQL('query { f }', {}, 'acc-explicit');
    check('an explicit identity still wins outside a budget', state.identities[0], 'acc-explicit');
  }

  // --- 4. the page's own owner fields answer when the graph cannot ---------
  state.graph = 'denied';
  state.rest = { ownerId: 'acc-page-owner', lastOwnerId: null, authorId: 'acc-author' };
  {
    const owner = await resolvePageOwner(
      { id: page.id, title: page.title },
      `ari:cloud:confluence:cloud-1:page/${page.id}`,
      { asAccountId: 'acc-principal' },
    );
    check('REST names the owner when the graph is denied', owner.accountId, 'acc-page-owner');
    check('the resolution says REST answered', owner.source, 'rest');
    check('the property that answered is named', owner.restField, 'owner');
    check('the note discloses the substitution', /Provenance source: rest/.test(owner.notes.join(' ')), true);

    const observation = await observePolicy(scanContext(), control, requirement);
    const verdict = judgeRequirement({ control, requirement, observation, ledger: {}, now });
    check('a denied graph does not make the claim NOT_VISIBLE', verdict.state, 'VERIFIED');
    check('the row carries the REST owner', observation.candidates[0]?.ownerAccountId, 'acc-page-owner');
    check('the row is marked resolved', observation.candidates[0]?.ownershipResolved, true);
    check(
      'provenance names the REST field hop',
      observation.provenance.some((hop) => hop.source === 'rest'),
      true,
    );
    check(
      'the observation is not flagged as unread',
      observation.accountabilityUnread,
      false,
    );
  }

  // lastOwner / author are used when there is no owner
  state.rest = { ownerId: null, lastOwnerId: 'acc-last-owner', authorId: 'acc-author' };
  {
    const owner = await resolvePageOwner(
      { id: page.id, title: page.title },
      `ari:cloud:confluence:cloud-1:page/${page.id}`,
      { asAccountId: 'acc-principal' },
    );
    check('lastOwner is the next fallback', owner.restField, 'lastOwner');
    check('lastOwner names the owner', owner.accountId, 'acc-last-owner');
  }
  state.rest = { ownerId: null, lastOwnerId: null, authorId: 'acc-author' };
  {
    const owner = await resolvePageOwner(
      { id: page.id, title: page.title },
      `ari:cloud:confluence:cloud-1:page/${page.id}`,
      { asAccountId: 'acc-principal' },
    );
    check('authorId is the last fallback', owner.restField, 'author');
  }

  // --- 5. neither answers: the old rules hold ------------------------------
  state.rest = { ownerId: null, lastOwnerId: null, authorId: null };
  state.graph = 'denied';
  {
    const observation = await observePolicy(scanContext(), control, requirement);
    const verdict = judgeRequirement({
      control,
      requirement,
      observation,
      ledger: { [GRAPH_SCOPES.PAGE]: 'DENIED' },
      now,
    });
    check('a denied graph with no owner stays NOT_VISIBLE', verdict.state, 'NOT_VISIBLE');
    check('the claim names the page scope', verdict.missingScopes.join(','), GRAPH_SCOPES.PAGE);
  }
  state.graph = 'ok';
  {
    const observation = await observePolicy(scanContext(), control, requirement);
    const verdict = judgeRequirement({
      control,
      requirement,
      observation,
      ledger: { [GRAPH_SCOPES.PAGE]: 'PROVEN' },
      now,
    });
    check('an empty graph with no owner is still STALE', verdict.state, 'STALE');
    check(
      'the note says the page owner fields were empty too',
      observation.notes.some((note) => /owner fields are empty/.test(note)),
      true,
    );
  }

  // --- 6. ensureSchema migrates once ---------------------------------------
  state.migrations = { enqueued: 0, runs: 0, selects: 0 };
  resetSchemaCacheForTests();
  await Promise.all([ensureSchema(), ensureSchema(), ensureSchema()]);
  check('concurrent callers run migrations once', state.migrations.runs, 1);
  check('the migration list is enqueued once', state.migrations.enqueued > 10, true);
  const enqueuedAfterFirst = state.migrations.enqueued;
  // The reads below are counted, and the assertion is the delta: the point is that a
  // warm call reads nothing, not how many columns the schema happens to have.
  const selectsAfterFirst = state.migrations.selects;
  await ensureSchema();
  check('a warm call re-runs nothing', state.migrations.enqueued, enqueuedAfterFirst);
  check('a warm call does not even read', state.migrations.selects, selectsAfterFirst);

  let failed = 0;
  for (const [name, actual, expected] of cases) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failed += 1;
      console.log(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    } else {
      console.log(`  ok   ${name}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} assertions passed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((cause) => {
  console.error(cause);
  process.exitCode = 1;
});
