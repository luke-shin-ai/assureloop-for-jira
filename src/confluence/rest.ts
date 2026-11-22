/**
 * Confluence REST: page freshness, title and space are exact here, so they are
 * read from REST. Ownership is not — that hop is the Teamwork Graph's job, which
 * is why a page can be current on REST and still be NOT_VISIBLE on ownership.
 */

import api, { route } from '@forge/api';
import { noteRestCall } from '../g0/counters';

export interface ConfluencePageSummary {
  id: string;
  title: string;
  lastUpdatedAt: string;
  version: number | null;
  spaceId: string | null;
  /** Relative web path from the API's _links.webui, for an evidence link. */
  webPath: string | null;
}

export interface ConfluenceReadError {
  status: number;
  message: string;
}

/**
 * Whose eyes a read uses.
 *
 * `asApp()` is the default: the app's own identity sees exactly the content the
 * installation was granted. Confluence withholds that content entirely — every
 * spaces/pages listing comes back `200` with an empty list, never a 403 — when the
 * app is not running inside Atlassian (an app with egress, or one whose major
 * version the site has not re-approved). Before treating an empty answer as "the
 * page does not exist", the reader retries as this account, which is the person
 * looking at the gate or the configured scan principal.
 */
export interface ConfluenceReadOptions {
  asAccountId?: string | null;
}

function confluenceClient(asAccountId?: string | null) {
  return asAccountId ? api.asUser(asAccountId) : api.asApp();
}

export type ConfluencePageResult =
  | { page: ConfluencePageSummary; error?: undefined; absent?: false }
  | {
      page: null;
      error: ConfluenceReadError;
      /**
       * True when the read settled the question: the space was readable, the page
       * listing answered, and no page with that title exists. That is an absence
       * (MISSING), not a blind spot (NOT_VISIBLE).
       */
      absent?: boolean;
    };

interface RawPage {
  id: string;
  title: string;
  spaceId?: string;
  version?: { createdAt?: string; number?: number };
  _links?: { webui?: string };
}

function mapPage(page: RawPage): ConfluencePageSummary {
  return {
    id: page.id,
    title: page.title,
    lastUpdatedAt: page.version?.createdAt ?? new Date().toISOString(),
    version: page.version?.number ?? null,
    spaceId: page.spaceId ?? null,
    webPath: page._links?.webui ?? null,
  };
}

export async function pageByTitle(
  title: string,
  spaceKey: string,
  options: ConfluenceReadOptions = {},
): Promise<ConfluencePageResult> {
  noteRestCall();
  // The v2 pages endpoint filters by `space-id`, not `space-key`. Passing a space
  // key silently widens the search to the whole site, which used to attach an
  // unrelated page (and its freshness) to a control. Resolve the id first.
  const space = spaceKey ? await spaceIdByKey(spaceKey, options) : { id: null };
  if (space.error) {
    return { page: null, error: space.error };
  }
  if (spaceKey && !space.id) {
    // The space is not on this site (or not visible to it). Searching every space
    // by title here is how an unrelated page once became a control's policy, so
    // the lookup stops: nothing can be concluded about a page in a space we
    // cannot name.
    return {
      page: null,
      error: { status: 404, message: `No space ${spaceKey} on this site` },
      absent: false,
    };
  }
  const spaceFilter = space.id ? `&space-id=${encodeURIComponent(space.id)}` : '';
  const query = `title=${encodeURIComponent(title)}${spaceFilter}&limit=5`;
  const readPage = async (asAccountId?: string | null) => {
    noteRestCall();
    return confluenceClient(asAccountId).requestConfluence(route`/wiki/api/v2/pages?${query}`, {
      headers: { Accept: 'application/json' },
    });
  };
  try {
    let response = await readPage();
    if (response.ok) {
      const body = (await response.json()) as { results?: RawPage[] };
      const needle = title.toLowerCase();
      const found = (body.results ?? []).find((page) => {
        const candidate = page.title.toLowerCase();
        return candidate === needle || candidate.startsWith(needle);
      });
      if (found?.id) {
        return { page: mapPage(found) };
      }
      if (options.asAccountId) {
        // Empty as the app: ask again as the account that is looking.
        response = await readPage(options.asAccountId);
        if (response.ok) {
          const borrowed = (await response.json()) as { results?: RawPage[] };
          const match = (borrowed.results ?? []).find((page) => {
            const candidate = page.title.toLowerCase();
            return candidate === needle || candidate.startsWith(needle);
          });
          if (match?.id) {
            return { page: mapPage(match) };
          }
        }
      }
    } else if (response.status !== 404) {
      return {
        page: null,
        error: {
          status: response.status,
          message: `GET page "${title}" in ${spaceKey} failed (${response.status})`,
        },
      };
    }
    // The v2 title filter is an exact match, and policy titles carry a version
    // suffix ("Change Management Policy v3"). A rule names a prefix, so fall back
    // to a title search before concluding the page is absent.
    const search = await searchPagesByTitlePrefix(title, spaceKey, options);
    if (search.page) {
      return { page: search.page };
    }
    if (search.error && search.error.status !== 404) {
      return { page: null, error: search.error };
    }
    return {
      page: null,
      error: { status: 404, message: `No page titled "${title}" in ${spaceKey}` },
      absent: search.searched === true,
    };
  } catch (cause) {
    return {
      page: null,
      error: { status: 0, message: cause instanceof Error ? cause.message : String(cause) },
    };
  }
}

/**
 * Title-prefix lookup inside one space.
 *
 * Deliberately not CQL: `/wiki/rest/api/content/search` needs `search:confluence`,
 * and one more scope on the install screen costs more than it buys. Listing the
 * pages of a space is a `read:page:confluence` call and the prefix filter is a
 * string comparison, which is exact enough for a policy title.
 */
export async function searchPagesByTitlePrefix(
  prefix: string,
  spaceKey: string,
  options: ConfluenceReadOptions = {},
): Promise<{ page: ConfluencePageSummary | null; error?: ConfluenceReadError; searched?: boolean }> {
  noteRestCall();
  const space = await spaceIdByKey(spaceKey, options);
  if (space.error) {
    return { page: null, error: space.error, searched: false };
  }
  const spaceId = space.id;
  if (!spaceId) {
    return { page: null, searched: false };
  }
  const readPages = async (asAccountId?: string | null) => {
    noteRestCall();
    return confluenceClient(asAccountId).requestConfluence(
      route`/wiki/api/v2/pages?space-id=${spaceId}&limit=100&sort=title`,
      { headers: { Accept: 'application/json' } },
    );
  };
  const select = (pages: RawPage[]) => {
    const needle = prefix.toLowerCase();
    const exact = pages.find((page) => page.title.toLowerCase() === needle);
    const prefixed = pages.find((page) => page.title.toLowerCase().startsWith(needle));
    return exact ?? prefixed;
  };
  try {
    const response = await readPages();
    if (!response.ok) {
      return {
        page: null,
        error: { status: response.status, message: `Page list for ${spaceKey} failed (${response.status})` },
        searched: false,
      };
    }
    const body = (await response.json()) as { results?: RawPage[] };
    const match = select(body.results ?? []);
    if (match) {
      return { page: mapPage(match), searched: true };
    }
    if (options.asAccountId) {
      const borrowed = await readPages(options.asAccountId);
      if (borrowed.ok) {
        const other = (await borrowed.json()) as { results?: RawPage[] };
        const found = select(other.results ?? []);
        if (found) {
          return { page: mapPage(found), searched: true };
        }
        // Both identities listed the space and neither has the page: absent.
        return { page: null, searched: true };
      }
      return { page: null, searched: false };
    }
    return { page: null, searched: true };
  } catch (cause) {
    return {
      page: null,
      error: { status: 0, message: cause instanceof Error ? cause.message : String(cause) },
      searched: false,
    };
  }
}

/**
 * The page's own owner fields, from Confluence REST.
 *
 * The Teamwork Graph traversal is the app's primary accountability hop, but it is
 * a graph read: it needs an identity, and the unattended scan has none of its own
 * (it borrows the stored principal). When that hop cannot be read, "nobody is
 * accountable" is not the honest answer — Confluence itself carries an owner and a
 * last owner on every page (REST v2 `GET /pages/{id}`: `ownerId`, `lastOwnerId`,
 * `authorId`), readable with the `read:page:confluence` scope the app already has.
 *
 * This is a *fallback*, and it says so: the caller labels the row's provenance as
 * `rest` and keeps the graph failure as a note. What it must never become is a
 * silent substitute for the traversal — hence the `field` that names exactly which
 * property answered, and `null` when none of them does.
 */
export interface PageOwnerRead {
  accountId: string | null;
  /** Which page property named the person, for the audit pack's provenance. */
  field: 'owner' | 'lastOwner' | 'author' | null;
  error?: ConfluenceReadError;
}

interface RawPageOwnerFields {
  ownerId?: string | null;
  lastOwnerId?: string | null;
  authorId?: string | null;
  version?: { authorId?: string | null };
}

export async function pageOwner(
  pageId: string,
  options: ConfluenceReadOptions = {},
): Promise<PageOwnerRead> {
  noteRestCall();
  const read = async (asAccountId?: string | null) => {
    noteRestCall();
    return confluenceClient(asAccountId).requestConfluence(route`/wiki/api/v2/pages/${pageId}`, {
      headers: { Accept: 'application/json' },
    });
  };
  const pick = (body: RawPageOwnerFields): { accountId: string | null; field: PageOwnerRead['field'] } => {
    const candidates: Array<[PageOwnerRead['field'], string | null | undefined]> = [
      ['owner', body.ownerId],
      ['lastOwner', body.lastOwnerId],
      ['author', body.version?.authorId ?? body.authorId],
    ];
    for (const [field, value] of candidates) {
      if (typeof value === 'string' && value.length > 0) {
        return { accountId: value, field };
      }
    }
    return { accountId: null, field: null };
  };
  try {
    let response = await read();
    if (response.ok) {
      return pick((await response.json()) as RawPageOwnerFields);
    }
    if (response.status === 404) {
      return { accountId: null, field: null, error: { status: 404, message: `No page ${pageId} on this site` } };
    }
    if (options.asAccountId) {
      // Confluence answers an app identity with an empty body rather than a 403, so
      // ask again as the person whose eyes the caller is borrowing.
      response = await read(options.asAccountId);
      if (response.ok) {
        return pick((await response.json()) as RawPageOwnerFields);
      }
    }
    return {
      accountId: null,
      field: null,
      error: {
        status: response.status,
        message: `GET page ${pageId} owner fields failed (${response.status})`,
      },
    };
  } catch (cause) {
    return {
      accountId: null,
      field: null,
      error: { status: 0, message: cause instanceof Error ? cause.message : String(cause) },
    };
  }
}

/**
 * Pages in one space, for the reverse (orphan) scan.
 *
 * `truncated` is reported rather than swallowed: a reverse scan that silently read
 * only the first 200 pages would claim "no unclaimed evidence" about pages it never
 * saw, which is the same class of error as calling a permission gap an absence.
 */
export async function listSpacePages(
  spaceKey: string,
  options: ConfluenceReadOptions = {},
  limit = 200,
): Promise<{ pages: ConfluencePageSummary[]; truncated: boolean; error?: ConfluenceReadError }> {
  noteRestCall();
  const space = await spaceIdByKey(spaceKey, options);
  if (space.error) {
    return { pages: [], truncated: false, error: space.error };
  }
  if (!space.id) {
    return { pages: [], truncated: false, error: { status: 404, message: `No space ${spaceKey} on this site` } };
  }
  const pages: ConfluencePageSummary[] = [];
  let cursor: string | null = null;
  let truncated = false;
  try {
    for (let page = 0; page < 4; page += 1) {
      // Route values are interpolated one at a time: Forge's route guard rejects a
      // whole path-and-query passed as a single value ("path manipulation attempt"),
      // which is how the first version of this read failed on the live site.
      const request = cursor
        ? route`/wiki/api/v2/pages?space-id=${space.id}&limit=50&sort=title&cursor=${cursor}`
        : route`/wiki/api/v2/pages?space-id=${space.id}&limit=50&sort=title`;
      const response = await confluenceClient(options.asAccountId).requestConfluence(request, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        return { pages, truncated, error: { status: response.status, message: `Page list for ${spaceKey} failed (${response.status})` } };
      }
      const body = (await response.json()) as {
        results?: RawPage[];
        _links?: { next?: string };
      };
      for (const raw of body.results ?? []) {
        if (raw?.id) {
          pages.push(mapPage(raw));
        }
      }
      const next = body._links?.next;
      const nextCursor = next ? /cursor=([^&]+)/.exec(next)?.[1] ?? null : null;
      if (!nextCursor) {
        break;
      }
      cursor = decodeURIComponent(nextCursor);
      if (page === 3) {
        truncated = true;
      }
      if (pages.length >= limit) {
        truncated = true;
        break;
      }
    }
    return { pages, truncated };
  } catch (cause) {
    return {
      pages,
      truncated,
      error: { status: 0, message: cause instanceof Error ? cause.message : String(cause) },
    };
  }
}

export async function pageById(pageId: string, options: ConfluenceReadOptions = {}): Promise<ConfluencePageResult> {
  noteRestCall();
  const response = await confluenceClient(options.asAccountId).requestConfluence(
    route`/wiki/api/v2/pages/${pageId}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!response.ok) {
    return {
      page: null,
      error: { status: response.status, message: `GET page ${pageId} failed (${response.status})` },
    };
  }
  const body = (await response.json()) as RawPage;
  return { page: mapPage(body) };
}

export async function spaceIdByKey(
  spaceKey: string,
  options: ConfluenceReadOptions = {},
): Promise<{ id: string | null; error?: ConfluenceReadError }> {
  const attempt = async (asAccountId?: string | null) => {
    noteRestCall();
    const response = await confluenceClient(asAccountId).requestConfluence(
      route`/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`,
      { headers: { Accept: 'application/json' } },
    );
    if (!response.ok) {
      return {
        id: null,
        failed: { status: response.status, message: `GET space ${spaceKey} failed (${response.status})` },
      };
    }
    const body = (await response.json()) as { results?: Array<{ id?: string }> };
    return { id: body.results?.[0]?.id ?? null, failed: null };
  };
  try {
    const own = await attempt();
    if (own.id || !options.asAccountId) {
      return own.failed ? { id: null, error: own.failed } : { id: own.id };
    }
    // The app's identity sees no such space. That is not proof it is absent: ask
    // the account that is looking before saying so.
    const borrowed = await attempt(options.asAccountId);
    return borrowed.failed ? { id: null, error: borrowed.failed } : { id: borrowed.id };
  } catch (cause) {
    return { id: null, error: { status: 0, message: cause instanceof Error ? cause.message : String(cause) } };
  }
}

/** ari:cloud:confluence:<cloudId>:page/<pageId> */
export function pageAri(cloudId: string, pageId: string): string {
  return `ari:cloud:confluence:${cloudId}:page/${pageId}`;
}

/** Alias used by the engine, where the object kind matters at the call site. */
export const confluencePageAri = pageAri;

/** ari:cloud:confluence:<cloudId>:space/<spaceId> */
export function spaceAri(cloudId: string, spaceId: string): string {
  return `ari:cloud:confluence:${cloudId}:space/${spaceId}`;
}

/**
 * Any page the app can read. Used by the Environment Check when the registry is
 * empty (a fresh install), so the page probe has a real object to try.
 */
export async function firstPage(options: ConfluenceReadOptions = {}): Promise<ConfluencePageSummary | null> {
  noteRestCall();
  try {
    const response = await confluenceClient(options.asAccountId).requestConfluence(
      route`/wiki/api/v2/pages?limit=1&sort=-modified-date`,
      { headers: { Accept: 'application/json' } },
    );
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { results?: RawPage[] };
    const page = body.results?.[0];
    return page?.id ? mapPage(page) : null;
  } catch {
    return null;
  }
}

export interface ConfluenceSpaceSummary {
  id: string;
  key: string;
  name: string;
  type: string | null;
}

/**
 * The spaces this app can see, for the one-click bind step.
 *
 * An empty list is ambiguous (no spaces, or none visible), which is why the
 * caller shows it as "no space readable" rather than "the site has no spaces".
 */
export async function listSpaces(
  options: ConfluenceReadOptions = {},
): Promise<{ spaces: ConfluenceSpaceSummary[]; error?: ConfluenceReadError }> {
  noteRestCall();
  try {
    const read = async (asAccountId?: string | null) => {
      noteRestCall();
      return confluenceClient(asAccountId).requestConfluence(
        route`/wiki/api/v2/spaces?limit=50&sort=key`,
        { headers: { Accept: 'application/json' } },
      );
    };
    // Read as the person first, then as the app.
    //
    // The app's own identity is treated as an external app on some sites and gets a
    // two-row space list (the personal space and one more), while the person looking
    // at the Control Room can see every space the programme needs. The picker showed
    // exactly those two, so "bind the policy space" was impossible to complete on
    // the one site that mattered. The borrowed identity is tried first and the app's
    // own read is the fallback, which is the order every other Confluence read in
    // this app already uses.
    let response = options.asAccountId ? await read(options.asAccountId) : await read();
    if (!response.ok) {
      response = await read();
    }
    if (!response.ok) {
      return {
        spaces: [],
        error: { status: response.status, message: `Space list failed (${response.status})` },
      };
    }
    const body = (await response.json()) as {
      results?: Array<{ id?: string; key?: string; name?: string; type?: string }>;
    };
    return {
      spaces: (body.results ?? [])
        .filter((space) => Boolean(space.id && space.key))
        .map((space) => ({
          id: String(space.id),
          key: String(space.key),
          name: space.name ?? String(space.key),
          type: space.type ?? null,
        })),
    };
  } catch (cause) {
    return {
      spaces: [],
      error: { status: 0, message: cause instanceof Error ? cause.message : String(cause) },
    };
  }
}
