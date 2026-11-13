// The fit: amounts of a set of foods that land closest to a macro target. opts carries { modes, caps, floors }:
// per goal "eq", "min" or "max", and whether each food is held to at most and at least one meal's amount.

const MACROS = ["p", "c", "f"];
const GOALS = [...MACROS, "kcal"]; // what a target can set; any of them can be left empty
const KCAL_PER_G = 4; // kcal off a calorie target that weigh as much in the fit as 1 g off a macro target
const SLACK = 0.25; // weight of grams on the allowed side of an "at least" or "at most" target; above 0 so the fit still prefers the value
const MISS = 5; // weight of grams on the wrong side of one, against 1 for an exact target, so limits come before closeness
const FIT_PULL = 1; // g² of macro error that a food at the edge of its meal-size range costs; small, so the target comes first

// The one rule for a food's calories, per whatever amount its macros are given for: the listed count,
// else Atwater factors. The fit, totals and details all go through it so they agree.
const kcalOf = (m) => m.kcal ?? 4 * m.p + 4 * m.c + 9 * m.f;

function perGram(food) {
  return { p: food.p / 100, c: food.c / 100, f: food.f / 100, kcal: kcalOf(food) / 100 };
}

// What the fit measures: the goals the target sets, each scaled to grams of macro.
const goalsOf = (r) => GOALS.filter((k) => r[k] != null);
const scaleOf = (k) => (k === "kcal" ? 1 / KCAL_PER_G : 1);

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
const bounds = (food, opts) => [opts.floors ? food.min : 0, opts.caps ? food.max : Infinity];

// Rounds to the food's step in that unit, kept inside its bounds when a step fits there.
function roundAmount(food, unit, grams, opts) {
  const step = stepOf(food, unit) * unit.g;
  const [min, max] = bounds(food, opts);
  const lo = Math.ceil(min / step - 1e-9) * step, hi = Math.floor(max / step + 1e-9) * step;
  const g = Math.round(grams / step) * step;
  return lo <= hi ? Math.min(hi, Math.max(lo, g)) : g;
}

// Least squares in grams per food, each held inside its bounds: minimise macroError² plus, with either limit on,
// a small pull toward the middle of each meal-size range, which picks the realistic answer when several hit the target.
// With "at least" or "at most" targets, the cost is one quadratic per guess of which side of its value each such total
// lands on. The cost is convex and smooth, so a guess that its own optimum confirms gives the global optimum.
// A set fixed[i] holds food i at that many grams.
function solveCombo(foods, r, fixed, opts) {
  const { modes } = opts;
  const cols = foods.map(perGram);
  const [lo, hi] = [0, 1].map((j) => foods.map((f, i) => fixed[i] ?? bounds(f, opts)[j]));
  const { mid, pull } = pullOf(foods, opts);
  const goals = goalsOf(r);
  const solve = (sides) => solveBoxed(cols, r, Object.fromEntries(goals.map((k) => [k, (sideWeight(modes[k], sides[k]) * scaleOf(k)) ** 2])), lo, hi, mid, pull);
  const sidesOf = (x) => allowedSides(cols, x, r, modes);
  const tried = new Map();
  for (let sides = sidesOf(null); !tried.has(JSON.stringify(sides)); ) {
    const x = solve(sides);
    tried.set(JSON.stringify(sides), x);
    const next = sidesOf(x);
    if (goals.every((k) => next[k] === sides[k])) return x;
    sides = next;
  }
  // The guesses went round in a loop, so try every one.
  const sided = goals.filter((k) => modes[k] !== "eq");
  let best = null;
  for (let code = 0; code < 2 ** sided.length; code++) {
    const sides = Object.fromEntries(goals.map((k) => [k, false]));
    sided.forEach((k, i) => (sides[k] = !!((code >> i) & 1)));
    const x = tried.get(JSON.stringify(sides)) ?? solve(sides);
    const c = fitCost(foods, x, r, opts);
    if (!best || c < best.cost) best = { x, cost: c };
  }
  return best.x;
}

// The middle of each food's meal-size range, and how strongly the fit pulls toward it.
function pullOf(foods, opts) {
  return {
    mid: foods.map((f) => (f.min + f.max) / 2),
    pull: foods.map((f) => (opts.caps || opts.floors ? FIT_PULL / ((f.max - f.min) / 2) ** 2 : 0)),
  };
}

// What solveCombo minimises.
function fitCost(foods, x, r, opts) {
  const { mid, pull } = pullOf(foods, opts);
  return macroError(foods.map(perGram), x, r, opts.modes) ** 2 + x.reduce((s, v, i) => s + pull[i] * (v - mid[i]) ** 2, 0);
}

// Minimises Σ w_k (A x − r)_k² over the goals k in w + Σ pull_i (x_i − mid_i)² with each x_i in [lo_i, hi_i], by a primal
// active-set method: solve for the foods off their bounds, step toward that answer until one meets a bound, and free a
// bound food whenever the cost falls by moving it inward. A food with lo = hi stays put.
function solveBoxed(cols, r, w, lo, hi, mid, pull) {
  const n = cols.length;
  const goals = Object.keys(w);
  const dot = (a, b) => goals.reduce((s, k) => s + w[k] * a[k] * b[k], 0);
  const G = cols.map((a) => cols.map((b) => dot(a, b)));
  const trace = 1e-9 * Math.max(...G.map((row, i) => row[i])) || 1e-12;
  const tie = pull.map((p) => p || trace); // with no pull, a trace of one keeps the system solvable when foods are interchangeable
  const H = G.map((row, i) => row.map((v, j) => v + (i === j ? tie[i] : 0)));
  const b = cols.map((a, i) => dot(a, r) + tie[i] * mid[i]);
  const x = mid.map((m, i) => Math.min(hi[i], Math.max(lo[i], m)));
  const at = x.map((v, i) => (lo[i] === hi[i] ? "fixed" : null)); // "lo", "hi", "fixed" or null when free
  for (let iter = 0; iter < 20 * n + 20; iter++) {
    const free = at.flatMap((a, i) => (a ? [] : [i]));
    const z = free.length && gaussSolve(
      free.map((i) => free.map((j) => H[i][j])),
      free.map((i) => b[i] - x.reduce((s, v, j) => (at[j] ? s + H[i][j] * v : s), 0)),
    );
    if (free.length && !z) break;
    let step = 1, block = -1, side = null;
    free.forEach((i, j) => {
      const d = z[j] - x[i];
      const room = d < 0 ? (lo[i] - x[i]) / d : d > 0 ? (hi[i] - x[i]) / d : Infinity;
      if (room < step) [step, block, side] = [Math.max(0, room), i, d < 0 ? "lo" : "hi"];
    });
    free.forEach((i, j) => (x[i] += step * (z[j] - x[i])));
    if (block >= 0) {
      at[block] = side;
      x[block] = side === "lo" ? lo[block] : hi[block];
      continue;
    }
    // At the optimum for this free set; free the bound food whose gradient points inward the most.
    let worst = -1, pullIn = 1e-9 * (1 + Math.abs(b.reduce((s, v) => s + Math.abs(v), 0)));
    at.forEach((a, i) => {
      if (a !== "lo" && a !== "hi") return;
      const g = H[i].reduce((s, h, j) => s + h * x[j], 0) - b[i];
      const inward = a === "lo" ? -g : g;
      if (inward > pullIn) [worst, pullIn] = [i, inward];
    });
    if (worst < 0) break;
    at[worst] = null;
  }
  return x;
}

// Rounds each amount to its step, then moves amounts a step at a time, alone or traded between two foods,
// while that lowers limitMiss, or macroError without raising limitMiss: rounding each food on its own can add up
// to grams off, and can leave a limit the unrounded amounts all but met.
function roundCombo(foods, units, x, r, fixed, opts) {
  const { modes } = opts;
  const cols = foods.map(perGram);
  const g = foods.map((f, i) => fixed[i] ?? roundAmount(f, units[i], x[i], opts));
  const steps = foods.map((f, i) => stepOf(f, units[i]) * units[i].g);
  const fits = (i) => { const [min, max] = bounds(foods[i], opts); return g[i] >= min - 1e-9 && g[i] <= max + 1e-9; };
  const open = foods.flatMap((_, i) => (fixed[i] == null ? [i] : []));
  const moves = open.flatMap((i) => [[[i, 1]], [[i, -1]], ...open.flatMap((j) => (j === i ? [] : [[[i, 1], [j, -1]]]))]);
  for (let pass = 0, moved = true; moved && pass < 50; pass++) {
    moved = false;
    for (const move of moves) {
      const [miss, err] = [limitMiss(cols, g, r, modes), macroError(cols, g, r, modes)];
      for (const [i, d] of move) g[i] += d * steps[i];
      const [newMiss, newErr] = [limitMiss(cols, g, r, modes), macroError(cols, g, r, modes)];
      if (move.every(([i]) => fits(i)) && (newMiss < miss - 1e-9 || (newMiss < miss + 1e-9 && newErr < err - 1e-9))) moved = true;
      else for (const [i, d] of move) g[i] -= d * steps[i];
    }
  }
  return g;
}

// Per goal, whether the total sits on the allowed side of an "at least" or "at most" value. No amounts yet means none do.
function allowedSides(cols, x, r, modes) {
  return Object.fromEntries(goalsOf(r).map((k) => {
    const d = x ? cols.reduce((t, v, i) => t + v[k] * x[i], 0) - r[k] : 0;
    return [k, (modes[k] === "min" && d > 0) || (modes[k] === "max" && d < 0)];
  }));
}

const sideWeight = (mode, allowed) => (allowed ? SLACK : mode === "eq" ? 1 : MISS);

// Distance from the target, in grams of macros (calories scaled by KCAL_PER_G), each goal's miss weighted by sideWeight.
function macroError(cols, x, r, modes) {
  const sides = allowedSides(cols, x, r, modes);
  return Math.sqrt(goalsOf(r).reduce((s, k) => {
    const d = (cols.reduce((t, v, i) => t + v[k] * x[i], 0) - r[k]) * scaleOf(k);
    return s + (sideWeight(modes[k], sides[k]) * d) ** 2;
  }, 0));
}

// How far the totals sit on the wrong side of "at least" and "at most" values, in the same units.
function limitMiss(cols, x, r, modes) {
  const sides = allowedSides(cols, x, r, modes);
  return Math.sqrt(goalsOf(r).reduce((s, k) => {
    if (modes[k] === "eq" || sides[k]) return s;
    return s + ((cols.reduce((t, v, i) => t + v[k] * x[i], 0) - r[k]) * scaleOf(k)) ** 2;
  }, 0));
}

function gaussSolve(M, b) {
  const n = b.length;
  const a = M.map((row, i) => [...row, b[i]]);
  const tol = 1e-14 * Math.max(...M.map((row) => Math.max(...row.map(Math.abs)))); // relative, since grams² per gram² are tiny
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (!(Math.abs(a[piv][col]) > tol)) return null; // also when M is all zeros and tol is 0
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

if (typeof module !== "undefined") {
  module.exports = {
    MACROS, GOALS, kcalOf, perGram, goalsOf, scaleOf, stepOf, bounds, roundAmount,
    solveCombo, solveBoxed, roundCombo, fitCost, macroError, limitMiss, allowedSides, gaussSolve,
  };
}
