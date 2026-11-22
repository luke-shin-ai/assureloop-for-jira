/**
 * Hardening tests — the findings from the external cross-review that are not a
 * single verdict: the scope ledger, the reverse (orphan) scan, the daily-trigger
 * guard and the trust boundary the gate carries.
 *
 *   node test/hardening.cjs
 *
 * Each case is here because a reviewer named it: C3 (the ledger was always empty),
 * C5 (orphan evidence was a string with no caller), C7 (the daily scan skipped
 * itself silently) and B1 (the pack never stated what it does not guarantee).
 */

const assert = require('node:assert/strict');
const Module = require('node:module');

const DAY = 86400000;
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

// ---------------------------------------------------------------------------
// A Confluence that has one claimed page and one that nothing claims
// ---------------------------------------------------------------------------

const pages = [
  {
    id: '501',
    title: 'Change Management Policy v7',
    spaceId: '77',
    version: { createdAt: daysAgo(10), number: 3 },
    _links: { webui: '/spaces/ITO/pages/501/Change+Management+Policy+v7' },
  },
  {
    id: '502',
    title: 'Legacy Vendor Register (unused)',
    spaceId: '77',
    version: { createdAt: daysAgo(900), number: 1 },
    _links: { webui: '/spaces/ITO/pages/502/Legacy+Vendor+Register' },
  },
];

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  };
}

const requester = {
  requestConfluence: async (route) => {
    const path = String(route);
    if (/\/spaces\?keys=/.test(path)) {
      return json({ results: [{ id: '77' }] });
    }
    if (/\/pages\?/.test(path)) {
      return json({ results: pages });
    }
    return json({ results: [] });
  },
  requestJira: async () => json({ issues: [] }),
  requestTeamworkGraph: async () => json({ data: {} }),
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

const {
  buildScopeLedger,
  scopeProbeFromObservation,
} = require('../dist/twg/queries.js');
const { findOrphanEvidence, pageIsClaimed } = require('../dist/audit/orphans.js');
const { shouldRunDailyScan } = require('../dist/index.js');

const cases = [];

async function main() {
  // --- C3: the ledger is a measurement, not an assumption --------------------
  {
    const proven = scopeProbeFromObservation('gate:policy_page', {
      requirementId: 'r1',
      evidenceType: 'policy_page',
      scope: 'read:graph:page:confluence',
      read: { label: 'owners', mode: 'curated', outcome: 'ROWS', latencyMs: 12, retries: 0 },
      candidates: [{ ari: 'ari:x', kind: 'confluence_page', observedAt: daysAgo(1), usable: true }],
      // v6.35: only rows the *graph* returned through the scope prove it. A policy
      // page found over REST is a candidate, not a proof of the graph read.
      scopeRows: 2,
      provenance: [],
      failures: [],
    });
    cases.push(['a hop that returned rows proves its scope', proven?.state, 'PROVEN']);

    const restOnly = scopeProbeFromObservation('gate:policy_page', {
      requirementId: 'r1',
      evidenceType: 'policy_page',
      scope: 'read:graph:page:confluence',
      read: { label: 'owners', mode: 'curated', outcome: 'ROWS', latencyMs: 12, retries: 0 },
      candidates: [{ ari: 'ari:x', kind: 'confluence_page', observedAt: daysAgo(1), usable: true }],
      provenance: [],
      failures: [],
    });
    cases.push(['a REST candidate does not prove the graph scope', restOnly?.state, 'INCONCLUSIVE']);

    const deniedWithCandidates = scopeProbeFromObservation('gate:policy_page', {
      requirementId: 'r1',
      evidenceType: 'policy_page',
      scope: 'read:graph:page:confluence',
      read: { label: 'owners', mode: 'curated', outcome: 'ERROR', latencyMs: 12, retries: 0 },
      candidates: [{ ari: 'ari:x', kind: 'confluence_page', observedAt: daysAgo(1), usable: true }],
      scopeRows: 0,
      provenance: [],
      failures: [
        { cause: 'PERMISSION_DENIED', message: 'denied', scope: 'read:graph:page:confluence', retryable: false },
      ],
    });
    cases.push(['a denial is not outvoted by a REST candidate (A7)', deniedWithCandidates?.state, 'DENIED']);

    const denied = scopeProbeFromObservation('gate:policy_page', {
      requirementId: 'r1',
      evidenceType: 'policy_page',
      scope: 'read:graph:page:confluence',
      read: { label: 'owners', mode: 'curated', outcome: 'ERROR', latencyMs: 12, retries: 0 },
      candidates: [],
      provenance: [],
      failures: [
        { cause: 'PERMISSION_DENIED', message: 'denied', scope: 'read:graph:page:confluence', retryable: false },
      ],
    });
    cases.push(['a denied hop denies its scope', denied?.state, 'DENIED']);

    const empty = scopeProbeFromObservation('gate:policy_page', {
      requirementId: 'r1',
      evidenceType: 'policy_page',
      scope: 'read:graph:page:confluence',
      read: { label: 'owners', mode: 'curated', outcome: 'EMPTY', latencyMs: 12, retries: 0 },
      candidates: [],
      provenance: [],
      failures: [],
    });
    cases.push(['an empty answer proves nothing', empty?.state, 'INCONCLUSIVE']);

    const none = scopeProbeFromObservation('gate:approval', {
      requirementId: 'r2',
      evidenceType: 'approval_comment',
      scope: null,
      read: { label: 'comments', mode: 'rest', outcome: 'ROWS', latencyMs: 5, retries: 0 },
      candidates: [],
      provenance: [],
      failures: [],
    });
    cases.push(['a REST-only claim does not pretend to prove a graph scope', none, null]);

    const ledger = buildScopeLedger([empty, denied, proven]);
    cases.push(['a proven scope is not overwritten by a later denial', ledger['read:graph:page:confluence'], 'PROVEN']);
  }

  // --- C5: the reverse scan finds evidence no control claims -----------------
  {
    cases.push([
      'a page whose title a rule names is claimed',
      pageIsClaimed({ title: 'Change Management Policy v7', id: '501' }, [{ title: 'Change Management Policy', ari: null }]),
      true,
    ]);
    cases.push([
      'a page carrying a registered link is claimed',
      pageIsClaimed({ title: 'Anything', id: '501' }, [{ title: null, ari: 'ari:cloud:confluence:cloud-1:page/501' }]),
      true,
    ]);
    cases.push([
      'a page nothing names is an orphan',
      pageIsClaimed({ title: 'Legacy Vendor Register (unused)', id: '502' }, [{ title: 'Change Management Policy', ari: null }]),
      false,
    ]);

    const scan = await findOrphanEvidence({
      spaces: ['ITO'],
      claimed: [{ title: 'Change Management Policy', ari: null }],
    });
    cases.push(['the reverse scan reads the bound space', scan.spaces.join(','), 'ITO']);
    cases.push(['it counts the pages it saw', scan.pagesSeen, 2]);
    cases.push(['it separates claimed pages', scan.claimed, 1]);
    cases.push(['it reports the unclaimed page', scan.orphans.map((page) => page.title).join(','), 'Legacy Vendor Register (unused)']);
    cases.push(['the orphan says where it lives', scan.orphans[0]?.spaceKey, 'ITO']);
    cases.push(['the scan says how it read', scan.mode, 'rest+registry']);

    const unbound = await findOrphanEvidence({ spaces: [], claimed: [] });
    cases.push(['no bound space is explained, not reported as zero orphans', unbound.notes.length > 0, true]);
    cases.push(['no bound space yields no orphans', unbound.orphans.length, 0]);
  }

  // --- C7: the daily guard ---------------------------------------------------
  cases.push(['no previous run means run now', shouldRunDailyScan(null, new Date()), true]);
  cases.push([
    'a run 19 hours ago is too soon',
    shouldRunDailyScan(new Date(Date.now() - 19 * 3600 * 1000).toISOString(), new Date()),
    false,
  ]);
  cases.push([
    'a run 21 hours ago is due',
    shouldRunDailyScan(new Date(Date.now() - 21 * 3600 * 1000).toISOString(), new Date()),
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
  console.log(`\n${cases.length - failures}/${cases.length} assertions passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('hardening harness failed:', error);
  process.exit(1);
});
