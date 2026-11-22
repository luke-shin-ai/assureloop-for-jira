/**
 * DOM test for the control room — the surface that rolls the last scan up.
 *
 *   node test/control-room.render.cjs
 *
 * The "Scan the registry" button is the one action the whole rollup depends on,
 * and it once shipped dead: `const scan = rollup.lastScan` inside the card
 * shadowed the `scan()` handler, so `el()` saw an object instead of a function,
 * attached no listener, and the button did nothing while every automated click
 * looked successful. This test clicks the real button in a real DOM and asserts
 * the resolver was actually invoked.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');

const stub = `
export const invoke = async (name, payload) => {
  const log = (globalThis.__invoked = globalThis.__invoked || []);
  log.push({ name, payload });
  if (name === 'controlRoom') {
    return {
      demoSeeded: true,
      lastScan: {
        id: 'scan-1',
        finishedAt: '2026-11-18T04:44:00Z',
        trigger: 'ROVO_ACTION',
        durationMs: 16960,
        counts: { VERIFIED: 15, STALE: 0, MISSING: 4, NOT_VISIBLE: 0, INCOMPLETE: 0 },
      },
      delta: { VERIFIED: 2, STALE: -1, MISSING: 0, NOT_VISIBLE: 0, INCOMPLETE: 0 },
      unexplainedGaps: 1,
      explainedGaps: 0,
      guarantees: {
        does: ['Deterministic observation inside the app’s scope.', 'Hash equality over the claim rows.'],
        doesNot: ['Changes made outside this app.', 'Systems the app does not watch.'],
      },
      orphans: {
        mode: 'rest+registry',
        spaces: ['ITO'],
        pagesSeen: 12,
        claimed: 2,
        orphans: [
          { pageId: '502', title: 'Legacy Vendor Register', spaceKey: 'ITO', lastUpdatedAt: '2025-01-01T00:00:00Z', webPath: null },
        ],
        truncated: false,
        scannedAt: '2026-11-18T04:44:00Z',
        notes: [],
      },
      audit: {
        asOf: '2026-11-18T04:44:00Z',
        scanId: 'scan-1',
        fingerprint: '1ed720dc080bcf63',
        fingerprintBasis: '19 claim row(s) · scan scan-1',
        claims: [
          {
            controlCode: 'AC-06',
            claim: 'Governing policy',
            state: 'STALE',
            reason: 'Incident Runbooks was last updated 1,934 days ago.',
            evidenceLabel: 'Incident Runbooks',
            evidenceUrl: null,
            observedAt: '2021-08-01T00:00:00Z',
            remediation: null,
            exception: null,
          },
        ],
        unexplainedGaps: 1,
        explainedGaps: 0,
        guarantees: {
          does: ['Deterministic observation inside the app’s scope.'],
          doesNot: ['Changes made outside this app.'],
        },
      },
      integrity: null,
      gaps: [
        {
          controlCode: 'AC-06',
          evidenceType: 'policy_page',
          claimKey: 'AC-06:policy_page',
          state: 'STALE',
          reason: 'The governing runbook is 1,936 days old.',
          remediation: null,
          exception: null,
        },
        {
          controlCode: 'AC-02',
          evidenceType: 'approval_comment',
          claimKey: 'AC-02:approval_comment',
          state: 'MISSING',
          reason: 'PAY-2 was approved by its own assignee.',
          remediation: null,
          exception: {
            reason: 'Segregation of duties covered by the platform team review until the new workflow ships.',
            expiresAt: '2027-01-31',
            compensatingControl: 'Four-eyes review in the platform stand-up',
            active: true,
          },
        },
      ],
      controls: [
        { code: 'AC-06', name: 'Incident postmortem completed within five business days', regulationRef: 'DORA Art.17', cadence: 'CONTINUOUS', state: 'STALE', openGaps: 1, incomplete: 0 },
      ],
      environment: null,
    };
  }
  if (name === 'verifyFingerprint') {
    return { verified: true, status: 'VERIFIED MATCH', computed: '1ed720dc080bcf63', claims: 19 };
  }
  if (name === 'siteSetup') {
    return {
      binding: { projectKey: 'PAY', spaceKey: null, boundAt: '2026-11-20T04:17:00Z', boundBy: 'acc-luke' },
      projects: [{ key: 'PAY', name: 'Northwind Pay' }],
      spaces: [
        { key: '~71202007bccbc517d7470a849b47c63d55a174', name: 'luke luck (yottaman)' },
        { key: 'TK', name: 'Tally KB' },
      ],
    };
  }
  if (name === 'bindProgramme') {
    return {
      bound: true,
      projectKey: payload?.projectKey ?? 'PAY',
      spaceKey: payload?.spaceKey ?? null,
      controls: 12,
      requirements: 30,
    };
  }
  if (name === 'onboardSite') {
    return {
      bound: true,
      projectKey: payload?.projectKey ?? 'PAY',
      spaceKey: payload?.spaceKey ?? null,
      created: [{ key: 'PAY-201', done: true, status: 'Done', note: 'completed' }],
      skipped: [],
      scan: { counts: { VERIFIED: 1, STALE: 0, MISSING: 0, NOT_VISIBLE: 0, INCOMPLETE: 18 }, durationMs: 4200, scanId: 'scan-2' },
    };
  }
  if (name === 'environmentCheck') {
    return {
      checkedAt: '2026-11-18T04:45:00Z',
      durationMs: 900,
      budgetMs: 5000,
      summary: { green: 3, yellow: 3, red: 0 },
      probes: [
        { id: 'connection', label: 'Connection (echo)', state: 'GREEN', detail: 'ok', scopes: [], remedy: 'No action needed.', latencyMs: 12 },
      ],
      fixtures: {},
    };
  }
  return { ok: true };
};
export const view = { getContext: async () => ({}) };
`;

async function bundle() {
  const result = await build({
    entryPoints: [path.join(root, 'ui/control-room/main.js')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    alias: { '@forge/bridge': path.join(root, 'test/bridge.stub.js') },
    logLevel: 'warning',
  });
  return result.outputFiles[0].text;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const fs = require('node:fs');
  fs.writeFileSync(path.join(root, 'test/bridge.stub.js'), stub);
  const code = await bundle();

  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', {
    runScripts: 'outside-only',
    url: 'https://example.atlassian.net/',
  });
  dom.window.eval(code);
  await wait(60);

  const document = dom.window.document;
  const buttons = [...document.querySelectorAll('button')];
  const labels = buttons.map((button) => button.textContent);
  const scanButton = buttons.find((button) => button.textContent === 'Scan the registry');

  const cases = [
    ['the rollup renders', document.querySelector('#app')?.textContent.includes('AssureLoop control room'), true],
    ['the scan button is on screen', Boolean(scanButton), true],
    ['the control room loaded before the click', labels.length >= 2, true],
  ];

  if (scanButton) {
    scanButton.click();
    await wait(60);
  }

  const invoked = (dom.window.__invoked ?? []).map((entry) => entry.name);
  cases.push(['clicking Scan the registry calls the scanNow resolver', invoked.includes('scanNow'), true]);
  cases.push(['the initial load still asks for the rollup', invoked.includes('controlRoom'), true]);

  // --- B1/B2/B3/B4/C5: the new surfaces actually render --------------------
  const text = document.querySelector('#app')?.textContent ?? '';
  cases.push(['the trust boundary is on screen', text.includes('What this pack does NOT guarantee'), true]);
  cases.push(['the unexplained gap count is on screen', /Unexplained gaps: 1/.test(text), true]);
  cases.push(['the before/after line is on screen', /verified 13 → 15/.test(text), true]);
  cases.push(['the unclaimed page is listed', text.includes('Legacy Vendor Register'), true]);

  const verifyButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Verify fingerprint');
  cases.push(['the Verify fingerprint button is on screen', Boolean(verifyButton), true]);
  if (verifyButton) {
    verifyButton.click();
    await wait(60);
  }
  const afterVerify = (dom.window.__invoked ?? []).map((entry) => entry.name);
  cases.push(['Verify fingerprint calls the resolver', afterVerify.includes('verifyFingerprint'), true]);
  cases.push([
    'the verification result is shown',
    (document.querySelector('#app')?.textContent ?? '').includes('VERIFIED MATCH'),
    true,
  ]);

  const exceptionButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Record an exception');
  cases.push(['a gap can be given an exception', Boolean(exceptionButton), true]);
  if (exceptionButton) {
    exceptionButton.click();
    await wait(30);
  }
  const inputs = [...document.querySelectorAll('.exception-form input')];
  cases.push(['the exception form asks for a reason, an expiry and a compensating control', inputs.length, 3]);

  // v6.35: pressing Record used to throw `ReferenceError: invoke is not defined`.
  // The handler called an identifier the module never imported (it imports
  // `invokeWarm`), so the exception feature — the one the target-winning case study
  // taught us to build — was dead on the surface that shows it. The click is what
  // the test does now, not just opening the form.
  if (inputs[0]) {
    inputs[0].value = 'Covered by the platform review until the workflow ships.';
    inputs[1].value = '2027-01-31';
    const recordButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Record');
    if (recordButton) {
      recordButton.click();
      await wait(80);
    }
  }
  const recorded = [...(dom.window.__invoked ?? [])].find((entry) => entry.name === 'recordException');
  cases.push(['pressing Record calls the recordException resolver', Boolean(recorded), true]);
  cases.push([
    'the exception is recorded against the gap it was opened on',
    recorded?.payload?.claimKey ?? `${recorded?.payload?.controlCode}:${recorded?.payload?.evidenceType}`,
    'AC-06:policy_page',
  ]);

  // The withdraw button only renders for a gap that carries a live exception.
  const withdrawButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Withdraw');
  cases.push(['a recorded exception can be withdrawn', Boolean(withdrawButton), true]);
  if (withdrawButton) {
    withdrawButton.click();
    await wait(80);
  }
  const withdrawn = [...(dom.window.__invoked ?? [])].find((entry) => entry.name === 'withdrawException');
  cases.push(['pressing Withdraw calls the withdrawException resolver', Boolean(withdrawn), true]);
  cases.push(['Withdraw names the gap it withdraws', withdrawn?.payload?.controlCode, 'AC-02']);

  // --- v6.30: "no space" is a real choice, and it must survive a re-render -----
  // The bind card recomputed its select with `||`, so the empty value fell back to
  // the first space on the next render: choosing "no space" and pressing Bind bound
  // the personal space instead, and every policy rule was pointed at it.
  const spaceSelectOf = () => [...document.querySelectorAll('select')][1];
  spaceSelectOf().value = '';
  spaceSelectOf().dispatchEvent(new dom.window.Event('change'));
  const scanAgain = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Scan the registry');
  if (scanAgain) {
    scanAgain.click();
    await wait(120);
  }
  cases.push(['choosing no space survives a re-render', spaceSelectOf().value, '']);
  const bindButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Bind the programme');
  cases.push(['the bind button is on screen', Boolean(bindButton), true]);
  if (bindButton) {
    bindButton.click();
    await wait(120);
  }
  const bindCall = [...(dom.window.__invoked ?? [])].reverse().find((entry) => entry.name === 'bindProgramme');
  cases.push(['binding with no space sends no spaceKey', bindCall?.payload?.spaceKey, undefined]);

  // --- v6.35: one click from an empty site to a judged one -------------------
  const onboardButton = [...document.querySelectorAll('button')].find((button) =>
    /Judge it on your site/.test(button.textContent ?? ''),
  );
  cases.push(['the one-click onboarding is on screen', Boolean(onboardButton), true]);
  if (onboardButton) {
    onboardButton.click();
    await wait(120);
  }
  const onboardCall = [...(dom.window.__invoked ?? [])].find((entry) => entry.name === 'onboardSite');
  cases.push(['the button binds and seeds in one call', Boolean(onboardCall), true]);
  cases.push([
    'it uses the project chosen on screen',
    onboardCall?.payload?.projectKey ?? null,
    'PAY',
  ]);
  cases.push([
    'the result shows the first scan\'s counts',
    /1 verified/.test(document.querySelector('#app')?.textContent ?? ''),
    true,
  ]);
  cases.push([
    'it says the sample change was created',
    (document.querySelector('#app')?.textContent ?? '').includes('PAY-201'),
    true,
  ]);

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
  console.log(`  (buttons ${JSON.stringify(labels)}, invoked ${JSON.stringify(invoked)})`);
  console.log(`\n${cases.length - failures}/${cases.length} assertions passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('control room harness failed:', error);
  process.exit(1);
});
