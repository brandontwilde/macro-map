const MACROS = ["p", "c", "f"];
const MACRO_NAMES = { p: "Protein", c: "Carbs", f: "Fat" };
const TOP_MATCHES = 5;
const LIST_LENGTH = 30;
const MAX_COMBO = 3;
// PR previews share the live site's origin, so each keeps its own saved state.
const PREVIEW_PATH = location.pathname.match(/\/pr-preview\/pr-\d+\//);
const STORE_KEY = PREVIEW_PATH ? `macro-map${PREVIEW_PATH[0]}` : "macro-map";

// Triangle corners in SVG units: protein at the top, carbs bottom-left, fat bottom-right.
const CORNERS = { p: [300, 52], c: [40, 502], f: [560, 502] };

const state = {
  foods: [],
  remaining: { p: 150, c: 200, f: 60 },
  maxGrams: 400,
  combo: [],
  query: "",
  sort: "closest",
};

const $ = (sel) => document.querySelector(sel);
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toString();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    if (saved.remaining) state.remaining = saved.remaining;
    if (saved.combo) state.combo = saved.combo;
    if (saved.maxGrams) state.maxGrams = saved.maxGrams;
  } catch {}
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ remaining: state.remaining, combo: state.combo, maxGrams: state.maxGrams }));
  } catch {}
}

function toXY(m) {
  const total = m.p + m.c + m.f;
  if (!total) return null;
  let x = 0, y = 0;
  for (const k of MACROS) {
    x += (m[k] / total) * CORNERS[k][0];
    y += (m[k] / total) * CORNERS[k][1];
  }
  return [x, y];
}

function perGram(food) {
  return { p: food.p / 100, c: food.c / 100, f: food.f / 100 };
}

// Largest amount of a food, up to maxGrams, that doesn't push any macro past what's left.
function fit(food, r, maxGrams) {
  const v = perGram(food);
  let grams = Infinity;
  for (const k of MACROS) if (v[k] > 0) grams = Math.min(grams, Math.max(r[k], 0) / v[k]);
  grams = isFinite(grams) ? Math.min(grams, maxGrams) : 0;
  const left = MACROS.reduce((s, k) => s + Math.max(r[k], 0), 0);
  const covered = MACROS.reduce((s, k) => s + grams * v[k], 0);
  return { grams, share: left ? covered / left : 0 };
}

function portionText(food, grams) {
  const portion = food.portions[food.defaultPortion ?? -1];
  if (!portion) return `${Math.round(grams)} g`;
  const n = grams / portion.g;
  const count = n >= 10 ? Math.round(n) : Math.round(n * 4) / 4;
  return `${Math.round(grams)} g · ≈${count} ${portion.label}`;
}

// Least squares in grams-per-food: minimise |A x − r| with x ≥ 0, by trying every
// subset of foods and keeping the best one whose unconstrained solution is non-negative.
function solveCombo(foods, r) {
  const cols = foods.map(perGram);
  const residual = (x) =>
    MACROS.reduce((s, k) => {
      const got = cols.reduce((t, v, i) => t + v[k] * x[i], 0);
      return s + (got - r[k]) ** 2;
    }, 0);

  let best = { x: foods.map(() => 0) };
  best.err = residual(best.x);
  for (let mask = 1; mask < 1 << foods.length; mask++) {
    const idx = foods.map((_, i) => i).filter((i) => mask & (1 << i));
    const A = idx.map((i) => cols[i]);
    const M = A.map((a) => A.map((b) => MACROS.reduce((s, k) => s + a[k] * b[k], 0)));
    const rhs = A.map((a) => MACROS.reduce((s, k) => s + a[k] * r[k], 0));
    const sol = gaussSolve(M, rhs);
    if (!sol || sol.some((v) => v < 0)) continue;
    const x = foods.map(() => 0);
    idx.forEach((i, j) => (x[i] = sol[j]));
    const err = residual(x);
    if (err < best.err) best = { x, err };
  }
  return best.x;
}

function gaussSolve(M, b) {
  const n = b.length;
  const a = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

// "closest": nearest on the triangle to the split of what's left. "covers": most of what's left filled.
function ranked() {
  const target = toXY(state.remaining);
  const dist = (food) => {
    const xy = toXY(food);
    return target && xy ? Math.hypot(xy[0] - target[0], xy[1] - target[1]) : Infinity;
  };
  return state.foods
    .map((food) => ({ food, d: dist(food), ...fit(food, state.remaining, state.maxGrams) }))
    .sort(state.sort === "covers" ? (a, b) => b.share - a.share : (a, b) => a.d - b.d);
}

function splitBar(m) {
  const total = m.p + m.c + m.f || 1;
  return `<span class="split" aria-hidden="true">${MACROS.map((k) =>
    m[k] > 0 ? `<i class="${k}" style="flex:${m[k] / total}"></i>` : ""
  ).join("")}</span>`;
}

function macroLine(m, unit = "") {
  return MACROS.map((k) => `${MACRO_NAMES[k][0]} ${fmt(m[k])}${unit}`).join(" · ");
}

function drawPlot(rank) {
  const svg = $("#tri");
  svg.replaceChildren();

  const grid = svgEl("g", { class: "grid" });
  for (const s of [0.2, 0.4, 0.6, 0.8]) {
    for (const k of MACROS) {
      const [o1, o2] = MACROS.filter((j) => j !== k);
      const a = toXY({ [k]: s, [o1]: 1 - s, [o2]: 0 });
      const b = toXY({ [k]: s, [o1]: 0, [o2]: 1 - s });
      grid.append(svgEl("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }));
    }
  }
  svg.append(grid);
  svg.append(svgEl("polygon", { class: "frame", points: MACROS.map((k) => CORNERS[k].join(",")).join(" ") }));

  // Protein-share ticks along the left edge (the line from carbs up to protein).
  for (const s of [0.2, 0.4, 0.6, 0.8]) {
    const [x, y] = toXY({ p: s, c: 1 - s, f: 0 });
    const t = svgEl("text", { class: "tick", x: x - 8, y: y + 4, "text-anchor": "end" });
    t.textContent = `${s * 100}%`;
    svg.append(t);
  }
  const corner = (k, x, y, anchor) => {
    const t = svgEl("text", { class: "corner", x, y, "text-anchor": anchor });
    t.textContent = MACRO_NAMES[k];
    svg.append(t);
  };
  corner("p", 300, 34, "middle");
  corner("c", 40, 528, "middle");
  corner("f", 560, 528, "middle");

  const comboFoods = state.combo.map((id) => state.foods.find((f) => f.id === id)).filter(Boolean);
  if (comboFoods.length >= 2) {
    const pts = comboFoods.map((f) => toXY(f).join(",")).join(" ");
    svg.append(svgEl(comboFoods.length === 2 ? "polyline" : "polygon", { class: "combo-shape", points: pts }));
  }

  const matchRank = new Map(rank.slice(0, TOP_MATCHES).map((r, i) => [r.food.id, i + 1]));
  const dots = svgEl("g");
  const top = svgEl("g");
  for (const { food, grams, share } of rank) {
    const xy = toXY(food);
    if (!xy) continue;
    const n = matchRank.get(food.id);
    const selected = state.combo.includes(food.id);
    const g = svgEl("g");
    g.append(svgEl("circle", { class: "hit", cx: xy[0], cy: xy[1], r: 12 }));
    g.append(svgEl("circle", {
      class: `dot${n ? " match" : ""}${selected ? " selected" : ""}`,
      cx: xy[0], cy: xy[1], r: n ? 9 : 5,
    }));
    if (n) {
      const t = svgEl("text", { class: "dot-num", x: xy[0], y: xy[1] });
      t.textContent = n;
      g.append(t);
    }
    g.addEventListener("pointerenter", (e) => showTip(e, food, grams, share));
    g.addEventListener("pointermove", moveTip);
    g.addEventListener("pointerleave", hideTip);
    g.addEventListener("click", () => toggleCombo(food.id));
    (n ? top : dots).append(g);
  }
  svg.append(dots, top);

  const target = toXY(state.remaining);
  if (target) {
    const g = svgEl("g", { class: "target", "pointer-events": "none" });
    g.append(svgEl("circle", { cx: target[0], cy: target[1], r: 11 }));
    g.append(svgEl("line", { x1: target[0] - 17, y1: target[1], x2: target[0] - 6, y2: target[1] }));
    g.append(svgEl("line", { x1: target[0] + 6, y1: target[1], x2: target[0] + 17, y2: target[1] }));
    g.append(svgEl("line", { x1: target[0], y1: target[1] - 17, x2: target[0], y2: target[1] - 6 }));
    g.append(svgEl("line", { x1: target[0], y1: target[1] + 6, x2: target[0], y2: target[1] + 17 }));
    svg.append(g);
  }

  if (comboFoods.length >= 2) {
    const x = solveCombo(comboFoods, state.remaining);
    const total = { p: 0, c: 0, f: 0 };
    comboFoods.forEach((f, i) => MACROS.forEach((k) => (total[k] += perGram(f)[k] * x[i])));
    const xy = toXY(total);
    if (xy) svg.append(svgEl("circle", { class: "combo-point", cx: xy[0], cy: xy[1], r: 5, "pointer-events": "none" }));
  }
}

function drawList(rank) {
  const q = state.query.trim().toLowerCase();
  const rows = rank
    .map((r, i) => ({ ...r, n: i + 1 }))
    .filter((r) => !q || r.food.name.toLowerCase().includes(q) || r.food.group.toLowerCase().includes(q))
    .slice(0, LIST_LENGTH);
  const ol = $("#ranked");
  if (!rows.length) {
    ol.innerHTML = `<li class="empty">No foods match “${esc(state.query)}”.</li>`;
    return;
  }
  ol.innerHTML = rows.map(({ food, grams, share, n }) => `
    <li data-id="${food.id}" class="${state.combo.includes(food.id) ? "selected" : ""}">
      <span class="rank">${n}</span>
      <span class="name" title="${food.name}">${food.name}</span>
      <span class="amount">${grams > 0 ? portionText(food, grams) : "—"}</span>
      <span class="sub">${splitBar(food)}<span class="fill">covers ${Math.round(share * 100)}%</span><span>${food.group}</span></span>
    </li>`).join("");
}

function drawCombo() {
  const card = $("#combo");
  const foods = state.combo.map((id) => state.foods.find((f) => f.id === id)).filter(Boolean);
  card.hidden = !foods.length;
  if (!foods.length) return;

  const x = solveCombo(foods, state.remaining);
  const total = { p: 0, c: 0, f: 0 };
  foods.forEach((f, i) => MACROS.forEach((k) => (total[k] += perGram(f)[k] * x[i])));

  $("#combo-items").innerHTML = foods.map((f, i) => `
    <li>
      <span class="rank">${i + 1}</span>
      <span class="name" title="${f.name}">${f.name}</span>
      <span class="amount">${x[i] > 0.5 ? portionText(f, x[i]) : "skip"}
        <button type="button" class="remove" data-id="${f.id}" aria-label="Remove ${f.name}">×</button></span>
      <span class="sub">${splitBar(f)}<span>per 100 g: ${macroLine(f)}</span></span>
    </li>`).join("") +
    (foods.length < MAX_COMBO ? `<li class="empty">Add ${foods.length === 1 ? "one or two foods" : "one more food"} from the list or map.</li>` : "");

  const row = (label, m, cls = () => "") =>
    `<tr><td>${label}</td>${MACROS.map((k) => `<td class="${cls(k)}">${fmt(m[k])} g</td>`).join("")}</tr>`;
  const diff = Object.fromEntries(MACROS.map((k) => [k, state.remaining[k] - total[k]]));
  $("#combo-totals").innerHTML =
    `<tr><th></th>${MACROS.map((k) => `<th>${MACRO_NAMES[k]}</th>`).join("")}</tr>` +
    row("Combo gives", total) +
    row("Left to eat", state.remaining) +
    `<tr><td>Still to go</td>${MACROS.map((k) =>
      `<td class="${diff[k] < -0.5 ? "over" : ""}">${diff[k] < -0.5 ? `${fmt(-diff[k])} g over` : `${fmt(Math.max(diff[k], 0))} g`}</td>`
    ).join("")}</tr>`;
}

function showTip(e, food, grams, share) {
  const tip = $("#tip");
  tip.innerHTML = `<b>${food.name}</b>
    <div class="muted">per 100 g: ${macroLine(food)}${food.kcal ? ` · ${Math.round(food.kcal)} kcal` : ""}</div>
    <div>${grams > 0 ? `${portionText(food, grams)} covers ${Math.round(share * 100)}% of what's left` : "Nothing left it can fill"}</div>`;
  tip.hidden = false;
  moveTip(e);
}
function moveTip(e) {
  const tip = $("#tip");
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + tip.offsetWidth > innerWidth - 8) x = e.clientX - tip.offsetWidth - pad;
  if (y + tip.offsetHeight > innerHeight - 8) y = e.clientY - tip.offsetHeight - pad;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
function hideTip() {
  $("#tip").hidden = true;
}

function toggleCombo(id) {
  const i = state.combo.indexOf(id);
  if (i >= 0) state.combo.splice(i, 1);
  else {
    state.combo.push(id);
    if (state.combo.length > MAX_COMBO) state.combo.shift();
  }
  save();
  render();
}

function render() {
  const rank = ranked();
  drawPlot(rank);
  drawList(rank);
  drawCombo();
}

async function init() {
  load();
  const form = $("#remaining");
  for (const k of MACROS) form.elements[k].value = state.remaining[k];
  form.elements.max.value = state.maxGrams;
  form.addEventListener("input", () => {
    for (const k of MACROS) state.remaining[k] = Math.max(0, Number(form.elements[k].value) || 0);
    state.maxGrams = Math.max(1, Number(form.elements.max.value) || 400);
    save();
    render();
  });
  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value;
    drawList(ranked());
  });
  $("#sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    render();
  });
  $("#ranked").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) toggleCombo(Number(li.dataset.id));
  });
  $("#combo-items").addEventListener("click", (e) => {
    const btn = e.target.closest(".remove");
    if (btn) toggleCombo(Number(btn.dataset.id));
  });
  $("#clear-combo").addEventListener("click", () => {
    state.combo = [];
    save();
    render();
  });

  state.foods = await (await fetch("foods.json")).json();
  render();
}

init();
