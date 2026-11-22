/**
 * Provenance trace -> node/link graph.
 *
 * The UI draws this as an SVG diagram (E2): the answer must show how it walked
 * the Teamwork Graph, not merely claim that it did. The hops come from the
 * verdict engine as stored provenance rows; this module only turns them into
 * something drawable, keeping every ARI, relationship name and observation time
 * intact so the picture cannot say more than the data does.
 */

import type { HopSource, ProvenanceHop } from '../twg/queries';

export type TraceNodeKind =
  | 'issue'
  | 'comment'
  | 'page'
  | 'space'
  | 'user'
  | 'team'
  | 'label'
  | 'unknown';

export interface TraceNode {
  id: string;
  label: string;
  kind: TraceNodeKind;
  /** Hop depth from the root, used to lay the diagram out in columns. */
  depth: number;
}

export interface TraceLink {
  from: string;
  to: string;
  relation: string;
  observedAt: string;
  hop: number;
  /**
   * Which route produced this hop. The diagram draws a rule-derived relationship
   * dashed and prefixes it with `rule:`, so the picture never dresses a match this
   * app made up as an edge the graph returned.
   */
  source: HopSource;
}

export interface TraceGraph {
  root: string | null;
  nodes: TraceNode[];
  links: TraceLink[];
  /** Nodes grouped by depth: columns[root][…]. */
  columns: TraceNode[][];
}

/** ARI -> node kind. The object type is in the ARI, so nothing is guessed. */
export function classifyAri(ari: string | null | undefined): TraceNodeKind {
  if (!ari) {
    return 'unknown';
  }
  if (/:issue\//.test(ari)) {
    return 'issue';
  }
  if (/:comment\//.test(ari)) {
    return 'comment';
  }
  if (/:page\//.test(ari)) {
    return 'page';
  }
  if (/:space\//.test(ari)) {
    return 'space';
  }
  if (/identity::user\//.test(ari)) {
    return 'user';
  }
  if (/:team\//.test(ari) || /:team\b/.test(ari)) {
    return 'team';
  }
  if (!ari.includes('ari:')) {
    return 'label';
  }
  return 'unknown';
}

const KIND_PREFIX: Readonly<Record<TraceNodeKind, string>> = {
  issue: 'issue',
  comment: 'comment',
  page: 'page',
  space: 'space',
  user: 'user',
  team: 'team',
  label: '',
  unknown: 'object',
};

/** Last path segment of an ARI, which is the most specific identifier it has. */
function tailOf(ari: string): string {
  const withoutQuery = ari.split('?')[0] ?? ari;
  const segments = withoutQuery.split('/');
  return segments[segments.length - 1] ?? withoutQuery;
}

export function shortLabel(ari: string, kind: TraceNodeKind, names?: Record<string, string>): string {
  const named = names?.[ari];
  if (named) {
    return named;
  }
  if (kind === 'label') {
    return ari;
  }
  const tail = tailOf(ari);
  const prefix = KIND_PREFIX[kind];
  return prefix ? `${prefix} ${tail}` : tail;
}

/**
 * Build the diagram.
 *
 * @param root the subject of the verdict (usually the work item), or null when
 *   the chain starts at its first hop.
 * @param hops persisted provenance hops, already ordered by hop number.
 * @param names optional ARI -> display name, so a user node shows a person's
 *   name rather than an opaque account id.
 */
export function buildTrace(
  root: { ari: string; label?: string; kind?: TraceNodeKind } | null,
  hops: readonly ProvenanceHop[],
  names?: Record<string, string>,
): TraceGraph {
  const nodes = new Map<string, TraceNode>();
  const links: TraceLink[] = [];

  const ensure = (ari: string, depth: number, explicitLabel?: string): TraceNode => {
    const kind = classifyAri(ari);
    const existing = nodes.get(ari);
    if (existing) {
      if (depth < existing.depth) {
        existing.depth = depth;
      }
      return existing;
    }
    const node: TraceNode = {
      id: ari,
      kind,
      label: explicitLabel ?? shortLabel(ari, kind, names),
      depth,
    };
    nodes.set(ari, node);
    return node;
  };

  let rootId: string | null = null;
  if (root) {
    const node = ensure(root.ari, 0, root.label);
    if (root.kind) {
      node.kind = root.kind;
    }
    rootId = node.id;
  }

  for (const hop of hops) {
    if (!hop.fromAri && !hop.toAri) {
      continue;
    }
    if (hop.fromAri) {
      ensure(hop.fromAri, rootId ? 1 : 0);
    }
    if (hop.toAri) {
      ensure(hop.toAri, rootId ? 2 : 1);
    }
    links.push({
      from: hop.fromAri ?? '',
      to: hop.toAri ?? '',
      relation: hop.relation,
      observedAt: hop.observedAt,
      hop: hop.hop,
      // Older stored hops carry no source; they were graph or REST reads, which the
      // diagram draws the same way. Defaulting to 'graph' keeps that honest.
      source: hop.source ?? 'graph',
    });
  }

  layerNodes(nodes, links, rootId);

  const ordered = [...nodes.values()].sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label));
  const columns: TraceNode[][] = [];
  for (const node of ordered) {
    const column = columns[node.depth] ?? [];
    column.push(node);
    columns[node.depth] = column;
  }

  return { root: rootId, nodes: ordered, links, columns };
}

/**
 * Put every node in a column of its own depth.
 *
 * Depth is the number of edges from the subject, walked in either direction. The
 * earlier rule ("every hop's from-node sits at depth 1") collapsed unrelated
 * hops into one column: a space -> page hop meant the space node and the page
 * node stood side by side in the same column, and the curve between them was
 * drawn back over both boxes. Walking the links fixes that for any hop order the
 * engine produces, and a genuinely backward edge still ends up in a column of
 * its own for the renderer to route.
 */
function layerNodes(
  nodes: Map<string, TraceNode>,
  links: readonly TraceLink[],
  rootId: string | null,
): void {
  const adjacency = new Map<string, string[]>();
  const connect = (from: string, to: string): void => {
    if (!from || !to) {
      return;
    }
    const list = adjacency.get(from) ?? [];
    if (!list.includes(to)) {
      list.push(to);
    }
    adjacency.set(from, list);
  };
  for (const link of links) {
    connect(link.from, link.to);
    connect(link.to, link.from);
  }

  const depth = new Map<string, number>();
  const walk = (start: string, startDepth: number): void => {
    depth.set(start, startDepth);
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const currentDepth = depth.get(current) ?? 0;
      for (const neighbour of adjacency.get(current) ?? []) {
        if (depth.has(neighbour)) {
          continue;
        }
        depth.set(neighbour, currentDepth + 1);
        queue.push(neighbour);
      }
    }
  };

  if (rootId && nodes.has(rootId)) {
    walk(rootId, 0);
  }
  // A component that does not reach the root (a hop naming neither end of the
  // chain) still deserves a column instead of being dropped.
  for (const id of nodes.keys()) {
    if (depth.has(id)) {
      continue;
    }
    const next = depth.size === 0 ? 0 : Math.max(...depth.values()) + 1;
    walk(id, next);
  }

  for (const node of nodes.values()) {
    node.depth = depth.get(node.id) ?? 0;
  }
}
