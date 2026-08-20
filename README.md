# ISU Degree Schedule Planner

A static website that helps Iowa State students pick a major/minor, see
exactly what's required, and build a semester-by-semester schedule that
respects prerequisites, credit limits, and gen-ed requirements — plus a
second page ("The Web") that visualizes how every ISU course connects to
every other course by prerequisite.

All of it is built from data scraped directly from ISU's own course catalog
(`catalog.iastate.edu`). There is no backend and no database: two Python
scrapers produce CSVs, two small build scripts join those CSVs into JSON,
and the website loads that JSON directly in the browser.

For the full breakdown of every file, every feature, and how the data
pipeline fits together, see **[PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md)**.

## Folder structure

```
run_full_update.py   Runs the entire pipeline below in order, start to finish
scrapers/             Python scrapers that produce the raw CSVs (run these first, occasionally)
data/                 The scraped CSVs (input to the website's build step)
website/              The actual website: HTML/CSS/JS + build scripts + generated JSON/images
```

## Full update, start to finish (one command)

```bash
python3 run_full_update.py
```

Re-scrapes ISU's live catalog (majors/minors/masters/courses), cross-checks/
corrects credit totals against the catalog PDF (if present), recomputes
course difficulty ratings, rebuilds every `website/data/*.json` file, and
updates the "data last updated" date shown in the site's Terms & Disclaimer
modal -- the entire pipeline in `PROJECT_DOCUMENTATION.md` §3, in the right
order, stopping immediately if any step fails. Takes several minutes (the
three live scrapes are most of that) and hits ISU's servers with real
traffic, so there's no need to run it more than occasionally -- see `--help`
for flags to skip the PDF check, difficulty ratings, or the Masters scrape.

## Quick start (already-scraped data)

If `data/*.csv` already exist (they do, checked into this project), you can
skip straight to building and running the website:

```bash
cd website
python3 build_data.py            # data/*.csv -> website/data/courses.json, programs.json, masters.json
python3 build_web_graph.py       # website/data/courses.json -> website/data/prereq_graph.json
python3 -m http.server 8000      # serve the site
```

Then open `http://localhost:8000/`.

## Re-scraping from ISU's catalog (only if the data is stale)

```bash
cd scrapers
python3 scrape_courses.py         # -> data/courses.csv (~8,400 courses; takes a few minutes)
python3 scrape_majors_minors.py   # -> data/majors.csv, minors.csv, sections.csv, requirements.csv
python3 scrape_masters.py         # -> data/masters.csv (~180 grad programs; ~4 minutes)
```

Both scrapers run their own embedded test suite automatically in the
background every time `main()` runs, and will clearly report if anything
looks wrong. You can also run the tests directly at any time:

```bash
cd scrapers
python3 -m pytest scrape_courses.py -v
python3 -m pytest scrape_majors_minors.py -v
```

After re-scraping, re-run the two `website/build_*.py` scripts above to
refresh the site's JSON.
