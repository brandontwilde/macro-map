const test = require("node:test");
const assert = require("node:assert");
const fit = require("../fit.js");
const foods = require("../foods.json");

// Seeded, so a failure names a case that can be run again.
function generator(seed) {
  let s = seed;
  const next = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return { next, pick: (a) => a[Math.floor(next() * a.length)] };
}

function randomCase(rnd, maxFoods) {
  const n = 1 + Math.floor(rnd.next() * maxFoods);
  const picked = Array.from({ length: n }, () => rnd.pick(foods));
  const r = {
    p: rnd.pick([null, 10 + rnd.next() * 60]),
    c: rnd.pick([null, rnd.next() * 120]),
    f: rnd.pick([null, rnd.next() * 40]),
    kcal: rnd.pick([null, 250 + rnd.next() * 700]),
  };
  if (fit.goalsOf(r).length === 0) r.p = 40;
  const modes = Object.fromEntries(fit.GOALS.map((k) => [k, rnd.pick(["eq", "min", "max"])]));
  const opts = { modes, caps: rnd.next() < 0.7, floors: rnd.next() < 0.7 };
  return { foods: picked, r, opts };
}

const describe = (c) => JSON.stringify({ foods: c.foods.map((f) => f.name), r: c.r, opts: c.opts, fixed: c.fixed });

// Every food at its lower bound, at its upper bound or free: 3^n cases, the best feasible one is the optimum.
function bruteBoxed(cols, r, w, lo, hi, mid, pull) {
  const n = cols.length;
  const goals = Object.keys(w);
  const dot = (a, b) => goals.reduce((s, k) => s + w[k] * a[k] * b[k], 0);
  const G = cols.map((a) => cols.map((b) => dot(a, b)));
  const Ar = cols.map((a) => dot(a, r));
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
      const sol = fit.gaussSolve(M, rhs);
      if (!sol || sol.some((v, j) => v < lo[free[j]] - 1e-6 || v > hi[free[j]] + 1e-6)) continue;
      free.forEach((i, j) => (x[i] = sol[j]));
    }
    const c = boxedCost(cols, r, w, x, mid, pull);
    if (!best || c < best.cost) best = { x, cost: c };
  }
  return best;
}

function boxedCost(cols, r, w, x, mid, pull) {
  return Object.keys(w).reduce((s, k) => s + w[k] * (cols.reduce((t, v, i) => t + v[k] * x[i], 0) - r[k]) ** 2, 0) +
    x.reduce((s, v, i) => s + pull[i] * (v - mid[i]) ** 2, 0);
}

const unitOf = (food) => food.portions.find((u) => u.label === food.unit) ?? { label: "g", g: 1 };

test("solveBoxed matches trying every bound for up to 4 foods", () => {
  const rnd = generator(1);
  for (let t = 0; t < 2000; t++) {
    const c = randomCase(rnd, 4);
    const cols = c.foods.map(fit.perGram);
    const [lo, hi] = [0, 1].map((j) => c.foods.map((f) => fit.bounds(f, c.opts)[j]));
    const mid = c.foods.map((f) => (f.min + f.max) / 2);
    const pull = c.foods.map((f) => (c.opts.caps || c.opts.floors ? 1 / ((f.max - f.min) / 2) ** 2 : 0));
    // The weights solveCombo gives a goal: exact, on the allowed side of a limit, or on the wrong side.
    const w = Object.fromEntries(fit.goalsOf(c.r).map((k) => [k, (rnd.pick([1, 0.25, 5]) * fit.scaleOf(k)) ** 2]));
    const x = fit.solveBoxed(cols, c.r, w, lo, hi, mid, pull);
    x.forEach((v, i) => assert.ok(v >= lo[i] - 1e-6 && v <= hi[i] + 1e-6, `food ${i} out of bounds: ${describe(c)}`));
    const ref = bruteBoxed(cols, c.r, w, lo, hi, mid, pull);
    if (!ref) continue; // every case was singular, so there is nothing to compare
    if (ref.x.some((v) => v > 5000)) continue; // past 5 kg of a food, the tie-break below rightly outweighs a trace of error
    const cost = boxedCost(cols, c.r, w, x, mid, pull);
    // 0.01 g², a tenth of a gram: with neither limit on, solveBoxed's tie-break between interchangeable foods may cost a trace.
    assert.ok(cost <= ref.cost * (1 + 1e-6) + 0.01, `cost ${cost} above ${ref.cost}: ${describe(c)}`);
  }
});

test("solveCombo and roundCombo keep amounts in bounds and locked amounts as they are", () => {
  const rnd = generator(2);
  for (let t = 0; t < 1000; t++) {
    const c = randomCase(rnd, 8);
    c.fixed = c.foods.map(() => (rnd.next() < 0.3 ? Math.round(rnd.next() * 400) : null));
    const x = fit.solveCombo(c.foods, c.r, c.fixed, c.opts);
    const units = c.foods.map(unitOf);
    const g = fit.roundCombo(c.foods, units, x, c.r, c.fixed, c.opts);
    c.foods.forEach((f, i) => {
      if (c.fixed[i] != null) {
        assert.strictEqual(x[i], c.fixed[i], `solveCombo moved locked food ${i}: ${describe(c)}`);
        assert.strictEqual(g[i], c.fixed[i], `roundCombo moved locked food ${i}: ${describe(c)}`);
        return;
      }
      const [min, max] = fit.bounds(f, c.opts);
      const step = fit.stepOf(f, units[i]) * units[i].g;
      assert.ok(Number.isFinite(x[i]) && x[i] >= min - 1e-6 && x[i] <= max + 1e-6, `solveCombo food ${i} out of bounds: ${describe(c)}`);
      assert.ok(g[i] >= min - step && g[i] <= max + step, `roundCombo food ${i} out of bounds: ${describe(c)}`); // a step may not fit inside
    });
  }
});

test("no 1 g change to one food improves the fit, for up to 10 foods", () => {
  const rnd = generator(3);
  for (let t = 0; t < 1000; t++) {
    const c = randomCase(rnd, 10);
    c.fixed = c.foods.map(() => (rnd.next() < 0.15 ? Math.round(rnd.next() * 400) : null));
    const x = fit.solveCombo(c.foods, c.r, c.fixed, c.opts);
    const cost = fit.fitCost(c.foods, x, c.r, c.opts);
    c.foods.forEach((f, i) => {
      if (c.fixed[i] != null) return;
      const [min, max] = fit.bounds(f, c.opts);
      for (const d of [-1, 1]) {
        const y = [...x];
        y[i] += d;
        if (y[i] < min || y[i] > max) continue;
        const nudged = fit.fitCost(c.foods, y, c.r, c.opts);
        assert.ok(nudged >= cost - 1e-3, `moving food ${i} by ${d} g lowers the cost from ${cost} to ${nudged}: ${describe(c)}`);
      }
    });
  }
});
