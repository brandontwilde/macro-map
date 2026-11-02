const MACROS = ["p", "c", "f"];
const MACRO_NAMES = { p: "Protein", c: "Carbs", f: "Fat" };
const TOP_MATCHES = 5;
const LIST_LENGTH = 30;
const MAX_COMBO = 3;
const WEIGHTS = [{ label: "g", g: 1 }, { label: "oz", g: 28.35 }];
// PR previews share the live site's origin, so each keeps its own saved state.
const PREVIEW_PATH = location.pathname.match(/\/pr-preview\/pr-\d+\//);
const STORE_KEY = PREVIEW_PATH ? `macro-map${PREVIEW_PATH[0]}` : "macro-map";

// Triangle corners in SVG units: protein at the top, carbs bottom-left, fat bottom-right.
const CORNERS = { p: [300, 52], c: [40, 502], f: [560, 502] };

const state = {
  foods: [],
  remaining: { p: 150, c: 200, f: 60 },
  maxGrams: 400,
  combo: [], // [{ id, grams, unit }], unit being a label from units(food)
  query: "",
  sort: "closest",
  focus: null, // { id, nearby: ids of the dots around it }
};
// Reach of a pointer, in CSS px: how far from a dot a hover or tap still picks it.
const REACH = { mouse: 14, touch: 24 };
let plotDots = []; // [{ food, grams, share, x, y }] in SVG units
let lastPointer = "mouse";

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

const units = (food) => [...food.portions, ...WEIGHTS];

function findUnit(food, label) {
  const all = units(food);
  return all.find((u) => u.label === label) ?? all.find((u) => u.label === food.unit) ?? WEIGHTS[0];
}

function newEntry(food) {
  const unit = findUnit(food, food.unit);
  const count = { g: 100, oz: 4 }[unit.label] ?? 1;
  return { id: food.id, unit: unit.label, grams: count * unit.g };
}

// Entries saved before amounts had units were bare ids or { id, servings }.
function upgradeCombo() {
  state.combo = state.combo.flatMap((c) => {
    const food = state.foods.find((f) => f.id === (c.id ?? c));
    if (!food) return [];
    if (c.grams != null) return [c];
    const entry = newEntry(food);
    if (c.servings != null) entry.grams *= c.servings;
    return [entry];
  });
}

const stepOf = (unit) => (unit.label === "g" ? 5 : unit.label === "oz" ? 0.5 : 0.25);
const qtyIn = (unit, grams) => {
  const n = grams / unit.g;
  if (unit.label === "g") return Math.round(n);
  return unit.label === "oz" ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100;
};
const amountText = (unit, grams) => `${qtyIn(unit, grams)} ${unit.label}`;

function comboItems() {
  return state.combo
    .map((c) => ({ ...c, food: state.foods.find((f) => f.id === c.id) }))
    .filter((c) => c.food);
}

function macrosOf(food, grams) {
  const v = perGram(food);
  return { p: v.p * grams, c: v.c * grams, f: v.f * grams };
}

function comboTotal(items) {
  const total = { p: 0, c: 0, f: 0 };
  for (const { food, grams } of items) {
    const m = macrosOf(food, grams);
    for (const k of MACROS) total[k] += m[k];
  }
  return total;
}

const inCombo = (id) => state.combo.some((c) => c.id === id);

function portionText(food, grams) {
  const unit = findUnit(food, food.unit);
  if (unit.label === "g") return `${Math.round(grams)} g`;
  const n = grams / unit.g;
  const count = n >= 10 ? Math.round(n) : Math.round(n * 4) / 4;
  return `${Math.round(grams)} g · ≈${count} ${unit.label}`;
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

  const items = comboItems();
  if (items.length >= 2) {
    const pts = items.map(({ food }) => toXY(food).join(",")).join(" ");
    svg.append(svgEl(items.length === 2 ? "polyline" : "polygon", { class: "combo-shape", points: pts }));
  }

  const matchRank = new Map(rank.slice(0, TOP_MATCHES).map((r, i) => [r.food.id, i + 1]));
  const dots = svgEl("g");
  const top = svgEl("g");
  plotDots = [];
  for (const { food, grams, share } of rank) {
    const xy = toXY(food);
    if (!xy) continue;
    plotDots.push({ food, grams, share, x: xy[0], y: xy[1] });
    const n = matchRank.get(food.id);
    const selected = inCombo(food.id);
    const g = n ? top : dots;
    g.append(svgEl("circle", {
      class: `dot${n ? " match" : ""}${selected ? " selected" : ""}`,
      cx: xy[0], cy: xy[1], r: n ? 9 : 5,
    }));
    if (n) {
      const t = svgEl("text", { class: "dot-num", x: xy[0], y: xy[1] });
      t.textContent = n;
      g.append(t);
    }
  }
  svg.append(dots, top);

  const focused = state.focus && plotDots.find((d) => d.food.id === state.focus.id);
  if (focused) svg.append(svgEl("circle", { class: "focus-ring", cx: focused.x, cy: focused.y, r: 13 }));

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

  const mix = items.length >= 2 && toXY(comboTotal(items));
  if (mix) svg.append(svgEl("circle", { class: "combo-point", cx: mix[0], cy: mix[1], r: 6, "pointer-events": "none" }));
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
    <li data-id="${food.id}" class="${inCombo(food.id) ? "selected" : ""}">
      <span class="rank">${n}</span>
      <span class="name" title="${food.name}">${food.name}</span>
      <span class="amount">${grams > 0 ? portionText(food, grams) : "—"}</span>
      <span class="sub">${splitBar(food)}<span class="fill">covers ${Math.round(share * 100)}%</span><span>${food.group}</span></span>
    </li>`).join("");
}

function drawCombo() {
  const items = comboItems();
  $("#combo").hidden = !items.length;
  if (!items.length) return;

  $("#combo-items").innerHTML = items.map(({ food, grams, unit: label }, i) => {
    const unit = findUnit(food, label);
    const options = units(food).map((u) =>
      `<option value="${esc(u.label)}"${u.label === unit.label ? " selected" : ""}>${esc(u.label)}</option>`).join("");
    return `
    <li>
      <span class="rank">${i + 1}</span>
      <span class="name">${food.name}</span>
      <button type="button" class="remove" data-id="${food.id}" aria-label="Remove ${food.name}">×</button>
      <span class="serving">
        <input type="number" class="qty" data-id="${food.id}" min="0" step="${stepOf(unit)}" value="${qtyIn(unit, grams)}"
          aria-label="Amount of ${food.name}">
        <select class="unit" data-id="${food.id}" aria-label="Unit for ${food.name}">${options}</select>
        <span class="muted equiv" data-id="${food.id}"></span>
      </span>
      <span class="sub">${splitBar(food)}<span class="item-macros" data-id="${food.id}"></span></span>
    </li>`;
  }).join("") +
    (items.length < MAX_COMBO ? `<li class="empty">Add ${items.length === 1 ? "one or two foods" : "one more food"} from the list or map.</li>` : "");
  drawComboTotals(items);
}

function drawComboTotals(items) {
  for (const { food, grams, unit } of items) {
    const others = [findUnit(food, food.unit), ...WEIGHTS].filter((u, i, all) =>
      u.label !== unit && all.findIndex((v) => v.label === u.label) === i);
    $(`.equiv[data-id="${food.id}"]`).textContent = `= ${others.map((u) => amountText(u, grams)).join(" · ")}`;
    $(`.item-macros[data-id="${food.id}"]`).textContent = macroLine(macrosOf(food, grams), " g");
  }

  const total = comboTotal(items);
  const row = (label, m) =>
    `<tr><td>${label}</td>${MACROS.map((k) => `<td>${fmt(m[k])} g</td>`).join("")}</tr>`;
  const diff = Object.fromEntries(MACROS.map((k) => [k, state.remaining[k] - total[k]]));
  $("#combo-totals").innerHTML =
    `<tr><th></th>${MACROS.map((k) => `<th>${MACRO_NAMES[k]}</th>`).join("")}</tr>` +
    row("Combo gives", total) +
    row("Left to eat", state.remaining) +
    `<tr><td>Still to go</td>${MACROS.map((k) =>
      `<td class="${diff[k] < -0.5 ? "over" : ""}">${diff[k] < -0.5 ? `${fmt(-diff[k])} g over` : `${fmt(Math.max(diff[k], 0))} g`}</td>`
    ).join("")}</tr>`;
}

// Amounts that land closest to what's left, rounded to each food's step in its chosen unit.
function fitCombo() {
  const items = comboItems();
  const grams = solveCombo(items.map((c) => c.food), state.remaining);
  items.forEach((c, i) => {
    const entry = state.combo.find((e) => e.id === c.id);
    const unit = findUnit(c.food, c.unit);
    const step = stepOf(unit) * unit.g;
    entry.grams = Math.round(grams[i] / step) * step;
  });
  save();
  render();
}

function foodDetails({ food, grams, share }) {
  return `<div class="muted">per 100 g: ${macroLine(food)}${food.kcal ? ` · ${Math.round(food.kcal)} kcal` : ""}</div>
    <div>${grams > 0 ? `${portionText(food, grams)} covers ${Math.round(share * 100)}% of what's left` : "Nothing left it can fill"}</div>`;
}

// Dots within reach (in CSS px) of a pointer event or an SVG point, nearest first.
function dotsNear(at, reach) {
  const svg = $("#tri");
  const { x, y } = "clientX" in at
    ? new DOMPoint(at.clientX, at.clientY).matrixTransform(svg.getScreenCTM().inverse())
    : at;
  const r = reach * (svg.viewBox.baseVal.width / svg.getBoundingClientRect().width);
  return plotDots
    .map((d) => ({ d, dist: Math.hypot(d.x - x, d.y - y) }))
    .filter(({ dist }) => dist <= r)
    .sort((a, b) => a.dist - b.dist)
    .map(({ d }) => d);
}

// The card lists foods around the shown dot, not around where the finger landed.
function focusOn(dot) {
  const nearby = dotsNear(dot, REACH.touch).filter((d) => d !== dot).slice(0, 5);
  state.focus = { id: dot.food.id, nearby: nearby.map((d) => d.food.id) };
}

function drawDotCard() {
  const card = $("#dot-card");
  const dot = state.focus && plotDots.find((d) => d.food.id === state.focus.id);
  card.hidden = !dot;
  if (!dot) return;
  const { food } = dot;
  const others = state.focus.nearby.map((id) => state.foods.find((f) => f.id === id));
  card.innerHTML = `
    <div class="dot-card-head">
      <b>${food.name}</b>
      <button type="button" class="remove" data-action="close" aria-label="Close details">×</button>
    </div>
    <div class="dot-card-body">${splitBar(food)}<div>${foodDetails(dot)}</div></div>
    <button type="button" class="button" data-action="toggle">${inCombo(food.id) ? "Remove from combo" : "Add to combo"}</button>
    ${others.length ? `<div class="nearby">Also here: ${others.map((f) =>
      `<button type="button" class="link" data-action="show" data-id="${f.id}">${f.name}</button>`).join("")}</div>` : ""}`;
}

function showTip(e, dot) {
  const tip = $("#tip");
  tip.innerHTML = `<b>${dot.food.name}</b>${foodDetails(dot)}`;
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
  const i = state.combo.findIndex((c) => c.id === id);
  if (i >= 0) state.combo.splice(i, 1);
  else {
    state.combo.push(newEntry(state.foods.find((f) => f.id === id)));
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
  drawDotCard();
}

const THEME_KEY = "macro-map-theme";

function currentTheme() {
  return document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function setupThemeToggle() {
  const btn = $("#theme-toggle");
  const label = () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    btn.textContent = next === "light" ? "☀ Light mode" : "☾ Dark mode";
    btn.setAttribute("aria-label", `Switch to ${next} mode`);
  };
  btn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    label();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", label);
  label();
}

async function init() {
  load();
  setupThemeToggle();
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
  // A mouse hovers for details and clicks to add; a tap opens a details card instead,
  // since a fingertip usually covers several dots and there's no hover.
  const svg = $("#tri");
  svg.addEventListener("pointerdown", (e) => (lastPointer = e.pointerType));
  svg.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const [dot] = dotsNear(e, REACH.mouse);
    svg.style.cursor = dot ? "pointer" : "";
    if (dot) showTip(e, dot);
    else hideTip();
  });
  svg.addEventListener("pointerleave", hideTip);
  svg.addEventListener("click", (e) => {
    if (lastPointer === "mouse") {
      const [dot] = dotsNear(e, REACH.mouse);
      if (dot) toggleCombo(dot.food.id);
      return;
    }
    const [dot] = dotsNear(e, REACH.touch);
    if (dot) focusOn(dot);
    else state.focus = null;
    drawPlot(ranked());
    drawDotCard();
  });
  $("#dot-card").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "toggle") return toggleCombo(state.focus.id);
    const dot = btn.dataset.action === "show" && plotDots.find((d) => d.food.id === Number(btn.dataset.id));
    if (dot) focusOn(dot);
    else state.focus = null;
    drawPlot(ranked());
    drawDotCard();
  });
  $("#ranked").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) toggleCombo(Number(li.dataset.id));
  });
  $("#combo-items").addEventListener("click", (e) => {
    const btn = e.target.closest(".remove");
    if (btn) toggleCombo(Number(btn.dataset.id));
  });
  // Typing an amount redraws only the totals and map, so the input keeps focus.
  $("#combo-items").addEventListener("input", (e) => {
    const input = e.target.closest(".qty");
    if (!input) return;
    const item = comboItems().find((c) => c.id === Number(input.dataset.id));
    const entry = state.combo.find((c) => c.id === item.id);
    entry.grams = Math.max(0, Number(input.value) || 0) * findUnit(item.food, item.unit).g;
    save();
    drawPlot(ranked());
    drawComboTotals(comboItems());
  });
  // Switching units keeps the same amount of food and re-expresses it.
  $("#combo-items").addEventListener("change", (e) => {
    const select = e.target.closest(".unit");
    if (!select) return;
    state.combo.find((c) => c.id === Number(select.dataset.id)).unit = select.value;
    save();
    drawCombo();
  });
  $("#fit-combo").addEventListener("click", fitCombo);
  $("#clear-combo").addEventListener("click", () => {
    state.combo = [];
    save();
    render();
  });

  state.foods = await (await fetch("foods.json")).json();
  upgradeCombo();
  render();
}

init();
