/* AssureLoop static demo: renders docs/demo/data.js. No framework, no network. */
(function () {
  'use strict';

  var DATA = window.ASSURE_DEMO;
  if (!DATA) {
    document.body.insertAdjacentHTML('afterbegin',
      '<p style="padding:16px;background:#fbe9e9;color:#a12121">data.js did not load. Open this page from the docs/demo folder with its data.js beside it.</p>');
    return;
  }

  // ------------------------------------------------------------------ helpers
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function stateChip(state) {
    return '<span class="state" data-state="' + esc(state) + '">' + esc(state.replace('_', ' ')) + '</span>';
  }

  function link(url, label) {
    if (!url) return esc(label);
    return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>';
  }

  function windowText(claim) {
    return claim.ageDays == null ? claim.maxAgeDays + ' d' : claim.ageDays + ' d / ' + claim.maxAgeDays + ' d';
  }

  // ------------------------------------------------------------------ sha-256
  // A compact implementation so "Verify fingerprint" recomputes the digest over
  // the rows on this page instead of printing a value it was handed.
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256Hex(text) {
    var bytes = new TextEncoder().encode(text);
    var bitLen = bytes.length * 8;
    var withPad = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    withPad.set(bytes);
    withPad[bytes.length] = 0x80;
    // The 64-bit big-endian bit length. Divide rather than shift: a JavaScript
    // shift count is taken modulo 32, so `len >>> 32` is `len >>> 0`.
    var remaining = bitLen;
    for (var b = 7; b >= 0; b--) {
      withPad[withPad.length - 8 + b] = remaining % 256;
      remaining = Math.floor(remaining / 256);
    }
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    for (var off = 0; off < withPad.length; off += 64) {
      for (var t = 0; t < 16; t++) {
        w[t] = (withPad[off + t * 4] << 24) | (withPad[off + t * 4 + 1] << 16) | (withPad[off + t * 4 + 2] << 8) | withPad[off + t * 4 + 3];
      }
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (hh + S1 + ch + K[t] + w[t]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    return h.map(function (n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }).join('');
  }

  // The same serialisation the generator uses: rows sorted by claimKey, then the
  // eighteen hashed fields in their declared order.
  function canonical(rows) {
    var fields = DATA.scan.fingerprintFields;
    var sorted = rows.slice().sort(function (x, y) {
      if (x.claimKey === y.claimKey) return 0;
      return x.claimKey < y.claimKey ? -1 : 1;
    });
    return JSON.stringify(sorted.map(function (row) {
      return fields.map(function (field) { return row[field] == null ? null : row[field]; });
    }));
  }

  // ------------------------------------------------------------------ render
  var claims = DATA.claims;
  var byKey = {};
  claims.forEach(function (claim) { byKey[claim.id] = claim; });

  function traceBlock(claim) {
    var hops = claim.trace.hops.map(function (hop) {
      return '' +
        '<div class="hop">' +
          '<p class="hop-from">' + esc(hop.from) + ' ' + esc(hop.label) +
            '<span>' + esc(hop.relation) + '</span></p>' +
          '<p class="hop-ari">' + esc(hop.ari) + '</p>' +
          '<p class="hop-meta"><span>observed ' + esc(hop.at) + '</span><span>read ' + esc(hop.source) + '</span></p>' +
        '</div>';
    }).join('');
    return '' +
      '<div class="trace" data-trace-for="' + esc(claim.id) + '">' +
        '<h3>Why this verdict: the read, in order</h3>' + hops +
        '<p class="trace-foot">' + esc(claim.trace.footer) + '</p>' +
      '</div>';
  }

  function claimRow(claim) {
    return '' +
      '<div class="tr" data-claim="' + esc(claim.id) + '">' +
        '<div class="control">' + esc(claim.controlCode) + '</div>' +
        '<div class="claim-text">' + esc(claim.claim) +
          '<span class="claim-key">' + esc(claim.claimKey) + '</span></div>' +
        '<div>' + stateChip(claim.state) + '</div>' +
        '<div class="evidence">' + link(claim.evidenceUrl, claim.evidenceLabel) + '</div>' +
        '<div class="time">' + esc(claim.observedAt) + '</div>' +
        '<div class="window">' + esc(windowText(claim)) + '</div>' +
        '<div class="why-cell"><button class="link-button" type="button" data-why="' + esc(claim.id) + '" aria-expanded="false">Why?</button></div>' +
        '<p class="reason">' + esc(claim.reason) + '</p>' +
      '</div>';
  }

  var claimsTable = document.querySelector('[data-claims-table]');
  claimsTable.innerHTML =
    '<div class="tr head">' +
      '<div>Control</div><div>Claim</div><div>State</div><div>Evidence</div>' +
      '<div>Observed</div><div>Window</div><div></div>' +
    '</div>' + claims.map(claimRow).join('');

  // Counters
  var names = { VERIFIED: 'verified', STALE: 'stale', MISSING: 'missing', NOT_VISIBLE: 'not visible', INCOMPLETE: 'not checked' };
  document.querySelector('[data-counters]').innerHTML = Object.keys(names).map(function (state) {
    return '<div class="counter" data-state="' + state + '">' +
      '<span class="counter-value">' + esc(DATA.counts[state]) + '</span>' +
      '<span class="counter-label">' + esc(names[state]) + '</span></div>';
  }).join('');

  var meta = document.querySelector('[data-scan-meta]');
  meta.textContent = DATA.scan.at + ', ' + DATA.scan.trigger + ', ' +
    DATA.scan.durationMs.toLocaleString('en-US') + ' ms, graph ' + DATA.scan.graphReads + ' read(s), full registry';

  document.querySelector('[data-site]').textContent = DATA.scan.site;
  document.querySelector('[data-project]').textContent = DATA.scan.project + ' (Northwind Pay)';
  document.querySelector('[data-space]').textContent = DATA.scan.space + ' (IT Operations)';

  // Evidence panel: the four claims of AC-01, the item the panel is opened on.
  var panel = document.querySelector('[data-evidence-panel]');
  panel.innerHTML = claims.filter(function (claim) { return claim.controlCode === 'AC-01'; }).map(function (claim) {
    return '' +
      '<article class="claim-card" data-claim="' + esc(claim.id) + '">' +
        '<header><h2>' + esc(claim.claim) + '</h2>' + stateChip(claim.state) + '</header>' +
        '<p class="claim-line">' + esc(claim.reason) + '</p>' +
        '<p class="meta"><span>' + esc(claim.evidenceKind) + ': ' + link(claim.evidenceUrl, claim.evidenceLabel) + '</span>' +
          '<span>observed ' + esc(claim.observedAt) + '</span>' +
          '<span>window ' + esc(claim.maxAgeDays) + ' d</span>' +
          '<span>owner ' + esc(claim.owner) + '</span></p>' +
        '<button class="link-button" type="button" data-why="' + esc(claim.id) + '" aria-expanded="false">Why?</button>' +
      '</article>';
  }).join('');

  // Pack table
  var packTable = document.querySelector('[data-pack-table]');
  packTable.innerHTML =
    '<div class="tr head">' +
      '<div>Control</div><div>Claim</div><div>State</div><div>Evidence</div>' +
      '<div>Observed</div><div>Window</div><div>Remediation</div>' +
    '</div>' + claims.map(function (claim) {
      var remediation = claim.remediation
        ? esc(claim.remediation.issueKey) + ' due ' + esc(claim.remediation.dueDate)
        : 'none';
      return '' +
        '<div class="tr" data-pack-claim="' + esc(claim.id) + '">' +
          '<div class="control">' + esc(claim.controlCode) + '</div>' +
          '<div class="claim-text">' + esc(claim.claim) + '</div>' +
          '<div>' + stateChip(claim.state) + '</div>' +
          '<div class="evidence">' + link(claim.evidenceUrl, claim.evidenceLabel) + '</div>' +
          '<div class="time">' + esc(claim.observedAt) + '</div>' +
          '<div class="window">' + esc(windowText(claim)) + '</div>' +
          '<div class="time">' + remediation + '</div>' +
        '</div>';
    }).join('');

  document.querySelector('[data-pack-meta]').textContent = 'as of ' + DATA.scan.asOf;
  document.querySelector('[data-fingerprint]').textContent =
    'Fingerprint ' + DATA.scan.fingerprint + ', SHA-256, 128 bits shown, ' +
    claims.length + ' claim rows, ' + DATA.scan.hashedFields + ' hashed fields';

  // Boundary lists, in both places they appear.
  document.querySelectorAll('[data-guarantees]').forEach(function (list) {
    list.innerHTML = DATA.guarantees.map(function (line) { return '<li>' + esc(line) + '</li>'; }).join('');
  });
  document.querySelectorAll('[data-not-guaranteed]').forEach(function (list) {
    list.innerHTML = DATA.notGuaranteed.map(function (line) { return '<li>' + esc(line) + '</li>'; }).join('');
  });

  // ------------------------------------------------------------------ actions
  document.querySelectorAll('[data-expand]').forEach(function (button) {
    button.addEventListener('click', function () {
      var section = button.closest('[data-boundary]');
      var full = section.querySelector('[data-boundary-full]');
      var open = full.hasAttribute('hidden');
      if (open) full.removeAttribute('hidden'); else full.setAttribute('hidden', '');
      button.setAttribute('aria-expanded', String(open));
      button.textContent = open ? 'Show less' : 'Show all';
    });
  });

  document.addEventListener('click', function (event) {
    var why = event.target.closest('[data-why]');
    if (!why) return;
    var id = why.getAttribute('data-why');
    var holder = why.closest('[data-claim]');
    var existing = holder.querySelector('.trace');
    if (existing) {
      existing.remove();
      why.setAttribute('aria-expanded', 'false');
      return;
    }
    why.setAttribute('aria-expanded', 'true');
    var claim = byKey[id];
    if (holder.classList.contains('tr')) holder.insertAdjacentHTML('beforeend', traceBlock(claim));
    else holder.insertAdjacentHTML('beforeend', traceBlock(claim));
  });

  // Tabs
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function selectTab(tab) {
    tabs.forEach(function (other) {
      var active = other === tab;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-selected', String(active));
      var panelEl = document.getElementById(other.getAttribute('aria-controls'));
      panelEl.classList.toggle('is-active', active);
      if (active) panelEl.removeAttribute('hidden'); else panelEl.setAttribute('hidden', '');
    });
  }
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () { selectTab(tab); });
    tab.addEventListener('keydown', function (event) {
      var index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') { event.preventDefault(); selectTab(tabs[(index + 1) % tabs.length]); tabs[(index + 1) % tabs.length].focus(); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); selectTab(tabs[(index - 1 + tabs.length) % tabs.length]); tabs[(index - 1 + tabs.length) % tabs.length].focus(); }
    });
  });

  // Verify fingerprint: recompute over the rows on this page.
  document.querySelector('[data-verify]').addEventListener('click', function () {
    var result = document.querySelector('[data-pack-result]');
    var recomputed = sha256Hex(canonical(claims)).slice(0, 32);
    var match = recomputed === DATA.scan.fingerprint;
    result.textContent = match
      ? 'VERIFIED MATCH. Recomputed ' + recomputed + ' over the ' + claims.length + ' rows on this page. The table you are reading is the table these rows produce.'
      : 'DRIFT DETECTED. Recomputed ' + recomputed + ', the pack claims ' + DATA.scan.fingerprint + '.';
    result.setAttribute('data-tone', match ? 'ok' : 'bad');
  });

  // Copy the audit memo: the same rows always produce the same words.
  document.querySelector('[data-copy-memo]').addEventListener('click', function (event) {
    var button = event.currentTarget;
    var lines = [
      'AssureLoop audit pack',
      'As of ' + DATA.scan.asOf,
      claims.length + ' claim(s): ' + DATA.counts.VERIFIED + ' verified, ' + DATA.counts.STALE + ' stale, ' +
        DATA.counts.MISSING + ' missing, ' + DATA.counts.NOT_VISIBLE + ' not visible, ' + DATA.counts.INCOMPLETE + ' not checked',
      'Fingerprint ' + DATA.scan.fingerprint + ' (SHA-256, 128 bits shown)',
      ''
    ].concat(claims.map(function (claim) {
      return claim.controlCode + ' | ' + claim.claimKey + ' | ' + claim.state + ' | ' + claim.reason;
    }));
    var text = lines.join('\n');
    var done = function () {
      var result = document.querySelector('[data-pack-result]');
      result.textContent = 'The memo is on your clipboard: ' + lines.length + ' lines, the same rows in the same order.';
      result.setAttribute('data-tone', 'ok');
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy the audit memo'; }, 2200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text); });
    } else {
      fallback(text);
    }
    function fallback(value) {
      var area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); done(); } catch (error) { /* clipboard unavailable */ }
      document.body.removeChild(area);
    }
  });
})();
