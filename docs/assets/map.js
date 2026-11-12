/* ESSI solar chart: pan, zoom, filter, navigate. Everything is drawn in screen space from world
   coordinates (Rc units) on each frame, so marks and labels keep their size at any zoom.
   Planets are computed in the browser (planets.js) for the date shown by the timeline. */
(async function () {
  const E = window.ESSI, P = window.ESSI_PLANETS;
  const boot = document.getElementById('boot');
  let S;
  try {
    S = await E.load();
  } catch (err) {
    boot.innerHTML += `<div class="warn">&gt; ERROR ${E.esc(err.message)} · serve the docs/ folder over HTTP (python3 -m http.server)</div>`;
    return;
  }
  E.stamp(S);

  // No amber/orange: that hue already means 'sweep with no reply' and UI accents.
  const PALETTE = ['#2ee6c5', '#f368e0', '#54a0ff', '#a3e635', '#b18cff', '#ff7eb6', '#7dffb3', '#7fd6ff', '#e8e8a0', '#c9a0ff'];
  const PLANET_COLORS = {Mercury: '#b9b1a6', Venus: '#e8cf8a', Earth: '#6fb6ff', Mars: '#ff7b54', Jupiter: '#e6b98a', Saturn: '#e9d9a6', Uranus: '#9de0e6', Neptune: '#7c95ff'};
  const STATION_HINTS = {Mercury: /mercury/i, Earth: /earth|luna|ratropia/i, Mars: /mars/i, Jupiter: /jupiter|europa/i};
  const PERIOD_DAYS = {Mercury: 88, Venus: 225, Earth: 365.25, Mars: 687, Jupiter: 4333, Saturn: 10759, Uranus: 30687, Neptune: 60190};

  const hulks = S.hulks.filter(h => h.pos);
  const sweeps = S.scans.filter(x => x.rc != null && x.oc != null);
  const empties = sweeps.filter(x => x.result === 'empty');
  const unanswered = sweeps.filter(x => x.result !== 'empty');
  const openTri = (S.open_triangulations || []).map((t, i) => ({...t, id: `open-${i}`}));
  const RANGE = S.scanner.range;
  const RMAX = Math.max(240, ...hulks.map(h => h.pos.rc + 30), ...sweeps.map(x => x.rc + RANGE + 10));

  // Signallers get a colour in order of their first triangulation (stable when new players appear).
  const firstSeen = new Map();
  const seen = (p, t) => { if (p && (!firstSeen.has(p) || (t && t < firstSeen.get(p)))) firstSeen.set(p, t || '9999'); };
  hulks.forEach(h => seen(h.player, (h.vertex_times || [])[0] || h.completed));
  openTri.forEach(t => seen(t.player, (t.times || [])[0] || t.updated));
  const triPlayers = [...firstSeen.keys()].sort((a, b) => firstSeen.get(a).localeCompare(firstSeen.get(b)));
  const pColor = p => (triPlayers.includes(p) ? PALETTE[triPlayers.indexOf(p) % PALETTE.length] : '#9aa5ad');

  // One marker per distinct point; its tooltip lists every triangulation that locked it.
  const vertices = new Map();
  const addVertex = (oc, rc, ref) => {
    const key = `${oc}/${rc}`;
    const v = vertices.get(key) || {id: `vertex-${oc}-${rc}`, oc, rc, refs: []};
    v.refs.push(ref);
    vertices.set(key, v);
  };
  hulks.forEach(h => h.vertices.forEach(([oc, rc], i) => addVertex(oc, rc, {kind: 'hulk', item: h, step: i + 1, time: (h.vertex_times || [])[i]})));
  openTri.forEach(t => t.vertices.forEach(([oc, rc], i) => addVertex(oc, rc, {kind: 'open', item: t, step: i + 1, time: (t.times || [])[i]})));

  const byId = new Map();
  hulks.forEach(h => byId.set(h.id, {kind: 'hulk', item: h}));
  sweeps.forEach(x => byId.set(x.id, {kind: 'sweep', item: x}));
  openTri.forEach(t => byId.set(t.id, {kind: 'open', item: t}));
  vertices.forEach(v => byId.set(v.id, {kind: 'vertex', item: v}));
  P.NAMES.forEach(n => byId.set(`planet-${n}`, {kind: 'planet', item: {name: n}}));

  boot.innerHTML = [
    '&gt; ESSI/DSD derelict survey terminal · open-source intelligence from comms channel #spacecraft',
    `&gt; archive ${E.fmtTime(S.coverage.from, true)} to ${E.fmtTime(S.coverage.to, true)} · ${S.coverage.messages.toLocaleString('en')} messages <span class="ok">[OK]</span>`,
    `&gt; derelicts resolved: <span class="ok">${S.hulks.filter(h => h.code).length}</span> · ciphers pending: <span class="warn">${S.hulks.filter(h => !h.code).length}</span> · triangulations: ${hulks.length + openTri.length} by ${triPlayers.length} signallers · sweeps: ${S.scans.length} · boardings seen: ${S.entries.length}`,
    '&gt; planetary ephemeris computed on this terminal (JPL Keplerian elements) <span class="ok">[OK]</span>',
    '&gt; chart ready<span class="cursor"></span>',
  ].map(l => `<div>${l}</div>`).join('');

  // ---- state ------------------------------------------------------------------------------
  const LAYERS = [
    ['hulks', 'Derelicts', true], ['triangles', 'Triangulations (colour = signaller)', true],
    ['vertices', 'Triangulation points', true], ['open', 'Open triangulations', true],
    ['empty', `No-derelict sweeps (Rc ± ${RANGE})`, true], ['unanswered', 'Unanswered sweeps', true],
    ['planets', 'Planets (computed)', true], ['orbits', 'Planet orbits', true], ['labels', 'Labels', true],
  ];
  const qualities = [...new Set(S.hulks.map(h => h.quality || 'UNKNOWN'))].sort((a, b) => E.QUALITIES.indexOf(a) - E.QUALITIES.indexOf(b));
  const players = [...new Set([...triPlayers, ...S.scans.map(x => x.player)].filter(Boolean))];
  const NOW = 'now';
  const times = [...new Set([...S.hulks.map(h => h.time), ...S.scans.map(x => x.time), ...openTri.map(t => t.updated),
    ...hulks.flatMap(h => h.vertex_times || [])].filter(Boolean))].sort().concat([NOW]);
  const st = {
    k: 1, cx: 0, cy: 0, sel: null,
    layers: Object.fromEntries(LAYERS.map(([k, , on]) => [k, on])),
    q: new Set(qualities), p: new Set(players), asOf: times.length - 1,
  };

  const chart = document.getElementById('chart');
  const svg = document.getElementById('map');
  const layer = document.getElementById('layer');
  const readout = document.getElementById('readout');
  const tip = document.getElementById('tip');
  let W = 800, H = 800;
  let cursorText = '-';
  const base = () => (Math.min(W, H) / 2 - 44) / RMAX;
  const scale = () => base() * st.k;
  const toS = (x, y) => [W / 2 + (x - st.cx) * scale(), H / 2 + (y - st.cy) * scale()];
  const toW = (sx, sy) => [(sx - W / 2) / scale() + st.cx, (sy - H / 2) / scale() + st.cy];
  const polarS = (oc, rc) => { const p = E.toXY(oc, rc); return toS(p.x, p.y); };
  // Planets use their real ecliptic longitude; sector k spans longitudes [30(k-1), 30k).
  const lonXY = (lon, sl) => { const a = (lon + 75) * Math.PI / 180; return {x: sl * Math.cos(a), y: -sl * Math.sin(a)}; };
  const f1 = n => n.toFixed(1);

  // ---- time & visibility ---------------------------------------------------------------------
  const live = () => times[st.asOf] === NOW;
  const asOfTime = () => (live() ? new Date().toISOString() : times[st.asOf]);
  const asOfDate = () => (live() ? new Date() : new Date(times[st.asOf]));
  const inTime = t => !t || t <= asOfTime();
  const playerOk = p => !p || st.p.has(p);
  const hulkVisible = h => st.q.has(h.quality || 'UNKNOWN') && playerOk(h.player) && inTime(h.time);
  const sweepVisible = x => playerOk(x.player) && inTime(x.time);
  const openVisible = t => playerOk(t.player) && inTime((t.times || [])[0] || t.updated);
  const refVisible = r => inTime(r.time) && playerOk(r.item.player) && (r.kind === 'open' || st.q.has(r.item.quality || 'UNKNOWN'));

  // ---- planets --------------------------------------------------------------------------------
  let planetCache = {key: null, list: []};
  function planets() {
    const d = asOfDate();
    const key = live() ? `live-${Math.floor(Date.now() / 600000)}` : d.getTime();
    if (planetCache.key !== key) planetCache = {key, list: P.NAMES.map(n => P.position(n, d))};
    return planetCache.list;
  }
  const orbits = Object.fromEntries(P.NAMES.map(n => {
    const now = new Date(), pts = [];
    for (let i = 0; i <= 96; i++) { const p = P.position(n, new Date(now.getTime() + i * PERIOD_DAYS[n] * 86400000 / 96)); pts.push(lonXY(p.lon, p.sl)); }
    return [n, pts];
  }));

  // ---- drawing --------------------------------------------------------------------------------
  function annulus(oc, r0, r1) {
    const a0 = E.angle(oc) - Math.PI / 12, a1 = E.angle(oc) + Math.PI / 12, s = scale();
    const [sx, sy] = toS(0, 0);
    const p = (r, a) => `${f1(sx + r * s * Math.cos(a))} ${f1(sy - r * s * Math.sin(a))}`;
    return `M ${p(r0, a0)} A ${f1(r0 * s)} ${f1(r0 * s)} 0 0 0 ${p(r0, a1)} L ${p(r1, a1)} A ${f1(r1 * s)} ${f1(r1 * s)} 0 0 1 ${p(r1, a0)} Z`;
  }
  const hulkFill = h => (h.hull_color ? E.qColor(h.hull_color) : 'var(--bg)');
  const hulkStroke = h => (h.hull_color ? 'var(--text)' : (h.code ? E.qStroke(h.quality) : 'var(--dim)'));
  const readoutHtml = () => `CURSOR <b>${E.esc(cursorText)}</b> · ZOOM <b>×${st.k.toFixed(1)}</b> · PLANETS <b>${live() ? 'live' : E.fmtTime(asOfTime())}</b>`;

  function render() {
    const out = [];
    const placed = [];
    const place = (x, y, w) => {       // nudge a label down until it clears the ones already placed
      let yy = y;
      for (let i = 0; i < 8 && placed.some(p => Math.abs(p.x - x) < (p.w + w) / 2 && Math.abs(p.y - yy) < 12); i++) yy += 12;
      placed.push({x, y: yy, w});
      return yy;
    };
    const s = scale();
    const [sunX, sunY] = toS(0, 0);
    const step = st.k >= 8 ? 10 : st.k >= 3 ? 25 : 50;
    for (let rc = step; rc <= RMAX; rc += step) {
      const major = rc % 50 === 0;
      out.push(`<circle cx="${f1(sunX)}" cy="${f1(sunY)}" r="${f1(rc * s)}" fill="none" stroke="${major ? 'var(--line)' : 'var(--grid)'}" stroke-width="${major ? 1 : 0.7}"/>`);
      if (major || st.k >= 3) { const [lx, ly] = polarS(1, rc); out.push(`<text x="${f1(lx + 4)}" y="${f1(ly - 3)}" font-size="10" fill="var(--dim)">Rc ${rc}</text>`); }
    }
    for (let oc = 1; oc <= 12; oc++) {
      const a = E.angle(oc) + Math.PI / 12;
      out.push(`<line x1="${f1(sunX)}" y1="${f1(sunY)}" x2="${f1(sunX + RMAX * s * Math.cos(a))}" y2="${f1(sunY - RMAX * s * Math.sin(a))}" stroke="var(--grid)" stroke-width="1"/>`);
      const lr = RMAX * s + 20, la = E.angle(oc);
      const lx = sunX + lr * Math.cos(la), ly = sunY - lr * Math.sin(la);
      out.push(`<text x="${f1(lx)}" y="${f1(ly - 1)}" text-anchor="middle" font-size="13" fill="var(--amber)">${oc}</text>`);
      out.push(`<text x="${f1(lx)}" y="${f1(ly + 11)}" text-anchor="middle" font-size="9.5" fill="var(--dim)">${E.esc(S.sectors[oc] || '')}</text>`);
    }
    out.push(`<circle cx="${f1(sunX)}" cy="${f1(sunY)}" r="${Math.max(4, 3 * Math.sqrt(st.k))}" fill="var(--amber)"/>`);

    if (st.layers.orbits) {
      for (const n of P.NAMES) {
        const pts = orbits[n];
        if (Math.hypot(pts[0].x, pts[0].y) > RMAX * 1.05) continue;
        out.push(`<polyline points="${pts.map(p => toS(p.x, p.y).map(f1).join(',')).join(' ')}" fill="none" stroke="${PLANET_COLORS[n]}" stroke-opacity="0.18" stroke-width="1"/>`);
      }
    }
    if (st.layers.empty) {
      for (const x of empties.filter(sweepVisible)) {
        const on = st.sel === x.id;
        out.push(`<path d="${annulus(x.oc, Math.max(0, x.rc - RANGE), x.rc + RANGE)}" fill="url(#hatch)" stroke="${on ? 'var(--amber)' : 'var(--empty)'}" stroke-opacity="${on ? 1 : 0.35}" stroke-width="${on ? 1.6 : 1}" data-id="${x.id}"/>`);
      }
    }
    if (st.layers.unanswered) {
      for (const x of unanswered.filter(sweepVisible)) {
        out.push(`<path d="${annulus(x.oc, Math.max(0, x.rc - RANGE), x.rc + RANGE)}" fill="none" stroke="var(--amber)" stroke-opacity="${st.sel === x.id ? 0.9 : 0.35}" stroke-dasharray="4 4" data-id="${x.id}"/>`);
      }
    }
    if (st.layers.triangles) {
      for (const h of hulks.filter(hulkVisible)) {
        if (!h.vertices || h.vertices.length < 3) continue;
        const on = st.sel === h.id, c = pColor(h.player);
        const pts = h.vertices.map(([o, r]) => polarS(o, r).map(f1).join(',')).join(' ');
        out.push(`<polygon points="${pts}" fill="${c}" fill-opacity="${on ? 0.18 : 0.05}" stroke="${c}" stroke-opacity="${on ? 1 : 0.75}" stroke-width="${on ? 2.4 : 1.4}" stroke-dasharray="${h.code ? '' : '6 4'}" stroke-linejoin="round" data-id="${h.id}"/>`);
      }
    }
    if (st.layers.open) {
      for (const t of openTri.filter(openVisible)) {
        const pts = t.vertices.map(([o, r]) => polarS(o, r));
        if (pts.length > 1) out.push(`<polyline points="${pts.map(p => p.map(f1).join(',')).join(' ')}" fill="none" stroke="${pColor(t.player)}" stroke-dasharray="3 3" data-id="${t.id}"/>`);
        if (st.layers.labels && pts.length) {
          const [x, y] = pts[pts.length - 1], txt = `${t.player || '?'} ${t.vertices.length}/3`;
          const ly = place(x + 9 + txt.length * 3, y + 15, txt.length * 6.2);
          out.push(`<text x="${f1(x + 9)}" y="${f1(ly)}" font-size="10" fill="${pColor(t.player)}" data-id="${t.id}">${E.esc(txt)}</text>`);
        }
      }
    }
    if (st.layers.vertices) {
      for (const v of vertices.values()) {
        const refs = v.refs.filter(r => refVisible(r) && (r.kind === 'open' ? st.layers.open : st.layers.triangles));
        if (!refs.length) continue;
        const [x, y] = polarS(v.oc, v.rc);
        const colors = [...new Set(refs.map(r => pColor(r.item.player)))];
        const on = st.sel === v.id || refs.some(r => r.item.id === st.sel);
        out.push(`<g data-id="${v.id}"><circle cx="${f1(x)}" cy="${f1(y)}" r="9" fill="transparent"/>`);
        out.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${on ? 5 : 4}" fill="${colors[0]}" stroke="${colors.length > 1 ? colors[1] : 'var(--bg)'}" stroke-width="${colors.length > 1 ? 2.2 : 1.2}"/></g>`);
      }
    }
    if (st.layers.planets) {
      for (const p of planets()) {
        const c = PLANET_COLORS[p.name], id = `planet-${p.name}`, on = st.sel === id;
        const w = lonXY(p.lon, p.sl);
        if (p.sl <= RMAX * 1.02) {
          const [x, y] = toS(w.x, w.y), r = p.name === 'Jupiter' ? 7 : 5;
          out.push(`<g data-id="${id}"><circle cx="${f1(x)}" cy="${f1(y)}" r="${r + 5}" fill="transparent"/><circle cx="${f1(x)}" cy="${f1(y)}" r="${r}" fill="${c}" stroke="${on ? 'var(--amber)' : 'var(--bg)'}" stroke-width="${on ? 2 : 1.4}"/>`);
          if (st.layers.labels) {
            const txt = `${p.name} ${p.oc}/${p.rc}`, ly = place(x + 10 + txt.length * 3.1, y - 8, txt.length * 6.3);
            out.push(`<text x="${f1(x + 10)}" y="${f1(ly)}" font-size="10.5" fill="${c}">${E.esc(txt)}</text>`);
          }
          out.push('</g>');
        } else {                        // beyond the chart: arrow on the rim
          const a = (p.lon + 75) * Math.PI / 180, rr = RMAX * s + 4;
          const x = sunX + rr * Math.cos(a), y = sunY - rr * Math.sin(a);
          out.push(`<g data-id="${id}"><path d="M 0 -5 L 9 0 L 0 5 Z" transform="translate(${f1(x)} ${f1(y)}) rotate(${f1(-(p.lon + 75))})" fill="${c}"/>`);
          if (st.layers.labels) {
            const txt = `${p.name} ${p.oc}/${p.rc}`, lx = x + 12 * Math.cos(a), ly0 = y - 12 * Math.sin(a);
            out.push(`<text x="${f1(lx)}" y="${f1(place(lx, ly0, txt.length * 6.3))}" font-size="10" fill="${c}" text-anchor="${Math.cos(a) >= 0 ? 'start' : 'end'}">${E.esc(txt)}</text>`);
          }
          out.push('</g>');
        }
      }
    }
    if (st.layers.empty) {
      for (const x of empties.filter(sweepVisible)) {
        const [mx, my] = polarS(x.oc, x.rc), c = pColor(x.player), on = st.sel === x.id;
        out.push(`<g data-id="${x.id}"><circle cx="${f1(mx)}" cy="${f1(my)}" r="9" fill="transparent"/>` +
          `<circle cx="${f1(mx)}" cy="${f1(my)}" r="${on ? 6.5 : 5.5}" fill="var(--bg)" stroke="${on ? 'var(--amber)' : c}" stroke-width="1.6"/>` +
          `<line x1="${f1(mx - 3.6)}" y1="${f1(my + 3.6)}" x2="${f1(mx + 3.6)}" y2="${f1(my - 3.6)}" stroke="${on ? 'var(--amber)' : c}" stroke-width="1.6"/></g>`);
      }
    }
    if (st.layers.unanswered) {
      for (const x of unanswered.filter(sweepVisible)) {
        const [mx, my] = polarS(x.oc, x.rc);
        out.push(`<g data-id="${x.id}"><circle cx="${f1(mx)}" cy="${f1(my)}" r="7.5" fill="var(--bg)" stroke="var(--amber)" stroke-width="${st.sel === x.id ? 2.4 : 1.5}"/><text x="${f1(mx)}" y="${f1(my + 3.5)}" text-anchor="middle" font-size="10" font-weight="600" fill="var(--amber)">?</text></g>`);
      }
    }
    if (st.layers.hulks) {
      const vis = hulks.filter(hulkVisible).map(h => ({h, xy: polarS(h.pos.oc, h.pos.rc)}));
      const clusters = [];
      for (const v of vis) {
        const c = clusters.find(c => Math.hypot(c.x - v.xy[0], c.y - v.xy[1]) < 18);
        if (c) c.items.push(v); else clusters.push({x: v.xy[0], y: v.xy[1], items: [v]});
      }
      for (const c of clusters) {
        const right = c.x >= sunX - 30;
        c.items.forEach((v, i) => {
          const h = v.h, on = st.sel === h.id;
          const x = c.x + (i - (c.items.length - 1) / 2) * 13, y = c.y;
          out.push(`<g data-id="${h.id}">`);
          if (on) out.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="13" fill="none" stroke="var(--amber)" stroke-width="1.4"/>`);
          out.push(`<rect x="${f1(x - 5.5)}" y="${f1(y - 5.5)}" width="11" height="11" transform="rotate(45 ${f1(x)} ${f1(y)})" fill="${hulkFill(h)}" stroke="${hulkStroke(h)}" stroke-width="1.5" stroke-dasharray="${h.hull_color ? '' : '2.5 2'}"/>`);
          if (h.pos.exact) out.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="1.6" fill="var(--amber)"/>`);
          if (st.layers.labels) {
            const ly = c.y - 14 - (c.items.length - 1 - i) * 13;
            const lx = right ? c.x + 16 : c.x - 16;
            const colour = h.hull_color ? `<tspan fill="${E.qStroke(h.hull_color)}"> ${E.esc(h.hull_color)}</tspan>` : (h.code ? `<tspan fill="var(--dim)"> cipher ${E.esc(h.quality)}</tspan>` : '<tspan fill="var(--dim)"> pending</tspan>');
            out.push(`<text x="${f1(lx)}" y="${f1(ly)}" text-anchor="${right ? 'start' : 'end'}" font-size="11.5" fill="${on ? 'var(--amber)' : 'var(--text)'}">${E.esc(h.code || h.cipher.slice(4, 8))}${colour}</text>`);
          }
          out.push('</g>');
        });
      }
    }
    layer.innerHTML = out.join('');
    readout.innerHTML = readoutHtml();
  }
  let frame = 0;
  const draw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };

  new ResizeObserver(() => {
    const r = chart.getBoundingClientRect();
    W = Math.max(200, r.width); H = Math.max(200, r.height);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    draw();
  }).observe(chart);

  // ---- pan / zoom -----------------------------------------------------------------------------
  const clampK = k => Math.min(40, Math.max(0.6, k));
  function zoomAt(sx, sy, factor) {
    const [wx, wy] = toW(sx, sy);
    st.k = clampK(st.k * factor);
    st.cx = wx - (sx - W / 2) / scale();
    st.cy = wy - (sy - H / 2) / scale();
    draw();
  }
  const local = e => { const r = svg.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
  // Wheel zooms once the chart is armed (clicked or focused) or with Ctrl/Cmd (also trackpad pinch);
  // otherwise the page scrolls and a hint shows, so the registries below stay reachable.
  let armed = false, hintTimer = 0;
  const hint = document.getElementById('hint');
  svg.addEventListener('wheel', e => {
    if (!(armed || e.ctrlKey || e.metaKey)) {
      hint.hidden = false; clearTimeout(hintTimer); hintTimer = setTimeout(() => { hint.hidden = true; }, 1400);
      return;
    }
    e.preventDefault();
    const [x, y] = local(e);
    zoomAt(x, y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  }, {passive: false});
  svg.addEventListener('focus', () => { armed = true; });
  svg.addEventListener('blur', () => { armed = false; });
  chart.addEventListener('pointerleave', () => { if (document.activeElement !== svg) armed = false; });
  svg.addEventListener('dblclick', e => { const [x, y] = local(e); zoomAt(x, y, e.shiftKey ? 0.5 : 2); });
  const pointers = new Map();
  let dragged = 0, pinch = null;
  svg.addEventListener('pointerdown', e => {
    armed = true; hint.hidden = true;
    svg.focus({preventScroll: true});
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    dragged = 0;
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = {d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: st.k}; }
  });
  svg.addEventListener('pointermove', e => {
    const p = local(e);
    updateCursor(p);
    if (!pointers.has(e.pointerId)) { hover(e); return; }
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      dragged += Math.abs(p[0] - prev[0]) + Math.abs(p[1] - prev[1]);
      if (dragged > 3) svg.classList.add('dragging');
      st.cx -= (p[0] - prev[0]) / scale();
      st.cy -= (p[1] - prev[1]) / scale();
      tip.hidden = true;
      draw();
    } else if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      dragged = 99;
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, clampK(pinch.k * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d) / st.k);
    }
  });
  const release = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; svg.classList.remove('dragging'); };
  svg.addEventListener('pointerup', e => {
    const wasClick = dragged <= 3 && pointers.size === 1;
    release(e);
    if (wasClick) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const hit = el && el.closest('[data-id]');
      select(hit ? hit.dataset.id : null, false);
    }
  });
  svg.addEventListener('pointercancel', release);
  svg.addEventListener('pointerleave', () => { tip.hidden = true; cursorText = '-'; draw(); });
  svg.addEventListener('keydown', e => {
    const stepW = 60 / scale();
    const keys = {ArrowLeft: [-stepW, 0], ArrowRight: [stepW, 0], ArrowUp: [0, -stepW], ArrowDown: [0, stepW]};
    if (keys[e.key]) { st.cx += keys[e.key][0]; st.cy += keys[e.key][1]; draw(); e.preventDefault(); }
    else if (e.key === '+' || e.key === '=') zoomAt(W / 2, H / 2, 1.4);
    else if (e.key === '-') zoomAt(W / 2, H / 2, 1 / 1.4);
    else if (e.key === '0') animateTo(0, 0, 1);
    else if (e.key === 'Escape') select(null, false);
  });
  document.getElementById('zin').onclick = () => zoomAt(W / 2, H / 2, 1.5);
  document.getElementById('zout').onclick = () => zoomAt(W / 2, H / 2, 1 / 1.5);
  document.getElementById('zreset').onclick = () => animateTo(0, 0, 1);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function animateTo(cx, cy, k) {
    if (reduced) { st.cx = cx; st.cy = cy; st.k = k; draw(); return; }
    const from = {cx: st.cx, cy: st.cy, k: st.k}, t0 = performance.now(), dur = 450;
    const tick = now => {
      const t = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - t, 3);
      st.k = Math.exp(Math.log(from.k) + (Math.log(k) - Math.log(from.k)) * e);
      st.cx = from.cx + (cx - from.cx) * e; st.cy = from.cy + (cy - from.cy) * e;
      render();
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function updateCursor([sx, sy]) {
    const [wx, wy] = toW(sx, sy);
    const p = E.toPolar(wx, wy);
    cursorText = p.rc <= RMAX + 10 ? `Oc ${p.oc} ${S.sectors[p.oc] || ''} / Rc ${p.rc.toFixed(0)}` : '-';
    readout.innerHTML = readoutHtml();
  }
  function hover(e) {
    const el = e.target.closest && e.target.closest('[data-id]');
    const entry = el && byId.get(el.dataset.id);
    if (!entry) { tip.hidden = true; return; }
    tip.innerHTML = tipHtml(entry);
    const r = chart.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = `${Math.max(4, Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 6))}px`;
    tip.style.top = `${Math.max(4, Math.min(e.clientY - r.top + 14, r.height - tip.offsetHeight - 6))}px`;
  }
  const planetNow = name => planets().find(p => p.name === name);
  function tipHtml({kind, item}) {
    if (kind === 'vertex') {
      const refs = item.refs.filter(refVisible);
      return `<b>Oc ${item.oc} / Rc ${item.rc}</b> <span class="dim">${E.esc(S.sectors[item.oc] || '')}</span>` + refs.map(r =>
        `<div><span style="color:${pColor(r.item.player)}">■</span> ${E.esc(r.item.player || '?')} · ${E.esc(r.kind === 'hulk' ? (r.item.code || r.item.cipher) : 'open')} point ${r.step}/3${r.time ? ' · ' + E.fmtTime(r.time) : ''}</div>`).join('');
    }
    if (kind === 'hulk') return `<b>${E.esc(item.code || item.cipher)}</b> · ${item.hull_color ? `${E.esc(item.hull_class)} <span style="color:${E.qStroke(item.hull_color)}">${E.esc(item.hull_color)}</span>` : `cipher ${E.esc(item.quality || '?')}, hull colour unknown`}<div><span style="color:${pColor(item.player)}">■</span> ${E.esc(item.player || '?')} · ${E.fmtPos(item.pos)}${item.pos.exact ? '' : ' (centre of triangle)'}</div>`;
    if (kind === 'sweep') return `<b>${item.result === 'empty' ? 'No derelict' : 'Sweep, no reply posted'}</b> · <span style="color:${pColor(item.player)}">■</span> ${E.esc(item.player || '?')} (${E.esc(item.vessel || '?')})<div>${E.fmtTime(item.time)} · from ${E.fmtPos(item)} · covers Oc ${item.oc}, Rc ${Math.max(1, item.rc - RANGE)} to ${item.rc + RANGE}</div>`;
    if (kind === 'planet') { const p = planetNow(item.name); return `<b>${E.esc(item.name)}</b> Oc ${p.oc} / Rc ${p.rc}<div class="dim">longitude ${p.lon.toFixed(1)}° · ${p.sl.toFixed(2)} SL · ${live() ? 'now' : E.fmtTime(asOfTime())}</div>`; }
    return `<span style="color:${pColor(item.player)}">■</span> ${E.esc(item.player || '?')} · triangulation ${item.vertices.length}/3`;
  }

  // ---- selection & readout ----------------------------------------------------------------------
  const detail = document.getElementById('detail');
  const dkind = document.getElementById('dkind');
  const rows = list => `<dl>${list.filter(Boolean).map(([k, v]) => `<dt>${E.esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const pointList = (vs, ts) => vs.map(([o, r], i) => `Oc ${o} / Rc ${r}${ts && ts[i] ? ` <span class="dim">${E.fmtTime(ts[i])}</span>` : ''}`).join('<br>');
  function showDetail(entry) {
    if (!entry) { dkind.textContent = ''; detail.innerHTML = '<p class="empty-state">Select a derelict, a triangulation point, a sweep or a planet on the chart.</p>'; return; }
    const {kind, item} = entry;
    if (kind === 'hulk') {
      dkind.textContent = 'DERELICT';
      detail.innerHTML = `<h3>${E.esc(item.code || 'Cipher pending')}</h3>` + rows([
        ['Hull', item.hull_class ? `<span class="q"><i style="background:${E.qColor(item.hull_color)}"></i>${E.esc(item.hull_class)} · ${E.esc(item.hull_color)}</span>` : 'unknown (no DM report on file)'],
        item.status ? ['Status', E.esc(item.status)] : null,
        ['Cipher quality', `<span class="q"><i style="background:${E.qColor(item.quality)}"></i>${E.esc(item.quality || '?')}</span>`],
        ['Cipher', E.esc(item.cipher || '-')],
        ['Signaller', `<span style="color:${pColor(item.player)}">■</span> ${E.esc(item.player || '?')} · ${E.esc(item.vessel || '?')}`],
        ['Points', item.vertices.length ? pointList(item.vertices, item.vertex_times) : '-'],
        [item.pos.exact ? 'Position' : 'Estimate', `${E.fmtPos(item.pos)}${item.pos.exact ? ' (DM report)' : ' · centre of triangle'}`],
        item.exact_known && !item.pos.exact ? ['Exact fix', 'on file, classified (private DM)'] : null,
        ['Decoded', item.decoded ? `${E.fmtTime(item.decoded, true)}${item.decoded_by ? ' by ' + E.esc(item.decoded_by) : ''}` : 'not yet'],
        ['Encrypted data', item.encrypted_data != null ? `+${item.encrypted_data}` : '-'],
        ['Boardings', item.entries && item.entries.length ? item.entries.map(t => E.fmtTime(t, true)).join(', ') : 'none seen'],
        item.code ? ['Enter with', `<code>!enter ${E.esc(item.code)}</code>`] : null,
      ]) + (item.note ? `<p class="note">${E.esc(item.note)}</p>` : '');
    } else if (kind === 'vertex') {
      dkind.textContent = 'TRIANGULATION POINT';
      detail.innerHTML = `<h3>Oc ${item.oc} / Rc ${item.rc}</h3>` + rows([['Sector', `${item.oc} (${E.esc(S.sectors[item.oc] || '')})`],
        ...item.refs.map(r => [`${r.item.player || '?'}`, `${E.esc(r.kind === 'hulk' ? (r.item.code || r.item.cipher) : 'open triangulation')} · point ${r.step}/3${r.time ? ' · ' + E.fmtTime(r.time, true) : ''}`])]);
    } else if (kind === 'sweep') {
      dkind.textContent = 'SCANNER SWEEP';
      detail.innerHTML = `<h3>${item.result === 'empty' ? 'Empty sector slice' : 'Unanswered sweep'}</h3>` + rows([
        ['Time', E.fmtTime(item.time, true)], ['Vessel', `${E.esc(item.vessel || '?')} · ${E.esc(item.player || '?')}`],
        ['From', E.fmtPos(item)], ['Covers', `Oc ${item.oc} (${E.esc(S.sectors[item.oc] || '')}), Rc ${Math.max(1, item.rc - RANGE)} to ${item.rc + RANGE}`],
        ['Result', item.result === 'empty' ? 'No derelict hulks detected' : (item.result === 'hits' ? E.esc(item.text) : 'no reply in channel')],
      ]) + `<p class="note">${item.result === 'empty' ? 'Empty at sweep time. Hulks can spawn or drift later.' : 'A hit shows a short-lived radar and sends the report by DM, which would explain the silence.'}</p>`;
    } else if (kind === 'planet') {
      const p = planetNow(item.name), next = P.nextSectorChange(item.name, asOfDate());
      const stations = (S.stations || []).filter(s => STATION_HINTS[item.name] && STATION_HINTS[item.name].test(s.name)).map(s => s.name);
      dkind.textContent = 'PLANET';
      detail.innerHTML = `<h3>${E.esc(item.name)}</h3>` + rows([
        ['Position', `Oc ${p.oc} (${E.esc(S.sectors[p.oc] || '')}) / Rc ${p.rc}`],
        ['For', live() ? 'now (live)' : E.fmtTime(asOfTime(), true)],
        ['Longitude', `${p.lon.toFixed(2)}° (ecliptic)`], ['Distance', `${p.sl.toFixed(2)} SL`],
        ['Next sector', next ? `Oc ${next.oc} on ${E.fmtTime(next.date.toISOString(), true)}` : 'not within 4 years'],
        stations.length ? ['Stations', E.esc(stations.join(', '))] : null,
      ]) + '<p class="note">Computed on this terminal from JPL orbital elements with the game mapping: Oc = ecliptic longitude / 30°, Rc = distance in miles / 3,000,000.</p>';
    } else {
      dkind.textContent = 'OPEN TRIANGULATION';
      detail.innerHTML = `<h3><span style="color:${pColor(item.player)}">■</span> ${E.esc(item.player || '?')} · ${item.vertices.length}/3</h3>` + rows([['Vessel', E.esc(item.vessel)], ['Points', pointList(item.vertices, item.times)], ['Last lock', E.fmtTime(item.updated, true)]]);
    }
  }
  function focusPoint({kind, item}) {
    if (kind === 'hulk') return E.toXY(item.pos.oc, item.pos.rc);
    if (kind === 'planet') { const p = planetNow(item.name); return lonXY(p.lon, Math.min(p.sl, RMAX)); }
    if (kind === 'open') return E.toXY(...item.vertices.at(-1));
    return E.toXY(item.oc, item.rc);
  }
  function select(id, fly) {
    st.sel = id && byId.has(id) ? id : null;
    const entry = st.sel ? byId.get(st.sel) : null;
    showDetail(entry);
    document.querySelectorAll('[data-row]').forEach(r => r.classList.toggle('on', r.dataset.row === st.sel));
    document.querySelectorAll('.target').forEach(b => b.classList.toggle('on', b.dataset.id === st.sel));
    try { history.replaceState(null, '', st.sel ? `#${st.sel}` : location.pathname + location.search); } catch (_) { /* sandboxed */ }
    if (fly && entry) { const w = focusPoint(entry); animateTo(w.x, w.y, Math.max(st.k, 3.2)); } else draw();
  }

  // ---- legend & filters -----------------------------------------------------------------------
  const counts = p => hulks.filter(h => h.player === p).length + openTri.filter(t => t.player === p).length;
  const fp = document.getElementById('fp');
  fp.innerHTML = players.map(p => `<button class="chip" data-p="${E.esc(p)}" aria-pressed="true"><span class="sw" style="background:${pColor(p)};border-color:${pColor(p)}"></span>${E.esc(p)} <span class="dim">${triPlayers.includes(p) ? counts(p) + ' tri.' : 'sweeps'}</span></button>`).join('');
  fp.addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) toggle(st.p, b.dataset.p, b); });
  const hullColours = [...new Set(S.hulks.map(h => h.hull_color).filter(Boolean))].sort((a, b) => E.QUALITIES.indexOf(a) - E.QUALITIES.indexOf(b));
  const diamond = (fill, stroke, dash) => `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="3" y="3" width="8" height="8" transform="rotate(45 7 7)" fill="${fill}" stroke="${stroke}" stroke-width="1.3"${dash ? ' stroke-dasharray="2.5 2"' : ''}/></svg>`;
  document.getElementById('lhull').innerHTML =
    hullColours.map(c => `<span class="lg">${diamond(E.qColor(c), 'var(--text)')}${E.esc(c)} hull</span>`).join('') +
    `<span class="lg">${diamond('var(--bg)', 'var(--q-WHITE)', true)}hull colour unknown (outline = cipher quality)</span>` +
    `<span class="lg">${diamond('var(--bg)', 'var(--dim)', true)}cipher not decoded</span>`;
  document.getElementById('lplanets').innerHTML = P.NAMES.map(n => `<span class="lg"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="${PLANET_COLORS[n]}"/></svg>${n}</span>`).join('');

  const layersBox = document.getElementById('layers');
  layersBox.innerHTML = LAYERS.map(([k, name]) => `<label class="check"><input type="checkbox" id="layer-${k}" data-layer="${k}" ${st.layers[k] ? 'checked' : ''}> ${E.esc(name)}</label>`).join('');
  layersBox.addEventListener('change', e => { const k = e.target.dataset.layer; if (k) { st.layers[k] = e.target.checked; renderTargets(); draw(); } });
  const fq = document.getElementById('fq');
  fq.innerHTML = qualities.map(q => `<button class="chip" data-q="${q}" aria-pressed="true"><span class="sw" style="background:${E.qColor(q)}"></span>${q}</button>`).join('');
  fq.addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (b) toggle(st.q, b.dataset.q, b); });
  function toggle(set, key, btn) {
    if (set.has(key)) set.delete(key); else set.add(key);
    btn.setAttribute('aria-pressed', set.has(key));
    refresh();
  }
  const asof = document.getElementById('asof'), asofVal = document.getElementById('asof-val');
  asof.max = Math.max(0, times.length - 1); asof.value = st.asOf;
  const asofText = () => { asofVal.textContent = live() ? 'now (live): all contacts, planets at the current time' : `as of ${E.fmtTime(asOfTime(), true)}`; };
  asof.addEventListener('input', () => { st.asOf = +asof.value; asofText(); refresh(); });
  asofText();
  document.getElementById('fall').onclick = () => {
    qualities.forEach(q => st.q.add(q)); players.forEach(p => st.p.add(p)); st.asOf = times.length - 1; asof.value = st.asOf; asofText();
    LAYERS.forEach(([k, , on]) => { st.layers[k] = on; document.getElementById(`layer-${k}`).checked = on; });
    document.querySelectorAll('#fq .chip, #fp .chip').forEach(b => b.setAttribute('aria-pressed', 'true'));
    refresh();
  };

  // ---- targets & tables -------------------------------------------------------------------------
  const targets = document.getElementById('targets');
  const markStyle = h => `background:${hulkFill(h)};border-color:${hulkStroke(h)};${h.hull_color ? '' : 'border-style:dashed;'}`;
  function renderTargets() {
    const list = [
      ...hulks.filter(hulkVisible).map(h => ({id: h.id, t: h.time, html: `<span class="mark" style="${markStyle(h)}"></span><span>${E.esc(h.code || 'pending ' + h.cipher)} <span class="k" style="color:${pColor(h.player)}">${E.esc(h.player || '')}</span></span><span class="k">${E.fmtPos(h.pos)}</span>`})),
      ...unanswered.filter(sweepVisible).map(x => ({id: x.id, t: x.time, html: `<span class="mark sweep"></span><span>sweep ? ${E.fmtTime(x.time)}</span><span class="k">${E.fmtPos(x)}</span>`})),
      ...(st.layers.empty ? empties.filter(sweepVisible) : []).map(x => ({id: x.id, t: x.time, html: `<span class="mark nohulk" style="--c:${pColor(x.player)}"></span><span>no derelict ${E.fmtTime(x.time)} <span class="k" style="color:${pColor(x.player)}">${E.esc(x.player || '')}</span></span><span class="k">${E.fmtPos(x)}</span>`})),
    ].sort((a, b) => (b.t || '').localeCompare(a.t || ''));
    const pl = planets().map(p => ({id: `planet-${p.name}`, html: `<span class="mark planet" style="background:${PLANET_COLORS[p.name]}"></span><span>${p.name}</span><span class="k">Oc ${p.oc} / Rc ${p.rc}</span>`}));
    targets.innerHTML = list.concat(pl).map(t => `<button class="target${t.id === st.sel ? ' on' : ''}" data-id="${t.id}">${t.html}</button>`).join('') || '<p class="empty-state">No target matches the filters.</p>';
    document.getElementById('tcount').textContent = `${list.length} contacts · ${pl.length} planets`;
  }
  const showChart = () => {
    const r = chart.getBoundingClientRect();
    if (r.bottom < 80 || r.top > innerHeight - 80) chart.scrollIntoView({behavior: reduced ? 'auto' : 'smooth', block: 'center'});
  };
  targets.addEventListener('click', e => { const b = e.target.closest('[data-id]'); if (b) { select(b.dataset.id, true); showChart(); } });

  const qcell = q => (q ? `<span class="q"><i style="background:${E.qColor(q)}"></i>${E.esc(q)}</span>` : '<span class="dim">-</span>');
  function renderTables() {
    const reg = document.getElementById('registry');
    reg.innerHTML = '<thead><tr><th>Code</th><th>Hull (DM)</th><th>Cipher quality</th><th>Signaller</th><th>Vessel</th><th>Points (Oc/Rc)</th><th>Position</th><th>Decoded</th><th>Cipher</th><th>Boarded</th></tr></thead><tbody>' +
      S.hulks.filter(hulkVisible).slice().sort((a, b) => (b.time || '').localeCompare(a.time || '')).map(h => `<tr data-row="${h.id}" class="${h.id === st.sel ? 'on' : ''}">` +
        `<td>${E.esc(h.code || '-')}</td><td>${h.hull_class ? `${qcell(h.hull_color)} <span class="dim">${E.esc(h.hull_class)}</span>` : '<span class="dim">unknown</span>'}</td><td>${qcell(h.quality)}</td>` +
        `<td><span style="color:${pColor(h.player)}">■</span> ${E.esc(h.player || '?')}</td><td class="dim">${E.esc(h.vessel || '?')}</td>` +
        `<td>${h.vertices.map(([o, r]) => `${o}/${r}`).join(' · ') || '-'}</td><td>${h.pos ? E.fmtPos(h.pos) + (h.pos.exact ? '' : h.exact_known ? ' <span class="dim">◇ fix classified</span>' : ' <span class="dim">◇</span>') : '-'}</td>` +
        `<td>${h.decoded ? E.fmtTime(h.decoded) : '<span class="amber">pending</span>'}</td><td class="dim">${E.esc(h.cipher || '-')}</td><td>${h.entries && h.entries.length ? h.entries.length : '<span class="dim">no</span>'}</td></tr>`).join('') + '</tbody>';
    const sw = document.getElementById('sweeps');
    sw.innerHTML = '<thead><tr><th>Time</th><th>Vessel</th><th>Signaller</th><th>From</th><th>Covers</th><th>Result</th></tr></thead><tbody>' +
      S.scans.filter(sweepVisible).slice().reverse().map(x => `<tr data-row="${x.id}" class="${x.id === st.sel ? 'on' : ''}"><td>${E.fmtTime(x.time)}</td><td class="dim">${E.esc(x.vessel || '?')}</td><td>${E.esc(x.player || '?')}</td>` +
        `<td>${E.fmtPos(x)}</td><td>${x.oc != null ? `Oc ${x.oc} · Rc ${Math.max(1, x.rc - RANGE)} to ${x.rc + RANGE}` : '-'}</td>` +
        `<td>${x.result === 'empty' ? '<span class="dim">empty</span>' : x.result === 'hits' ? '<span class="cyan">contact</span>' : '<span class="amber">no reply</span>'}</td></tr>`).join('') + '</tbody>';
    document.getElementById('sweepmeta').textContent = `SSCAN short range: ${RANGE} SL inside the same sector, ${S.scanner.max_results} results max`;
  }
  for (const id of ['registry', 'sweeps']) {
    document.getElementById(id).addEventListener('click', e => { const r = e.target.closest('[data-row]'); if (r) { select(r.dataset.row, true); showChart(); } });
  }
  E.analysisFooter(S);

  function refresh() { renderTargets(); renderTables(); if (st.sel && !isVisible(st.sel)) select(null, false); else if (st.sel) showDetail(byId.get(st.sel)); draw(); }
  function isVisible(id) {
    const e = byId.get(id);
    if (!e) return false;
    if (e.kind === 'hulk') return hulkVisible(e.item);
    if (e.kind === 'sweep') return sweepVisible(e.item);
    if (e.kind === 'vertex') return e.item.refs.some(refVisible);
    if (e.kind === 'open') return openVisible(e.item);
    return true;
  }

  refresh();
  setInterval(() => { if (live()) { planetCache.key = null; renderTargets(); draw(); } }, 600000);
  const start = decodeURIComponent(location.hash.slice(1));
  if (start && byId.has(start)) select(start, true);
})();
