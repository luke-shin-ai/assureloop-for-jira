/**
 * DOM render test for the provenance trace and the environment panel.
 *
 *   node test/trace.render.cjs
 *
 * The diagram is the screen a judge remembers, so it gets a real DOM rather than
 * a promise: the bundle is built with the Forge bridge aliased to a stub, loaded
 * into jsdom, and asserted on what it actually appended — one box per hop node,
 * one curve per relationship, the queryKey/rows/ms footer, and a coloured row per
 * environment probe.
 *
 * It also holds the two layout defects G0 found: boxes in one column used to be
 * drawn on top of each other (a space node and a page node in the same column),
 * and long relationship names were painted under the boxes and read as cut off.
 * So the geometry is asserted, not just the element count.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');

const stub = `
export const invoke = async () => ({});
export const view = { getContext: async () => ({}) };
`;

async function bundle() {
  const result = await build({
    stdin: {
      contents: `export { renderTrace, renderEnvironment, chip, stateLabel } from '../ui/shared/ui.js';`,
      resolveDir: path.join(root, 'test'),
      sourcefile: 'entry.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'SharedUI',
    platform: 'browser',
    target: ['es2020'],
    alias: { '@forge/bridge': path.join(root, 'test/bridge.stub.js') },
    logLevel: 'warning',
  });
  return result.outputFiles[0].text;
}

/** Node boxes as drawn: x, y, width, height. */
function boxes(node) {
  return [...node.querySelectorAll('rect.node-box')].map((box) => ({
    x: Number(box.getAttribute('x')),
    y: Number(box.getAttribute('y')),
    w: Number(box.getAttribute('width')),
    h: Number(box.getAttribute('height')),
  }));
}

/** Estimated ink box of a text line, from its anchor and its length. */
function inkBox(text, charWidth) {
  const value = text.textContent ?? '';
  const cx = Number(text.getAttribute('x'));
  const baseline = Number(text.getAttribute('y'));
  const half = (value.length * charWidth) / 2;
  return { x: cx - half, y: baseline - charWidth * 0.9, w: value.length * charWidth, h: charWidth * 1.3 };
}

function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function layoutReport(container) {
  const svg = container.querySelector('svg');
  const width = Number(svg?.getAttribute('width') ?? 0);
  const height = Number(svg?.getAttribute('height') ?? 0);
  const rectangles = boxes(container);

  const overlapping = [];
  for (let i = 0; i < rectangles.length; i += 1) {
    for (let j = i + 1; j < rectangles.length; j += 1) {
      if (intersects(rectangles[i], rectangles[j])) {
        overlapping.push([i, j]);
      }
    }
  }

  const labels = [...container.querySelectorAll('text.edge-label, text.edge-time')];
  const outside = labels.filter((label) => {
    const ink = inkBox(label, 5.2);
    return ink.x < 2 || ink.x + ink.w > width - 2 || ink.y < 0 || ink.y + ink.h > height;
  });
  const underBoxes = labels.filter((label) => {
    const ink = inkBox(label, 5.2);
    return rectangles.some((box) => intersects(ink, box));
  });

  return {
    width,
    height,
    boxes: rectangles.length,
    overlapping: overlapping.length,
    outside: outside.map((label) => label.textContent),
    underBoxes: underBoxes.map((label) => label.textContent),
    relationLines: [...container.querySelectorAll('text.edge-label')].map((label) => label.textContent),
  };
}

async function main() {
  const fs = require('node:fs');
  fs.writeFileSync(path.join(root, 'test/bridge.stub.js'), stub);
  const code = await bundle();

  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  dom.window.eval(code);
  const ui = dom.window.SharedUI;

  const issueAri = 'ari:cloud:jira:cloud-1:issue/1183';
  const commentAri = 'ari:cloud:jira:cloud-1:comment/9001';
  const userAri = 'ari:cloud:identity::user/acc-9';
  const pageAri = 'ari:cloud:confluence:cloud-1:page/1001';
  const teamAri = 'ari:cloud:identity::team/team-1';

  const trace = {
    graph: {
      root: issueAri,
      nodes: [
        { id: issueAri, label: 'PAY-1183', kind: 'issue', depth: 0 },
        { id: commentAri, label: 'comment 9001', kind: 'comment', depth: 1 },
        { id: userAri, label: 'J. Kim', kind: 'user', depth: 2 },
        { id: pageAri, label: 'Change Policy v3', kind: 'page', depth: 3 },
        { id: teamAri, label: 'Payments Platform', kind: 'team', depth: 4 },
      ],
      links: [
        { from: issueAri, to: commentAri, relation: 'jira_work_item_has_jira_work_item_comment', observedAt: '2026-10-14T09:00:00Z', hop: 1 },
        { from: commentAri, to: userAri, relation: 'jira_work_item_comment_authored_by_atlassian_user', observedAt: '2026-10-14T09:00:00Z', hop: 2 },
        { from: userAri, to: pageAri, relation: 'atlassian_user_owns_confluence_page', observedAt: '2026-10-15T10:00:00Z', hop: 3 },
        { from: pageAri, to: teamAri, relation: 'atlassian_team_links_space_entity', observedAt: '2026-10-15T10:00:00Z', hop: 4 },
      ],
      columns: [],
    },
    queryKey: 'qk_abc123',
    rows: 7,
    latencyMs: 38,
    retries: 1,
    mode: 'persisted',
    label: 'assureloop.evidence-chain',
  };
  trace.graph.columns = trace.graph.nodes.map((node) => [node]);

  const node = ui.renderTrace(trace);
  const svg = node.querySelector('svg');
  const curves = node.querySelectorAll('path.edge');
  const footer = node.querySelector('.trace-foot')?.textContent ?? '';
  const report = layoutReport(node);

  // The shape the policy claim actually produces on PAY-1: issue -> page, page ->
  // user, and a space -> page hop that points backwards. The space must not be
  // stacked on the page node, and its label must stay legible.
  const spaceAri = 'ari:cloud:confluence:cloud-1:space/1474567';
  const policyTrace = {
    graph: {
      root: issueAri,
      nodes: [
        { id: issueAri, label: 'PAY-1', kind: 'issue', depth: 0 },
        { id: pageAri, label: 'Change Management Policy v3', kind: 'page', depth: 1 },
        { id: spaceAri, label: 'space 1474567', kind: 'space', depth: 2 },
        { id: userAri, label: 'luke luck (yottaman)', kind: 'user', depth: 2 },
      ],
      links: [
        { from: issueAri, to: pageAri, relation: 'policy_required_by_control', observedAt: '2026-11-18T04:34:00Z', hop: 1 },
        { from: pageAri, to: userAri, relation: 'atlassian_user_owns_confluence_page', observedAt: '2026-11-18T04:34:00Z', hop: 2 },
        { from: spaceAri, to: pageAri, relation: 'confluence_space_has_confluence_page', observedAt: '2026-11-18T04:34:00Z', hop: 3 },
        { from: teamAri, to: spaceAri, relation: 'atlassian_team_links_space_entity', observedAt: '2026-11-18T04:34:00Z', hop: 4 },
      ],
      columns: [
        [{ id: issueAri, label: 'PAY-1', kind: 'issue', depth: 0 }],
        [
          { id: pageAri, label: 'Change Management Policy v3', kind: 'page', depth: 1 },
        ],
        [
          { id: spaceAri, label: 'space 1474567', kind: 'space', depth: 2 },
          { id: userAri, label: 'luke luck (yottaman)', kind: 'user', depth: 2 },
        ],
        [{ id: teamAri, label: 'Payments Platform', kind: 'team', depth: 3 }],
      ],
    },
    queryKey: 'curated (no key)',
    rows: 1,
    latencyMs: 1656,
    retries: 0,
    mode: 'curated',
    label: 'confluence:ITO:Change Management Policy + confluencePageOwners',
  };
  const policyNode = ui.renderTrace(policyTrace);
  const policyReport = layoutReport(policyNode);

  // A trace that mixes routes: one rule-derived hop, one graph hop. The diagram
  // must say which is which — a rule match drawn as a graph edge would claim the
  // customer's data contains a link it does not.
  const ruleTrace = {
    graph: {
      root: issueAri,
      nodes: [
        { id: issueAri, label: 'PAY-1', kind: 'issue', depth: 0 },
        { id: pageAri, label: 'Change Management Policy v3', kind: 'page', depth: 1 },
        { id: userAri, label: 'J. Kim', kind: 'user', depth: 2 },
      ],
      links: [
        { from: issueAri, to: pageAri, relation: 'policy_required_by_control', observedAt: '2026-11-18T04:34:00Z', hop: 1, source: 'rule' },
        { from: pageAri, to: userAri, relation: 'atlassian_user_owns_confluence_page', observedAt: '2026-11-18T04:34:00Z', hop: 2, source: 'graph' },
      ],
      columns: [],
    },
    queryKey: null,
    rows: 1,
    latencyMs: 42,
    retries: 0,
    mode: 'curated',
    label: 'confluence:ITO policy',
    notes: ['Persisted Cypher did not answer (FEATURE_UNAVAILABLE) — the verdict was reached without it.'],
  };
  const ruleNode = ui.renderTrace(ruleTrace);
  const ruleReport = layoutReport(ruleNode);

  const environment = {
    checkedAt: '2026-11-18T02:00:00Z',
    durationMs: 812,
    budgetMs: 5000,
    summary: { green: 3, yellow: 2, red: 1 },
    probes: [
      { id: 'connection', label: 'Connection (echo)', state: 'GREEN', detail: 'ok', scopes: [], remedy: 'No action needed.', latencyMs: 12 },
      { id: 'issue', label: 'Work item scope', state: 'YELLOW', detail: 'empty', scopes: ['read:graph:issue:jira'], remedy: 'Approve it.', latencyMs: 40 },
      { id: 'policy', label: 'Page / space scope', state: 'RED', detail: 'denied', scopes: ['read:graph:page:confluence'], remedy: 'Approve it.', latencyMs: 44 },
    ],
    fixtures: { issueKey: 'PAY-1183', pageAri: null, spaceAri: null, userAri },
  };
  const env = ui.renderEnvironment(environment);
  const dots = [...env.querySelectorAll('.dot')].map((dot) => dot.className);

  const joinedRelations = report.relationLines.join('_');

  // M5: when the persisted traversal ran beside the curated read, the footer reports it
  // as a second read with its own rows and latency. It used to print the larger of the
  // two row counts and the sum of both latencies under one `via curated` label.
  const withPersisted = ui.renderTrace({
    ...trace,
    mode: 'curated',
    rows: 1,
    latencyMs: 2480,
    persisted: { used: true, rows: 5, latencyMs: 813, queryKey: 'qk_persisted' },
  });
  const persistedFooter = withPersisted.querySelector('.trace-foot')?.textContent ?? '';
  const curatedOnly = ui.renderTrace({
    ...trace,
    mode: 'curated',
    rows: 1,
    latencyMs: 2480,
    persisted: { used: false, rows: 0, latencyMs: 0, queryKey: null },
  });
  const curatedFooter = curatedOnly.querySelector('.trace-foot')?.textContent ?? '';

  const cases = [
    ['the trace renders an svg', Boolean(svg), true],
    ['the footer reports the curated read on its own', persistedFooter.includes('rows 1'), true],
    ['the footer does not add the persisted latency to the curated one', persistedFooter.includes('2480 ms'), true],
    ['the persisted traversal is reported beside it', persistedFooter.includes('persisted 5 row'), true],
    ['a persisted read that did not run is not reported', curatedFooter.includes('persisted'), false],
    ['one box per hop node', report.boxes, 5],
    ['one curve per relationship', curves.length, 4],
    ['the footer shows the query key', footer.includes('qk_abc123'), true],
    ['the footer shows rows', footer.includes('rows 7'), true],
    ['the footer shows latency', footer.includes('38 ms'), true],
    ['the footer shows retries when they happened', footer.includes('retries 1'), true],
    ['the board is wide enough for five columns', report.width > 900, true],
    ['no two node boxes overlap', report.overlapping, 0],
    ['no relationship label runs outside the drawing', report.outside.length, 0],
    ['no relationship label is painted under a node box', report.underBoxes.length, 0],
    ['a long relationship name is wrapped, not clipped', joinedRelations.includes('jira_work_item_comment_authored_by_atlassian_user'), true],
    ['a backwards hop gets its own column', policyReport.overlapping, 0],
    ['the backwards hop label stays legible', policyReport.underBoxes.length, 0],
    ['the policy trace does not shrink to one column', policyReport.width > 700, true],
    ['the environment panel renders one dot per probe', dots.length, 3],
    ['the panel colours a red probe red', dots.some((dot) => dot.includes('RED')), true],
    ['the panel names the scope to approve', env.textContent.includes('read:graph:page:confluence'), true],
    ['a rule hop is drawn dashed', Boolean(ruleNode.querySelector('path.edge.rule')), true],
    ['a rule hop is labelled as derived here', ruleNode.textContent.includes('rule: policy'), true],
    ['the graph hop is not labelled as a rule', ruleNode.textContent.includes('rule: atlassian_user_owns'), false],
    ['the legend explains the four routes', ruleNode.textContent.includes('rule (derived here)'), true],
    ['the legend names the graph route', ruleNode.textContent.includes('graph edge'), true],
    ['a read note is shown under the trace', ruleNode.textContent.includes('Persisted Cypher did not answer'), true],
    ['a rule hop trace still has no overlapping boxes', ruleReport.overlapping, 0],
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
  console.log(`  (trace ${report.width}x${report.height}, ${report.boxes} boxes, ${curves.length} curves)`);
  console.log(`  (policy trace ${policyReport.width}x${policyReport.height}, overlapping ${policyReport.overlapping}, under boxes ${policyReport.underBoxes.length})`);
  console.log(`\n${cases.length - failures}/${cases.length} assertions passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('render harness failed:', error);
  process.exit(1);
});
