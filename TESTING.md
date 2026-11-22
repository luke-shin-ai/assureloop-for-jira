# Testing AssureLoop for Jira

**Codegeist 2026: Apps for Specialized Industries (finance)**
**Bonus prize claimed: Best apps with Teamwork Graph integration**
**Source version: 6.48.0**; **deployed to production (production version 2.1.0, 2026-11-20T09:04:34Z)**
**Distribution: Sharing with anyone; installation link issued 2026-11-20** (link text and app-detail fields in `../sharing-links.md`)
App ID `ari:cloud:ecosystem::app/f671f494-1c70-40d1-a9e7-624b9d45ada2`

Every number in §3, §4 and §6 below was re-measured on the **production** installation of the demo
site on 2026-11-20 after that deployment, and the raw output is in `verify-output.txt`. Screenshots
(1920 px window) are in `../screenshots/` (list at the end of this document).

This document is written for a judge with five minutes and a Jira Cloud site. Every claim below
is something you can see in the app, in the manifest, or in a test you can run yourself. Where a
number was measured on our demo site rather than on yours, it says so.

---

## 0. The 60-second version

1. Install from the installation link (section 1).
2. Open **Jira -> Apps -> AssureLoop** and press **Bind the programme** (section 3.1).
3. Press **Scan the registry** and read the five counters (section 3.2).
4. Open any work item and open the **Evidence** panel (section 3.3).
5. Open one claim with **Why?** and read the provenance footer (section 3.4).

What you are testing: the app answers *"did this control actually operate?"* from the Teamwork
Graph, and when it cannot see something it says **`not visible`** or **`not checked`** instead of
**`missing`**. Those three are different findings in a regulated institution, and only the third
one is the auditee's problem.

### What you need

| Requirement | Why |
|---|---|
| A Jira Cloud + Confluence Cloud site (one site, both products) | The app installs into both: the issue panel and Control Room in Jira, the audit-pack macro in Confluence |
| **Site admin** on that site (organisation admin if your site enforces it for Teamwork Graph scopes) | 13 scopes are requested; the Teamwork Graph ones may need org-admin approval |
| Rovo with agents enabled (Standard plan or above; *optional*) | Only for section 6. Every other surface works without Rovo |
| Nothing else: no external account, no API key, no LLM key, no outbound network | Section 2 |

---

## 1. Install

The submission provides a Forge **installation link** (Developer Console -> Distribution -> Sharing, status **Sharing with anyone**) on the Devpost submission page. It was issued on
2026-11-20 and points at the production deployment (2.1.0); the full text is in
`../sharing-links.md`. Opening it requires a **site admin** on the target site, verified on
2026-11-20 by opening the link, which renders the app's install page ("AssureLoop", "For Jira,
Confluence", the vendor privacy policy and the 13 scopes). Use it, then:

1. Choose your site and **Jira**; install. Then install the same app on **Confluence** on the same
   site: the manifest declares both, and the audit-pack macro lives on the Confluence side. The
   install screen lists the scopes; approving them is the whole configuration.
2. Open **Jira -> Apps -> AssureLoop**. The Control Room renders the twelve shipped controls even
   before anything is scanned or bound. The programme ships with the app, so an empty site is a
   usable site.
3. If your site shows *"Programme not bound to this site"*, continue to section 3.1. That is the
   expected first state on a site that does not have our demo project.

**If the install screen refuses on permissions:** the seven `read:graph:*` scopes are Teamwork
Graph scopes; an organisation admin must approve them. Approve the rest, finish the install, and
the app still works. The Environment Check (section 3.5) will name exactly which scope is
missing and which claims that makes `not visible`. That is a product feature, not a failure mode:
a missing Teamwork Graph scope returns an **empty, successful** result, so most apps silently show
"no data".

### The 13 scopes, and who reads what

| Scope | Read by |
|---|---|
| `storage:app` | Forge SQL (required by the `sql` module) |
| `read:jira-work` | JQL population, issue, comments, remote links (`src/jira/rest.ts`) |
| `write:jira-work` | Remediation issues and the claim label: only after a person presses **Close the gaps** |
| `read:page:confluence` | Confluence v2 pages (`/wiki/api/v2/pages`) |
| `read:space:confluence` | Confluence v2 spaces (`/wiki/api/v2/spaces`) |
| `read:confluence-content.all` | Legacy Confluence v1 content API. Declared, **not called by current code**; it is removed in the first post-submission release together with the unused impersonation on `write:jira-work` (see `../roi5-verification.md` §C13) |
| `read:graph:issue:jira` | `jiraSpaceWorkItems`: the population probe |
| `read:graph:issue-comment:jira` | `jiraWorkItemComments`: approval comments |
| `read:graph:project:jira` | The Jira space behind a work item |
| `read:graph:page:confluence` | `confluencePageOwners`: the accountability hop |
| `read:graph:space:confluence` | `atlassianTeamsBySpace` |
| `read:graph:user:atlassian` | Page owners, comment authors, team members |
| `read:graph:team:atlassian` | `atlassianTeamsBySpace`, `atlassianUserInTeams` |

No scope is declared that the code does not read, except `read:confluence-content.all` above, which
is disclosed here rather than left for you to find.

---

## 2. Check the eligibility claims (30 seconds)

**Runs on Atlassian.** The app is entirely Forge-hosted: `nodejs24.x` runtime, `sql` module,
`storage:app`; the manifest declares **no** `permissions.external.fetch`, no custom container, no
`rovo:mcp` server, no Forge LLM call. Every request the code makes goes to an Atlassian API. On
2026-11-20 `forge eligibility` reported the source version (6.48.0, development) **eligible for the
Runs on Atlassian program**, and the production deployment reported the same for version 2.1.0. It is
the same command you can run against the app if you have source access, and the same property
Atlassian checks from the manifest.

You can verify it from the artefacts without running anything:

- `manifest.yml`: `permissions:` contains scopes only, no `external` block; `app.runtime` is
  `nodejs24.x` with `memoryMB: 512`, `architecture: arm64` (Forge-hosted, not a container).
- `grep -r "fetch(" src/`: every call is `@forge/api` `requestJira` / `requestConfluence` or the
  Teamwork Graph gateway. There is no third-party host anywhere in the source.

**$0 to operate.** Forge functions and Forge SQL inside the free tier; no paid API; no LLM billing
because no model decides anything (section 5). The demo site is Atlassian's own free developer site.

---

## 3. Verify on your own site (5 minutes, your data)

This is the path that matters: it is **not** a hardcoded demo. Nothing below needs our demo project.

### 3.1 Bind the programme to your project and space (~20 s)

**Jira -> Apps -> AssureLoop -> "Where this programme runs"**

1. **Project**: pick any project you can read. This is the population the controls are judged
   against.
2. **Policy space**: pick a Confluence space, or leave **"no space (policy claims will report a
   setup gap)"**. With no space, policy claims report a setup gap rather than a permission gap
   (that distinction is deliberate).
3. Press **Bind the programme**. The badge at the top of the page changes from *"programme not
   bound"* to **`bound, <PROJECT>`**.

Binding needs **no new permission**: it rewrites `jira_project_key` on the twelve shipped controls
and the `spaceKey` in their rules, in Forge SQL, and retires the demo's evidence links (a link to a
page your site does not have is not evidence).

### 3.2 Scan (~20 s first time, longer on a cold container)

Press **Scan the registry**. While it runs the button reads *Scanning...*; when it returns you get:

- five counters, **verified / stale / missing / not visible / not checked**, plus a before -> after
  delta against the previous scan;
- a one-line **read identity** for the run, e.g. `graph 17 read(s), 17 as the scan principal, identity warm-up 361 ms` (measured on the demo site, v6.31). This is how an *unattended* run
  proves which identity read the graph;
- integrity counters: retried reads, claims not checked, claims out of view, and the causes.

On a project with no `ctrl-ac-*` labels the scan switches to **discovery mode**: the five most
recently completed changes in your project are judged instead, and every affected row says so.
A label-less site therefore produces a real verdict about *your* work items instead of an empty
table. This is stated on screen, not hidden.

### 3.3a The claim that needs the graph, and only the graph

Every work item under AC-01 carries a fourth claim, **Approval accountability**: *the person who
approved this change must be a member of a team the graph names as accountable for the governing
policy* (the policy page's owner's team, or a team linked to the policy's space).

| The graph's answer | The state | What it means |
|---|---|---|
| the approver is in that team | `verified` | "Approval by ..., member of <team>" |
| the team was read and the approver is not in it | `stale` | an approval from outside the accountable team |
| no team could be read | `not visible` (scope unproven) or `not checked` (scope proven, no rows) | never "nobody is accountable", and never "missing" |

No Atlassian REST API joins a Jira comment's author to a Confluence page's owning team, so this
claim has **no REST fallback** and no rule that can stand in for it. Measured on the demo site's
**production** installation (2026-11-20, version 2.1.0): `PAY-1` -> `verified`, evidence *"Approval by
luke luck (yottaman), member of Team Pulse"*, trace `ISSUE PAY-1 -> COMMENT 84900`,
`rule: policy -> PAGE 4063233`, `PAGE -> USER (atlassian_user_owns)`, `USER -> TEAM
(atlassian_team_member)`, footer `queryKey curated (no key), rows 1, 2,741 ms, via curated`.

### 3.3 Open a work item: the Evidence Gate (~10 s)

Open any issue in the bound project -> **Evidence** panel (issue panel, right-hand side).

- The badge is one of **`Evidence complete`**, **`Gaps found`**, **`Partly checked`**,
  **`Cannot be fully verified`**, **`Programme not bound to this site`**.
- Under it, one row per claim the item's control requires, with the five states and a one-line
  reason, plus evidence label, `observed <time>`, `owner`, `max age <n>d`.
- A work item with no control label is still judged: the app says *"No control label is on PAY-x; showing
  AC-01 as a template because it covers project PAY"* and offers **Claim for this control**. In a project
  no control covers, it offers the first three controls as templates (`AC-01`, `AC-02`, `AC-03`).
  A template evaluation cannot raise remediation issues: nothing is written until the item is claimed.

There is no "run a scan first" step in this path: opening the issue is the interaction. **Recheck**
exists for a run that came back *not checked*.

### 3.4 Press **Why?**: the provenance trace (~10 s)

Each claim expands into the graph path behind its verdict: one drawn node per hop with its ARI,
the relation name on the link, and the observation time; then a footer:

`queryKey <key or "curated (no key)">, rows <n>, <ms> ms, retries <n>, via <mode>, <label>`

This is the difference between "the app says so" and "here is the read that produced it". Hops the
catalogue could not express are drawn as their REST/registry hops and labelled, so the trace does not
imply a graph edge it did not get.

### 3.5 Environment Check (6 probes, one 5-second budget)

Press **Run environment check** (Control Room, or it appears automatically in the panel when a
verdict is `not visible` / `partly checked`).

| Probe | Reads |
|---|---|
| Connection (echo) | A minimal Teamwork Graph call |
| Work item scope | `jiraSpaceWorkItems` for the bound project |
| Comment scope | `jiraWorkItemComments` on a real work item |
| Page / space scope | `confluencePageOwners` on a visible page, plus `atlassianTeamsBySpace` |
| User / team scope | `atlassianUserInTeams` |
| Persisted query | The registered persisted Cypher, when a `queryKey` is configured |

Each probe is green / yellow / red, carries **what to do next** when it is not green, and names the
scope to approve. "Data absent" and "permission withheld" are displayed as different lines, because
the graph reports both the same way.

### 3.6 Close the loop (~15 s, optional: it writes)

On a work item with gaps, press **Close the N gaps**. For each missing/stale claim the app creates
one Jira issue, assigns it through the owner route it actually resolved (**graph page owner -> issue assignee -> component lead -> control owner**), and writes that route into the issue
**description** (`Owner route: <route> (<name>)`) while the **summary** carries the control, the claim,
the state and a finding token `[AL-xxxxxxxx]`. Re-running the scan does not open a second issue for
the same claim, because the token is matched before anything is created.

Gaps on a work item that was only *evaluated as a template* (no control label) are not raised: the
app refuses and says to claim the item first.

### 3.7 Optional: reproduce all five states with your own data (~10 minutes)

If you want to see `verified`, `stale` and `missing` side by side without our demo data:

1. Bind to a project **and** a space.
2. **`verified`**: create a Confluence page in that space titled **`Change Management Policy (test)`**, and
   take one issue in the project: set it **Done**, label it **`ctrl-ac-01`** (or accept the template the
   panel offers, an unlabelled item is still judged, with a "Claim for this control" button), and add
   a comment saying `approved` from a **different** account than the assignee. Open the Evidence panel:
   *Completed change record*, *Independent approval* and *Governing policy* read `verified`.
3. **`missing`**: make that same approval come from the assignee's own account instead (or delete the
   comment): *Independent approval* reads `missing`, with the reason naming self-approval. That is AC-02,
   "nobody deploys to production with their own approval", the demo's PAY-2.
4. **`stale`**: needs a policy page whose last version is older than the claim's window **and** whose
   title matches the rule's prefix. Creating a page today cannot age it out, and the app will not fake
   an age: that is why our demo points AC-06 at a real page last edited in 2021. If your site has no old
   page under one of the programme's titles, you will not see `stale` here, and that is the honest
   answer, not a missing feature.
5. **`not visible`**: deliberately decline one Teamwork Graph scope at install (or have an admin remove
   it): the claims that need it read `not visible`, name the scope, and nothing else changes.
6. **`not checked`**: no setup needed. A throttled or timed-out read produces it, and the reason
   (`RATE_LIMIT_EXCEEDED`, `TIMEOUT`, index lag, `teamsV2` 403) travels with the claim.

---

## 4. The demo programme: what the video shows (measured, not staged)

The recorded walkthrough runs on our demo site **`https://one-atlas-xkzp.atlassian.net`** (Atlassian
free developer site, provisioned 2026-11-18, valid to **2027-02-16**, which covers the judging
window 2027-01-06 to 2027-02-04). It holds a synthetic programme, *Northwind Pay*: a fictional
regulated payment institution with 12 controls (`AC-01` ... `AC-12`, 20 claims), 12 change issues
(`PAY-1` ... `PAY-12`, labelled `ctrl-ac-01` ... `ctrl-ac-12`), 6 policy pages in `ITO` / `SECOPS` /
`LEGAL`, and one genuinely old page (`Incident Runbooks`, last edited 2021-08-01). Nothing in it
refers to a real company, product or person.

**The demo site is not the test environment; your install is.** It is listed here so you can check
the video against the same numbers. If the site is re-provisioned (planned 2026-12-01, so its 90-day
life covers the whole judging period), the URL and these values are updated in this document and on
the submission page before the submission period closes.

Values below were measured on the **production installation** on **2026-11-20** (version 2.1.0),
except where a row says otherwise.

| Where | What you see | Value |
|---|---|---|
| Control Room badge | binding | `bound, PAY` / `bound to PAY / ITO` |
| **Scan the registry** | counts after a scan | **18 verified, 1 stale, 1 missing, 0 not visible, 0 not checked** (20 claims) |
| | duration | 23,464 ms (manual, production 2.1.0, first scan on a cold container), 22,989 ms (v6.48, development) |
| | read identity | `full registry, graph 17 read(s)` |
| | unattended run | 19,587 ms, `graph 17 read(s), 17 as the scan principal, identity warm-up 361 ms`, 0 capped (development installation) |
| | delta | `no previous scan to compare with yet`: the first scan of the production installation; later scans show the before -> after delta |
| Audit pack card | fingerprint basis | `20 claim row(s), 18 hashed fields, scan ba3fe02e-...` |
| | fingerprint | `8c0f371f12f9d11c`, then `ee61873b3a522752` once the AC-06 exception is recorded (the exception is hashed) |
| **Verify fingerprint** | verdict | **`VERIFIED MATCH`**, recomputed `ee61873b3a522752` over 20 rows |
| **Unexplained gaps** | count | **`Unexplained gaps: 1 of 2`** (AC-06 carries an exception until 2027-01-31 with a compensating control; AC-02 does not) |
| **Unclaimed evidence** | reverse scan | 43 pages read in ITO / SECOPS / LEGAL, 6 claimed, **37 unclaimed**: measured on the development installation. The reverse pass only runs inside the scan's 15-second budget, so the 23.5 s production scan skipped it and the card keeps the last stored answer; the number is not a constant of the site |
| | mode label | `rest+registry`: it reads Confluence REST and the registry, and says so |
| Environment Check | probes | 5 green, 1 yellow, 0 red, 1,701 ms; the yellow probe (Comment scope) states its own cause: the graph read succeeded and returned no rows, and the graph cannot tell that from a withheld scope |

### The three work items the video uses

**`PAY-1`, `Evidence complete`.** Control AC-01, three claims, all `verified`: the completed change
record, an independent approval comment (age ~1 day), and `Change Management Policy v3` (observed
2026-11-18, window 365 d). Opening **Why?** on the policy claim draws issue -> comment -> approver -> policy page -> team, with `queryKey c372c8f4-40be-4acf-9281-2fbceb39a07a, rows 6, 2,694 ms, via curated`
in the footer.

**`PAY-2`, `Gaps found`, 1 missing.** Control AC-02, *"nobody deploys to production with their own
approval"*. The only claim is the independent approval, and the approval comment was written by the
assignee. The app reports `missing` with that reason, this is the finding an auditor cares about,
and the app reaches it without a human reading 12 tickets.

**`PAY-6`, `Gaps found`, 0 missing / 1 stale.** Control AC-06 (incident postmortem within five
business days), policy claim on **`Incident Runbooks`**: last edited **1,936 days** ago against a
**180-day** window, and the row says **`owner not resolved`** with the note *"confluencePageOwners
returned no rows for Incident Runbooks, and Confluence's own owner fields are empty"*. This is the
honest version of the "accountability" story: when the graph cannot name an owner, the app shows
the two routes it tried rather than inventing one. **Why?** shows the trail and `2 claims, ~2.7 s`.

### The Confluence macro (`AC-01 audit pack`, space `ITO`)

Rendered on a real Confluence page, from the Confluence installation's own scan:

`as of 2026-11-20T09:10:59.314Z, fingerprint 7d1836b711580dfc, scan 945d968a, trigger manual, 20 claim(s): 17 verified, 1 stale, 1 missing, 0 not visible, 1 not checked`

Press **Verify fingerprint** -> `VERIFIED MATCH` (recomputed `7d1836b711580dfc` over 20 rows).
Press **Scan now (this installation)** to fill the Confluence side without a Jira scan.

The one `not checked` row is AC-01's **Approval accountability** on the Confluence side: *"The graph
named no team for the policy the control names, so whether the approver is accountable for the policy
could not be checked."* The same claim is `verified` on the Jira side, where the page-owner and team
hops resolve. The two installations hold separate Forge SQL, which is also why the pack shows
`Unexplained gaps: 2` (the AC-06 exception was recorded in the Jira side's database).

**One thing to know before you compare the two surfaces:** Forge SQL is scoped to the installation
that invokes it, so the **Jira** installation and the **Confluence** installation each keep their
own registry and scan history. The macro reads the Confluence side; the Control Room reads the Jira
side. That is why the macro's pack shows `Unexplained gaps: 2` while the Control Room shows
`1 of 2` (the exception was recorded in the Jira side's database). It is a per-product store, not a
bug, and it is the one place where two screens legitimately disagree.

---

## 5. The five states, and why the fifth one exists

| State | Meaning | What a reviewer should check |
|---|---|---|
| `VERIFIED` | Evidence exists, is inside the claim's window, and its owner is active | The row links to the evidence object and shows when it was observed |
| `STALE` | Evidence exists but is older than the window, or its owner is deactivated | The age in days and the window are both on the row |
| `MISSING` | Evidence really is absent, **and the read that looked for it finished and could see the data** | The reason never names a scope |
| `NOT_VISIBLE` | The app could not see the data, because a permission was not granted | The reason names the scope to approve, e.g. `read:graph:page:confluence` |
| `INCOMPLETE` | The scan could not check the claim **this time**: throttle, timeout, index lag, `teamsV2` 403 | The cause travels with the claim, and the verdict says *rescan*, not *missing* |

The engine is deterministic: rules over graph and REST reads, no model in the verdict path. The
agent narrates verdicts; it never creates or softens one. Prose is Rovo's job; the verdict is not.
The audit memo's text comes from the same deterministic function on every surface, so the same rows
always produce the same words.

**How `NOT_VISIBLE` is produced honestly.** Revoking a scope mid-demo does *not* reproduce it: scope
changes take about a minute to propagate and rows keep arriving after removal, so a live demonstration
of revocation would be theatre. The reproducible ways are (a) install with one Teamwork Graph scope
deliberately declined, (b) a site where the admin withheld it, or (c) a genuine `403`. All three are
covered by tests that pin the behaviour (`status code is: 403` -> `NOT_VISIBLE`, never retried, scope
named). The video states which of these it is showing; it does not pretend a revoked scope.

---

## 6. Rovo: 4 actions + 1 skill (2 minutes, needs Rovo)

The app declares `rovo:agent` (**Assurance Agent**), four `action` modules and one `rovo:skill`.
Open Rovo chat in Jira and use one of the three shipped starters, or ask for the write explicitly:

- *"What does PAY-1 need to prove before it ships?"* -> `get-evidence` (GET, stateless: reads the
  graph and Jira REST, needs no earlier scan).
- *"Explain why the approval claim for PAY-1 is not verified"* -> `explain-verdict` (GET): hop-by-hop
  path with ARI, relation, observation time, query key, rows, latency.
- *"Which claims cannot be verified because of permissions?"* -> `explain-verdict` / `scan-control`
  (TRIGGER): scans **one control** per call. The manifest says why: a Rovo action gets about 20
  seconds, and a whole-registry scan can take longer.
- *"Raise the gaps for PAY-6"* (your phrasing, not a shipped starter) -> `create-remediation`
  (CREATE): the agent must state which claims it is about to raise and wait for a yes; the issues it
  creates are the same ones the panel creates.

The skill `audit-pack-playbook` is the multi-step procedure (judge -> table -> provenance -> memo) kept
out of the prompt so other agents can reuse it as a tool.

**Home chat is different, on purpose.** Rovo home has no Jira product context, so Jira REST cannot be
read there. `get-evidence` then returns `needsSiteContext: true` with a deep link to the work item,
and the agent prompt tells it to route you there instead of guessing a verdict. You should see a
short "this chat cannot read Jira, open the item" answer, not a failed read.

---

## 7. Verify the implementation locally (2 minutes, no site needed)

```bash
cd assureloop
npm install
npx tsc --noEmit          # strict TypeScript: 0 errors
npm run smoke             # compiles, then 489 assertions across 12 files; no site, no credentials
npm run build:ui          # esbuild bundles for the three Custom UI surfaces
npm run check:claims      # the numbers in README.md, TESTING.md and the Devpost text match the code
npm run build:demo        # regenerates docs/demo/data.js from the shipped programme
npm run test:demo         # Playwright, 1440 / 1920 / 390x844: no horizontal scroll (python playwright)
forge lint                # manifest + code -> "No issues found" (needs `forge login`)
```

`npm run smoke` is what keeps the product's claims pinned rather than merely asserted:

| Test file | Assertions | What it pins |
|---|---|---|
| `resolvers.unique.cjs` | 3 | every resolver key is defined once (a duplicate throws on the first call and takes every surface down) |
| `judge.smoke.cjs` | 72 | fresh -> `VERIFIED`; old -> `STALE`; absent with a proven scope -> `MISSING`; unproven scope -> `NOT_VISIBLE`, never `MISSING`; throttle / unindexed / unread population / `teamsV2` 403 -> `INCOMPLETE`; failure classification |
| `gate.fixture.cjs` | 53 | a whole work item judged against a fake Atlassian: a 412-day-old policy is `STALE` with a working URL, a denied ownership hop is `NOT_VISIBLE` and names the scope, a throttled comment read is `INCOMPLETE` with `RATE_LIMIT_EXCEEDED` |
| `scan.honesty.cjs` | 23 | the registry scan reports the same five states with the same rules as the panel |
| `audit.pack.cjs` | 63 | the fingerprint covers all 18 hashed fields; changing a label, URL, missing scope, exception reason/expiry/compensating control, remediation, window or judged time is **DRIFT**; row order and clock-derived values are not |
| `trace.render.cjs` | 29 | in jsdom: one box per hop node, one curve per relation, no overlapping boxes, no label under a box or outside the drawing, a backward hop gets its own column, the footer shows `queryKey, rows, ms, retries` |
| `control-room.render.cjs` | 27 | in jsdom: **Scan the registry** really calls `scanNow` (a regression test for a shadowed handler that once made the button dead) |
| `hardening.cjs` | 21 | unreachable site -> `NOT_EVALUATED`, not a throw; registry falls back to the shipped programme |
| `v627.regressions.cjs` | 55 | the cross-review fixes: scope-probe honesty, no read-failure-as-permission, finding tokens, retry isolation, truncated persisted results |
| `v630.regressions.cjs` | 37 | the graph budget: a hung hop returns instead of blocking, a capped hop is `TIMEOUT` and not retried, two caps open the breaker, REST owner fallback names the property that answered, migrations run once |
| `v635.regressions.cjs` | 45 | the v6.35 honesty core: an approval is a statement rather than a request, a revoked ownership hop is `not visible` rather than `nobody accountable`, a denial is not outvoted by a REST candidate, an empty project is `not checked`, a link title is not a pull request, `regulationRef` is hashed, and the cross-product claim's three answers |
| **v640.regressions.cjs** | 61 | the v6.49 red-team round: seventeen phrasings that read as approvals are not, a population claim prints how much it read and how much qualified (`everyItem` needs all of it), change 51 and comment 101 are read through the API's pages, migrations survive a concurrent first request, the trace footer reports one read per number, and the displayed fingerprint is 128 bits |
| **total** | **489** | 12 files, no site, no credentials |

---

## 8. Known limitations (read this before you judge)

Stated here rather than found by you:

1. **Cold start.** The first invoke of a Forge container after idle can take 70-180 seconds, and a
   click during that window can come back `Failed to fetch`. Mitigations: the Control Room calls the
   `ping` resolver when the page opens, invokes retry once on a transport failure, and schema
   migration is de-duplicated. **Warm the page (open it, wait for it to render) before pressing Verify
   fingerprint.** This is the platform's cold start; it is not removable from the app side.
2. **Per-product database.** Jira and Confluence installations have separate Forge SQL. Seed and
   scan through the product whose surface you are demonstrating; the macro's **Scan now (this
   installation)** fills the Confluence side.
3. **Persisted Cypher is per environment.** `ASSUR_QUERY_KEY_EVIDENCE_CHAIN` is a Forge *variable*,
   so it applies per environment, not per installation. Without it the app runs curated-only, says
   so on the trace footer (`curated (no key)`) and in the Environment Check (yellow), and never moves
   a verdict on the strength of an optional enrichment.
4. **Ownership data is thin on some sites.** `confluencePageOwners` returns zero rows on our demo
   site, so the app falls back to Confluence's own owner fields (`ownerId` -> `lastOwnerId` -> `authorId`), marks the provenance `rest`, and if those are empty too it prints **owner not
   resolved** instead of implying an owner. `teamsV2` may answer 403 while every other scope is
   granted; routes then fall back to issue assignee and component lead, visibly.
5. **Seeding has no button.** `resolver: seedDemo` exists for the demo programme and refuses to run on
   a project with no work items (a registry of unresolved links would produce fake evidence). It is
   not exposed in the UI, because a "make evidence appear" button is the wrong idea for this product.
   Use **Bind** + **Discovery** instead; the shipped programme works on your project without it.
6. **The two screens legitimately disagree on unexplained gaps**, for the reason in section 4.
7. **Not listed on Marketplace.** The Marketplace bonus was not claimed; the bonus claimed is
   Teamwork Graph integration, which is what the product actually cannot work without.
8. **Loom and Assets were cut.** The account has no Loom data and Assets exposes only
   `objects(ids:)`, so neither can be a hop (`../g0-benchmark.md` #12). They are not claimed anywhere
   in the product.

---

## 9. Judge's checklist

- [ ] Installed on Jira **and** Confluence from the installation link
- [ ] `forge eligibility` (or the manifest) shows a Forge-hosted app with no egress
- [ ] Control Room renders the twelve controls before any scan
- [ ] **Bind the programme** -> badge becomes `bound, <your project>`
- [ ] **Scan the registry** -> five counters + read identity line + integrity counters
- [ ] A work item's **Evidence** panel judges its claims with no scan step
- [ ] **Why?** opens a trace with ARI, relation, observed time and a `queryKey, rows, ms` footer
- [ ] **Close the gaps** creates one issue per gap with the owner route written in
- [ ] Environment Check names what to approve, in six probes
- [ ] Confluence macro renders a claim table with an as-of time, a SHA-256 fingerprint, and
      **Verify fingerprint** -> `VERIFIED MATCH`
- [ ] An exception turns an unexplained gap into an explained one **without** changing the state
- [ ] `npm run smoke` -> 489/489

---

## 10. The screenshots behind the submission

Captured on 2026-11-20 between 18:00 and 18:13 KST in a **1920 px-wide window** (1920 × 993 CSS px,
2400 × 1241 device px at the browser's 1.25 device ratio) against the demo site, production
installation. Each file was opened and checked for clipping before it was kept.

| File (`../screenshots/`) | What it shows |
|---|---|
| `01-control-room-counters-1920.png` | Control Room: `bound, PAY`, LAST SCAN `18 / 1 / 1 / 0 / 0`, `full registry, graph 17 read(s)`, `unexplained gaps 1`, Environment Check 5 green, 1 yellow |
| `02-control-room-audit-pack-verified-match-1920.png` | Audit pack: fingerprint `ee61873b3a522752`, **Verify fingerprint -> VERIFIED MATCH**, `Unexplained gaps: 1 of 2`, the AC-06 row carrying `exception until 2027-01-31` |
| `03-pay1-evidence-panel-1920.png` | `PAY-1` Evidence panel: `Evidence complete, AC-01, HIGH`, *"All 4 claim(s) are backed by evidence the graph could see"*, the guarantees / not-guarantees boundary |
| `04-pay1-approval-accountability-trace-1920.png` | `PAY-1` *Approval accountability* `verified`, *"Approval by luke luck (yottaman), member of Team Pulse"*, with the four-hop TWG trace and the `queryKey, rows, ms, via` footer |
| `05-pay6-stale-governing-policy-1920.png` | `PAY-6` `Gaps found, AC-06`, `0 missing, 1 stale`: *Incident Runbooks* 1,936 days old against a 180-day window, `owner not resolved`, and the "Ownership unresolved" note |
| `06-confluence-audit-pack-macro-1920.png` | Confluence macro `AC-01 audit pack`: as-of time, `fingerprint 7d1836b711580dfc`, `20 claim(s): 17 verified, 1 stale, 1 missing, 0 not visible, 1 not checked`, guarantees, claim rows |
| `07-confluence-verify-fingerprint-verified-match-1920.png` | Macro tail: `Verify fingerprint -> VERIFIED MATCH, recomputed 7d1836b711580dfc over 20 row(s)`, `Scan now (this installation)` -> `Scan finished.` |
| `08-shared-install-page-1920.png` | The shared installation link opened in a browser: the Atlassian install page for `AssureLoop`, "By luke luck (yottaman) (Independent developer (solo entry, Codegeist 2026))", "For Jira, Confluence", vendor privacy policy and the 13 scopes |

Known visual limitation at this width: inside a Jira issue panel (~1,170 px) the four-hop trace fits
its columns but two edge labels (`atlassian_user_owns`, `rule: policy`) sit close to the neighbouring
boxes. The trace renderer's own test pins a 1,542 px board as collision-free; widening the trace's
minimum width and letting it scroll inside a narrow panel is queued as a post-submission change.
