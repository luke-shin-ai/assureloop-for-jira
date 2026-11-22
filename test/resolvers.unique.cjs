/**
 * Resolver-surface test: every resolver key is defined exactly once.
 *
 *   node test/resolvers.unique.cjs
 *
 * A duplicate `resolver.define(key, …)` does not fail the type checker and does
 * not stop `forge deploy`; it throws at runtime on the first call —
 * `Resolver definition 'closeGapsForIssue' already exists` — which takes down
 * every resolver of the app at once, macro and control room included. That is
 * exactly how the app broke once, so the keys are counted from the source.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');

const keys = [...source.matchAll(/resolver\.define\(\s*'([^']+)'/g)].map((match) => match[1]);
const counts = new Map();
for (const key of keys) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);

// The surfaces the UI and the macro call by name; a rename would break them.
const required = [
  'issueGate',
  'explainClaim',
  'environmentCheck',
  'controlRoom',
  'scanNow',
  'closeGapsForIssue',
  'claimIssue',
  'diagnostics',
  'siteSetup',
  'bindProgramme',
  'auditPack',
  'auditMemo',
];

const cases = [
  ['the app defines resolvers', keys.length >= required.length, true],
  ['no resolver key is defined twice', duplicates, []],
  [
    'every surface the UI calls is defined',
    required.filter((key) => !counts.has(key)),
    [],
  ],
];

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
console.log(`  (${keys.length} resolver definitions, ${counts.size} unique)`);
console.log(`\n${cases.length - failures}/${cases.length} assertions passed`);
process.exit(failures === 0 ? 0 : 1);
