/**
 * Evidence Gate — the Jira issue panel (primary surface, E1).
 *
 * One work item. Its claims. Judged live, with the receipts one click away.
 * The panel deliberately has no "scan" step in the path to a verdict: opening the
 * issue is the interaction, and the Rescan button exists only for a run that came
 * back INCOMPLETE.
 */

import {
  ageLabel,
  badge,
  chip,
  clear,
  copyButton,
  el,
  formatWhen,
  getContext,
  invoke,
  invokeWarm,
  issueKeyFromContext,
  renderEnvironment,
  renderTrace,
  shortAri,
  stateLabel,
  stateLegend,
} from '../shared/ui.js';

const root = document.getElementById('app');
let state = {
  issueKey: null,
  controlCode: null,
  gate: null,
  environment: null,
  closing: false,
  closure: null,
  expanded: new Set(),
  loading: true,
  error: null,
};

function heading(gate) {
  const control = gate.control;
  return el('div', { class: 'stack', style: 'gap:4px' }, [
    el('div', { class: 'spread' }, [
      el('div', { class: 'row' }, [
        badge(gate.badge?.state ?? 'NOT_EVALUATED', gate.badge?.label ?? 'Evidence'),
        control
          ? el('span', { class: 'mono', text: `${control.code} · ${control.riskTier}` })
          : null,
      ]),
      el(
        'button',
        {
          class: 'secondary tiny',
          text: state.loading ? 'Checking…' : 'Recheck',
          disabled: state.loading,
          onclick: () => load({ rescan: true }),
        },
        [],
      ),
    ]),
    el('h1', { text: 'AssureLoop — Evidence Gate' }),
    el('p', {
      class: 'tiny muted',
      text:
        'What this change must prove before it ships — and what could not be proven is shown as “not checked” or “not visible”, never as “missing”.',
    }),
    gate.issue
      ? el('div', { class: 'muted' }, [
          `${gate.issue.key} · ${gate.issue.summary} · ${gate.issue.status}`,
        ])
      : null,
    control
      ? el('div', { class: 'muted' }, [`${control.name} · ${control.regulationRef}`])
      : null,
    el('p', { class: 'tiny muted', text: gate.badge?.detail ?? '' }),
    stateLegend(),
  ]);
}

/**
 * B1: the trust boundary, on the surface a control owner actually opens.
 *
 * Two lines each: what the evidence behind this verdict guarantees, and what it does
 * not. The panel is where the claim is made, so it is where the boundary belongs.
 */
function guaranteeBox(guarantees) {
  if (!guarantees) {
    return null;
  }
  return el('div', { class: 'card stack' }, [
    el('div', { class: 'guarantees' }, [
      el('div', { class: 'guarantee-col does' }, [
        el('div', { class: 'guarantee-title', text: 'This evidence guarantees' }),
        ...guarantees.does.map((line) => el('div', { class: 'tiny', text: `• ${line}` })),
      ]),
      el('div', { class: 'guarantee-col does-not' }, [
        el('div', { class: 'guarantee-title', text: 'This evidence does NOT guarantee' }),
        ...guarantees.doesNot.map((line) => el('div', { class: 'tiny', text: `• ${line}` })),
      ]),
    ]),
  ]);
}

function claimRow(gate, row) {
  const open = state.expanded.has(row.requirementId);
  const evidenceNode = row.evidence
    ? row.evidence.url
      ? el('a', { href: row.evidence.url, target: '_blank', rel: 'noopener', text: row.evidence.label ?? shortAri(row.evidence.ari) })
      : el('span', { text: row.evidence.label ?? shortAri(row.evidence.ari) })
    : el('span', { class: 'muted', text: 'no evidence object' });

  const meta = el('div', { class: 'meta' }, [
    el('span', {}, ['evidence ', evidenceNode]),
    el('span', { text: `observed ${formatWhen(row.evidence?.observedAt)}` }),
    row.evidence?.owner
      ? el('span', { text: `owner ${row.evidence.owner}` })
      : row.evidence?.ownerResolved === false
        ? el('span', { class: 'warn', text: 'owner not resolved' })
        : null,
    el('span', { text: `max age ${row.maxAgeDays}d` }),
  ]);

  const details = [];
  if ((row.missingScopes ?? []).length > 0) {
    details.push(
      el('div', { class: 'banner' }, [
        el('strong', { text: 'Cannot see this: ' }),
        document.createTextNode(
          row.missingScopes.map((scope) => `${scope.scope} (${scope.explanation})`).join(', '),
        ),
      ]),
    );
  }
  if ((row.failures ?? []).length > 0) {
    details.push(
      el('ul', { class: 'tight' }, row.failures.map((failure) =>
        el('li', {}, [
          el('span', { class: 'mono', text: failure.cause }),
          ` — ${failureMessage(failure)}`,
        ]),
      )),
    );
  }
  if (row.expectation) {
    details.push(el('p', { class: 'tiny muted', text: `Requirement: ${row.expectation}` }));
  }
  for (const note of row.notes ?? []) {
    details.push(el('p', { class: 'tiny muted', text: note }));
  }

  return el('div', { class: 'claim' }, [
    el('div', { class: 'claim-head' }, [
      el('div', { class: 'row' }, [chip(row.state), el('strong', { text: row.claim })]),
      el('button', {
        class: 'why',
        text: open ? 'Hide the why' : 'Why?',
        onclick: () => {
          if (open) {
            state.expanded.delete(row.requirementId);
          } else {
            state.expanded.add(row.requirementId);
          }
          render();
        },
      }),
    ]),
    el('p', { class: 'reason', text: row.reason }),
    meta,
    ...details,
    open ? renderTrace(row.trace) : null,
  ]);
}

/** Guard against a typo producing "undefined" on screen. */
function failureMessage(failure) {
  return failure?.message ?? 'no detail';
}

function closurePanel() {
  if (!state.closure) {
    return null;
  }
  const created = state.closure.created ?? [];
  const skipped = state.closure.skipped ?? [];
  const routes = state.closure.routes ?? [];
  return el('div', { class: 'card stack' }, [
    el('h2', { text: 'Gaps closed' }),
    created.length === 0
      ? el('p', { class: 'muted', text: 'Nothing was created — no missing or stale claim was found.' })
      : el('ul', { class: 'tight' }, created.map((entry) =>
          el('li', {}, [
            el('strong', { text: entry.createdIssue }),
            ` — ${entry.requirement}`,
            entry.assignee ? `, assigned to ${entry.assignee}` : ', unassigned',
            el('div', { class: 'tiny muted', text: entry.hint }),
          ]),
        )),
    skipped.length > 0
      ? el('details', {}, [
          el('summary', { class: 'tiny muted', text: `${skipped.length} skipped` }),
          el('ul', { class: 'tight' }, skipped.map((entry) => el('li', { class: 'tiny', text: `${entry.requirement}: ${entry.why}` }))),
        ])
      : null,
    routes.length > 0
      ? el('div', { class: 'tiny muted' }, [
          'Owner routes: ',
          routes.map((route) => `${route.requirement} → ${route.route}`).join(' · '),
        ])
      : null,
  ]);
}

function integrityLine(gate) {
  const integrity = gate.integrity ?? {};
  const parts = [
    `${integrity.checked ?? 0} claims judged`,
    `${integrity.durationMs ?? 0} ms`,
  ];
  if (integrity.retried) {
    parts.push(`${integrity.retried} retried read(s)`);
  }
  if (integrity.incomplete) {
    parts.push(`${integrity.incomplete} not checked`);
  }
  if (integrity.notVisible) {
    parts.push(`${integrity.notVisible} out of view`);
  }
  return el('div', { class: 'trace-foot' }, parts.map((part) => el('span', { text: part })));
}

function render() {
  clear(root);
  if (state.loading && !state.gate) {
    root.append(el('div', { class: 'card' }, [el('p', { class: 'muted', text: 'Reading the Teamwork Graph…' })]));
    return;
  }
  if (state.error) {
    root.append(
      el('div', { class: 'card stack' }, [
        el('h1', { text: 'AssureLoop' }),
        el('div', { class: 'banner', text: state.error }),
        el('button', { class: 'secondary', text: 'Try again', onclick: () => load() }),
      ]),
    );
    return;
  }
  const gate = state.gate;
  if (!gate) {
    return;
  }

  const wrap = el('div', { class: 'stack' }, [heading(gate)]);

  if (gate.note) {
    wrap.append(
      el('div', { class: 'banner info' }, [
        document.createTextNode(`${gate.note} `),
        gate.control
          ? el('button', {
              class: 'secondary tiny',
              text: 'Claim for this control',
              onclick: async () => {
                await invoke('claimIssue', { issueKey: state.issueKey, controlCode: gate.control.code });
                await load();
              },
            })
          : null,
      ]),
    );
  }

  if (gate.badge?.state === 'NOT_EVALUATED' && /not bound/i.test(gate.badge?.label ?? '')) {
    wrap.append(
      el('div', { class: 'banner info' }, [
        document.createTextNode(
          'This programme is bound to a project and space this site does not have. Open the AssureLoop control room (Jira → Apps → AssureLoop) and press “Bind the programme” — one click, no new permission. ',
        ),
      ]),
    );
  }

  if (gate.guarantees) {
    wrap.append(guaranteeBox(gate.guarantees));
  }

  if (gate.requirements.length === 0) {
    wrap.append(
      el('div', { class: 'card stack' }, [
        el('p', { class: 'muted', text: 'No claim is registered for this work item yet.' }),
        gate.suggestedControls?.length
          ? el('div', { class: 'row' }, [
              el('span', { class: 'tiny muted', text: 'Judge it against a control as a template:' }),
              ...gate.suggestedControls.map((control) =>
                el('button', {
                  class: 'secondary tiny',
                  text: control.code,
                  onclick: () => {
                    state.controlCode = control.code;
                    load();
                  },
                }),
              ),
            ])
          : null,
      ]),
    );
  } else {
    wrap.append(el('div', {}, gate.requirements.map((row) => claimRow(gate, row))));
    wrap.append(integrityLine(gate));
  }

  const footer = el('div', { class: 'row' }, []);
  if (gate.gaps > 0) {
    footer.append(
      el('button', {
        class: state.closing ? 'primary' : 'primary',
        text: state.closing ? 'Closing gaps…' : `Close the ${gate.gaps} gap${gate.gaps === 1 ? '' : 's'}`,
        disabled: state.closing,
        onclick: closeGaps,
      }),
    );
  }
  if (gate.integrity?.incomplete > 0) {
    footer.append(el('button', { class: 'secondary', text: 'Recheck (some claims unchecked)', onclick: () => load({ rescan: true }) }));
  }
  if (gate.requirements.length > 0) {
    footer.append(
      copyButton('Copy audit memo', async () => {
        const memo = await invokeWarm('auditMemo', {
          issueKey: state.issueKey,
          controlCode: state.controlCode ?? undefined,
        });
        return memo?.memo ?? 'No memo was produced.';
      }),
    );
  }
  if (footer.childNodes.length > 0) {
    wrap.append(footer);
  }

  if (state.closure) {
    wrap.append(closurePanel());
  }

  if (state.environment) {
    wrap.append(renderEnvironment(state.environment, { onRerun: () => loadEnvironment() }));
  } else if (needsEnvironment(gate)) {
    wrap.append(
      el('div', { class: 'card stack' }, [
        el('div', { class: 'spread' }, [
          el('h2', { text: 'Why can’t this be verified?' }),
          el('button', { class: 'secondary tiny', text: 'Run the check', onclick: () => loadEnvironment() }),
        ]),
        el('p', { class: 'tiny muted', text: 'The environment check reads six things in about five seconds and names what to approve.' }),
      ]),
    );
  }

  root.append(wrap);
}

function needsEnvironment(gate) {
  return gate.badge?.state === 'UNVERIFIABLE' || gate.badge?.state === 'PARTIAL' || gate.badge?.state === 'NOT_EVALUATED';
}

async function loadEnvironment() {
  state.environment = await invokeWarm('environmentCheck', { issueKey: state.issueKey });
  render();
}

async function closeGaps() {
  state.closing = true;
  render();
  try {
    state.closure = await invoke('closeGapsForIssue', {
      issueKey: state.issueKey,
      controlCode: state.controlCode ?? undefined,
    });
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    state.closing = false;
    await load({ keepClosure: true });
  }
}

async function load(options = {}) {
  state.loading = true;
  if (!options.keepClosure) {
    state.closure = null;
  }
  render();
  try {
    if (!state.issueKey) {
      const context = await getContext();
      state.issueKey = issueKeyFromContext(context);
    }
    if (!state.issueKey) {
      state.error = 'No Jira work item is in context. Open this panel from an issue.';
      state.loading = false;
      render();
      return;
    }
    state.gate = await invokeWarm('issueGate', {
      issueKey: state.issueKey,
      controlCode: state.controlCode ?? undefined,
    });
    state.error = null;
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    state.loading = false;
    render();
  }
  if (needsEnvironment(state.gate ?? {})) {
    // Async, so the verdicts are on screen before the probes finish.
    loadEnvironment().catch(() => undefined);
  }
}

load();
