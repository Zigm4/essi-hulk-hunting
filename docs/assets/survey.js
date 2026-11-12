/* ESSI survey helpers shared by every page: data loading, solar geometry, formatting. */
(function () {
  const QUALITIES = ['PURPLE', 'PINK', 'GREEN', 'BLUE', 'RED', 'WHITE', 'BLACK'];   // loot box order (dev notice)

  async function load() {
    const res = await fetch('data/survey.json', {cache: 'no-cache'});
    if (!res.ok) throw new Error(`survey.json: HTTP ${res.status}`);
    const s = await res.json();
    s.hulks.forEach((h, i) => {
      h.id = h.code || h.cipher || `hulk-${i}`;
      h.time = h.decoded || h.completed;
      h.pos = h.exact ? {oc: h.exact[0], rc: h.exact[1], exact: true} : centroid(h.vertices);
    });
    s.scans.forEach((x, i) => { x.id = `sweep-${i + 1}`; });
    return s;
  }

  // Oc 1 at the top, Oc increasing anticlockwise (lever .51). World units = Rc (SL).
  const angle = oc => (90 + (oc - 1) * 30) * Math.PI / 180;
  const toXY = (oc, rc) => ({x: rc * Math.cos(angle(oc)), y: -rc * Math.sin(angle(oc))});
  function toPolar(x, y) {
    const a = Math.atan2(-y, x) * 180 / Math.PI;
    const oc = ((Math.round((a - 90) / 30) % 12) + 12) % 12 + 1;
    return {oc, rc: Math.hypot(x, y), deg: a};
  }
  function centroid(vertices) {
    if (!vertices || !vertices.length) return null;
    const pts = vertices.map(([o, r]) => toXY(o, r));
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length, y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const p = toPolar(x, y);
    return {oc: p.oc, rc: Math.round(p.rc), exact: false};
  }

  const qColor = q => `var(--q-${QUALITIES.includes(q) ? q : 'UNKNOWN'})`;
  const qStroke = q => (q === 'BLACK' ? 'var(--t-BLACK)' : qColor(q));
  const pad = n => String(n).padStart(2, '0');
  function fmtTime(iso, withYear) {
    if (!iso) return '-';
    const d = new Date(iso);
    const day = `${withYear ? d.getFullYear() + '-' : ''}${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const fmtPos = p => (p ? `Oc ${p.oc} / Rc ${p.rc}` : '-');
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

  function stamp(s) {
    const el = document.getElementById('sync');
    if (el) el.innerHTML = `DATA SYNC <b>${fmtTime(s.coverage.to, true)}</b> · ${s.coverage.messages.toLocaleString('en')} msgs`;
  }

  /* Footer line shared by every page: when the survey was last analysed and how far the channel was read. */
  function analysisFooter(s) {
    const el = document.getElementById('analysis');
    if (el) el.innerHTML = `LAST ANALYSIS <b>${fmtTime(s.generated, true)}</b> · channel read up to ${fmtTime(s.coverage.to, true)} · archive since ${fmtTime(s.coverage.from, true)} · ${s.coverage.messages.toLocaleString('en')} messages · times in your local zone`;
  }

  /* Theme picker: data-skin on <html>, remembered per browser (also ?skin=name in the address). */
  function initSkins() {
    const root = document.documentElement;
    const buttons = [...document.querySelectorAll('.skins button[data-skin]')];
    const mark = () => { const cur = root.dataset.skin || 'terminal'; buttons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.skin === cur))); };
    buttons.forEach(b => b.addEventListener('click', () => {
      root.dataset.skin = b.dataset.skin;
      try { localStorage.setItem('essi-skin', b.dataset.skin); } catch (_) { /* storage blocked */ }
      mark();
      window.dispatchEvent(new Event('essi-skin'));
    }));
    mark();
  }
  initSkins();

  window.ESSI = {load, angle, toXY, toPolar, centroid, qColor, qStroke, QUALITIES, fmtTime, fmtPos, esc, stamp, analysisFooter};
})();
