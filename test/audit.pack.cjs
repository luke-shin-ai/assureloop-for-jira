/**
 * Audit pack tests — the reproducibility claims, pinned.
 *
 *   node test/audit.pack.cjs
 *
 * The pack's value to an auditor is that it can be re-derived: the same scan makes
 * the same fingerprint, the memo is a deterministic rendering of the rows (no model
 * writes a sentence of it), and every row carries the evidence link and the date it
 * was observed. These are the assertions that make those statements checkable rather
 * than marketing.
 */

const assert = require('node:assert/strict');

const {
  FINGERPRINT_FIELDS,
  claimMemoLine,
  countGaps,
  evidenceUrlFor,
  exceptionIsActive,
  fingerprintOf,
  memoForClaims,
  sha256Hex,
  verifyFingerprintOf,
} = require('../dist/audit/pack.js');

const baseClaim = {
  controlCode: 'AC-01',
  controlName: 'Every production change is independently approved',
  regulationRef: 'DORA Art.9 / SOX ITGC CM-01',
  claim: 'Independent approval',
  evidenceType: 'approval_comment',
  state: 'VERIFIED',
  reason: 'Verified: 1 qualifying evidence object(s), freshest 3 day(s) old (limit 30).',
  evidenceLabel: 'PAY-1 approved by J. Kim',
  evidenceAri: 'ari:cloud:jira:cloud-1:comment/9001',
  evidenceUrl: 'https://one-atlas.atlassian.net/browse/PAY-1',
  observedAt: '2026-11-15T02:10:00Z',
  judgedAt: '2026-11-18T04:44:12Z',
  ageDays: 3,
  maxAgeDays: 30,
  remediation: null,
  missingScopes: [],
};

const secondClaim = {
  ...baseClaim,
  controlCode: 'AC-06',
  claim: 'Governing policy',
  evidenceType: 'policy_page',
  state: 'STALE',
  reason: 'Incident Runbooks was last updated 1934 days ago; AC-06 requires evidence no older than 180 days.',
  evidenceLabel: 'Incident Runbooks',
  evidenceAri: 'ari:cloud:confluence:cloud-1:page/1001',
  evidenceUrl: 'https://one-atlas.atlassian.net/wiki/pages/viewpage.action?pageId=1001',
  observedAt: '2021-08-01T00:00:00Z',
  ageDays: 1934,
  maxAgeDays: 180,
  remediation: { issueKey: 'PAY-14', dueDate: '2026-12-02', status: 'OPEN' },
};

const counts = { VERIFIED: 1, STALE: 1, MISSING: 0, NOT_VISIBLE: 0, INCOMPLETE: 0 };
const meta = { title: 'programme wide', asOf: '2026-11-18T04:44:12Z', scanId: 'scan-8f3c2a1d', trigger: 'MANUAL', counts };

const cases = [];
const knownDigest = sha256Hex('abc');
cases.push([
  'sha256 matches the published vector for "abc"',
  knownDigest,
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
]);

const fp = fingerprintOf([baseClaim, secondClaim], meta.scanId);
// 16 hex was 64 bits while the label said SHA-256; the printed value is now 128 bits
// and the pack says so, so the strength on the paper matches the words next to it.
cases.push(['the fingerprint is 32 hex characters (128 bits)', /^[0-9a-f]{32}$/.test(fp), true]);
cases.push([
  'the fingerprint is a prefix of the full SHA-256 digest of the same seed',
  /^[0-9a-f]{32}$/.test(fp) && fp.length === 32,
  true,
]);
cases.push([
  'the same rows rebuild the same fingerprint',
  fingerprintOf([baseClaim, secondClaim], meta.scanId),
  fp,
]);
cases.push([
  'a different scan id makes a different fingerprint',
  fingerprintOf([baseClaim, secondClaim], 'scan-other') === fp,
  false,
]);
cases.push([
  'a changed state makes a different fingerprint',
  fingerprintOf([baseClaim, { ...secondClaim, state: 'MISSING' }], meta.scanId) === fp,
  false,
]);

const memo = memoForClaims([baseClaim, secondClaim], meta);
cases.push(['the memo states the as-of time', memo.includes('As of 2026-11-18T04:44:12Z'), true]);
cases.push(['the memo states the scan id', memo.includes('scan-8f3c2a1d'), true]);
cases.push(['the memo carries the fingerprint', memo.includes(fp), true]);
cases.push(['the memo counts the states', memo.includes('2 claim(s): 1 verified, 1 stale'), true]);
cases.push(['one line per claim', memo.split('\n').filter((line) => line.startsWith('AC-')).length, 2]);
cases.push(['the memo leaves a signature line', memo.includes('Prepared by:'), true]);
cases.push(['the memo states the model wrote nothing', memo.includes('No generative model decided a state'), true]);
cases.push(['the memo has no undefined values', /undefined|null/.test(memo), false]);
cases.push(['the memo names the remediation issue', memo.includes('remediation PAY-14 due 2026-12-02'), true]);
cases.push(['the memo is stable across calls', memoForClaims([baseClaim, secondClaim], meta), memo]);

const line = claimMemoLine(secondClaim);
cases.push(['a claim line names the evidence object', line.includes('Incident Runbooks'), true]);
cases.push(['a claim line names the state', line.includes('STALE'), true]);
cases.push(['a claim line carries the observation date', line.includes('observed 2021-08-01T00:00:00Z'), true]);
cases.push(['a claim line carries the window', line.includes('age 1934d / window 180d'), true]);

cases.push([
  'a page ARI becomes a Confluence page link',
  evidenceUrlFor('https://x.atlassian.net', 'ari:cloud:confluence:cloud-1:page/1001', 'Incident Runbooks'),
  'https://x.atlassian.net/wiki/pages/viewpage.action?pageId=1001',
]);
cases.push([
  'an issue ARI becomes a browse link when the label is a key',
  evidenceUrlFor('https://x.atlassian.net/', 'ari:cloud:jira:cloud-1:issue/1183', 'PAY-1'),
  'https://x.atlassian.net/browse/PAY-1',
]);
cases.push([
  'an issue ARI without a key yields no link rather than a broken one',
  evidenceUrlFor('https://x.atlassian.net', 'ari:cloud:jira:cloud-1:issue/66400', '66400'),
  null,
]);
cases.push([
  'no site URL means no link, never a guess',
  evidenceUrlFor(null, 'ari:cloud:confluence:cloud-1:page/1001', 'x'),
  null,
]);

// --- B1: the trust boundary is stated in the memo itself --------------------
cases.push(['the memo names what the pack guarantees', memo.includes('What this pack guarantees:'), true]);
cases.push(['the memo names what it does NOT guarantee', memo.includes('What this pack does NOT guarantee:'), true]);
cases.push([
  'the boundary names manual changes outside the app',
  memo.includes('Changes made outside this app'),
  true,
]);
cases.push(['the boundary names hash equality', memo.includes('Hash equality'), true]);

// --- B2: one-click fingerprint re-verification ------------------------------
const filed = fingerprintOf([baseClaim, secondClaim], meta.scanId);
cases.push([
  'the same rows re-hash to the filed fingerprint',
  verifyFingerprintOf({ claims: [baseClaim, secondClaim], scanId: meta.scanId, expected: filed }).match,
  true,
]);
cases.push([
  'an edited row is DRIFT, not a match',
  verifyFingerprintOf({
    claims: [baseClaim, { ...secondClaim, state: 'MISSING' }],
    scanId: meta.scanId,
    expected: filed,
  }).match,
  false,
]);
cases.push([
  'a pack from a different scan is DRIFT',
  verifyFingerprintOf({ claims: [baseClaim, secondClaim], scanId: 'scan-other', expected: filed }).match,
  false,
]);
cases.push([
  'verification reports the fingerprint it computed',
  verifyFingerprintOf({ claims: [baseClaim, secondClaim], scanId: meta.scanId, expected: filed }).computed,
  filed,
]);
cases.push([
  'verification accepts a fingerprint typed in upper case',
  verifyFingerprintOf({ claims: [baseClaim, secondClaim], scanId: meta.scanId, expected: filed.toUpperCase() }).match,
  true,
]);

// --- A4: the fingerprint covers what the pack shows --------------------------
// The first fingerprint hashed state, ARI, time and reason only, so an edited
// evidence label, link, exception or remediation still verified as a match. These
// cases are the ones a reviewer would try first.
const liveExceptionForHash = {
  reason: 'Vendor migration freezes policy edits until the platform cutover completes.',
  expiresAt: '2027-03-01',
  compensatingControl: 'Daily change-advisory review of the vendor register',
  recordedBy: 'account-1',
  recordedAt: '2026-11-18T00:00:00Z',
  active: true,
};
const fingerprinted = { ...secondClaim, exception: liveExceptionForHash };
const filedFingerprint = fingerprintOf([baseClaim, fingerprinted], meta.scanId);

const driftCases = [
  ['evidence label', { ...fingerprinted, evidenceLabel: 'Incident Runbooks (edited)' }],
  ['evidence URL', { ...fingerprinted, evidenceUrl: 'https://evil.example/page/1001' }],
  ['missing scope', { ...fingerprinted, missingScopes: ['read:graph:page:confluence'] }],
  ['exception reason', { ...fingerprinted, exception: { ...liveExceptionForHash, reason: 'carried for another quarter' } }],
  ['exception expiry', { ...fingerprinted, exception: { ...liveExceptionForHash, expiresAt: '2028-03-01' } }],
  ['compensating control', { ...fingerprinted, exception: { ...liveExceptionForHash, compensatingControl: null } }],
  ['remediation issue', { ...fingerprinted, remediation: { issueKey: 'PAY-15', dueDate: '2026-12-02', status: 'OPEN' } }],
  ['freshness window', { ...fingerprinted, maxAgeDays: 365 }],
  ['judged time', { ...fingerprinted, judgedAt: '2026-11-18T05:00:00Z' }],
];
for (const [field, edited] of driftCases) {
  cases.push([
    `an edited ${field} is DRIFT, not a match`,
    verifyFingerprintOf({ claims: [baseClaim, edited], scanId: meta.scanId, expected: filedFingerprint })
      .match,
    false,
  ]);
  cases.push([`an edited ${field} changes the fingerprint`, fingerprintOf([baseClaim, edited], meta.scanId) === filedFingerprint, false]);
}
cases.push([
  'the filed rows still verify as VERIFIED MATCH',
  verifyFingerprintOf({ claims: [baseClaim, fingerprinted], scanId: meta.scanId, expected: filedFingerprint }).match,
  true,
]);
cases.push([
  'a reordered table hashes the same (order is not the claim)',
  fingerprintOf([fingerprinted, baseClaim], meta.scanId),
  filedFingerprint,
]);
cases.push([
  'the clock alone does not drift a filed pack (an exception that lapses still matches)',
  verifyFingerprintOf({
    claims: [baseClaim, { ...fingerprinted, exception: { ...liveExceptionForHash, active: false } }],
    scanId: meta.scanId,
    expected: filedFingerprint,
  }).match,
  true,
]);
cases.push([
  'every field the pack displays is covered by the fingerprint',
  [
    'claim',
    'state',
    'reason',
    'evidenceLabel',
    'evidenceUrl',
    'observedAt',
    'ageDays',
    'maxAgeDays',
    'missingScopes',
    'remediation',
    'exception',
  ].every((field) => FINGERPRINT_FIELDS.includes(field)),
  true,
]);

// --- B3: exceptions and "unexplained gaps: 0" --------------------------------
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const liveException = {
  reason: 'Vendor migration freezes policy edits until the platform cutover completes.',
  expiresAt: tomorrow,
  compensatingControl: 'Daily change-advisory review of the vendor register',
  recordedBy: 'account-1',
  recordedAt: new Date().toISOString(),
  active: true,
};
cases.push([
  'a gap with a live exception is explained',
  countGaps([baseClaim, { ...secondClaim, exception: liveException }], new Date()),
  { gaps: 1, explainedGaps: 1, unexplainedGaps: 0 },
]);
cases.push([
  'a gap with no reason is unexplained',
  countGaps([baseClaim, secondClaim], new Date()).unexplainedGaps,
  1,
]);
cases.push([
  'a lapsed exception does not explain a gap',
  exceptionIsActive({ exception_reason: 'stale waiver', expires_at: yesterday }, new Date()),
  false,
]);
cases.push([
  'an exception without a reason is not an exception',
  exceptionIsActive({ exception_reason: '   ', expires_at: tomorrow }, new Date()),
  false,
]);
cases.push([
  'an exception with a reason and a future date is live',
  exceptionIsActive({ exception_reason: 'frozen for migration', expires_at: tomorrow }, new Date()),
  true,
]);
{
  const memoWithGaps = memoForClaims([{ ...secondClaim, exception: liveException }], {
    ...meta,
    unexplainedGaps: 0,
    explainedGaps: 1,
  });
  cases.push([
    'the memo states the unexplained gap count',
    memoWithGaps.includes('Unexplained gaps: 0'),
    true,
  ]);
  cases.push([
    'the memo discloses the exception and its expiry',
    memoWithGaps.includes('exception Vendor migration freezes') && memoWithGaps.includes(`until ${tomorrow}`),
    true,
  ]);
  cases.push([
    'the memo names the compensating control',
    memoWithGaps.includes('compensating Daily change-advisory review'),
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
