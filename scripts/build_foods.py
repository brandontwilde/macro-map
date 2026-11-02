"""Build foods.json from USDA FoodData Central (SR Legacy) CSVs.

Usage: python scripts/build_foods.py <path to extracted SR Legacy CSV dir>

Download the "SR Legacy" CSV zip from https://fdc.nal.usda.gov/download-datasets
and extract it. Which foods to include, their display names, and the preferred
portion for each are listed in scripts/curated.csv. `diet` is "vegan",
"vegetarian" or blank. `portion` matches part of a USDA portion name;
`portion_label` optionally renames it for display.
"""

import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CURATED = ROOT / "scripts" / "curated.csv"
OUT = ROOT / "foods.json"

NUTRIENTS = {"1003": "p", "1005": "c", "1004": "f", "1008": "kcal"}
# The page offers g and oz for every food, so USDA's own weight portions are dropped.
WEIGHT_UNITS = {"g", "oz"}
WEIGHT_ONLY = re.compile(r"^(oz|lb|g|grams?\b.*)$", re.I)


def read(path):
    with open(path, newline="", encoding="utf-8") as f:
        yield from csv.DictReader(f)


def unit_portion(row):
    """Scale a portion like "0.5 cup, 78 g" to one unit: ("cup", 156)."""
    amount = float(row["amount"] or 1)
    label = re.sub(r"\s*\(.*?\)", "", row["modifier"] or row["portion_description"]).strip()
    return label, float(row["gram_weight"]) / amount


def main(usda_dir):
    usda = Path(usda_dir)
    curated = list(read(CURATED))
    ids = {c["fdc_id"] for c in curated}

    nutrients = {i: {} for i in ids}
    for row in read(usda / "food_nutrient.csv"):
        key = NUTRIENTS.get(row["nutrient_id"])
        if key and row["fdc_id"] in ids:
            nutrients[row["fdc_id"]][key] = float(row["amount"])

    portions = {i: [] for i in ids}
    for row in read(usda / "food_portion.csv"):
        # "Yield" portions describe what some other amount turns into, not a unit you'd measure with.
        if "yield" in row["modifier"].lower():
            continue
        if row["fdc_id"] in ids and not WEIGHT_ONLY.match(unit_portion(row)[0]):
            portions[row["fdc_id"]].append((int(row["seq_num"] or 0), *unit_portion(row)))

    foods, problems = [], []
    for c in curated:
        n = nutrients[c["fdc_id"]]
        missing = {"p", "c", "f"} - n.keys()
        if missing:
            problems.append(f"{c['name']}: no data for {sorted(missing)}")
            continue
        ps, seen = [], set()
        for _, label, g in sorted(portions[c["fdc_id"]]):
            label = re.sub(r"^NLEA serving$", "label serving", label, flags=re.I)
            if label.lower() not in seen:
                seen.add(label.lower())
                ps.append({"label": label, "g": round(g, 1)})
        unit = None
        if c["portion"] in WEIGHT_UNITS:
            unit = c["portion"]
        elif c["portion"]:
            want = c["portion"].lower()
            labels = [p["label"].lower() for p in ps]
            default = next((i for i, l in enumerate(labels) if l == want), None)
            if default is None:
                default = next((i for i, l in enumerate(labels) if want in l), None)
            if default is None:
                problems.append(f"{c['name']}: no portion matching {c['portion']!r}")
            else:
                if c["portion_label"]:
                    ps[default]["label"] = c["portion_label"]
                unit = ps[default]["label"]
        foods.append(
            {
                "id": int(c["fdc_id"]),
                "name": c["name"],
                "group": c["group"],
                "diet": c["diet"] or None,  # "vegan", "vegetarian", or neither
                # macros per 100 g, energy in kcal
                "p": n["p"],
                "c": n["c"],
                "f": n["f"],
                "kcal": n.get("kcal"),
                "portions": ps,
                "unit": unit,
            }
        )

    OUT.write_text(json.dumps(foods, indent=1) + "\n")
    print(f"wrote {len(foods)} foods to {OUT.relative_to(ROOT)}")
    for p in problems:
        print("warning:", p, file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
