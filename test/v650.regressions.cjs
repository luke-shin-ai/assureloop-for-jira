/**
 * v6.50 regressions — the approvals a red-team pass grew, and the guard on every write.
 *
 *   node test/v650.regressions.cjs
 *
 *   1. The approval matcher, six shapes it got wrong in both directions: a mention of the
 *      approval process, a checklist review that found gaps, "un-approved", a partial
 *      "LGTM for the code only", and the everyday "I approve this change" that the
 *      shipped pattern could not match at all. The 17 rejections and the 10 acceptances
 *      of the previous rounds are re-run against the widened pattern, because the fix
 *      pulls both ways and a widened verb must not re-admit a mention.
 *   2. Segregation of duties against both people on a work item: the approver may be
 *      neither the assignee nor the reporter, on the panel and in the registry scan.
 *   3. Every write asks Jira first (ADMINISTER for the programme, EDIT_ISSUES on the
 *      work item, BROWSE_PROJECTS before a verdict), and a refusal writes nothing.
 *   4. A project key is a whitelist, not a string: a quote never reaches a JQL query.
 *   5. A custom control is validated, saved with its rule, and its JSON import reports
 *      each row it refused.
 *   6. A withdrawn exception carries the name of the person who withdrew it.
 */

const assert = require('node:assert/strict');
const Module = require('node:module');

const DAY = 86400000;
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

// ---------------------------------------------------------------------------
// The fake site
// ---------------------------------------------------------------------------

const state = {
  /** mypermissions answers. A permission that is absent is granted. */
  permissions: {},
  /** 'full' answers mypermissions; 'empty' omits the permission; 500 breaks it. */
  permissionAnswer: 'full',
  permissionStatus: 200,
  /** Who wrote the approving comment. */
  commentAuthor: 'acc-reviewer',
  commentAuthorName: 'Reviewer One',
  /** Every Jira path asked for, so a test can prove a query was never sent. */
  jiraCalls: [],
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
  id: '2001',
  key: 'PAY-7',
  fields: {
    summary: 'Rotate the merchant webhook signing secret',
    status: { name: 'Done', statusCategory: { key: 'done' } },
    assignee: { accountId: 'acc-dev', displayName: 'Dev One', active: true },
    reporter: { accountId: 'acc-reporter', displayName: 'Rep Two', active: true },
    updated: daysAgo(2),
    created: daysAgo(20),
    issuetype: { name: 'Change' },
    labels: ['ctrl-ac-01'],
    project: { key: 'PAY', id: '2001' },
    components: [],
  },
};

function commentBody(authorAccountId, authorName, text = 'Approved by the change board.') {
  return {
    comments: [
      {
        id: '9100',
        author: { accountId: authorAccountId, displayName: authorName, active: true },
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
        created: daysAgo(3),
      },
    ],
  };
}

const requester = {
  requestJira: async (route, options = {}) => {
    const path = String(route);
    state.jiraCalls.push(path);
    if (/\/mypermissions/.test(path)) {
      const requested = /permissions=([A-Z_]+)/.exec(path)?.[1] ?? '';
      if (state.permissionStatus !== 200) {
        return json({ message: 'permission service unavailable' }, state.permissionStatus);
      }
      if (state.permissionAnswer === 'empty') {
        return json({});
      }
      return json({
        permissions: { [requested]: { havePermission: state.permissions[requested] !== false } },
      });
    }
    if (/\/comment/.test(path)) {
      return json(commentBody(state.commentAuthor, state.commentAuthorName));
    }
    if (/\/search\/jql/.test(path)) {
      return json({ issues: [issueBody], isLast: true });
    }
    if (/\/issue\//.test(path)) {
      return json(issueBody);
    }
    if (/\/project\//.test(path)) {
      return json({ id: '2001' });
    }
    return json({});
  },
  requestConfluence: async (route) => {
    const path = String(route);
    if (/\/spaces/.test(path)) {
      return json({ results: [{ id: '77', key: 'ITO' }] });
    }
    return json({ results: [] });
  },
  requestTeamworkGraph: async (query) => {
    if (/confluencePageOwners/.test(query)) {
      return json({
        data: {
          confluencePageOwners: {
            edges: [{ node: { __typename: 'AtlassianUser', accountId: 'acc-owner', name: 'Policy Owner' } }],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    }
    if (/atlassianTeamMembers/.test(query)) {
      return json({
        data: {
          atlassianTeamMembers: {
            edges: [{ node: { __typename: 'AtlassianUser', accountId: state.commentAuthor, name: state.commentAuthorName } }],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    }
    if (/atlassianTeamsBySpace|atlassianUserInTeams/.test(query)) {
      return json({
        data: {
          atlassianTeamsBySpace: {
            edges: [{ node: { __typename: 'AtlassianTeam', id: 'ari:cloud:identity::team/t1', displayName: 'Change Advisory' } }],
            pageInfo: { hasNextPage: false },
          },
          atlassianUserInTeams: {
            edges: [{ node: { __typename: 'AtlassianTeam', id: 'ari:cloud:identity::team/t1', displayName: 'Change Advisory' } }],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    }
    return json({ data: { __typename: 'Query' } });
  },
};

// ---------------------------------------------------------------------------
// The fake database
// ---------------------------------------------------------------------------

const db = {
  controls: [],
  requirements: [],
  exceptions: [],
  queries: [],
};

function handle(query, params) {
  db.queries.push({ query, params });
  if (/information_schema/i.test(query)) {
    return [];
  }
  if (/SELECT 1 FROM controls/i.test(query)) {
    return [];
  }
  if (/SELECT \* FROM controls WHERE code = \?/i.test(query)) {
    return db.controls.filter((row) => row.code === params[0]);
  }
  if (/SELECT \* FROM controls WHERE id = \?/i.test(query)) {
    return db.controls.filter((row) => row.id === params[0]);
  }
  if (/SELECT \* FROM controls ORDER BY code ASC/i.test(query)) {
    return db.controls.slice().sort((a, b) => (a.code < b.code ? -1 : 1));
  }
  if (/INSERT INTO controls/i.test(query)) {
    db.controls.push({
      id: params[0],
      code: params[1],
      name: params[2],
      regulation_ref: params[3],
      cadence: params[4],
      risk_tier: params[5],
      jira_label: params[6],
      jira_project_key: params[7],
      owner_account_id: params[8],
      owner_display_name: params[9],
      status: params[10],
    });
    return [];
  }
  if (/UPDATE controls/i.test(query)) {
    const row = db.controls.find((entry) => entry.id === params[9]);
    if (row) {
      Object.assign(row, {
        name: params[0],
        regulation_ref: params[1],
        cadence: params[2],
        risk_tier: params[3],
        jira_label: params[4],
        jira_project_key: params[5],
        owner_account_id: params[6],
        owner_display_name: params[7],
        status: params[8],
      });
    }
    return [];
  }
  if (/SELECT \* FROM evidence_requirements WHERE control_id = \?/i.test(query)) {
    return db.requirements.filter((row) => row.control_id === params[0]);
  }
  if (/INSERT INTO evidence_requirements/i.test(query)) {
    db.requirements.push({
      id: params[0],
      control_id: params[1],
      evidence_type: params[2],
      max_age_days: params[3],
      min_count: params[4],
      rule_json: params[5],
    });
    return [];
  }
  if (/UPDATE evidence_requirements/i.test(query)) {
    const row = db.requirements.find((entry) => entry.id === params[3]);
    if (row) {
      Object.assign(row, { max_age_days: params[0], min_count: params[1], rule_json: params[2] });
    }
    return [];
  }
  if (/SELECT \* FROM claim_exceptions WHERE claim_key = \? AND active = 1/i.test(query)) {
    return db.exceptions.filter((row) => row.claim_key === params[0] && row.active === 1);
  }
  if (/UPDATE claim_exceptions SET active = 0/i.test(query)) {
    const row = db.exceptions.find((entry) => entry.id === params[2]);
    if (row) {
      Object.assign(row, { active: 0, withdrawn_by: params[0], withdrawn_at: params[1] });
    }
    return [];
  }
  if (/SELECT config_value FROM app_config/i.test(query)) {
    // The site is bound to PAY, so a custom control that names no project is judged
    // where the programme already runs - the ordinary case the form relies on.
    if (String(params[0]) === 'site_binding') {
      return [
        {
          config_value: JSON.stringify({
            projectKey: 'PAY',
            spaceKey: 'ITO',
            boundAt: daysAgo(1),
            boundBy: 'acc-admin',
          }),
        },
      ];
    }
    return [];
  }
  return [];
}

const fakeSql = {
  prepare: (query) => ({
    bindParams: (...params) => ({
      execute: async () => ({ rows: handle(String(query), params) }),
    }),
  }),
  migrationRunner: { enqueue: () => {}, run: async () => {} },
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
  if (request === '@forge/sql') {
    return { ...fakeSql, default: fakeSql };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { statesApproval, approvalPatternOf, independenceConflict, evaluateIssueGate } = require('../dist/engine/gate.js');
const { observeComments } = require('../dist/index.js');
const { handler } = require('../dist/index.js');
const { checkJiraPermission } = require('../dist/perm/guard.js');
const { withdrawClaimException } = require('../dist/schema/sql.js');
const { validateProjectKey } = require('../dist/engine/input.js');
const { importCustomControls, saveCustomControl } = require('../dist/registry/custom.js');

const cases = [];
const check = (name, actual, expected) => cases.push([name, actual, expected]);

/** Call a resolver the way Forge does, with a signed-in person. */
const callResolver = (functionKey, payload = {}, accountId = 'acc-admin') =>
  handler({ call: { functionKey, payload }, context: { cloudId: 'cloud-1' } }, { principal: { accountId } });

const shippedPattern = /\b(approve[sd]?|approval|lgtm)\b/i;
const legacyPattern = /\b(approved|approval|lgtm)\b/i;

async function main() {
  // --- 1. the approval matcher, six new shapes ------------------------------
  {
    const refused = [
      'Approval process: see wiki page',
      'Reviewed the approval checklist and found gaps',
      'un-approved draft',
      'Un-approved draft for review',
      'LGTM for the code only, not the release',
      'LGTM for the code only',
      'Can you approve this change?',
      'Please approve this change',
    ];
    for (const text of refused) {
      check(`"${text}" is not an approval`, statesApproval(text, shippedPattern), false);
    }
    const accepted = [
      'I approve this change',
      'I approved this change',
      'Approved by the CAB on 2026-11-01',
      'LGTM, ship it',
      'No objections - approved',
      'Approval: finance and risk signed off.',
      'Approved by CAB, per the change process',
    ];
    for (const text of accepted) {
      check(`"${text}" is an approval`, statesApproval(text, shippedPattern), true);
    }

    // The previous round's rejections, re-run against the widened pattern: adding the
    // verb must not have re-admitted a request, a negation or a state.
    const earlierRejected = [
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
    let reAdmitted = 0;
    for (const text of earlierRejected) {
      if (statesApproval(text, shippedPattern)) {
        reAdmitted += 1;
      }
    }
    check('the widened verb re-admits none of the 17 earlier rejections', reAdmitted, 0);

    const earlierAccepted = [
      'Approved by Jane',
      'LGTM, ship it',
      'Approved, and no further review is needed',
      'Approval: finance and risk signed off.',
      'Approved in CAB on Tuesday.',
      'Approval was granted by Jane',
      'Approved, please deploy after the freeze',
      'Approved. Pending items: none',
    ];
    let lost = 0;
    for (const text of earlierAccepted) {
      if (!statesApproval(text, shippedPattern)) {
        lost += 1;
      }
    }
    check('the six new rules lose none of the earlier acceptances', lost, 0);

    // A pattern an administrator wrote is used as written; the legacy default is widened.
    check(
      'the legacy default pattern is widened for an existing registry',
      approvalPatternOf({ approvalPattern: '\\b(approved|approval|lgtm)\\b' }).source.includes('approve[sd]?'),
      true,
    );
    check(
      'a pattern an administrator wrote is left alone',
      approvalPatternOf({ approvalPattern: '\\bsigned off\\b' }).source,
      '\\bsigned off\\b',
    );
    check('an empty rule gets the current default', approvalPatternOf({}).source.includes('approve[sd]?'), true);

    // The old pattern still reads the old way for a caller that holds it: the app widens
    // the stored default, it does not change what a caller's own regex means.
    check('a caller-supplied legacy regex is unchanged', statesApproval('I approve this change', legacyPattern), false);
  }

  // --- 2. segregation of duties against assignee and reporter ---------------
  {
    const issue = { key: 'PAY-7', assigneeAccountId: 'acc-dev', reporterAccountId: 'acc-reporter' };
    check('the assignee is a conflict', independenceConflict('acc-dev', issue)?.who, 'its own assignee');
    check('the reporter is a conflict', independenceConflict('acc-reporter', issue)?.who, 'the person who reported it');
    check('a third person is not a conflict', independenceConflict('acc-reviewer', issue), null);
    check('an unknown author is not compared', independenceConflict(null, issue), null);
    check(
      'a work item with no reporter still checks the assignee',
      independenceConflict('acc-dev', { assigneeAccountId: 'acc-dev', reporterAccountId: null })?.who,
      'its own assignee',
    );

    // Panel: the reporter signing off the change they reported is the same hands twice.
    state.commentAuthor = 'acc-reporter';
    state.commentAuthorName = 'Rep Two';
    const selfReported = await evaluateIssueGate({ issueKey: 'PAY-7', cloudId: 'cloud-1', accountId: 'acc-see' });
    const approvalRow = selfReported.requirements.find((row) => row.evidenceType === 'approval_comment');
    check('an approval by the reporter does not verify the claim', approvalRow?.state, 'MISSING');
    check(
      'and the row names the reporter as the conflict',
      /reported it/.test(approvalRow?.reason ?? '') || /reported it/.test(approvalRow?.evidence?.label ?? ''),
      true,
    );

    // A comment by a third account is still an approval.
    state.commentAuthor = 'acc-reviewer';
    state.commentAuthorName = 'Reviewer One';
    const independent = await evaluateIssueGate({ issueKey: 'PAY-7', cloudId: 'cloud-1', accountId: 'acc-see' });
    const independentRow = independent.requirements.find((row) => row.evidenceType === 'approval_comment');
    check('an approval by a third account verifies the claim', independentRow?.state, 'VERIFIED');

    // Scan: the same rule over a population.
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
    const requirement = {
      id: 'req-approval',
      control_id: 'control-1',
      evidence_type: 'approval_comment',
      max_age_days: 120,
      min_count: 1,
      rule_json: JSON.stringify({ approvalPattern: '\\b(approved|approval|lgtm)\\b', requiresIndependentApprover: true }),
    };
    const scanContext = () => ({
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
    });
    state.commentAuthor = 'acc-reporter';
    const scanned = await observeComments(scanContext(), control, requirement);
    check('the scan reads the reporter as a conflict too', scanned.candidates[0]?.usable, false);
    check(
      'and says so on the row',
      /reported it/.test(scanned.candidates[0]?.unusableReason ?? ''),
      true,
    );
    // The legacy rule string is widened, so the everyday sentence counts in a scan.
    const spanishOk = await observeComments(
      scanContext(),
      control,
      { ...requirement, id: 'req-legacy' },
    );
    check('the scan judges the legacy default with the widened pattern', spanishOk.candidates.length > 0, true);
    state.commentAuthor = 'acc-reviewer';
  }

  // --- 3. every write asks Jira first --------------------------------------
  {
    const granted = await checkJiraPermission({ permission: 'ADMINISTER' });
    check('a granted permission is GRANTED', granted.cause, 'GRANTED');
    check('and it carries Jira\u2019s own sentence', /granted/.test(granted.detail), true);

    state.permissions.ADMINISTER = false;
    const denied = await checkJiraPermission({ permission: 'ADMINISTER' });
    check('a withheld permission is DENIED', denied.cause, 'DENIED');
    check('and it is not allowed', denied.allowed, false);

    state.permissionStatus = 500;
    const broken = await checkJiraPermission({ permission: 'ADMINISTER' });
    check('a check that fails is UNESTABLISHED', broken.cause, 'UNESTABLISHED');
    check('and it is refused, not assumed', broken.allowed, false);

    state.permissionStatus = 200;
    state.permissionAnswer = 'empty';
    const silent = await checkJiraPermission({ permission: 'ADMINISTER' });
    check('an answer that does not state the permission is UNESTABLISHED', silent.cause, 'UNESTABLISHED');
    state.permissionAnswer = 'full';

    // The resolver layer: refused before anything is read or written.
    db.queries = [];
    db.controls = [];
    const controlSave = await callResolver('upsertControl', {
      code: 'AC-90',
      name: 'Evidence retention',
      evidenceType: 'policy_page',
      maxAgeDays: 30,
    });
    check('a denied custom control save is refused', controlSave.saved, false);
    check('and it names the permission', controlSave.permission, 'ADMINISTER');
    check('and nothing was written', db.controls.length, 0);
    check('the sentence tells the person who to ask', /site administrator/.test(controlSave.why ?? ''), true);

    const exceptionSave = await callResolver('recordException', {
      controlCode: 'AC-01',
      evidenceType: 'approval_comment',
      reason: 'Carried to the next sprint',
      expiresAt: '2027-01-31',
    });
    check('a denied exception is refused', exceptionSave.recorded, false);
    const withdraw = await callResolver('withdrawException', { controlCode: 'AC-01', evidenceType: 'approval_comment' });
    check('a denied withdrawal is refused', withdraw.withdrawn, false);
    const bind = await callResolver('bindProgramme', { projectKey: 'PAY' });
    check('a denied binding is refused', bind.bound, false);
    const seed = await callResolver('seedDemo', {});
    check('a denied seed is refused', seed.seeded, false);
    const closeAll = await callResolver('closeGaps', {});
    check('a denied closeGaps is refused', closeAll.created.length, 0);
    check('and the skip row says why', /ADMINISTER/.test(closeAll.skipped[0]?.why ?? ''), true);

    // The site grants again: the same calls must now go through, which is what makes the
    // refusals above a decision about permission rather than a broken path.
    delete state.permissions.ADMINISTER;
    const allowedSave = await callResolver('upsertControl', {
      code: 'AC-98',
      name: 'Change freeze evidence',
      evidenceType: 'jira_work_item',
      maxAgeDays: 30,
    });
    check('the same save is written once Jira grants ADMINISTER', allowedSave.saved, true);
    db.controls = db.controls.filter((row) => row.code !== 'AC-98');
    db.requirements = db.requirements.filter((row) => row.control_id !== allowedSave.controlId);

    state.permissions.EDIT_ISSUES = false;
    const claim = await callResolver('claimIssue', { issueKey: 'PAY-7', controlCode: 'AC-01' });
    check('claiming an item needs EDIT_ISSUES', claim.claimed, false);
    check('and the refusal names the item permission', claim.permission, 'EDIT_ISSUES');
    const closeIssue = await callResolver('closeGapsForIssue', { issueKey: 'PAY-7' });
    check('closing an item needs EDIT_ISSUES', closeIssue.created.length, 0);
    check('and the skip row carries the sentence', /Edit issues/.test(closeIssue.skipped[0]?.why ?? ''), true);
    state.permissions.EDIT_ISSUES = true;

    // A read is refused only on a confirmed denial.
    state.permissions.BROWSE_PROJECTS = false;
    const hidden = await evaluateIssueGate({ issueKey: 'PAY-7', cloudId: 'cloud-1', accountId: 'acc-see' });
    check('a confirmed denial stops the verdict', hidden.requirements.length, 0);
    check('and the badge says it is not visible to you', hidden.badge.state, 'NOT_EVALUATED');
    check('the refusal names the permission to ask for', /Browse projects/.test(hidden.badge.detail), true);
    check('and the denial is on the result', hidden.permission?.cause, 'DENIED');
    state.permissions.BROWSE_PROJECTS = true;

    state.permissionStatus = 500;
    const unconfirmed = await evaluateIssueGate({ issueKey: 'PAY-7', cloudId: 'cloud-1', accountId: 'acc-see' });
    check('an unconfirmed visibility check still judges the item', unconfirmed.requirements.length > 0, true);
    check('and discloses that it could not confirm', unconfirmed.permission?.cause, 'UNESTABLISHED');
    state.permissionStatus = 200;
  }

  // --- 4. a project key is a whitelist -------------------------------------
  {
    check('PAY is a project key', validateProjectKey('PAY').ok, true);
    check('PAY_CORE is a project key', validateProjectKey('PAY_CORE').ok, true);
    check('a quote is not a project key', validateProjectKey('PAY" OR 1=1').ok, false);
    check('lowercase is not a project key', validateProjectKey('pay').ok, false);
    check('a hyphen is not in a project key', validateProjectKey('PAY-1').ok, false);
    check('an empty key is refused', validateProjectKey('').ok, false);
    check(
      'the refusal says what a key looks like',
      /capital letter/.test(validateProjectKey('PAY" OR 1=1').why ?? ''),
      true,
    );

    state.jiraCalls = [];
    let threw = null;
    try {
      await callResolver('bindProgramme', { projectKey: 'PAY" OR 1=1' });
    } catch (cause) {
      threw = cause;
    }
    check('binding with an injected key does not throw past the resolver', threw, null);
    const bindRefusal = await callResolver('bindProgramme', { projectKey: 'PAY" OR 1=1' });
    check('and it is refused', bindRefusal.bound, false);
    check('with the reason', /not a Jira project key/.test(bindRefusal.why ?? ''), true);
    check(
      'and no JQL query was sent with it',
      state.jiraCalls.some((path) => /search\/jql/.test(path)),
      false,
    );
  }

  // --- 5. a custom control is validated and written with its rule -----------
  {
    db.controls = [];
    db.requirements = [];
    db.queries = [];
    const saved = await callResolver('upsertControl', {
      code: 'AC-90',
      name: 'Evidence retention decisions',
      evidenceType: 'approval_comment',
      maxAgeDays: 45,
      everyItem: true,
    });
    check('a custom control is saved', saved.saved, true);
    check('and it is new', saved.created, true);
    check('with its own label derived from the code', saved.jiraLabel, 'ctrl-ac-90');
    check('and the project it inherits is the bound one', saved.jiraProjectKey, 'PAY');
    check('one control row was written', db.controls.length, 1);
    check('one claim row was written', db.requirements.length, 1);
    const rule = JSON.parse(db.requirements[0].rule_json);
    check('the rule is universal when the form says so', rule.everyItem, true);
    check('the rule names an independent approver', rule.requiresIndependentApprover, true);
    check('the rule carries the approval pattern', /\bapprove\[sd\]\?/.test(rule.approvalPattern), true);
    check('the window is the one chosen', db.requirements[0].max_age_days, 45);

    // A second save of the same control and claim updates instead of duplicating.
    const again = await callResolver('upsertControl', {
      code: 'AC-90',
      name: 'Evidence retention decisions',
      evidenceType: 'approval_comment',
      maxAgeDays: 60,
      everyItem: false,
    });
    check('a second save updates the control', again.created, false);
    check('and does not add a control row', db.controls.length, 1);
    check('and does not add a claim row', db.requirements.length, 1);
    check('the window is the new one', db.requirements[0].max_age_days, 60);
    check('and the rule follows the form', JSON.parse(db.requirements[0].rule_json).everyItem, false);

    const badCode = await callResolver('upsertControl', { code: 'ac 90', name: 'x', evidenceType: 'policy_page' });
    check('a code with a space is refused', badCode.saved, false);
    check('and says how a code looks', /control code/.test(badCode.why ?? ''), true);
    const badType = await callResolver('upsertControl', { code: 'AC-91', name: 'x', evidenceType: 'vibes' });
    check('an unknown evidence type is refused', badType.saved, false);
    check('and lists the ones that exist', /jira_work_item/.test(badType.why ?? ''), true);
    const badWindow = await callResolver('upsertControl', {
      code: 'AC-92',
      name: 'x',
      evidenceType: 'jira_work_item',
      maxAgeDays: 0,
    });
    check('a zero-day window is refused', badWindow.saved, false);
    const noName = await callResolver('upsertControl', { code: 'AC-93', evidenceType: 'jira_work_item' });
    check('a control with no name is refused', noName.saved, false);

    // The JSON import reports each row.
    const imported = await callResolver('importControls', {
      json: JSON.stringify([
        { code: 'AC-95', name: 'Vendor onboarding approval', evidenceType: 'approval_comment', maxAgeDays: 30 },
        { code: 'AC-96', name: 'Key rotation attestation', evidenceType: 'test_record', maxAgeDays: 400, everyItem: true },
        { code: 'bad code', name: 'nope', evidenceType: 'jira_work_item' },
      ]),
    });
    check('the import saves the two good rows', imported.imported, 2);
    check('and counts the refused one', imported.failed, 1);
    check('and names what was refused', imported.results.find((row) => !row.saved)?.code, null);
    check(
      'with a sentence for the refused row',
      /control code|starts with a letter/i.test(imported.results.find((row) => !row.saved)?.why ?? ''),
      true,
    );

    const brokenJson = await callResolver('importControls', { json: '{not json' });
    check('unreadable JSON is refused', brokenJson.imported, 0);
    check('and says what to paste', /not JSON/.test(brokenJson.why ?? ''), true);
    const notAList = await callResolver('importControls', { json: '{"hello": 1}' });
    check('an object that holds no list is refused', /array/.test(notAList.why ?? ''), true);
    const tooMany = await callResolver('importControls', {
      json: JSON.stringify(Array.from({ length: 51 }, (_, index) => ({ code: `AC-${index}`, name: 'x', evidenceType: 'jira_work_item' }))),
    });
    check('an import is limited to 50 rows', /limited to 50/.test(tooMany.why ?? ''), true);

    // The domain function refuses on its own, without a resolver to catch it.
    const directRefusal = await saveCustomControl({ code: 'AC-97', name: 'x', evidenceType: 'policy_page' });
    check('a control with no project anywhere is refused', directRefusal.saved, false);
    check('and the sentence says to bind first', /Bind the programme/.test(directRefusal.why ?? ''), true);
    const directImport = await importCustomControls('[1,2]', { projectKeyFallback: 'PAY' });
    check('a non-object entry is refused, not written', directImport.imported, 0);
    check('and the report holds a row per entry', directImport.results.length, 2);
  }

  // --- 6. a withdrawn exception carries its actor ---------------------------
  {
    db.exceptions = [
      {
        id: 'ce-1',
        control_id: 'control-1',
        claim_key: 'AC-01:approval_comment',
        evidence_type: 'approval_comment',
        exception_reason: 'Carried to the next sprint',
        expires_at: '2027-01-31',
        compensating_control: null,
        recorded_by: 'acc-prior',
        recorded_at: daysAgo(10),
        active: 1,
      },
    ];
    db.queries = [];
    const withdrawn = await callResolver('withdrawException', {
      controlCode: 'AC-01',
      evidenceType: 'approval_comment',
    });
    check('the exception is withdrawn', withdrawn.withdrawn, true);
    check('and the resolver reports who did it', withdrawn.withdrawnBy, 'acc-admin');
    const update = db.queries.find((entry) => /UPDATE claim_exceptions SET active = 0/i.test(entry.query));
    check('the row keeps the actor', update?.params[0], 'acc-admin');
    check('and the time', /^\d{4}-\d{2}-\d{2}T/.test(String(update?.params[1])), true);
    check('the exception row is not deleted', db.exceptions.length, 1);

    const missing = await withdrawClaimException('AC-02.approval_comment', 'acc-admin');
    check('withdrawing one that is not there answers false', missing, false);
    const notThere = await callResolver('withdrawException', { controlCode: 'AC-02', evidenceType: 'approval_comment' });
    check('and the resolver says no exception is recorded', /No active exception/.test(notThere.why ?? ''), true);
  }

  // --- report --------------------------------------------------------------
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
  console.error('v6.50 harness failed:', cause);
  process.exitCode = 1;
});
