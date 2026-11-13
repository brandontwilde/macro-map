# Macro Map

A page for finding foods that fit a protein, carbs and fat target, and
optionally calories: what's left for the day, or a single meal or snack.

Every food is plotted on a triangle by its macro split (by grams): pure
protein at the top corner, pure carbs bottom-left, pure fat bottom-right.
Your target is a marker on the same triangle, so foods near the marker are
the ones that fit. Pick any number of foods and it works out the
amounts that land closest to your numbers, keeping each food within what a
person would eat in one meal. Any mix of foods sits inside the outline around
them on the map.

Each target can be exact (=), a minimum (≥) or a maximum (≤). Grams on the
wrong side of a minimum or maximum count five times as much as grams off an
exact value, so limits are met before closeness counts. Grams past a minimum or
under a maximum still count for a quarter as much as grams off an exact value,
so the fit lands near the value instead of overshooting it (and "at most"
everything doesn't give an empty plate). When amounts are rounded to each
food's step, rounding first keeps every limit it can, then gets close. The suggestions use the same
measure.

Any target left empty is left out of the fit and the suggestions. With a
macro empty the target has no split, so the map hides its crosshair and the
suggestions are ranked by fit alone.

The calorie target takes the same three modes; it's most
useful as a cap ("at least 40 g protein, at most 500 kcal"), since exact
macros already fix the calories. In the fit, 4 kcal off counts as much as 1 g
of macro off. A food's calories are its listed count where there is one,
otherwise 4 kcal per gram of protein and carbs and 9 per gram of fat, and the
fit, combo totals and food details all use that same number. The map shows
only the macro split, so calories don't move the crosshair.

Once a combo is started, foods that don't go with it fade, and the list
suggests the foods that would bring it closest to the target, ranked up by
how well they pair. Pairing comes from tags on every food: the meals it's
eaten at, its role in a meal, its cuisine (only for foods distinctive to one),
and the kinds of dish it goes into. Foods pair when they share a cuisine or
dish type, and rarer shared tags count for more. **Any food** turns this off.

## Your own foods

The **My foods** button opens a panel where people can add their own foods,
meals or recipes as JSON: an object (or array of them) with `name`, `group`,
`diet`, `unit` (one chip, one slice, one pot), `protein`, `carbs` and
`fat` in one unit, `min` and `max` (the least and most of the unit eaten in one
meal), and the pairing tags `meals`, `role`, `cuisines` and `dishes`. `grams` (weight of one unit, which lets amounts be entered
in g or oz) and `kcal` are optional; missing calories are estimated from the
macros. **Copy prompt** gives a
prompt that asks a chatbot for exactly that format. They're kept in the
browser's local storage, so Export and Import file move them between devices.

**Scan barcode** reads a packaged food's barcode with the camera (or takes the
number typed in) and looks it up on [Open Food Facts](https://world.openfoodfacts.org),
a free, keyless API. The unit comes from the label's serving size ("1 bar",
"2 tbsp" becomes one tbsp), or "serving" or 100 g when that isn't readable, and
the group and pairing tags from Open Food Facts' food groups and categories.
A meal is taken to be half to three label servings. Everything can be edited
before it's added.
Decoding uses the browser's `BarcodeDetector` where there is one (Android
Chrome) and otherwise loads ZXing from jsDelivr (iOS Safari). The camera only
works over HTTPS or on localhost.

## Run it

It's a static page with no build step. Serve the folder and open it:

```bash
python3 -m http.server 8000
```

Then go to http://localhost:8000. Opening `index.html` directly from disk
won't work, because browsers block it from loading `foods.json`.

## Test it

The fit lives in `fit.js` and has tests in `tests/`. They need Node 18 or
later and no packages:

```bash
node --test tests/*.test.js
```

## Food data

`foods.json` is generated from USDA FoodData Central's SR Legacy dataset
(public domain). To change which foods are included, edit
`scripts/curated.csv` and rebuild:

1. Download the SR Legacy CSV zip from
   https://fdc.nal.usda.gov/download-datasets and extract it.
2. `python3 scripts/build_foods.py <extracted folder>`

In `curated.csv`, `diet` is `vegan`, `vegetarian` or blank (for the diet
filter), `portion` picks which USDA serving size to show (exact match first,
then a substring match), and `portion_label` optionally renames it.

`meals`, `role`, `cuisines` and `dishes` are the pairing tags (space-separated;
the allowed values are listed in `app.js`), and `min_g` and `max_g` are the
least and most a person would eat in one meal.
`python3 scripts/pairing_report.py [food name ...]` prints which foods pair
with which, to check the tags.

## Publishing

Pushes to `main` publish the site to GitHub Pages (via the `gh-pages`
branch). Each pull request also gets a preview at
`https://brandontwilde.github.io/macro-map/pr-preview/pr-<number>/`,
linked in a comment on the PR and removed when the PR closes.
