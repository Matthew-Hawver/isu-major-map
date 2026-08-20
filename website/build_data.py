"""
Phase 1 of the ISU Degree Schedule Planner (see ../Website-Plan.md): joins
the 5 CSVs produced by ClassesScraper.py and Major-MinorScraper.py into two
JSON files the website loads directly in the browser -- no server, no
database. Re-run this any time the CSVs are re-scraped; it always
regenerates data/courses.json and data/programs.json from scratch.

Output shapes:

  courses.json:
    { "<course code>": {"description", "credits", "prerequisites", "corequisites"}, ... }

  programs.json:
    { "<program_id>": {
        "name", "type", "college", "url", "total_credits", "credits_flag",
        "sections": [
          {"name", "credits_required", "requirements": [
            {"group_id", "relation", "course_code", "credits",
             "group_target_credits", "note"},
            ...
          ]},
          ...
        ]
      }, ... }

  masters.json:
    { "<program_id>": {"name", "degrees", "url", "total_credits"}, ... }
    No "sections" -- see build_masters()'s docstring for why (ISU has no
    structured per-program graduate requirements to scrape).

  Each course's "prereq_logic"/"coreq_logic" is a parsed AND/OR tree built
  from the free-text Prerequisites/Corequisites columns, so the website can
  check in the browser whether a course's requirements are actually met by
  what's scheduled in earlier/same semesters (requirement 5 of the semester
  planner redesign). The source text mixes real course codes with
  unverifiable prose ("Sophomore classification", "Permission of
  Instructor", GPA minimums) -- those become {"other": "..."} leaves that
  always evaluate as satisfied, since we have no way to check them
  programmatically. This is a deliberate, disclosed simplification: it means
  a prerequisite gated purely on non-course criteria will always show as
  met. "Credit or (concurrent) enrollment in X" phrasing is detected and
  marked with allow_concurrent=True, meaning X may be scheduled in the same
  semester (not just earlier) to satisfy it.
"""

import csv
import json
import os
import re

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_DATA_DIR = os.path.join(PROJECT_DIR, "data")  # scraped CSVs, written by scrapers/
DATA_DIR = os.path.dirname(os.path.abspath(__file__)) + "/data"  # website/data, this script's JSON output

COURSES_CSV = os.path.join(SOURCE_DATA_DIR, "courses.csv")
MAJORS_CSV = os.path.join(SOURCE_DATA_DIR, "majors.csv")
MINORS_CSV = os.path.join(SOURCE_DATA_DIR, "minors.csv")
SECTIONS_CSV = os.path.join(SOURCE_DATA_DIR, "sections.csv")
REQUIREMENTS_CSV = os.path.join(SOURCE_DATA_DIR, "requirements.csv")
MASTERS_CSV = os.path.join(SOURCE_DATA_DIR, "masters.csv")

COURSES_JSON = os.path.join(DATA_DIR, "courses.json")
PROGRAMS_JSON = os.path.join(DATA_DIR, "programs.json")
MASTERS_JSON = os.path.join(DATA_DIR, "masters.json")


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


# ---------------- prerequisite/corequisite free-text -> logic tree ----------------

_COURSE_TOKEN = r"[A-Za-z][A-Za-z&]{1,7}\s+\d{3,4}[A-Za-z]?"

_CONCURRENT_RE = re.compile(
    r"\b(?:credit\s+or\s+)?concurrent(?:ly)?\s+(?:enroll(?:ed|ment)?|registration)\s*(?:in)?\b"
    r"|\bcredit\s+or\s+enrollment\s+in\b",
    re.IGNORECASE,
)

_TOKEN_RE = re.compile(
    r"(?P<lparen>\()"
    r"|(?P<rparen>\))"
    r"|(?P<and>\band\b)"
    r"|(?P<or>\bor\b)"
    r"|(?P<sep>,)"
    r"|(?P<course>" + _COURSE_TOKEN + r")"
    r"|(?P<other>(?:(?!\(|\)|\band\b|\bor\b|,|" + _COURSE_TOKEN + r").)+)",
    re.IGNORECASE,
)

_ATOM_START = ("course", "other", "lparen")
_JOINERS = ("and", "or", "sep")


def _tokenize(text):
    """Tokenizes ONE semicolon-delimited segment (see parse_requisite) --
    "," is a soft joiner that can collapse with a neighboring and/or, unlike
    ";" which is a hard boundary handled before this is ever called."""
    tokens = []
    for m in _TOKEN_RE.finditer(text):
        kind = m.lastgroup
        val = m.group().strip()
        if kind == "other" and not val:
            continue
        if kind == "course":
            prefix, number = val.split()
            val = f"{prefix.upper()} {number.upper()}"
        tokens.append((kind, val))

    # Collapse runs of consecutive joiners (e.g. ", or") into a single one,
    # preferring "or" since it's the looser/more-significant operator.
    collapsed = []
    i = 0
    while i < len(tokens):
        kind, val = tokens[i]
        if kind in _JOINERS:
            j = i + 1
            joiners = [kind]
            while j < len(tokens) and tokens[j][0] in _JOINERS:
                joiners.append(tokens[j][0])
                j += 1
            merged = "or" if "or" in joiners else "and"
            collapsed.append((merged, merged))
            i = j
        else:
            collapsed.append((kind, val))
            i += 1

    while collapsed and collapsed[0][0] in ("and", "or"):
        collapsed.pop(0)
    while collapsed and collapsed[-1][0] in ("and", "or"):
        collapsed.pop()

    return collapsed


class _Parser:
    """Recursive-descent parser: OR binds looser than AND; adjacent atoms
    with no explicit and/or/comma between them (e.g. "enrollment in FDM
    5100") are treated as an implicit AND."""

    def __init__(self, tokens):
        self.tokens = tokens
        self.i = 0

    def _peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else (None, None)

    def _advance(self):
        tok = self.tokens[self.i]
        self.i += 1
        return tok

    def parse(self):
        if not self.tokens:
            return {"other": ""}
        return self._or()

    def _or(self):
        children = [self._and()]
        while self._peek()[0] == "or":
            self._advance()
            children.append(self._and())
        return children[0] if len(children) == 1 else {"op": "OR", "children": children}

    def _and(self):
        children = [self._atom()]
        while self._peek()[0] == "and" or self._peek()[0] in _ATOM_START:
            if self._peek()[0] == "and":
                self._advance()
            children.append(self._atom())
        return children[0] if len(children) == 1 else {"op": "AND", "children": children}

    def _atom(self):
        kind, val = self._peek()
        if kind == "lparen":
            self._advance()
            node = self._or()
            if self._peek()[0] == "rparen":
                self._advance()
            return node
        if kind == "course":
            self._advance()
            return {"course": val}
        if kind == "other":
            self._advance()
            return {"other": val}
        self._advance()
        return {"other": ""}


def parse_requisite(text):
    """Parses free-text prerequisites/corequisites into {"tree", "allow_concurrent"},
    or None for blank text. `tree` is a nested {"op": "AND"|"OR", "children": [...]}
    / {"course": "DEPT 1234"} / {"other": "raw prose"} structure."""
    if not text or not text.strip():
        return None

    allow_concurrent = bool(_CONCURRENT_RE.search(text))
    text = _CONCURRENT_RE.sub(" ", text)

    # ";" is a hard AND boundary between independent clauses -- unlike ",",
    # it must NOT let an "or" inside one clause (e.g. "EM 3240 ; ME 1700 or
    # ENGR 1700; STAT 3005") bind across the whole expression. Each
    # semicolon-delimited segment is parsed on its own and the results are
    # ANDed together, so an "or" only ever scopes to its own segment.
    segments = [seg for seg in text.split(";") if seg.strip()]
    trees = [_Parser(_tokenize(seg)).parse() for seg in segments]

    if not trees:
        return None
    tree = trees[0] if len(trees) == 1 else {"op": "AND", "children": trees}
    return {"tree": tree, "allow_concurrent": allow_concurrent}


# ---------------- gen-ed category tagging ----------------
#
# ISU tags two gen-ed requirements directly in the catalog description text
# ("Meets International Perspectives Requirement.", "Meets U.S. Cultures and
# Communities Requirement."), so those two are reliably detectable. There is
# no equivalent "Meets Humanities Requirement"/"Meets Social Science
# Requirement" tag anywhere in the source data, so the Humanities-vs-Social-
# Science split requested for those two categories is NOT directly derivable
# -- it's approximated here with a department-prefix heuristic covering the
# departments that actually appear in the IP/USC-tagged course list.
# Departments left out of both buckets fall into "other" rather than being
# force-classified, since guessing wrong would misinform a student's actual
# degree progress. This is disclosed in the UI, not presented as official.

_IP_RE = re.compile(r"meets international\s*perspectives requirement", re.IGNORECASE)
_USC_RE = re.compile(r"meets u\.?s\.? cultures and communities requirement", re.IGNORECASE)

_HUMANITIES_DEPTS = {
    "SPAN", "FRNCH", "GER", "CHIN", "RUS", "WLC", "ARABC", "LATIN", "PORT",
    "HIST", "CLST", "ARTH", "RELIG", "ENGL", "LING", "PHIL",
    "ART", "ARTID", "ARTGR", "MUSIC", "DANCE",
}

_SOCIAL_SCIENCE_DEPTS = {
    "ANTHR", "POLS", "ECON", "SOC", "PSYCH", "WGS", "AFAM", "AFAS", "AMIN",
    "USLS", "INTST", "GLOBE", "HDFS", "CJ", "EDUC", "SPED", "JLMC",
    "COMST", "SPCM", "LDST",
}


def gen_ed_tags_for(description):
    tags = []
    if _IP_RE.search(description):
        tags.append("international_perspectives")
    if _USC_RE.search(description):
        tags.append("us_cultures")
    return tags


def gen_ed_category_for(class_code):
    dept = class_code.split()[0].upper() if class_code.split() else ""
    if dept in _HUMANITIES_DEPTS:
        return "humanities"
    if dept in _SOCIAL_SCIENCE_DEPTS:
        return "social_science"
    return "other"


def build_courses():
    courses = {}
    for row in read_csv(COURSES_CSV):
        code = row["Class Code"]
        tags = gen_ed_tags_for(row["Description"])
        courses[code] = {
            "description": row["Description"],
            "credits": row["Credits"],
            "prerequisites": row["Prerequisites"],
            "corequisites": row["Corequisites"],
            "prereq_logic": parse_requisite(row["Prerequisites"]),
            "coreq_logic": parse_requisite(row["Corequisites"]),
            "gen_ed_tags": tags,
            # Computed for every course, not just IP/USC-tagged ones -- plain
            # "Humanities"/"Social Science" gen-ed requirements (common on
            # majors' General Education sections) need this classification
            # too, and most of those courses were never IP/USC-tagged at all.
            "gen_ed_category": gen_ed_category_for(code),
        }
    return courses


def build_programs():
    programs = {}
    for row in read_csv(MAJORS_CSV) + read_csv(MINORS_CSV):
        programs[row["program_id"]] = {
            "name": row["name"],
            "type": row["type"],
            "college": row["college"],
            "url": row.get("url", ""),
            "total_credits": row["total_credits"],
            "credits_flag": row["credits_flag"],
            "sections": [],
        }

    sections_by_id = {}
    for row in read_csv(SECTIONS_CSV):
        program = programs.get(row["program_id"])
        if program is None:
            continue  # section belongs to a program that's unresolved/dropped
        section = {
            "name": row["name"],
            "credits_required": row["credits_required"],
            "requirements": [],
        }
        program["sections"].append(section)
        sections_by_id[row["section_id"]] = section

    for row in read_csv(REQUIREMENTS_CSV):
        section = sections_by_id.get(row["section_id"])
        if section is None:
            continue
        section["requirements"].append({
            "group_id": row["group_id"],
            "relation": row["relation"],
            "course_code": row["course_code"],
            "credits": row["credits"],
            "group_target_credits": row["group_target_credits"],
            "note": row["note"],
        })

    return programs


def build_masters():
    """masters.csv (scrapers/scrape_masters.py) has no sections/requirements
    -- see that script's docstring for why: ISU has no structured,
    per-program graduate requirements page to scrape, unlike majors/minors.
    total_credits is ISU's one uniform Graduate College minimum (30
    credits), not a verified per-program figure."""
    masters = {}
    if not os.path.exists(MASTERS_CSV):
        return masters
    for row in read_csv(MASTERS_CSV):
        masters[row["program_id"]] = {
            "name": row["name"],
            "degrees": row["degrees"],
            "url": row["url"],
            "total_credits": row["total_credits"],
        }
    return masters


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    courses = build_courses()
    with open(COURSES_JSON, "w", encoding="utf-8") as f:
        json.dump(courses, f, separators=(",", ":"))
    print(f"Wrote {len(courses)} courses to {COURSES_JSON} "
          f"({os.path.getsize(COURSES_JSON) / 1024:.0f} KB)")

    programs = build_programs()
    with open(PROGRAMS_JSON, "w", encoding="utf-8") as f:
        json.dump(programs, f, separators=(",", ":"))
    n_sections = sum(len(p["sections"]) for p in programs.values())
    n_requirements = sum(len(s["requirements"]) for p in programs.values() for s in p["sections"])
    print(f"Wrote {len(programs)} programs ({n_sections} sections, {n_requirements} requirement "
          f"rows) to {PROGRAMS_JSON} ({os.path.getsize(PROGRAMS_JSON) / 1024:.0f} KB)")

    masters = build_masters()
    with open(MASTERS_JSON, "w", encoding="utf-8") as f:
        json.dump(masters, f, separators=(",", ":"))
    print(f"Wrote {len(masters)} masters programs to {MASTERS_JSON} "
          f"({os.path.getsize(MASTERS_JSON) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
