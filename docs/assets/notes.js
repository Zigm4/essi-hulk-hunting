/* ESSI field notes: tables recomputed from survey.json, plus the hand-written field log. */
(async function () {
  const E = window.ESSI;
  let S, N;
  try {
    [S, N] = await Promise.all([E.load(), fetch('data/field_notes.json', {cache: 'no-cache'}).then(r => r.json())]);
  } catch (err) {
    document.getElementById('notes').innerHTML = `<p class="amber">&gt; ERROR ${E.esc(err.message)} · serve the docs/ folder over HTTP</p>`;
    return;
  }
  E.stamp(S);
  const md = s => E.esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  const pct = x => `${Math.round(x * 100)} %`;
  const qcell = q => q ? `<span class="q"><i style="background:${E.qColor(q)}"></i>${E.esc(q)}</span>` : '<span class="dim">-</span>';

  // --- calibration per signaller ---------------------------------------------------------------------
  const per = new Map();
  for (const c of S.calibration) {
    const p = c.player || '?';
    const r = per.get(p) || {player: p, lock: 0, drift: 0, rejected: 0, thresholds: new Set()};
    r[c.result] = (r[c.result] || 0) + 1;
    if (c.threshold) r.thresholds.add(c.threshold);
    per.set(p, r);
  }
  const knw = p => (S.players[p] && S.players[p].knw_personal != null ? S.players[p].knw_personal : null);
  const rowsCal = [...per.values()].map(r => {
    const th = r.thresholds.size ? Math.max(...r.thresholds) : (knw(r.player) != null ? 60 + knw(r.player) : null);
    const attempts = r.lock + r.drift;
    return {...r, th, attempts, rate: attempts ? r.lock / attempts : null};
  }).sort((a, b) => (b.th || 0) - (a.th || 0));
  document.getElementById('calib').innerHTML = '<thead><tr><th>Signaller</th><th>Personal KNW</th><th>Threshold</th><th>Locks / attempts</th><th>Lock rate vs expected</th><th>Rejected</th></tr></thead><tbody>' +
    rowsCal.map(r => `<tr><td>${E.esc(r.player)}</td><td>${knw(r.player) != null ? knw(r.player).toFixed(3) : '-'}</td><td>${r.th ? r.th.toFixed(3) : '-'}</td>` +
      `<td>${r.lock} / ${r.attempts}</td><td><div style="display:flex; gap:10px; align-items:center"><div class="bar" title="observed ${r.rate != null ? pct(r.rate) : '-'}, expected ${r.th ? Math.round(r.th) + ' %' : '-'}">` +
      `${r.rate != null ? `<div class="obs" style="width:${(r.rate * 100).toFixed(1)}%"></div>` : ''}${r.th ? `<div class="exp" style="left:${Math.min(100, r.th).toFixed(1)}%"></div>` : ''}</div>` +
      `<span>${r.rate != null ? pct(r.rate) : '-'}</span></div></td><td>${r.rejected}</td></tr>`).join('') + '</tbody>';

  // --- quality vs signaller ------------------------------------------------------------------------------
  const byP = new Map();
  for (const h of S.hulks) {
    if (!h.player) continue;
    const r = byP.get(h.player) || {player: h.player, q: {}, rc: [], colors: []};
    r.q[h.quality] = (r.q[h.quality] || 0) + 1;
    h.vertices.forEach(([, rc]) => r.rc.push(rc));
    if (h.hull_color) r.colors.push(`${h.quality} → ${h.hull_color}`);
    byP.set(h.player, r);
  }
  document.getElementById('quality').innerHTML = '<thead><tr><th>Signaller</th><th>Personal KNW</th><th>Cipher quality</th><th>Vertex Rc</th><th>Hull colour (DM)</th></tr></thead><tbody>' +
    [...byP.values()].sort((a, b) => (knw(a.player) ?? -1) - (knw(b.player) ?? -1)).map(r =>
      `<tr><td>${E.esc(r.player)}</td><td>${knw(r.player) != null ? knw(r.player).toFixed(2) : '-'}</td>` +
      `<td>${Object.entries(r.q).map(([q, n]) => `${qcell(q)} ×${n}`).join('  ')}</td>` +
      `<td>${r.rc.length ? `${Math.min(...r.rc)}–${Math.max(...r.rc)}` : '-'}</td><td>${E.esc(r.colors.join(', ') || '-')}</td></tr>`).join('') + '</tbody>';

  const drifts = S.calibration.filter(c => c.result === 'drift');

  // --- kpis ----------------------------------------------------------------------------------------------
  const locks = S.calibration.filter(c => c.result === 'lock').length, drifted = drifts.length;
  document.getElementById('kpis').innerHTML = [
    [S.hulks.filter(h => h.code).length, 'derelicts decoded'],
    [`${locks}/${locks + drifted}`, 'calibrations locked'],
    [S.scans.filter(x => x.result === 'empty').length, 'empty sweeps'],
    [N.notes.length, 'field notes'],
  ].map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join('');

  // --- field log -----------------------------------------------------------------------------------------
  const tags = [...new Set(N.notes.map(n => n.tag))];
  let active = null;
  const nf = document.getElementById('nf');
  nf.innerHTML = ['All', ...tags].map(t => `<button class="chip" data-t="${E.esc(t)}" aria-pressed="${t === 'All'}">${E.esc(t)}</button>`).join('');
  nf.addEventListener('click', e => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    active = b.dataset.t === 'All' ? null : b.dataset.t;
    nf.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', c === b));
    renderNotes();
  });
  function renderNotes() {
    const list = N.notes.filter(n => !active || n.tag === active).slice().sort((a, b) => b.id.localeCompare(a.id));
    document.getElementById('notes').innerHTML = list.map(n => `<article class="note" id="${E.esc(n.id)}">
      <div class="head"><span class="id">${E.esc(n.id)}</span><span class="tag">${E.esc(n.tag)}</span><span class="tag ${E.esc(n.confidence)}">${E.esc(n.confidence)}</span><span class="date">${E.esc(n.date)}</span><h3>${md(n.title)}</h3></div>
      ${n.body.map(p => `<p>${md(p)}</p>`).join('')}</article>`).join('');
    document.getElementById('ncount').textContent = `${list.length} of ${N.notes.length} entries`;
  }
  renderNotes();
  E.analysisFooter(S);
})();
