/* Heliocentric planet positions in game coordinates, computed in the browser for any date.

   Orbits: JPL "Approximate Positions of the Planets" (E. M. Standish), Keplerian elements and rates
   for 1800-2050, J2000 ecliptic. Game mapping (the one the UnderPunks bot reproduces):
     Oc = floor(heliocentric ecliptic longitude / 30°) + 1
     Rc = floor(distance in the ecliptic plane, in miles / 3,000,000)
   Checked against 36 positions read in #spacecraft (35 identical; the game seems to refresh with a delay). */
(function (root) {
  const D = Math.PI / 180;
  const MILES_PER_AU = 149597870.7 * 0.621371;
  const SL_PER_AU = MILES_PER_AU / 3e6;
  // name: [a, e, I, L, long. perihelion, long. node] then rates per Julian century
  const ELEMENTS = {
    Mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593], [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
    Venus: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255], [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
    Earth: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0], [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
    Mars: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891], [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
    Jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
    Saturn: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
    Uranus: [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503], [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
    Neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
  };
  const NAMES = Object.keys(ELEMENTS);

  function xyz(name, date) {
    const T = (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525;
    const [el, rate] = ELEMENTS[name];
    const [a, e, I, L, wbar, node] = el.map((v, i) => v + rate[i] * T);
    const w = wbar - node;
    let M = ((L - wbar) % 360 + 540) % 360 - 180;
    M *= D;
    let E = M + e * Math.sin(M);
    for (let i = 0; i < 12; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const cw = Math.cos(w * D), sw = Math.sin(w * D), cO = Math.cos(node * D), sO = Math.sin(node * D), cI = Math.cos(I * D), sI = Math.sin(I * D);
    return {
      x: (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
      y: (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
      z: sw * sI * xp + cw * sI * yp,
    };
  }

  /* Game position of `name` at `date`: lon (deg, ecliptic), sl (exact), oc and rc as the game shows them. */
  function position(name, date) {
    const p = xyz(name, date);
    const lon = ((Math.atan2(p.y, p.x) / D) % 360 + 360) % 360;
    const sl = Math.hypot(p.x, p.y) * SL_PER_AU;
    return {name, lon, sl, oc: Math.floor(lon / 30) + 1, rc: Math.floor(sl)};
  }

  /* Next change of sector after `date` (day steps, then bisection), searched up to `days` ahead. */
  function nextSectorChange(name, date, days = 1500) {
    const oc0 = position(name, date).oc;
    let lo = date.getTime(), hi = null;
    for (let d = 1; d <= days; d++) {
      const t = date.getTime() + d * 86400000;
      if (position(name, new Date(t)).oc !== oc0) { hi = t; break; }
      lo = t;
    }
    if (hi === null) return null;
    while (hi - lo > 60000) {
      const mid = (lo + hi) / 2;
      if (position(name, new Date(mid)).oc !== oc0) hi = mid; else lo = mid;
    }
    return {date: new Date(hi), oc: position(name, new Date(hi + 1000)).oc};
  }

  const api = {NAMES, position, nextSectorChange, SL_PER_AU};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ESSI_PLANETS = api;
})(typeof window !== 'undefined' ? window : globalThis);
