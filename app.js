const MACROS = ["p", "c", "f"];
const MACRO_NAMES = { p: "Protein", c: "Carbs", f: "Fat" };
const TOP_MATCHES = 5;
const LIST_LENGTH = 30;
const MAX_COMBO = 5;
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

// Fixed tag lists, so foods from the AI prompt or a scan use the same words as the built-in ones.
const MEALS = ["breakfast", "main", "snack", "dessert"];
const ROLES = ["protein", "starch", "vegetable", "fruit", "fat", "sauce", "sweet", "drink", "dish"];
const CUISINES = {
  latin: "Latin", italian: "Italian", mediterranean: "Mediterranean", "middle-eastern": "Middle Eastern",
  indian: "Indian", "east-asian": "East Asian", "southeast-asian": "Southeast Asian",
};
const DISHES = {
  "breakfast-plate": "breakfast plate", cereal: "cereal & oats", "yogurt-bowl": "yogurt bowl", smoothie: "smoothie & shake",
  salad: "salad", sandwich: "sandwich & wrap", burger: "burger", pizza: "pizza", pasta: "pasta & noodles",
  soup: "soup & stew", curry: "curry", "stir-fry": "stir-fry", "grain-bowl": "rice & grain bowl", tacos: "tacos & burritos",
  sushi: "sushi", grill: "grill & bbq", roast: "roast dinner", "snack-board": "snack board", baked: "baked goods",
  dessert: "dessert", "protein-snack": "protein snack",
};
// Pairing scores; scripts/pairing_report.py uses the same numbers to check the tags.
const MEAL_BONUS = 1; // a shared meal, about what one common dish type is worth
const ROLE_BONUS = 2; // a different role fills a gap in the meal
const DISH_PENALTY = 2; // a complete dish wants sides, not another main
const SIDE_ROLES = ["vegetable", "fruit", "sauce", "drink"];
const SWAP_ROLES = ["starch", "fat", "drink", "dish"]; // two of these in one meal are usually alternatives
const SWAP_FACTOR = 0.5;
const NO_CLASH_ROLES = ["drink", "sweet", "fruit"]; // go alongside any cuisine
const PAIR_WEIGHT = 0.2; // how much the best pairing counts against target error (a share of the target)
const SLACK = 0.25; // weight of grams on the allowed side of an "at least" or "at most" target; above 0 so the fit still prefers the value
const MODES = { eq: "exactly", min: "at least", max: "at most" };
const MODE_SIGNS = { eq: "", min: "≥ ", max: "≤ " };
const FIT_PULL = 1; // g² of macro error that a food at the edge of its meal-size range costs; small, so the target comes first

const state = {
  foods: [],
  mine: [], // the person's own foods, as entered: [{ id, name, group, diet, unit, grams, protein, carbs, fat, kcal }]
  remaining: { p: 40, c: 60, f: 20 }, // about a 580 kcal meal
  modes: { p: "eq", c: "eq", f: "eq" }, // per macro, a key of MODES
  combo: [], // [{ id, grams, unit }], unit being a label from units(food)
  caps: true, // hold combo amounts to at most what a person eats in one meal
  floors: true, // and to at least a small portion of each, so no food drops out
  query: "",
  focus: null, // { id, nearby: ids of the dots around it }
  filters: { groups: [], meals: [], diet: "", mine: false, anyFood: false }, // no groups or meals means all of them; diet "", "vegetarian" or "vegan"
  filtersOpen: false,
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
    if (saved.modes) for (const k of MACROS) if (saved.modes[k] in MODES) state.modes[k] = saved.modes[k];
    if (saved.combo) state.combo = saved.combo;
    if (saved.filters) state.filters = { ...state.filters, ...saved.filters };
    if (saved.caps === false) state.caps = false;
    if (saved.floors === false) state.floors = false;
    if (saved.filtersOpen) state.filtersOpen = true;
  } catch {}
  try {
    state.mine = JSON.parse(localStorage.getItem(FOODS_KEY) || "[]").filter((r) => !checkFoods(r).errors.length);
  } catch {}
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ remaining: state.remaining, modes: state.modes, combo: state.combo, filters: state.filters, filtersOpen: state.filtersOpen, caps: state.caps, floors: state.floors }));
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
    meals: r.meals, role: r.role, cuisines: r.cuisines, dishes: r.dishes, min: r.min * g, max: r.max * g,
  };
}
let tagWeight = {};
let foodsVersion = 0;
// A food of mine hides the built-in food with the same name.
function setFoods() {
  const names = new Set(state.mine.map((r) => r.name.toLowerCase()));
  state.foods = [...builtIn.filter((f) => !names.has(f.name.toLowerCase())), ...state.mine.map(toFood)];
  // Rarer tags count for more: the log of how many foods there are per food carrying the tag.
  const counts = {};
  for (const f of state.foods) {
    f.tags = new Set([...f.cuisines, ...f.dishes]);
    for (const t of f.tags) counts[t] = (counts[t] ?? 0) + 1;
  }
  tagWeight = Object.fromEntries(Object.entries(counts).map(([t, n]) => [t, Math.log(state.foods.length / n)]));
  foodsVersion++;
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
- "min", "max": the least and most of the unit one person would eat in one meal, e.g. 5 and 30 for "chip", 1 and 3 for "egg"
- "meals": when it's eaten, any of ${MEALS.map((m) => `"${m}"`).join(", ")}
- "role": its part in a meal, one of ${ROLES.map((r) => `"${r}"`).join(", ")}; "dish" means a complete meal on its own
- "cuisines": any of ${Object.keys(CUISINES).map((c) => `"${c}"`).join(", ")}, only where the food would seem out of place in most other cuisines; generic ingredients get []
- "dishes": every kind of dish it goes into or alongside, from ${Object.keys(DISHES).map((d) => `"${d}"`).join(", ")}; when unsure, include it
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
    const [min, max] = ["min", "max"].map(num);
    if (!(min > 0 && max > min)) return errors.push(`${label}: "min" and "max" must be amounts of one unit for a meal, with max above min.`);
    const list = (k) => (Array.isArray(item[k]) ? item[k] : String(item[k] ?? "").split(/[\s,]+/)).map((v) => String(v).trim());
    const meals = list("meals").filter((m) => MEALS.includes(m));
    if (!meals.length) return errors.push(`${label}: "meals" needs at least one of ${MEALS.join(", ")}.`);
    const role = String(item.role ?? "").trim();
    if (!ROLES.includes(role)) return errors.push(`${label}: "role" must be one of ${ROLES.join(", ")}.`);
    const diet = ["vegan", "vegetarian"].includes(item.diet) ? item.diet : null;
    records.push({
      name, group: String(item.group ?? "").trim() || "Other", diet, unit, grams, protein, carbs, fat,
      kcal: kcal >= 0 ? kcal : null, min, max, meals, role,
      cuisines: list("cuisines").filter((c) => c in CUISINES), dishes: list("dishes").filter((d) => d in DISHES),
    });
  });
  return { records, errors };
}

// A food with the same name as one already added, or as a built-in food, replaces it, keeping its place in any combo.
function addMine(records) {
  let next = Math.min(0, ...state.mine.map((r) => r.id)) - 1; // negative ids never clash with USDA ones
  for (const r of records) {
    const old = state.mine.find((m) => m.name.toLowerCase() === r.name.toLowerCase());
    if (old) Object.assign(old, r);
    else state.mine.push({ id: next--, ...r });
  }
  saveMine();
  state.combo = state.combo.map((c) => {
    const built = builtIn.find((f) => f.id === c.id);
    const mine = built && state.foods.find((f) => f.mine && f.name.toLowerCase() === built.name.toLowerCase());
    return mine ? newEntry(mine) : c;
  });
  save();
}

// Returns what restoreMine needs to put the food back where it was.
function removeMine(id) {
  const index = state.mine.findIndex((r) => r.id === id);
  const at = state.combo.findIndex((c) => c.id === id);
  const removed = { record: state.mine[index], index, entry: state.combo[at], at };
  state.mine.splice(index, 1);
  if (at >= 0) state.combo.splice(at, 1);
  if (state.focus?.id === id) state.focus = null;
  saveMine();
  save();
  return removed;
}

function restoreMine({ record, index, entry, at }) {
  state.mine.splice(Math.min(index, state.mine.length), 0, record);
  if (entry && state.combo.length < MAX_COMBO) state.combo.splice(Math.min(at, state.combo.length), 0, entry);
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

// A first guess at meals, role and dish types from the food group, refined by Open Food Facts categories
// (the first matching category with a role sets it).
const GROUP_TAGS = {
  "Meat & fish": { meals: ["main"], role: "protein", dishes: ["grill", "sandwich", "salad"] },
  "Eggs & dairy": { meals: ["breakfast", "snack"], role: "protein", dishes: ["breakfast-plate"] },
  "Plant protein": { meals: ["main"], role: "protein", dishes: ["grain-bowl", "salad"] },
  "Grains & starches": { meals: ["breakfast", "main"], role: "starch", dishes: [] },
  Fruit: { meals: ["breakfast", "snack"], role: "fruit", dishes: ["yogurt-bowl", "smoothie", "snack-board"] },
  Vegetables: { meals: ["main"], role: "vegetable", dishes: ["salad", "roast", "stir-fry"] },
  "Fats & nuts": { meals: ["snack"], role: "fat", dishes: ["snack-board", "salad"] },
  "Snacks & sweets": { meals: ["snack"], role: "sweet", dishes: ["snack-board"] },
  "Prepared foods": { meals: ["main"], role: "dish", dishes: [] },
  "Sauces & condiments": { meals: ["main"], role: "sauce", dishes: [] },
  Drinks: { meals: ["main", "snack"], role: "drink", dishes: [] },
};
const OFF_CATEGORY_TAGS = [
  { re: /protein/, meals: ["snack"], role: "protein", dishes: ["protein-snack", "smoothie"] },
  { re: /breakfast-cereals|mueslis|granolas|porridge|oat-flakes/, meals: ["breakfast"], role: "starch", dishes: ["cereal", "yogurt-bowl"] },
  { re: /yogurts/, meals: ["breakfast", "snack"], role: "protein", dishes: ["yogurt-bowl", "smoothie", "protein-snack"] },
  { re: /cereal-bars|snack-bars|energy-bars/, meals: ["snack"], role: "starch", dishes: ["protein-snack", "snack-board"] },
  { re: /pizzas/, meals: ["main"], role: "dish", dishes: ["pizza"], cuisines: ["italian"] },
  { re: /pasta-sauces|pestos/, role: "sauce", dishes: ["pasta", "pizza"], cuisines: ["italian"] },
  { re: /pastas/, role: "starch", dishes: ["pasta"], cuisines: ["italian"] },
  { re: /soups/, meals: ["main"], dishes: ["soup"] },
  { re: /burritos|tortillas|salsas|tacos|nachos/, dishes: ["tacos", "grain-bowl"], cuisines: ["latin"] },
  { re: /hummus/, dishes: ["snack-board", "sandwich", "grain-bowl"], cuisines: ["middle-eastern"] },
  { re: /curries|curry/, dishes: ["curry"], cuisines: ["indian"] },
  { re: /noodles|ramen/, dishes: ["soup", "stir-fry"], cuisines: ["east-asian"] },
  { re: /soy-sauces|sushi/, dishes: ["stir-fry", "sushi", "grain-bowl"], cuisines: ["east-asian"] },
  { re: /crisps|chips|crackers|popcorn|pretzels/, meals: ["snack"], role: "starch", dishes: ["snack-board", "sandwich"] },
  { re: /biscuits|cookies|cakes|pastries/, meals: ["snack", "dessert"], role: "sweet", dishes: ["dessert", "baked"] },
  { re: /ice-creams|frozen-desserts|chocolates|candies|confectioneries/, meals: ["snack", "dessert"], role: "sweet", dishes: ["dessert"] },
  { re: /breads/, meals: ["breakfast", "main"], role: "starch", dishes: ["sandwich", "breakfast-plate"] },
  { re: /cheeses/, meals: ["main", "snack"], role: "fat", dishes: ["sandwich", "snack-board", "pizza", "salad"] },
  { re: /dressings/, role: "sauce", dishes: ["salad"] },
  { re: /nut-butters|peanut-butters/, meals: ["breakfast", "snack"], role: "fat", dishes: ["sandwich", "smoothie", "yogurt-bowl"] },
  { re: /juices|smoothies/, meals: ["breakfast"], role: "drink", dishes: ["breakfast-plate", "smoothie"] },
  { re: /milks/, meals: ["breakfast"], role: "drink", dishes: ["cereal", "smoothie"] },
  { re: /sodas|soft-drinks|beers|wines/, meals: ["main"], role: "drink", dishes: ["burger", "pizza", "grill"] },
];

function offTags(p, group) {
  const categories = (p.categories_tags ?? []).join(" ");
  const hits = OFF_CATEGORY_TAGS.filter(({ re }) => re.test(categories));
  const base = GROUP_TAGS[group] ?? GROUP_TAGS["Prepared foods"];
  const all = (k) => [...new Set(hits.flatMap((h) => h[k] ?? []))];
  const orBase = (k) => (all(k).length ? all(k) : base[k]);
  return {
    meals: orBase("meals"),
    role: hits.find((h) => h.role)?.role ?? base.role,
    cuisines: all("cuisines"),
    dishes: orBase("dishes"),
  };
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
  const group = offGroup(p);
  const units = (n) => Math.round(n * per * 100) / 100;
  return {
    name: brand && !product.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${product}`.trim() : product,
    group, ...offTags(p, group), min: units(0.5), max: units(3), // half to three label servings
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

let scanTags = [];
const tagLabel = (t) => CUISINES[t] ?? DISHES[t];

// The scanned food's cuisines and dish types, as chips that remove themselves, plus a menu to add more.
function drawScanTags() {
  const rest = [...Object.keys(CUISINES), ...Object.keys(DISHES)].filter((t) => !scanTags.includes(t));
  $("#scan-tags").innerHTML = scanTags.map((t) =>
    `<button type="button" class="chip" aria-pressed="true" data-tag="${t}" aria-label="Remove ${esc(tagLabel(t))}">${esc(tagLabel(t))} ×</button>`).join("") +
    `<select id="scan-tag-add" class="chip" aria-label="Add a cuisine or dish"><option value="">Add…</option>${
      rest.map((t) => `<option value="${t}">${esc(tagLabel(t))}</option>`).join("")}</select>`;
}

function labelScanLimits() {
  const unit = $("#scan-food").elements.unit.value.trim() || "unit";
  $("#scan-min-label").textContent = `Least in a meal (${unit})`;
  $("#scan-max-label").textContent = `Most in a meal (${unit})`;
}

function showScanned(r) {
  const form = $("#scan-food");
  const groups = [...new Set(state.foods.map((f) => f.group))].sort();
  form.elements.group.innerHTML = groups.map((g) => `<option>${esc(g)}</option>`).join("");
  form.elements.role.innerHTML = ROLES.map((role) => `<option>${role}</option>`).join("");
  for (const k of ["name", "unit", "group", "diet", "role", "min", "max"]) form.elements[k].value = r[k];
  for (const box of form.elements.meals) box.checked = r.meals.includes(box.value);
  scanTags = [...r.cuisines, ...r.dishes];
  drawScanTags();
  labelScanLimits();
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
  return { id: food.id, unit: unit.label, grams: roundAmount(food, unit, count * unit.g) };
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

// Amounts move in steps of about an eighth of the food's meal-size range, at a round number: 0.1 of a
// chicken breast, 0.02 of a pot. Foods eaten several units at a time keep to half units or more (eggs, slices).
function stepOf(food, unit) {
  if (unit.label === "g") return 5;
  if (unit.label === "oz") return 0.5;
  const range = (food.max - food.min) / unit.g;
  const raw = range / 8, k = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * k).reduce((a, b) => (Math.abs(Math.log(b / raw)) < Math.abs(Math.log(a / raw)) ? b : a));
  return range >= 2 ? Math.max(0.5, step) : step;
}
// Without caps a food can grow as far as needed; without floors it can drop to none.
const bounds = (food) => [state.floors ? food.min : 0, state.caps ? food.max : Infinity];

// Rounds to the food's step in that unit, kept inside its bounds when a step fits there.
function roundAmount(food, unit, grams) {
  const step = stepOf(food, unit) * unit.g;
  const [min, max] = bounds(food);
  const lo = Math.ceil(min / step - 1e-9) * step, hi = Math.floor(max / step + 1e-9) * step;
  const g = Math.round(grams / step) * step;
  return lo <= hi ? Math.min(hi, Math.max(lo, g)) : g;
}
const qtyIn = (unit, grams) => {
  const n = grams / unit.g;
  if (unit.label === "g") return Math.round(n);
  return unit.label === "oz" ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100;
};
const amountText = (unit, grams) => `${qtyIn(unit, grams)} ${unit.label}`;

// The share of the target's grams (all macros together) that an amount of a food provides.
function shareOf(food, grams) {
  const target = MACROS.reduce((s, k) => s + state.remaining[k], 0);
  return target ? MACROS.reduce((s, k) => s + macrosOf(food, grams)[k], 0) / target : 0;
}

function serving(food) {
  const { grams, unit } = newEntry(food);
  return { grams, unit, share: shareOf(food, grams) };
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

// Least squares in grams per food, each held inside its bounds: minimise macroError² plus, with either limit on,
// a small pull toward the middle of each meal-size range, which picks the realistic answer when several hit the target.
// With "at least" or "at most" targets, the cost is one quadratic per guess of which side of its value each such total
// lands on. The cost is convex and smooth, so a guess that its own optimum confirms gives the global optimum.
function solveCombo(foods, r, modes = state.modes) {
  const cols = foods.map(perGram);
  const [lo, hi] = [0, 1].map((j) => foods.map((f) => bounds(f)[j]));
  const mid = foods.map((f) => (f.min + f.max) / 2);
  const pull = foods.map((f) => (state.caps || state.floors ? FIT_PULL / ((f.max - f.min) / 2) ** 2 : 0));
  const solve = (sides) => solveBoxed(cols, r, Object.fromEntries(MACROS.map((k) => [k, sides[k] ? SLACK ** 2 : 1])), lo, hi, mid, pull);
  const sidesOf = (x) => allowedSides(cols, x, r, modes);
  const tried = new Map();
  for (let sides = sidesOf(null); !tried.has(JSON.stringify(sides)); ) {
    const x = solve(sides);
    tried.set(JSON.stringify(sides), x);
    const next = sidesOf(x);
    if (MACROS.every((k) => next[k] === sides[k])) return x;
    sides = next;
  }
  // The guesses went round in a loop, so try every one.
  const sided = MACROS.filter((k) => modes[k] !== "eq");
  const cost = (x) => macroError(cols, x, r, modes) ** 2 + x.reduce((s, v, i) => s + pull[i] * (v - mid[i]) ** 2, 0);
  let best = null;
  for (let code = 0; code < 2 ** sided.length; code++) {
    const sides = Object.fromEntries(MACROS.map((k) => [k, false]));
    sided.forEach((k, i) => (sides[k] = !!((code >> i) & 1)));
    const x = tried.get(JSON.stringify(sides)) ?? solve(sides);
    const c = cost(x);
    if (!best || c < best.cost) best = { x, cost: c };
  }
  return best.x;
}

// Minimises Σ w_k (A x − r)_k² + Σ pull_i (x_i − mid_i)² with each x_i in [lo_i, hi_i]. Every food is tried at its
// lower bound, at its upper bound and free (3^n cases); the problem is convex, so the best feasible case is the optimum.
function solveBoxed(cols, r, w, lo, hi, mid, pull) {
  const n = cols.length;
  const dot = (a, b) => MACROS.reduce((s, k) => s + w[k] * a[k] * b[k], 0);
  const G = cols.map((a) => cols.map((b) => dot(a, b)));
  const Ar = cols.map((a) => dot(a, r));
  const cost = (x) => MACROS.reduce((s, k) => s + w[k] * (cols.reduce((t, v, i) => t + v[k] * x[i], 0) - r[k]) ** 2, 0) +
    x.reduce((s, v, i) => s + pull[i] * (v - mid[i]) ** 2, 0);
  let best = null;
  for (let code = 0; code < 3 ** n; code++) {
    const x = [], free = [];
    for (let i = 0, c = code; i < n; i++, c = Math.floor(c / 3)) {
      if (c % 3 === 0) free.push(i);
      x[i] = [null, lo[i], hi[i]][c % 3];
    }
    if (x.includes(Infinity)) continue;
    if (free.length) {
      const M = free.map((i) => free.map((j) => G[i][j] + (i === j ? pull[i] : 0)));
      const rhs = free.map((i) => Ar[i] + pull[i] * mid[i] - x.reduce((s, v, j) => (v == null ? s : s + G[i][j] * v), 0));
      const sol = gaussSolve(M, rhs);
      if (!sol || sol.some((v, j) => v < lo[free[j]] - 1e-6 || v > hi[free[j]] + 1e-6)) continue;
      free.forEach((i, j) => (x[i] = sol[j]));
    }
    if (code === 0) return x; // the unbounded optimum already sits inside every range
    const c = cost(x);
    if (!best || c < best.cost) best = { x, cost: c };
  }
  return best.x;
}

// Rounds each amount to its step, then moves amounts a step at a time, alone or traded between two foods,
// while that lowers macroError: rounding each food on its own can add up to grams off.
function roundCombo(foods, units, x, r) {
  const cols = foods.map(perGram);
  const g = foods.map((f, i) => roundAmount(f, units[i], x[i]));
  const steps = foods.map((f, i) => stepOf(f, units[i]) * units[i].g);
  const fits = (i) => { const [min, max] = bounds(foods[i]); return g[i] >= min - 1e-9 && g[i] <= max + 1e-9; };
  const moves = foods.flatMap((_, i) => [[[i, 1]], [[i, -1]], ...foods.flatMap((_, j) => (j === i ? [] : [[[i, 1], [j, -1]]]))]);
  for (let pass = 0, moved = true; moved && pass < 50; pass++) {
    moved = false;
    for (const move of moves) {
      const before = macroError(cols, g, r);
      for (const [i, d] of move) g[i] += d * steps[i];
      if (move.every(([i]) => fits(i)) && macroError(cols, g, r) < before - 1e-9) moved = true;
      else for (const [i, d] of move) g[i] -= d * steps[i];
    }
  }
  return g;
}

// Per macro, whether the total sits on the allowed side of an "at least" or "at most" value. No amounts yet means none do.
function allowedSides(cols, x, r, modes) {
  return Object.fromEntries(MACROS.map((k) => {
    const d = x ? cols.reduce((t, v, i) => t + v[k] * x[i], 0) - r[k] : 0;
    return [k, (modes[k] === "min" && d > 0) || (modes[k] === "max" && d < 0)];
  }));
}

// Distance from the target, in grams of macros, with grams on the allowed side of an "at least" or "at most" value scaled by SLACK.
function macroError(cols, x, r, modes = state.modes) {
  const sides = allowedSides(cols, x, r, modes);
  return Math.sqrt(MACROS.reduce((s, k) => {
    const d = cols.reduce((t, v, i) => t + v[k] * x[i], 0) - r[k];
    return s + (sides[k] ? SLACK * d : d) ** 2;
  }, 0));
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
  const { groups, meals, diet } = state.filters;
  if (state.filters.mine && state.mine.length && !food.mine) return false;
  if (groups.length && !groups.includes(food.group)) return false;
  if (meals.length && !food.meals.some((m) => meals.includes(m))) return false;
  return diet === "vegan" ? food.diet === "vegan" : diet === "vegetarian" ? !!food.diet : true;
}

const shareMeal = (a, b) => a.meals.some((m) => b.meals.includes(m));
const sharedTags = (a, b) => [...a.tags].filter((t) => b.tags.has(t));
// Two distinctive foods from different cuisines, like soy sauce and a tortilla.
function clash(a, b) {
  if (NO_CLASH_ROLES.includes(a.role) || NO_CLASH_ROLES.includes(b.role)) return false;
  return a.cuisines.length > 0 && b.cuisines.length > 0 && !a.cuisines.some((c) => b.cuisines.includes(c));
}
// A shared meal is enough for a drink; anything else needs a shared cuisine or dish type.
function goesWith(a, b) {
  if (clash(a, b)) return false;
  if ((a.role === "drink" || b.role === "drink") && shareMeal(a, b)) return true;
  return sharedTags(a, b).length > 0;
}
function pairScore(a, b) {
  let s = sharedTags(a, b).reduce((sum, t) => sum + tagWeight[t], 0);
  if (a.role === b.role && SWAP_ROLES.includes(a.role)) s *= SWAP_FACTOR;
  if (shareMeal(a, b)) s += MEAL_BONUS;
  if (a.role !== b.role) s += ROLE_BONUS;
  if ([a.role, b.role].includes("dish") && !SIDE_ROLES.includes(a.role) && !SIDE_ROLES.includes(b.role)) s -= DISH_PENALTY;
  return s;
}

const pairing = () => !state.filters.anyFood && state.combo.length > 0;
// Passes the filters and, once a combo is started, goes with it.
function shown(food, items = comboItems()) {
  if (inCombo(food.id)) return true;
  if (!passesFilters(food)) return false;
  return !pairing() || (items.every((c) => !clash(c.food, food)) && items.some((c) => goesWith(c.food, food)));
}

// Suggestions re-fit the whole combo, so they depend on which foods are in it but not on their amounts.
let rankCache = {};
function ranked() {
  const key = JSON.stringify([state.remaining, state.modes, state.combo.map((c) => c.id), state.filters, state.caps, state.floors, foodsVersion]);
  if (rankCache.key !== key) rankCache = { key, value: rank() };
  return rankCache.value;
}

// With no combo: nearest first, on the triangle, to the target's split. With one: the foods that would
// bring it closest to the target, with the amount the fit gives them, helped up by how well they pair.
function rank() {
  const items = comboItems();
  const r = state.remaining;
  if (!items.length) {
    const target = toXY(r);
    const dist = (food) => {
      const xy = toXY(food);
      return target && xy ? Math.hypot(xy[0] - target[0], xy[1] - target[1]) : Infinity;
    };
    return state.foods
      .filter(passesFilters)
      .map((food) => ({ food, d: dist(food), ...serving(food) }))
      .sort((a, b) => a.d - b.d);
  }
  const norm = Math.hypot(...MACROS.map((k) => r[k])) || 1;
  const base = items.slice(items.length >= MAX_COMBO ? 1 : 0); // adding a food pushes out the oldest
  const picks = state.foods.filter((f) => !inCombo(f.id) && shown(f, items)).map((food) => {
    const foods = [...base.map((c) => c.food), food];
    const x = solveCombo(foods, r);
    const unit = findUnit(food, food.unit);
    const grams = roundAmount(food, unit, x.at(-1));
    return {
      food, grams, unit: unit.label, share: shareOf(food, grams),
      err: macroError(foods.map(perGram), x, r) / norm,
      pair: pairing() ? items.reduce((s, c) => s + pairScore(c.food, food), 0) : 0,
    };
  });
  const useful = picks.filter((p) => p.grams > 0); // without floors, the fit can leave a food out
  const top = Math.max(1, ...useful.map((p) => p.pair));
  for (const p of useful) p.d = p.err - (PAIR_WEIGHT * p.pair) / top;
  return useful.sort((a, b) => a.d - b.d);
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

function drawPlot(suggestions) {
  const rank = [...suggestions, ...comboItems().map(({ food, grams, unit }) => ({ food, grams, unit, share: shareOf(food, grams) }))];
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
    const pts = hull(items.map(({ food }) => plotXY(food))).map((p) => p.join(",")).join(" ");
    svg.append(svgEl(items.length === 2 ? "polyline" : "polygon", { class: "combo-shape", points: pts, "clip-path": "url(#frame-clip)" }));
  }

  const matchRank = new Map(rank.slice(0, TOP_MATCHES).map((r, i) => [r.food.id, i + 1]));
  const faded = svgEl("g", { class: "faded" });
  const ranks = new Set(rank.map((r) => r.food.id));
  for (const food of state.foods) {
    const xy = !ranks.has(food.id) && plotXY(food);
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

// Outline around a set of points (Andrew's monotone chain).
function hull(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (pts) => pts.reduce((h, pt) => {
    while (h.length >= 2 && cross(h.at(-2), h.at(-1), pt) <= 0) h.pop();
    h.push(pt);
    return h;
  }, []);
  return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)];
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
    .filter((r) => !q || r.food.name.toLowerCase().includes(q))
    .slice(0, LIST_LENGTH);
  const ol = $("#ranked");
  if (!rows.length) {
    ol.innerHTML = `<li class="empty">${q ? `No foods match “${esc(state.query)}”`
      : pairing() ? "No foods that go with your combo would bring it closer to the target. Try Any food"
      : state.combo.length ? "No foods would bring your combo closer to the target" : "No foods pass the filters"}.</li>`;
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
  $("#caps-toggle").setAttribute("aria-checked", state.caps);
  $("#floors-toggle").setAttribute("aria-checked", state.floors);

  $("#combo-items").innerHTML = items.map(({ food, grams, unit: label }, i) => {
    const unit = findUnit(food, label);
    const options = units(food).map((u) =>
      `<option value="${esc(u.label)}"${u.label === unit.label ? " selected" : ""}>${esc(u.label)}</option>`).join("");
    const age = fresh?.id === food.id ? performance.now() - fresh.at : Infinity;
    return `
    <li${age < FRESH_MS ? ` class="just-added" style="animation-delay: ${-Math.round(age)}ms"` : ""}>
      <span class="rank">${i + 1}</span>
      <span class="name">${esc(food.name)}</span>
      <button type="button" class="remove" data-id="${food.id}" aria-label="Remove ${esc(food.name)}">×</button>
      <span class="serving">
        <input type="number" class="qty" data-id="${food.id}" min="0" step="${stepOf(food, unit)}" value="${qtyIn(unit, grams)}"
          aria-label="Amount of ${esc(food.name)}">
        <select class="unit" data-id="${food.id}" aria-label="Unit for ${esc(food.name)}">${options}</select>
        <span class="muted equiv" data-id="${food.id}"></span>
      </span>
      <span class="sub">${splitBar(food)}<span class="item-macros" data-id="${food.id}"></span></span>
    </li>`;
  }).join("") +
    (items.length < MAX_COMBO ? `<li class="empty">Add ${MAX_COMBO - items.length === 1 ? "one more food" : `up to ${MAX_COMBO - items.length} more foods`} from the list or map.</li>` : "");
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
  const togo = (k) => {
    const d = state.remaining[k] - total[k];
    const mode = state.modes[k];
    if ((mode === "min" && d <= 0.5) || (mode === "max" && d >= -0.5)) return `<td class="met">✓ Met</td>`;
    return d < -0.5 ? `<td class="over">${fmt(-d)} g over</td>` : `<td>${fmt(Math.max(d, 0))} g</td>`;
  };
  $("#combo-totals").innerHTML =
    `<tr><th></th>${MACROS.map((k) => `<th>${MACRO_NAMES[k]}</th>`).join("")}</tr>` +
    row("Combo gives", total) +
    `<tr><td>Target</td>${MACROS.map((k) => `<td>${MODE_SIGNS[state.modes[k]]}${fmt(state.remaining[k])} g</td>`).join("")}</tr>` +
    `<tr><td>Still to go</td>${MACROS.map(togo).join("")}</tr>`;
}

// Amounts that land closest to the target within each food's bounds, rounded to its step in its chosen unit.
function fitCombo() {
  const items = comboItems();
  const foods = items.map((c) => c.food);
  const grams = roundCombo(foods, items.map((c) => findUnit(c.food, c.unit)), solveCombo(foods, state.remaining), state.remaining);
  items.forEach((c, i) => (state.combo.find((e) => e.id === c.id).grams = grams[i]));
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
    const hit = ranked().find((r) => r.food.id === id); // a suggestion comes in at the amount it was shown with
    state.combo.push(hit ? { id, unit: hit.unit, grams: hit.grams } : newEntry(state.foods.find((f) => f.id === id)));
    fresh = { id, at: performance.now() };
    if (state.combo.length > MAX_COMBO) {
      const out = state.combo.shift();
      save();
      render();
      return showPushedOut(out, id);
    }
  }
  closeToast();
  save();
  render();
}

const TOAST_MS = 6000;
const FRESH_MS = 1600; // keep in step with the just-added animation in style.css
let fresh = null; // { id, at }: the food that just came into the combo, briefly highlighted
let toast = null; // { undo, timer, left, started }
const foodName = (id) => state.foods.find((f) => f.id === id)?.name ?? "A food";
function announce(text) {
  const live = $("#toast-live");
  live.textContent = ""; // cleared first so the same words are read again
  setTimeout(() => (live.textContent = text), 50);
}
function showToast(text, undo) {
  closeToast();
  $("#toast-msg").textContent = text;
  $("#toast").hidden = false;
  toast = { undo, timer: 0, left: TOAST_MS, started: 0 };
  if (!$("#toast").matches(":hover, :focus-within")) runToast();
  announce(`${text} Undo is available.`);
}
function undoToast() {
  if (!toast) return;
  const { undo } = toast;
  closeToast();
  undo();
}
function showPushedOut(out, inId) {
  showToast(`${foodName(out.id)} was removed to make room for ${foodName(inId)}.`, () => undoPushOut(out, inId));
}
function runToast() {
  if (!toast || toast.timer) return;
  toast.started = performance.now();
  toast.timer = setTimeout(closeToast, toast.left);
}
function pauseToast() {
  if (!toast || !toast.timer) return;
  clearTimeout(toast.timer);
  toast.timer = 0;
  toast.left = Math.max(1500, toast.left - (performance.now() - toast.started)); // a moment to read it after the pointer leaves
}
function closeToast() {
  if (!toast) return;
  clearTimeout(toast.timer);
  toast = null;
  $("#toast").hidden = true;
}
function undoPushOut(out, inId) {
  state.combo = state.combo.filter((c) => c.id !== inId && c.id !== out.id);
  state.combo.unshift(out); // back in its old place, as the oldest
  state.combo.length = Math.min(state.combo.length, MAX_COMBO);
  if (fresh?.id === inId) fresh = null;
  save();
  render();
  announce(`${foodName(out.id)} is back in the combo and ${foodName(inId)} was removed.`);
}
function setupToast() {
  const el = $("#toast");
  el.addEventListener("pointerenter", pauseToast);
  el.addEventListener("pointerleave", () => !el.contains(document.activeElement) && runToast());
  el.addEventListener("focusin", pauseToast);
  el.addEventListener("focusout", (e) => !el.contains(e.relatedTarget) && !el.matches(":hover") && runToast());
  el.addEventListener("keydown", (e) => e.key === "Escape" && closeToast());
  $("#toast-undo").addEventListener("click", undoToast);
  $("#toast-close").addEventListener("click", closeToast);
}

const DIETS = [["", "Any diet"], ["vegetarian", "Vegetarian"], ["vegan", "Vegan"]];
const MEAL_LABELS = { breakfast: "Breakfast", main: "Lunch & dinner", snack: "Snack", dessert: "Dessert" };

// What the filters hold back, so the collapsed control still explains why foods are missing or faded.
function filterSummary() {
  const { groups, meals, diet } = state.filters;
  const mine = state.filters.mine && state.mine.length > 0;
  const parts = [
    mine && "My foods",
    diet && DIETS.find(([value]) => value === diet)[1],
    meals.length && MEALS.filter((m) => meals.includes(m)).map((m) => MEAL_LABELS[m]).join(", "),
    groups.join(", "),
    pairing() && "Goes with combo",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "All foods";
}

function drawFilters() {
  const { groups, meals, diet } = state.filters;
  const mine = state.filters.mine && state.mine.length > 0;
  const all = [...new Set(state.foods.map((f) => f.group))];
  const chip = (attrs, label, on) => `<button type="button" class="chip" ${attrs} aria-pressed="${on}">${esc(label)}</button>`;
  $("#filters-summary").textContent = filterSummary();
  $("#filters-toggle").setAttribute("aria-expanded", state.filtersOpen);
  $("#filters").hidden = !state.filtersOpen;
  $("#filters").innerHTML = `${state.mine.length ? `
    <div class="filter-row" role="group" aria-labelledby="source-label">
      <span class="filter-label" id="source-label">Source</span>
      <div class="segmented">${chip('data-mine=""', "All foods", !mine)}${chip('data-mine="1"', "My foods", mine)}</div>
    </div>` : ""}
    <div class="filter-row" role="group" aria-labelledby="diet-label">
      <span class="filter-label" id="diet-label">Diet</span>
      <div class="segmented">${DIETS.map(([value, label]) => chip(`data-diet="${value}"`, label, diet === value)).join("")}</div>
    </div>
    <div class="filter-row" role="group" aria-labelledby="meal-label">
      <span class="filter-label" id="meal-label">Meal</span>
      <div class="chips">${MEALS.map((m) => chip(`data-meal="${m}"`, MEAL_LABELS[m], meals.includes(m))).join("")}</div>
    </div>
    <div class="filter-row" role="group" aria-labelledby="groups-label">
      <span class="filter-label" id="groups-label">Group</span>
      <div class="chips">${all.map((g) => chip(`data-group="${esc(g)}"`, g, groups.includes(g))).join("")}${
        groups.length ? '<button type="button" class="link" data-clear-groups>Clear</button>' : ""}</div>
    </div>${state.combo.length ? `
    <div class="filter-row" role="group" aria-labelledby="pair-label">
      <span class="filter-label" id="pair-label">Pair</span>
      <div class="segmented">${chip('data-any="1"', "Any food", state.filters.anyFood)}${chip('data-any=""', "Goes with combo", !state.filters.anyFood)}</div>
    </div>` : ""}`;
}

function render() {
  if (!state.combo.length) state.filters.anyFood = false; // Pair is hidden without a combo, so each new combo starts on Goes with combo
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
      <span class="muted">1 ${esc(r.unit)}${r.grams == null ? "" : ` (${fmt(r.grams)} g)`} · ${macroLine({ p: r.protein, c: r.carbs, f: r.fat }, " g")} · ${fmt(r.min)}–${fmt(r.max)} per meal</span>
      <span class="muted">${esc([r.meals.join(", "), r.role, ...[...r.cuisines, ...r.dishes].map(tagLabel)].join(" · "))}</span>
      <button type="button" class="remove" data-id="${r.id}" aria-label="Delete ${esc(r.name)}">×</button>
    </li>`).join("");
}

function importFoods({ records, errors }) {
  if (records.length) {
    closeToast(); // an undone delete could otherwise bring back a food with the same name
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
  const labelMode = (k) => (form.elements[`${k}-mode`].title = `${MACRO_NAMES[k]}: ${MODES[state.modes[k]]}`);
  for (const k of MACROS) {
    form.elements[k].value = state.remaining[k];
    form.elements[`${k}-mode`].value = state.modes[k];
    labelMode(k);
  }
  form.addEventListener("input", () => {
    for (const k of MACROS) {
      state.remaining[k] = Math.max(0, Number(form.elements[k].value) || 0);
      state.modes[k] = form.elements[`${k}-mode`].value;
      labelMode(k);
    }
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
  $("#filters-toggle").addEventListener("click", () => {
    state.filtersOpen = !state.filtersOpen;
    save();
    drawFilters();
  });
  // Group and meal chips combine (any of the picked ones).
  $("#filters").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip, [data-clear-groups]");
    if (!btn) return;
    const f = state.filters;
    if ("clearGroups" in btn.dataset) f.groups = [];
    else if ("any" in btn.dataset) f.anyFood = !!btn.dataset.any;
    else if ("diet" in btn.dataset) f.diet = btn.dataset.diet;
    else if ("mine" in btn.dataset) f.mine = !!btn.dataset.mine;
    else if ("meal" in btn.dataset) f.meals = f.meals.includes(btn.dataset.meal) ? f.meals.filter((m) => m !== btn.dataset.meal) : [...f.meals, btn.dataset.meal];
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
  for (const k of ["caps", "floors"]) {
    $(`#${k}-toggle`).addEventListener("click", () => {
      state[k] = !state[k];
      save();
      render();
    });
  }
  $("#clear-combo").addEventListener("click", () => {
    closeToast();
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
    const record = {
      ...scanned, name: f.name.value, unit: f.unit.value, group: f.group.value, diet: f.diet.value, role: f.role.value,
      min: f.min.value, max: f.max.value, meals: [...f.meals].filter((box) => box.checked).map((box) => box.value),
      cuisines: scanTags.filter((t) => t in CUISINES), dishes: scanTags.filter((t) => t in DISHES),
    };
    if (importFoods(checkFoods(record))) showScan(false);
  });
  $("#scan-tags").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-tag]");
    if (!chip) return;
    scanTags = scanTags.filter((t) => t !== chip.dataset.tag);
    drawScanTags();
  });
  $("#scan-tags").addEventListener("change", (e) => {
    if (!e.target.value) return;
    scanTags.push(e.target.value);
    drawScanTags();
  });
  $("#scan-food").elements.unit.addEventListener("input", labelScanLimits);
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
    const removed = removeMine(Number(btn.dataset.id));
    render();
    showToast(`${removed.record.name} was deleted from My foods.`, () => {
      restoreMine(removed);
      render();
      announce(`${removed.record.name} is back in My foods.`);
    });
  });

  setupToast();

  builtIn = await (await fetch("foods.json?v=fe75a988")).json();
  setFoods();
  upgradeCombo();
  render();
}

init();
