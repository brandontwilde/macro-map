"""Print which foods pair with a few test foods, to check the pairing tags in curated.csv.

Usage: python scripts/pairing_report.py [food name ...]

With no names, reports on a fixed set of test foods plus two custom foods
defined below (one as the AI prompt would return it, one as a barcode scan
would fill it in).
"""

import csv
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CURATED = ROOT / "scripts" / "curated.csv"

TEST_FOODS = [
    "Chicken breast (roasted)", "Oats (dry)", "Greek yogurt (nonfat)", "Peanut butter",
    "Tofu (firm)", "White rice (cooked)", "Chicken burrito bowl", "Protein bar (scanned)",
]
CUSTOM = [
    {"name": "Chicken burrito bowl", "meals": "main", "role": "dish",
     "cuisines": "latin", "dishes": "tacos grain-bowl"},
    {"name": "Protein bar (scanned)", "meals": "snack", "role": "protein",
     "cuisines": "", "dishes": "protein-snack"},
]
MEAL_BONUS = 1.0  # a shared meal, about what one common dish type is worth
ROLE_BONUS = 2.0  # a different role fills a gap; the same role is usually a swap, not a partner
DISH_PENALTY = 2.0  # a complete dish wants sides, not another main
SIDE_ROLES = {"vegetable", "fruit", "sauce", "drink"}
NO_CLASH_ROLES = {"drink", "sweet", "fruit"}  # go alongside any cuisine


def load():
    foods = [dict(r) for r in csv.DictReader(open(CURATED, newline="", encoding="utf-8"))] + CUSTOM
    for f in foods:
        for k in ("meals", "cuisines", "dishes"):
            f[k] = set(f[k].split())
        f["tags"] = f["cuisines"] | f["dishes"]
    return foods


def weights(foods):
    """Rarer tags count for more: log of how many foods per food carrying the tag."""
    counts = {}
    for f in foods:
        for t in f["tags"]:
            counts[t] = counts.get(t, 0) + 1
    return {t: math.log(len(foods) / n) for t, n in counts.items()}


def clash(a, b):
    """Two distinctive foods from different cuisines."""
    if {a["role"], b["role"]} & NO_CLASH_ROLES:
        return False
    return bool(a["cuisines"] and b["cuisines"] and not a["cuisines"] & b["cuisines"])


def faded(a, b):
    """A shared meal ranks foods but only keeps a drink in view; anything else needs a shared tag."""
    if clash(a, b):
        return True
    if "drink" in (a["role"], b["role"]) and a["meals"] & b["meals"]:
        return False
    return not a["tags"] & b["tags"]


def score(a, b, w):
    s = sum(w[t] for t in a["tags"] & b["tags"])
    if a["meals"] & b["meals"]:
        s += MEAL_BONUS
    if a["role"] != b["role"]:
        s += ROLE_BONUS
    if "dish" in (a["role"], b["role"]) and not {a["role"], b["role"]} & SIDE_ROLES:
        s -= DISH_PENALTY
    return s


def report(food, foods, w):
    others = [f for f in foods if f is not food]
    kept = sorted((f for f in others if not faded(food, f)), key=lambda f: -score(food, f, w))
    clashes = [f["name"] for f in others if clash(food, f)]
    unrelated = [f["name"] for f in others if faded(food, f) and not clash(food, f)]
    tags = " ".join(sorted(food["cuisines"])) + " | " + " ".join(sorted(food["dishes"]))
    print(f"\n## {food['name']}  [{' '.join(sorted(food['meals']))} · {food['role']} · {tags}]")
    for i, f in enumerate(kept[:10], 1):
        shared = " ".join(sorted(food["tags"] & f["tags"])) or "-"
        print(f"{i:>3}. {f['name']:<34} {score(food, f, w):5.2f}  {shared}")
    print(f"     {len(kept)} kept, {len(clashes)} faded by cuisine, {len(unrelated)} faded as unrelated")
    if clashes:
        print(f"     cuisine clash: {', '.join(clashes)}")


def main(names):
    foods = load()
    w = weights(foods)
    by_name = {f["name"].lower(): f for f in foods}
    for name in names or TEST_FOODS:
        food = by_name.get(name.lower())
        if food is None:
            sys.exit(f"no food named {name!r}")
        report(food, foods, w)


if __name__ == "__main__":
    main(sys.argv[1:])
