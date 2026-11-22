#!/usr/bin/env node
/**
 * check:claims — the public documents may not disagree with the code.
 *
 *   npm run check:claims
 *   node scripts/check-claims.mjs --quiet
 *
 * Every number this repository quotes in public (README.md, TESTING.md and the
 * Devpost write-up) is produced by something in the repository. This script reads
 * them back from the source of truth and fails when a document says otherwise, so
 * a stale sentence is a red check instead of a reviewer's discovery:
 *
 *   controls and claims      src/seed/northwind-pay.ts (12 controls, 20 requirements)
 *   hashed fields            FINGERPRINT_FIELDS in src/audit/pack.ts (18)
 *   scopes                   permissions.scopes in manifest.yml (13)
 *   resolver keys            resolver.define in src/index.ts (20)
 *   tables                   CREATE TABLE statements in src/schema/sql.ts (9)
 *   Rovo actions             modules.action keys in manifest.yml (4)
 *   discovery population     the page size of the discovery JQL (5)
 *   assertions               each test/*.cjs file is executed and its own count read
 *
 * It also rejects a small set of typographic characters (em or en dash, middle dot,
 * arrows, smart quotes, ellipsis, emoji) in a public document, and any path that points
 * outside the repository, so a page reads the same in every viewer and links only to
 * files that exist here.
 *
 * No dependencies. Exit code 0 means every public number matches the code.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');
const rel = (p) => join(ROOT, p);

const problems = [];
const checked = [];
const fail = (message) => problems.push(message);
const ok = (message) => checked.push(message);

// ---------------------------------------------------------------------------
// 1. The numbers, read out of the code
// ---------------------------------------------------------------------------

const seed = read('src/seed/northwind-pay.ts');
const controls = (seed.match(/code: 'AC-\d+'/g) ?? []).length;
const claims = (seed.match(/^\s+evidenceType: '/gm) ?? []).length;

const pack = read('src/audit/pack.ts');
const fieldsBlock = pack.match(/FINGERPRINT_FIELDS: readonly string\[\] = \[([\s\S]*?)\];/);
const hashedFields = fieldsBlock ? (fieldsBlock[1].match(/^\s+'[^']+',/gm) ?? []).length : 0;

const manifest = read('manifest.yml');
const scopesBlock = manifest.split('\npermissions:')[1] ?? '';
const scopes = (scopesBlock.match(/^\s{4}'[^']+':/gm) ?? []).length;
const actionsBlock = manifest.match(/^\s{2}action:\n([\s\S]*?)(?=^\s{2}[a-z])/m);
const rovoActions = actionsBlock ? (actionsBlock[1].match(/^\s{4}- key:/gm) ?? []).length : 0;

const index = read('src/index.ts');
const resolverKeys = (index.match(/resolver\.define\(/g) ?? []).length;

const sql = read('src/schema/sql.ts');
const tables = new Set(sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) ?? []).size;

const discovery = index.match(/statusCategory = Done ORDER BY updated DESC`,\s*(\d+),/);
const discoverySize = discovery ? Number(discovery[1]) : -1;

const facts = { controls, claims, hashedFields, scopes, resolver_keys: resolverKeys, tables, rovo_actions: rovoActions, discovery: discoverySize };
for (const [name, value] of Object.entries(facts)) {
  if (!Number.isFinite(value) || value <= 0) fail(`could not read ${name} from the code (got ${value})`);
}
if (!problems.length) ok(`${controls} controls, ${claims} claims, ${hashedFields} hashed fields, ${scopes} scopes, ${resolverKeys} resolver keys, ${tables} tables, ${rovoActions} Rovo actions, discovery reads ${discoverySize}`);

// ---------------------------------------------------------------------------
// 2. The assertion counts, by running the suite the way `npm run smoke` does
// ---------------------------------------------------------------------------

const suite = JSON.parse(read('package.json')).scripts.smoke;
const smokeFiles = [...suite.matchAll(/node (test\/[\w.-]+\.cjs)/g)].map((m) => m[1]);
const allTests = ['resolvers.unique', 'judge.smoke', 'gate.fixture', 'scan.honesty', 'audit.pack', 'trace.render',
  'control-room.render', 'hardening', 'v627.regressions', 'v630.regressions', 'v635.regressions',
  'v640.regressions'].map((name) => `test/${name}.cjs`);
const missingFromSmoke = allTests.filter((file) => !smokeFiles.includes(file) && existsSync(rel(file)));
if (missingFromSmoke.length) fail(`npm run smoke does not run ${missingFromSmoke.join(', ')}: a test outside the suite is a test nobody runs`);

const counts = {};
let total = 0;
for (const file of smokeFiles) {
  if (!existsSync(rel(file))) {
    fail(`${file} is named in npm run smoke but does not exist`);
    continue;
  }
  const run = spawnSync(process.execPath, [rel(file)], { cwd: ROOT, encoding: 'utf8' });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const tally = [...output.matchAll(/(\d+)\/(\d+) assertions passed/g)].pop();
  if (run.status !== 0 || !tally) {
    fail(`${file} failed (exit ${run.status}): ${output.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
    continue;
  }
  counts[file] = Number(tally[1]);
  total += Number(tally[1]);
}
if (!problems.length) ok(`npm run smoke: ${total} assertions in ${Object.keys(counts).length} files, all passing`);

// ---------------------------------------------------------------------------
// 3. What the public documents may say
// ---------------------------------------------------------------------------

const docs = {
  'README.md': read('README.md'),
  'TESTING.md': read('TESTING.md'),
};

// The Devpost write-up is written beside the repository while the entry is prepared, so
// a clone has no copy of it. Checked when it is there, never required.
const devpost = join(ROOT, '../devpost-form-about.md');
if (existsSync(devpost)) docs['devpost-form-about.md'] = readFileSync(devpost, 'utf8');

// Documents that carry no numbers but still face a reader: the demo's own README.
const glyphDocs = { ...docs, 'docs/demo/README.md': read('docs/demo/README.md') };

const glyphNames = {
  '\u2014': 'em dash', '\u2013': 'en dash', '\u00b7': 'middle dot',
  '\u2192': 'arrow', '\u2190': 'arrow', '\u2191': 'arrow', '\u2193': 'arrow',
  '\u21d2': 'double arrow', '\u2018': 'smart quote', '\u2019': 'smart quote',
  '\u201c': 'smart quote', '\u201d': 'smart quote', '\u2026': 'ellipsis',
};
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

for (const [name, text] of Object.entries(glyphDocs)) {
  for (const [line, body] of text.split('\n').entries()) {
    const glyphs = [...body].filter((ch) => glyphNames[ch] || emoji.test(ch));
    if (glyphs.length) {
      const found = [...new Set(glyphs)].map((ch) => glyphNames[ch] ?? `emoji ${ch}`).join(', ');
      fail(`${name}:${line + 1} carries a typographic glyph (${found}): ${body.trim().slice(0, 90)}`);
    }
  }
}
if (!problems.length) ok('no typographic glyphs in the public documents (README, TESTING, demo README)');

/**
 * A public document may only point at files this repository has. A relative path that
 * walks out of the tree, or an absolute path into the machine that wrote it, is a 404
 * for every reader who is not the author, and a repository is read by people who are
 * not the author.
 */
const outsideTree = [
  [/\/workspace\//, 'an absolute working path (/workspace/...)'],
  [/(^|[\s(`"'])\.\.\//, 'a relative path outside the repository (../...)'],
  [/\bhackathons\//, 'a project folder that is not part of this repository'],
];
for (const [name, text] of Object.entries(glyphDocs)) {
  for (const [line, body] of text.split('\n').entries()) {
    const hit = outsideTree.find(([pattern]) => pattern.test(body));
    if (hit) fail(`${name}:${line + 1} points at ${hit[1]}: ${body.trim().slice(0, 90)}`);
  }
}
if (!problems.length) ok('no public document points outside the repository (no ../, no /workspace/)');

/** Assert every "<n> assertions" in a document equals the measured total. */
function checkAssertionTotals(name, text) {
  for (const match of text.matchAll(/(\d+)\s+assertions\b/g)) {
    if (Number(match[1]) !== total) {
      fail(`${name} says "${match[1]} assertions"; the suite runs ${total}`);
    }
  }
  for (const match of text.matchAll(/(?<![\d/])(\d+)\/(\d+)(?![\d/])/g)) {
    if (Number(match[1]) !== total || Number(match[2]) !== total) {
      fail(`${name} says "${match[1]}/${match[2]}"; the suite runs ${total}/${total}`);
    }
  }
}

for (const [name, text] of Object.entries(docs)) checkAssertionTotals(name, text);

// The per-file table in TESTING.md §7 must agree with the runs above.
const testing = docs['TESTING.md'];
for (const [file, count] of Object.entries(counts)) {
  const base = file.replace(/^test\//, '').replace('.', '\\.');
  const row = testing.match(new RegExp(`\\|\\s*[\`*]{0,2}${base}[\`*]{0,2}\\s*\\|\\s*(\\d+)\\s*\\|`));
  if (!row) {
    fail(`TESTING.md §7 has no row for ${file} (${count} assertions)`);
  } else if (Number(row[1]) !== count) {
    fail(`TESTING.md §7 says ${file} has ${row[1]} assertions; it runs ${count}`);
  }
}
const totalRow = testing.match(/\|\s*\*\*total\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/);
if (!totalRow) fail('TESTING.md §7 has no total row');
else if (Number(totalRow[1]) !== total) fail(`TESTING.md §7 total says ${totalRow[1]}; the files add up to ${total}`);
if (!problems.length) ok('TESTING.md §7 per-file counts and total match the runs');

// ---------------------------------------------------------------------------
// 4. The structural claims the submission quotes
// ---------------------------------------------------------------------------

const spoken = [
  [/(\d+) controls\b/g, controls, 'controls'],
  [/(\d+) claims\b/g, claims, 'claims'],
  [/(\d+)\s*hashed fields|(\d+)-field coverage|fingerprint over (\d+) fields/g, hashedFields, 'hashed fields'],
  [/(\d+) scopes\b/g, scopes, 'scopes'],
  [/(\d+) resolver keys\b/g, resolverKeys, 'resolver keys'],
  [/(\d+) tables\b/g, tables, 'tables'],
];
const prose = (text) => text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
for (const [name, text] of Object.entries(docs)) {
  const body = prose(text);
  for (const [pattern, expected, label] of spoken) {
    for (const match of body.matchAll(pattern)) {
      const value = Number(match[1] ?? match[2] ?? match[3]);
      if (Number.isFinite(value) && value !== expected) {
        fail(`${name} says "${value} ${label}"; the code has ${expected}`);
      }
    }
  }
}

// Verdict lines: the five states must add up to the claim count.
const verdictLine = docs['README.md'].match(
  /(\d+) verified, (\d+) stale, (\d+) missing, (\d+) not visible, (\d+) not checked/,
);
if (!verdictLine) {
  fail('README.md no longer states the measured verdict line (n verified, n stale, ...)');
} else {
  const sum = verdictLine.slice(1, 6).reduce((acc, n) => acc + Number(n), 0);
  if (sum !== claims) fail(`README.md's verdict line adds up to ${sum}; the programme has ${claims} claims`);
}
for (const slash of docs['README.md'].matchAll(/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)/g)) {
  const sum = slash.slice(1, 6).reduce((acc, n) => acc + Number(n), 0);
  if (sum !== claims) fail(`README.md quotes "${slash[0]}"; those five states add up to ${sum}, not ${claims} claims`);
}

// Discovery mode reads a fixed number of recent changes; the Devpost text names it.
if (discoverySize > 0) {
  const spelled = ['five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const word = spelled[discoverySize - 5] ?? String(discoverySize);
  const sentence = docs['devpost-form-about.md'];
  if (sentence && !new RegExp(`\\b(${word}|${discoverySize})\\b most recently completed change`).test(sentence)) {
    fail(`the Devpost write-up does not describe discovery mode as reading the ${discoverySize} most recently completed changes`);
  }
}
if (!problems.length) ok('the structural numbers in the documents match the manifest, the seed and the schema');

// ---------------------------------------------------------------------------
// 5. The static demo (docs/demo) is generated from the shipped programme
// ---------------------------------------------------------------------------

const demoPath = 'docs/demo/index.html';
if (!existsSync(rel(demoPath))) {
  fail(`${demoPath} is missing: the no-install demo is what the README's first table links to`);
} else {
  const demo = read(demoPath);
  const quoted = demo.match(/data-claims="(\d+)"/);
  if (!quoted) fail(`${demoPath} does not carry data-claims="<n>"`);
  else if (Number(quoted[1]) !== claims) fail(`${demoPath} renders ${quoted[1]} claims; the programme has ${claims}`);
  for (const [line, body] of demo.split('\n').entries()) {
    const glyphs = [...body].filter((ch) => glyphNames[ch] || emoji.test(ch));
    if (glyphs.length) fail(`${demoPath}:${line + 1} carries a typographic glyph (${[...new Set(glyphs)].join(' ')})`);
  }
  const demoData = read('docs/demo/data.js');
  for (const file of ['docs/demo/data.js', 'docs/demo/app.js', 'docs/demo/styles.css']) {
    for (const [line, body] of read(file).split('\n').entries()) {
      const glyphs = [...body].filter((ch) => glyphNames[ch] || emoji.test(ch));
      if (glyphs.length) fail(`${file}:${line + 1} carries a typographic glyph (${[...new Set(glyphs)].join(' ')})`);
    }
  }
  const demoFields = demoData.match(/"fingerprintFields": \[([\s\S]*?)\]/);
  const demoFieldNames = demoFields ? [...demoFields[1].matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]) : [];
  const sourceFields = fieldsBlock ? [...fieldsBlock[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]) : [];
  if (demoFieldNames.join(',') !== sourceFields.join(',')) {
    fail(`docs/demo/data.js hashes ${demoFieldNames.length} field(s) the app does not: ${demoFieldNames.join(', ')}`);
  }
  const demoCounts = demoData.match(/"VERIFIED": (\d+),\s*"STALE": (\d+),\s*"MISSING": (\d+),\s*"NOT_VISIBLE": (\d+),\s*"INCOMPLETE": (\d+)/);
  if (!demoCounts) fail('docs/demo/data.js carries no verdict counts');
  else {
    const states = ['VERIFIED', 'STALE', 'MISSING', 'NOT_VISIBLE', 'INCOMPLETE'];
    const total = states.reduce((acc, state, index) => acc + Number(demoCounts[index + 1]), 0);
    if (total !== claims) fail(`docs/demo/data.js counts add up to ${total}; the programme has ${claims} claims`);
  }
  if (!problems.length) ok(`${demoPath} renders ${claims} claims, hashes the app's ${sourceFields.length} fields, and carries no typographic glyph`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (problems.length) {
  console.error(`check:claims FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nA public document may not disagree with the code. Fix the document, or the number.');
  process.exit(1);
}

if (!process.argv.includes('--quiet')) {
  console.log('check:claims OK');
  for (const line of checked) console.log(`  ok  ${line}`);
}
