# Macro Map

A page for finding foods that fit a protein, carbs and fat target: what's
left for the day, or a single meal or snack.

Every food is plotted on a triangle by its macro split (by grams): pure
protein at the top corner, pure carbs bottom-left, pure fat bottom-right.
Your target is a marker on the same triangle, so foods near the marker are
the ones that fit. Pick two or three foods and it works out the
amounts that land closest to your numbers. Any mix of two foods sits on the
line between them, and a mix of three sits inside their triangle.

## Your own foods

The **My foods** button opens a panel where people can add their own foods,
meals or recipes as JSON: an object (or array of them) with `name`, `group`,
`diet`, `unit` (one chip, one slice, one bowl), `grams` in one unit, and
`protein`, `carbs`, `fat` and `kcal` in one unit. **Copy prompt** gives a
prompt that asks a chatbot for exactly that format. They're kept in the
browser's local storage, so Export and Import file move them between devices.

## Run it

It's a static page with no build step. Serve the folder and open it:

```bash
python3 -m http.server 8000
```

Then go to http://localhost:8000. Opening `index.html` directly from disk
won't work, because browsers block it from loading `foods.json`.

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

## Publishing

Pushes to `main` publish the site to GitHub Pages (via the `gh-pages`
branch). Each pull request also gets a preview at
`https://brandonwilde.github.io/macro-map/pr-preview/pr-<number>/`,
linked in a comment on the PR and removed when the PR closes.
