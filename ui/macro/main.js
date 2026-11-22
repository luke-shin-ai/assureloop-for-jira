/**
 * Audit pack — the Confluence macro.
 *
 * A control owner drops this on a page and the pack renders from the last scan:
 * every claim with its evidence link, the date it was observed, its state, and the
 * remediation issue if one was raised. As-of is the scan time and the fingerprint
 * is SHA-256 over the rows, so this page is a workpaper rather than a live view.
 *
 * Read-only apart from one explicit button: this installation's scan. Forge SQL is
 * per product, so the Confluence installation has its own scan history — pressing
 * "Scan now" is what fills it (G0 §9-4).
 */

import { chip, clear, copyButton, el, formatWhen, invoke, invokeWarm, stateLabel } from '../shared/ui.js';

const root = document.getElementById('app');
const state = { pack: null, loading: true, scanning: false, verifying: false, verification: null, error: null, notice: null };

/** The site this macro is rendered on, for absolute evidence links. */
function siteFromReferrer() {
  try {
    const url = new URL(document.referrer);
    return url.origin;
  } catch {
    return null;
  }
}

function header(pack) {
  const counts = pack.counts ?? {};
  return el('div', { class: 'stack', style: 'gap:4px' }, [
    el('div', { class: 'spread' }, [
      el('h1', { text: 'AssureLoop audit pack' }),
      el('span', { class: 'pack-meta', text: `as of ${pack.asOf ?? 'no completed scan'}` }),
    ]),
    el('div', { class: 'row tiny muted' }, [
      el('span', { class: 'fingerprint', text: `fingerprint ${pack.fingerprint}` }),
      el('span', { text: pack.scanId ? `scan ${pack.scanId.slice(0, 8)}` : 'no scan' }),
      el('span', { text: pack.trigger ? `trigger ${pack.trigger.toLowerCase()}` : '' }),
      el('span', {
        text: `${pack.claims.length} claim(s): ${counts.VERIFIED ?? 0} verified · ${counts.STALE ?? 0} stale · ${counts.MISSING ?? 0} missing · ${counts.NOT_VISIBLE ?? 0} not visible · ${counts.INCOMPLETE ?? 0} not checked`,
      }),
    ]),
    // B4: the before/after line. A workpaper that only shows today cannot answer
    // "is this getting better?", which is the first question about a control.
    deltaLine(pack),
    // B3: the number a closing meeting asks about.
    el('div', { class: 'row tiny' }, [
      el('strong', { text: `Unexplained gaps: ${pack.unexplainedGaps ?? 0}` }),
      el('span', {
        class: 'muted',
        text:
          (pack.explainedGaps ?? 0) > 0
            ? `· ${pack.explainedGaps} further gap(s) carry a recorded exception (disclosed per row)`
            : '· no gap on this pack carries a recorded exception',
      }),
    ]),
  ]);
}

function deltaLine(pack) {
  const delta = pack.delta;
  const counts = pack.counts ?? {};
  if (!delta) {
    return el('div', { class: 'tiny muted', text: 'No previous completed scan on this installation, so there is no before/after to show yet.' });
  }
  const before = {
    VERIFIED: (counts.VERIFIED ?? 0) - delta.VERIFIED,
    STALE: (counts.STALE ?? 0) - delta.STALE,
    MISSING: (counts.MISSING ?? 0) - delta.MISSING,
  };
  const arrow = (key, label) =>
    el('span', {
      text: `${label} ${before[key]} → ${counts[key] ?? 0} (${delta[key] >= 0 ? '+' : ''}${delta[key]})`,
    });
  return el('div', { class: 'row tiny' }, [
    el('span', { class: 'muted', text: 'Since the previous scan:' }),
    arrow('VERIFIED', 'verified'),
    arrow('STALE', 'stale'),
    arrow('MISSING', 'missing'),
  ]);
}

/**
 * The trust boundary, on the pack itself.
 *
 * Two columns and no prose: what this pack guarantees, and what it does not. An
 * auditor who is told the boundary reads the rest differently — and a pack that
 * hides it invites the assumption that nothing outside the app happened.
 */
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

function claimTable(pack) {
  if (pack.claims.length === 0) {
    return el('p', {
      class: 'muted',
      text: 'No completed scan on this installation yet. Press “Scan now (this installation)” to build the pack.',
    });
  }
  // Five columns, not seven: the macro renders inside a Confluence page at roughly
  // 760px, and a workpaper that scrolls sideways is not a workpaper. The window and
  // the remediation issue ride under the observed date / evidence they belong to.
  return el('table', { class: 'grid pack' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Control' }),
        el('th', { text: 'Claim' }),
        el('th', { text: 'State' }),
        el('th', { text: 'Evidence' }),
        el('th', { text: 'Observed · window' }),
      ]),
    ]),
    el('tbody', {}, pack.claims.map((claim) =>
      el('tr', {}, [
        el('td', { class: 'mono', text: claim.controlCode }),
        el('td', { class: 'claim-cell' }, [
          el('div', { text: claim.claim }),
          el('div', { class: 'tiny muted', text: claim.regulationRef }),
        ]),
        el('td', { class: 'state' }, [
          chip(claim.state),
          // The chip carries a verified row; the reason only earns space where it
          // says something a reader has to act on.
          claim.state === 'VERIFIED'
            ? null
            : el('div', { class: 'tiny muted reason', title: claim.reason, text: claim.reason ?? '' }),
          // B3: an exception is disclosed where the gap is, with its owner and expiry.
          claim.exception
            ? el('div', { class: `tiny ${claim.exception.active ? 'warn' : 'muted'}` }, [
                `exception ${claim.exception.active ? 'until' : 'EXPIRED'} ${claim.exception.expiresAt}: ${claim.exception.reason}`,
                claim.exception.compensatingControl
                  ? ` (compensating: ${claim.exception.compensatingControl})`
                  : '',
              ])
            : null,
        ]),
        el('td', { class: 'evidence' }, [
          claim.evidenceUrl
            ? el('a', { href: claim.evidenceUrl, target: '_blank', rel: 'noopener', text: claim.evidenceLabel ?? claim.evidenceAri })
            : el('span', { class: 'muted', text: claim.evidenceLabel ?? 'no evidence object' }),
          claim.remediation
            ? el('div', { class: 'tiny', text: `issue ${claim.remediation.issueKey} · due ${claim.remediation.dueDate}` })
            : null,
        ]),
        el('td', { class: 'observed' }, [
          el('div', { class: 'tiny', text: claim.observedAt ? formatWhen(claim.observedAt) : '—' }),
          el('div', { class: 'tiny muted', text: claim.maxAgeDays === null ? '' : `window ${claim.maxAgeDays}d` }),
        ]),
      ]),
    )),
  ]);
}

function render() {
  clear(root);
  if (state.loading) {
    root.append(el('div', { class: 'card' }, [el('p', { class: 'muted', text: 'Rendering the audit pack…' })]));
    return;
  }
  const pack = state.pack;
  if (!pack) {
    root.append(
      el('div', { class: 'card stack' }, [
        el('div', { class: 'banner', text: state.error ?? 'No audit pack available.' }),
        el('button', { class: 'secondary', text: 'Try again', onclick: load }),
      ]),
    );
    return;
  }
  root.append(
    el('div', { class: 'card stack' }, [
      header(pack),
      pack.notes.length > 0
        ? el('div', { class: 'banner' }, pack.notes.map((note) => el('div', { class: 'tiny', text: note })))
        : null,
      guaranteeBox(pack.guarantees),
      claimTable(pack),
      el('div', { class: 'pack-actions' }, [
        copyButton('Copy the audit memo', async () => (await invokeWarm('auditMemo', {}))?.memo ?? 'No memo was produced.'),
        // B2: the one-click check that the table has not changed since it was filed.
        el('button', {
          class: 'secondary tiny',
          text: state.verifying ? 'Verifying…' : 'Verify fingerprint',
          disabled: state.verifying,
          onclick: verify,
        }),
        state.verification
          ? el('span', {
              class: `chip ${state.verification.verified ? 'VERIFIED' : 'MISSING'}`,
              text: state.verification.status,
            })
          : null,
        state.verification
          ? el('span', {
              class: 'tiny muted',
              text: `recomputed ${state.verification.computed} over ${state.verification.claims} row(s)`,
            })
          : null,
        el('button', {
          class: 'secondary tiny',
          text: state.scanning ? 'Scanning this installation…' : 'Scan now (this installation)',
          disabled: state.scanning,
          onclick: scan,
        }),
        state.notice ? el('span', { class: 'tiny muted', text: state.notice }) : null,
      ]),
      el('p', {
        class: 'signoff',
        text:
          'Prepared by the deterministic rule engine from the Teamwork Graph and Atlassian REST at scan time. ' +
          'No model decided a state or wrote this text.  Prepared by: ____________   Reviewed by: ____________',
      }),
      el('p', {
        class: 'tiny muted',
        text:
          'States: ' +
          ['VERIFIED', 'STALE', 'MISSING', 'NOT_VISIBLE', 'INCOMPLETE']
            .map((key) => stateLabel(key))
            .join(' · ') +
          ' — “not visible” means a permission stopped the read and is not the same as “missing”.',
      }),
    ]),
  );
}

/** B2: recompute the fingerprint from the same scan and compare it with the pack. */
async function verify() {
  state.verifying = true;
  render();
  try {
    state.verification = await invokeWarm('verifyFingerprint', {
      fingerprint: state.pack?.fingerprint,
      scanId: state.pack?.scanId ?? undefined,
    });
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    state.verifying = false;
    render();
  }
}

async function scan() {  state.scanning = true;
  state.notice = null;
  render();
  try {
    await invoke('scanNow', {});
    state.notice = 'Scan finished.';
    await load({ keepNotice: true });
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    state.scanning = false;
    render();
  }
}

async function load(options = {}) {
  state.loading = true;
  if (!options.keepNotice) {
    state.notice = null;
  }
  render();
  try {
    state.pack = await invokeWarm('auditPack', { siteUrl: siteFromReferrer() });
    state.error = null;
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    state.loading = false;
    render();
  }
}

load();
