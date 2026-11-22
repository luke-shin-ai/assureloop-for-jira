/**
 * Control Room — the Jira global page.
 *
 * Secondary by design (E1): a rollup of the last scan, the drift delta, the
 * integrity badge, the audit pack and the Environment Check. It is also the one
 * place a judge binds the programme to their own project and space, because an
 * empty site has to become a working one in a single click.
 */

import {
  badge,
  chip,
  clear,
  copyButton,
  el,
  formatWhen,
  invokeWarm,
  renderEnvironment,
  stateLabel,
} from '../shared/ui.js';

const root = document.getElementById('app');

/** The same claim names the panel and the pack use, so a reader is not translating. */
const CLAIM_LABEL = {
  jira_work_item: 'Completed change record',
  approval_comment: 'Independent approval',
  policy_page: 'Governing policy',
  test_record: 'Test or attestation record',
  pull_request: 'Linked pull request',
  deployment: 'Deployment record',
  approval_independence: 'Approval accountability',
};
const state = {
  rollup: null,
  setup: null,
  environment: null,
  /** What the opening ping said about the app being awake. */
  warm: null,
  scanning: false,
  binding: false,
  loading: true,
  error: null,
  notice: null,
  projectKey: null,
  spaceKey: null,
  verifying: false,
  verification: null,
  exceptionFor: null,
  exceptionNotice: null,
  onboarding: false,
  onboardResult: null,
  /** The custom-control form. Kept here so a re-render does not empty the fields. */
  customCode: '',
  customName: '',
  customLabel: '',
  customType: 'jira_work_item',
  customDays: '90',
  customEvery: false,
  customJson: '',
  customNotice: null,
  customBusy: false,
};

/** The evidence types a custom control may claim, in the words the rows use. */
const CUSTOM_EVIDENCE = [
  ['jira_work_item', 'Completed change record'],
  ['approval_comment', 'Independent approval'],
  ['policy_page', 'Governing policy'],
  ['test_record', 'Test or attestation record'],
  ['pull_request', 'Linked pull request'],
  ['deployment', 'Deployment record'],
  ['approval_independence', 'Approval accountability'],
];

function countBoxes(counts) {
  const order = ['VERIFIED', 'STALE', 'MISSING', 'NOT_VISIBLE', 'INCOMPLETE'];
  return el(
    'div',
    { class: 'counts' },
    order.map((key) =>
      el('div', { class: `count ${key}` }, [
        el('div', { class: 'n', text: String(counts?.[key] ?? 0) }),
        el('div', { class: 'k', text: stateLabel(key) }),
      ]),
    ),
  );
}

/**
 * B4: before → after, plus the unexplained count.
 *
 * The counts alone say what is true now; the arrow says whether the quarter is
 * closing the gaps or accumulating them, which is the sentence a control owner has
 * to say out loud.
 */
function deltaSummary(rollup) {
  const scan = rollup.lastScan;
  if (!scan) {
    return null;
  }
  const delta = rollup.delta;
  const counts = scan.counts ?? {};
  const parts = [];
  if (delta) {
    const before = {
      VERIFIED: (counts.VERIFIED ?? 0) - delta.VERIFIED,
      STALE: (counts.STALE ?? 0) - delta.STALE,
      MISSING: (counts.MISSING ?? 0) - delta.MISSING,
    };
    for (const [key, label] of [
      ['VERIFIED', 'verified'],
      ['STALE', 'stale'],
      ['MISSING', 'missing'],
    ]) {
      parts.push(
        el('span', {
          text: `${label} ${before[key]} → ${counts[key] ?? 0} (${delta[key] >= 0 ? '+' : ''}${delta[key]})`,
        }),
      );
    }
  } else {
    parts.push(el('span', { class: 'muted', text: 'no previous scan to compare with yet' }));
  }
  parts.push(
    el('span', {
      class: rollup.unexplainedGaps > 0 ? 'unexplained warn' : 'unexplained',
      text: `unexplained gaps ${rollup.unexplainedGaps ?? 0}`,
    }),
  );
  return el('div', { class: 'delta-line tiny' }, [
    el('span', { class: 'muted', text: 'Since the previous scan:' }),
    ...parts,
  ]);
}

/** B1: the trust boundary, on the rollup as on the pack. */
function guaranteeBox(guarantees) {
  if (!guarantees) {
    return null;
  }
  return el('div', { class: 'guarantees' }, [
    el('div', { class: 'guarantee-col does' }, [
      el('div', { class: 'guarantee-title', text: 'What this pack guarantees' }),
      ...guarantees.does.map((line) => el('div', { class: 'tiny', text: `• ${line}` })),
    ]),
    el('div', { class: 'guarantee-col does-not' }, [
      el('div', { class: 'guarantee-title', text: 'What this pack does NOT guarantee' }),
      ...guarantees.doesNot.map((line) => el('div', { class: 'tiny', text: `• ${line}` })),
    ]),
  ]);
}

function rollupCard(rollup) {
  // Named apart from the `scan()` handler below on purpose: `const scan = ...`
  // used to shadow it, so the Scan button got an object instead of a listener
  // and clicking it did nothing at all.
  const lastScan = rollup.lastScan;
  const integrity = rollup.integrity;
  const delta = rollup.delta;
  return el('div', { class: 'card stack' }, [
    el('div', { class: 'spread' }, [
      el('h2', { text: 'Last scan' }),
      badge(
        integrity?.degraded ? 'PARTIAL' : lastScan ? 'PASS' : 'NOT_EVALUATED',
        integrity?.degraded ? 'degraded run' : lastScan ? 'completed' : 'not run yet',
      ),
    ]),
    lastScan
      ? el('div', { class: 'row tiny muted' }, [
          el('span', { text: `${formatWhen(lastScan.finishedAt)} · ${lastScan.trigger.toLowerCase()} · ${lastScan.durationMs ?? 0} ms` }),
          delta
            ? el('span', {
                text: `Δ verified ${delta.VERIFIED >= 0 ? '+' : ''}${delta.VERIFIED}, gaps ${delta.MISSING + delta.STALE >= 0 ? '+' : ''}${delta.MISSING + delta.STALE}`,
              })
            : null,
        ])
      : el('p', { class: 'muted', text: 'No completed scan on this installation yet. Run one to fill the rollup.' }),
    lastScan ? countBoxes(lastScan.counts) : null,
    rollup.scanPredatesBinding
      ? el('div', { class: 'banner' }, [
          document.createTextNode(
            `This scan finished before the programme was bound to ${rollup.binding?.projectKey ?? 'this project'}: its counts judged a different project. Run a scan to roll up this one. Exceptions recorded before the binding stay on record — withdraw any that no longer apply. `,
          ),
        ])
      : null,
    // How the run read the graph — its identity, hops and any cap — straight from
    // the scan record, so an unattended run can be checked on screen.
    lastScan?.notes
      ? el('div', { class: 'tiny muted', dataset: { testid: 'read-identity' }, text: lastScan.notes })
      : null,
    deltaSummary(rollup),
    integrity
      ? el('div', { class: 'row tiny muted' }, [
          el('span', { text: `${integrity.retriedCalls ?? 0} retried read(s)` }),
          el('span', { text: `${integrity.incomplete ?? 0} claim(s) not checked` }),
          el('span', { text: `${integrity.notVisible ?? 0} out of view` }),
          Object.entries(integrity.causes ?? {}).length > 0
            ? el('span', { text: `causes: ${Object.entries(integrity.causes).map(([key, value]) => `${key}×${value}`).join(', ')}` })
            : null,
        ])
      : null,
    el('div', { class: 'row' }, [
      el('button', {
        class: 'primary',
        text: state.scanning ? 'Scanning…' : 'Scan the registry',
        disabled: state.scanning,
        onclick: scan,
      }),
      el('button', {
        class: 'secondary',
        text: state.environment ? 'Re-run environment check' : 'Run environment check',
        onclick: runCheck,
      }),
    ]),
    (rollup.discovery ?? []).length > 0
      ? el('div', { class: 'banner info' }, [
          el('strong', { text: 'Discovery mode: ' }),
          document.createTextNode(rollup.discovery.join(' ')),
        ])
      : null,
  ]);
}

/**
 * Bind the programme to this site.
 *
 * A judge's site has no PAY project and no ITO space. This card is the whole
 * onboarding: pick a project (and a space for policy pages), press once, rescan.
 */
function bindCard(rollup) {
  const setup = state.setup;
  if (!setup) {
    return null;
  }
  const binding = setup.binding;
  const projects = setup.projects ?? [];
  const spaces = setup.spaces ?? [];
  const projectValue = state.projectKey ?? binding?.projectKey ?? projects[0]?.key ?? '';
  // `??`, not `||`: "no space" is a real choice with the value '', and `||`
  // silently replaced it with the first space on the next render — so pressing
  // Bind after choosing "no space" bound the personal space instead, pointing every
  // policy rule at a space the programme never named.
  // When a binding already exists, show what it actually holds (a bound programme
  // with no space shows "no space", not the first space in the picker).
  const spaceValue =
    state.spaceKey ?? (binding ? (binding.spaceKey ?? '') : (spaces[0]?.key ?? ''));

  const projectSelect = el(
    'select',
    { onchange: (event) => { state.projectKey = event.target.value; } },
    projects.map((project) => el('option', { value: project.key, text: `${project.key} — ${project.name}` })),
  );
  if (projectValue) {
    projectSelect.value = projectValue;
    state.projectKey = projectValue;
  }
  const spaceSelect = el(
    'select',
    { onchange: (event) => { state.spaceKey = event.target.value; } },
    [
      el('option', { value: '', text: '— no space (policy claims will report a setup gap) —' }),
      ...spaces.map((space) => el('option', { value: space.key, text: `${space.key} — ${space.name}` })),
    ],
  );
  spaceSelect.value = spaceValue;
  state.spaceKey = spaceValue;

  return el('div', { class: 'card stack' }, [
    el('div', { class: 'spread' }, [
      el('h2', { text: 'Where this programme runs' }),
      badge(
        binding ? 'PASS' : 'NOT_EVALUATED',
        binding ? `bound to ${binding.projectKey}${binding.spaceKey ? ` / ${binding.spaceKey}` : ''}` : 'not bound',
      ),
    ]),
    el('p', {
      class: 'tiny muted',
      text:
        'The twelve controls are shipped with the app. Binding points them at one of this site’s projects (the work items judged) and one space (where policy pages are looked for). Nothing leaves Atlassian and no new permission is needed.',
    }),
    setup.projectsError
      ? el('div', { class: 'banner', text: `Project list unavailable: ${setup.projectsError}` })
      : projects.length === 0
        ? el('div', { class: 'banner', text: 'No project is readable with read:jira-work on this site.' })
        : el('div', { class: 'setup-grid' }, [
            el('span', { class: 'tiny muted', text: 'Project' }),
            projectSelect,
            el('span', { class: 'tiny muted', text: 'Policy space' }),
            spaceSelect,
          ]),
    setup.spacesError
      ? el('div', { class: 'tiny muted', text: `Space list: ${setup.spacesError}` })
      : null,
    el('div', { class: 'row' }, [
      el('button', {
        class: 'primary',
        text: state.binding ? 'Binding…' : 'Bind the programme',
        disabled: state.binding || projects.length === 0,
        onclick: bind,
      }),
      binding
        ? el('span', {
            class: 'tiny muted',
            text: `bound ${formatWhen(binding.boundAt)}${binding.boundBy ? ` by ${binding.boundBy}` : ''}`,
          })
        : null,
    ]),
    state.notice ? el('div', { class: 'tiny muted', text: state.notice }) : null,
    // v6.35: one click from an empty site to a judged one.
    el('div', { class: 'row' }, [
      el('button', {
        class: 'secondary tiny',
        text: state.onboarding ? 'Setting up…' : 'Judge it on your site — create 3 sample changes',
        disabled: state.onboarding || projects.length === 0,
        onclick: onboard,
      }),
      el('span', {
        class: 'tiny muted',
        text: 'Binds the programme, creates three completed sample changes labelled ctrl-ac-10 and runs the first scan.',
      }),
    ]),
    state.onboardResult ? onboardResult(state.onboardResult) : null,
    el('p', {
      class: 'tiny muted',
      text: `The shipped programme has ${setup.programme?.controls ?? 0} controls; the first three are ${(setup.programme?.names ?? [])
        .slice(0, 3)
        .map((entry) => entry.code)
        .join(', ')}.`,
    }),
  ]);
}

/**
 * What the one-click onboarding did, in the order a person checks it.
 *
 * The counts are the scan's own, so the first screen on a brand-new site is an
 * answer instead of an empty rollup. Nothing is described as verified that the scan
 * did not measure.
 */
function onboardResult(result) {
  const counts = result.scan?.counts;
  return el('div', { class: 'card stack' }, [
    el('div', { class: 'spread' }, [
      el('h2', { text: 'Your site, judged' }),
      badge(result.scan ? 'PASS' : 'PARTIAL', result.scan ? 'first scan done' : 'no scan yet'),
    ]),
    result.created.length > 0
      ? el('ul', { class: 'tight' }, result.created.map((entry) =>
          el('li', { class: 'tiny' }, [
            el('strong', { text: entry.key }),
            ` — ${entry.status ?? 'created'}${entry.done ? ' (completed)' : ''}`,
            entry.note && entry.note !== 'completed' ? ` · ${entry.note}` : '',
          ]),
        ))
      : null,
    counts
      ? el('div', { class: 'row tiny' }, [
          el('span', { text: `${counts.VERIFIED} verified` }),
          el('span', { text: `${counts.STALE} stale` }),
          el('span', { text: `${counts.MISSING} missing` }),
          el('span', { text: `${counts.NOT_VISIBLE} not visible` }),
          el('span', { text: `${counts.INCOMPLETE} not checked` }),
          el('span', { text: `${result.scan.durationMs} ms` }),
        ])
      : null,
    el('p', {
      class: 'tiny muted',
      text:
        'Open any sample change to see its Evidence panel. Two claims need a person, not a button: an approval comment from a second account, and a policy page in a Confluence space (create one and bind that space).',
    }),
    result.skipped.length > 0
      ? el('div', { class: 'tiny muted', text: result.skipped.join(' · ') })
      : null,
  ]);
}

/**
 * The audit pack: the last scan as a workpaper.
 *
 * As-of is the scan's finish time, not the time this page was opened, and the
 * fingerprint is computed from the claim rows so a reviewer can prove the table
 * they were handed is the table the app produced.
 */
function auditCard(rollup) {
  const audit = rollup.audit;
  if (!audit) {
    return null;
  }
  const gaps = audit.claims.filter((claim) => claim.state === 'MISSING' || claim.state === 'STALE');
  return el('div', { class: 'card stack' }, [
    el('div', { class: 'spread' }, [
      el('h2', { text: 'Audit pack' }),
      el('span', { class: 'pack-meta', text: `as of ${audit.asOf ?? 'no completed scan'}` }),
    ]),
    el('div', { class: 'row tiny muted' }, [
      el('span', { class: 'fingerprint', text: `fingerprint ${audit.fingerprint}` }),
      el('span', { text: `${audit.claims.length} claim row(s)` }),
      el('span', { text: audit.fingerprintBasis }),
    ]),
    el('p', {
      class: 'tiny muted',
      text:
        'The same scan rebuilds the same fingerprint, so “the table has not changed since submission” is something a reviewer can check. The paper is prepared by the app and signed by a person.',
    }),
    guaranteeBox(audit.guarantees ?? rollup.guarantees),
    el('div', { class: 'row tiny' }, [
      el('strong', { text: `Unexplained gaps: ${audit.unexplainedGaps ?? 0}` }),
      el('span', {
        class: 'muted',
        text:
          (audit.explainedGaps ?? 0) > 0
            ? `· ${audit.explainedGaps} gap(s) carry a recorded exception`
            : '· no gap carries a recorded exception',
      }),
    ]),
    gaps.length > 0
      ? el('table', { class: 'grid pack' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Control' }),
              el('th', { text: 'Claim' }),
              el('th', { text: 'State' }),
              el('th', { text: 'Evidence' }),
              el('th', { text: 'Remediation' }),
            ]),
          ]),
          el('tbody', {}, gaps.slice(0, 8).map((claim) =>
            el('tr', {}, [
              el('td', { class: 'mono', text: claim.controlCode }),
              el('td', { text: claim.claim }),
              el('td', { class: 'state' }, [chip(claim.state)]),
              el('td', { class: 'evidence' }, [
                claim.evidenceUrl
                  ? el('a', { href: claim.evidenceUrl, target: '_blank', rel: 'noopener', text: claim.evidenceLabel ?? claim.evidenceAri })
                  : el('span', { class: 'muted', text: claim.evidenceLabel ?? 'no evidence object' }),
                el('div', { class: 'tiny muted', text: claim.observedAt ? `observed ${formatWhen(claim.observedAt)}` : 'never observed' }),
              ]),
              el('td', { class: 'mono' }, [
                el('div', { text: claim.remediation?.issueKey ?? '—' }),
                claim.exception
                  ? el('div', {
                      class: `tiny ${claim.exception.active ? 'warn' : 'muted'}`,
                      text: `exception ${claim.exception.active ? 'until' : 'EXPIRED'} ${claim.exception.expiresAt}`,
                    })
                  : null,
              ]),
            ]),
          )),
        ])
      : el('p', { class: 'muted', text: 'No missing or stale claim in the last scan — nothing to remediate.' }),
    el('div', { class: 'pack-actions' }, [
      copyButton('Copy the audit memo', async () => {
        const memo = await invokeWarm('auditMemo', {});
        return memo?.memo ?? 'No memo was produced.';
      }),
      // B2: recompute the filed fingerprint and show the verdict.
      el('button', {
        class: 'secondary tiny',
        text: state.verifying ? 'Verifying…' : 'Verify fingerprint',
        disabled: state.verifying,
        onclick: verifyFingerprint,
      }),
      state.verification
        ? el('span', {
            class: `chip ${state.verification.verified ? 'VERIFIED' : 'MISSING'}`,
            text: state.verification.status,
          })
        : null,
      state.verification
        ? el('span', { class: 'tiny muted', text: `recomputed ${state.verification.computed}` })
        : null,
      el('span', { class: 'tiny muted', text: 'Deterministic text — the same rows, the same words.' }),
    ]),
  ]);
}

/**
 * B3: gaps, exceptions, and the number nobody can account for.
 *
 * The state is never edited by an exception: what changes is whether the gap is
 * explained. Recording one needs a reason, an expiry and (optionally) the
 * compensating control that covers the period — the three things an auditor asks
 * for when a control is not met on purpose.
 */
function exceptionsCard(rollup) {
  const gaps = rollup.gaps ?? [];
  if (gaps.length === 0) {
    return null;
  }
  const unexplained = gaps.filter((gap) => !(gap.exception && gap.exception.active)).length;
  const rows = gaps.map((gap) => {
    const form = state.exceptionFor === gap.claimKey ? exceptionForm(gap) : null;
    return el('div', { class: 'claim' }, [
      el('div', { class: 'claim-head' }, [
        el('div', { class: 'row' }, [
          chip(gap.state),
          el('strong', { text: `${gap.controlCode} · ${CLAIM_LABEL[gap.evidenceType] ?? gap.claim ?? gap.evidenceType}` }),
        ]),
        el('div', { class: 'row' }, [
          gap.exception && gap.exception.active
            ? el('span', {
                class: 'chip VERIFIED',
                text: 'explained',
                title: `${gap.exception.reason} — until ${gap.exception.expiresAt}`,
              })
            : el('span', { class: 'chip MISSING', text: gap.exception ? 'exception expired' : 'unexplained' }),
          el('button', {
            class: 'secondary tiny',
            text: state.exceptionFor === gap.claimKey ? 'Close' : gap.exception ? 'Change the exception' : 'Record an exception',
            onclick: () => {
              state.exceptionFor = state.exceptionFor === gap.claimKey ? null : gap.claimKey;
              state.exceptionNotice = null;
              render();
            },
          }),
          gap.exception && gap.exception.active
            ? el('button', {
                class: 'secondary tiny',
                text: 'Withdraw',
                onclick: async () => {
                  await invokeWarm('withdrawException', { controlCode: gap.controlCode, evidenceType: gap.evidenceType });
                  await load();
                },
              })
            : null,
        ]),
      ]),
      el('p', { class: 'reason', text: gap.reason }),
      gap.exception
        ? el('p', { class: 'tiny muted' }, [
            `${gap.exception.active ? 'Exception until' : 'Exception expired'} ${gap.exception.expiresAt}: ${gap.exception.reason}`,
            gap.exception.compensatingControl ? ` · compensating: ${gap.exception.compensatingControl}` : '',
          ])
        : null,
      form,
    ]);
  });
  return el('div', { class: 'card stack' }, [
    el('div', { class: 'spread' }, [
      el('h2', { text: 'Unexplained gaps' }),
      badge(unexplained === 0 ? 'PASS' : 'GAPS', `Unexplained gaps: ${unexplained} of ${gaps.length}`),
    ]),
    el('p', {
      class: 'tiny muted',
      text:
        'A gap with a reason, an owner and an expiry on record is explained and disclosed on the pack. Everything else is unexplained — the number a closing meeting asks about. Recording an exception never changes the verdict.',
    }),
    state.exceptionNotice ? el('div', { class: 'banner info', text: state.exceptionNotice }) : null,
    ...rows,
  ]);
}

function exceptionForm(gap) {
  const reason = el('input', { type: 'text', placeholder: 'Why is this gap carried? (required)' });
  // A plain text field, validated as yyyy-mm-dd on both sides: a native date input
  // reads keystrokes as segments, so a typed date lands scrambled in some locales.
  const expires = el('input', { type: 'text', placeholder: 'Expiry date (yyyy-mm-dd)', inputmode: 'numeric' });
  const compensating = el('input', { type: 'text', placeholder: 'Compensating control (optional)' });
  return el('div', { class: 'exception-form' }, [
    reason,
    expires,
    compensating,
    el('div', { class: 'row' }, [
      el('button', {
        class: 'primary tiny',
        text: 'Record',
        onclick: async () => {
          if (!reason.value.trim()) {
            state.exceptionNotice = 'An exception needs a reason — without one the gap stays unexplained.';
            render();
            return;
          }
          if (!expires.value) {
            state.exceptionNotice = 'An exception needs an expiry date.';
            render();
            return;
          }
          const result = await invokeWarm('recordException', {
            controlCode: gap.controlCode,
            evidenceType: gap.evidenceType,
            reason: reason.value,
            expiresAt: expires.value,
            compensatingControl: compensating.value || undefined,
          });
          state.exceptionNotice = result?.recorded
            ? `Exception recorded for ${gap.controlCode} until ${result.expiresAt}.`
            : result?.why ?? 'The exception was not recorded.';
          state.exceptionFor = null;
          await load();
        },
      }),
    ]),
  ]);
}

/**
 * C5: the reverse scan — pages in the programme's spaces that no control names.
 *
 * This is the direction a spreadsheet never looks: not "what is missing for this
 * control" but "what exists that nobody asserted". It reads Confluence REST and the
 * registry, and it says so on the card (mode rest+registry) rather than implying a
 * graph traversal it does not make.
 */
function orphanCard(rollup) {
  const orphans = rollup.orphans;
  if (!orphans) {
    return null;
  }
  const list = orphans.orphans ?? [];
  return el('div', { class: 'card stack' }, [
    el('div', { class: 'spread' }, [
      el('h2', { text: 'Unclaimed evidence' }),
      badge(list.length === 0 ? 'PASS' : 'GAPS', `${list.length} page(s) no control claims`),
    ]),
    el('p', {
      class: 'tiny muted',
      text:
        `Read ${orphans.pagesSeen} page(s) in ${(orphans.spaces ?? []).join(', ') || 'no space'}; ${orphans.claimed} are named by a control's rule or a registered link. ` +
        'Either an obligation that is not in the programme, or a document nobody uses — both are findings.',
    }),
    orphans.truncated
      ? el('div', { class: 'banner', text: 'The reverse scan hit its read window: only the first pages were judged.' })
      : null,
    orphans.error ? el('div', { class: 'banner', text: orphans.error }) : null,
    ...(orphans.notes ?? []).map((note) => el('div', { class: 'tiny muted', text: note })),
    list.length === 0
      ? null
      : el('ul', { class: 'tight' }, list.slice(0, 10).map((page) =>
          el('li', { class: 'tiny' }, [
            el('strong', { text: page.title }),
            ` · ${page.spaceKey}`,
            el('div', { class: 'tiny muted', text: `last updated ${formatWhen(page.lastUpdatedAt)}` }),
          ]),
        )),
  ]);
}

async function verifyFingerprint() {
  state.verifying = true;
  render();
  try {
    const audit = state.rollup?.audit;
    state.verification = await invokeWarm('verifyFingerprint', {
      fingerprint: audit?.fingerprint,
      scanId: audit?.scanId ?? undefined,
    });
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    state.verifying = false;
    render();
  }
}

function gapsCard(rollup) {
  if (!rollup.gaps || rollup.gaps.length === 0) {
    return el('div', { class: 'card' }, [
      el('h2', { text: 'Open gaps' }),
      el('p', { class: 'muted', text: 'No missing or stale claim in the last scan.' }),
    ]);
  }
  return el('div', { class: 'card stack' }, [
    el('h2', { text: 'Open gaps' }),
    el('table', { class: 'grid' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Control' }),
          el('th', { text: 'State' }),
          el('th', { text: 'Why' }),
          el('th', { text: 'Issue' }),
        ]),
      ]),
      el('tbody', {}, rollup.gaps.map((gap) =>
        el('tr', {}, [
          el('td', { class: 'mono', text: gap.controlCode }),
          el('td', {}, [chip(gap.state)]),
          el('td', { class: 'tiny', text: gap.reason }),
          el('td', { class: 'mono', text: gap.remediation ?? '—' }),
        ]),
      )),
    ]),
  ]);
}

function controlsCard(rollup) {
  return el('div', { class: 'card stack' }, [
    el('h2', { text: 'Controls' }),
    el('table', { class: 'grid' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Code' }),
          el('th', { text: 'Control' }),
          el('th', { text: 'State' }),
          el('th', { text: 'Gaps' }),
          el('th', { text: 'Unchecked' }),
        ]),
      ]),
      el('tbody', {}, (rollup.controls ?? []).map((control) =>
        el('tr', {}, [
          el('td', { class: 'mono', text: control.code }),
          el('td', {}, [
            el('div', { text: control.name }),
            el('div', { class: 'tiny muted', text: `${control.regulationRef} · ${control.cadence}` }),
          ]),
          el('td', {}, [control.state === 'UNKNOWN' ? el('span', { class: 'muted tiny', text: 'not scanned' }) : chip(control.state)]),
          el('td', { text: String(control.openGaps) }),
          el('td', { text: String(control.incomplete) }),
        ]),
      )),
    ]),
  ]);
}

/**
 * Custom controls: a programme that is not only the twelve shipped with the app.
 *
 * Two ways in, both of them small: a form for one control (code, name, evidence type,
 * freshness window, everyItem) and a JSON paste for a list of them. Both go through the
 * same resolver, so both are validated the same way and both say exactly which row was
 * refused and why. The site administrator check happens on the server: this card never
 * pretends to know who may write.
 */
function customControlsCard(rollup) {
  const existing = rollup.customControls ?? [];
  const text = (label, attrs) =>
    el('label', { class: 'field' }, [el('span', { class: 'tiny muted', text: label }), el('input', attrs)]);

  const form = el('div', { class: 'custom-form' }, [
    text('Control code', {
      type: 'text',
      placeholder: 'AC-13',
      value: state.customCode,
      oninput: (event) => {
        state.customCode = event.target.value;
      },
      dataset: { testid: 'custom-code' },
    }),
    text('Name (the sentence the claim reads)', {
      type: 'text',
      placeholder: 'Every release has a retention decision on record',
      value: state.customName,
      oninput: (event) => {
        state.customName = event.target.value;
      },
      dataset: { testid: 'custom-name' },
    }),
    el('label', { class: 'field' }, [
      el('span', { class: 'tiny muted', text: 'Evidence type' }),
      el(
        'select',
        {
          onchange: (event) => {
            state.customType = event.target.value;
          },
          dataset: { testid: 'custom-type' },
        },
        CUSTOM_EVIDENCE.map(([value, label]) =>
          el('option', { value, text: label, selected: value === state.customType }),
        ),
      ),
    ]),
    text('Freshness window (days)', {
      type: 'text',
      inputmode: 'numeric',
      placeholder: '90',
      value: state.customDays,
      oninput: (event) => {
        state.customDays = event.target.value;
      },
      dataset: { testid: 'custom-days' },
    }),
    text('Jira label (optional)', {
      type: 'text',
      placeholder: 'ctrl-ac-13',
      value: state.customLabel,
      oninput: (event) => {
        state.customLabel = event.target.value;
      },
      dataset: { testid: 'custom-label' },
    }),
    el('label', { class: 'field check' }, [
      el('input', {
        type: 'checkbox',
        checked: state.customEvery,
        onchange: (event) => {
          state.customEvery = event.target.checked;
        },
        dataset: { testid: 'custom-every' },
      }),
      el('span', {
        class: 'tiny',
        text: 'Every item must qualify (a universal claim), not just one',
      }),
    ]),
    el('div', { class: 'row' }, [
      el('button', {
        class: 'primary tiny',
        text: state.customBusy ? 'Saving…' : 'Add the control',
        disabled: state.customBusy,
        onclick: addCustomControl,
      }),
      el('span', {
        class: 'tiny muted',
        text: `Saved to ${state.projectKey ?? rollup.binding?.projectKey ?? 'the bound project'}. Adding a control needs ADMINISTER on this site.`,
      }),
    ]),
  ]);

  const importer = el('div', { class: 'custom-import' }, [
    el('label', { class: 'field' }, [
      el('span', {
        class: 'tiny muted',
        text: 'JSON import: an array of controls, or an object with a "controls" array',
      }),
      el('textarea', {
        rows: '4',
        placeholder:
          '[{"code":"AC-14","name":"Quarterly retention decision","evidenceType":"jira_work_item","maxAgeDays":90,"everyItem":true}]',
        value: state.customJson,
        oninput: (event) => {
          state.customJson = event.target.value;
        },
        dataset: { testid: 'custom-json' },
      }),
    ]),
    el('div', { class: 'row' }, [
      el('button', {
        class: 'secondary tiny',
        text: 'Import JSON',
        disabled: state.customBusy,
        onclick: importControls,
      }),
      el('span', { class: 'tiny muted', text: 'Each row is validated on its own; a refused row says why.' }),
    ]),
  ]);

  return el('div', { class: 'card stack' }, [
    el('div', { class: 'spread' }, [
      el('h2', { text: 'Custom controls' }),
      badge(existing.length > 0 ? 'PASS' : 'NOT_EVALUATED', `${existing.length} added to the programme`),
    ]),
    el('p', {
      class: 'tiny muted',
      text:
        'The twelve shipped controls answer DORA and SOX change management. A control of your own is added here and judged by the same engine, with the same five states and the same row on the pack. Nothing is added silently: the code, the label and the window are validated, and a value that would change a query is refused.',
    }),
    form,
    importer,
    state.customNotice ? el('div', { class: 'banner info', dataset: { testid: 'custom-notice' }, text: state.customNotice }) : null,
    existing.length === 0
      ? el('p', { class: 'muted tiny', text: 'No custom control on this site yet. The programme is the twelve shipped controls.' })
      : el('table', { class: 'grid' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Code' }),
              el('th', { text: 'Control' }),
              el('th', { text: 'Claims' }),
              el('th', { text: 'Project' }),
            ]),
          ]),
          el('tbody', {}, existing.map((control) =>
            el('tr', { dataset: { customControl: control.code } }, [
              el('td', { class: 'mono', text: control.code }),
              el('td', {}, [
                el('div', { text: control.name }),
                el('div', { class: 'tiny muted', text: `${control.jiraLabel}${control.regulationRef ? ` · ${control.regulationRef}` : ''}` }),
              ]),
              el('td', { class: 'tiny' }, (control.claims ?? []).map((claim) =>
                el('div', {
                  text: `${CLAIM_LABEL[claim.evidenceType] ?? claim.evidenceType}: within ${claim.maxAgeDays} d${claim.everyItem ? ' · every item' : ''}`,
                }),
              )),
              el('td', { class: 'mono', text: control.jiraProjectKey }),
            ]),
          )),
        ]),
  ]);
}

async function addCustomControl() {
  state.customBusy = true;
  state.customNotice = null;
  render();
  try {
    const result = await invokeWarm('upsertControl', {
      code: state.customCode,
      name: state.customName,
      jiraLabel: state.customLabel || undefined,
      evidenceType: state.customType,
      maxAgeDays: state.customDays,
      everyItem: state.customEvery,
      projectKey: state.projectKey || undefined,
    });
    if (result?.saved) {
      state.customNotice =
        `${result.code} ${result.created ? 'added' : 'updated'}: ${CLAIM_LABEL[result.evidenceType] ?? result.evidenceType}, ` +
        `within ${result.maxAgeDays} day(s)${result.everyItem ? ', every item' : ''}. Run a scan to judge it.`;
      state.customCode = '';
      state.customName = '';
      state.customLabel = '';
    } else {
      // The refusal is the server's sentence, which names what to fix. It is shown as
      // written rather than re-worded here.
      state.customNotice = result?.why ?? 'The control was not saved.';
    }
    await load();
  } catch (cause) {
    state.customNotice = cause instanceof Error ? cause.message : String(cause);
  } finally {
    state.customBusy = false;
    render();
  }
}

async function importControls() {
  state.customBusy = true;
  state.customNotice = null;
  render();
  try {
    const result = await invokeWarm('importControls', { json: state.customJson });
    if (result?.why) {
      state.customNotice = result.why;
    } else {
      const refused = (result?.results ?? []).filter((row) => !row.saved);
      state.customNotice =
        `Imported ${result?.imported ?? 0} control(s)` +
        (refused.length > 0
          ? `; refused ${refused.length}: ${refused.map((row) => `${row.code ?? '(no code)'} — ${row.why}`).join(' | ')}`
          : '.');
      if ((result?.imported ?? 0) > 0) {
        state.customJson = '';
      }
    }
    await load();
  } catch (cause) {
    state.customNotice = cause instanceof Error ? cause.message : String(cause);
  } finally {
    state.customBusy = false;
    render();
  }
}

function render() {
  clear(root);
  if (state.loading) {
    root.append(el('div', { class: 'card' }, [el('p', { class: 'muted', text: 'Loading the rollup…' })]));
    return;
  }
  if (state.error) {
    root.append(el('div', { class: 'card' }, [el('div', { class: 'banner', text: state.error })]));
  }
  const rollup = state.rollup;
  if (!rollup) {
    return;
  }
  root.append(
    el('div', { class: 'stack' }, [
      el('div', { class: 'spread' }, [
        el('div', {}, [
          el('h1', { text: 'AssureLoop control room' }),
          el('p', { class: 'muted', text: 'Rollup, drift and what this site can see. Open any work item for its evidence gate.' }),
        ]),
        badge(
          rollup.binding ? 'PASS' : 'NOT_EVALUATED',
          rollup.binding ? `bound · ${rollup.binding.projectKey}` : 'programme not bound',
        ),
      ]),
      bindCard(rollup),
      rollupCard(rollup),
      rollup.environment ? renderEnvironment(rollup.environment, { onRerun: runCheck }) : null,
      state.environment ? renderEnvironment(state.environment, { onRerun: runCheck }) : null,
      auditCard(rollup),
      exceptionsCard(rollup),
      orphanCard(rollup),
      gapsCard(rollup),
      controlsCard(rollup),
      customControlsCard(rollup),
    ]),
  );
}

async function bind() {
  state.binding = true;
  state.notice = 'Binding…';
  render();
  try {
    const result = await invokeWarm('bindProgramme', {
      projectKey: state.projectKey,
      spaceKey: state.spaceKey || undefined,
    });
    state.notice = result?.bound
      ? `Bound ${result.controls} controls to ${result.projectKey}${result.spaceKey ? ` / ${result.spaceKey}` : ''}. Now run a scan.`
      : `Not bound: ${result?.why ?? 'unknown reason'}`;
    await load();
  } catch (cause) {
    state.notice = cause instanceof Error ? cause.message : String(cause);
  } finally {
    state.binding = false;
    render();
  }
}

async function onboard() {
  state.onboarding = true;
  state.onboardResult = null;
  render();
  try {
    state.onboardResult = await invokeWarm('onboardSite', {
      projectKey: state.projectKey,
      spaceKey: state.spaceKey || undefined,
    });
    state.notice = state.onboardResult?.bound
      ? `Bound to ${state.onboardResult.projectKey} and created ${state.onboardResult.created.length} sample change(s).`
      : (state.onboardResult?.why ?? 'The site was not set up.');
    await load();
  } catch (cause) {
    state.notice = cause instanceof Error ? cause.message : String(cause);
  } finally {
    state.onboarding = false;
    render();
  }
}

async function scan() {
  state.scanning = true;
  render();
  try {
    await invokeWarm('scanNow', {});
    await load();
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    state.scanning = false;
    render();
  }
}

async function runCheck() {
  state.environment = await invokeWarm('environmentCheck', {});
  render();
}

async function load() {
  state.loading = true;
  render();
  try {
    const [rollup, setup] = await Promise.all([
      invokeWarm('controlRoom', {}),
      invokeWarm('siteSetup', {}),
    ]);
    state.rollup = rollup;
    state.setup = setup;
    state.error = null;
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    state.loading = false;
    render();
  }
  runCheck().catch(() => undefined);
}

/**
 * Keep the app awake while this page is open.
 *
 * A Forge container that has been idle scales down; the first invoke after that is
 * exactly the one that comes back "Failed to fetch" (measured twice on Verify
 * fingerprint while the page sat open). One cheap ping when the page opens, and the
 * invokes that matter retry once after a short wait, is what turns a cold start
 * into a second of waiting instead of a broken button.
 */
async function prewarm() {
  try {
    const result = await invokeWarm('ping', {}, { attempts: 2, delayMs: 800 });
    state.warm = result;
  } catch (cause) {
    state.warm = { ok: false, why: cause instanceof Error ? cause.message : String(cause) };
  }
  render();
}

load();
prewarm();
