/**
 * Engine smoke test — no Atlassian site, no Forge runtime required.
 *
 *   npm run smoke      (compiles TypeScript, then runs this file)
 *
 * It pins the claims the product rests on after the judge-validation pass:
 *   1. five verdict states, deterministically produced, with INCOMPLETE kept
 *      apart from MISSING (E4);
 *   2. a permission gap is NOT_VISIBLE and names the scope (E3);
 *   3. throttle / timeout / index lag / teamsV2 are INCOMPLETE, never MISSING;
 *   4. every verdict carries a drawable provenance trace (E2);
 *   5. the Environment Check answers six probes inside its budget (E5);
 *   6. the gate degrades instead of throwing when nothing is reachable.
 */

const assert = require('node:assert/strict');

const {
  judgeRequirement,
  summarizeVerdicts,
  classifyFailure,
  scopeExplanation,
  graphRetryPolicyFor,
  withGraphRetryPolicy,
  activeGraphRetryPolicy,
  persistedIdentity,
} = require('../dist/twg/queries.js');
const { buildTrace, classifyAri } = require('../dist/trace/graph.js');
const { runEnvironmentCheck } = require('../dist/engine/envcheck.js');
const { evaluateIssueGate, registryRequirements } = require('../dist/engine/gate.js');

const control = {
  id: 'control-1',
  code: 'AC-07',
  name: 'Critical third parties reviewed before renewal',
  regulation_ref: 'DORA Art.28-30',
  cadence: 'ANNUAL',
  risk_tier: 'MEDIUM',
  jira_label: 'ctrl-ac-07',
  jira_project_key: 'PAY',
  owner_account_id: 'account-1',
  owner_display_name: 'Tomas Rivera',
  status: 'ACTIVE',
};

const requirement = {
  id: 'requirement-1',
  control_id: 'control-1',
  evidence_type: 'policy_page',
  max_age_days: 365,
  min_count: 1,
  rule_json: '{"pageTitlePrefix":"Third-Party Risk Standard"}',
};

const PAGE_SCOPE = 'read:graph:page:confluence';
const now = new Date('2026-11-18T00:00:00Z');

const readOk = {
  label: 'confluencePageOwners',
  mode: 'curated',
  outcome: 'ROWS',
  latencyMs: 38,
  retries: 0,
};

function observation(candidates, overrides = {}) {
  return {
    requirementId: requirement.id,
    evidenceType: 'policy_page',
    scope: PAGE_SCOPE,
    read: readOk,
    candidates,
    provenance: [],
    failures: [],
    ...overrides,
  };
}

function page(observedAt, extra = {}) {
  return {
    ari: 'ari:cloud:confluence:cloud-1:page/1001',
    kind: 'confluence_page',
    label: 'Third-Party Risk Standard',
    observedAt,
    ownerActive: true,
    usable: true,
    ...extra,
  };
}

const proven = { [PAGE_SCOPE]: 'PROVEN' };
const inconclusive = { [PAGE_SCOPE]: 'INCONCLUSIVE' };

const cases = [];
const verdictOf = (observation, ledger = proven) =>
  judgeRequirement({ control, requirement, observation, ledger, now });

// --- 1. the five states -----------------------------------------------------

{
  const verdict = verdictOf(observation([page('2026-10-01T00:00:00Z')]));
  cases.push(['fresh evidence is VERIFIED', verdict.state, 'VERIFIED']);
}

{
  const verdict = verdictOf(observation([page('2025-01-01T00:00:00Z')]));
  cases.push(['evidence past its window is STALE', verdict.state, 'STALE']);
  cases.push(['STALE carries the age in days', verdict.ageDays, 686]);
}

{
  const verdict = verdictOf(observation([]));
  cases.push(['no evidence with a proven scope is MISSING', verdict.state, 'MISSING']);
  cases.push(['MISSING names no scope', verdict.missingScopes.length, 0]);
}

{
  const verdict = verdictOf(observation([]), inconclusive);
  cases.push(['unproven scope is NOT_VISIBLE, never MISSING', verdict.state, 'NOT_VISIBLE']);
  cases.push(['NOT_VISIBLE names the scope to grant', verdict.missingScopes.join(','), PAGE_SCOPE]);
}

{
  const verdict = verdictOf(
    observation([
      page('2026-10-01T00:00:00Z', {
        usable: false,
        unusableReason: 'Linked page "Change Management Policy v3" does not match "Third-Party Risk Standard"',
      }),
    ]),
  );
  cases.push(['disqualified evidence with a proven scope is MISSING', verdict.state, 'MISSING']);
  cases.push(['the disqualification reason is preserved', verdict.reason.includes('does not match'), true]);
}

{
  const verdict = verdictOf(
    observation([], {
      read: { ...readOk, outcome: 'ERROR', error: { message: 'permission denied', status: 403 } },
    }),
  );
  cases.push(['a denied graph read is NOT_VISIBLE', verdict.state, 'NOT_VISIBLE']);
}

{
  const verdict = verdictOf(
    observation([page('2026-11-01T00:00:00Z', { ownerActive: false, ownerName: 'Marcus Webb' })]),
  );
  cases.push(['fresh evidence with a deactivated owner is STALE', verdict.state, 'STALE']);
}

// --- 2. E4: INCOMPLETE is a first-class state, never merged with MISSING ----

{
  const verdict = verdictOf(
    observation([], {
      failures: [{ cause: 'RATE_LIMIT_EXCEEDED', message: '20s window exhausted', retryable: true }],
      read: { ...readOk, outcome: 'EMPTY' },
    }),
  );
  cases.push(['a throttled scan is INCOMPLETE, not MISSING', verdict.state, 'INCOMPLETE']);
  cases.push(['INCOMPLETE names the throttle cause', verdict.reason.includes('RATE_LIMIT_EXCEEDED'), true]);
  cases.push(['INCOMPLETE claims no missing scope', verdict.missingScopes.length, 0]);
}

{
  const verdict = verdictOf(
    observation([], {
      indexingDelay: true,
      failures: [],
      read: { ...readOk, outcome: 'EMPTY' },
    }),
  );
  cases.push(['an unindexed object is INCOMPLETE', verdict.state, 'INCOMPLETE']);
}

{
  const verdict = verdictOf(
    observation([], {
      populationUnread: true,
      failures: [{ cause: 'SERVICE_ERROR', message: 'JQL failed (503)', retryable: true }],
    }),
  );
  cases.push(['an unread population is INCOMPLETE', verdict.state, 'INCOMPLETE']);
}

{
  const verdict = verdictOf(
    observation([], {
      failures: [{ cause: 'SERVICE_ERROR', message: 'teamsV2 status code is: 403', retryable: true }],
      read: { ...readOk, outcome: 'ERROR', error: { message: 'teamsV2 status code is: 403', cause: 'SERVICE_ERROR', retryable: true } },
    }),
  );
  cases.push(['a teamsV2 403 is INCOMPLETE, not NOT_VISIBLE', verdict.state, 'INCOMPLETE']);
}

{
  const verdict = verdictOf(
    observation([], {
      failures: [{ cause: 'PERMISSION_DENIED', message: 'missing scope', scope: PAGE_SCOPE, retryable: false }],
      read: { ...readOk, outcome: 'ROWS' },
    }),
  );
  cases.push(['a missing scope reported as a failure is NOT_VISIBLE', verdict.state, 'NOT_VISIBLE']);
  cases.push(['the scope is named for the admin', verdict.missingScopes.join(','), PAGE_SCOPE]);
}

// --- 3. failure classification ---------------------------------------------

cases.push(['429 is a rate limit', classifyFailure(429, 'Too many requests'), 'RATE_LIMIT_EXCEEDED']);
cases.push(['teamsV2 403 is a service error', classifyFailure(403, 'teamsV2 status code is: 403'), 'SERVICE_ERROR']);
cases.push(['a plain 403 is permission', classifyFailure(403, 'Forbidden'), 'PERMISSION_DENIED']);
cases.push(['a 504 is a timeout', classifyFailure(504, 'Gateway Timeout'), 'TIMEOUT']);
cases.push(['an unknown-failure message is UNKNOWN', classifyFailure(200, 'weird'), 'UNKNOWN']);

// --- 3b. C1: the 403 that used to be swallowed by the service-error branch -----
cases.push([
  'a graph 403 phrased "status code is: 403" is a permission gap',
  classifyFailure(200, 'Request failed: status code is: 403'),
  'PERMISSION_DENIED',
]);
cases.push([
  'a 403 with no message body is a permission gap',
  classifyFailure(403, 'HTTP 403'),
  'PERMISSION_DENIED',
]);
cases.push([
  'a scope denial is a permission gap',
  classifyFailure(200, 'The app lacks the scope read:graph:page:confluence'),
  'PERMISSION_DENIED',
]);
cases.push([
  'an upstream failure stays a service error',
  classifyFailure(502, 'upstream connect error'),
  'SERVICE_ERROR',
]);

// --- 3c. C8: a shortfall is not an absence ----------------------------------
{
  const twoRequired = { ...requirement, min_count: 2 };
  const verdict = judgeRequirement({
    control,
    requirement: twoRequired,
    observation: observation([page('2026-10-01T00:00:00Z')]),
    ledger: proven,
    now,
  });
  cases.push(['one of two required objects is MISSING', verdict.state, 'MISSING']);
  cases.push(['the shortfall is stated as a count', /Only 1 of the 2 required/.test(verdict.reason), true]);
  cases.push([
    'a shortfall never claims nothing was found',
    /really is absent|No .* was found/.test(verdict.reason),
    false,
  ]);
  cases.push(['the shortfall says how many more are needed', /1 more is needed/.test(verdict.reason), true]);
}

// --- 3d. C10: a REST permission names the REST scope, not a graph scope ------
{
  const verdict = verdictOf(
    observation([], {
      failures: [
        { cause: 'PERMISSION_DENIED', message: 'GET comments failed (403)', scope: 'read:jira-work', retryable: false },
      ],
      read: { ...readOk, outcome: 'ERROR', error: { message: 'GET comments failed (403)', status: 403 } },
    }),
  );
  cases.push(['a denied REST read is NOT_VISIBLE', verdict.state, 'NOT_VISIBLE']);
  cases.push(['the REST scope is the one named for the admin', verdict.missingScopes.join(','), 'read:jira-work']);
  cases.push(
    ['the REST scope is explained in plain words', /read:jira-work/.test(scopeExplanation('read:jira-work')), true],
  );
}

// --- 3e. C4: unsupported evidence is not a gap -------------------------------
{
  const verdict = verdictOf(
    observation([], {
      failures: [
        { cause: 'UNSUPPORTED', message: 'no connector on this site supplies deployment evidence', retryable: false },
      ],
      read: { ...readOk, outcome: 'EMPTY' },
    }),
  );
  cases.push(['an unsupported claim is INCOMPLETE, not MISSING', verdict.state, 'INCOMPLETE']);
  cases.push(['the verdict says it is unsupported', /unsupported claim here, not missing evidence/.test(verdict.reason), true]);
}

// --- 3f. C13: the action path does not retry into its 20 s timeout -----------
cases.push(['a Rovo action read tries once', graphRetryPolicyFor('ROVO_ACTION').attempts, 1]);
cases.push(['a manual scan still retries', graphRetryPolicyFor('MANUAL').attempts, 3]);
cases.push(['a scheduled scan still retries', graphRetryPolicyFor('SCHEDULED').attempts, 3]);

// --- 3g. C12: a persisted node keeps its ARI ---------------------------------
cases.push([
  'a persisted Confluence page node rebuilds its ARI',
  persistedIdentity({ typename: 'ConfluencePage', id: '4128789' }, 'cloud-1'),
  'ari:cloud:confluence:cloud-1:page/4128789',
]);
cases.push([
  'a persisted work item node rebuilds its ARI',
  persistedIdentity({ typename: 'JiraWorkItem', id: '1183' }, 'cloud-1'),
  'ari:cloud:jira:cloud-1:issue/1183',
]);
cases.push([
  'an ari field on the node wins over the id',
  persistedIdentity({ typename: 'ConfluencePage', id: '4128789', ari: 'ari:cloud:confluence:cloud-9:page/4128789' }, 'cloud-1'),
  'ari:cloud:confluence:cloud-9:page/4128789',
]);
cases.push([
  'an unknown node type is not turned into a made-up ARI',
  persistedIdentity({ typename: 'SomethingElse', id: '7' }, 'cloud-1'),
  null,
]);

// --- 4. state counts -------------------------------------------------------

{
  const counts = summarizeVerdicts([
    verdictOf(observation([page('2026-10-01T00:00:00Z')])),
    verdictOf(observation([])),
    verdictOf(observation([]), inconclusive),
    verdictOf(
      observation([], {
        failures: [{ cause: 'RATE_LIMIT_EXCEEDED', message: 'throttled', retryable: true }],
        read: { ...readOk, outcome: 'EMPTY' },
      }),
    ),
  ]);
  cases.push(['counts cover five states', counts.INCOMPLETE, 1]);
  cases.push(['counts keep NOT_VISIBLE apart', counts.NOT_VISIBLE, 1]);
  cases.push(['counts total to the verdicts judged', counts.VERIFIED + counts.MISSING + counts.NOT_VISIBLE + counts.INCOMPLETE, 4]);
}

// --- 5. E2: the trace is a drawable graph ----------------------------------

{
  const issueAri = 'ari:cloud:jira:cloud-1:issue/1183';
  const commentAri = 'ari:cloud:jira:cloud-1:comment/9001';
  const userAriValue = 'ari:cloud:identity::user/account-9';
  const trace = buildTrace(
    { ari: issueAri, label: 'PAY-1183', kind: 'issue' },
    [
      { hop: 1, fromAri: issueAri, relation: 'jira_work_item_has_jira_work_item_comment', toAri: commentAri, observedAt: '2026-10-14T09:00:00Z' },
      { hop: 2, fromAri: commentAri, relation: 'jira_work_item_comment_authored_by_atlassian_user', toAri: userAriValue, observedAt: '2026-10-14T09:00:00Z' },
      { hop: 3, fromAri: userAriValue, relation: 'atlassian_user_owns_confluence_page', toAri: 'ari:cloud:confluence:cloud-1:page/1001', observedAt: '2026-10-15T10:00:00Z' },
      { hop: 4, fromAri: 'ari:cloud:confluence:cloud-1:space/77', relation: 'atlassian_team_links_space_entity', toAri: 'ari:cloud:confluence:cloud-1:page/1001', observedAt: '2026-10-15T10:00:00Z' },
    ],
    { [userAriValue]: 'J. Kim' },
  );
  cases.push(['trace keeps every node', trace.nodes.length, 5]);
  cases.push(['trace keeps every link', trace.links.length, 4]);
  cases.push(['trace lays out hop depth as columns', trace.columns.length >= 3, true]);
  cases.push(['trace uses the display name for a user', trace.nodes.find((n) => n.id === userAriValue)?.label, 'J. Kim']);
  cases.push(['trace classifies an issue ARI', classifyAri(issueAri), 'issue']);
  cases.push(['trace classifies a comment ARI', classifyAri(commentAri), 'comment']);
  cases.push(['trace classifies a page ARI', classifyAri('ari:cloud:confluence:cloud-1:page/1'), 'page']);
  cases.push(['trace classifies a user ARI', classifyAri(userAriValue), 'user']);
  cases.push(['trace links carry the relation name', trace.links[0].relation, 'jira_work_item_has_jira_work_item_comment']);
  cases.push(['trace links carry the observation time', trace.links[0].observedAt, '2026-10-14T09:00:00Z']);

  // A backward hop (space -> page) must not put both ends in one column: that is
  // what made the space box overlap the page box in the drawn diagram.
  const s = trace.nodes.find((n) => n.id === 'ari:cloud:confluence:cloud-1:space/77');
  const page = trace.nodes.find((n) => n.id === 'ari:cloud:confluence:cloud-1:page/1001');
  cases.push(['a backward hop still gets its own column', s?.depth !== page?.depth, true]);
  const sameColumn = trace.links.filter((link) => {
    const from = trace.nodes.find((node) => node.id === link.from);
    const to = trace.nodes.find((node) => node.id === link.to);
    return from && to && from.depth === to.depth;
  });
  cases.push(['no relationship joins two nodes in one column', sameColumn.length, 0]);
}

// --- 6. E5: the environment check survives having no site -------------------

async function environmentCases() {
  const report = await runEnvironmentCheck({
    context: { cloudId: 'cloud-1', accountId: 'account-1', userAri: 'ari:cloud:identity::user/account-1' },
    budgetMs: 5000,
  });
  cases.push(['environment check runs six probes', report.probes.length, 6]);
  cases.push([
    'environment check probes are the prescribed six',
    report.probes.map((probe) => probe.id).join(','),
    'connection,issue,comment,policy,people,persisted',
  ]);
  cases.push(['environment check respects its budget', report.durationMs < 5000, true]);
  cases.push(['environment check sums to six', report.summary.green + report.summary.yellow + report.summary.red, 6]);
  cases.push([
    'every probe says what to do next',
    report.probes.every((probe) => typeof probe.remedy === 'string' && probe.remedy.length > 0),
    true,
  ]);
  cases.push([
    'an unreachable site is not reported as green',
    report.probes.some((probe) => probe.state !== 'GREEN'),
    true,
  ]);
}

// --- 7. the gate degrades instead of throwing ------------------------------

async function gateCases() {
  const gate = await evaluateIssueGate({ issueKey: 'PAY-1183', cloudId: 'cloud-1' });
  cases.push(['an unreachable work item yields NOT_EVALUATED, not a throw', gate.badge.state, 'NOT_EVALUATED']);
  cases.push(['the gate still explains itself', typeof gate.badge.detail === 'string' && gate.badge.detail.length > 0, true]);
  cases.push(['the gate reports five-state counts', Object.keys(gate.counts).sort().join(','), 'INCOMPLETE,MISSING,NOT_VISIBLE,STALE,VERIFIED']);

  // The shipped programme is the stateless fallback for the registry.
  const requirements = await registryRequirements(control);
  cases.push(['registry falls back to the shipped programme', requirements.length > 0, true]);
  cases.push([
    'programme requirements carry age limits',
    requirements.every((row) => typeof row.max_age_days === 'number'),
    true,
  ]);
}

async function hardeningCases() {
  const before = activeGraphRetryPolicy().attempts;
  let during = 0;
  await withGraphRetryPolicy(graphRetryPolicyFor('ROVO_ACTION'), async () => {
    during = activeGraphRetryPolicy().attempts;
  });
  cases.push(['the policy is in force inside the block', during, 1]);
  cases.push(['the policy is restored afterwards', activeGraphRetryPolicy().attempts, before]);
}

async function main() {
  await hardeningCases();
  await environmentCases();
  await gateCases();

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
  console.error('smoke harness failed:', error);
  process.exit(1);
});
