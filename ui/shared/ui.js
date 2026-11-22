/**
 * Shared UI helpers: bridge calls, DOM construction, formatting and the
 * provenance trace diagram (E2).
 *
 * No framework on purpose. The three surfaces are small, and a bundled React app
 * would cost more review time than it saves at this stage; what matters is that
 * the trace is drawn from real hop data and that every state name on screen is
 * the engine's, not the renderer's.
 */

import { invoke as bridgeInvoke, view } from '@forge/bridge';

export function invoke(name, payload = {}) {
  return bridgeInvoke(name, payload);
}

/** Failures that mean "the container was not there", not "the app said no". */
const TRANSPORT_FAILURES = /failed to fetch|network|timeout|timed out|econn|not available|bad gateway|service unavailable|\b50[234]\b/i;

/**
 * An invoke that survives a cold container.
 *
 * A Forge function that has been idle scales down; the first invoke after that can
 * come back as a transport failure with no resolver behind it (measured on this
 * site: `Verify fingerprint` returned "Failed to fetch" twice while the page was
 * open, then worked). Retrying once after a short wait is the difference between a
 * broken button and a second of waiting. Only transport failures are retried: an
 * answer from the resolver — "Unknown control code", a permission error — is the
 * app's verdict and is passed straight back.
 */
export async function invokeWarm(name, payload = {}, options = {}) {
  const attempts = options.attempts ?? 2;
  const delayMs = options.delayMs ?? 900;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await bridgeInvoke(name, payload);
    } catch (cause) {
      lastError = cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (attempt === attempts - 1 || !TRANSPORT_FAILURES.test(message)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Module context as Forge gives it to Custom UI. */
export function getContext() {
  return view.getContext();
}

/** issueKey for an issue panel: the extension is on a Jira issue. */
export function issueKeyFromContext(context) {
  const extension = context?.extension ?? {};
  if (typeof extension.issue?.key === 'string') {
    return extension.issue.key;
  }
  if (typeof extension.issueKey === 'string') {
    return extension.issueKey;
  }
  // Fall back to the URL, which is what a right-hand panel always has.
  const match = /\/browse\/([A-Z][A-Z0-9_]*-\d+)/.exec(context?.location ?? '');
  return match ? match[1] : null;
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === 'class') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = value;
    } else if (key === 'html') {
      node.innerHTML = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (key === 'text') {
      node.textContent = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  return node;
}

const STATE_LABEL = {
  VERIFIED: 'verified',
  STALE: 'stale',
  MISSING: 'missing',
  NOT_VISIBLE: 'not visible',
  INCOMPLETE: 'not checked',
  UNKNOWN: 'unknown',
};

export function stateLabel(state) {
  return STATE_LABEL[state] ?? String(state ?? 'unknown').toLowerCase();
}

export function chip(state) {
  return el('span', { class: `chip ${state}`, text: stateLabel(state) });
}

export function badge(state, label) {
  const klass =
    state === 'PASS'
      ? 'pass'
      : state === 'GAPS'
        ? 'gaps'
        : state === 'UNVERIFIABLE'
          ? 'unverifiable'
          : state === 'PARTIAL'
            ? 'partial'
            : 'neutral';
  return el('span', { class: `badge ${klass}`, text: label });
}

export function formatWhen(iso) {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const diff = Date.now() - date.getTime();
  const days = Math.floor(diff / 86400000);
  const stamp = date.toISOString().slice(0, 16).replace('T', ' ');
  if (days <= 0) {
    return `${stamp} (today)`;
  }
  if (days < 30) {
    return `${stamp} (${days}d ago)`;
  }
  return `${stamp} (${Math.floor(days / 30)}mo ago)`;
}

export function ageLabel(days) {
  if (days === null || days === undefined) {
    return '—';
  }
  return days === 0 ? 'today' : `${days} days old`;
}

/** A short, readable tail for an ARI, used in dense places. */
export function shortAri(ari) {
  if (!ari) {
    return '—';
  }
  const tail = String(ari).split('/').pop();
  return tail && tail.length > 28 ? `${tail.slice(0, 27)}…` : tail;
}

// ---------------------------------------------------------------------------
// E2 — the provenance trace
// ---------------------------------------------------------------------------

const NODE_W = 170;
const NODE_H = 54;
const ROW_GAP = 26;
const PAD = 16;
const MIN_COL_GAP = 86;
const LABEL_CHAR_W = 5.2;
const LABEL_LINE_H = 10;
const PLATE_PAD = 5;
const BUS_GAP = 46;

let traceSequence = 0;

/** Rough width of a line at the trace's small type size. */
function textWidth(text) {
  return String(text ?? '').length * LABEL_CHAR_W;
}

/**
 * Break a relationship name into two lines at an underscore.
 *
 * `jira_work_item_comment_authored_by_atlassian_user` is 48 characters: on one
 * line it is 235px wide, which is wider than the space between two columns, so it
 * used to run under the node boxes and read as truncated. Splitting it at the
 * underscore that balances the two halves keeps the whole name on screen.
 */
function wrapRelation(relation) {
  const text = String(relation ?? '');
  if (text.length <= 26) {
    return [text];
  }
  let best = null;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '_') {
      continue;
    }
    const head = text.slice(0, index);
    const tail = text.slice(index + 1);
    if (head.length < 6 || tail.length < 6) {
      continue;
    }
    const score = Math.max(head.length, tail.length);
    if (!best || score < best.score) {
      best = { score, head, tail };
    }
  }
  if (best) {
    return [best.head, best.tail];
  }
  const middle = Math.ceil(text.length / 2);
  return [text.slice(0, middle), text.slice(middle)];
}

/** Columns from the server, or rebuilt from node depth when they are missing. */
function traceColumns(graph) {
  const given = (Array.isArray(graph.columns) ? graph.columns : []).filter(
    (column) => Array.isArray(column) && column.length > 0,
  );
  if (given.length > 0) {
    return given;
  }
  const byDepth = new Map();
  for (const node of graph.nodes) {
    const depth = typeof node.depth === 'number' ? node.depth : 0;
    const list = byDepth.get(depth) ?? [];
    list.push(node);
    byDepth.set(depth, list);
  }
  return [...byDepth.keys()].sort((a, b) => a - b).map((depth) => byDepth.get(depth));
}

function truncateToWidth(text, width, charWidth) {
  const value = String(text ?? '');
  const max = Math.max(4, Math.floor(width / charWidth));
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Which route produced a hop; older stored hops default to a graph read. */
function sourceOf(link) {
  const source = link?.source;
  return source === 'persisted' || source === 'rest' || source === 'rule' || source === 'graph'
    ? source
    : 'graph';
}

/** How the hop is named in the diagram: a rule is marked, because it was derived here. */
function relationLabel(link) {
  const relation = String(link?.relation ?? '');
  return sourceOf(link) === 'rule' ? `rule: ${relation}` : relation;
}

const SOURCE_LEGEND = [
  { source: 'graph', label: 'graph edge' },
  { source: 'persisted', label: 'persisted Cypher' },
  { source: 'rest', label: 'REST read' },
  { source: 'rule', label: 'rule (derived here)' },
];

/**
 * The legend under the diagram. Four routes can produce a hop, and an auditor has
 * to be able to tell an edge the Teamwork Graph returned from a relationship this
 * app matched by a label or a title. Only the first is evidence of a link in the
 * customer's data.
 */
function traceLegend(graph) {
  const present = new Set((graph.links ?? []).map((link) => sourceOf(link)));
  const items = SOURCE_LEGEND.filter((entry) => present.has(entry.source)).map((entry) =>
    el('span', { class: 'legend-item' }, [
      el('span', { class: `legend-swatch ${entry.source}` }),
      el('span', { text: entry.label }),
    ]),
  );
  if (items.length === 0) {
    return null;
  }
  return el('div', { class: 'trace-legend' }, items);
}

/**
 * Draw the node-link diagram.
 *
 * One column per hop depth, and the depth comes from walking the hops from the
 * subject in either direction, so a backward hop (space -> page) gets a column of
 * its own instead of landing on top of its neighbour. Relationship names are
 * wrapped to the width of the gap between columns and given a plate of their own,
 * and an edge that points back to an earlier column is routed along a lane under
 * the diagram: no label ends up half-hidden behind a box.
 */
export function renderTrace(trace) {
  const container = el('div', { class: 'trace' });
  const graph = trace?.graph;
  const empty = () => {
    container.append(el('p', { class: 'muted', text: 'No hops were recorded for this claim.' }));
    return container;
  };
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return empty();
  }

  const columns = traceColumns(graph);
  if (columns.length === 0) {
    return empty();
  }

  const labels = new Map();
  for (const link of graph.links ?? []) {
    labels.set(link, wrapRelation(relationLabel(link)));
  }
  const widestLine = Math.max(
    0,
    ...[...labels.values()].flatMap((lines) => lines.map((line) => textWidth(line))),
  );
  const colGap = Math.max(MIN_COL_GAP, widestLine + 30);

  const width = PAD * 2 + columns.length * NODE_W + Math.max(0, columns.length - 1) * colGap;

  const blockHeightFor = (lines) => lines.length * LABEL_LINE_H + LABEL_LINE_H + PLATE_PAD * 2;

  /**
   * Lay the diagram out in an area of `areaHeight`. Node columns are centred in
   * it; each label is placed at its curve's midpoint and pushed down only when it
   * would land on the label above it. Returns the height the labels need, so the
   * caller can grow the drawing instead of clipping a label at the bottom.
   */
  const layout = (areaHeight) => {
    const position = new Map();
    columns.forEach((column, columnIndex) => {
      const columnHeight = column.length * NODE_H + (column.length - 1) * ROW_GAP;
      const startY = (areaHeight - columnHeight) / 2;
      column.forEach((node, rowIndex) => {
        position.set(node.id, {
          x: PAD + columnIndex * (NODE_W + colGap),
          y: startY + rowIndex * (NODE_H + ROW_GAP),
          column: columnIndex,
        });
      });
    });

    const forward = [];
    const backward = [];
    for (const link of graph.links ?? []) {
      const from = position.get(link.from);
      const to = position.get(link.to);
      if (!from || !to) {
        continue;
      }
      (to.column > from.column ? forward : backward).push({ link, from, to });
    }

    const placements = [];
    const floorOf = new Map();
    const ordered = [...forward].sort(
      (a, b) => (a.from.y + a.to.y) / 2 - (b.from.y + b.to.y) / 2,
    );
    for (const edge of ordered) {
      const x1 = edge.from.x + NODE_W;
      const y1 = edge.from.y + NODE_H / 2;
      const x2 = edge.to.x;
      const y2 = edge.to.y + NODE_H / 2;
      const lines = labels.get(edge.link) ?? [String(edge.link.relation ?? '')];
      const blockHeight = blockHeightFor(lines);
      const key = edge.from.column;
      let top = (y1 + y2) / 2 - blockHeight / 2;
      const floor = (floorOf.get(key) ?? PAD - PLATE_PAD) + 4;
      if (top < floor) {
        top = floor;
      }
      floorOf.set(key, top + blockHeight);
      placements.push({ kind: 'forward', edge, top, blockHeight, lines, x1, y1, x2, y2 });
    }

    const labelBottom = Math.max(
      PAD,
      ...placements.map((placement) => placement.top + placement.blockHeight),
    );
    return { position, forward, backward, placements, required: labelBottom + PAD };
  };

  const stackHeight = PAD * 2 + Math.max(...columns.map((column) => column.length)) * NODE_H
    + Math.max(0, Math.max(...columns.map((column) => column.length)) - 1) * ROW_GAP;

  let areaHeight = stackHeight;
  let placed = layout(areaHeight);
  for (let pass = 0; pass < 4 && placed.required > areaHeight + 0.5; pass += 1) {
    areaHeight = placed.required;
    placed = layout(areaHeight);
  }

  const busHeight = placed.backward.length > 0 ? 12 + placed.backward.length * BUS_GAP : 0;
  const height = areaHeight + busHeight;

  const svg = svgEl('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': 'Provenance trace',
  });

  traceSequence += 1;
  const markerId = `trace-arrow-${traceSequence}`;
  const defs = svgEl('defs');
  const marker = svgEl('marker', {
    id: markerId,
    viewBox: '0 0 8 8',
    refX: 7,
    refY: 4,
    markerWidth: 6,
    markerHeight: 6,
    orient: 'auto',
  });
  marker.append(svgEl('path', { class: 'edge-arrow', d: 'M 0 0 L 8 4 L 0 8 Z' }));
  defs.append(marker);
  svg.append(defs);

  const stampOf = (link) => String(link.observedAt ?? '').slice(0, 16).replace('T', ' ');

  const labelBlock = (centerX, top, lines, time) => {
    const boxWidth = Math.max(...lines.map((line) => textWidth(line)), textWidth(time)) + 12;
    const boxX = Math.min(Math.max(centerX - boxWidth / 2, 2), width - boxWidth - 2);
    const blockHeight = blockHeightFor(lines);
    svg.append(
      svgEl('rect', {
        class: 'edge-plate',
        x: boxX,
        y: top,
        width: boxWidth,
        height: blockHeight,
        rx: 3,
      }),
    );
    lines.forEach((line, index) => {
      const text = svgEl('text', {
        class: 'edge-label',
        x: boxX + boxWidth / 2,
        y: top + PLATE_PAD + LABEL_LINE_H * (index + 1) - 3,
        'text-anchor': 'middle',
      });
      text.textContent = line;
      svg.append(text);
    });
    const stamp = svgEl('text', {
      class: 'edge-time',
      x: boxX + boxWidth / 2,
      y: top + blockHeight - PLATE_PAD - 1,
      'text-anchor': 'middle',
    });
    stamp.textContent = time;
    svg.append(stamp);
  };

  // Forward edges: a curve across the gap, its label on a plate in that gap.
  for (const placement of placed.placements) {
    const { edge, top, lines, x1, y1, x2, y2 } = placement;
    const midX = (x1 + x2) / 2;
    svg.append(
      svgEl('path', {
        class: `edge ${sourceOf(edge.link)}`,
        d: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
        'marker-end': `url(#${markerId})`,
      }),
    );
    labelBlock(midX, top, lines, stampOf(edge.link));
  }

  // Backward edges: out of the bottom of the source, along a lane under every
  // column, and up into the bottom of the target. Nothing crosses a node box.
  placed.backward.forEach((edge, index) => {
    const laneY = areaHeight + 10 + index * BUS_GAP;
    const x1 = edge.from.x + NODE_W / 2;
    const y1 = edge.from.y + NODE_H;
    const x2 = edge.to.x + NODE_W / 2;
    const y2 = edge.to.y + NODE_H;
    svg.append(
      svgEl('path', {
        class: `edge back ${sourceOf(edge.link)}`,
        d: `M ${x1} ${y1} L ${x1} ${laneY} L ${x2} ${laneY} L ${x2} ${y2}`,
        'marker-end': `url(#${markerId})`,
      }),
    );
    const lines = labels.get(edge.link) ?? [String(edge.link.relation ?? '')];
    labelBlock((x1 + x2) / 2, laneY + 5, lines, stampOf(edge.link));
  });

  for (const node of graph.nodes) {
    const spot = placed.position.get(node.id);
    if (!spot) {
      continue;
    }
    const group = svgEl('g', {});
    group.append(
      svgEl('rect', {
        class: `node-box${node.depth === 0 ? ' root' : ''}`,
        x: spot.x,
        y: spot.y,
        width: NODE_W,
        height: NODE_H,
        rx: 6,
      }),
    );
    const kind = svgEl('text', { class: 'node-kind', x: spot.x + 9, y: spot.y + 16 });
    kind.textContent = node.kind;
    group.append(kind);

    const label = svgEl('text', { class: 'node-label', x: spot.x + 9, y: spot.y + 32 });
    label.textContent = truncateToWidth(node.label, NODE_W - 18, 6.3);
    group.append(label);

    const ari = svgEl('text', { class: 'node-kind', x: spot.x + 9, y: spot.y + 46 });
    ari.textContent = truncateToWidth(shortAri(node.id), NODE_W - 18, 4.9);
    group.append(ari);

    const title = svgEl('title');
    title.textContent = `${node.kind}: ${node.label}\n${node.id}`;
    group.append(title);
    svg.append(group);
  }

  container.append(svg);
  const legend = traceLegend(graph);
  if (legend) {
    container.append(legend);
  }

  const persistedUsed = trace.persisted && trace.persisted.used === true;
  const foot = el('div', { class: 'trace-foot' }, [
    el('span', { text: `queryKey ${trace.queryKey ?? 'curated (no key)'}` }),
    el('span', { text: `rows ${trace.rows ?? 0}` }),
    el('span', { text: `${trace.latencyMs ?? 0} ms` }),
    trace.retries ? el('span', { text: `retries ${trace.retries}` }) : null,
    el('span', { text: `via ${trace.mode ?? 'unknown'}` }),
    // A second read is a second number. The footer used to print the larger row count
    // and the sum of both latencies under one label; when the persisted traversal ran,
    // it now says so on its own.
    persistedUsed
      ? el('span', {
          text: `+ persisted ${trace.persisted.rows} row(s) / ${trace.persisted.latencyMs} ms`,
        })
      : null,
    el('span', { text: trace.label ?? '' }),
  ]);
  container.append(foot);
  if (Array.isArray(trace.notes) && trace.notes.length > 0) {
    container.append(
      el(
        'div',
        { class: 'trace-notes' },
        trace.notes.map((note) => el('div', { class: 'tiny muted', text: note })),
      ),
    );
  }
  return container;
}


// ---------------------------------------------------------------------------
// E5 — the environment check panel
// ---------------------------------------------------------------------------

export function renderEnvironment(report, options = {}) {
  const container = el('div', { class: 'card stack' });
  const summary = report?.summary ?? { green: 0, yellow: 0, red: 0 };
  container.append(
    el('div', { class: 'spread' }, [
      el('h2', { text: 'Environment check' }),
      el('span', {
        class: 'tiny muted',
        text: report
          ? `${summary.green} green · ${summary.yellow} yellow · ${summary.red} red · ${report.durationMs} ms`
          : '',
      }),
    ]),
  );
  if (!report) {
    container.append(
      el('p', { class: 'muted', text: 'Not run yet. The check reads six things the app depends on.' }),
    );
    return container;
  }
  for (const probe of report.probes) {
    const row = el('div', { class: 'probe' }, [
      el('span', { class: `dot ${probe.state}` }),
      el('div', { class: 'stack', style: 'gap:2px' }, [
        el('strong', { text: probe.label }),
        el('span', { class: 'muted', text: probe.detail }),
        probe.state === 'GREEN'
          ? null
          : el('span', { class: 'tiny', text: probe.remedy }),
        probe.scopes && probe.scopes.length > 0
          ? el('span', { class: 'tiny mono', text: probe.scopes.join('  ') })
          : null,
      ]),
    ]);
    container.append(row);
  }
  if (options.onRerun) {
    container.append(
      el('div', { class: 'row' }, [
        el('button', { class: 'secondary', text: 'Run again', onclick: options.onRerun }),
      ]),
    );
  }
  return container;
}

export function clear(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

// ---------------------------------------------------------------------------
// Clipboard — the audit memo is meant to be pasted into a ticket or a mail
// ---------------------------------------------------------------------------

/** Copy text without a library; falls back to a hidden textarea. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied (an iframe without clipboard-write): try the old way.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    area.remove();
    return Boolean(copied);
  } catch {
    return false;
  }
}

/**
 * A copy button that names what it copied.
 *
 * `getText` is async on purpose: the memo is produced by the resolver from the
 * engine's rows, so the button copies exactly what the screen shows.
 */
export function copyButton(label, getText) {
  const status = el('span', { class: 'copied' });
  const button = el('button', {
    class: 'secondary tiny',
    text: label,
    onclick: async () => {
      button.disabled = true;
      try {
        const text = await getText();
        const copied = await copyText(text);
        status.textContent = copied
          ? `Copied ${text.split('\n').filter((line) => line.trim().length > 0).length} line(s) to the clipboard.`
          : 'Copy failed — the memo is shown below instead.';
        if (!copied) {
          const area = el('textarea', { class: 'memo-fallback', readonly: true, rows: 12 });
          area.value = text;
          status.after(area);
          area.select();
        }
      } catch (cause) {
        status.textContent = cause instanceof Error ? cause.message : String(cause);
      } finally {
        button.disabled = false;
      }
    },
  });
  return el('span', { class: 'row' }, [button, status]);
}

/** The five states, explained once. Collapsed by default so the panel stays short. */
export function stateLegend() {
  return el('details', { class: 'legend' }, [
    el('summary', { class: 'tiny muted', text: 'What the five states mean' }),
    el('div', { class: 'stack', style: 'gap:4px' }, [
      el('div', { class: 'tiny' }, [el('span', { class: 'chip VERIFIED', text: 'verified' }), ' evidence exists, is fresh, and its owner is active.']),
      el('div', { class: 'tiny' }, [el('span', { class: 'chip STALE', text: 'stale' }), ' evidence exists but is older than the claim allows, or its owner is deactivated.']),
      el('div', { class: 'tiny' }, [el('span', { class: 'chip MISSING', text: 'missing' }), ' the app looked and it really is not there.']),
      el('div', { class: 'tiny' }, [el('span', { class: 'chip NOT_VISIBLE', text: 'not visible' }), ' a permission prevented the read — not the same as absent.']),
      el('div', { class: 'tiny' }, [el('span', { class: 'chip INCOMPLETE', text: 'not checked' }), ' a throttle, timeout, index lag or setup gap stopped the check.']),
    ]),
  ]);
}
