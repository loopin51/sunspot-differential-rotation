// ===== Solar differential-rotation pipeline (shared by embedded & live modes) =====
const OMEGA_C = 14.1844;          // deg/day, sidereal Carrington rotation rate

function median(a) {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// raw events [{ar, time(ms), stonyLon, lat, carrLon}] -> daily rows [[ar,date,stonyLon,lat,carrLon,n]]
function aggregateDaily(events) {
  const groups = new Map();
  for (const e of events) {
    if (e.ar == null || !isFinite(e.lat) || !isFinite(e.carrLon)) continue;
    if (Math.abs(e.stonyLon) > 60) continue; // limb cut
    const date = new Date(e.time).toISOString().slice(0, 10);
    const k = e.ar + "|" + date;
    if (!groups.has(k)) groups.set(k, { ar: e.ar, date, s: [], l: [], c: [] });
    const g = groups.get(k);
    g.s.push(e.stonyLon); g.l.push(e.lat); g.c.push(e.carrLon);
  }
  return [...groups.values()]
    .map(g => [g.ar, g.date, median(g.s), median(g.l), median(g.c), g.s.length])
    .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
}

function unwrapDeg(lons) {
  const out = [lons[0]];
  for (let i = 1; i < lons.length; i++) {
    let d = lons[i] - lons[i - 1];
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    out.push(out[i - 1] + d);
  }
  return out;
}

function linfit(x, y) { // least squares y = a + b x
  const n = x.length, mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  const b = sxy / sxx, a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (y[i] - a - b * x[i]) ** 2;
  return { a, b, rms: Math.sqrt(ss / n) };
}

// daily rows -> per-AR tracks with rotation rates
// coord = "hgc": fit the Carrington longitude drift; Omega_sid = 14.1844 + slope.
// coord = "hgs": fit the Stonyhurst (hgs_x) longitude drift directly; Omega = slope.
//                No Earth-orbital correction is applied, so this is the raw
//                synodic (Earth-observed) drift rate, not a sidereal rate.
function fitTracks(daily, screenSet, coord = "hgc") {
  const byAR = new Map();
  for (const r of daily) {
    if (!byAR.has(r[0])) byAR.set(r[0], []);
    byAR.get(r[0]).push(r);
  }
  const t0 = Math.min(...daily.map(r => Date.parse(r[1])));
  const tracks = [];
  for (const [ar, rows] of byAR) {
    rows.sort((a, b) => (a[1] < b[1] ? -1 : 1));
    if (rows.length < 3) continue;
    const days = rows.map(r => (Date.parse(r[1]) - t0) / 86400e3);
    const span = days[days.length - 1] - days[0];
    if (span < 2) continue;
    // Carrington longitude (r[4]) needs 360° unwrapping; Stonyhurst longitude
    // (r[2]) stays within one disk passage (|lon|<=60), so no unwrap.
    const lon = coord === "hgs" ? rows.map(r => r[2]) : unwrapDeg(rows.map(r => r[4]));
    const f = linfit(days, lon);
    const omega = coord === "hgs" ? f.b : OMEGA_C + f.b;
    const meanLat = rows.reduce((s, r) => s + r[3], 0) / rows.length;
    tracks.push({
      ar, meanLat, nDays: rows.length, span, coord,
      slope: f.b, intercept: f.a, omega, rms: f.rms,
      onScreen: screenSet.has(ar), rows, days, lonSeries: lon, t0,
    });
  }
  return tracks.sort((a, b) => a.meanLat - b.meanLat);
}

// weighted least squares for Omega = A + B sin^2(phi) (+ C sin^4)
function solveNormal(M, y, w) {
  const k = M[0].length, A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let i = 0; i < M.length; i++) {
    for (let p = 0; p < k; p++) {
      b[p] += w[i] * M[i][p] * y[i];
      for (let q = 0; q < k; q++) A[p][q] += w[i] * M[i][p] * M[i][q];
    }
  }
  for (let col = 0; col < k; col++) { // gaussian elimination
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]]; [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = 0; r < k; r++) {
      if (r === col || A[r][col] === 0) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < k; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

function fitProfile(tracks, opts) {
  const { rmsMax = 1.0, minDays = 5, minSpan = 5 } = opts || {};
  const good = tracks.filter(t => t.rms <= rmsMax && t.nDays >= minDays && t.span >= minSpan);
  if (good.length < 3) return { good, fit2: null, fit3: null };
  const s2 = good.map(t => Math.sin(t.meanLat * Math.PI / 180) ** 2);
  const y = good.map(t => t.omega);
  const w = good.map(t => t.span / (t.rms + 0.1));
  const [A2, B2] = solveNormal(s2.map(v => [1, v]), y, w);
  // 3-term fit only with enough points and latitude coverage — otherwise the
  // sin^4 term is unconstrained and oscillates wildly (overfitting).
  let fit3 = null;
  const latMax = Math.max(...good.map(t => Math.abs(t.meanLat)));
  if (good.length >= 15 && latMax >= 22) {
    const [A3, B3, C3] = solveNormal(s2.map(v => [1, v, v * v]), y, w);
    if (Math.abs(C3) < 30) fit3 = { A: A3, B: B3, C: C3 };
  }
  const pred = s2.map(v => A2 + B2 * v);
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  const ssRes = y.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0);
  const ssTot = y.reduce((s, v) => s + (v - my) ** 2, 0);
  return { good, fit2: { A: A2, B: B2, r2: ssTot > 0 ? 1 - ssRes / ssTot : NaN }, fit3 };
}

if (typeof module !== "undefined") module.exports = { aggregateDaily, fitTracks, fitProfile, unwrapDeg, median, OMEGA_C };
