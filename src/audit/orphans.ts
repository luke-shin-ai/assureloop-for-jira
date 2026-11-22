/**
 * Reverse scan: evidence the programme never asserts.
 *
 * The forward direction is "for each control, find its evidence". This is the
 * other direction — "which governance pages exist that no control claims?" — and it
 * is the point a spreadsheet cannot make: a policy page nobody cites is either an
 * uncatalogued obligation or a dead document, and both are findings.
 *
 * It used to be a documented idea with no caller (`orphanEvidence` was a string
 * constant in a query draft). This is the working unit: list the pages of the
 * spaces the programme runs in, subtract every page a control names in its rules or
 * carries as a registered evidence link, and report the remainder.
 *
 * What it is not: a graph traversal. The declared plumbing is Confluence REST plus
 * the registry, which is why the result says `mode: 'rest+registry'` on screen. A
 * persisted Cypher version can replace the read later without changing the shape of
 * the answer.
 */

import { listSpacePages, type ConfluencePageSummary } from '../confluence/rest';

export interface ClaimedPage {
  /** Page title a rule names (a prefix is enough), or null. */
  title: string | null;
  /** ARI of a registered evidence link, or null. */
  ari: string | null;
}

export interface OrphanPage {
  pageId: string;
  title: string;
  spaceKey: string;
  lastUpdatedAt: string;
  webPath: string | null;
}

export interface OrphanScan {
  mode: 'rest+registry';
  spaces: string[];
  pagesSeen: number;
  claimed: number;
  orphans: OrphanPage[];
  truncated: boolean;
  /** When the reverse scan ran. */
  scannedAt: string;
  notes: string[];
  error?: string;
}

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

/** True when some control names this page (by rule title or by a registered link). */
export function pageIsClaimed(page: { title: string; id: string }, claimed: readonly ClaimedPage[]): boolean {
  const title = normalise(page.title);
  for (const entry of claimed) {
    if (entry.title && title.startsWith(normalise(entry.title))) {
      return true;
    }
    if (entry.ari && entry.ari.endsWith(`:page/${page.id}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Run the reverse scan over the given spaces.
 *
 * A space that cannot be read is reported as an error, not as \"no orphans there\":
 * an empty answer and an unread space are exactly the two things this app refuses
 * to confuse, in either direction.
 */
export async function findOrphanEvidence(options: {
  spaces: readonly string[];
  claimed: readonly ClaimedPage[];
  asAccountId?: string | null;
  now?: Date;
}): Promise<OrphanScan> {
  const spaces = [...new Set(options.spaces.filter((space) => typeof space === 'string' && space.trim().length > 0))];
  const scan: OrphanScan = {
    mode: 'rest+registry',
    spaces,
    pagesSeen: 0,
    claimed: 0,
    orphans: [],
    truncated: false,
    scannedAt: (options.now ?? new Date()).toISOString(),
    notes: [],
  };
  if (spaces.length === 0) {
    scan.notes.push('No space is bound to the programme, so there was nothing to search backwards through.');
    return scan;
  }
  const errors: string[] = [];
  for (const spaceKey of spaces) {
    const listed = await listSpacePages(spaceKey, { asAccountId: options.asAccountId ?? null });
    if (listed.error) {
      errors.push(`${spaceKey}: ${listed.error.message}`);
      continue;
    }
    if (listed.truncated) {
      scan.truncated = true;
      scan.notes.push(`Only the first ${listed.pages.length} page(s) of ${spaceKey} were read; more exist and were not judged.`);
    }
    for (const page of listed.pages) {
      scan.pagesSeen += 1;
      if (pageIsClaimed({ title: page.title, id: page.id }, options.claimed)) {
        scan.claimed += 1;
        continue;
      }
      scan.orphans.push(toOrphan(page, spaceKey));
    }
  }
  if (errors.length > 0) {
    scan.error = errors.join('; ');
  }
  scan.orphans.sort((a, b) => a.title.localeCompare(b.title));
  return scan;
}

function toOrphan(page: ConfluencePageSummary, spaceKey: string): OrphanPage {
  return {
    pageId: page.id,
    title: page.title,
    spaceKey,
    lastUpdatedAt: page.lastUpdatedAt,
    webPath: page.webPath,
  };
}
