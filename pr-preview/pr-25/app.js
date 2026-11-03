const MACROS = ["p", "c", "f"];
const MACRO_NAMES = { p: "Protein", c: "Carbs", f: "Fat" };
const TOP_MATCHES = 5;
const LIST_LENGTH = 30;
const MAX_COMBO = 3;
const WEIGHTS = [{ label: "g", g: 1 }, { label: "oz", g: 28.35 }];
// PR previews share the live site's origin, so each keeps its own saved state.
const PREVIEW_PATH = location.pathname.match(/\/pr-preview\/pr-\d+\//);
const STORE_KEY = PREVIEW_PATH ? `macro-map${PREVIEW_PATH[0]}` : "macro-map";
const FOODS_KEY = `${STORE_KEY}-foods`;

// Triangle corners in SVG units: protein at the top, carbs bottom-left, fat bottom-right.
const CORNERS = { p: [300, 52], c: [40, 502], f: [560, 502] };
const PLOT_W = 600;
const MAX_ZOOM = 30; // enough to pull apart the closest pairs (~0.7 units) for labels
const GRID_STEPS = [0.2, 0.1, 0.05, 0.02, 0.01, 0.005]; // macro shares, coarse to fine
const MIN_GRID_GAP = 50; // SVG units between neighbouring ruler lines
const LABEL_ZOOM = 1.8; // names appear beside dots from this zoom on
const LABEL_FONT = 11; // SVG units; keep in step with .dot-label in style.css

const state = {
  foods: [],
  mine: [], // the person's own foods, as entered: [{ id, name, group, diet, unit, grams, protein, carbs, fat, kcal }]
  remaining: { p: 150, c: 200, f: 60 },
  combo: [], // [{ id, grams, unit }], unit being a label from units(food)
  query: "",
  focus: null, // { id, nearby: ids of the dots around it }
  filters: { groups: [], diet: "", mine: false }, // no groups means every group; diet "", "vegetarian" or "vegan"
  view: { x: 0, y: 0, w: PLOT_W }, // plot point at the view's top-left, and the plot width shown
};
// Reach of a pointer, in CSS px: how far from a dot a hover or tap still picks it.
const REACH = { mouse: 14, touch: 24 };
let plotDots = []; // [{ food, grams, unit, share, x, y }] in SVG units
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
    if (saved.filters) state.filters = { ...state.filters, ...saved.filters };
  } catch {}
  try {
    state.mine = JSON.parse(localStorage.getItem(FOODS_KEY) || "[]");
  } catch {}
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ remaining: state.remaining, combo: state.combo, filters: state.filters }));
  } catch {}
}

// Custom foods are kept per unit (one chip, one bowl), the way people enter them, and converted to per 100 g for the map.
let builtIn = [];
function toFood(r) {
  // Without a known weight, the macros' own weight stands in: only ratios matter then, and g/oz aren't offered.
  const g = r.grams ?? r.protein + r.carbs + r.fat;
  const per100 = (v) => (v / g) * 100;
  return {
    id: r.id, name: r.name, group: r.group, diet: r.diet, mine: true, weightless: r.grams == null,
    p: per100(r.protein), c: per100(r.carbs), f: per100(r.fat), kcal: r.kcal == null ? null : per100(r.kcal),
    portions: [{ label: r.unit, g }], unit: r.unit,
  };
}
function setFoods() {
  state.foods = [...builtIn, ...state.mine.map(toFood)];
}
function saveMine() {
  try {
    localStorage.setItem(FOODS_KEY, JSON.stringify(state.mine));
  } catch {}
  setFoods();
}

const foodPrompt = () => `Give me nutrition data for the foods below as a JSON array, one object per food, with these keys:
- "name": short name, e.g. "Chicken burrito bowl"
- "group": one of ${[...new Set(builtIn.map((f) => f.group))].map((g) => `"${g}"`).join(", ")}
- "diet": "vegan", "vegetarian" or ""
- "unit": what it's counted in, e.g. "chip", "slice", "egg", "cup", "bar"
- "grams" (optional): weight of one unit as eaten (cooked or prepared), in grams
- "protein", "carbs", "fat": grams in one unit
- "kcal" (optional): calories in one unit
My foods may come as a list, a recipe, a screenshot or export from another app, or photos of labels or food; work out each food's values from whatever I give.
If you can search the web, look up branded, packaged and restaurant foods instead of estimating: use the maker's published nutrition facts first, then Open Food Facts. For plain whole foods, use USDA FoodData Central values.
For a recipe, use one portion if I say how many it makes; otherwise use the whole batch, e.g. "pot". Reply with only the JSON.

My foods:
`;

// Reads pasted or uploaded JSON (an array or a single object, code fences allowed) into food records.
function parseFoods(text) {
  let data;
  try {
    data = JSON.parse(text.trim().replace(/^```\w*\s*|\s*```$/g, ""));
  } catch {
    return { records: [], errors: ["That isn't valid JSON. Paste just the JSON part of the reply."] };
  }
  return checkFoods(data);
}

function checkFoods(data) {
  const records = [], errors = [];
  (Array.isArray(data) ? data : [data]).forEach((item, i) => {
    const label = `Item ${i + 1}${item?.name ? ` (${item.name})` : ""}`;
    if (!item || typeof item !== "object") return errors.push(`${label}: not an object.`);
    const name = String(item.name ?? "").trim();
    const num = (k) => (item[k] === "" || item[k] == null ? NaN : Number(item[k]));
    const [protein, carbs, fat] = ["protein", "carbs", "fat"].map(num);
    const grams = item.grams === "" || item.grams == null ? null : Number(item.grams);
    const kcal = num("kcal");
    if (!name) return errors.push(`${label}: needs a name.`);
    if (grams !== null && !(grams > 0)) return errors.push(`${label}: "grams" must be a positive number, or left out.`);
    if (![protein, carbs, fat].every((v) => v >= 0)) return errors.push(`${label}: "protein", "carbs" and "fat" must be numbers.`);
    if (protein + carbs + fat === 0) return errors.push(`${label}: has no protein, carbs or fat.`);
    if (grams !== null && protein + carbs + fat > grams * 1.05) return errors.push(`${label}: its macros weigh more than one unit (${grams} g).`);
    const unit = String(item.unit ?? "").trim();
    if (!unit) return errors.push(`${label}: needs a "unit", e.g. "slice" or "cup".`);
    if (WEIGHTS.some((w) => w.label === unit.toLowerCase())) return errors.push(`${label}: "unit" can't be g or oz, which are always offered; use something like "piece" or "cup".`);
    const diet = ["vegan", "vegetarian"].includes(item.diet) ? item.diet : null;
    records.push({
      name, group: String(item.group ?? "").trim() || "Other", diet, unit, grams, protein, carbs, fat,
      kcal: kcal >= 0 ? kcal : null,
    });
  });
  return { records, errors };
}

// A food with the same name as one already added replaces it, keeping its place in any combo.
function addMine(records) {
  let next = Math.min(0, ...state.mine.map((r) => r.id)) - 1; // negative ids never clash with USDA ones
  for (const r of records) {
    const old = state.mine.find((m) => m.name.toLowerCase() === r.name.toLowerCase());
    if (old) Object.assign(old, r);
    else state.mine.push({ id: next--, ...r });
  }
  saveMine();
}

function removeMine(id) {
  state.mine = state.mine.filter((r) => r.id !== id);
  state.combo = state.combo.filter((c) => c.id !== id);
  if (state.focus?.id === id) state.focus = null;
  saveMine();
  save();
}

function exportMine() {
  const json = JSON.stringify(state.mine.map(({ id, ...r }) => r), null, 1);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([json + "\n"], { type: "application/json" }));
  a.download = "my-foods.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

const ZXING_URL = "https://cdn.jsdelivr.net/npm/@zxing/browser@0.2.1/umd/zxing-browser.min.js";
const ZXING_SRI = "sha384-HRtzk9lZgkbSgvUyQrnfC/GxiXZgwaNyD7hC9wcXlsBpDhkS80ISl73juef2FRuf"; // update with the version
const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
const OFF_FIELDS = "product_name,brands,serving_size,serving_quantity,nutriments,ingredients_analysis_tags,food_groups_tags,categories_tags";
let stopScan = () => {};
let scanned = null; // the looked-up record awaiting confirmation

function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    Object.assign(s, { src, integrity, crossOrigin: "anonymous", onload: resolve, onerror: reject });
    document.head.append(s);
  });
}

// Reads barcodes off the camera until stopScan(). BarcodeDetector is native in Android Chrome;
// elsewhere, notably iOS Safari, ZXing decodes instead.
async function startScan(onCode) {
  stopScan();
  const video = $("#scan-video"), view = $("#scan-view");
  let live = true, stream, stopDecoding = () => {};
  stopScan = () => {
    live = false;
    stopDecoding();
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    view.hidden = true;
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    if (!live) return stopScan();
    video.srcObject = stream;
    view.hidden = false;
    $("#scan").scrollIntoView({ behavior: "smooth", block: "nearest" });
    await video.play();
    const formats = "BarcodeDetector" in window
      ? (await BarcodeDetector.getSupportedFormats()).filter((f) => BARCODE_FORMATS.includes(f)) : [];
    if (formats.length) {
      const detector = new BarcodeDetector({ formats });
      const tick = async () => {
        const [hit] = await detector.detect(video).catch(() => []);
        if (!live) return;
        if (hit) onCode(hit.rawValue);
        else setTimeout(tick, 150);
      };
      tick();
    } else {
      if (!window.ZXingBrowser) await loadScript(ZXING_URL, ZXING_SRI);
      if (!live) return;
      const controls = await new ZXingBrowser.BrowserMultiFormatReader()
        .decodeFromStream(stream, video, (result) => result && live && onCode(result.getText()));
      if (!live) return controls.stop();
      stopDecoding = () => controls.stop();
    }
  } catch (err) {
    if (!live) return; // stopped mid-start, so the failure is moot
    stopScan();
    throw err;
  }
}

// Open Food Facts files products under a fixed two-level food-group list (PNNS); subgroups are checked before
// their parent. A few of its placements differ from this app's, so some categories are checked first.
const OFF_CATEGORY_GROUPS = [
  [/nut-butters/, "Fats & nuts"],
  [/tofu|tempeh|meat-analogues|hummus/, "Plant protein"],
  [/crisps|chips|popcorn|pretzels|crackers/, "Snacks & sweets"],
];
const OFF_FOOD_GROUPS = {
  "en:fruit-juices": "Fruit", "en:fruit-nectars": "Fruit", "en:fruits": "Fruit", "en:dried-fruits": "Fruit",
  "en:vegetables": "Vegetables", "en:soups": "Prepared foods", "en:legumes": "Plant protein", "en:nuts": "Fats & nuts",
  "en:eggs": "Eggs & dairy", "en:dressings-and-sauces": "Sauces & condiments", "en:fats": "Fats & nuts",
  "en:beverages": "Drinks", "en:alcoholic-beverages": "Drinks", "en:fruits-and-vegetables": "Vegetables",
  "en:cereals-and-potatoes": "Grains & starches", "en:milk-and-dairy-products": "Eggs & dairy",
  "en:fish-meat-eggs": "Meat & fish", "en:fat-and-sauces": "Fats & nuts", "en:sugary-snacks": "Snacks & sweets",
  "en:salty-snacks": "Snacks & sweets", "en:composite-foods": "Prepared foods",
};

function offGroup(p) {
  const categories = (p.categories_tags ?? []).join(" ");
  const override = OFF_CATEGORY_GROUPS.find(([re]) => re.test(categories));
  if (override) return override[1];
  const tags = [...(p.food_groups_tags ?? [])].reverse(); // most specific first
  return OFF_FOOD_GROUPS[tags.find((t) => t in OFF_FOOD_GROUPS)] ?? "Prepared foods";
}

// The label's serving size as a count of some unit: "1 bar (68 g)", "2/3 cup (55 g)", "1 1/2 cups".
// Generic or weight-only servings ("39g") give no unit; "1 portion (1 cup)" falls back to its brackets.
function servingUnit(text) {
  text = String(text ?? "");
  const m = text.match(/^\s*(?:(\d+)\s+)?(\d+(?:\.\d+)?)(?:\/(\d+))?\s*([a-z][a-z .-]*?)\s*(?:\(|$)/i);
  if (!m) return null;
  const count = Number(m[1] ?? 0) + Number(m[2]) / Number(m[3] ?? 1);
  let unit = m[4].trim().toLowerCase();
  if (/^(servings?|portions?)$/.test(unit) && count === 1) return servingUnit(text.match(/\((.*)\)/)?.[1]);
  if (!(count > 0) || unit.length > 20 || /^(servings?|portions?|g|grams?|ml|oz|ounces?|kg|l)$/.test(unit)) return null;
  if (count !== 1) unit = unit.replace(/(ch|sh|x|ss)es$/, "$1").replace(/([^s])s$/, "$1");
  return { count, unit };
}

// Nutriments are per 100 g, and per serving when the label gives one; the serving is preferred since it's
// the amount people count in and its label-rounded numbers are the ones on the pack. A serving of several
// units ("2 tbsp") is divided down to one.
function fromOpenFoodFacts(p) {
  const n = p.nutriments ?? {};
  const serving = Number(p.serving_quantity) > 0 ? Number(p.serving_quantity) : null;
  const label = serving ? servingUnit(p.serving_size) : null;
  const per = label?.count ?? 1;
  const amount = (key) => {
    const v = serving && n[`${key}_serving`] != null ? Number(n[`${key}_serving`])
      : n[`${key}_100g`] != null ? (Number(n[`${key}_100g`]) * (serving ?? 100)) / 100 : NaN;
    return v >= 0 ? Math.round((v / per) * 10) / 10 : null;
  };
  const [protein, carbs, fat] = ["proteins", "carbohydrates", "fat"].map(amount);
  if ([protein, carbs, fat].includes(null) || protein + carbs + fat === 0) return null;
  const brand = String(p.brands ?? "").split(",")[0].trim();
  const product = String(p.product_name ?? "").trim();
  const tags = p.ingredients_analysis_tags ?? [];
  return {
    name: brand && !product.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${product}`.trim() : product,
    group: offGroup(p),
    diet: tags.includes("en:vegan") ? "vegan" : tags.includes("en:vegetarian") ? "vegetarian" : "",
    unit: label?.unit ?? (serving ? "serving" : "100 g"), grams: Math.round(((serving ?? 100) / per) * 10) / 10,
    protein, carbs, fat, kcal: amount("energy-kcal"),
    labelServing: per === 1 ? null : p.serving_size,
  };
}

function scanMessage(text, error = false) {
  const msg = $("#scan-msg");
  msg.textContent = text;
  msg.classList.toggle("over", error);
}

async function lookUpBarcode(code) {
  $("#scan-food").hidden = true;
  scanMessage(`Looking up ${code}…`);
  let product;
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`);
    ({ product } = await res.json());
  } catch {
    return scanMessage("Couldn't reach Open Food Facts. Check the connection and try again.", true);
  }
  if (!product) return scanMessage(`Barcode ${code} isn't in Open Food Facts yet. Add it with Copy AI prompt instead.`, true);
  const record = fromOpenFoodFacts(product);
  if (!record) return scanMessage(`Open Food Facts has barcode ${code} but not its protein, carbs and fat. Add it with Copy AI prompt instead.`, true);
  scanMessage("Check the details, then add it.");
  showScanned(record);
}

function showScanned(r) {
  const form = $("#scan-food");
  const groups = [...new Set(state.foods.map((f) => f.group))].sort();
  form.elements.group.innerHTML = groups.map((g) => `<option>${esc(g)}</option>`).join("");
  for (const k of ["name", "unit", "group", "diet"]) form.elements[k].value = r[k];
  $("#scan-macros").textContent = `One unit (${fmt(r.grams)} g): ${macroLine({ p: r.protein, c: r.carbs, f: r.fat }, " g")}${
    r.kcal == null ? "" : ` · ${fmt(r.kcal)} kcal`}${r.labelServing ? ` · the label's serving is ${r.labelServing}` : ""}`;
  scanned = r;
  form.hidden = false;
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

// Macro shares of a point, relative to the triangle's corners.
function toShares([x, y]) {
  const [[px, py], [cx, cy], [fx, fy]] = MACROS.map((k) => CORNERS[k]);
  const det = (cy - fy) * (px - fx) + (fx - cx) * (py - fy);
  const p = ((cy - fy) * (x - fx) + (fx - cx) * (y - fy)) / det;
  const c = ((fy - py) * (x - fx) + (px - fx) * (y - fy)) / det;
  return { p, c, f: 1 - p - c };
}

function perGram(food) {
  return { p: food.p / 100, c: food.c / 100, f: food.f / 100 };
}

const units = (food) => (food.weightless ? food.portions : [...food.portions, ...WEIGHTS]);

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

// A typical serving and the share of the target's grams (all macros together) it provides.
function serving(food) {
  const { grams, unit } = newEntry(food);
  const target = MACROS.reduce((s, k) => s + state.remaining[k], 0);
  const got = MACROS.reduce((s, k) => s + macrosOf(food, grams)[k], 0);
  return { grams, unit, share: target ? got / target : 0 };
}

function servingText(food, grams, unit) {
  const u = findUnit(food, unit);
  return esc(WEIGHTS.includes(u) || food.weightless ? amountText(u, grams) : `${amountText(u, grams)} (${Math.round(grams)} g)`);
}

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

function passesFilters(food) {
  const { groups, diet } = state.filters;
  if (state.filters.mine && state.mine.length && !food.mine) return false;
  if (groups.length && !groups.includes(food.group)) return false;
  return diet === "vegan" ? food.diet === "vegan" : diet === "vegetarian" ? !!food.diet : true;
}

// Nearest first, on the triangle, to the target's split.
function ranked() {
  const target = toXY(state.remaining);
  const dist = (food) => {
    const xy = toXY(food);
    return target && xy ? Math.hypot(xy[0] - target[0], xy[1] - target[1]) : Infinity;
  };
  return state.foods
    .filter(passesFilters)
    .map((food) => ({ food, d: dist(food), ...serving(food) }))
    .sort((a, b) => a.d - b.d);
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

const zoom = () => PLOT_W / state.view.w;
// Zooming moves points apart rather than scaling the drawing, so dots and text keep their size.
const toView = ([x, y]) => [(x - state.view.x) * zoom(), (y - state.view.y) * zoom()];
const plotXY = (m) => {
  const xy = toXY(m);
  return xy && toView(xy);
};
// The view is a smaller copy of the triangle drawn in the same frame: each macro's
// lowest share in view, so the view spans lo[k] to lo[k] + 1 / zoom() of every macro.
const viewLow = () => {
  const s = 1 / zoom();
  const top = toShares([state.view.x + CORNERS.p[0] * s, state.view.y + CORNERS.p[1] * s]);
  return { p: top.p - s, c: top.c, f: top.f };
};
const inFrame = (xy) => Object.values(toShares(xy)).every((v) => v > -1e-9);

function drawPlot(rank) {
  const svg = $("#tri");
  svg.replaceChildren();

  // Ruler lines get finer as you zoom, keeping about MIN_GRID_GAP apart on screen.
  const triangleHeight = CORNERS.c[1] - CORNERS.p[1];
  const step = GRID_STEPS.filter((st) => st * triangleHeight * zoom() >= MIN_GRID_GAP).at(-1);
  const grid = svgEl("g", { class: "grid" });
  const rulers = [];
  const lo = viewLow(), span = 1 / zoom();
  for (let i = 1; i * step < 1 - 1e-9; i++) {
    const v = Math.round(i * step * 1e4) / 1e4;
    for (const k of MACROS) {
      if (v <= lo[k] + 1e-9 || v >= lo[k] + span - 1e-9) continue;
      const [o1, o2] = MACROS.filter((j) => j !== k);
      const seg = [plotXY({ [k]: v, [o1]: lo[o1], [o2]: 1 - v - lo[o1] }), plotXY({ [k]: v, [o1]: 1 - v - lo[o2], [o2]: lo[o2] })];
      grid.append(svgEl("line", { class: k, x1: seg[0][0], y1: seg[0][1], x2: seg[1][0], y2: seg[1][1] }));
      rulers.push({ k, v, seg });
    }
  }
  const clip = svgEl("clipPath", { id: "frame-clip" });
  clip.append(svgEl("polygon", { points: MACROS.map((k) => CORNERS[k].join(",")).join(" ") }));
  svg.append(clip, grid);
  svg.append(svgEl("polygon", { class: "frame", points: MACROS.map((k) => CORNERS[k].join(",")).join(" ") }));

  const ticks = svgEl("g"); // filled once food names are placed, which take priority
  svg.append(ticks);
  // Zoomed in, each corner shows how far its macro reaches in view, not 100%.
  const zoomed = span < 1 - 1e-9;
  const corner = (k, dx, dy, anchor) => {
    const [x, y] = CORNERS[k];
    const t = svgEl("text", { class: `corner ${k}`, x: x + dx, y: y + dy, "text-anchor": anchor });
    t.textContent = MACRO_NAMES[k];
    if (zoomed) {
      const v = svgEl("tspan", { class: "corner-pct" });
      v.textContent = ` ${((lo[k] + span) * 100).toFixed(step < 0.01 ? 1 : 0)}%`;
      t.append(v);
    }
    svg.append(t);
  };
  corner("p", 0, -18, "middle");
  corner("c", zoomed ? -30 : 0, 36, zoomed ? "start" : "middle");
  corner("f", zoomed ? 30 : 0, 36, zoomed ? "end" : "middle");
  if (zoomed) svg.append(minimap(lo, span, rank));

  const items = comboItems();
  if (items.length >= 2) {
    const pts = items.map(({ food }) => plotXY(food).join(",")).join(" ");
    svg.append(svgEl(items.length === 2 ? "polyline" : "polygon", { class: "combo-shape", points: pts, "clip-path": "url(#frame-clip)" }));
  }

  const matchRank = new Map(rank.slice(0, TOP_MATCHES).map((r, i) => [r.food.id, i + 1]));
  const faded = svgEl("g", { class: "faded" });
  for (const food of state.foods) {
    const xy = !passesFilters(food) && plotXY(food);
    if (xy && inFrame(xy)) faded.append(svgEl("circle", { cx: xy[0], cy: xy[1], r: 3 }));
  }
  svg.append(faded);
  const dots = svgEl("g");
  const top = svgEl("g");
  plotDots = [];
  for (const { food, grams, unit, share } of rank) {
    const xy = plotXY(food);
    if (!xy || !inFrame(xy)) continue;
    plotDots.push({ food, grams, unit, share, x: xy[0], y: xy[1] });
    const n = matchRank.get(food.id);
    const selected = inCombo(food.id);
    const g = n ? top : dots;
    const cls = `dot${n ? " match" : ""}${selected ? " selected" : ""}`;
    const r = n ? 9 : 5;
    g.append(food.mine
      ? svgEl("rect", { class: cls, x: xy[0] - r, y: xy[1] - r, width: 2 * r, height: 2 * r, transform: `rotate(45 ${xy[0]} ${xy[1]})` })
      : svgEl("circle", { class: cls, cx: xy[0], cy: xy[1], r }));
    if (n) {
      const t = svgEl("text", { class: "dot-num", x: xy[0], y: xy[1] });
      t.textContent = n;
      g.append(t);
    }
  }
  svg.append(dots, top);
  const placed = [];
  drawRulerLabels(ticks, rulers, step, placed);
  if (zoom() >= LABEL_ZOOM) svg.append(dotLabels(matchRank, placed));

  const focused = state.focus && plotDots.find((d) => d.food.id === state.focus.id);
  if (focused) svg.append(svgEl("circle", { class: "focus-ring", cx: focused.x, cy: focused.y, r: 13 }));

  const target = plotXY(state.remaining);
  if (target && inFrame(target)) {
    const g = svgEl("g", { class: "target", "pointer-events": "none" });
    g.append(svgEl("circle", { cx: target[0], cy: target[1], r: 11 }));
    g.append(svgEl("line", { x1: target[0] - 17, y1: target[1], x2: target[0] - 6, y2: target[1] }));
    g.append(svgEl("line", { x1: target[0] + 6, y1: target[1], x2: target[0] + 17, y2: target[1] }));
    g.append(svgEl("line", { x1: target[0], y1: target[1] - 17, x2: target[0], y2: target[1] - 6 }));
    g.append(svgEl("line", { x1: target[0], y1: target[1] + 6, x2: target[0], y2: target[1] + 17 }));
    svg.append(g);
  }

  const mix = items.length >= 2 && plotXY(comboTotal(items));
  if (mix && inFrame(mix)) svg.append(svgEl("circle", { class: "combo-point", cx: mix[0], cy: mix[1], r: 6, "pointer-events": "none" }));
}

const MINIMAP = { x: 8, y: 8, w: 140 }; // SVG units, in the empty top-left of the plot
const fromMinimap = ([x, y]) => {
  const k = PLOT_W / MINIMAP.w;
  return [(x - MINIMAP.x) * k, (y - MINIMAP.y) * k];
};

// The whole triangle in miniature with the foods that pass the filters, top matches
// darker, and the part in view shaded.
function minimap(lo, span, rank) {
  const k = MINIMAP.w / PLOT_W;
  const at = ([x, y]) => [MINIMAP.x + x * k, MINIMAP.y + y * k];
  const pts = (xys) => xys.map((xy) => at(xy).join(",")).join(" ");
  const g = svgEl("g", { class: "minimap" });
  g.append(svgEl("rect", { x: 0, y: 0, width: MINIMAP.x * 2 + MINIMAP.w, height: MINIMAP.y * 2 + CORNERS.c[1] * k }));
  g.append(svgEl("polygon", { class: "minimap-frame", points: pts(MACROS.map((m) => CORNERS[m])) }));
  rank.forEach(({ food }, i) => {
    const xy = toXY(food);
    if (!xy) return;
    const [cx, cy] = at(xy);
    g.append(svgEl("circle", { class: i < TOP_MATCHES ? "match" : "", cx, cy, r: i < TOP_MATCHES ? 1.6 : 1.1 }));
  });
  const view = MACROS.map((m) => toXY({ ...lo, [m]: lo[m] + span }));
  g.append(svgEl("polygon", { class: "minimap-view", points: pts(view) }));
  const [cx, cy] = at(toXY({ p: lo.p + span / 3, c: lo.c + span / 3, f: lo.f + span / 3 }));
  if (span * (CORNERS.c[1] - CORNERS.p[1]) * k < 8) g.append(svgEl("circle", { class: "minimap-spot", cx, cy, r: 4 }));
  return g;
}

// Moves the view so its centre is at a plot point.
function centerOn([x, y]) {
  const s = state.view.w / PLOT_W;
  const [cx, cy] = toXY({ p: 1, c: 1, f: 1 });
  setView(x - cx * s, y - cy * s, state.view.w);
}

// Percent labels for the ruler lines, each macro read off its own edge: protein on the
// left, carbs along the base, fat on the right. Their boxes are added to placed.
function drawRulerLabels(g, rulers, step, placed) {
  const pct = (v) => `${(v * 100).toFixed(step < 0.01 ? 1 : 0)}%`;
  for (const { k, v, seg } of rulers) {
    const [a, b] = seg;
    const [x, y] = { p: a[0] < b[0] ? a : b, c: a[1] > b[1] ? a : b, f: a[0] > b[0] ? a : b }[k];
    const [dx, dy, anchor] = { p: [-8, 4, "end"], c: [0, 17, "middle"], f: [8, 4, "start"] }[k];
    const text = pct(v);
    const w = text.length * 6.2;
    const x0 = { end: x + dx - w, middle: x - w / 2, start: x + dx }[anchor];
    placed.push({ x0, x1: x0 + w, y0: y + dy - 10, y1: y + dy + 2 });
    const t = svgEl("text", { class: `tick ${k}`, x: x + dx, y: y + dy, "text-anchor": anchor });
    t.textContent = text;
    g.append(t);
  }
}

// Names beside dots, placed greedily (top matches first), on the right or else the left,
// and skipped where they'd overlap. Dots sharing a spot (e.g. two pure oils) share a label.
function dotLabels(matchRank, placed) {
  const g = svgEl("g", { class: "dot-labels" });
  const spots = [];
  const order = [...plotDots].sort((a, b) => (matchRank.get(a.food.id) ?? 99) - (matchRank.get(b.food.id) ?? 99));
  for (const dot of order) {
    const name = dot.food.name.replace(/\s*\(.*\)$/, "");
    const spot = spots.find((s) => Math.hypot(s.x - dot.x, s.y - dot.y) < 1.5);
    if (spot) spot.names.push(name);
    else spots.push({ x: dot.x, y: dot.y, names: [name] });
  }
  const hits = (box) => (o) => o.x0 < box.x1 && box.x0 < o.x1 && o.y0 < box.y1 && box.y0 < o.y1;
  for (const { x, y, names } of spots) {
    const text = names.join(" / ");
    const w = text.length * LABEL_FONT * 0.55;
    const [y0, y1] = [y - LABEL_FONT * 0.6, y + LABEL_FONT * 0.6];
    const box = [{ x0: x + 8, x1: x + 10 + w, y0, y1 }, { x0: x - 10 - w, x1: x - 8, y0, y1 }].find((b) =>
      b.x0 >= 0 && b.x1 <= PLOT_W && !placed.some(hits(b)) &&
      !plotDots.some((d) => Math.hypot(d.x - x, d.y - y) >= 1.5 && hits(b)({ x0: d.x - 4, x1: d.x + 4, y0: d.y - 4, y1: d.y + 4 })));
    if (!box) continue;
    placed.push(box);
    const t = svgEl("text", { class: "dot-label", x: box.x0, y });
    t.textContent = text;
    g.append(t);
  }
  return g;
}

// Zoom by factor f about a point given in current view coordinates.
function zoomAt(f, [vx, vy]) {
  const v = state.view;
  const w = Math.min(PLOT_W, Math.max(PLOT_W / MAX_ZOOM, v.w / f));
  const px = v.x + vx / zoom(), py = v.y + vy / zoom();
  setView(px - (px - v.x) * (w / v.w), py - (py - v.y) * (w / v.w), w);
}
function panBy(dx, dy) {
  setView(state.view.x - dx / zoom(), state.view.y - dy / zoom(), state.view.w);
}
// Keeps the view's triangle inside the plot's: no macro's lowest share in view may go
// below 0, so any shortfall is taken from the others in proportion.
function setView(x, y, w) {
  const s = w / PLOT_W;
  const top = toShares([x + CORNERS.p[0] * s, y + CORNERS.p[1] * s]);
  const lo = { p: top.p - s, c: top.c, f: top.f };
  const pos = MACROS.reduce((sum, k) => sum + Math.max(lo[k], 0), 0);
  for (const k of MACROS) lo[k] = pos > 0 ? (Math.max(lo[k], 0) * (1 - s)) / pos : 0;
  const [tx, ty] = toXY({ ...lo, p: lo.p + s });
  state.view = { x: tx - CORNERS.p[0] * s, y: ty - CORNERS.p[1] * s, w };
  $("#tri").classList.toggle("zoomed", w < PLOT_W);
  $("#zoom-reset").disabled = w >= PLOT_W;
  drawPlot(ranked());
}

function drawList(rank) {
  const q = state.query.trim().toLowerCase();
  const rows = rank
    .map((r, i) => ({ ...r, n: i + 1 }))
    .filter((r) => !q || r.food.name.toLowerCase().includes(q) || r.food.group.toLowerCase().includes(q))
    .slice(0, LIST_LENGTH);
  const ol = $("#ranked");
  if (!rows.length) {
    ol.innerHTML = `<li class="empty">${q ? `No foods match “${esc(state.query)}”` : "No foods pass the filters"}.</li>`;
    return;
  }
  ol.innerHTML = rows.map(({ food, grams, unit, share, n }) => `
    <li data-id="${food.id}" class="${inCombo(food.id) ? "selected" : ""}">
      <span class="rank">${n}</span>
      <span class="name" title="${esc(food.name)}">${esc(food.name)}</span>
      <span class="amount">${servingText(food, grams, unit)}</span>
      <span class="sub">${splitBar(food)}<span class="fill">${macroLine(macrosOf(food, grams), " g")}</span><span class="fill">${pctText(share)}</span></span>
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
      <span class="name">${esc(food.name)}</span>
      <button type="button" class="remove" data-id="${food.id}" aria-label="Remove ${esc(food.name)}">×</button>
      <span class="serving">
        <input type="number" class="qty" data-id="${food.id}" min="0" step="${stepOf(unit)}" value="${qtyIn(unit, grams)}"
          aria-label="Amount of ${esc(food.name)}">
        <select class="unit" data-id="${food.id}" aria-label="Unit for ${esc(food.name)}">${options}</select>
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
    const others = [findUnit(food, food.unit), ...units(food).filter((u) => WEIGHTS.includes(u))].filter((u, i, all) =>
      u.label !== unit && all.findIndex((v) => v.label === u.label) === i);
    $(`.equiv[data-id="${food.id}"]`).textContent = others.length ? `= ${others.map((u) => amountText(u, grams)).join(" · ")}` : "";
    $(`.item-macros[data-id="${food.id}"]`).textContent = macroLine(macrosOf(food, grams), " g");
  }

  const total = comboTotal(items);
  const row = (label, m) =>
    `<tr><td>${label}</td>${MACROS.map((k) => `<td>${fmt(m[k])} g</td>`).join("")}</tr>`;
  const diff = Object.fromEntries(MACROS.map((k) => [k, state.remaining[k] - total[k]]));
  $("#combo-totals").innerHTML =
    `<tr><th></th>${MACROS.map((k) => `<th>${MACRO_NAMES[k]}</th>`).join("")}</tr>` +
    row("Combo gives", total) +
    row("Target", state.remaining) +
    `<tr><td>Still to go</td>${MACROS.map((k) =>
      `<td class="${diff[k] < -0.5 ? "over" : ""}">${diff[k] < -0.5 ? `${fmt(-diff[k])} g over` : `${fmt(Math.max(diff[k], 0))} g`}</td>`
    ).join("")}</tr>`;
}

// Amounts that land closest to the target, rounded to each food's step in its chosen unit.
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

const foodTitle = (food) =>
  `<b>${esc(food.name)}</b><span class="food-group">${esc(food.group)}${food.mine ? " · my food" : ""}</span>`;
const pctText = (share) => `${share > 0 && share < 0.005 ? "<1" : Math.round(share * 100)}% of target`;

function foodDetails({ food, grams, unit, share }) {
  const per100 = food.kcal ?? 4 * food.p + 4 * food.c + 9 * food.f; // Atwater factors when no calorie count is given
  const kcal = per100 ? ` · ${Math.round((per100 * grams) / 100)} kcal` : "";
  return `<div>${servingText(food, grams, unit)}${kcal}</div>
    <div class="muted">${macroLine(macrosOf(food, grams), " g")} · ${pctText(share)}</div>`;
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
      ${foodTitle(food)}
      <button type="button" class="remove" data-action="close" aria-label="Close details">×</button>
    </div>
    <div class="dot-card-body">${splitBar(food)}<div>${foodDetails(dot)}</div></div>
    <button type="button" class="button" data-action="toggle">${inCombo(food.id) ? "Remove from combo" : "Add to combo"}</button>
    ${others.length ? `<div class="nearby">Also here: ${others.map((f) =>
      `<button type="button" class="link" data-action="show" data-id="${f.id}">${esc(f.name)}</button>`).join("")}</div>` : ""}`;
}

function showTip(e, dot) {
  const tip = $("#tip");
  tip.innerHTML = `<div class="food-title">${foodTitle(dot.food)}</div>${splitBar(dot.food)}${foodDetails(dot)}`;
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

const DIETS = [["", "Any diet"], ["vegetarian", "Vegetarian"], ["vegan", "Vegan"]];

function drawFilters() {
  const { groups, diet } = state.filters;
  const mine = state.filters.mine && state.mine.length > 0;
  const all = [...new Set(state.foods.map((f) => f.group))];
  const chip = (attrs, label, on) => `<button type="button" class="chip" ${attrs} aria-pressed="${on}">${esc(label)}</button>`;
  $("#filters").innerHTML = `
    <div class="filter-row" role="group" aria-labelledby="diet-label">
      <span class="filter-label" id="diet-label">Diet</span>
      <div class="segmented">${DIETS.map(([value, label]) => chip(`data-diet="${value}"`, label, diet === value)).join("")}</div>
    </div>
    <div class="filter-row" role="group" aria-labelledby="groups-label">
      <span class="filter-label" id="groups-label">Show</span>
      <div class="chips">${chip('data-group=""', "All foods", !groups.length && !mine)}${
        state.mine.length ? chip("data-mine", "My foods", mine) : ""}${
        all.map((g) => chip(`data-group="${esc(g)}"`, g, groups.includes(g))).join("")}</div>
    </div>`;
}

function render() {
  const rank = ranked();
  drawFilters();
  drawPlot(rank);
  drawList(rank);
  drawCombo();
  drawDotCard();
  drawMine();
}

function drawMine() {
  $("#mine-count").textContent = state.mine.length ? `(${state.mine.length})` : "";
  $("#export-mine").hidden = !state.mine.length;
  $("#mine-list").innerHTML = state.mine.map((r) => `
    <li>
      <span class="name">${esc(r.name)}</span>
      <span class="muted">1 ${esc(r.unit)}${r.grams == null ? "" : ` (${fmt(r.grams)} g)`} · ${macroLine({ p: r.protein, c: r.carbs, f: r.fat }, " g")}</span>
      <button type="button" class="remove" data-id="${r.id}" aria-label="Delete ${esc(r.name)}">×</button>
    </li>`).join("");
}

function importFoods({ records, errors }) {
  if (records.length) {
    addMine(records);
    upgradeCombo();
    render();
  }
  const added = records.length ? `Added ${records.length} food${records.length > 1 ? "s" : ""}.` : "";
  const msg = $("#mine-msg");
  msg.classList.toggle("over", !!errors.length);
  msg.innerHTML = [added, ...errors].filter(Boolean).map(esc).join("<br>");
  return records.length > 0 && !errors.length;
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
    btn.textContent = next === "light" ? "☀" : "☾";
    btn.setAttribute("aria-label", `Switch to ${next} mode`);
    btn.title = `Switch to ${next} mode`;
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

// Hover shows a tip on its own (see CSS); a click or tap pins it open until a click elsewhere or Escape.
function setupInfoTips() {
  const close = (except) => {
    for (const info of document.querySelectorAll(".info.open")) {
      if (info === except) continue;
      info.classList.remove("open");
      info.querySelector(".info-btn").setAttribute("aria-expanded", "false");
    }
  };
  document.addEventListener("click", (e) => {
    const info = e.target.closest(".info");
    close(info);
    if (!info || !e.target.closest(".info-btn")) return;
    info.querySelector(".info-btn").setAttribute("aria-expanded", info.classList.toggle("open"));
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
}

async function init() {
  load();
  setupThemeToggle();
  setupInfoTips();
  const form = $("#remaining");
  for (const k of MACROS) form.elements[k].value = state.remaining[k];
  form.addEventListener("input", () => {
    for (const k of MACROS) state.remaining[k] = Math.max(0, Number(form.elements[k].value) || 0);
    save();
    render();
  });
  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value;
    drawList(ranked());
  });
  // A mouse hovers for details and clicks to add; a tap opens a details card instead,
  // since a fingertip usually covers several dots and there's no hover.
  const svg = $("#tri");
  const toPlot = (e) => {
    const { x, y } = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return [x, y];
  };
  const unitsPerPx = () => PLOT_W / svg.getBoundingClientRect().width;
  // One pointer pans once zoomed in; two pinch. A drag mustn't also count as a tap.
  const pointers = new Map();
  let dragged = false;
  let onMinimap = false; // a press on the minimap steers the view instead of panning it
  svg.addEventListener("pointerdown", (e) => {
    lastPointer = e.pointerType;
    onMinimap = e.isPrimary && !!e.target.closest(".minimap");
    if (onMinimap) {
      dragged = true;
      svg.setPointerCapture(e.pointerId);
      centerOn(fromMinimap(toPlot(e)));
      return;
    }
    if (e.isPrimary) pointers.clear(); // first finger down, so any entry left over is stale
    if (!pointers.size) dragged = false;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 || state.view.w < PLOT_W) svg.setPointerCapture(e.pointerId);
  });
  // On window, since a lift can land outside the chart when a redraw removes the element it started on.
  const release = (e) => {
    pointers.delete(e.pointerId);
    onMinimap = false;
  };
  addEventListener("pointerup", release);
  addEventListener("pointercancel", release);
  svg.addEventListener("pointermove", (e) => {
    if (onMinimap) return centerOn(fromMinimap(toPlot(e)));
    const prev = pointers.get(e.pointerId);
    if (prev) {
      const cur = { x: e.clientX, y: e.clientY };
      if (pointers.size === 2) {
        const [other] = [...pointers].filter(([id]) => id !== e.pointerId).map(([, pt]) => pt);
        const f = Math.hypot(cur.x - other.x, cur.y - other.y) / (Math.hypot(prev.x - other.x, prev.y - other.y) || 1);
        const mid = toPlot({ clientX: (cur.x + other.x) / 2, clientY: (cur.y + other.y) / 2 });
        zoomAt(f, mid);
        panBy(((cur.x - prev.x) / 2) * unitsPerPx(), ((cur.y - prev.y) / 2) * unitsPerPx());
        dragged = true;
      } else if (state.view.w < PLOT_W && (dragged || Math.hypot(cur.x - prev.x, cur.y - prev.y) > 3)) {
        panBy((cur.x - prev.x) * unitsPerPx(), (cur.y - prev.y) * unitsPerPx());
        dragged = true;
      } else return; // under the drag threshold: keep the start point
      pointers.set(e.pointerId, cur);
      hideTip();
      return;
    }
    if (e.pointerType !== "mouse") return;
    const [dot] = dotsNear(e, REACH.mouse);
    svg.style.cursor = dot ? "pointer" : "";
    if (dot) showTip(e, dot);
    else hideTip();
  });
  svg.addEventListener("pointerleave", hideTip);
  svg.addEventListener("click", (e) => {
    if (dragged) return;
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
  // Scrolling out past full view is left to the page, so the chart doesn't trap scrolling.
  svg.addEventListener("wheel", (e) => {
    if (e.deltaY > 0 && state.view.w >= PLOT_W) return;
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.002), toPlot(e));
  }, { passive: false });
  const center = toXY({ p: 1, c: 1, f: 1 });
  $("#zoom-in").addEventListener("click", () => zoomAt(2, center));
  $("#zoom-out").addEventListener("click", () => zoomAt(1 / 2, center));
  $("#zoom-reset").addEventListener("click", () => setView(0, 0, PLOT_W));
  // Group chips combine (any of the picked groups); "All foods" clears them.
  $("#filters").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    const f = state.filters;
    if ("diet" in btn.dataset) f.diet = btn.dataset.diet;
    else if ("mine" in btn.dataset) f.mine = !f.mine;
    else if (!btn.dataset.group) [f.groups, f.mine] = [[], false];
    else if (f.groups.includes(btn.dataset.group)) f.groups = f.groups.filter((g) => g !== btn.dataset.group);
    else f.groups = [...f.groups, btn.dataset.group];
    state.focus = null;
    save();
    render();
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
    if (!li) return;
    state.query = $("#search").value = "";
    toggleCombo(Number(li.dataset.id));
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

  $("#copy-prompt").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(foodPrompt());
      e.target.textContent = "Copied";
    } catch {
      $("#mine-json").value = foodPrompt(); // clipboard can be blocked; leave it where it can be copied by hand
      e.target.textContent = "Copy it from the box";
    }
    setTimeout(() => (e.target.textContent = "Copy AI prompt"), 2000);
  });
  const showMine = (open) => {
    $("#mine").hidden = !open;
    $("#mine-toggle").setAttribute("aria-expanded", open);
    $("#mine-toggle").setAttribute("aria-pressed", open);
    if (!open) showScan(false);
  };
  const showScan = (open) => {
    stopScan();
    $("#scan").hidden = !open;
    $("#scan-open").setAttribute("aria-expanded", open);
    $("#scan-food").hidden = true;
    $("#scan-code").elements.code.value = "";
    scanMessage("");
    if (!open) return;
    if (!navigator.mediaDevices?.getUserMedia) return scanMessage("This browser can't use the camera here, so type the number instead.");
    startScan((code) => {
      stopScan();
      $("#scan-code").elements.code.value = code;
      lookUpBarcode(code);
    }).catch(() => scanMessage("Couldn't open the camera. Type the number under the barcode instead.", true));
  };
  $("#scan-open").addEventListener("click", () => showScan($("#scan").hidden));
  $("#scan-close").addEventListener("click", () => showScan(false));
  $("#scan-code").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = e.target.elements.code.value.replace(/\D/g, "");
    if (code.length < 8 || code.length > 14) return scanMessage("A barcode number has 8 to 14 digits.", true);
    stopScan();
    lookUpBarcode(code);
  });
  $("#scan-food").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const record = { ...scanned, name: f.name.value, unit: f.unit.value, group: f.group.value, diet: f.diet.value };
    if (importFoods(checkFoods(record))) showScan(false);
  });
  $("#mine-toggle").addEventListener("click", () => showMine($("#mine").hidden));
  $("#close-mine").addEventListener("click", () => showMine(false));
  $("#add-mine").addEventListener("click", () => {
    if (importFoods(parseFoods($("#mine-json").value))) $("#mine-json").value = "";
  });
  $("#import-mine").addEventListener("change", async (e) => {
    const [file] = e.target.files;
    if (file) importFoods(parseFoods(await file.text()));
    e.target.value = "";
  });
  $("#export-mine").addEventListener("click", exportMine);
  $("#mine-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".remove");
    if (!btn) return;
    removeMine(Number(btn.dataset.id));
    render();
  });

  builtIn = await (await fetch("foods.json?v=1ae2dce8")).json();
  setFoods();
  upgradeCombo();
  render();
}

init();
