"""
Runs the entire pipeline end to end: scrapes ISU's live catalog, then
rebuilds every website/data/*.json file from the fresh CSVs. This is the
one command for "get everything up to date" -- see PROJECT_DOCUMENTATION.md
§3 for what each individual step does and why, if you want to run one step
in isolation instead.

Steps, in order:
  1. scrapers/scrape_courses.py              -- data/courses.csv
  2. scrapers/scrape_majors_minors.py        -- data/majors.csv, minors.csv,
                                                 sections.csv, requirements.csv,
                                                 unresolved_programs.csv
  3. scrapers/scrape_masters.py              -- data/masters.csv (Master's
                                                 programs; ~4 minutes, ~180
                                                 live page fetches -- see
                                                 that script's own docstring
                                                 for why it's name/degrees/
                                                 link only, no per-program
                                                 requirements)
  4. scrapers/verify_credits_from_catalog.py -- cross-checks/corrects
     --apply --recover-unresolved               total_credits against
                                                 data/ISU2024-2025 Catalog.pdf
                                                 (skipped automatically if
                                                 that PDF isn't present)
  5. scrapers/compute_difficulty_ratings.py  -- adds difficulty columns to
                                                 data/courses.csv
  6. website/build_data.py                   -- website/data/courses.json,
                                                 programs.json, masters.json
  7. website/build_web_graph.py              -- website/data/prereq_graph.json
  8. Updates DATA_LAST_UPDATED in website/tabs.js to today's date (the
     Terms & Disclaimer modal's "data last updated" line -- see §6.8)

Deliberately NOT included: website/build_topo_background.py. It's a
cosmetic one-off unrelated to scraped data (a fixed random seed, so
re-running it produces the same image every time) -- not part of a data
refresh. Run it by hand if you actually want a different background.

Each step's own stdout/stderr streams through live. If any step fails
(non-zero exit), the whole run stops immediately rather than continuing
with stale/partial data downstream -- e.g. there's no point rebuilding
courses.json from a courses.csv that a failed scrape only half-wrote.
"""

import argparse
import os
import re
import subprocess
import sys
from datetime import date

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
SCRAPERS_DIR = os.path.join(PROJECT_ROOT, "scrapers")
WEBSITE_DIR = os.path.join(PROJECT_ROOT, "website")
CATALOG_PDF = os.path.join(PROJECT_ROOT, "data", "ISU2024-2025 Catalog.pdf")
TABS_JS = os.path.join(WEBSITE_DIR, "tabs.js")


def run_step(label, cmd, cwd):
    print(f"\n{'=' * 70}\n{label}\n{'=' * 70}")
    result = subprocess.run([sys.executable, *cmd], cwd=cwd)
    if result.returncode != 0:
        print(f"\nx {label} failed (exit {result.returncode}) -- stopping.")
        sys.exit(result.returncode)
    print(f"\n{label}: done.")


def update_last_updated_date():
    with open(TABS_JS, encoding="utf-8") as f:
        text = f.read()
    today = date.today()
    formatted = f"{today:%B} {today.day}, {today.year}"  # e.g. "August 1, 2026" -- no leading zero
    new_text, count = re.subn(
        r'const DATA_LAST_UPDATED = "[^"]*";',
        f'const DATA_LAST_UPDATED = "{formatted}";',
        text,
    )
    if count == 0:
        print("\n! Could not find DATA_LAST_UPDATED in website/tabs.js -- update it by hand.")
        return
    with open(TABS_JS, "w", encoding="utf-8") as f:
        f.write(new_text)
    print(f"\nUpdated DATA_LAST_UPDATED in website/tabs.js to {formatted}.")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--skip-pdf-check", action="store_true",
        help="Skip the catalog-PDF credit cross-check/recovery step.",
    )
    parser.add_argument(
        "--skip-difficulty", action="store_true",
        help="Skip recomputing course difficulty ratings.",
    )
    parser.add_argument(
        "--skip-masters", action="store_true",
        help="Skip re-scraping Master's programs (saves ~4 minutes).",
    )
    args = parser.parse_args()

    run_step("1/7 Scraping courses (catalog.iastate.edu/azcourses/)", ["scrape_courses.py"], SCRAPERS_DIR)
    run_step("2/7 Scraping majors/minors (catalog.iastate.edu/collegescurricula/)", ["scrape_majors_minors.py"], SCRAPERS_DIR)

    if args.skip_masters:
        print("\nSkipping Master's program scrape (--skip-masters).")
    else:
        run_step("3/7 Scraping Master's programs (grad-college.iastate.edu)", ["scrape_masters.py"], SCRAPERS_DIR)

    if args.skip_difficulty:
        print("\nSkipping difficulty rating computation (--skip-difficulty).")
    else:
        run_step("4/7 Computing course difficulty ratings", ["compute_difficulty_ratings.py"], SCRAPERS_DIR)

    if args.skip_pdf_check:
        print("\nSkipping catalog PDF cross-check (--skip-pdf-check).")
    elif not os.path.exists(CATALOG_PDF):
        print(f"\nSkipping catalog PDF cross-check -- '{CATALOG_PDF}' not found.")
    else:
        run_step(
            "5/7 Cross-checking credits against the catalog PDF",
            ["verify_credits_from_catalog.py", "--apply", "--recover-unresolved"],
            SCRAPERS_DIR,
        )

    run_step("6/7 Building website data (courses.json, programs.json, masters.json)", ["build_data.py"], WEBSITE_DIR)
    run_step("7/7 Building the prerequisite web graph", ["build_web_graph.py"], WEBSITE_DIR)

    update_last_updated_date()

    print(f"\n{'=' * 70}")
    print("Full pipeline complete -- website/ is ready to serve.")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
