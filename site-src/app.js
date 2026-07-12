const DATA = JSON.parse(document.getElementById("embedded-data").textContent);
const SCREEN = new Set(DATA.screen);
const SNOD = phi => 14.71 - 2.39 * Math.sin(phi) ** 2 - 1.78 * Math.sin(phi) ** 4;
const $ = id => document.getElementById(id);

// ---------- raw detections + source selection ----------
// Each detection carries its source (src index into DATA.srcNames). The daily
// median aggregation happens in-browser AFTER the source filter, so switching
// sources genuinely re-derives every daily position (median over the selected
// sources only), not just a display toggle.
const SRC_NAMES = DATA.srcNames; // ["HMI SHARP", "NOAA SWPC Observer"]
const DET = DATA.det.map(d => ({ ar: d[0], date: d[1], stonyLon: d[2], lat: d[3], carrLon: d[4], src: d[5] }));
// srcMode -> Set of allowed src indices (null = all sources)
const SRC_SETS = { both: null, hmi: new Set([0]), noaa: new Set([1]) };
const _dailyCache = new Map(); // srcMode -> daily rows (aggregation only depends on source)
function dailyForMode(mode) {
  if (!_dailyCache.has(mode)) _dailyCache.set(mode, aggregateDaily(DET, SRC_SETS[mode]));
  return _dailyCache.get(mode);
}
// full-data daily (both sources) — drives the stable, source-independent UI
// bounds: selectable date range, AR list, and the hgc reference longitudes.
const ALL_DAILY = dailyForMode("both");
const DATA_MIN = ALL_DAILY.reduce((m, r) => r[1] < m ? r[1] : m, ALL_DAILY[0][1]);
const DATA_MAX = ALL_DAILY.reduce((m, r) => r[1] > m ? r[1] : m, ALL_DAILY[0][1]);
const ALL_ARS = [...new Set(ALL_DAILY.map(r => r[0]))].sort((a, b) => a - b);

// ---------- hgc (Carrington 경도) 일치 표시 ----------
// 화면 AR(Helioviewer 11개) 각각이 2026-05-29 무렵 가졌던 hgc(Carrington 경도) 값을 기준으로,
// 데이터 전체에서 그 값과 ±허용오차 안에 드는 모든 행(같은 AR·다른 AR, 어떤 날짜든 무관)을 표시.
// 순수하게 hgc 컬럼 값만 비교 — 날짜·자전주기는 고려하지 않음. 기준값은 소스 선택과
// 무관하게 안정적으로 두기 위해 전체(both) 집계에서 계산.
const REF_DATE = "2026-05-29";
const circDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const SCREEN_REF_LON = new Map(); // ar -> hgc(Carrington 경도) near 2026-05-29
for (const ar of SCREEN) {
  const rows = ALL_DAILY.filter(r => r[0] === ar);
  if (!rows.length) continue;
  const best = rows.reduce((a, b) =>
    Math.abs(Date.parse(b[1]) - Date.parse(REF_DATE)) < Math.abs(Date.parse(a[1]) - Date.parse(REF_DATE)) ? b : a);
  SCREEN_REF_LON.set(ar, ((best[4] % 360) + 360) % 360);
}
function matchedScreenARs(carrLon, tolDeg) {
  const lon = ((carrLon % 360) + 360) % 360;
  const out = [];
  for (const [ar, ref] of SCREEN_REF_LON) if (circDist(lon, ref) <= tolDeg) out.push(ar);
  return out;
}

const state = {
  dateStart: DATA_MIN, dateEnd: DATA_MAX,
  rmsMax: 1.0, rmsOn: false, minDays: 5,
  selected: new Set(ALL_ARS), // active regions to process (default: all)
  coord: "hgs", // 회전 분석 좌표계: "hgc"(Carrington) | "hgs"(Stonyhurst)
  srcMode: "both", // 데이터 소스: "both" | "hmi" | "noaa"
  retTol: 5, // hgc(Carrington 경도) 일치 허용오차, deg
  excluded: new Map(), // ar -> Set(date) 사용자가 선형 피팅에서 제외한 일별 점
  mapIdx: -1, playing: null,
};

// effective RMS cut passed to fitProfile (Infinity = filter disabled)
const effRms = () => (state.rmsOn ? state.rmsMax : Infinity);

// ---------- derived model ----------
let M = null;
function recompute() {
  const src = dailyForMode(state.srcMode); // daily rows aggregated over selected source(s)
  let daily = src.filter(r =>
    r[1] >= state.dateStart && r[1] <= state.dateEnd && state.selected.has(r[0]));
  const tracks = daily.length ? fitTracks(daily, SCREEN, state.coord, state.excluded) : [];
  const prof = fitProfile(tracks, { rmsMax: effRms(), minDays: state.minDays });
  const goodSet = new Set(prof.good.map(t => t.ar));
  const dates = [...new Set(daily.map(r => r[1]))].sort();
  M = { daily, tracks, prof, goodSet, dates };
}

// active regions that pass the quality filter across the current date window,
// ignoring the current selection (used by the "필터 통과" preset)
function goodARsInWindow() {
  const daily = dailyForMode(state.srcMode).filter(r => r[1] >= state.dateStart && r[1] <= state.dateEnd);
  if (!daily.length) return new Set();
  const prof = fitProfile(fitTracks(daily, SCREEN, state.coord, state.excluded), { rmsMax: effRms(), minDays: state.minDays });
  return new Set(prof.good.map(t => t.ar));
}

// ---------- svg helpers ----------
const NS = "http://www.w3.org/2000/svg";
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function niceTicks(lo, hi, n = 6) {
  const span = hi - lo, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n + 1) || mag * 10;
  const t = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) t.push(+v.toFixed(10));
  return t;
}
function baseChart(box, opts) {
  box.textContent = "";
  const W = Math.max(320, box.clientWidth), H = opts.h || 400;
  const m = Object.assign({ t: 16, r: 18, b: 44, l: 56 }, opts.m);
  const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img" }, box);
  if (opts.title) svg.setAttribute("aria-label", opts.title);
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const [x0, x1] = opts.x, [y0, y1] = opts.y;
  const X = v => m.l + (v - x0) / (x1 - x0) * iw;
  const Y = v => m.t + ih - (v - y0) / (y1 - y0) * ih;
  const css = v => getComputedStyle(document.body).getPropertyValue(v).trim();
  // grid + ticks
  const xt = opts.xTicks || niceTicks(x0, x1), yt = opts.yTicks || niceTicks(y0, y1);
  for (const v of yt) {
    el("line", { x1: m.l, x2: m.l + iw, y1: Y(v), y2: Y(v), stroke: css("--grid"), "stroke-width": 1 }, svg);
    el("text", { x: m.l - 9, y: Y(v) + 4, "text-anchor": "end", "font-size": 11.5,
      fill: css("--muted"), style: "font-variant-numeric:tabular-nums" }, svg)
      .textContent = opts.yFmt ? opts.yFmt(v) : v;
  }
  for (const v of xt) {
    el("line", { x1: X(v), x2: X(v), y1: m.t, y2: m.t + ih, stroke: css("--grid"), "stroke-width": 1 }, svg);
    el("text", { x: X(v), y: m.t + ih + 18, "text-anchor": "middle", "font-size": 11.5,
      fill: css("--muted"), style: "font-variant-numeric:tabular-nums" }, svg)
      .textContent = opts.xFmt ? opts.xFmt(v) : v;
  }
  el("line", { x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih, stroke: css("--baseline"), "stroke-width": 1 }, svg);
  if (opts.xLabel) el("text", { x: m.l + iw / 2, y: H - 8, "text-anchor": "middle", "font-size": 12, fill: css("--ink2") }, svg).textContent = opts.xLabel;
  if (opts.yLabel) {
    const t = el("text", { x: 0, y: 0, "text-anchor": "middle", "font-size": 12, fill: css("--ink2"),
      transform: `translate(14 ${m.t + ih / 2}) rotate(-90)` }, svg);
    t.textContent = opts.yLabel;
  }
  return { svg, X, Y, m, iw, ih, css, W, H };
}
function curvePath(c, f, x0, x1, n = 160) {
  let d = "";
  for (let i = 0; i <= n; i++) {
    const x = x0 + (x1 - x0) * i / n, y = f(x);
    d += (i ? "L" : "M") + c.X(x).toFixed(1) + " " + c.Y(y).toFixed(1);
  }
  return d;
}
function makeTooltip(box) {
  let tt = box.querySelector(".tooltip");
  if (!tt) { tt = document.createElement("div"); tt.className = "tooltip"; box.appendChild(tt); }
  return {
    show(px, py, title, rows) {
      tt.textContent = "";
      const h = document.createElement("div"); h.className = "tt-title"; h.textContent = title; tt.appendChild(h);
      for (const [l, v] of rows) {
        const r = document.createElement("div"); r.className = "row";
        const a = document.createElement("span"); a.className = "l"; a.textContent = l;
        const b = document.createElement("span"); b.className = "v"; b.textContent = v;
        r.append(a, b); tt.appendChild(r);
      }
      tt.style.display = "block";
      const bw = box.clientWidth, tw = tt.offsetWidth;
      tt.style.left = Math.min(px + 14, bw - tw - 6) + "px";
      tt.style.top = Math.max(4, py - tt.offsetHeight - 12) + "px";
    },
    hide() { tt.style.display = "none"; },
  };
}
function legendHTML(node, items) {
  node.textContent = "";
  for (const it of items) {
    const k = document.createElement("span"); k.className = "k";
    const s = document.createElement("span");
    if (it.type === "dot") { s.className = "dot"; s.style.background = it.color; }
    else { s.className = "ln" + (it.type === "dash" ? " dash" : it.type === "dot3" ? " dot3" : ""); s.style.borderTopColor = it.color; }
    const t = document.createElement("span"); t.textContent = it.label;
    k.append(s, t); node.appendChild(k);
  }
}
const fmt = (v, d = 2) => v == null || !isFinite(v) ? "–" : v.toFixed(d);

// ---------- KPI tiles ----------
function renderTiles() {
  const { prof, tracks } = M, f2 = prof.fit2;
  const tiles = [
    ["적도 회전율 A", f2 ? fmt(f2.A) : "–", "°/일", f2 ? `회전주기 ${fmt(360 / f2.A, 1)}일 (${state.coord === "hgs" ? "삭망" : "항성"})` : "피팅 불가"],
    ["차등 계수 B", f2 ? fmt(f2.B) : "–", "°/일", "Ω = A + B·sin²φ"],
    ["사용 활성영역", `${prof.good.length}`, `/ ${tracks.length}`, "품질 필터 통과 / 전체 추적"],
    ["피팅 R²", f2 ? fmt(f2.r2) : "–", "", "가중 최소제곱 (2항)"],
    ["문헌값 (S&U 1990)", "14.71", "°/일", "− 2.39sin²φ − 1.78sin⁴φ"],
  ];
  const host = $("tiles"); host.textContent = "";
  for (const [lab, val, unit, note] of tiles) {
    const d = document.createElement("div"); d.className = "tile";
    const l = document.createElement("div"); l.className = "lab"; l.textContent = lab;
    const v = document.createElement("div"); v.className = "val"; v.textContent = val;
    const u = document.createElement("span"); u.className = "unit"; u.textContent = unit; v.appendChild(u);
    const n = document.createElement("div"); n.className = "note"; n.textContent = note;
    d.append(l, v, n); host.appendChild(d);
  }
}

// ---------- rotation chart ----------
function renderRotation() {
  const box = $("rotChart"), { prof, tracks, goodSet } = M;
  const isHgsMode = state.coord === "hgs";
  $("rotDesc").textContent = isHgsMode
    ? "각 점은 활성영역 하나 — Stonyhurst(hgs_x) 경도의 시간 변화 기울기를 보정 없이 그대로 쓴 삭망(지구 관측) 회전율입니다. 점 크기는 추적 신뢰도(기간/RMS)."
    : "각 점은 활성영역 하나 — Carrington(hgc) 경도 표류율로 구한 항성 회전율입니다. 점 크기는 추적 신뢰도(기간/RMS).";
  const pts = tracks.filter(t => goodSet.has(t.ar));
  if (!pts.length) {
    box.textContent = "";
    const msg = document.createElement("p");
    msg.style.cssText = "color:var(--muted);padding:40px 0;text-align:center";
    msg.textContent = "선택한 기간·활성영역·필터에 해당하는 추적이 없습니다 — 기간을 넓히거나, 활성영역 선택·품질 필터를 완화해 보세요.";
    box.appendChild(msg);
    legendHTML($("rotLegend"), []);
    return;
  }
  // y-domain follows the INCLUDED points + reference curves; excluded points
  // are drawn only if they fall inside (outliers live in the table view).
  const allO = pts.map(p => p.omega).concat([13.2, 14.8]);
  const y0 = Math.min(...allO) - 0.3, y1 = Math.max(...allO) + 0.35;
  const cut = tracks.filter(t => !goodSet.has(t.ar) && t.omega > y0 && t.omega < y1);
  const c = baseChart(box, { h: 440, x: [-40, 40], y: [y0, y1],
    xLabel: "태양 위도 φ (deg)", yLabel: isHgsMode ? "삭망 회전 각속도 Ω (deg/day)" : "항성 회전 각속도 Ω (deg/day)",
    yFmt: v => v.toFixed(1), title: "위도별 회전 각속도" });
  const d2r = Math.PI / 180;
  el("path", { d: curvePath(c, x => SNOD(x * d2r), -40, 40), fill: "none",
    stroke: c.css("--c-ref"), "stroke-width": 2, "stroke-dasharray": "7 5" }, c.svg);
  const f2 = prof.fit2, f3 = prof.fit3;
  if (f3) el("path", { d: curvePath(c, x => f3.A + f3.B * Math.sin(x * d2r) ** 2 + f3.C * Math.sin(x * d2r) ** 4, -40, 40),
    fill: "none", stroke: c.css("--c-fit3"), "stroke-width": 2.5, "stroke-dasharray": "2 5", "stroke-linecap": "round" }, c.svg);
  if (f2) el("path", { d: curvePath(c, x => f2.A + f2.B * Math.sin(x * d2r) ** 2, -40, 40),
    fill: "none", stroke: c.css("--c-fit2"), "stroke-width": 2.5 }, c.svg);
  // excluded (faint hollow)
  for (const t of cut) el("circle", { cx: c.X(t.meanLat), cy: c.Y(t.omega), r: 3.5, fill: "none",
    stroke: c.css("--muted"), "stroke-width": 1.2, opacity: 0.55 }, c.svg);
  // included points
  const ws = pts.map(t => t.span / (t.rms + 0.1)), wMin = Math.min(...ws), wMax = Math.max(...ws);
  const R = w => 4.5 + (wMax > wMin ? (w - wMin) / (wMax - wMin) : 0.5) * 4.5;
  const hitPts = [];
  for (const t of pts) {
    const r = R(t.span / (t.rms + 0.1));
    el("circle", { cx: c.X(t.meanLat), cy: c.Y(t.omega), r,
      fill: t.onScreen ? c.css("--c-screen") : c.css("--c-other"),
      stroke: c.css("--surface"), "stroke-width": 2 }, c.svg);
    hitPts.push({ x: c.X(t.meanLat), y: c.Y(t.omega), t, r });
  }
  // selective labels: screen ARs only, greedy collision dodge (above / below / above-higher)
  const labs = pts.filter(t => t.onScreen).sort((a, b) => a.meanLat - b.meanLat);
  const placed = [];
  for (const t of labs) {
    const x = c.X(t.meanLat), py = c.Y(t.omega);
    let y = null;
    for (const dy of [-14, 26, -30, 42]) {
      const cand = py + dy;
      if (!placed.some(p => Math.abs(p.x - x) < 46 && Math.abs(p.y - cand) < 13)) { y = cand; break; }
    }
    if (y == null) continue; // give up: tooltip + table still carry it
    placed.push({ x, y });
    el("text", { x, y, "text-anchor": "middle",
      "font-size": 11, "font-weight": 600, fill: c.css("--ink2") }, c.svg).textContent = t.ar;
  }
  const legendItems = [
    { type: "dot", color: c.css("--c-screen"), label: "화면 표시 AR (Helioviewer 11개)" },
    { type: "dot", color: c.css("--c-other"), label: "기타 AR" },
  ];
  if (f2) legendItems.push({ type: "ln", color: c.css("--c-fit2"),
    label: `2항 피팅 Ω = ${fmt(f2.A)} ${f2.B < 0 ? "−" : "+"} ${fmt(Math.abs(f2.B))}·sin²φ` });
  if (f3) legendItems.push({ type: "dot3", color: c.css("--c-fit3"),
    label: `3항 피팅 (…${f3.C < 0 ? "−" : "+"} ${fmt(Math.abs(f3.C))}·sin⁴φ)` });
  legendItems.push({ type: "dash", color: c.css("--c-ref"), label: "Snodgrass & Ulrich 1990 (문헌값, 항성 기준)" });
  legendHTML($("rotLegend"), legendItems);
  // nearest-point hover
  const tt = makeTooltip(box);
  c.svg.addEventListener("pointermove", ev => {
    const b = c.svg.getBoundingClientRect(), px = ev.clientX - b.left, py = ev.clientY - b.top;
    let best = null, bd = 30;
    for (const p of hitPts) { const d = Math.hypot(p.x - px, p.y - py); if (d < bd) { bd = d; best = p; } }
    if (!best) return tt.hide();
    const t = best.t;
    tt.show(best.x, best.y, `NOAA ${t.ar}${t.onScreen ? " · 화면 AR" : ""}`, [
      ["위도", fmt(t.meanLat, 1) + "°"], [`Ω (${t.coord === "hgs" ? "삭망" : "항성"})`, fmt(t.omega, 3) + " °/일"],
      ["회전주기", fmt(360 / t.omega, 1) + " 일"], ["관측", `${t.nDays}일 / ${fmt(t.span, 0)}일간`],
      ["피팅 RMS", fmt(t.rms, 2) + "°"],
    ]);
  });
  c.svg.addEventListener("pointerleave", () => tt.hide());
}

// ---------- fit-point selection (per-AR, affects that AR's linear fit) ----------
function toggleFitPoint(ar, date) {
  if (!state.excluded.has(ar)) state.excluded.set(ar, new Set());
  const s = state.excluded.get(ar);
  if (s.has(date)) s.delete(date); else s.add(date);
  if (!s.size) state.excluded.delete(ar);
  rerenderAll();
}
function resetFitPoints(ar) {
  if (state.excluded.delete(ar)) rerenderAll();
}

// ---------- track charts ----------
function renderTrackSel() {
  const sel = $("trackSel"), { tracks, goodSet } = M;
  const prev = sel.value;
  sel.textContent = "";
  const sorted = [...tracks].sort((a, b) => (b.onScreen - a.onScreen) || (a.ar - b.ar));
  for (const t of sorted) {
    const o = document.createElement("option");
    o.value = t.ar;
    o.textContent = `NOAA ${t.ar}${t.onScreen ? " ●화면" : ""}${goodSet.has(t.ar) ? "" : " (필터 제외)"}`;
    sel.appendChild(o);
  }
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}
function renderTrack() {
  const { tracks } = M, ar = +$("trackSel").value;
  $("trackDesc").textContent = state.coord === "hgs"
    ? "Stonyhurst(hgs) 경도의 시간 변화 기울기를 보정 없이 그대로 Ω로 씁니다 (지구 공전 보정 없음, 삭망 회전율)."
    : "Carrington(hgc) 경도의 시간 변화 기울기가 곧 차등회전 신호입니다 (기울기 + 14.1844 = Ω).";
  const t = tracks.find(x => x.ar === ar);
  const box1 = $("trackChart1"), box2 = $("trackChart2");
  if (!t) { box1.textContent = ""; box2.textContent = ""; $("trackStats").textContent = "데이터 없음"; return; }
  const fitNote = t.nFit < t.nDays ? ` · 피팅에 ${t.nFit}/${t.nDays}개 점 사용` : "";
  $("trackStats").textContent =
    `평균 위도 ${fmt(t.meanLat, 1)}° · Ω = ${fmt(t.omega, 3)} °/일 · 회전주기 ${fmt(360 / t.omega, 1)}일 · RMS ${fmt(t.rms, 2)}°${fitNote}`;
  const days = t.days, dsMin = Math.min(...days), dsMax = Math.max(...days);
  const dateOf = d => new Date(t.t0 + d * 86400e3).toISOString().slice(5, 10);
  const xt = niceTicks(dsMin, dsMax, 7).filter(v => v >= dsMin - 1e-9 && v <= dsMax + 1e-9);
  // chart 1: longitude series used for the fit (hgc unwrapped, or hgs)
  const isHgs = t.coord === "hgs";
  const lonName = isHgs ? "Stonyhurst(hgs) 경도" : "Carrington(hgc) 경도";
  const lc = t.lonSeries, lo = Math.min(...lc), hi = Math.max(...lc), pad = Math.max(1.2, (hi - lo) * 0.18);
  const c1 = baseChart(box1, { h: 260, x: [dsMin - 0.5, dsMax + 0.5], y: [lo - pad, hi + pad],
    xTicks: xt, xFmt: dateOf, yFmt: v => v.toFixed(0),
    xLabel: "날짜 (UTC)", yLabel: lonName + " (deg)", title: lonName + " 추적" });
  el("path", { d: `M${c1.X(dsMin)} ${c1.Y(t.intercept + t.slope * dsMin)} L${c1.X(dsMax)} ${c1.Y(t.intercept + t.slope * dsMax)}`,
    stroke: c1.css("--c-fit2"), "stroke-width": 2, fill: "none" }, c1.svg);
  const hp1 = [];
  const color1 = t.onScreen ? c1.css("--c-screen") : c1.css("--c-other");
  days.forEach((d, i) => {
    const included = t.fitIdx.has(i);
    el("circle", included
      ? { cx: c1.X(d), cy: c1.Y(lc[i]), r: 4.5, fill: color1,
          stroke: c1.css("--surface"), "stroke-width": 2,
          style: "cursor:pointer", "data-i": i, class: "trkpt" }
      : { cx: c1.X(d), cy: c1.Y(lc[i]), r: 5.5, fill: "none",
          stroke: color1, "stroke-width": 2, "stroke-dasharray": "2 2", opacity: 0.6,
          style: "cursor:pointer", "data-i": i, class: "trkpt" }, c1.svg);
    hp1.push({ x: c1.X(d), y: c1.Y(lc[i]), i });
  });
  c1.svg.addEventListener("click", ev => {
    const c = ev.target.closest("circle.trkpt"); if (!c) return;
    toggleFitPoint(t.ar, t.rows[+c.dataset.i][1]);
  });
  el("text", { x: c1.X(dsMax), y: c1.Y(t.intercept + t.slope * dsMax) - 10, "text-anchor": "end",
    "font-size": 11.5, "font-weight": 600, fill: c1.css("--ink2") }, c1.svg)
    .textContent = isHgs
      ? `기울기 ${fmt(t.slope, 3)} °/일 = Ω = ${fmt(t.omega, 3)}`
      : `기울기 ${t.slope >= 0 ? "+" : ""}${fmt(t.slope, 3)} °/일 + 14.184 → Ω = ${fmt(t.omega, 3)}`;
  // chart 2: latitude
  const lats = t.rows.map(r => r[3]), la = Math.min(...lats), lb = Math.max(...lats), lp = Math.max(0.8, (lb - la) * 0.35);
  const c2 = baseChart(box2, { h: 200, x: [dsMin - 0.5, dsMax + 0.5], y: [la - lp, lb + lp],
    xTicks: xt, xFmt: dateOf, yFmt: v => v.toFixed(1),
    xLabel: "날짜 (UTC)", yLabel: "위도 (deg)", title: "위도 추적" });
  let pd = "";
  days.forEach((d, i) => { pd += (i ? "L" : "M") + c2.X(d).toFixed(1) + " " + c2.Y(lats[i]).toFixed(1); });
  el("path", { d: pd, fill: "none", stroke: t.onScreen ? c2.css("--c-screen") : c2.css("--c-other"),
    "stroke-width": 2, "stroke-linejoin": "round", opacity: 0.55 }, c2.svg);
  days.forEach((d, i) => el("circle", { cx: c2.X(d), cy: c2.Y(lats[i]), r: 4,
    fill: t.onScreen ? c2.css("--c-screen") : c2.css("--c-other"),
    stroke: c2.css("--surface"), "stroke-width": 2 }, c2.svg));
  const trackLegendItems = [
    { type: "dot", color: color1, label: `NOAA ${t.ar} 일별 위치(중앙값)` },
    { type: "ln", color: c1.css("--c-fit2"), label: "선형 피팅 (경도 표류)" },
  ];
  if (t.nFit < t.nDays) trackLegendItems.push({ type: "dot", color: color1, label: "빈 점 = 피팅에서 제외됨 (클릭해서 되돌리기)" });
  legendHTML($("trackLegend"), trackLegendItems);
  // hover for chart1
  const tt = makeTooltip(box1);
  c1.svg.addEventListener("pointermove", ev => {
    const b = c1.svg.getBoundingClientRect(), px = ev.clientX - b.left, py = ev.clientY - b.top;
    let best = null, bd = 28;
    for (const p of hp1) { const d = Math.hypot(p.x - px, p.y - py); if (d < bd) { bd = d; best = p; } }
    if (!best) return tt.hide();
    const i = best.i, r = t.rows[i];
    tt.show(best.x, best.y, r[1], [
      ["Carr. 경도", fmt(lc[i], 2) + "°"], ["Stonyhurst", fmt(r[2], 1) + "°"],
      ["위도", fmt(r[3], 2) + "°"], ["검출 수", r[5] + "회"],
    ]);
  });
  c1.svg.addEventListener("pointerleave", () => tt.hide());
}

// ---------- solar disk map ----------
function renderMapControls() {
  const { dates } = M, sl = $("mapDate");
  sl.max = Math.max(0, dates.length - 1);
  if (state.mapIdx < 0 || state.mapIdx >= dates.length) {
    const target = state.dateStart <= "2026-05-29" && "2026-05-29" <= state.dateEnd
      ? "2026-05-29" : dates[Math.floor(dates.length / 2)];
    state.mapIdx = Math.max(0, dates.indexOf(target));
  }
  sl.value = state.mapIdx;
  $("mapDateV").textContent = dates[state.mapIdx] || "–";
}
function renderMap() {
  const box = $("mapChart"), { daily, dates, goodSet } = M;
  const date = dates[state.mapIdx];
  $("mapDateV").textContent = date || "–";
  box.textContent = "";
  if (!date) return;
  const W = Math.max(320, box.clientWidth), H = 460, R = Math.min(W, H) / 2 - 28;
  const cx = W / 2, cy = H / 2;
  const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "태양면 지도 " + date }, box);
  const css = v => getComputedStyle(document.body).getPropertyValue(v).trim();
  el("circle", { cx, cy, r: R, fill: "none", stroke: css("--baseline"), "stroke-width": 1.5 }, svg);
  const d2r = Math.PI / 180;
  // latitude lines (straight — B0=0 approximation, edge-on circles) & central meridian
  for (const la of [-30, -15, 0, 15, 30]) {
    const y = cy - R * Math.sin(la * d2r), rx = R * Math.cos(la * d2r);
    el("line", { x1: cx - rx, x2: cx + rx, y1: y, y2: y,
      stroke: css("--grid"), "stroke-width": la === 0 ? 1.4 : 1 }, svg);
    el("text", { x: cx - rx - 7, y: y + 4, "text-anchor": "end", "font-size": 10.5, fill: css("--muted") }, svg).textContent = la + "°";
  }
  el("line", { x1: cx, x2: cx, y1: cy - R, y2: cy + R, stroke: css("--grid"), "stroke-width": 1 }, svg);
  el("text", { x: cx - R, y: cy + R + 20, "font-size": 11, fill: css("--muted") }, svg).textContent = "동 (E)";
  el("text", { x: cx + R, y: cy + R + 20, "text-anchor": "end", "font-size": 11, fill: css("--muted") }, svg).textContent = "서 (W)";
  const rows = daily.filter(r => r[1] === date);
  const tt = makeTooltip(box), hp = [], mplaced = [];
  const pos = rows.map(r => {
    const lon = r[2] * d2r, lat = r[3] * d2r;
    return { r, x: cx + R * Math.cos(lat) * Math.sin(lon), y: cy - R * Math.sin(lat), scr: SCREEN.has(r[0]) };
  }).sort((a, b) => a.x - b.x);
  for (const p of pos) {
    el("circle", { cx: p.x, cy: p.y, r: p.scr ? 7 : 5.5,
      fill: p.scr ? css("--c-screen") : css("--c-other"),
      stroke: css("--surface"), "stroke-width": 2, opacity: goodSet.has(p.r[0]) ? 1 : 0.5 }, svg);
    // label with greedy dodge; drop when crowded (tooltip carries it)
    let ly = null;
    for (const dy of [-11, 19, -24, 32]) {
      const cand = p.y + dy;
      if (!mplaced.some(q => Math.abs(q.x - p.x) < 38 && Math.abs(q.y - cand) < 11)) { ly = cand; break; }
    }
    if (ly != null) {
      mplaced.push({ x: p.x, y: ly });
      el("text", { x: p.x, y: ly, "text-anchor": "middle", "font-size": 9.5,
        fill: css(p.scr ? "--ink2" : "--muted"), "font-weight": p.scr ? 700 : 400 }, svg).textContent = p.r[0];
    }
    hp.push({ x: p.x, y: p.y, r: p.r });
  }
  legendHTML($("mapLegend"), [
    { type: "dot", color: css("--c-screen"), label: "화면 표시 AR" },
    { type: "dot", color: css("--c-other"), label: "기타 AR" },
  ]);
  svg.addEventListener("pointermove", ev => {
    const b = svg.getBoundingClientRect(), px = ev.clientX - b.left, py = ev.clientY - b.top;
    let best = null, bd = 26;
    for (const p of hp) { const d = Math.hypot(p.x - px, p.y - py); if (d < bd) { bd = d; best = p; } }
    if (!best) return tt.hide();
    const r = best.r;
    tt.show(best.x, best.y, `NOAA ${r[0]}`, [
      ["위도", fmt(r[3], 2) + "°"], ["Stonyhurst 경도", fmt(r[2], 2) + "°"],
      ["Carrington 경도", fmt(((r[4] % 360) + 360) % 360, 2) + "°"], ["검출 수", r[5] + "회"],
    ]);
  });
  svg.addEventListener("pointerleave", () => tt.hide());
}

// ---------- data table ----------
let tblSort = { key: "meanLat", dir: 1 };
function tableData() {
  const mode = document.querySelector("input[name=tblMode]:checked").value;
  if (mode === "rot") {
    const cols = [
      ["ar", "NOAA"], ["meanLat", "평균 위도(°)"], ["omega", "Ω (°/일)"], ["period", "회전주기(일)"],
      ["slope", "경도 표류(°/일)"], ["nDays", "관측일"], ["span", "기간(일)"], ["rms", "RMS(°)"], ["st", "상태"],
    ];
    const rows = M.tracks.map(t => ({
      ar: t.ar, meanLat: t.meanLat, omega: t.omega, period: 360 / t.omega, slope: t.slope,
      nDays: t.nDays, span: t.span, rms: t.rms,
      st: M.goodSet.has(t.ar) ? "포함" : "제외", _scr: t.onScreen, _cut: !M.goodSet.has(t.ar),
      _fitSel: t.nFit < t.nDays, _nFit: t.nFit,
    }));
    return { cols, rows, fmts: { meanLat: 1, omega: 3, period: 1, slope: 3, span: 0, rms: 2 } };
  }
  const arSel = $("tblAr").value;
  const cols = [["ar", "NOAA"], ["date", "날짜(UTC)"], ["lat", "위도(°)"], ["stonyLon", "Stonyhurst 경도(°)"],
    ["carrLon", "Carrington 경도(°)"], ["n", "검출 수"]];
  const rows = M.daily
    .filter(r => arSel === "all" || r[0] === +arSel)
    .map(r => {
      const matches = matchedScreenARs(r[4], state.retTol);
      return { ar: r[0], date: r[1], lat: r[3], stonyLon: r[2], carrLon: r[4], n: r[5],
        _scr: SCREEN.has(r[0]), _ret: matches.length > 0, _retArs: matches };
    });
  return { cols, rows, fmts: { lat: 2, stonyLon: 2, carrLon: 2 } };
}
function renderTable() {
  const { cols, rows, fmts } = tableData();
  const key = cols.some(c => c[0] === tblSort.key) ? tblSort.key : cols[0][0];
  rows.sort((a, b) => {
    const x = a[key], y = b[key];
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * tblSort.dir;
  });
  const tbl = $("tbl"); tbl.textContent = "";
  const thead = document.createElement("thead"), trh = document.createElement("tr");
  for (const [k, label] of cols) {
    const th = document.createElement("th");
    th.textContent = label + (k === key ? (tblSort.dir > 0 ? " ↑" : " ↓") : "");
    th.onclick = () => { tblSort = { key: k, dir: k === tblSort.key ? -tblSort.dir : 1 }; renderTable(); };
    trh.appendChild(th);
  }
  thead.appendChild(trh); tbl.appendChild(thead);
  const tb = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    const cls = [];
    if (r._scr) cls.push("screen");
    if (r._cut) cls.push("cut");
    if (r._ret) cls.push("ret");
    tr.className = cls.join(" ");
    if (r._ret) {
      tr.title = `hgc(Carrington 경도) 일치 (±${state.retTol}°): 화면 NOAA ${r._retArs.join(", ")}의 2026-05-29 hgc 값 부근`;
    }
    for (const [k] of cols) {
      const td = document.createElement("td");
      let v = r[k];
      if (typeof v === "number" && fmts[k] != null) v = v.toFixed(fmts[k]);
      if (k === "ar" && (r._scr || r._fitSel)) {
        td.textContent = v + " ";
        if (r._scr) {
          const s = document.createElement("span"); s.className = "tag scr"; s.textContent = "화면";
          td.appendChild(s); td.append(" ");
        }
        if (r._fitSel) {
          const s = document.createElement("span"); s.className = "tag fit"; s.textContent = "점선택";
          s.title = `사용자가 피팅 점을 선택함 — ${r._nFit}/${r.nDays}개 점으로 계산된 값 (AR 추적 탭에서 확인/초기화)`;
          td.appendChild(s);
        }
      } else if (k === "date" && r._ret) {
        td.textContent = v + " ";
        const s = document.createElement("span"); s.className = "tag ret"; s.textContent = "일치";
        td.appendChild(s);
      } else td.textContent = v;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
}
function renderTblAr() {
  const sel = $("tblAr"), prev = sel.value;
  sel.textContent = "";
  const all = document.createElement("option"); all.value = "all"; all.textContent = "전체"; sel.appendChild(all);
  for (const ar of [...new Set(M.daily.map(r => r[0]))].sort((a, b) => a - b)) {
    const o = document.createElement("option"); o.value = ar;
    o.textContent = "NOAA " + ar + (SCREEN.has(ar) ? " ●" : "");
    sel.appendChild(o);
  }
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}
function downloadCSV() {
  const { cols, rows, fmts } = tableData();
  const head = cols.map(c => c[1]).join(",");
  const body = rows.map(r => cols.map(([k]) => {
    let v = r[k];
    if (typeof v === "number" && fmts[k] != null) v = v.toFixed(fmts[k]);
    return v;
  }).join(",")).join("\n");
  const blob = new Blob(["﻿" + head + "\n" + body], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = document.querySelector("input[name=tblMode]:checked").value === "rot"
    ? "rotation_rates.csv" : "daily_positions.csv";
  a.click(); URL.revokeObjectURL(a.href);
}

// ---------- date-range filter (slices the embedded dataset) ----------
function initDateFilter() {
  for (const id of ["fStart", "fEnd"]) {
    $(id).min = DATA_MIN;
    $(id).max = DATA_MAX;
  }
  $("fStart").value = state.dateStart;
  $("fEnd").value = state.dateEnd;
}
function onDateChange() {
  let s = $("fStart").value || DATA_MIN, e = $("fEnd").value || DATA_MAX;
  // clamp into the stored range and keep start <= end
  if (s < DATA_MIN) s = DATA_MIN;
  if (e > DATA_MAX) e = DATA_MAX;
  if (s > e) { if (this && this.id === "fStart") e = s; else s = e; }
  state.dateStart = s; state.dateEnd = e;
  $("fStart").value = s; $("fEnd").value = e;
  state.mapIdx = -1; // re-anchor the map slider inside the new range
  rerenderAll();
}

// ---------- active-region selection ----------
function updateArCountLabel() {
  const n = state.selected.size, total = ALL_ARS.length;
  $("arSelCount").textContent = n === total ? "전체" : n === 0 ? "없음" : `${n}/${total}`;
  $("arPopCount").textContent = `${n} / ${total} 선택`;
}
function renderArPanel() {
  const grid = $("arGrid");
  grid.textContent = "";
  for (const ar of ALL_ARS) {
    const on = state.selected.has(ar), scr = SCREEN.has(ar);
    const chip = document.createElement("div");
    chip.className = "archip" + (on ? " on" : "") + (scr ? " scr" : "");
    chip.setAttribute("role", "checkbox");
    chip.setAttribute("aria-checked", on ? "true" : "false");
    const box = document.createElement("span"); box.className = "box";
    const lab = document.createElement("span"); lab.className = "noaa";
    lab.textContent = (scr ? "● " : "") + ar;
    chip.append(box, lab);
    chip.onclick = () => {
      if (state.selected.has(ar)) state.selected.delete(ar); else state.selected.add(ar);
      chip.classList.toggle("on");
      chip.setAttribute("aria-checked", state.selected.has(ar) ? "true" : "false");
      updateArCountLabel();
      rerenderAll();
    };
    grid.appendChild(chip);
  }
  updateArCountLabel();
}
function applyArPreset(kind) {
  if (kind === "all") state.selected = new Set(ALL_ARS);
  else if (kind === "none") state.selected = new Set();
  else if (kind === "screen") state.selected = new Set(ALL_ARS.filter(a => SCREEN.has(a)));
  else if (kind === "good") state.selected = goodARsInWindow();
  renderArPanel();
  rerenderAll();
}
function toggleArPop(open) {
  const pop = $("arPop");
  const show = open == null ? pop.hidden : open;
  pop.hidden = !show;
}

// ---------- orchestration ----------
function activeTab() { return document.querySelector(".tabs button.on").dataset.t; }
function renderActive() {
  const t = activeTab();
  if (t === "rotation") renderRotation();
  else if (t === "track") { renderTrackSel(); renderTrack(); }
  else if (t === "map") { renderMapControls(); renderMap(); }
  else if (t === "table") { renderTblAr(); renderTable(); }
}
const SRC_LABEL = { both: "HMI SHARP + NOAA SWPC Observer", hmi: "HMI SHARP", noaa: "NOAA SWPC Observer" };
function updateSrcLine() {
  const w = DATA.window;
  $("srcLine").textContent =
    `데이터: NASA HEK (${SRC_LABEL[state.srcMode]}) · 기간 ${w[0]} ~ ${w[1]} (2026-05-29 ±2개월)`;
}
function rerenderAll() { recompute(); updateSrcLine(); renderTiles(); renderActive(); }

$("tabs").addEventListener("click", ev => {
  const b = ev.target.closest("button"); if (!b) return;
  document.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("on", p.id === "p-" + b.dataset.t));
  renderActive();
});
$("fRms").addEventListener("input", () => { state.rmsMax = +$("fRms").value; $("fRmsV").textContent = state.rmsMax.toFixed(1); rerenderAll(); });
$("fRmsOn").addEventListener("change", () => {
  state.rmsOn = $("fRmsOn").checked;
  $("fRms").closest(".rmsf").classList.toggle("off", !state.rmsOn);
  rerenderAll();
});
$("fDays").addEventListener("input", () => { state.minDays = +$("fDays").value; $("fDaysV").textContent = state.minDays; rerenderAll(); });
$("fCoord").addEventListener("change", () => { state.coord = $("fCoord").value; rerenderAll(); });
$("fSrc").addEventListener("change", () => {
  state.srcMode = $("fSrc").value;
  // a manual fit-point selection may reference dates that no longer exist under
  // the new source — harmless (fitTracks ignores absent dates), but clear it so
  // the exclusion set doesn't silently apply to a different daily series.
  state.excluded.clear();
  rerenderAll();
});
$("arSelBtn").addEventListener("click", ev => { ev.stopPropagation(); toggleArPop(); });
$("arPop").addEventListener("click", ev => ev.stopPropagation());
document.querySelectorAll("[data-arpreset]").forEach(b =>
  b.addEventListener("click", () => applyArPreset(b.dataset.arpreset)));
document.addEventListener("click", () => { if (!$("arPop").hidden) toggleArPop(false); });
$("trackSel").addEventListener("change", renderTrack);
$("trackResetBtn").addEventListener("click", () => resetFitPoints(+$("trackSel").value));
$("mapDate").addEventListener("input", () => { state.mapIdx = +$("mapDate").value; renderMap(); });
$("mapPlay").addEventListener("click", () => {
  if (state.playing) { clearInterval(state.playing); state.playing = null; $("mapPlay").textContent = "▶ 재생"; return; }
  $("mapPlay").textContent = "⏸ 정지";
  state.playing = setInterval(() => {
    state.mapIdx = (state.mapIdx + 1) % M.dates.length;
    $("mapDate").value = state.mapIdx; renderMap();
  }, 260);
});
document.querySelectorAll("input[name=tblMode]").forEach(r => r.addEventListener("change", () => {
  const isDaily = document.querySelector("input[name=tblMode]:checked").value === "daily";
  $("tblArWrap").style.display = isDaily ? "" : "none";
  $("retNote").style.display = isDaily ? "" : "none";
  renderTable();
}));
$("tblAr").addEventListener("change", renderTable);
$("csvBtn").addEventListener("click", downloadCSV);
$("retTolInput").addEventListener("input", () => {
  const v = +$("retTolInput").value;
  if (isFinite(v) && v > 0) { state.retTol = v; renderTable(); }
});
$("retTolInput").addEventListener("click", ev => ev.stopPropagation());
$("fStart").addEventListener("change", onDateChange);
$("fEnd").addEventListener("change", onDateChange);
$("fFull").addEventListener("click", () => {
  $("fStart").value = DATA_MIN; $("fEnd").value = DATA_MAX; onDateChange();
});
let rsz = null;
window.addEventListener("resize", () => { clearTimeout(rsz); rsz = setTimeout(renderActive, 180); });
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { renderTiles(); renderActive(); });

state.rmsOn = $("fRmsOn").checked;
$("fRms").closest(".rmsf").classList.toggle("off", !state.rmsOn);
initDateFilter();
renderArPanel();
rerenderAll();
