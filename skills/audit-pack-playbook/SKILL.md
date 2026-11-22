---
name: audit-pack-playbook
description: Assemble an audit-ready evidence pack for one work item or one control — judge the claims live, pull the provenance chain for every non-VERIFIED row, and hand back a table an auditor can accept. Use when someone asks for a quarter-close pack, an audit response, or "show me everything for PAY-1 with the receipts".
allowed-tools: get-evidence explain-verdict scan-control
---

# Audit pack playbook

Produce one work item's (or one control's) evidence pack. Work in this order; do not
skip a step because the answer "looks obvious".

## 1. Judge, do not assume

Call `get-evidence` with the work item key. It judges every claim its control
requires, live, from the graph and Jira REST. Do not ask for a scan first: a scan is
for drift, not for answering a question.

Record: the work item, the control, the badge, and the per-claim states. Those are
the pack's header.

For a whole quarter, call `scan-control` once with a single control code (a chat action
has about 20 seconds; a whole-registry scan can exceed it) and use its counts, delta and
integrity line as the header instead.

The app also produces the memo text deterministically (panel → "Copy audit memo", macro,
Control Room). Quote that text as it is; never rewrite it or add a claim the engine did
not judge.

## 2. Build the table, claim by claim

| Claim | State | Evidence | Observed | Age | Why |
|---|---|---|---|---|---|

Rules for the table:
- One row per claim. Never merge two claims into one row.
- `Evidence` is the evidence object (page title, comment, issue key), not the control.
- `Age` comes from the verdict; never compute it yourself.
- `Why` is the engine's reason string. Quote it; do not rewrite it into a softer
  sentence.

## 3. Pull the receipts for every non-VERIFIED row

For each STALE / MISSING / NOT_VISIBLE / INCOMPLETE row, call `explain-verdict` with
the work item key and the claim name. Add under the table, per row:

- the hop chain (`from -[relation]-> to @ observed`),
- the executed query (query key, row count, latency, retries),
- for NOT_VISIBLE, the exact scopes to grant,
- for INCOMPLETE, the cause (rate limit, timeout, index lag, backend 403).

Never present a STALE, MISSING, NOT_VISIBLE or INCOMPLETE claim without its chain.
The chain is the product.

## 4. Say what the pack cannot say

End with a short "Open points" section:
- NOT_VISIBLE rows, grouped by missing scope, with who can approve it
  (an organisation admin, on the app's Connected apps page).
- INCOMPLETE rows, with the cause and whether a rescan is worth doing now.
- MISSING rows, with whether a remediation issue already exists.
- Anything the scan could not evaluate (a claim type with no connector).

## 5. Offer the next step, do not take it

If the user wants gaps closed, describe the issues that `create-remediation` would
open (claim, assignee route, due date) and wait for a clear yes before calling it.
Then report the created keys and the route each assignee came from.

## Failure handling

- If `get-evidence` cannot read the work item: report the REST status. Do not guess
  the issue's content.
- If every row is NOT_VISIBLE: the app is installed without Teamwork Graph scopes.
  Say so, list the scopes, and stop — do not attempt a REST-only narrative that
  presents unverifiable claims as verified.
- If every row is INCOMPLETE with RATE_LIMIT_EXCEEDED: say the site is throttling the
  graph, and wait before rescanning.
