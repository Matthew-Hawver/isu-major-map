# ISU Degree Schedule Planner — Project Documentation

This is the detailed reference for the whole project: what every file does,
how data flows from ISU's catalog into the website, every feature the site
has, and the limitations that were deliberately accepted along the way.
**Update this file whenever you make a change worth knowing about later.**

---

## 1. What this project is

Two things, both static (no server, no database):

1. **A data pipeline** that scrapes Iowa State's public course catalog
   (`catalog.iastate.edu`) into structured CSVs, then joins those into JSON
   the website can load directly.
2. **A website** (single page, three tabs) built on that JSON:
   - **Iowa State Degree Planning** — pick a major (+ optional minor), get an
     auto-filled semester-by-semester schedule, drag courses around, and see
     live progress toward every requirement.
   - **Iowa State Classes Connected** ("The Web") — a pannable/zoomable map
     of every course connected to another by prerequisite, plus a
     most-connected-classes ranking.
   - **Help** — a dropdown of feedback options (opens a pre-filled email;
     see §7).

## 2. Folder structure

ISU Classes Project/
├── README.md                    Quick-start instructions
├── PROJECT_DOCUMENTATION.md     This file
├── run_full_update.py           Runs the entire pipeline below, start to finish, in order
├── scrapers/
│   ├── scrape_courses.py                  Scrapes catalog.iastate.edu/azcourses/ -> data/courses.csv
│   ├── scrape_majors_minors.py            Scrapes catalog.iastate.edu/collegescurricula/ -> data/majors.csv, minors.csv, sections.csv, requirements.csv, unresolved_programs.csv
│   ├── scrape_masters.py                  Scrapes grad-college.iastate.edu -> data/masters.csv (see §3.4)
│   ├── verify_credits_from_catalog.py     Cross-checks/corrects total_credits against data/ISU2024-2025 Catalog.pdf (see §3.2)
│   └── compute_difficulty_ratings.py      Adds heuristic difficulty-rating columns to data/courses.csv (see §3.3)
├── data/                        The scraped CSVs (input to the website build step)
└── website/
    ├── index.html               The entire site (single page: a top nav + three views)
    ├── style.css                All styling
    ├── app.js                   Degree Planning view logic
    ├── web.js                   Classes Connected view logic (the graph + ranking panel)
    ├── tabs.js                  Nav switching + Help modal + feedback/terms/honors-info modals
    ├── theme.js                 Shared light/dark toggle
    ├── build_data.py            data/*.csv -> website/data/courses.json, programs.json, masters.json
    ├── build_web_graph.py       website/data/courses.json -> website/data/prereq_graph.json
    ├── build_topo_background.py Generates assets/topo-background.jpg (retired, unused -- see §6.3)
    ├── capture_tour_screenshots.py  Regenerates assets/tour/*.webp (see §6.14)
    ├── assets/
    │   ├── isu-logo.webp             Processed logo (background removed), used on the landing card -- see §6.13
    │   ├── isu-logo.png              Superseded by isu-logo.webp -- unreferenced leftover from resizing it (see §6.13's caution note), not the original full-resolution file
    │   ├── isu-logo-source.webp      The true original, background NOT removed -- the only thing left to re-derive a new logo crop from
    │   ├── topo-background.jpg      Retired site-wide background image, no longer referenced (see §6.3)
    │   ├── headshot.jpg              320x320 About-view photo (see §6.1)
    │   ├── HeadShot.jpg              Original, untouched, full-resolution source photo
    │   └── tour/                     12 real UI screenshots used by the guided tour (see §6.14)
    └── data/
        ├── courses.json          Every scraped course + parsed prerequisite/corequisite logic
        ├── programs.json         Every major/minor's sections and requirements
        ├── masters.json          Every Master's program's name/degrees/link/credit minimum (see §3.4)
        └── prereq_graph.json     Node/edge graph + precomputed layout for "The Web"
```

**Rule of thumb:** `scrapers/` writes to `data/`. `website/build_*.py` reads
`data/` (and `website/data/`) and writes `website/data/` and
`website/assets/`. The build scripts are independent of each other and only
need re-running when their specific input changes.

## 3. The data pipeline, in order

Run `python3 run_full_update.py` from the project root to do all of this in
one command (steps 1-2 and 6-7 below, plus 3-5 unless skipped with a flag);
see its own docstring/`--help` for exactly what it does and why, and §3.2/
§3.3/§3.4 below for the steps it can skip. Manually, in order:

1. `scrapers/scrape_courses.py` → `data/courses.csv` (~8,400 rows: class
   code, description, prerequisites, corequisites, credits).
2. `scrapers/scrape_majors_minors.py` → `data/majors.csv`, `minors.csv`,
   `sections.csv`, `requirements.csv`, `unresolved_programs.csv` (250
   programs, 896 requirement sections, ~10,700 requirement rows — see §3.1
   for what "unresolved" means).
3. `scrapers/scrape_masters.py` (see §3.4) → `data/masters.csv` (~117
   Master's programs; name, degree types, link, and ISU's uniform 30-credit
   minimum -- no per-program requirements, see why in §3.4).
4. `scrapers/verify_credits_from_catalog.py --apply --recover-unresolved`
   (see §3.2) — cross-checks/corrects `total_credits` in `majors.csv`/
   `minors.csv` against `data/ISU2024-2025 Catalog.pdf`, if that file is
   present.
5. `scrapers/compute_difficulty_ratings.py` (see §3.3) — adds heuristic
   difficulty-rating columns to `data/courses.csv`.
6. `website/build_data.py` reads all of the above, parses every
   prerequisite/corequisite string into a logic tree (nested AND/OR/course
   nodes — see §5.1), tags gen-ed categories, and writes
   `website/data/courses.json` + `programs.json` + `masters.json`.
7. `website/build_web_graph.py` reads `courses.json`, builds an edge for
   every pair of courses connected by a prerequisite, corequisite,
   cross-listing/equivalence, or related-by-mention relationship (~4,224 of
   8,387 are connected to *something*), computes a one-time force-directed
   layout plus a radius-aware de-overlap pass (see §6.2) and 1st/2nd/3rd-
   degree connection counts for the ranking panel, and writes
   `prereq_graph.json`.

Not part of this pipeline, run by hand only if wanted:
`website/build_topo_background.py` — a one-off (re-run only if you want a
different random pattern): generates the background image from a synthetic
height field, no scraped data involved.

Re-run steps 3/4/5 any time step 1/2's CSVs change; re-run step 7 any time
step 6 regenerates `courses.json`.

### 3.1 Data-quality notes (accepted, disclosed limitations)

- `unresolved_programs.csv` lists programs where the scraper couldn't find a
  requirements table or a total-credit figure — these simply don't appear on
  the website. As of the last full HTML scrape: 18 unresolved out of 268
  found. The PDF cross-check in §3.2 subsequently recovered 5 of those
  (International Agriculture Minor, Forestry B.S., Education Services in
  Family and Consumer Sciences Minor, Financial Counseling and Planning
  Minor, Military Studies Minor), and a dedicated special case (below)
  recovered Kinesiology and Health, B.S., leaving **12 unresolved** -- see
  §3.2 for why the rest resist.
- **Kinesiology and Health, B.S.** (`scrape_majors_minors.py`,
  `kinesiology_and_health_scope`/`split_kinesiology_option_specific_gen_ed`/
  `kinesiology_and_health_total_credits`) needed a named special case, not
  just a PDF-recovered total: its page
  (`catalog.iastate.edu/collegeofhumansciences/kinesiology/`) has two
  compounding quirks unique to it in the whole catalog. First, its own
  index-page anchor (`#text`) happens to match `id="textcontainer"` by
  `find_anchor_scope`'s normal `"{anchor}container"` rule -- but that
  container holds the department's Overview blurb, not the curriculum; the
  real requirement tables live in a separate, unlinked
  `curriculumtextcontainer` that this same page also uses to host the
  Athletic Training curriculum (a different major, with its own dedicated
  page elsewhere), with neither major's `<h2>` carrying an id to
  disambiguate them -- split by heading text instead, the same technique
  `split_shared_minor_container` already uses for a shared minors container.
  Second, three of its gen-ed categories (Physical and Life Sciences,
  Mathematics and Statistics, Social Sciences) each nest a *different*
  required course list per specialization option under `<h5>`/`<h6>`
  sub-headings (the heading level varies by category) rather than under
  that option's own "Option N." section -- left alone,
  `extract_program_requirements` (which only recognizes `<h3>`/`<h4>` as
  section boundaries) would merge all 5 options' alternatives into one
  section, summing credits from options a student would never take
  together. Each option-specific sub-block is moved onto its own "Option N."
  section instead. Its total credits (124) also come from a uniquely-worded
  page statement ("Total cr. required to graduate: A minimum of 124
  credits...", in a `<p>`, not the `<h3>` phrasing `TOTAL_CREDITS_RE` looks
  for elsewhere) rather than the generic extractor. Like other multi-option
  majors (e.g. Wildlife and Fisheries Conservation and Ecology), the live
  "total credits" figure shown in the app sums every option's requirements
  together rather than just the one a student would actually choose -- an
  existing, accepted limitation of the option/section data model (see §7),
  not something specific to this program.
- `majors.csv`/`minors.csv` include a `credits_flag` column
  (`OUT OF RANGE`/`NO DATA`/blank) flagging programs whose total credits fall
  outside a plausible range (4-year majors: 96–144 cr; 2-year majors:
  48–72 cr; minors: 15–30 cr). A flag means "worth double-checking against
  the official catalog," not "definitely wrong." As of the last full HTML
  scrape: 72 majors / 53 minors `OUT OF RANGE`, 6 majors / 2 minors
  `NO DATA`. After applying the PDF-confirmed corrections in §3.2: **64
  majors / 31 minors `OUT OF RANGE`**, `NO DATA` counts unchanged (the PDF
  cross-check only corrects rows it can positively confirm; it never clears
  a flag without a real replacement value).
- Some `requirements.csv` rows use a combined course code like
  `"CE 2710 & CE 2720"` (two real courses that must be taken together). The
  website's `splitComboCode()` (app.js) splits these back into their real,
  independently-creditable courses wherever they're used — this was a real
  bug (courses.json has no such key, so the combo string had no credits/
  description of its own) fixed after initial launch.

### 3.2 Catalog PDF cross-check (`scrapers/verify_credits_from_catalog.py`)

`data/ISU2024-2025 Catalog.pdf` is ISU's official 2024-2025 undergraduate
catalog (1,758 pages). `scrapers/verify_credits_from_catalog.py` cross-checks
every program's `total_credits` against the PDF's own stated total, writing
its findings to `data/catalog_credit_check.csv`. Run with no flags it's
read-only (report only); `--apply` writes confirmed corrections into
`majors.csv`/`minors.csv`, and `--recover-unresolved` additionally attempts
to match `unresolved_programs.csv` entries and append any recovered program.
Both flags have been run across three rounds of matcher refinement
(2026-07-31) and their results are reflected in §3.1's current counts.

**Matching**, via `find_and_extract()`: each program tries a list of
candidate methods in order and extracts total credits from *each* candidate
immediately, only moving to the next if that one comes up empty -- this
matters because the first method to match anything doesn't always land on
the real section (e.g. literal-name matching on "Climate Science, B.S."
only ever hits table-of-contents listings in this catalog; a different
method might still resolve it). Candidates, in order:
1. Exact CSV `name` as a literal running-header match (largest contiguous
   2+ page run) -- majors only, works when the PDF repeats the full "Name,
   Degree. (College)" string verbatim.
2. A type-specific anchor phrase (case-insensitive) built from `base_name`
   (the name with its degree suffix/college qualifier stripped):
   - Majors: `"Bachelor of <Degree>, <name>"` or `"Bachelor of <Degree>
     degree with a major in <name>"`.
   - Minors, **exclusively** -- no literal-name fallback at all: `"minor in
     <name>"` or `"<name> minor"`. A bare minor name (no degree suffix to
     disambiguate) is often *also* a same-named major's running header, or
     worse, a wholly unrelated recurring phrase -- e.g. "Professional
     Communication" is just the title of a common course (COMST 2140)
     quoted throughout dozens of unrelated programs' requirement lists,
     which an early version of this script's literal-name fallback matched
     as if it were that minor's own section, producing a confidently wrong
     answer. Minors also get **no page expansion** beyond the single
     anchor page, for the same reason (confirmed: expanding from the
     anchor once pulled the Biology minor's window into an unrelated
     adjacent Culinary Food Science page, just because the word "Biology"
     recurred there too).

**Total-credits extraction**, tried in order and filtered by
`in_plausible_range()`: (1) colon-style `"Total Credits: X"` or `"Total
Degree Requirement: X cr."` (majors only -- both repeat consistently across
a major's own pages; either showing up near a minor is reliably
bleed-through from an adjacent major); (2) plain `"Total Credits  X"`
(colon-less); (3) last-resort prose patterns, e.g. "by taking 15 credits of
coursework", "requires a minimum of 120 credits", for programs that state
their total only in a sentence. Minors search a small graduated window
(anchor page alone, then ±1) rather than a fixed range, widening only as
far as actually needed.

**Applied results (2026-07-31, after three refinement rounds):** of the
original 133 programs flagged `OUT OF RANGE`/`NO DATA`, **29 have been
confirmed and applied** (8 majors, 21 minors -- see §3.1 for final flag
counts), and **5 previously-unresolved programs** were recovered into
`majors.csv`/`minors.csv` (all individually verified against their own PDF
text, not just pattern-matched): International Agriculture (Minor, "The
minor requires 15 credits"), Forestry (B.S., "Total Degree Requirement: 128
cr."), Education Services in Family and Consumer Sciences (Minor, "...minor
may be earned by completing 15 credits"), Financial Counseling and Planning
(Minor, confirmed on the same page as its own "Total Credits 15" line --
notably, an *earlier* version of the recovery pass had matched this same
program to the wrong section via an unsafe literal-name fallback and
produced the same 15-credit answer by coincidence; it was caught, the
fallback was removed, and this final anchor-based match was re-verified
independently), and Military Studies (Minor, "by taking 15 credits of
coursework"). Recovered programs have a correct `total_credits` but no rows
in `sections.csv`/`requirements.csv` (only the total-credits figure was
recovered, not a full requirements table), so they appear in the picker
with no requirement checklist yet. **0 corrections were ever applied on a
wrong-but-plausible number** across all three rounds -- every applied value
was verified against the PDF's own text.

**64 majors / 31 minors remain `OUT OF RANGE`, and 13 programs remain
unresolved** despite the added matching strategies. Manually investigated
categories of why:
- **Genuinely absent from this PDF snapshot** (zero occurrences anywhere in
  1,758 pages): Animal Enterprise and Innovation (Major), Education Studies
  (Major), Planetary Science (Minor). Likely programs added after this
  2024-2025 catalog was published, or catalogued under a materially
  different name.
- **Only appears as an unrelated phrase**, never as a program section:
  Professional Communication (Minor) is just the title of a common course,
  COMST 2140, quoted throughout dozens of unrelated requirement lists, plus
  unrelated graduate program names ("PhD in Rhetoric and Professional
  Communication"); Digital Storytelling (Minor) and User Experience Design
  (Minor) likewise only appear as a course title or in graduate-level
  contexts, never introduced as their own undergraduate minor.
- **The name only appears in table-of-contents/department-listing pages**,
  never in a real content section with a stated total: Climate Science
  (Major), and the "International Agriculture, Secondary Major" variant
  (its separate Minor variant, same underlying program, was recovered).
- **Anchor phrase matched, but to unrelated incidental text, not a real
  standalone section**: Animal Ecology (Minor) and Biology (Minor) --
  both originally failed their live HTML scrape too (404 / "no sections
  found"), consistent with these minors not actually having their own
  dedicated catalog section any more.
- **Real section found, but no total stated in a form this script
  recognizes**: Kinesiology and Health (Major) -- a 5-option major whose
  write-up gives credit ranges per option/semester but, as far as was
  found, never states one canonical overall total the way most other
  majors do.
- **The scraped `name` itself is corrupted** (a pre-existing scraper bug,
  unrelated to PDF matching): `"Interdisciplinary Studies, B.A.,
  B.S.Classical StudiesU.S. Latino/a Studies"` -- several program names
  concatenated together by `scrape_majors_minors.py`. No PDF-matching
  strategy can fix a name that's wrong at the source; this needs a fix in
  the HTML scraper itself.
- **Illustration, B.F.A. (Major)** remains unmatched despite "Illustration"
  appearing 100+ times in the PDF (its Minor counterpart was recovered
  successfully) -- likely a similar idiosyncratic-phrasing case to
  Kinesiology, not yet run down further.

**A secondary finding surfaced along the way, since qualified:** 45 of 120
minors were scraped as *exactly* 15 credits, which first looked like a mass
default-value bug (15 is `MINOR_RANGE`'s lower bound, so a wrong scrape
landing there would never trip the flag). Spot-checking several against the
PDF was mixed: some really are correct (ISU's College of Design standardizes
multiple minors -- Critical Studies in Design, Design Studies, etc. -- at
exactly 15 credits, confirmed directly in the PDF text), but others are
genuinely wrong (Genetics: scraped 15, PDF 21; Theatre: scraped 15, PDF 21;
Astronomy: scraped 15, PDF 20-21; Data Science: scraped 15, PDF 18;
Entrepreneurship: scraped 15, PDF 27). So this cluster is a mix of real
15-credit minors and a real, still-uninvestigated scraper bug -- not
uniformly one or the other. The bug's root cause (why the scraper lands on
15 specifically for the wrong cases) hasn't been investigated; that would be
in `scrape_majors_minors.py`, not this diagnostic script.

This confirms the PDF is a genuinely reliable data source for total-credits
correction, now applied. Extending it to fully replace/correct
`requirements.csv` (per-course requirement parsing) remains unattempted and
would be substantially more work (see the original assessment in this file's
history / the plan this was scoped from).

### 3.3 Difficulty rating (`scrapers/compute_difficulty_ratings.py`)

Writes a heuristic per-course difficulty rating directly into `data/courses.csv`
as seven new columns. **Data-pipeline only** -- this does not touch anything
under `website/` (no UI, no `courses.json`); whether/how to surface it on the
site is a separate decision not made yet.

Of ten originally-proposed difficulty signals, six are actually derivable
from `courses.csv` (Class Code, Description, Corequisites, Prerequisites,
Credits) and are implemented, each normalized to a 0-10 scale:
- **Math_Rigor** -- department (MATH/STAT) + keyword scan (calculus, proofs,
  matrices, statistical inference, ...).
- **Conceptual_Depth** -- keyword scan, theoretical language ("theory",
  "abstract", "foundations of") net of applied language ("hands-on", "case
  study", "intro to").
- **Memorization_Load** -- department (anatomy/physiology-heavy life
  sciences, foreign languages) + keyword scan (terminology, nomenclature,
  classification).
- **Reading_Writing_Load** -- department (English, History, Philosophy,
  Communication Studies, ...) + keyword scan (essay, writing intensive,
  literature, rhetoric).
- **Workload** -- credits, plus a keyword/structural proxy for a lab or
  project component. Only a partial proxy for the originally-proposed
  "credits x contact-hour type": ISU's catalog text (as scraped here)
  doesn't break out lecture vs. lab contact hours at all.
- **Prereq_Depth** -- the one fully-objective signal: how many courses deep
  the prerequisite chain runs, via a memoized recursive walk over a
  code -> direct-prerequisite-codes map (built with the same course-code
  token shape as build_data.py's prerequisite parser, `_COURSE_TOKEN`, reused
  as a plain regex rather than importing across the scrapers/website split).
  Verified against a real depth-15 chain (`FSHN 4820X`) by hand-tracing it
  back through genuine Calculus -> Chemistry -> Biochemistry -> Nutrition
  prerequisites -- a real long chain, not a parsing bug.

**Four of the original ten are deliberately not computed** -- this project
has no data source for them, and fabricating numbers would be actively
misleading rather than a useful estimate:
- **Feedback_Risk / Assessment_Concentration** -- needs syllabi (grading
  breakdown by assignment); nothing here scrapes that.
- **Pace_Density** -- needs contact-hours and per-term offering/compression
  data (e.g. a 3-credit course crammed into a 3-week summer session);
  neither is in `courses.csv`.
- **DFW_Rate / Grade_Harshness** -- needs empirical grade-distribution data.
  Whether ISU publishes this publicly at all hasn't been researched; adding
  it would be a genuinely separate data-collection project.
- **Instructor_Variance** -- needs per-instructor grade spread or a service
  like RateMyProfessor; not scraped here, and scraping RMP at scale raises
  its own terms-of-service questions independent of the technical work.

`Difficulty_Score` averages the six implemented signals, then **min-max
rescales that average across the whole catalog** so the hardest real course
reads ~10 and the easiest ~0 (a strictly monotonic transform of the raw
average, not a different scoring method) -- a course is rarely demanding on
all six largely-independent axes simultaneously (typically math-heavy *or*
memorization-heavy *or* reading/writing-heavy, not all three), so the plain
average alone clustered nearly every course near 0 before this rescale was
added. After rescaling, the ten hardest-scoring courses are a believable
list: upper-level foreign-language literature seminars (GER 3300, SPAN
4400/4450) and STAT/MATH courses (STAT 3031/4207/4232, MATH 4230/4360) --
median score sits around 1.7-2.0, reflecting that most of the ~8,400-course
catalog is lower-intensity/narrow special-topics courses that just don't
trip these particular heuristics, which is a real property of the catalog,
not a scoring bug.

Re-run any time `data/courses.csv` is regenerated by `scrape_courses.py`, as
the last step before (or after) `verify_credits_from_catalog.py` -- order
between the two doesn't matter, since they touch disjoint columns of
different files (`courses.csv` vs. `majors.csv`/`minors.csv`).

### 3.4 Master's programs (`scrapers/scrape_masters.py`)

Scrapes `grad-college.iastate.edu`'s graduate program directory (~178
programs) for name, degree types offered, and a link, keeping only programs
that offer at least one Master's-level degree (any degree abbreviation
starting with "M." -- M.S., M.Engr., M.B.A., etc.; PhD-only programs are
dropped) -- 117 programs as of the last run. Writes `data/masters.csv`,
joined into `website/data/masters.json` by `build_data.py`.

**This is deliberately much thinner than majors/minors.** Before writing
this scraper, I checked (live fetches, not assumptions) whether ISU has
anything like the structured per-program requirements pages majors/minors
get:
- catalog.iastate.edu department pages (e.g. Mechanical Engineering) have
  only a general "Graduate Study" blurb (`#graduatetextcontainer`) -- no
  enumerated course list, no total credit figure.
- grad-college.iastate.edu's own per-program pages (e.g.
  `/programs/mechanical_engineering`) are admissions/overview pages --
  degrees offered, admission requirements, application deadlines -- that
  explicitly punt to a per-department "Program Handbook" for actual
  requirements. There are ~280 of these, in inconsistent, mostly
  non-catalog-system formats; not something reliably scrapable the way
  majors/minors are.

So the only structured, uniform number that exists at all is ISU's
Graduate College catalog's own rule: a minimum of 30 credits for any
Master's degree (at least 22 from ISU). That's `MASTERS_MINIMUM_CREDITS`,
used as every masters program's `total_credits` -- a real ISU-wide rule,
but not a verified per-program figure, and the website discloses this
directly (the "Masters" badge's tooltip on the masters requirement card, see
§6.9) rather than presenting it as if it were a real per-course checklist.

## 4. Prerequisite/corequisite parsing (build_data.py)

ISU's catalog gives prerequisites as free text, e.g.
`"( CE 2740 or ( CE 2710 and CE 2720 )) and (Credit or enrollment in MATH 2660 or MATH 2670 )"`.
`build_data.py` tokenizes and parses this into a tree of
`{"op": "AND"|"OR", "children": [...]}` / `{"course": "DEPT 1234"}` /
`{"other": "raw prose"}` nodes, stored as `prereq_logic`/`coreq_logic` on
each course in `courses.json`.

- `{"other": ...}` leaves (class standing, GPA minimums, instructor
  permission, etc.) always evaluate as satisfied — there's no way to verify
  them from data, so a prerequisite gated purely on non-course criteria will
  always show as met. This is deliberate and disclosed in the UI, not a bug.
- `"Credit or (concurrent) enrollment in X"` phrasing sets
  `allow_concurrent: true` on the whole record, meaning X can be scheduled
  in the *same* semester (not just earlier) to satisfy it.
- Semicolons are treated as a hard top-level AND boundary (parsed as
  independent segments before any and/or logic), specifically so that
  `"EM 3240 ; ME 1700 or ENGR 1700; STAT 3005"` doesn't let the middle
  clause's "or" leak across the whole expression.

## 5. Gen-ed / elective category detection (app.js + build_data.py)

Two categories are tagged directly in ISU's course descriptions
(`"Meets International Perspectives Requirement."` /
`"...U.S. Cultures and Communities Requirement."`) — reliable, no guessing.

Two more are **not** tagged anywhere in the source data:
**Humanities** and **Social Science**. These are approximated with a
department-prefix heuristic (`build_data.py`'s `_HUMANITIES_DEPTS` /
`_SOCIAL_SCIENCE_DEPTS`), computed for every course. This is disclosed as a
heuristic in the UI, not presented as official ISU data.

**Technical Electives** has no tag or heuristic table at all — its eligible
list is inferred per-program at render time from whichever department
prefix appears most often among that program's own concretely-named
requirements (`programHomeDepartment()` in app.js).

A course's live progress toward a category (e.g. "Technical Electives:
18 / 27 cr") is the sum of the real credits of every eligible course
currently scheduled — not a one-shot "is anything scheduled?" flag. That
distinction mattered: the first version credited the *entire* category
target the moment any one matching course was scheduled, so adding a 2nd or
3rd course did nothing further. Fixed in `categoryScheduledCredits()`.

## 6. Website architecture

### 6.1 Page structure (index.html)

One HTML file. `<body>` stacks top to bottom: `<header class="top-nav">`,
one of three `.view` containers (`#planner-view`, `#web-view`,
`#about-view`) toggled by `hidden`, then `<footer class="bottom-bar">`.
Switching tabs never navigates -- `tabs.js` (`activateTab()`) just flips
which view is visible. A brief history here matters for anyone reading the
git-less diff history of this file: an earlier version of this redesign
tried a persistent, collapsible *left sidebar* holding the nav, Help,
About, and the footer content all in one column. That was rebuilt back into
a conventional top nav + bottom bar after real feedback that it read as
cluttered -- worth knowing so nobody re-derives the sidebar approach from
first principles and reintroduces it.

**Top nav** (`.top-nav`, right-aligned, not full-width or centered like the
original angled Chrome-tab bar it replaced): plain text `.nav-link` buttons
with an underline that slides in on the active/hovered one -- no icons, no
emoji, deliberately minimal. Left to right: **Help** (opens `#help-modal`,
a real instructions panel plus the feedback shortcuts -- see §6.5), **About**
(`data-tab="about"`, its own `.view`), **Classes Connected**
(`data-tab="web"`), **Degree Planning** (`data-tab="planner"`, the default/
active one, positioned nearest the page's main content).

**About view** (`#about-view`): `.about-scroll` stacks two centered cards
(`flex-direction:column`, its own `overflow-y:auto` so both stay reachable
regardless of viewport height -- same reasoning as every other overflow fix
in §6.11). First, the bio card -- headshot (`assets/headshot.jpg`, a
320x320 crop of the original photo, kept far under a raw multi-MB upload's
size; `assets/HeadShot.jpg` is the untouched original), a short "why this
exists" blurb, a Terms & Disclaimer link (`#about-terms-open`, wired to the
same `openTermsModal()` as the bottom bar's own link), and a LinkedIn
button. Second, an "Open Source" card linking to the public repo
(https://github.com/Matthew-Hawver/isu-major-map) via `.about-repo-link`
(GitHub's own dark chrome color, fixed rather than theme-following, so it
reads as distinct from the LinkedIn button's blue at a glance) -- plus a
`.repo-file-list` (a `<dl>`, monospace `<dt>` path in `var(--course)` +
muted `<dd>` description per entry) describing the repo's top-level
documents, kept in sync BY HAND with the real repo/folder structure
(README.md, PROJECT_DOCUMENTATION.md, run_full_update.py, scrapers/, data/,
website/) -- there's no automated check that this list matches reality, so
update it here too if the top-level structure ever changes.

**Bottom bar** (`.bottom-bar`, unchanged in spirit from the site's original
layout): the disclaimer text, Terms & Disclaimer link, and the light/dark
theme toggle, exactly as before the sidebar experiment.

**Setup flow.** `#landing` (the "Which major are you working toward?" card)
is where every selection is made, not a single major picker with a
separately-always-visible header full of the rest: picking a major via the
typeahead (`selectMajor()`, app.js) reveals `#landing-extra-pickers` --
Second Major, Minor, Masters, Honors, and a "View My Schedule" button
(`goToSchedule()`). `major-select` itself stays a hidden `<select>` in the
DOM purely as the data holder every other function already reads via
`.value` (`programSelectIds()`, `scheduleKey()`, etc.) -- the typeahead is
the only real UI for it. Once submitted, `#landing` hides and `#app` shows
along with a compact `#summary-bar` (program names + "Edit Selections",
which reopens `#landing` pre-filled via `showLanding()` -- selections stay
editable anytime) and Export/Import Schedule. `major-select`/
`second-major-select` mutually exclude each other's current value
(`refreshProgramExclusions()`) so the same program can never be picked as
both at once -- a real bug in an earlier version, where doing so rendered
that program's requirements panel twice.

**Searchable selects** (`createSearchableSelect()`/
`wireSearchableSelectToHiddenSelect()`, app.js): Second Major, Minor,
Masters, and the Classes Connected graph's major/department filters are
all search-as-you-type inputs -- the same interaction pattern as the major
typeahead, generalized -- rather than plain `<select>` dropdowns. Each one
mounts into an empty container div and mirrors an existing *hidden*
`<select>` (still populated the normal way by `populateSelect()`/
`populateMastersSelect()`/`populateFilterControls()`), writing back through
it (`.value` + a dispatched `"change"` event) so every function that
already reads that select's value or listens for its `change` event keeps
working completely unchanged -- the searchable UI is a drop-in visual
layer, not a parallel state mechanism. Typing nothing, or clearing the box,
means "blank" (the same as the old "None" option) with no separate clear
button needed. Because `app.js` isn't IIFE-wrapped, `web.js` (which is)
calls these same two functions directly as pre-existing globals, the same
way it already reads `programs`/`splitComboCode` -- one implementation,
reused everywhere a searchable select is needed, not five near-duplicates.
Results float as an absolute-positioned overlay (`.searchable-select-results`)
rather than the major typeahead's own always-expanded list, since several
of these sit close together (the setup form) or side-by-side in a toolbar
(the graph filters) where an always-expanded list would be impractical --
and specifically renders just a short hint (not a full option dump) when
the box is empty, both to match the major typeahead's own behavior and
because a full-length list would visually cover whatever sits below it
(e.g. Second Major's dropdown would otherwise cover "View My Schedule").

### 6.2 The Web (web.js)

Node positions are **precomputed once** by `build_web_graph.py` (a small
hand-rolled Fruchterman-Reingold force-directed layout — no physics
simulation runs in the browser, which wouldn't stay smooth at ~4,200 nodes),
followed by a radius-aware de-overlap pass (`resolve_overlaps()`): the FR
layout treats every node as a dimensionless point, so a high-degree hub
(e.g. `ENGL 2500`, degree 94) could end up laid out closer to a neighbor
than its much-larger rendered bubble actually allows. The pass nudges every
actually-overlapping pair apart along their connecting vector, using the
exact same radius formula as `web.js`'s own `nodeRadius()` (kept in sync by
comment cross-reference in both files) — at the current node/edge count this
resolves the great majority but not all overlaps (down to 136 remaining
pairs out of ~4,224 nodes, from 311 before the pass) within its iteration
cap; a fully overlap-free layout isn't guaranteed at every density. The page
only pans/zooms/draws the static result on a single `<canvas>`.

**Bubble size** (`nodeRadius()`/`radius_for_degrees()`, kept in sync between
`web.js` and `build_web_graph.py`) is set by **rank** among the distinct
degree values actually present, not raw degree run through a formula.
Degree is heavily right-skewed (58% of connected courses have 2 or fewer
connections; only 1% exceed 30) — a plain `sqrt(degree)` curve clamped to a
min/max put the great majority of nodes at the exact same minimum size, with
almost no visible size difference across most of the graph. Ranking the
unique degree values and spacing them evenly across `[NODE_MIN_R,
NODE_MAX_R]` (2–20 world units) guarantees every distinct connection-count
tier is visibly, not just theoretically, distinct, while courses sharing the
same degree still render at the same size.

Four edge sources (`build_web_graph.py`'s `EDGE_TYPES`, stored as a numeric
index per edge to keep the JSON small):
- **prereq** — a real course-code leaf inside `prereq_logic` (the original,
  only source before this feature).
- **coreq** — a real course-code leaf inside `coreq_logic`. In the current
  dataset this never actually contributes a *new* edge: ISU's "credit or
  concurrent enrollment" phrasing gets parsed into both `prereq_logic`
  (`allow_concurrent: true`) and `coreq_logic` identically, so the pair is
  always already captured via `prereq`. Kept anyway so a future scraper/
  parsing change that stops duplicating the two fields starts contributing
  edges here automatically, with no further code changes needed.
- **cross_listed** — courses treated as equivalent/interchangeable, from two
  signals: (a) a description explicitly stating so ("Only one of X, Y, Z
  ... may count towards graduation" — `build_only_one_of_edges`), and (b)
  courses that share an identical, *substantive* description **and** the
  same course number, just a different department prefix
  (`build_same_description_edges`). Both conditions in (b) matter: a
  genuinely cross-listed course (e.g. a joint bioinformatics course offered
  as both `BCB 5700` and `COMS 5700`) always keeps its catalog number across
  departments, but ISU also reuses identical *generic* text for unrelated,
  department-specific administrative slots (independent study, thesis
  research, co-op credit) that happen to share a conventional number too
  (nearly every engineering department has its own `6970` "cooperative
  education" course, textually identical, none of them the same actual
  course) — number-matching alone doesn't separate those, so administrative/
  procedural language (`_ADMIN_DESCRIPTION_RE`) and very short descriptions
  are excluded outright.
- **related** — a description mentions another real course code in prose (a
  companion lab, an undergrad/grad pair, a credit-limit restriction, a
  prerequisite-adjacent recommendation the structured `prereq_logic` parse
  didn't capture) — `build_mentioned_edges`. A softer signal than
  `cross_listed` (related, not interchangeable), styled distinctly and more
  subtly in `web.js`.

Together these connect 4,224 of 8,387 courses (50.4%, up from 2,946 with
prereqs alone) across 7,292 edges. The remaining ~4,163 courses genuinely
have no prerequisite, corequisite, stated equivalence, or prose mention
connecting them to anything else scraped — standalone by the data, not a
gap in this pass. Recovering ISU's actual "Cross-listed with X" catalog text
(currently discarded by `scrape_courses.py`'s credits-parsing regex before
it ever reaches `courses.csv`) would be the remaining, cleaner path to more
connections; connecting courses purely by shared department or gen-ed
category was considered and rejected as it would trade a specific,
fact-based signal for a much weaker categorical one (see §7).

- Bubbles: ISU Cardinal red. Lines: solid ISU Gold for `prereq`, dashed gold
  for `coreq` (same relationship family, drawn distinctly for when it ever
  starts contributing edges), solid blue (`--course`) for `cross_listed` — a
  deliberately different color since it's an equivalence, not a requirement
  — and a muted, finely-dashed gray (`--muted`) for `related`, deliberately
  understated since it's the softest of the four signals. The
  currently-pinned (clicked) node renders in gold to stand out.
- Labels are hidden by default and only drawn for a clicked (pinned) node and
  its direct neighbors — with ~4,200 nodes, always-on labels were unreadable
  clutter.
- Hovering (mouse only) shows an info tooltip (description/credits/
  connection count), independent of the click-to-pin/label system. A plain
  click/tap only pins -- it deliberately does NOT show the tooltip itself,
  since that popping up on every ordinary tap (especially on a phone, where
  there's no hover at all) felt intrusive. The tooltip's own deliberate
  trigger is **right-click** on desktop (`contextmenu`, default menu
  suppressed) or a **long press** (touch, ~500ms held within ~12px of the
  start point -- a real pan cancels the pending timer) on mobile --
  `pinAndShowInfo()` is the one function both paths call, alongside the tap/
  click-only pin path in `wireEvents()`'s `endPointer()`.
- The left ranking panel lists every connected course sorted by 1st/2nd/3rd-
  degree connection count (precomputed via BFS in `build_web_graph.py`'s
  `bfs_shell_counts()` — "degrees of Kevin Bacon"), sortable by any column,
  click a row to jump to and pin that node. Degree/connection counts include
  all three edge types, not just prerequisites.

**Filter by major/department.** Two searchable selects (see §6.1) in
`.web-header`, mirroring hidden `#web-major-filter`/`#web-dept-filter`
`<select>`s, dim (not hide — the layout stays stable and the rest of the
graph stays visible for context) every node that doesn't pass every
currently-active filter (`isInScope()`), combined as AND. The major filter
reuses the exact same source data the planner's own requirements
checklists read — `programs[id].sections[].requirements[].course_code`,
including combo-code splitting via the shared global `splitComboCode()` —
so "what counts as this major's courses" never drifts from what the
planner itself shows. `programs` is a plain global from app.js (not
IIFE-wrapped there) and is already loaded by the time a user can reach
this tab, so no extra fetch is needed. The department filter's options
come straight from each node's existing `dept` field. Masters programs are
deliberately left out of the major-filter options — they have no
per-course requirements to filter by at all (see §3.4), so offering one
would just dim everything with no explanation.

**Legend** (`#web-legend`, bottom-right of the canvas): a short, always-visible
key -- "each dot is a course, bigger dots have more connections" -- plus a
swatch per edge style (solid gold = prerequisite, dashed gold =
corequisite, solid blue = cross-listed/equivalent, dotted gray = related)
matching `EDGE_STYLE` in web.js exactly, so this needs updating by hand if
that ever changes.

**Prerequisite path-finder.** Two text inputs (`#web-path-from`/
`#web-path-to`) plus "Find Prereq Path" run a **directed** BFS
(`findPrereqPath()`) over `prereq`-type edges only, since
`build_prereq_edges()` stores each one as `(prereq, dependent, 0)` — unlike
the undirected `neighbors` map pin-highlighting uses, this answers "what
sequence of prerequisites actually leads from X to Y," not just "are these
connected at all." If no forward path exists, it tries the reverse
direction and says so explicitly ("Y is actually a prerequisite toward X")
rather than just reporting failure. A found path becomes its own highlight
mode (green, `--ok`) that takes priority over both pin-highlighting and the
major/department filters, with the view panned/zoomed to fit it and every
course in the chain listed as text below the inputs (some hops can be far
apart on screen).

### 6.3 Background (style.css)

`body`'s background is `var(--bg)`, which follows the light/dark toggle
like the rest of the site -- plain black in dark mode, the site's usual
near-white in light mode (see §6.15). Every view renders directly against
that, including the landing screen (`#landing`), which has no background
of its own. `#web-view` and `#about-view` also set `background: var(--bg)`
explicitly rather than relying on inheriting body's, so each is correct on
its own regardless of any ancestor changes.

The landing screen briefly had an animated flying-birds backdrop here
instead of a plain background (see git history / earlier revisions of this
document for that implementation, `landing-bg.js` + vendored Three.js/
Vanta.js); it was removed in favor of the plain themed background above.

Before either of those, the background was a generated topographic-
contour-line image (`build_topo_background.py` → `assets/topo-background.jpg`,
a dark red-to-gold gradient), shown site-wide through the open gaps between
cards. Retired after direct feedback that it wasn't landing well.
`build_topo_background.py` and the generated image are both still present
in the repo (harmless, undocumented-as-dead rather than deleted) in case
that direction is ever revisited, but nothing in the live site references
them anymore.

### 6.4 Export / Import (app.js)

**Export** asks for the student's name, then downloads either:
- **CSV** — semester-grouped course list plus one column per requirement
  section (full names, not abbreviations — a deliberate choice: the goal is
  knowing exactly what you're fulfilling), with a running cumulative
  per-section credit tally at each semester boundary.
- **Excel** — the same data as an HTML `<table>` saved with a `.xls`
  extension (a long-standing, widely-supported trick — Excel opens it
  natively). This is *not* a real binary XLSX/OOXML file.

Column layout, left to right: `EXPORT_HEADERS` (Class, Description,
Prerequisites, Corequisites, Requisites Met, Credits, **Grade**) then a
**GPA** column, then the section columns — `LEFT_COLUMN_COUNT` is
`EXPORT_HEADERS.length + 1` (the `+1` is that GPA column) and everything
that pads/aligns blank cells uses that, not `EXPORT_HEADERS.length` alone.
Grade is per-course (blank if ungraded); GPA is blank on every course row
and only populated on two kinds of summary rows, mirroring how "Credit
hours:" already only appears on a summary row rather than every course row:
- Each semester's existing `"Credit hours:", creditTotal` summary row now
  continues rightward with `"GPA:", <that semester's GPA>` (blank if no
  course in that semester has a grade yet) before the per-section
  cumulative tally.
- One final row at the very bottom of the sheet: `"Cumulative GPA:", <GPA
  across every graded course in the whole schedule>`.

Filename format: `{Name}-{Major}-{Minor}-ISUClassSchedule.{ext}` (minor
segment omitted if none selected).

**Program metadata row.** The very first row of both formats is now a
sentinel-tagged row (`buildProgramMetadataCells()`, cell 0 =
`PROGRAM_METADATA_SENTINEL = "ISU-Planner-Programs-v1"`) carrying the
major/second major/minor/Masters *names* (not the internal `<select>`
ids, which are scrape-assigned and not guaranteed stable across a future
re-scrape) plus an Honors flag. This is what §6.14's "returning user"
upload flow reads to restore a full setup automatically. Verified safe
against the *existing, unmodified* row parser below: the sentinel never
matches a semester label or a real course code, so it's silently skipped
by ordinary import regardless of where it sits in the file.

**Import** reads either format back (`importScheduleFromText()` →
`parseImportRows()`, which sniffs HTML vs. plain CSV and routes to the
matching cell-extraction path, then both funnel into one shared row
processor, `importScheduleFromRows()`). It restores exactly which
semesters — including which summer terms — were in use, and each course's
`Grade` cell (`cells[GRADE_COLUMN_INDEX]`) back into `schedule.grades` —
GPA itself is never read back in since it's fully derived from grades +
credits and just recomputes live. A grade cell is only trusted if it's one
of the values in `ALL_GRADE_MARKS` (the 11 letter grades plus P/NP), so
re-importing a pre-grades-feature export (which simply doesn't have that
column) safely leaves every course ungraded rather than misreading some
other column's value as a grade. A native `.xlsx` saved by real Excel (not
one of this site's own exports) will **not** import; that would need a full
binary spreadsheet parser, out of scope for round-tripping this site's own
export format.

The file-selection handler rejects anything not named `.csv`/`.xls` before
ever reading it, and separately checks that `importScheduleFromText()`
actually found at least one real course before committing anything to
`schedule`/`saveSchedule()` — an earlier version parsed first and asked
"replace your schedule?" second, so a genuinely unsupported file (a real
`.xlsx`, or any non-export text) got silently misread as near-empty CSV
data and **wiped the existing schedule with no error shown**. Both checks
now fail loudly (an `alert()` explaining what's actually supported) and
leave the current schedule untouched instead.

### 6.5 Feedback (tabs.js)

The Help top-nav button opens `#help-modal` (`openHelpModal()`/
`closeHelpModal()`, same overlay-click-to-close pattern as the Terms and
Honors-info modals) — real written instructions covering the setup flow,
the schedule/requirements columns, Export/Import, and the Classes Connected
graph, since none of that existed anywhere on the site before (the old Help
control was only ever a dropdown of feedback shortcuts, no actual
"how do I use this" content). Those three shortcuts (`improve` /
`incomplete` / `cant-find`, now `.help-feedback-item` buttons) still live
at the bottom of that same modal, alongside the landing page's own "Can't
Find My Major?" button — all four funnel into one modal
(`openFeedbackModal(kind)`). Submitting POSTs directly to a
Formspree endpoint (`FEEDBACK_ENDPOINT` in tabs.js, plain `fetch()` — no SDK
needed for one simple form) which relays the message to the real inbox
without the visitor ever seeing the destination address (an earlier version
used a `mailto:` link, which inherently shows the "To:" address in the
visitor's own compose window — replaced for that reason). Every kind shares
the exact subject prefix `[ISU Planner Feedback]` (sent as Formspree's
special `_subject` field) on purpose, so a single Gmail filter on that text
catches and labels all three. A local copy is also kept in `localStorage`
(`isu-planner-feedback`) as a redundant backup. If the Formspree endpoint
ever needs to change (e.g. a new form), update `FEEDBACK_ENDPOINT` in
tabs.js — that's the only place it's referenced.

### 6.6 Auto-fill pathway generator (app.js, `generateDefaultPathway`)

The first time a (major, minor) pair is selected, every specifically-named
requirement (plus one pick per "choose one of" group, plus one pick per
recognized elective category) is collected, then **transitively closed**:
anything those courses themselves need as a prerequisite/corequisite gets
pulled in too, recursively.

This closure is *why* the generated total sometimes runs higher than a
program's nominal credit count: some transitively-added prerequisite
courses aren't literally named on the requirements page.

**Scheduling order — `buildPackOrder`.** Courses are handed to the packer in
true **list-scheduling** order, not a flat sort: at each step, among the
courses whose own prerequisites/corequisites are already scheduled (the
"ready" set), the one with the longest remaining downstream chain still
hanging off it wins (`computeHeights` — a course nothing else depends on has
height 0 and can wait; a course sitting at the head of a long stretch of
later requirements needs first claim on capacity). An earlier version
sorted purely by dependency depth (critical-path length from the root), which
let depth-tied, prerequisite-free filler courses grab early-semester capacity
just because they were processed first — starving genuinely long chains and
forcing them into overflow later than they actually needed. Sorting by depth
alone also inflated how many semesters a chain needs in the first place: a
"credit or concurrent enrollment" prerequisite only needs to land at or
before its dependent (same semester is fine), so it's treated as a free hop
here and in the packer's own placement logic, not a full semester of
separation.

**Placement — `packIntoBins`.** True first-fit bin-packing: each course (or
concurrent-enrollment group, placed atomically so a lecture and its lab
always land together) goes into the *earliest* semester at or after its own
computed minimum position that still has room, preferring a regular semester
over a summer one. An earlier version used a single cursor that only ever
moved forward and never revisited an earlier semester with spare capacity —
one long chain could push the cursor to the very last slot, after which
*every* later course (regardless of its own actual requirements) piled into
that same terminal slot, and since summer semesters had no credit cap in
that version at all, the pileup was invisible until it showed up as a
70+-credit summer.

**Three fallback tiers**, from most to least ideal, each checked against
both the 18-credit (regular) / 12-credit (summer) caps and every real
prerequisite/corequisite (`pathwayIsValid`) before being accepted:
1. 8 regular semesters, no summers — "here's a clean 4-year example."
2. + all 4 summers, if tier 1 can't fit without breaking a cap or leaving a
   requirement unmet.
3. + a genuine Fifth Year (reusing the app's own Fifth Year slots, §6.9), if
   even every summer isn't enough. This is real for a handful of
   ABET-heavy engineering majors — e.g. Aerospace Engineering's senior
   capstone (`AERE 4610`) alone requires 7 separate junior-level courses
   completed first — not just an artifact of the packer.

A freshly-generated pathway should always show **zero** red
requisite-warning icons and never exceed either credit cap, whichever tier
it took; if it needed a tier past the first, `schedule.fifthYear` and
`schedule.activeSummers` are set accordingly so the UI reflects it
immediately rather than only after the fact. One known remaining edge case:
programs with an unusually convergent prerequisite (many courses funneling
into one gateway course, then a further course after *that*) can still
occasionally leave 1-2 warnings even at tier 3 — true resource-constrained
scheduling with both precedence and capacity constraints is NP-hard, and
this greedy list-scheduling approach, while far better than a flat sort, is
still a heuristic, not an exact solver (see §7).

**Semester card sizing.** Every semester card shows at least 5 course-row
slots of height regardless of how many courses it actually holds
(`.semester-course-list`'s `min-height`), so a short semester doesn't read
as visually "done" next to a full one; the semester list scrolls internally
(`overflow-y: auto`) to accommodate the resulting extra height rather than
growing the whole page.

**Summer credit cap.** Summer semesters are hard-capped at
`SUMMER_MAX_CREDITS` (12) credits — enforced in `placeCourse()` for manual
drag-and-drop (adding a course that would push a summer over 12 is rejected
with an explanation, not just flagged) and in `packIntoBins()`/
`pathwayFitsCapacity()` for the auto-generated pathway, so the same rule
applies everywhere a course can land in a summer slot.

### 6.7 Grades / GPA (app.js)

Each placed course row has an **Add Grade** button (next to Description and
Pre/Co-reqs) that opens the same shared detail panel those two use, but
filled with a grade picker (`renderGradePicker()`) instead of text: the 11
standard ISU letter grades, A through F (`GRADE_ORDER`/`GRADE_POINTS`), plus
**P** and **NP** (Pass/Not Pass, `PASS_MARKS`) shown as a second row below a
dashed divider, since they're marks rather than letter grades. Click one to
set it, or "Clear grade" to remove it. The button's own label reflects the
current grade or mark (`"Grade: B+"`, `"Grade: P"`) once one is set.
`ALL_GRADE_MARKS` (`GRADE_ORDER` + `PASS_MARKS`) is the full set of values
this feature will ever write to `schedule.grades` or trust on import.

Grades are stored as `schedule.grades[code] = "B+"` — a flat map, since a
course code can only occupy one semester slot at a time (same invariant
`schedule.courses` already relies on) — persisted alongside
`courses`/`activeSummers` in the same per-(major,minor) `localStorage` key.
Removing a course from the schedule entirely also clears its grade;
"Clear All" wipes all grades along with everything else.

**GPA** (`gpaForCodes()`) follows ISU's real calculation exactly: quality
points (grade value × credits) summed and divided by credits attempted,
*not* a simple average of grade values — a 4-credit A and a 1-credit C
should pull the average up much more than they'd average evenly. A course
with no grade set contributes nothing (excluded, not treated as a 0.0).
**P and NP work the same way** -- they're valid, selectable marks (unlike
S/T/R, which aren't recorded by this tool at all) but deliberately have no
entry in `GRADE_POINTS`, so `gpaForCodes()`'s `points === undefined` check
excludes them from both quality points and credits attempted exactly like
an ungraded course, matching ISU's real rule that Pass/Not Pass marks never
factor into GPA. A 0-credit course contributes 0 to both the numerator and
denominator regardless of its grade, which is mathematically correct but
worth knowing if a grade appears to have no effect (e.g. a 0-credit
placement/support course like `ENGL 0990S`).

Two display points, both computed live and hidden entirely when nothing's
graded yet (rather than showing a misleading "0.00"):
- **Per-semester GPA** (`semesterGPA(slotId)`) — a gold pill in the semester
  card's header, to the left of the credit-count pill, covering only that
  semester's own graded courses.
- **Cumulative GPA** (`cumulativeGPA()`) — next to the live total-credits
  figure in each program's heading (`.program-summary .meta`), covering
  *every* graded course across the whole schedule (GPA isn't a per-major
  concept in ISU's system, so the major and minor headings both show the
  same overall figure, the same way both already show the same kind of live
  total-credits tracking).

Grades and GPA are also reflected in the CSV/Excel export and import --
see §6.4 for the exact column layout.

### 6.8 Terms & Disclaimer (index.html, tabs.js)

A short disclaimer sits in the bottom bar next to the theme switch
(`.footer-disclaimer`, see §6.1) -- not affiliated with ISU, data may be
outdated, confirm with an advisor -- plus a **Terms & Disclaimer** link
(`#terms-modal-open`, also reachable from the About view via
`#about-terms-open`) that opens a full modal (`#terms-modal`) covering: no
official affiliation, where the data comes from and when it was last
updated, that grades/GPA are self-entered personal data (not official ISU
records, not derived from or reflecting any real grade-distribution data --
this project doesn't have or use that), no warranty, that generated
schedules aren't a real registration, that this isn't academic advising,
and a limitation-of-liability clause. Wired up the same way the feedback
modal already is (§6.5): open/close handlers in `tabs.js`, closing on both
the × button and an overlay click.

`DATA_LAST_UPDATED` (a plain string constant in `tabs.js`) is injected into
the modal at load time and **must be updated by hand** after every
re-scrape (see §8 Maintenance) -- there's no automatic timestamping of
`data/*.csv`, so this is the one place that has to be remembered manually.

### 6.9 Second majors, Masters, and Fifth Year (app.js)

Three related extensions to the original one-major-plus-one-minor model,
all read live from their own `<select>`/state rather than duplicated
anywhere -- `programSelectIds()` is the one place that reads all four
program pickers (major, second major, minor, masters), used everywhere
that used to hardcode just major+minor (schedule key, credit totals, the
requirements panel, export).

- **Second Major** -- a `#second-major-select` alongside the existing Minor
  picker (so major + second major + minor can all be active together).
  `refreshProgramExclusions()` keeps `major-select` and `second-major-select`
  from ever holding the same program at once (each one's own option list
  excludes the other's current value, re-filtered on every change) -- a real
  bug in an earlier version let the same program be picked as both, which
  rendered its requirements panel twice since `selectedPrograms()` had no
  way to know they were meant to be different programs.
  `totalCreditsNeeded()` uses ISU's actual double-major rule (confirmed via
  catalog.iastate.edu's Academic Life → Degree Planning page, not
  assumed): one degree, both majors listed, and a total credit floor of
  *whichever major needs more, plus at least 30 more* -- not a sum of both
  majors' totals (`DOUBLE_MAJOR_EXTRA_CREDITS`). The auto-fill pathway
  generator (§6.6) also folds the second major's requirements into its
  transitive closure. Export's per-section column prefixes
  (`selectedProgramsWithRoles()`) are now keyed by each program's actual
  role (`""` / `"(2nd Major) "` / `"(Minor) "`) instead of guessing from
  array position -- position-based guessing broke the moment a second major
  could be selected without a minor, since index 1 would have wrongly
  gotten the minor's prefix.

- **Masters** -- `#masters-select` (from `masters.json`, see §3.4). Picking
  one appends `GRAD_SEMESTER_COUNT` (4) "Masters Semester" slots
  (`grad-1`..`grad-4`) after every undergrad semester in the vertical
  column -- built the same way summers already were, just as their own
  `kind: "grad"` slot type. Renders as its own card (`renderMastersProgram`)
  with a live credit count against ISU's uniform 30-credit minimum
  (`gradCreditsScheduled()`, sums courses placed in any `grad-*` slot) --
  no per-course checklist, since none exists to scrape (§3.4's whole point).

- **Fifth Year** -- a `+ Add Fifth Year` button (next to the semester list,
  positioned before any Masters semesters if both are active) extends the
  regular-semester range from `reg-8` to `reg-10` (`undergradSemesterCount()`)
  and unlocks a "Summer After Fifth Year" slot the same way summers after
  years 1-4 already worked (`SUMMER_ANCHORS` now includes 10). Toggled via
  `schedule.fifthYear`, persisted per-schedule like `activeSummers` (not a
  global flag like `honors`, since which programs you're pursuing is the
  more natural scope for "do I need a 5th year"). "Remove Fifth Year"
  clears both its semesters (and their courses) plus any summer after them
  in one action, since the two semesters were always added as a pair.

### 6.10 Embedded catalog links + info icons (app.js, index.html)

Every program heading (major/second major/minor/masters) is wrapped in a
deliberately understated inline link to its official ISU catalog page
(`programNameHtml()` -- `.program-link` in style.css inherits the
surrounding text's color/weight, only picking up an underline on hover, so
it reads as plain text rather than a "visit site" button). Uses
`program.url`, which `build_data.py` now carries through from
majors.csv/minors.csv into `programs.json` (previously read but silently
dropped during that CSV → JSON join).

Two small info icons (ⓘ), both native `title` tooltips -- the same pattern
already used for the requisite-warning icon, not a new tooltip system:
- Next to "Honors student": opens a modal (`#honors-info-modal`) with the
  six requirements every college's Honors Program has in common, quoted
  from Iowa State's University Honors Program Student Handbook (2025) --
  GPA minimum, honors courses/seminars, the advisory POS, the honors
  project, and the Honors Poster Session. The icon is a `<button>` nested
  inside the checkbox's own `<label>`, which would otherwise also toggle
  the checkbox on click (labels forward clicks to their control) --
  `e.preventDefault()` in its click handler stops that forwarding.
- Next to "Most Connected Classes" (Classes Connected page): explains what
  1st/2nd/3rd-degree connections mean (§6.2's "degrees of Kevin Bacon"
  idea), in the ranking panel's own words rather than assuming it's obvious.

### 6.11 Mobile & touch support (style.css, app.js, web.js)

The site was originally desktop/mouse-only -- no responsive breakpoints at
all, and the schedule's native HTML5 drag-and-drop plus the Classes
Connected canvas's mouse-only pan/zoom don't work on a touchscreen. Two
width breakpoints were added, deliberately kept conceptually separate from
touch-target sizing: `900px` (below this, the planner's schedule +
requirements two-column layout can't both fit -- see below) and `480px`
(phone tier, secondary chrome tightens further). Touch-target sizing itself
is instead scoped to `@media (max-width: 900px), (pointer: coarse)` --
width OR a finger as the input, whichever comes first -- so a touch laptop
in a wide window still gets bigger tap targets, and a resized desktop
Chrome window doesn't.

**Stacked planner layout below 900px.** `.app-columns` switches to
`flex-direction: column`. The first attempt gave the schedule panel a
`max-height: 45vh` and left the requirements panel to `flex: 1 1 auto` --
this looked reasonable in isolation but broke in practice: both panels also
have their *own* internal `overflow-y: auto` scroll regions sized against
whatever `.app-columns`'s fixed total height happens to be (itself already
reduced by the summary bar wrapping to 2-3 lines at this width), and two
nested flex children both trying to keep an independent scroll region
inside too little combined space caused the requirements panel's own
scroll container (`.browse-scroll`) to collapse to **zero height** --
present in the DOM, "visible" by Playwright's own check, but completely
unreachable. The fix: on this breakpoint, `.app-columns` becomes the *one*
scroll container (`overflow-y: auto`), and both `.semester-list` and
`.browse-scroll` switch to `overflow-y: visible; flex: 0 0 auto` -- normal
document flow, sized to content, with the outer container handling all the
scrolling. `.column-resizer` hides (nothing to resize once stacked) --
`initColumnResizer()` (app.js) also actively clears/restores the resizer's
saved inline pixel `flexBasis` via a `matchMedia("(max-width: 900px)")`
listener, since an inline style always outranks a stylesheet media query
and would otherwise permanently defeat the stacking rule for anyone who'd
ever dragged the resizer on desktop.

**Classes Connected below 900px** hit the same class of bug from the other
direction: an early version stacked every header control (search, two
filters, the path-finder's two inputs/two buttons) to full width, one per
row -- reasonable-looking per control, but ~9 controls tall enough (600px+)
to exceed the *entire* view on a phone, squeezing the actual graph canvas
below it to zero height. Fixed by leaving the controls to the existing
`flex-wrap` + fluid `min(Npx, %)` widths (letting them wrap into several
more-compact rows instead of one-per-row), plus a `max-height: 40vh;
overflow-y: auto` cap on `.web-header` itself as a guaranteed floor under
the canvas's share of the screen regardless of how tall that wrapped
content gets -- the graph is this page's whole point. The **ranking panel**
becomes a fixed off-canvas drawer (`transform: translateX(-100%)`, toggled
via `#ranking-panel-toggle-btn` and a document-level "tap outside closes
it" listener in `wireEvents()`), its `.open` state adding a
`box-shadow: 0 0 0 100vmax` spread that dims the rest of the screen with no
separate backdrop element. The **legend** (`#web-legend`) collapses to just
its title by default at the 480px tier (`web-legend-toggle-btn`, mirroring
the existing `.category-toggle` pattern) -- both lessons from this same
"don't let secondary chrome starve the canvas" principle.

**Tap-to-place scheduling** (app.js): a touch alternative to the existing
native-HTML5-drag placement, added rather than replacing it -- tap an
unplaced course chip or search row to select it (`selectCourseForPlacement()`,
tracked in `selectedCourseCode`, highlighted via `.selected-for-place` and a
`#tap-place-hint` pill), then tap any semester's course list
(`wireDropTarget()`'s new `click` listener) to call the existing
`placeCourse()` completely unmodified. This is deliberately *not*
feature-detected behind a touch/coarse-pointer check: a `click` fires
identically for mouse and touch, and critically a `click` never fires
after a real `dragstart`, so layering it underneath the existing drag
handlers is free for desktop (mouse users incidentally get it as an
alternative too) and can't regress the drag path. The two chip/row surfaces
that only ever had a hover-only tooltip (`renderAvailableChip()`,
`renderSearchTable()`'s code cell) each gained a small info-icon button
(reusing `.info-icon-btn`) opening a new shared `#course-info-modal`
(mirrors `#export-modal`'s structure) built from the same
`courseTooltipHTML()` the hover tooltip already used --
`renderPlacedChip()` keeps its own existing Description/Pre-Co-reqs buttons
unchanged, since scheduled courses already had a tap-friendly path.
Deliberately out of scope: tap-based reordering of already-placed chips
between semesters -- technically possible via the same `placeCourse()`
call, but it creates a real UX ambiguity (does tapping a placed chip move
*it*, or place the pending selection into *its* slot?) the original
instructions didn't resolve.

**Touch support for the graph** (web.js): the old `mousedown`/`window
mousemove`/`window mouseup` trio was replaced with unified
`pointerdown`/`pointermove`/`pointerup`/`pointercancel` -- a drop-in,
behavior-preserving swap for the single-pointer (mouse) case, and what
makes pinch-zoom possible without a second, duplicate set of
`touchstart`/`touchmove` handlers re-deriving the same math. `activePointers`
(a `pointerId -> {x,y}` Map) tracks every pointer currently down: size 1 is
pan (identical math to the old mouse-drag path), size 2 is pinch, computed
by re-solving `view.x/y` so the world point under the pinch's *starting*
midpoint stays fixed under the midpoint's current position as it moves --
the same "keep the point under the gesture fixed" technique the `wheel`
handler already used for scroll-to-zoom, generalized to a moving two-finger
midpoint so pinch and 2-finger pan fall out of one calculation.
`canvas.setPointerCapture()` is wrapped in a `try/catch` since it can throw
in edge cases (confirmed directly: dispatching synthetic `PointerEvent`s
without a real OS-backed pointer session throws exactly this) and isn't
load-bearing for the rest of the handler, which listens on `window` anyway.
A single tap (no movement) now pins/unpins the node under it **and** shows
its info tooltip in one path -- fixing a small pre-existing gap where a
mouse *click* pinned a node but never called `showTooltip()` itself (info
only ever appeared via a separate hover side-channel), which also happens
to be the exact fix touch needed (no hover path exists there at all).
`findNodeNear()` takes an optional hit-radius (`TOUCH_HIT_PIXEL_RADIUS = 22`
vs. the existing `HOVER_PIXEL_RADIUS = 10`), since a fingertip's effective
tap precision is coarser than a mouse cursor's. `#graph-canvas` gets
`touch-action: none` so the browser's own native touch-scroll/pinch
gesture doesn't fight this custom handling.

Verified with Playwright (`has_touch=True, is_mobile=True` contexts) at
375/430/768px plus a 1440px desktop-regression pass (native HTML5
`dragTo()` still places a course; real per-pixel checks confirmed a false
alarm during testing came from a test assertion bug, not a product
regression). Not verified on real iOS Safari hardware -- Pointer Events +
`touch-action` support is solid in Chromium/Android but has occasionally
diverged on WebKit in the past, so a real-device spot-check remains a good
idea if one becomes available.

**Follow-up round: three more real mobile bugs**, found via direct user
report after the above shipped (the Playwright pass above tested layout and
interaction, but not "can every element actually be reached" end to end):

- **The landing screen's submit button was unreachable.** `.landing-card-wrap`
  vertically centers its content (`align-items:center`) inside whatever
  space is left below the logo. Once the Second Major/Minor/Masters/Honors
  fields pushed the card's natural height past that available space
  (routine on a phone), plain `align-items:center` on an overflowing flex
  item clips it symmetrically off **both** ends with no way to scroll to
  either one -- there was no way to reach "Create a Schedule" at all. Fixed
  with `align-items: safe center` (falls back to top-aligned + scrollable
  instead of centering when content doesn't fit -- the `align-items:
  flex-start` line immediately before it in the same rule is the fallback
  for the one browser that doesn't understand the `safe` keyword, since an
  unrecognized single declaration is simply skipped, not the whole rule)
  plus `overflow-y: auto`.
- **The Help modal couldn't be closed.** Same root cause, more severe: the
  Help modal's content (long instructions + a feedback-shortcuts section)
  can be taller than an entire phone viewport, and `.modal-overlay` also
  used plain `align-items:center`. The close (×) button lives in the
  modal's *header*, at the very top of the box -- centering an overflowing
  box pushed that header above `y=0`, off-screen, with nothing to scroll it
  back into view (only one inner section had its own scroll, not the whole
  overlay). Same `safe center` + `overflow-y:auto` fix, applied to
  `.modal-overlay` itself -- fixes every modal at once, not just Help.
- **Classes Connected "looked horrible" on mobile** -- three compounding
  problems, all fixed together:
  1. The full search/filter/path-finder header (~9 controls) was always
     visible, eating up to 40% of a phone screen and leaving the graph a
     tiny, illegible sliver. Restructured into a slim always-visible
     `.web-toolbar` (two toggle buttons: "Most Connected Classes" and
     "Search & Filters") plus a `.web-controls-panel` that's now a
     drop-down overlay below 900px (`position:absolute`, closed by default,
     opened by its toggle, closed again by tapping outside it or via the
     other toggle -- opening one of the two overlay panels always closes
     the other, so they can't end up open and overlapping) instead of a
     permanently-visible block eating canvas space. The canvas keeps its
     size throughout since the panel is an overlay, not part of normal
     flow, so no `resizeCanvas()`/`render()` re-trigger is needed on
     open/close.
  2. The controls (search input, filter dropdowns, buttons, tooltip,
     ranking panel, legend) all use the same `var(--bg)`/`var(--text)`/etc.
     custom properties as the rest of the site, which follow the global
     light/dark toggle -- but `#web-view`'s own background is
     unconditionally black. In light mode this meant white UI islands
     stranded on a black backdrop, a real part of why it read as ugly.
     Fixed by re-declaring the dark-theme variable values directly on
     `#web-view`, scoped to that view only -- since every component
     already reads these same variables, this one block makes the whole
     page resolve to a coherent dark palette regardless of the site-wide
     toggle, with no changes needed to any individual component's CSS. This
     also improves desktop light-mode users' experience of this page as a
     side effect, not just mobile.
  3. `.ranking-panel`, positioned `fixed` and spanning the full viewport
     height (`top:0` to `bottom:0`), rendered *behind* the new always-on
     `.web-toolbar` when open -- both a stray double "Most Connected
     Classes" header and, worse, the toolbar's own "Search & Filters"
     button became unclickable (covered by the drawer). Fixed two ways
     together: `.web-toolbar` gets `position:relative; z-index:46` (above
     both overlay panels, so it's never covered), and `.ranking-panel`
     switched from `position:fixed` (viewport-relative) to
     `position:absolute` scoped to `.web-main` (`position:relative`, added
     for this) -- so the drawer now starts right below the toolbar instead
     of sliding out from underneath it.

**Second follow-up round**, again from direct user feedback after the
above shipped:

- **Top nav wrapped unevenly on phones.** `.top-nav-cluster`'s `flex-wrap`
  let 3 of the 4 links sit on one row and the 4th ("Degree Planning") wrap
  alone onto a second, reading as broken rather than deliberate. Replaced
  with a single-row, evenly-divided bar instead: each `.nav-link` gets
  `flex: 1 1 0` (an equal quarter of the full width) and centers its own
  text, wrapping to two lines *within its own cell* if its label needs it
  (e.g. "Classes" / "Connected") rather than wrapping the whole row -- every
  cell ends up the same height, reading as one formal structure regardless
  of label length. The underline-on-active indicator (`.nav-link::after`)
  needed no changes, it just centers under a wider cell now.
- **Degree Planning gained the same tab pattern Classes Connected already
  has**, at the user's request: below 900px, `.semester-column` and
  `.browse-column` are no longer both stacked and scrolled through
  together -- only one is shown at a time (`display:none` by default,
  `.app-columns.showing-schedule`/`.showing-requirements` reveals the
  matching one via a more-specific descendant-selector override), each
  filling the full height with its own internal scroll exactly like the
  desktop side-by-side layout already gives each column. Toggled by a new
  `.mobile-toolbar` (`#schedule-tab-btn`/`#requirements-tab-btn`) wired in
  `init()` (app.js) the same way as everywhere else: `.classList.replace()`
  between the two state classes on `#app`, `.active` on whichever button.
  This replaced the earlier "outer `.app-columns` scrolls as one unit"
  design entirely -- reusing the reasoning above, a scroll-through-both
  compromise never actually needed to exist once real tab panels do the job
  directly, and it now matches the same "how do I get to X on a small
  screen" pattern Classes Connected already established.
- Since Classes Connected's toolbar was the direct model for the above, its
  `.web-toolbar`/`.web-toolbar-btn` classes were renamed to generic
  `.mobile-toolbar`/`.mobile-toolbar-btn` so both pages share one
  definition rather than duplicating identical CSS under two names -- no
  behavior change on that page, purely a rename for reuse.

### 6.12 Landing screen background (retired: landing-bg.js)

`#landing` (the "Which major are you working toward?" screen only -- not
the schedule, Classes Connected, or About views) briefly had an animated
flock of birds that scattered from the mouse, via [Vanta.js's BIRDS
effect](https://www.vantajs.com/?effect=birds), with Three.js r134 +
`vanta.birds.min.js` vendored locally under `assets/vendor/`. It's been
removed: `landing-bg.js`, `assets/vendor/three.r134.min.js`, and
`assets/vendor/vanta.birds.min.js` are all deleted, along with their
`<script>` tags and the `#vanta-landing-bg` mount element in index.html.
`#landing` now has no background of its own, so `body`'s `var(--bg)` shows
straight through (see §6.3) -- plain black in dark mode, plain white-ish in
light mode, same as every other view. This also drops 644KB of vendored JS
(mostly `three.r134.min.js`) from the page's script payload entirely.

### 6.13 Load performance (index.html, app.js)

Three changes, found by auditing actual file sizes/network behavior rather
than guessing:

- **`assets/isu-logo.png` was 7.0MB at 3353x3352px**, displayed at a fixed
  12rem (192px) on the landing card (`.isu-logo`) -- roughly 17x more
  resolution than any display could ever show it at. Replaced with
  `assets/isu-logo.webp`, resized to 800x800 (generous headroom for
  high-DPI displays) and re-encoded as WebP (quality 90, alpha channel
  verified intact -- transparency was the whole reason the original PNG
  existed) at 130KB, a ~54x reduction with no visible quality loss.
  **Caution for future edits**: the original full-resolution
  background-removed PNG was overwritten in place during this pass with no
  backup kept, so it's not recoverable if a different resize/format is ever
  needed later -- `assets/isu-logo-source.webp` (4000x4000, background
  *not* removed) is the only remaining original to re-derive from.
- **All 7 `<script>` tags gained `defer`.** They already sat at the very
  end of `<body>`, after all other markup, so this doesn't change *when*
  they run relative to the DOM (already fully parsed either way) -- it lets
  the browser fetch all 7 (`three.r134.min.js` alone is 615KB) in parallel
  instead of one at a time, since without `defer` each script blocks the
  next one's download until it's fully fetched *and executed*. Execution
  order still matches document order, so `theme.js` still runs before
  `app.js`, etc., exactly as before.
- **`courses.json` (~4.6MB, easily the largest of the three data files) no
  longer blocks the landing screen.** Nothing before a major is actually
  picked ever reads it -- the major typeahead and `buildSearchIndex()` only
  touch `programs`. `loadData()` was split into `loadPrograms()`
  (`programs.json` + `masters.json`, still `await`ed in `init()` before
  anything renders) and `startLoadingCourses()` (`courses.json`, kicked off
  right after but not awaited -- it loads in the background while the user
  is still picking a major). `courses` starts as `null` rather than `{}`
  specifically so code can tell "hasn't loaded yet" apart from "loaded, but
  legitimately empty" (an empty object is truthy, so only a null check
  actually distinguishes the two). `goToSchedule()` is the one place that
  actually needs `courses` -- it `await`s `startLoadingCourses()` (a no-op
  if already resolved, which it almost always is by the time anyone clicks
  through) as a correctness backstop, showing a disabled "Loading course
  data…" button state for the rare case of a slow connection or someone
  moving through setup unusually fast. Verified this exact path end-to-end
  by forcing a delayed `coursesLoadPromise` in a test rather than relying
  on real network conditions being slow enough to hit it.

### 6.14 Onboarding: welcome modal + guided tour (tabs.js, app.js, index.html)

Two new modals, `#welcome-modal` and `#tour-modal`, following the exact
same `.modal-overlay`/`.modal-box`/`.modal-header`/`.modal-body` structure
every other modal on the site uses (see every `open*Modal()`/`close*Modal()`
pair in tabs.js) -- reusing that structure verbatim is what keeps both
correct on mobile for free, since `.modal-overlay` already carries the
`align-items: safe center` + `overflow-y: auto` fix from earlier in this
same documentation pass.

**First-visit prompt.** `maybeShowWelcomeModal()` runs once, unconditionally,
at tabs.js's own top level (no dependency on app.js's `init()` finishing --
same timing precedent as every other modal's wiring). Guarded by
`ONBOARDING_SEEN_KEY` (`isu-planner-onboarding-seen`), set at *show* time
rather than *choice* time, so closing the tab without picking anything
still counts as "asked" and the prompt never reappears uninvited. One
deliberate refinement beyond the literal spec: anyone who already has a
saved schedule (any `isu-schedule:*` key present) is grandfathered past the
prompt silently -- asking a genuinely returning user "is this your first
time?" would just be wrong, and the flag still gets set so it behaves
identically to everyone else going forward.

- **"Yes, first time"** -> closes the welcome modal, opens the tour at step 1.
- **"No, I've used this before"** -> reveals an upload panel. Picking a file
  runs it through `parseImportRows()` -> `extractProgramMetadata()` (§6.4).
  If metadata is present, `applyRestoredProgramSelection(metadata)` (app.js)
  resolves each name back to a *current* id (`resolveProgramIdByName()` /
  `resolveMastersIdByName()`, filtering by `p.type` since majors and minors
  share one name-keyed dict), sets Honors in localStorage **before** calling
  `goToSchedule()` (`loadSchedule()` reads Honors via `honorsEnabled()`, not
  the checkbox), then reuses `selectMajor()` + `goToSchedule()` -- the exact
  same path "Edit Selections" already uses, rather than a parallel
  implementation. Courses/grades are then offered as a separate confirm()
  step via the *unmodified* `importScheduleFromRows()`. If the major itself
  can't be resolved (no metadata row at all -- an older export, or a
  foreign file -- or a since-renamed/removed major), one clear `alert()`
  explains why, the schedule is left untouched, and the user lands on the
  plain landing screen to pick manually (their existing "Import Schedule"
  button still works from there afterward, unchanged). A second
  major/minor/Masters name that fails to resolve is non-fatal -- everything
  else restores, with what didn't match named in one follow-up alert.
- **"Skip"** (present in both branches, one shared control) just closes --
  the seen-flag is already set.
- `programsReadyPromise` (app.js, set in `init()` around `loadPrograms()`,
  mirroring the existing `coursesLoadPromise` pattern for `courses.json`)
  is `await`ed before resolving program names, defending the same edge case
  `goToSchedule()` already defends for courses: an implausibly fast upload
  on a slow connection.

**Guided tour.** `TOUR_STEPS` (tabs.js) is a 12-entry array (title/body
text + an image path + alt text), covering every tool on the site: picking
a major; the optional Second Major/Minor/Masters/Honors fields; the
schedule view; adding courses (drag on desktop, tap-to-place on touch --
§6.11); course detail buttons and grades; the requirements checklist;
search; Edit Selections/Export/Import; then Classes Connected in two parts
(what the dots/lines mean, then its search/filter/path-finder/ranking-panel
tools plus the right-click-desktop/long-press-mobile info trigger from
earlier in this documentation pass); and a wrap-up step naming the Help
reopen path. `renderTourStep()` updates the image/text/step-counter and
disables Back on step 1 / relabels Next to "Done" on the last step;
`openTourModal()` always resets to step 0.

**Reopen from Help.** A new button, `#help-reopen-tour-btn`, styled
identically to the existing `.help-feedback-item` shortcuts by adding it to
that same CSS rule's selector list (`.help-feedback-item,
.help-tour-replay-btn { ... }`) rather than duplicating the declarations --
but deliberately given its own class and its own dedicated listener
(`closeHelpModal(); openTourModal();`), *not* `.help-feedback-item` itself,
since that exact class is what the generic
`document.querySelectorAll(".help-feedback-item")` loop uses to route
clicks into `openFeedbackModal(btn.dataset.feedback)` -- reusing it here
would have misrouted the click.

**Screenshots** (`assets/tour/`, ~570KB total across all 12 images) are
real captures of the live site, not illustrations -- generated by
`website/capture_tour_screenshots.py` (Playwright driving a local
`http.server`, clipped to the relevant region per step, resized/re-encoded
as WebP at quality 82). The script is kept in the repo as the reproducible
source for these images specifically so they can be regenerated after a
future UI change instead of quietly going stale -- run it again anytime
`TOUR_STEPS`' content or the underlying UI changes:
```
python3 -m http.server 8000   # from website/, in one terminal
python3 capture_tour_screenshots.py   # in another
```

**A real bug found during testing**: `#welcome-returning-panel` initially
stayed visible even while `hidden` was set. Root cause: its own ID-selector
CSS rule set `display: flex`, which -- being a higher-specificity ID
selector -- outranked the browser's own default `[hidden] { display: none;
}` rule. Same class of bug this project has hit before with
`.landing-extra-pickers[hidden]`; fixed the same way, with an explicit
`#welcome-returning-panel[hidden] { display: none; }` override. Worth
remembering for any *future* initially-hidden element that also needs its
own `display` value once shown: the `[hidden]` override has to be written
explicitly, it does not happen automatically.

### 6.15 Light Mode now actually turns everything light (style.css)

`body`, `#about-view`, `.app-columns`, and `#web-view` previously all had
`background: #000` hardcoded, regardless of the light/dark toggle -- a
side effect of two earlier rounds of work that each had a real reason at
the time (giving the landing screen's birds backdrop something to sit on;
making Classes Connected read as one coherent dark page instead of white
UI islands on black). Net effect: picking Light Mode never actually turned
the page light anywhere except the cards floating on top of it. All four
now use `var(--bg)` like everything else on the site.

One real finding while removing `#web-view`'s pinned dark-only custom
properties: they turned out to have never affected the graph canvas itself.
`web.js`'s `cssVar()` reads colors via
`getComputedStyle(document.documentElement)` -- the `<html>` element,
which is an *ancestor* of `#web-view`, not a descendant. A custom property
set on `#web-view` only cascades to elements at or below it in the DOM, so
it never reached that `getComputedStyle` call. The dots and connection
lines had been following the site-wide toggle correctly this whole time;
only the surrounding HTML controls (search box, filters, ranking panel,
legend) were stuck dark, since those *do* read `var(--accent)` etc.
directly in their own CSS. Removing the pin fixed the controls without
touching the canvas at all.

At the time this fix landed, the birds backdrop (`landing-bg.js`) also
gained matching light/dark colors and had a theme-toggle race condition
fixed in its `change` listener. Both are moot now: the birds backdrop was
removed entirely in a later change (see §6.12), and `#landing` just shows
`body`'s `var(--bg)` directly, with no separate light/dark color logic of
its own to keep in sync.

### 6.16 User-facing text rewrite: no em dashes, shorter sentences (index.html, tabs.js, app.js, web.js)

Every piece of user-visible prose across the site -- modal copy, tooltips,
alerts, placeholders, the guided tour steps, the About page -- was rewritten
to drop em-dash-style "--" usage and use shorter, plainer sentences. This
was a copy pass only: no markup, logic, or styling changed, and every
`id`/`class`/`data-*` a script depends on was left untouched.

**Scope decision**: only text a site visitor actually reads was rewritten.
Code comments (which use "--" constantly throughout this codebase, this
document included) were deliberately left alone -- "make sure it doesn't
sound robotic" is a request about copy a human reads on the page, not about
comments aimed at whoever maintains the code next. The one exception left
in place on purpose is the CSV export's blank-cell placeholder
(`extraInfoTags(info).join(", ") || "--"` in `app.js`'s `exportAsCSV`) --
that "--" is a spreadsheet "N/A" convention, not a sentence.

**Method**: `grep -n -- "--" <file>` against each of the four files with
user-facing strings, filtered by hand to drop comments and the CSS custom
property name strings that legitimately start with "--" (`cssVar("--gold")`,
`colorVar: "--course"`, etc. in `web.js` -- those are CSS variable names,
not punctuation, and rewriting them would break the graph's colors). What
was left was the real list: ~15 spots in `index.html` (Honors/Feedback/
Terms/Help/Welcome modals, placeholders, the web legend, the About page,
the footer disclaimer), all 12 `TOUR_STEPS` entries plus a few alerts in
`tabs.js`, ~15 alerts/tooltips/hints in `app.js`, and 3 placeholder/hint
strings in `web.js`. The Terms modal's legal paragraphs got the most care,
since simplifying sentence structure there had to preserve the actual legal
meaning, not just shorten word count.

Verified afterward with a Playwright pass that opened every rewritten
modal (Terms, Help, Feedback, Honors, Welcome, all 12 tour steps), the
About page, and the Classes Connected legend, read back each one's
rendered `innerText`, and confirmed no `--` remained anywhere except the
one deliberate CSV placeholder above. `app.js`, `web.js`, and `tabs.js`'s
cache-busting `?v=` bumped to `20260805c` for this change (`style.css` and
`landing-bg.js` weren't touched this pass, so their version stayed put).

### 6.17 Birds backdrop removed; landing screen is a plain background again (index.html, style.css)

The animated flying-birds effect described in §6.12 is gone. `#landing`
now has no background element of its own at all -- `body`'s `var(--bg)`
shows straight through, exactly like every other view, so the landing
screen is plain black in dark mode and the site's usual light background
in light mode, matching whatever the toggle is set to.

Deleted outright: `landing-bg.js`, `assets/vendor/three.r134.min.js`,
`assets/vendor/vanta.birds.min.js` (and the now-empty `assets/vendor/`
directory), the `#vanta-landing-bg` mount element in index.html, its three
`<script>` tags, and the CSS that positioned it and stacked the logo/card
above it (`.vanta-landing-bg`, and the `.isu-logo, .landing-card-wrap {
position: relative; z-index: 1; }` rule, which existed solely to paint
above that canvas and had nothing left to stack above once it was gone).
Net effect on load performance: 644KB less vendored JS on every page load
(`three.r134.min.js` alone was 615KB), on top of the §6.13 work.

`style.css` bumped to `?v=20260805c` for this change (matches the version
already used by `app.js`/`web.js`/`tabs.js` from §6.16's text rewrite).

## 7. Known limitations (disclosed, not bugs)

- The Web's connections (§6.2) don't capture real ISU "Cross-listed with X"
  data, since `scrape_courses.py`'s credits-parsing regex discards that
  phrase before it ever reaches `courses.csv`. The `cross_listed` edge type
  instead relies on two proxies: an explicit, ISU-stated "only one of X, Y,
  Z may count towards graduation" restriction sentence (90 courses have
  one), and courses sharing an identical, substantive description under the
  same course number (see §6.2 for why both the "identical description" and
  "same number" conditions, plus excluding administrative/procedural
  language, are needed -- courses merely sharing a *generic* description,
  like "Individual study of a selected topic" reused by unrelated
  independent-study courses across many departments, are deliberately
  excluded even though ~41% of all courses share *some* description with
  another course). Both are real signals, narrower than true cross-listing
  data would be, but not a heuristic guess either.
- Connecting courses purely by shared department or gen-ed category/tag was
  considered as a way to push the Web's connected-course count even higher,
  and rejected: unlike prereq/coreq/cross-listed/related (each a specific,
  individually-verified fact about two particular courses), "both tagged
  humanities" or "both in the same department" is true for hundreds to
  thousands of course pairs at once, and would produce dense, uninformative
  cliques rather than a meaningful web.
- Humanities/Social Science category membership is a department-prefix
  heuristic, not official ISU data (see §5).
- Non-course prerequisite conditions (class standing, GPA, permission) are
  always treated as satisfied (see §4).
- A generic, unrecognized elective category (not IP/USC/Tech
  Elective/Humanities/Social Science) has no eligible-course list to check
  against, so its progress pill shows `? / target cr` rather than a live
  number.
- A major with mutually-exclusive named options (e.g. Wildlife and
  Fisheries Conservation and Ecology; Kinesiology and Health, §3.1) renders
  every option as its own section, but the program's live "total credits"
  figure (`programFulfilledCredits`) sums *all* of them together, since
  there's no concept of "the student picked just one option" in the data
  model -- the program's stated `total_credits` (used for the `X / Y`
  denominator and the completion checkmark) stays the real, correct
  official minimum regardless.
- Import only round-trips this site's own CSV/`.xls` export formats, not a
  natively-saved `.xlsx`.
- Feedback submissions POST directly to Formspree (§6.5) -- no visitor
  email client involved, unlike an earlier `mailto:`-based version.
- Masters programs have no per-course requirements checklist and aren't
  included in the CSV/Excel export -- see §3.4 for why (ISU has no
  structured per-program graduate requirements to scrape at all); only the
  uniform 30-credit minimum is tracked.
- The double-major credit formula (§6.9) only enforces ISU's overall
  30-extra-credits floor -- it doesn't attempt to detect or dedupe specific
  courses that happen to satisfy both majors' requirements simultaneously.
- The auto-fill pathway generator's list-scheduling heuristic (§6.6) isn't
  an exact solver -- a program with an unusually convergent prerequisite
  structure can still occasionally leave 1-2 unmet requirements even at the
  Fifth Year fallback tier (confirmed for Aerospace Engineering, B.S.).
- A handful of course records have prerequisite text that the scraper's
  regex mis-tokenized into a phantom, non-existent course code -- e.g.
  `FRNCH 4990`/`GER 4990`'s "9 credits of French/German at the 3000 level"
  parsed the word "the" plus "3000" as course code `THE 3000`/`GER 3000`,
  which doesn't exist, so that one prerequisite branch can never be
  satisfied by any schedule. `expandWithRequisites`'s existence guard
  correctly refuses to add the phantom code, so this surfaces as a
  never-clearable warning icon on that specific course, not a crash or a
  silently-wrong schedule. Same root cause as the pre-existing
  `FSHN 3800`/`HSPM 3800` (Culinary Food Science) concurrent-enrollment
  parsing gap and the missing `EDUC 3800` reference from `ENGL 3970` --
  a `build_data.py` prerequisite-text extraction limitation, not a
  scheduling bug.

## 8. Maintenance

- Re-scrape only when ISU's catalog has likely changed (e.g. a new academic
  year) — each run takes several minutes and hits ~170+ live catalog pages.
  Run `python3 run_full_update.py` from the project root to do the entire
  pipeline (§3) in one command, including re-running `build_data.py`/
  `build_web_graph.py` and updating `DATA_LAST_UPDATED` (§6.8) automatically
  -- prefer this over running each step by hand.
- Both scrapers run their embedded pytest suite automatically in the
  background whenever `main()` runs, and will clearly report where/when a
  failure happened; run `python3 -m pytest scrapers/scrape_courses.py -v`
  (or `scrape_majors_minors.py`) directly at any time.
- **Update this file** when you add a feature, change the data model, or fix
  something non-obvious enough that future-you would otherwise have to
  rediscover it from the code.
