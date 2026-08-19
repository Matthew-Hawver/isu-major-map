// Loads the two JSON files built by build_data.py, lets the user pick a
// major (and optionally a minor), and build a semester-by-semester schedule
// by dragging courses into place. Semesters run vertically on the left
// (Credits From High School, then Freshman/Sophomore/Junior/Senior Semester
// 1/2, with optional summer terms insertable between years); the right side
// is a search bar plus the requirements checklist to drag courses from.
// Everything is client-side; the schedule is saved in localStorage per
// (major, minor) pair.

const MIN_CREDITS = 12;
const MAX_CREDITS = 18;
const HONORS_MAX_CREDITS = 22; // matches ISU's honors-student credit ceiling
const SUMMER_MAX_CREDITS = 12; // hard cap, enforced in placeCourse() -- not just a warning
// A Fifth Year (toggled per-schedule, like activeSummers) appends a 5th
// entry here and extends the regular-semester range to reg-10; a summer
// after it becomes reachable the same way summers after years 1-4 already are.
const REGULAR_YEAR_NAMES = ["Freshman", "Sophomore", "Junior", "Senior", "Fifth Year"];
const SUMMER_ANCHORS = [2, 4, 6, 8, 10]; // insertion points: after semester 2, 4, 6, 8, 10
const GRAD_SEMESTER_COUNT = 4; // Masters: "another two years" appended after all undergrad semesters
const HONORS_KEY = "isu-planner-honors-student";
// ISU's actual double-major rule (catalog.iastate.edu, Academic Life ->
// Degree Planning): a double major earns ONE degree with both majors
// listed, and requires at least this many more credits than whichever
// major alone needs more of -- not a simple sum of both majors' totals.
const DOUBLE_MAJOR_EXTRA_CREDITS = 30;
const SEARCH_MATCH_CAP = 200;
const SEMESTER_WIDTH_KEY = "isu-planner-semester-column-width";
const MIN_SEMESTER_COLUMN_WIDTH = 260;
const MIN_BROWSE_COLUMN_WIDTH = 380;

// Some ISU gen-ed requirement categories (e.g. "International Perspectives")
// are university-wide and weren't enumerated on the major/minor pages we
// scraped, so searching their full name may not be very useful yet -- but
// aliasing short codes to their full name at least keeps both spellings
// searching the same thing.
const SEARCH_ALIASES = { ip: "international perspectives" };

// ISU's standard 4.0 quality-point scale. Deliberately excludes P/NP
// (Pass/Not Pass -- selectable as marks below, see PASS_MARKS, but never
// assigned a point value) and S/T/R, which ISU's real GPA calculation
// excludes entirely: a course graded with one of those should never
// contribute quality points or attempted credits, the same way an
// ungraded course doesn't.
const GRADE_POINTS = {
  "A": 4.00, "A-": 3.67,
  "B+": 3.33, "B": 3.00, "B-": 2.67,
  "C+": 2.33, "C": 2.00, "C-": 1.67,
  "D+": 1.33, "D": 1.00, "D-": 0.67,
  "F": 0.00,
};
const GRADE_ORDER = Object.keys(GRADE_POINTS);
// Pass/Not Pass -- selectable marks that intentionally have no entry in
// GRADE_POINTS, so gpaForCodes() naturally excludes them from GPA the same
// way it excludes an ungraded course.
const PASS_MARKS = ["P", "NP"];
const ALL_GRADE_MARKS = [...GRADE_ORDER, ...PASS_MARKS];

let programs = {};
let mastersPrograms = {};
let courses = {};
let requirementNotesByCode = {};
let schedule = { activeSummers: [], courses: {}, grades: {}, honors: false, fifthYear: false };

// Tap-to-place: a touch-friendly alternative to dragging a course chip/row
// into a semester (native HTML5 drag-and-drop never fires on touchscreens).
// Tapping an unplaced course sets this, then tapping a semester's course
// list calls placeCourse() with it -- see selectCourseForPlacement() and
// wireDropTarget() below. Plain clicks, so mouse users get this too, at no
// cost to the existing drag-and-drop (a real drag never fires a trailing
// click on its source element).
let selectedCourseCode = null;

async function loadData() {
  const [programsRes, coursesRes, mastersRes] = await Promise.all([
    fetch("data/programs.json"),
    fetch("data/courses.json"),
    fetch("data/masters.json"),
  ]);
  programs = await programsRes.json();
  courses = await coursesRes.json();
  mastersPrograms = await mastersRes.json();
}

function buildSearchIndex() {
  requirementNotesByCode = {};
  for (const program of Object.values(programs)) {
    for (const section of program.sections) {
      for (const req of section.requirements) {
        if (req.course_code && req.note) {
          if (!requirementNotesByCode[req.course_code]) requirementNotesByCode[req.course_code] = new Set();
          requirementNotesByCode[req.course_code].add(req.note);
        }
      }
    }
  }
}

function populateSelect(select, type, placeholder, excludeId) {
  const entries = Object.entries(programs)
    .filter(([, p]) => (type === "Major" ? p.type !== "Minor" : p.type === "Minor"))
    .filter(([id]) => id !== excludeId)
    .sort((a, b) => a[1].name.localeCompare(b[1].name));

  select.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = placeholder;
  select.appendChild(blank);

  for (const [id, p] of entries) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = p.name;
    select.appendChild(opt);
  }
}

// Major and Second Major can't be the same program -- picking one out of
// the other's list would otherwise render that program's requirements
// panel twice (selectedPrograms() would return the same object at both
// indices). Re-excludes each select's OWN option list from the other's
// current value on every change, and if a conflict already exists (e.g.
// Major just changed to match the standing Second Major), Second Major
// loses since it's the optional one.
function refreshProgramExclusions() {
  const majorSelect = document.getElementById("major-select");
  const secondMajorSelect = document.getElementById("second-major-select");
  const currentMajor = majorSelect.value;
  const resolvedSecondMajor = secondMajorSelect.value === currentMajor ? "" : secondMajorSelect.value;

  populateSelect(majorSelect, "Major", "Select a major…", resolvedSecondMajor);
  populateSelect(secondMajorSelect, "Major", "None (optional)", currentMajor);
  majorSelect.value = currentMajor;
  secondMajorSelect.value = resolvedSecondMajor;
  // The hidden select's own <option> list just changed (the exclusion
  // above rebuilds it) -- the searchable-select UI mirroring it needs to
  // pick up the same change, or it'd keep offering the now-excluded major.
  secondMajorSearchable?.refresh();
}

// ---------------- reusable searchable select ----------------
// A search-as-you-type replacement for a plain <select>, the same pattern
// the major typeahead on the landing page already uses (see
// renderMajorTypeahead()/selectMajor()) generalized for any option list.
// Typing nothing, or clearing the box, means "blank" -- the same as an
// optional <select> left on its default/"None" option -- so these compose
// as a drop-in visual replacement without changing what "no selection"
// means to any existing code. Results float as an absolute-positioned
// overlay (unlike the major typeahead's own always-expanded list) since
// several of these sit close together (the setup form) or side-by-side in
// a toolbar (the graph filters).
function createSearchableSelect(container, { options, placeholder, onChange }) {
  container.classList.add("searchable-select-mount");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "searchable-select-input";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  const results = document.createElement("div");
  results.className = "searchable-select-results";
  results.hidden = true;
  container.appendChild(input);
  container.appendChild(results);

  let value = "";
  let byValue = new Map();

  function setOptions(newOptions) {
    options = newOptions;
    byValue = new Map(options.map((o) => [o.value, o]));
  }
  setOptions(options);

  function renderResults(query) {
    results.innerHTML = "";
    const q = query.trim().toLowerCase();

    if (!q) {
      // Matches renderMajorTypeahead()'s own behavior: an empty box shows a
      // hint, not a scrollable wall of every option -- also matters
      // structurally here, not just cosmetically, since this dropdown
      // floats over whatever's below it (e.g. "View My Schedule" right
      // under Second Major) and a full-length list would cover it.
      const hint = document.createElement("p");
      hint.className = "typeahead-hint";
      hint.textContent = `Start typing to search ${options.length}…`;
      results.appendChild(hint);
      results.hidden = false;
      return;
    }

    const matches = options.filter((o) => o.label.toLowerCase().includes(q)).slice(0, 40);
    if (!matches.length) {
      const hint = document.createElement("p");
      hint.className = "typeahead-hint";
      hint.textContent = "No matches.";
      results.appendChild(hint);
    } else {
      for (const opt of matches) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "typeahead-row";
        row.innerHTML = `<span class="typeahead-name">${opt.label}</span>`
          + (opt.sublabel ? `<span class="typeahead-college">${opt.sublabel}</span>` : "");
        // Keeps focus on the input through the click, so the row's own
        // click handler fires before blur (below) hides the results.
        row.addEventListener("mousedown", (e) => e.preventDefault());
        row.addEventListener("click", () => choose(opt.value));
        results.appendChild(row);
      }
    }
    results.hidden = false;
  }

  function choose(newValue) {
    value = newValue;
    const opt = byValue.get(newValue);
    input.value = opt ? opt.label : "";
    results.hidden = true;
    onChange(value);
  }

  input.addEventListener("input", (e) => {
    if (!e.target.value.trim()) {
      // Emptying the box IS the "blank/None" state -- no separate clear button needed.
      value = "";
      onChange("");
    }
    renderResults(e.target.value);
  });
  input.addEventListener("focus", () => renderResults(input.value));
  input.addEventListener("blur", () => { results.hidden = true; });

  return {
    getValue: () => value,
    setValue(newValue) {
      value = newValue;
      const opt = byValue.get(newValue);
      input.value = opt ? opt.label : "";
    },
    setOptions,
  };
}

// Mounts a createSearchableSelect() that mirrors an existing hidden
// <select>'s options and writes back through it (.value + a dispatched
// "change" event), so every existing function that already reads that
// select's .value or listens for its "change" event keeps working
// completely unchanged.
function wireSearchableSelectToHiddenSelect(container, hiddenSelect, placeholder) {
  const readOptions = () => [...hiddenSelect.options]
    .filter((o) => o.value)
    .map((o) => ({ value: o.value, label: o.textContent }));

  const controller = createSearchableSelect(container, {
    options: readOptions(),
    placeholder,
    onChange(value) {
      hiddenSelect.value = value;
      hiddenSelect.dispatchEvent(new Event("change"));
    },
  });
  controller.refresh = () => {
    controller.setOptions(readOptions());
    controller.setValue(hiddenSelect.value);
  };
  return controller;
}

let secondMajorSearchable = null;
let minorSearchable = null;
let mastersSearchable = null;

// mastersPrograms is a separate dict from programs (no "type" field, no
// sections -- see build_masters()'s docstring), so it gets its own
// populate function rather than reusing populateSelect()'s Major/Minor filter.
function populateMastersSelect(select) {
  const entries = Object.entries(mastersPrograms).sort((a, b) => a[1].name.localeCompare(b[1].name));

  select.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "None (optional)";
  select.appendChild(blank);

  for (const [id, p] of entries) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = p.name;
    select.appendChild(opt);
  }
}

// ---------------- semester slot model ----------------
//
// Slots are identified by a stable id: "hs" (Credits From High School, no
// credit limits), "reg-N" for N=1..8 (Freshman Semester 1 ... Senior
// Semester 2, each needing 12-18/22 credits) -- extended to N=1..10 when
// the Fifth Year toggle is on (schedule.fifthYear) -- and "summer-A" for
// A in {2,4,6,8,10} (an optional summer term inserted right after reg-A, no
// credit limits). Only summer slots the user has added are rendered. If a
// Masters program is selected, "grad-N" for N=1..GRAD_SEMESTER_COUNT are
// appended after every undergrad slot -- see undergradSemesterCount().

function undergradSemesterCount() {
  return schedule.fifthYear ? 10 : 8;
}

function slotMeta(slotId) {
  if (slotId === "hs") return { label: "Credits From High School", kind: "hs" };

  let m = /^reg-(\d+)$/.exec(slotId);
  if (m) {
    const n = Number(m[1]);
    const yearIdx = Math.floor((n - 1) / 2);
    const term = ((n - 1) % 2) + 1;
    return { label: `${REGULAR_YEAR_NAMES[yearIdx]} Semester ${term}`, kind: "regular" };
  }

  m = /^summer-(\d+)$/.exec(slotId);
  if (m) {
    const anchor = Number(m[1]);
    const yearIdx = anchor / 2 - 1;
    const yearName = REGULAR_YEAR_NAMES[yearIdx];
    // REGULAR_YEAR_NAMES[4] is "Fifth Year" (already has "Year" in it,
    // unlike "Freshman"/"Sophomore"/etc.) -- avoid "Summer After Fifth Year Year".
    const label = yearName.endsWith("Year") ? `Summer After ${yearName}` : `Summer After ${yearName} Year`;
    return { label, kind: "summer", anchor };
  }

  m = /^grad-(\d+)$/.exec(slotId);
  if (m) {
    return { label: `Masters Semester ${Number(m[1])}`, kind: "grad" };
  }

  return { label: slotId, kind: "regular" };
}

function slotAnchorAfter(slotId) {
  const m = /^reg-(\d+)$/.exec(slotId);
  if (!m) return null;
  const n = Number(m[1]);
  return SUMMER_ANCHORS.includes(n) ? n : null;
}

function buildSlotOrder() {
  const active = new Set(schedule.activeSummers);
  const order = ["hs"];
  const regCount = undergradSemesterCount();
  for (let i = 1; i <= regCount; i++) {
    order.push(`reg-${i}`);
    if (SUMMER_ANCHORS.includes(i) && active.has(i)) order.push(`summer-${i}`);
  }
  if (document.getElementById("masters-select").value) {
    for (let i = 1; i <= GRAD_SEMESTER_COUNT; i++) order.push(`grad-${i}`);
  }
  return order;
}

// ---------------- schedule state (localStorage-backed) ----------------

// Centralizes the 4 program pickers so scheduleKey/totalCreditsNeeded/etc.
// don't each repeat the same getElementById calls.
function programSelectIds() {
  return {
    major: document.getElementById("major-select").value,
    secondMajor: document.getElementById("second-major-select").value,
    minor: document.getElementById("minor-select").value,
    masters: document.getElementById("masters-select").value,
  };
}

function scheduleKey() {
  const { major, secondMajor, minor, masters } = programSelectIds();
  return `isu-schedule:${major || "none"}:${secondMajor || "none"}:${minor || "none"}:${masters || "none"}`;
}

function honorsEnabled() {
  return localStorage.getItem(HONORS_KEY) === "1";
}

function loadSchedule() {
  const raw = localStorage.getItem(scheduleKey());
  if (raw) {
    const parsed = JSON.parse(raw);
    schedule = {
      activeSummers: parsed.activeSummers || [],
      courses: parsed.courses || {},
      grades: parsed.grades || {},
      honors: honorsEnabled(),
      fifthYear: parsed.fifthYear || false,
    };
    return;
  }

  // First time this exact program combination has been picked -- seed it
  // with a suggested pathway instead of leaving every semester empty.
  const { major, secondMajor, minor } = programSelectIds();
  const generated = major
    ? generateDefaultPathway(major, minor, secondMajor)
    : { courses: {}, activeSummers: [], fifthYear: false };
  schedule = {
    activeSummers: generated.activeSummers,
    courses: generated.courses,
    grades: {},
    honors: honorsEnabled(),
    fifthYear: generated.fifthYear || false,
  };
  saveSchedule();
}

function clearAllSchedule() {
  if (!confirm("Clear your entire schedule? This removes every course from every semester.")) return;
  schedule.activeSummers = [];
  schedule.courses = {};
  schedule.grades = {};
  schedule.fifthYear = false;
  saveSchedule();
  renderAll();
}

function saveSchedule() {
  localStorage.setItem(scheduleKey(), JSON.stringify({
    activeSummers: schedule.activeSummers,
    courses: schedule.courses,
    grades: schedule.grades,
    fifthYear: schedule.fifthYear,
  }));
}

function allScheduledCodes() {
  return new Set(Object.values(schedule.courses).flat());
}

function findScheduledSlot(code) {
  for (const [slotId, codes] of Object.entries(schedule.courses)) {
    if (codes.includes(code)) return slotId;
  }
  return null;
}

function clearSlot(slotId) {
  delete schedule.courses[slotId];
}

function placeCourse(code, targetSlotId, beforeCode) {
  if (slotMeta(targetSlotId).kind === "summer") {
    // Excludes `code` itself first so re-dropping a course already in this
    // same summer (e.g. just reordering it) doesn't double-count its credits.
    const others = (schedule.courses[targetSlotId] || []).filter((c) => c !== code);
    const projected = others.reduce((sum, c) => sum + courseCredits(c), 0) + courseCredits(code);
    if (projected > SUMMER_MAX_CREDITS) {
      alert(`${slotMeta(targetSlotId).label} is capped at ${SUMMER_MAX_CREDITS} credits -- `
        + `adding ${code} would put it at ${projected}.`);
      return;
    }
  }

  for (const slotId of Object.keys(schedule.courses)) {
    schedule.courses[slotId] = schedule.courses[slotId].filter((c) => c !== code);
  }
  if (!schedule.courses[targetSlotId]) schedule.courses[targetSlotId] = [];
  const list = schedule.courses[targetSlotId];
  const insertAt = beforeCode ? list.indexOf(beforeCode) : -1;
  if (insertAt !== -1) list.splice(insertAt, 0, code);
  else list.push(code);
  saveSchedule();
  renderAll();
}

function removeCourse(code) {
  for (const slotId of Object.keys(schedule.courses)) {
    schedule.courses[slotId] = schedule.courses[slotId].filter((c) => c !== code);
  }
  delete schedule.grades[code];
  saveSchedule();
  renderAll();
}

function courseCredits(code) {
  const value = parseFloat(courses[code]?.credits);
  return Number.isFinite(value) ? value : 0;
}

function totalCreditsNeeded() {
  const { major, secondMajor, minor, masters } = programSelectIds();
  const creditsOf = (id) => {
    const value = parseFloat(programs[id]?.total_credits);
    return Number.isFinite(value) ? value : 0;
  };

  let total = major ? creditsOf(major) : 0;
  if (secondMajor) {
    // ISU's actual double-major rule (see DOUBLE_MAJOR_EXTRA_CREDITS) --
    // whichever major needs more credits, plus at least 30 more. Not a sum
    // of both majors' totals.
    total = Math.max(creditsOf(major), creditsOf(secondMajor)) + DOUBLE_MAJOR_EXTRA_CREDITS;
  }
  if (minor) total += creditsOf(minor);
  if (masters) {
    const mastersValue = parseFloat(mastersPrograms[masters]?.total_credits);
    if (Number.isFinite(mastersValue)) total += mastersValue;
  }
  return total;
}

// ---------------- grades / GPA ----------------
// ISU computes GPA as total quality points (grade value * credits) divided
// by total credits attempted in standard letter-graded courses -- an
// average weighted by credits, not a simple average of grades.

function setGrade(code, grade) {
  if (grade) schedule.grades[code] = grade;
  else delete schedule.grades[code];
  saveSchedule();
  renderAll();
}

function gpaForCodes(codes) {
  let qualityPoints = 0;
  let creditsAttempted = 0;
  for (const code of codes) {
    const grade = schedule.grades[code];
    const points = GRADE_POINTS[grade];
    if (points === undefined) continue; // ungraded, or a P/NP mark (excluded from GPA by design)
    const credits = courseCredits(code);
    qualityPoints += points * credits;
    creditsAttempted += credits;
  }
  return creditsAttempted > 0 ? qualityPoints / creditsAttempted : null;
}

function semesterGPA(slotId) {
  return gpaForCodes(schedule.courses[slotId] || []);
}

function cumulativeGPA() {
  return gpaForCodes([...allScheduledCodes()]);
}

// ---------------- gen-ed / elective category expansion ----------------
//
// ISU tags two gen-ed requirements right in the catalog description
// ("Meets International Perspectives Requirement.", "...U.S. Cultures and
// Communities Requirement.") -- see build_data.py's gen_ed_tags_for. There's
// no equivalent explicit tag for "Technical Electives"; that's a
// per-program category generally meaning "upper-level courses from your own
// department," so its eligible list is inferred from whichever course
// prefix appears most often among the program's own concretely-named
// requirements.

const CATEGORY_DISPLAY_CAP = 60;
const expandedCategories = new Set(); // ephemeral per-session expand/collapse state, not persisted

function categoryKind(note) {
  const n = (note || "").toLowerCase();
  if (n.includes("international perspectives")) return "ip";
  if (n.includes("u.s. cultures") || n.includes("us cultures")) return "usc";
  if (n.includes("technical elective") || n.includes("tech elective")) return "tech";
  if (n.includes("humanities")) return "humanities";
  if (n.includes("social science")) return "social_science";
  return null;
}

function categoryLabel(kind) {
  return {
    ip: "International Perspectives",
    usc: "U.S. Cultures and Communities",
    tech: "Technical Electives",
    humanities: "Humanities",
    social_science: "Social Science",
  }[kind];
}

function programHomeDepartment(program) {
  const counts = {};
  for (const section of program.sections) {
    for (const req of section.requirements) {
      if (req.course_code) {
        const dept = req.course_code.split(" ")[0];
        counts[dept] = (counts[dept] || 0) + 1;
      }
    }
  }
  let best = null;
  let bestCount = 0;
  for (const [dept, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = dept;
      bestCount = count;
    }
  }
  return best;
}

function eligibleCoursesForCategory(kind, program) {
  let codes;
  if (kind === "ip") {
    codes = Object.keys(courses).filter((c) => courses[c].gen_ed_tags?.includes("international_perspectives"));
  } else if (kind === "usc") {
    codes = Object.keys(courses).filter((c) => courses[c].gen_ed_tags?.includes("us_cultures"));
  } else if (kind === "tech") {
    const dept = programHomeDepartment(program);
    codes = dept ? Object.keys(courses).filter((c) => c.startsWith(`${dept} `) && courseLevel(c) >= 3000) : [];
  } else if (kind === "humanities" || kind === "social_science") {
    codes = Object.keys(courses).filter((c) => courses[c].gen_ed_category === kind);
  } else {
    codes = [];
  }
  return codes.sort((a, b) => courseLevel(a) - courseLevel(b));
}

function splitByGenEdCategory(codes) {
  const humanities = [];
  const socialScience = [];
  const other = [];
  for (const c of codes) {
    const cat = courses[c].gen_ed_category;
    if (cat === "humanities") humanities.push(c);
    else if (cat === "social_science") socialScience.push(c);
    else other.push(c);
  }
  return { humanities, socialScience, other };
}

// ---------------- section fulfillment ----------------

// A handful of category rows (e.g. "Complete 15 cr. Technical Electives")
// never got a structured credit amount from the scraper -- the number only
// exists inside the note's prose. This recovers it so the section's
// fulfilled-credit math doesn't silently treat it as 0.
function extractCreditsFromNote(note) {
  const m = /(\d+(?:\.\d+)?)\s*cr/i.exec(note || "");
  return m ? parseFloat(m[1]) : 0;
}

// Some programs represent International Perspectives / U.S. Cultures /
// Technical Electives as their OWN section with a credit target but zero
// requirement rows (the category lives only in the section's name), rather
// than as a note on a blank-course-code row inside a bigger section. Both
// representations need to resolve to the same category-kind handling.
function wholeSectionCategoryKind(section) {
  return section.requirements.length === 0 ? categoryKind(section.name) : null;
}

// Sums the REAL credits of every eligible-for-`kind` course that's actually
// scheduled -- not a one-shot "is anything scheduled? then count the whole
// target" flag, which would freeze at the target credit the moment a single
// matching course showed up and never move again no matter how many more
// were added afterward (that was a real bug: adding a 2nd, 3rd, ... tech
// elective did nothing once the first one made the section "look" done).
function categoryScheduledCredits(kind, program, scheduled) {
  return eligibleCoursesForCategory(kind, program)
    .filter((c) => scheduled.has(c))
    .reduce((sum, c) => sum + courseCredits(c), 0);
}

function sectionFulfilledCredits(section, program) {
  const scheduled = allScheduledCodes();

  const wholeKind = wholeSectionCategoryKind(section);
  if (wholeKind) {
    return categoryScheduledCredits(wholeKind, program, scheduled);
  }

  let total = 0;
  for (const group of groupRequirements(section.requirements)) {
    const target = parseFloat(group[0].group_target_credits || group[0].credits)
      || extractCreditsFromNote(group[0].note) || 0;
    if (group.length === 1 && !group[0].course_code) {
      const kind = categoryKind(group[0].note);
      if (kind) {
        total += categoryScheduledCredits(kind, program, scheduled);
      }
    } else {
      // An alternative like "CE 2710 & CE 2720" only counts once ALL of its
      // real constituent courses are scheduled, not just the literal string.
      const satisfied = group.some((r) => r.course_code
        && splitComboCode(r.course_code).every((c) => scheduled.has(c)));
      if (satisfied) total += target;
    }
  }
  return total;
}

function isSectionFulfilled(section, program) {
  const required = parseFloat(section.credits_required) || 0;
  if (!required) return false;
  return sectionFulfilledCredits(section, program) >= required;
}

function programFulfilledCredits(program) {
  return program.sections.reduce((sum, s) => sum + sectionFulfilledCredits(s, program), 0);
}

function isProgramComplete(program) {
  const required = parseFloat(program.total_credits) || 0;
  if (!required) return false;
  return program.sections.every((s) => isSectionFulfilled(s, program)) && programFulfilledCredits(program) >= required;
}

// ---------------- default pathway generator ----------------
//
// Seeds a brand-new (major, minor) schedule with a *complete* starting
// pathway: every specifically-required course, one pick from each "choose
// one of the following" group, one pick for each recognized elective
// category (International Perspectives / U.S. Cultures / Technical
// Electives -- see "gen-ed / elective category expansion" below), and then
// the transitive closure of everything THOSE courses themselves need as a
// prerequisite or corequisite (so a capstone that needs a course we didn't
// otherwise list still gets it, recursively). That closure is what lets
// every section end up fulfilled and nothing end up flagged for an unmet
// requisite -- at the cost of the generated total sometimes running higher
// than the program's nominal credit count, since some of those transitively
// -added courses aren't literally named on the requirements page.
//
// Courses are ordered by dependency depth (critical-path length through
// prereqs/coreqs within the set), course level as a tiebreaker, then packed
// into the 8 regular semesters aiming for ~15 credits each. If a dependency
// chain genuinely runs deeper than 8 regular semesters can hold without
// forcing two dependent courses into the same semester, summer terms are
// activated automatically as overflow capacity (in true chronological
// order, so validation afterward sees the same ordering the generator used).

function courseLevel(code) {
  const m = /(\d+)/.exec(code);
  return m ? parseInt(m[1], 10) : 9999;
}

function collectDefaultCourses(programId) {
  const program = programs[programId];
  if (!program) return [];
  const codes = [];
  for (const section of program.sections) {
    const wholeKind = wholeSectionCategoryKind(section);
    if (wholeKind) {
      const eligible = eligibleCoursesForCategory(wholeKind, program);
      if (eligible.length) codes.push(eligible[0]);
      continue;
    }
    for (const group of groupRequirements(section.requirements)) {
      if (group.length === 1 && group[0].course_code) {
        codes.push(...splitComboCode(group[0].course_code));
      } else if (group.length > 1) {
        const withCode = group.find((r) => r.course_code);
        if (withCode) codes.push(...splitComboCode(withCode.course_code));
      } else if (group.length === 1 && !group[0].course_code) {
        const kind = categoryKind(group[0].note);
        if (kind) {
          const eligible = eligibleCoursesForCategory(kind, program);
          if (eligible.length) codes.push(eligible[0]);
        }
      }
    }
  }
  return codes;
}

function directRequisiteCodes(code, withinSet, field) {
  const logic = courses[code]?.[field];
  if (!logic) return [];
  const found = [];
  (function walk(node) {
    if (!node) return;
    if (node.op) {
      node.children.forEach(walk);
      return;
    }
    if (node.course && withinSet.has(node.course)) found.push(node.course);
  })(logic.tree);
  return found;
}

function directPrereqCodes(code, withinSet) {
  return directRequisiteCodes(code, withinSet, "prereq_logic");
}

function directCoreqCodes(code, withinSet) {
  return directRequisiteCodes(code, withinSet, "coreq_logic");
}

// Walks a requisite logic tree and picks ONE concrete course per branch that
// would satisfy it (first alternative of an OR, every child of an AND).
// Non-course prose leaves ("Sophomore classification", GPA minimums, ...)
// contribute nothing -- there's no specific course that would satisfy them.
function pickSatisfyingCourses(node) {
  if (!node) return [];
  if (node.op === "AND") return node.children.flatMap(pickSatisfyingCourses);
  if (node.op === "OR") {
    for (const child of node.children) {
      if (child.course) return [child.course];
      const picks = pickSatisfyingCourses(child);
      if (picks.length) return picks;
    }
    return [];
  }
  if (node.course) return [node.course];
  return [];
}

function expandWithRequisites(initialCodes) {
  const set = new Set(initialCodes);
  const queue = [...initialCodes];
  while (queue.length) {
    const code = queue.shift();
    const info = courses[code];
    if (!info) continue;
    const needed = [
      ...(info.prereq_logic ? pickSatisfyingCourses(info.prereq_logic.tree) : []),
      ...(info.coreq_logic ? pickSatisfyingCourses(info.coreq_logic.tree) : []),
    ];
    for (const need of needed) {
      if (!set.has(need) && courses[need]) {
        set.add(need);
        queue.push(need);
      }
    }
  }
  return set;
}

function topoOrder(codes) {
  const remaining = new Set(codes);
  const deps = new Map(codes.map((c) => [
    c,
    [...directPrereqCodes(c, remaining), ...directCoreqCodes(c, remaining)],
  ]));
  const placed = new Set();
  const order = [];

  while (remaining.size) {
    let candidates = [...remaining].filter((c) => deps.get(c).every((d) => placed.has(d)));
    if (!candidates.length) candidates = [...remaining]; // dependency cycle/gap -- just take what's left
    candidates.sort((a, b) => courseLevel(a) - courseLevel(b) || a.localeCompare(b));
    const next = candidates[0];
    order.push(next);
    placed.add(next);
    remaining.delete(next);
  }
  return order;
}

// Longest remaining downstream chain hanging off each course -- "how much
// still depends on this being scheduled early." A course with high height
// sits at the head of a long stretch of later requirements and needs first
// claim on early bin capacity; a course with height 0 is a dead end
// (nothing in this program depends on it) and can slot into whatever
// capacity is left over without consequence. A "credit or concurrent
// enrollment" edge doesn't cost a hop, matching the same allow_concurrent
// leniency used for minBin in packIntoBins.
function computeHeights(orderedCodes, codeSet) {
  const dependents = new Map(orderedCodes.map((c) => [c, []]));
  for (const code of orderedCodes) {
    const allowConcurrent = Boolean(courses[code]?.prereq_logic?.allow_concurrent);
    for (const p of directPrereqCodes(code, codeSet)) {
      dependents.get(p)?.push({ to: code, cost: allowConcurrent ? 0 : 1 });
    }
    for (const c of directCoreqCodes(code, codeSet)) {
      dependents.get(c)?.push({ to: code, cost: 0 });
    }
  }
  const height = {};
  for (let i = orderedCodes.length - 1; i >= 0; i -= 1) {
    const code = orderedCodes[i];
    let h = 0;
    for (const { to, cost } of dependents.get(code) || []) {
      h = Math.max(h, (height[to] || 0) + cost);
    }
    height[code] = h;
  }
  return height;
}

// The order courses are offered to packIntoBins matters as much as the
// packer itself. Sorting by dependency depth alone lets low-stakes,
// prereq-free filler courses grab early-bin capacity purely because they
// happen to be processed first, starving the genuinely long chains that
// needed that room and forcing them (or their downstream courses) into
// overflow later than necessary. Real list scheduling instead always
// processes the most CRITICAL ready course next -- the one with the
// longest remaining chain still hanging off it (computeHeights) -- so long
// chains get first claim on capacity and short, flexible courses fill in
// whatever room is left.
function buildPackOrder(codes, codeSet) {
  const ordered = topoOrder(codes);
  const height = computeHeights(ordered, codeSet);
  const deps = new Map(codes.map((c) => [
    c,
    [...directPrereqCodes(c, codeSet), ...directCoreqCodes(c, codeSet)],
  ]));
  const remaining = new Set(codes);
  const placed = new Set();
  const order = [];

  while (remaining.size) {
    let candidates = [...remaining].filter((c) => deps.get(c).every((d) => placed.has(d)));
    if (!candidates.length) candidates = [...remaining]; // dependency cycle/gap -- just take what's left
    candidates.sort((a, b) => height[b] - height[a] || courseLevel(a) - courseLevel(b) || a.localeCompare(b));
    const next = candidates[0];
    order.push(next);
    placed.add(next);
    remaining.delete(next);
  }
  return order;
}

// Tried first: just the 8 regular semesters, no summers -- this is meant to
// read as "here's a clean 4-year example of what you could do." Some
// majors' real prerequisite chains run deeper than 8 sequential semesters
// can hold at <= MAX_CREDITS each (confirmed, not hypothetical -- Mechanical
// Engineering's closure needs 12), so PACK_BINS_WITH_SUMMER is the next
// fallback, used ONLY when the no-summer attempt can't fit without either
// breaking a credit cap or leaving a prerequisite unmet -- see
// generateDefaultPathway(). A few programs (dense, ABET-heavy engineering
// majors especially) are real enough in their credit load that even 8
// semesters plus every summer can't hold them at <= 18/semester and
// <= 12/summer -- PACK_BINS_WITH_FIFTH_YEAR is the last-resort fallback for
// those, reusing the app's own Fifth Year slots so the "example" stays an
// honest, fully-satisfied schedule rather than a 4-year one that quietly
// breaks a promise. Every course landing in any of these three arrays has
// every prerequisite/corequisite satisfied by construction (packed in true
// dependency order -- see buildPackOrder), so a freshly-generated pathway
// should always show zero red requisite-warning icons regardless of which
// tier it took.
const PACK_BINS_NO_SUMMER = ["reg-1", "reg-2", "reg-3", "reg-4", "reg-5", "reg-6", "reg-7", "reg-8"];
const PACK_BINS_WITH_SUMMER = [
  "reg-1", "reg-2", "summer-2", "reg-3", "reg-4", "summer-4",
  "reg-5", "reg-6", "summer-6", "reg-7", "reg-8", "summer-8",
];
const PACK_BINS_WITH_FIFTH_YEAR = [
  ...PACK_BINS_WITH_SUMMER, "reg-9", "reg-10", "summer-10",
];

function isSummerBinIdx(bins, i) {
  return bins[i]?.startsWith("summer");
}

// Regular semesters cap at MAX_CREDITS (18); summers are hard-capped at
// SUMMER_MAX_CREDITS (12) -- same rule enforced interactively in
// placeCourse(), applied here too so the auto-generated pathway can never
// show a summer over 12 either.
function binCapacity(bins, i) {
  return isSummerBinIdx(bins, i) ? SUMMER_MAX_CREDITS : MAX_CREDITS;
}

// Courses that MUST land in the same bin as `code` (not just "at or
// before" like a normal prerequisite): its real corequisites, plus any
// prerequisite specifically marked "credit or concurrent enrollment"
// (allow_concurrent) -- checkRequisites() accepts either being scheduled in
// the *same* semester as satisfying these, so packing has to actually
// place them together to make that true, not just imply it.
function concurrentGroupCodes(code, codeSet) {
  const info = courses[code];
  if (!info) return [];
  const group = new Set(directCoreqCodes(code, codeSet));
  if (info.prereq_logic?.allow_concurrent) {
    for (const c of directPrereqCodes(code, codeSet)) group.add(c);
  }
  return [...group];
}

// True first-fit bin-packing: each course (or concurrent group) goes into
// the EARLIEST bin at/after its own minBin that still has room, rather than
// a single cursor that only ever moves forward. A single forward cursor
// (the original design) could get pushed to the last bin by one genuinely
// deep chain and then never come back for later, shallower courses --
// dumping everything from that point on into whatever bin it got stuck at,
// with no cap ever stopping it once that bin happened to be a summer.
// First-fit also lets binCapacity() apply a real cap to summer bins (12,
// same as the interactive placeCourse() hard cap) instead of exempting
// them from any limit at all.
function packIntoBins(packOrder, codeSet, bins) {
  const result = {};
  const binOfCode = {};
  const binUsed = new Array(bins.length).fill(0);
  const placed = new Set();

  for (const code of packOrder) {
    if (placed.has(code)) continue; // already placed as part of an earlier course's concurrent group

    const group = [code];
    for (const c of concurrentGroupCodes(code, codeSet)) {
      if (!placed.has(c) && !group.includes(c)) group.push(c);
    }
    const groupSet = new Set(group);

    let minBin = 0;
    let groupCredits = 0;
    for (const groupCode of group) {
      groupCredits += courseCredits(groupCode);
      // "Credit or concurrent enrollment" prereqs only need to be at or
      // before this course's bin (same semester is fine), same as a real
      // corequisite -- NOT strictly earlier. Treating them as strict (+1)
      // needlessly inflates how many bins a dependency chain actually
      // requires, since it forces a fresh bin for every concurrent-allowed
      // hop even though nothing stops them from sharing one.
      const allowConcurrent = Boolean(courses[groupCode]?.prereq_logic?.allow_concurrent);
      for (const p of directPrereqCodes(groupCode, codeSet)) {
        if (groupSet.has(p)) continue; // satisfied by a fellow group member landing in the same bin
        const placedBin = binOfCode[p] ?? -1;
        minBin = Math.max(minBin, allowConcurrent ? Math.max(placedBin, 0) : placedBin + 1);
      }
    }
    // A real corequisite (not concurrent-allowed-prereq) only needs "at or
    // before," same as the original single-course logic -- relevant when
    // one member of the group has its own separate coreq that's already placed.
    for (const groupCode of group) {
      for (const c of directCoreqCodes(groupCode, codeSet)) {
        if (groupSet.has(c)) continue;
        minBin = Math.max(minBin, binOfCode[c] ?? 0);
      }
    }

    // Prefer the earliest REGULAR bin at/after minBin with room; summer is
    // true overflow, only used when no regular bin can take the group. If
    // nothing has room anywhere, the program's real requirements exceed
    // what four years (even with every summer) can hold -- clamp to the
    // last bin so the course still lands somewhere instead of vanishing.
    let chosen = -1;
    for (let i = minBin; i < bins.length; i += 1) {
      if (isSummerBinIdx(bins, i)) continue;
      if (binUsed[i] + groupCredits <= binCapacity(bins, i)) {
        chosen = i;
        break;
      }
    }
    if (chosen === -1) {
      for (let i = minBin; i < bins.length; i += 1) {
        if (!isSummerBinIdx(bins, i)) continue;
        if (binUsed[i] + groupCredits <= binCapacity(bins, i)) {
          chosen = i;
          break;
        }
      }
    }
    if (chosen === -1) chosen = bins.length - 1;

    const slotId = bins[chosen];
    for (const groupCode of group) {
      (result[slotId] ||= []).push(groupCode);
      binOfCode[groupCode] = chosen;
      placed.add(groupCode);
    }
    binUsed[chosen] += groupCredits;
  }
  return result;
}

function generateDefaultPathway(majorId, minorId, secondMajorId) {
  const baseCodes = [...new Set([
    ...collectDefaultCourses(majorId),
    ...(minorId ? collectDefaultCourses(minorId) : []),
    ...(secondMajorId ? collectDefaultCourses(secondMajorId) : []),
  ])];
  const codeSet = expandWithRequisites(baseCodes);
  const codes = [...codeSet];
  const packOrder = buildPackOrder(codes, codeSet);

  let result = packIntoBins(packOrder, codeSet, PACK_BINS_NO_SUMMER);
  let bins = PACK_BINS_NO_SUMMER;
  if (!pathwayIsValid(result, bins)) {
    // The no-summer attempt couldn't fit this program's real prerequisite
    // depth within 8 semesters, either busting a credit cap or (the subtler
    // failure -- no credit overflow at all, just two bin-8-bound courses
    // landing in the same last bin with nowhere further to push the later
    // one) leaving a prerequisite unmet. Falling back to summer overflow
    // rather than presenting an "example" that quietly breaks either promise.
    result = packIntoBins(packOrder, codeSet, PACK_BINS_WITH_SUMMER);
    bins = PACK_BINS_WITH_SUMMER;
  }
  let fifthYear = false;
  if (!pathwayIsValid(result, bins)) {
    // A handful of dense, ABET-heavy majors genuinely don't fit in 8
    // semesters plus every summer without breaking a cap or a prerequisite
    // -- true of their real credit load, not just an artifact of this
    // packer. Extending into a real Fifth Year (the app's own existing
    // slots) keeps the "example" honest: a longer schedule that actually
    // satisfies every requirement, rather than a 4-year one that doesn't.
    result = packIntoBins(packOrder, codeSet, PACK_BINS_WITH_FIFTH_YEAR);
    bins = PACK_BINS_WITH_FIFTH_YEAR;
    fifthYear = true;
  }

  const activeSummers = [];
  for (const slotId of Object.keys(result)) {
    const m = /^summer-(\d+)$/.exec(slotId);
    if (m) activeSummers.push(Number(m[1]));
  }

  return { courses: result, activeSummers: activeSummers.sort((a, b) => a - b), fifthYear };
}

// ---------------- prerequisite/corequisite validation ----------------

function evalLogic(node, isSatisfied) {
  if (!node) return true;
  if (node.op === "AND") return node.children.every((c) => evalLogic(c, isSatisfied));
  if (node.op === "OR") return node.children.some((c) => evalLogic(c, isSatisfied));
  if (node.course) return isSatisfied(node.course);
  return true; // unverifiable prose (classification, GPA, permission, ...) -- assume satisfied
}

// Used only by generateDefaultPathway() to decide whether its no-summer
// attempt actually worked, before committing to it -- the same logic
// checkRequisites() uses against the live schedule, run instead against a
// proposed { slotId: [codes] } packing and the true chronological order of
// `bins` (whichever PACK_BINS_* array was used), so a bad attempt can be
// discarded in favor of the summer-inclusive fallback rather than shown to
// the user as a broken "example."
// Same hard caps packIntoBins itself enforces (18/regular, 12/summer) --
// re-checked here as a belt-and-suspenders validity gate, since a proposed
// packing is only accepted if this AND pathwaySatisfiesRequisites both pass.
function pathwayFitsCapacity(result, bins) {
  return bins.every((slotId, idx) => {
    const credits = (result[slotId] || []).reduce((sum, c) => sum + courseCredits(c), 0);
    return credits <= binCapacity(bins, idx);
  });
}

function pathwayIsValid(result, bins) {
  return pathwayFitsCapacity(result, bins) && pathwaySatisfiesRequisites(result, bins);
}

function pathwaySatisfiesRequisites(result, bins) {
  const binOfCode = {};
  bins.forEach((slotId, idx) => {
    for (const code of result[slotId] || []) binOfCode[code] = idx;
  });

  for (const [slotId, codesInBin] of Object.entries(result)) {
    const idx = bins.indexOf(slotId);
    for (const code of codesInBin) {
      const info = courses[code];
      if (!info) continue;
      if (info.prereq_logic) {
        const maxAllowedIdx = info.prereq_logic.allow_concurrent ? idx : idx - 1;
        if (!evalLogic(info.prereq_logic.tree, (c) => (binOfCode[c] ?? Infinity) <= maxAllowedIdx)) return false;
      }
      if (info.coreq_logic && !evalLogic(info.coreq_logic.tree, (c) => (binOfCode[c] ?? Infinity) <= idx)) {
        return false;
      }
    }
  }
  return true;
}

function codesBeforeIndex(idx, order) {
  const set = new Set();
  for (let i = 0; i < idx; i++) {
    for (const c of schedule.courses[order[i]] || []) set.add(c);
  }
  return set;
}

function codesUpToIndex(idx, order) {
  return codesBeforeIndex(idx + 1, order);
}

// Checks whether `code` scheduled at position `idx` in `order` has its
// prerequisites/corequisites satisfied by what's scheduled earlier/alongside
// it. This is a best-effort check: free-text conditions we can't map to a
// specific course code (class standing, GPA, instructor permission, etc.)
// are always treated as met, since there's no data to verify them against.
function checkRequisites(code, idx, order) {
  const info = courses[code];
  if (!info) return { ok: true, problems: [] };

  const beforeSet = codesBeforeIndex(idx, order);
  const uptoSet = codesUpToIndex(idx, order);
  const problems = [];

  if (info.prereq_logic) {
    const satisfiedSet = info.prereq_logic.allow_concurrent ? uptoSet : beforeSet;
    if (!evalLogic(info.prereq_logic.tree, (c) => satisfiedSet.has(c))) {
      problems.push(`Prerequisite may not be met yet: ${info.prerequisites}`);
    }
  }
  if (info.coreq_logic) {
    if (!evalLogic(info.coreq_logic.tree, (c) => uptoSet.has(c))) {
      problems.push(`Corequisite may not be met: ${info.corequisites}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ---------------- rendering: requirements checklist ----------------

function groupRequirements(requirements) {
  const order = [];
  const byGroup = new Map();
  for (const req of requirements) {
    if (!byGroup.has(req.group_id)) {
      byGroup.set(req.group_id, []);
      order.push(req.group_id);
    }
    byGroup.get(req.group_id).push(req);
  }
  return order.map((gid) => byGroup.get(gid));
}

// ---------------- combined course codes ("CE 2710 & CE 2720") ----------------
//
// requirements.csv sometimes lists two co-listed real courses as one
// "X & Y"-style course_code string (a course plus its lab, or two courses
// that together count as one alternative). Treated as a single literal
// string that's not a real key in courses.json, that string had no
// credits/description/drag behavior of its own. This splits it back into
// its real, independent course codes -- each with its own correct credits.
function splitComboCode(code) {
  if (!code) return [];
  if (!code.includes("&")) return [code];
  const parts = code.split("&").map((s) => s.trim()).filter(Boolean);
  const result = [];
  let lastDept = null;
  for (const part of parts) {
    const m = /^([A-Za-z]+)\s+(.+)$/.exec(part);
    if (m) {
      lastDept = m[1].toUpperCase();
      result.push(`${lastDept} ${m[2].toUpperCase()}`);
    } else if (lastDept) {
      result.push(`${lastDept} ${part.toUpperCase()}`);
    } else {
      result.push(part.toUpperCase());
    }
  }
  return result;
}

// ---------------- rich hover tooltip ----------------

let hoverTooltipEl = null;

function ensureTooltipEl() {
  if (!hoverTooltipEl) {
    hoverTooltipEl = document.createElement("div");
    hoverTooltipEl.className = "course-tooltip";
    hoverTooltipEl.hidden = true;
    document.body.appendChild(hoverTooltipEl);
  }
  return hoverTooltipEl;
}

function courseTooltipHTML(code, extraLines) {
  const info = courses[code];
  if (!info) return `<div class="tooltip-code">${code}</div>`;
  const tags = extraInfoTags(info);
  let html = `<div class="tooltip-code"><span>${code}</span><span class="tooltip-credits">${info.credits} cr</span></div>`
    + `<div class="tooltip-desc">${info.description || "No description available."}</div>`
    + `<div class="tooltip-row"><strong>Prerequisites:</strong> ${info.prerequisites || "None"}</div>`
    + `<div class="tooltip-row"><strong>Corequisites:</strong> ${info.corequisites || "None"}</div>`;
  if (tags.length) html += `<div class="tooltip-row"><strong>Tags:</strong> ${tags.join(", ")}</div>`;
  for (const line of extraLines || []) html += `<div class="tooltip-warning">${line}</div>`;
  return html;
}

function positionTooltip(tip, e) {
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const rect = tip.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = e.clientY - rect.height - pad;
  tip.style.left = `${Math.max(0, x)}px`;
  tip.style.top = `${Math.max(0, y)}px`;
}

function attachCourseTooltip(el, code, extraLinesFn) {
  el.addEventListener("mouseenter", (e) => {
    const tip = ensureTooltipEl();
    tip.innerHTML = courseTooltipHTML(code, extraLinesFn ? extraLinesFn() : []);
    tip.hidden = false;
    positionTooltip(tip, e);
  });
  el.addEventListener("mousemove", (e) => {
    if (hoverTooltipEl && !hoverTooltipEl.hidden) positionTooltip(hoverTooltipEl, e);
  });
  el.addEventListener("mouseleave", () => {
    if (hoverTooltipEl) hoverTooltipEl.hidden = true;
  });
}

// Shows the same info as attachCourseTooltip()'s hover tooltip, but in a
// modal -- used by the tap-friendly info-icon buttons added to available
// chips/search rows below, since a hover-only tooltip has no touch
// equivalent (renderPlacedChip()'s Description/Pre-Co-reqs buttons already
// give scheduled courses a tap-friendly path, so this modal is only wired
// up for the two not-yet-scheduled surfaces).
function showCourseInfoModal(code, extraLines) {
  document.getElementById("course-info-modal-title").textContent = code;
  document.getElementById("course-info-modal-body").innerHTML = courseTooltipHTML(code, extraLines || []);
  document.getElementById("course-info-modal").hidden = false;
}

function selectCourseForPlacement(code) {
  selectedCourseCode = selectedCourseCode === code ? null : code;
  document.body.classList.toggle("tap-place-active", !!selectedCourseCode);
  const hint = document.getElementById("tap-place-hint");
  hint.hidden = !selectedCourseCode;
  if (selectedCourseCode) hint.textContent = `${selectedCourseCode} selected -- tap a semester to add it`;
  renderAll();
}

function clearPlacementSelection() {
  selectedCourseCode = null;
  document.body.classList.remove("tap-place-active");
  document.getElementById("tap-place-hint").hidden = true;
}

function renderAvailableChip(code) {
  const scheduledSlot = findScheduledSlot(code);
  const span = document.createElement("span");
  span.className = "course-chip";

  const label = document.createElement("span");
  label.textContent = code;
  span.appendChild(label);

  if (scheduledSlot) {
    span.classList.add("scheduled");
  } else {
    span.draggable = true;
    span.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", code);
      e.dataTransfer.effectAllowed = "copyMove";
    });
    if (code === selectedCourseCode) span.classList.add("selected-for-place");
    span.addEventListener("click", () => selectCourseForPlacement(code));

    const infoBtn = document.createElement("button");
    infoBtn.type = "button";
    infoBtn.className = "info-icon-btn";
    infoBtn.textContent = "ⓘ";
    infoBtn.title = `${code} description and prerequisites`;
    infoBtn.setAttribute("aria-label", `${code} details`);
    infoBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showCourseInfoModal(code);
    });
    span.appendChild(infoBtn);
  }
  attachCourseTooltip(span, code, () => (scheduledSlot ? [`Already scheduled in ${slotMeta(scheduledSlot).label}`] : []));
  return span;
}

function renderComboChips(comboCode) {
  const wrap = document.createElement("span");
  wrap.className = "combo-chips";
  splitComboCode(comboCode).forEach((code, i) => {
    if (i > 0) {
      const amp = document.createElement("span");
      amp.className = "combo-amp";
      amp.textContent = "&";
      wrap.appendChild(amp);
    }
    wrap.appendChild(renderAvailableChip(code));
  });
  return wrap;
}

function renderCategoryBucket(label, codes) {
  if (!codes.length) return null;
  const bucket = document.createElement("div");
  bucket.className = "category-bucket";
  const h = document.createElement("h4");
  h.textContent = `${label} (${codes.length})`;
  bucket.appendChild(h);

  const list = document.createElement("div");
  list.className = "category-course-list";
  const shown = codes.slice(0, CATEGORY_DISPLAY_CAP);
  for (const c of shown) list.appendChild(renderAvailableChip(c));
  bucket.appendChild(list);

  if (codes.length > shown.length) {
    const more = document.createElement("p");
    more.className = "typeahead-hint";
    more.textContent = `+${codes.length - shown.length} more -- use search to find a specific one.`;
    bucket.appendChild(more);
  }
  return bucket;
}

function renderCategoryExpander(kind, label, program, targetCredits, key, liveCredits) {
  const wrap = document.createElement("div");
  const expanded = expandedCategories.has(key);
  const target = parseFloat(targetCredits) || 0;
  const complete = target > 0 && liveCredits >= target;

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "category-toggle";
  toggleBtn.innerHTML = `<span class="category-note">${expanded ? "▾" : "▸"} ${label}</span>`
    + `<span class="credits-pill${complete ? " complete" : ""}">${liveCredits} / ${targetCredits || "?"} cr</span>`;
  toggleBtn.addEventListener("click", () => {
    if (expanded) expandedCategories.delete(key);
    else expandedCategories.add(key);
    renderAll();
  });
  wrap.appendChild(toggleBtn);

  if (expanded) {
    const eligible = eligibleCoursesForCategory(kind, program);
    const panel = document.createElement("div");
    panel.className = "category-options";

    if (kind === "tech" || kind === "humanities" || kind === "social_science") {
      const bucket = renderCategoryBucket(categoryLabel(kind), eligible);
      panel.appendChild(bucket || Object.assign(document.createElement("p"), {
        className: "typeahead-hint",
        textContent: "Couldn't infer an eligible course list for this program.",
      }));
    } else {
      const { humanities, socialScience, other } = splitByGenEdCategory(eligible);
      const halves = document.createElement("div");
      halves.className = "category-halves";
      const hBucket = renderCategoryBucket("Humanities", humanities);
      const sBucket = renderCategoryBucket("Social Science", socialScience);
      if (hBucket) halves.appendChild(hBucket);
      if (sBucket) halves.appendChild(sBucket);
      panel.appendChild(halves);
      const oBucket = renderCategoryBucket("Other", other);
      if (oBucket) panel.appendChild(oBucket);
    }
    wrap.appendChild(panel);
  }
  return wrap;
}

function renderGroup(group, program) {
  const li = document.createElement("li");

  if (group.length === 1 && !group[0].course_code) {
    const req = group[0];
    const target = req.group_target_credits || req.credits || extractCreditsFromNote(req.note) || "?";
    const kind = categoryKind(req.note);

    if (!kind) {
      // No recognized category (not IP/USC/Tech Elective) means no eligible-course
      // list exists to check against, so there's no way to compute a live count here --
      // shown as "? / target" rather than a live number so it doesn't look like a bug.
      li.innerHTML = `<span class="category-note">${req.note || "Elective"}</span> `
        + `<span class="credits-pill" title="Can't verify this one automatically -- no specific course list is available for it.">? / ${target} cr</span>`;
      return li;
    }

    const key = `${program.name}|${req.group_id}|${req.note}`;
    const liveCredits = categoryScheduledCredits(kind, program, allScheduledCodes());
    li.appendChild(renderCategoryExpander(kind, req.note || categoryLabel(kind), program, target, key, liveCredits));
    return li;
  }

  if (group.length === 1) {
    const req = group[0];
    li.appendChild(renderComboChips(req.course_code));
    return li;
  }

  const label = document.createElement("span");
  label.className = "choice-label";
  const target = group[0].group_target_credits || group[0].credits || "?";
  const note = group.find((r) => r.note)?.note;
  label.textContent = note ? `${note} (${target} cr)` : `Choose one (${target} cr):`;
  li.appendChild(label);

  const options = document.createElement("div");
  options.className = "choice-options";
  for (const req of group) {
    if (!req.course_code) continue;
    options.appendChild(renderComboChips(req.course_code));
  }
  li.appendChild(options);
  return li;
}

function renderSection(section, program) {
  const card = document.createElement("div");
  const fulfilled = isSectionFulfilled(section, program);
  card.className = "section-card" + (fulfilled ? " fulfilled" : "");

  const wholeKind = wholeSectionCategoryKind(section);

  const heading = document.createElement("h3");
  const check = fulfilled ? '<span class="fulfilled-check" title="This section\'s requirements are met by your scheduled courses">✓ </span>' : "";
  const liveCredits = sectionFulfilledCredits(section, program);
  const pillClass = "credits-pill" + (fulfilled ? " complete" : "");
  heading.innerHTML = `<span>${check}${section.name}</span>`
    + (wholeKind ? "" : `<span class="${pillClass}">${liveCredits} / ${section.credits_required || "?"} cr</span>`);
  card.appendChild(heading);

  if (wholeKind) {
    const key = `${program.name}|section|${section.name}`;
    card.appendChild(renderCategoryExpander(wholeKind, categoryLabel(wholeKind), program, section.credits_required, key, sectionFulfilledCredits(section, program)));
    return card;
  }

  const list = document.createElement("ul");
  list.className = "requirement-list";
  for (const group of groupRequirements(section.requirements)) {
    list.appendChild(renderGroup(group, program));
  }
  card.appendChild(list);
  return card;
}

// Wraps a scraped program/course name in a discreet inline link to its
// official ISU catalog page -- styled to read as plain text (see
// .program-link in style.css) rather than a glaring "view source" button,
// per how this was asked for. escapeHtml() both here and on plain (no-link)
// names, since these are scraped free text, not something this project
// controls the contents of.
function programNameHtml(name, url) {
  const safeName = escapeHtml(name);
  return url ? `<a class="program-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${safeName}</a>` : safeName;
}

function renderProgram(program) {
  const wrap = document.createElement("div");

  const summary = document.createElement("div");
  const complete = isProgramComplete(program);
  summary.className = "program-summary" + (complete ? " complete" : "");
  const flag = program.credits_flag
    ? `<span class="flag-badge" title="This program's total credits look outside the typical range -- worth double-checking against the official catalog.">${program.credits_flag}</span>`
    : "";
  const liveTotal = programFulfilledCredits(program);
  const gpa = cumulativeGPA();
  const gpaHtml = gpa !== null ? ` &middot; <span class="meta-gpa">GPA ${gpa.toFixed(2)}</span>` : "";
  summary.innerHTML = `<h2>${programNameHtml(program.name, program.url)}${flag}</h2>`
    + `<div class="meta">${escapeHtml(program.college)} &middot; <span class="meta-credits">${liveTotal} / ${program.total_credits || "?"} total credits</span>${gpaHtml}</div>`;
  wrap.appendChild(summary);

  const sectionsWrap = document.createElement("div");
  sectionsWrap.className = "section-columns";
  for (const section of program.sections) {
    sectionsWrap.appendChild(renderSection(section, program));
  }
  wrap.appendChild(sectionsWrap);
  return wrap;
}

// Masters programs have no sections/requirements to check off (see
// build_masters()'s docstring) -- just a name, degree types, a link, and a
// live credit count against ISU's uniform 30-credit Graduate College minimum.
function gradCreditsScheduled() {
  let total = 0;
  for (const [slotId, codes] of Object.entries(schedule.courses)) {
    if (!slotId.startsWith("grad-")) continue;
    total += codes.reduce((sum, c) => sum + courseCredits(c), 0);
  }
  return total;
}

function renderMastersProgram(program) {
  const wrap = document.createElement("div");
  const summary = document.createElement("div");
  const target = parseFloat(program.total_credits) || 0;
  const liveCredits = gradCreditsScheduled();
  const complete = target > 0 && liveCredits >= target;
  summary.className = "program-summary" + (complete ? " complete" : "");
  const badge = `<span class="flag-badge masters-badge" title="ISU's Graduate College sets one uniform minimum (30 credits, at least 22 from ISU) for every Master's program -- there's no structured, per-program requirements page to check specific courses against, since ISU doesn't publish one for graduate programs (unlike undergraduate majors/minors).">Masters</span>`;
  summary.innerHTML = `<h2>${programNameHtml(program.name, program.url)}${badge}</h2>`
    + `<div class="meta">${escapeHtml(program.degrees)} &middot; <span class="meta-credits">${liveCredits} / ${target} graduate credits (ISU minimum)</span></div>`;
  wrap.appendChild(summary);
  return wrap;
}

function renderResults() {
  const { major, masters } = programSelectIds();
  const results = document.getElementById("results");
  results.innerHTML = "";

  if (!major) return;

  const hint = document.createElement("p");
  hint.className = "results-hint";
  hint.textContent = "Drag any course below into a semester on the left.";
  results.appendChild(hint);

  for (const program of selectedPrograms()) {
    results.appendChild(renderProgram(program));
  }
  if (masters && mastersPrograms[masters]) {
    results.appendChild(renderMastersProgram(mastersPrograms[masters]));
  }
}

// ---------------- rendering: search ----------------

function matchesQuery(code, info, q) {
  if (code.toLowerCase().includes(q)) return true;
  const dept = code.split(" ")[0].toLowerCase();
  if (dept === q || dept.startsWith(q)) return true;
  // Skip substring matching against free text for very short queries (e.g. "ip") --
  // it mostly just picks up unrelated words that happen to contain those letters.
  // Aliases (see SEARCH_ALIASES) still expand short codes to their full phrase below.
  if (q.length < 3) return false;
  if (info?.description?.toLowerCase().includes(q)) return true;
  const notes = requirementNotesByCode[code];
  if (notes) {
    for (const note of notes) {
      if (note.toLowerCase().includes(q)) return true;
    }
  }
  return false;
}

function runSearch(query) {
  const container = document.getElementById("search-results");
  const hint = document.getElementById("search-hint");
  const resultsPanel = document.getElementById("results");
  const q = query.trim().toLowerCase();

  if (!q) {
    container.innerHTML = "";
    resultsPanel.hidden = false;
    hint.textContent = "Search matches course codes, departments/descriptions, and requirement "
      + "categories that list specific courses -- broad gen-ed tags without an enumerated course "
      + "list on the catalog page (e.g. some International Perspectives entries) may not surface here.";
    return;
  }
  resultsPanel.hidden = true;
  hint.textContent = "";

  const queries = new Set([q]);
  if (SEARCH_ALIASES[q]) queries.add(SEARCH_ALIASES[q]);

  const matches = [];
  for (const [code, info] of Object.entries(courses)) {
    for (const term of queries) {
      if (matchesQuery(code, info, term)) {
        matches.push(code);
        break;
      }
    }
    if (matches.length >= SEARCH_MATCH_CAP) break;
  }

  container.innerHTML = "";
  const heading = document.createElement("p");
  heading.className = "search-results-heading";
  heading.textContent = matches.length
    ? `${matches.length}${matches.length >= SEARCH_MATCH_CAP ? "+" : ""} course${matches.length === 1 ? "" : "s"} match -- drag a row into a semester:`
    : "No courses match that search.";
  container.appendChild(heading);

  if (matches.length) container.appendChild(renderSearchTable(matches));
}

function extraInfoTags(info) {
  const tags = [];
  if (info?.gen_ed_tags?.includes("international_perspectives")) tags.push("International Perspectives");
  if (info?.gen_ed_tags?.includes("us_cultures")) tags.push("U.S. Cultures");
  if (info?.gen_ed_category === "humanities") tags.push("Humanities");
  if (info?.gen_ed_category === "social_science") tags.push("Social Science");
  return tags;
}

function renderSearchTable(codes) {
  const wrap = document.createElement("div");
  wrap.className = "search-table-wrap";

  const table = document.createElement("table");
  table.className = "search-table";
  table.innerHTML = "<thead><tr>"
    + "<th>Class Code</th><th>Description</th><th>Prerequisites</th><th>Extra Info</th><th>Credits</th>"
    + "</tr></thead>";

  const tbody = document.createElement("tbody");
  for (const code of codes) {
    const info = courses[code];
    const scheduledSlot = findScheduledSlot(code);

    const tr = document.createElement("tr");
    tr.className = "search-row" + (scheduledSlot ? " scheduled" : "");
    if (!scheduledSlot) {
      tr.draggable = true;
      tr.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", code);
        e.dataTransfer.effectAllowed = "copyMove";
      });
      if (code === selectedCourseCode) tr.classList.add("selected-for-place");
      tr.addEventListener("click", () => selectCourseForPlacement(code));
    }
    attachCourseTooltip(tr, code, () => (scheduledSlot ? [`Already scheduled in ${slotMeta(scheduledSlot).label}`] : []));

    const codeTd = document.createElement("td");
    codeTd.className = "search-cell-code";
    const codeWrap = document.createElement("span");
    codeWrap.className = "search-code-wrap";
    const codeLabel = document.createElement("span");
    codeLabel.textContent = scheduledSlot ? `✓ ${code}` : code;
    codeWrap.appendChild(codeLabel);
    if (!scheduledSlot) {
      const infoBtn = document.createElement("button");
      infoBtn.type = "button";
      infoBtn.className = "info-icon-btn";
      infoBtn.textContent = "ⓘ";
      infoBtn.title = `${code} description and prerequisites`;
      infoBtn.setAttribute("aria-label", `${code} details`);
      infoBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showCourseInfoModal(code);
      });
      codeWrap.appendChild(infoBtn);
    }
    codeTd.appendChild(codeWrap);
    tr.appendChild(codeTd);

    const cells = [
      info?.description || "",
      info?.prerequisites || "None",
      extraInfoTags(info).join(", ") || "--",
      info ? `${info.credits} cr` : "",
    ];
    const classes = ["search-cell-desc", "search-cell-prereq", "search-cell-tags", "search-cell-credits"];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.className = classes[i];
      td.textContent = text;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// ---------------- rendering: semester column ----------------

function wireDropTarget(el, slotId) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("drag-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    const code = e.dataTransfer.getData("text/plain");
    if (code) placeCourse(code, slotId);
  });
  // Tap-to-place's other half -- see selectCourseForPlacement(). A tap
  // anywhere in this semester's course list (including on an existing
  // placed chip's non-button area) places whatever's currently selected.
  el.addEventListener("click", () => {
    if (!selectedCourseCode) return;
    const code = selectedCourseCode;
    clearPlacementSelection();
    placeCourse(code, slotId);
  });
}

function renderGradePicker(container, code) {
  const current = schedule.grades[code];

  function makeOptionButton(mark) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "grade-option-btn" + (mark === current ? " active" : "");
    btn.textContent = mark;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setGrade(code, mark);
    });
    return btn;
  }

  const wrap = document.createElement("div");
  wrap.className = "grade-picker";
  for (const grade of GRADE_ORDER) wrap.appendChild(makeOptionButton(grade));
  container.appendChild(wrap);

  // Pass/Not Pass -- a separate row since these are marks, not letter
  // grades, and (per setGrade/gpaForCodes) never factor into GPA.
  const passWrap = document.createElement("div");
  passWrap.className = "grade-picker grade-picker-pass";
  for (const mark of PASS_MARKS) passWrap.appendChild(makeOptionButton(mark));
  container.appendChild(passWrap);

  if (current) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "grade-clear-btn";
    clearBtn.textContent = "Clear grade";
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setGrade(code, null);
    });
    container.appendChild(clearBtn);
  }
}

function renderPlacedChip(code, slotId, idx, order) {
  const li = document.createElement("li");
  li.className = "course-row";
  li.draggable = true;
  const check = checkRequisites(code, idx, order);
  if (!check.ok) li.classList.add("requisite-warning");

  const info = courses[code];

  const main = document.createElement("div");
  main.className = "course-row-main";

  const codeEl = document.createElement("span");
  codeEl.className = "chip-code";
  codeEl.textContent = code;
  main.appendChild(codeEl);

  const detail = document.createElement("div");
  detail.className = "course-row-detail";
  detail.hidden = true;

  function toggleDetail(mode, render) {
    if (!detail.hidden && detail.dataset.mode === mode) {
      detail.hidden = true;
      return;
    }
    detail.dataset.mode = mode;
    detail.innerHTML = "";
    render(detail);
    detail.hidden = false;
  }

  const descBtn = document.createElement("button");
  descBtn.type = "button";
  descBtn.className = "row-info-btn";
  descBtn.textContent = "Description";
  descBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDetail("description", (el) => {
      el.textContent = info?.description || "No description available.";
    });
  });
  main.appendChild(descBtn);

  const reqBtn = document.createElement("button");
  reqBtn.type = "button";
  reqBtn.className = "row-info-btn";
  reqBtn.textContent = "Pre/Co-reqs";
  reqBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const preText = `Prerequisites: ${info?.prerequisites || "none listed"}`;
    const coText = `Corequisites: ${info?.corequisites || "none listed"}`;
    const warnText = check.ok ? "" : `\n\n⚠ ${check.problems.join("\n")}`;
    toggleDetail("reqs", (el) => {
      el.textContent = `${preText}\n${coText}${warnText}`;
    });
  });
  main.appendChild(reqBtn);

  const gradeBtn = document.createElement("button");
  gradeBtn.type = "button";
  gradeBtn.className = "row-info-btn";
  gradeBtn.textContent = schedule.grades[code] ? `Grade: ${schedule.grades[code]}` : "Add Grade";
  gradeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDetail("grade", (el) => renderGradePicker(el, code));
  });
  main.appendChild(gradeBtn);

  if (!check.ok) {
    const warnIcon = document.createElement("span");
    warnIcon.className = "row-warning-icon";
    warnIcon.textContent = "⚠";
    warnIcon.title = check.problems.join("\n");
    main.appendChild(warnIcon);
  }

  const creditsEl = document.createElement("span");
  creditsEl.className = "chip-credits";
  creditsEl.textContent = info ? `${info.credits} cr` : "";
  main.appendChild(creditsEl);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "chip-remove";
  removeBtn.textContent = "×";
  removeBtn.title = "Remove from schedule";
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    removeCourse(code);
  });
  main.appendChild(removeBtn);

  li.appendChild(main);
  li.appendChild(detail);

  attachCourseTooltip(codeEl, code, () => (check.ok ? [] : check.problems));

  li.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", code);
    e.dataTransfer.effectAllowed = "move";
  });
  li.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    li.classList.add("drop-before");
  });
  li.addEventListener("dragleave", () => li.classList.remove("drop-before"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    li.classList.remove("drop-before");
    const dragged = e.dataTransfer.getData("text/plain");
    if (dragged && dragged !== code) placeCourse(dragged, slotId, code);
  });

  return li;
}

function renderSemesterCard(slotId, idx, order) {
  const meta = slotMeta(slotId);
  const codes = schedule.courses[slotId] || [];
  const credits = codes.reduce((sum, c) => sum + courseCredits(c), 0);

  const card = document.createElement("div");
  card.className = `semester-card kind-${meta.kind}`;

  const head = document.createElement("div");
  head.className = "semester-head";

  const title = document.createElement("h3");
  title.textContent = meta.label;
  head.appendChild(title);

  const gpa = semesterGPA(slotId);
  if (gpa !== null) {
    const gpaEl = document.createElement("span");
    gpaEl.className = "semester-gpa";
    gpaEl.textContent = `GPA ${gpa.toFixed(2)}`;
    head.appendChild(gpaEl);
  }

  const creditEl = document.createElement("span");
  creditEl.className = "semester-credits";
  let statusText = `${credits} cr`;
  if (meta.kind === "regular") {
    const max = schedule.honors ? HONORS_MAX_CREDITS : MAX_CREDITS;
    if (credits === 0) {
      creditEl.classList.add("neutral");
    } else if (credits < MIN_CREDITS) {
      creditEl.classList.add("warn");
      statusText = `${credits} cr -- under full-time (need ${MIN_CREDITS})`;
    } else if (credits > max) {
      creditEl.classList.add("warn");
      statusText = `${credits} cr -- over the ${max} max`;
    } else {
      creditEl.classList.add("ok");
    }
  } else if (meta.kind === "summer") {
    // Hard-capped at placeCourse() -- this can never actually exceed
    // SUMMER_MAX_CREDITS, so there's no "warn" state to show here, just
    // the cap itself so it's clear why a drop got rejected.
    creditEl.classList.add(credits > 0 ? "ok" : "neutral");
    statusText = `${credits} / ${SUMMER_MAX_CREDITS} cr`;
  } else {
    creditEl.classList.add("neutral");
  }
  creditEl.textContent = statusText;
  head.appendChild(creditEl);

  // Clears just this semester's courses -- distinct from "Remove
  // Summer"/"Remove Fifth Year" below, which remove the semester SLOT
  // itself (and, for Fifth Year, its paired semester + summer too). Reuses
  // the same clearSlot() helper those already call. Only shown once there's
  // actually something in the semester to clear.
  if (codes.length) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "clear-semester-btn";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => {
      if (!confirm(`Clear ${meta.label}? Its ${codes.length} course(s) will be taken off your schedule.`)) return;
      clearSlot(slotId);
      saveSchedule();
      renderAll();
    });
    head.appendChild(clearBtn);
  }

  if (meta.kind === "summer") {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-summer-btn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      if (codes.length && !confirm(`Remove ${meta.label}? Its ${codes.length} course(s) will be taken off your schedule.`)) {
        return;
      }
      schedule.activeSummers = schedule.activeSummers.filter((a) => a !== meta.anchor);
      clearSlot(slotId);
      saveSchedule();
      renderAll();
    });
    head.appendChild(removeBtn);
  }

  // Fifth Year is toggled as a whole (both its semesters at once), so the
  // "Remove" affordance lives only on the first of the two -- shown here
  // rather than next to the "+ Add Fifth Year" button so it's right next
  // to the semesters it would remove.
  if (slotId === "reg-9") {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-summer-btn";
    removeBtn.textContent = "Remove Fifth Year";
    removeBtn.addEventListener("click", () => {
      const fifthYearCourses = [...(schedule.courses["reg-9"] || []), ...(schedule.courses["reg-10"] || [])];
      if (fifthYearCourses.length
        && !confirm(`Remove your Fifth Year? Its ${fifthYearCourses.length} course(s) will be taken off your schedule.`)) {
        return;
      }
      schedule.activeSummers = schedule.activeSummers.filter((a) => a !== 10);
      clearSlot("reg-9");
      clearSlot("reg-10");
      clearSlot("summer-10");
      schedule.fifthYear = false;
      saveSchedule();
      renderAll();
    });
    head.appendChild(removeBtn);
  }

  card.appendChild(head);

  const list = document.createElement("ul");
  list.className = "semester-course-list";
  if (codes.length === 0) {
    list.classList.add("empty");
    const empty = document.createElement("li");
    empty.className = "semester-empty";
    empty.textContent = "Drop courses here";
    list.appendChild(empty);
  } else {
    for (const code of codes) list.appendChild(renderPlacedChip(code, slotId, idx, order));
  }
  card.appendChild(list);
  wireDropTarget(list, slotId);

  return card;
}

function renderAddSummerButton(anchor) {
  const wrap = document.createElement("div");
  wrap.className = "add-summer-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "add-summer-btn";
  btn.textContent = "+ Add Summer Semester";
  btn.addEventListener("click", () => {
    schedule.activeSummers = [...new Set([...schedule.activeSummers, anchor])].sort((a, b) => a - b);
    saveSchedule();
    renderAll();
  });
  wrap.appendChild(btn);
  return wrap;
}

function renderAddFifthYearButton() {
  const wrap = document.createElement("div");
  wrap.className = "add-summer-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "add-summer-btn";
  btn.textContent = "+ Add Fifth Year";
  btn.addEventListener("click", () => {
    schedule.fifthYear = true;
    saveSchedule();
    renderAll();
  });
  wrap.appendChild(btn);
  return wrap;
}

function renderSemesterColumn() {
  const col = document.getElementById("semester-list");
  col.innerHTML = "";
  const order = buildSlotOrder();
  let addedFifthYearButton = false;

  order.forEach((slotId, idx) => {
    // The Fifth Year button belongs right after the undergrad semesters
    // and before any Masters semesters -- not at the very bottom of the
    // whole column, which would read as "after grad school."
    if (slotId.startsWith("grad-") && !schedule.fifthYear && !addedFifthYearButton) {
      col.appendChild(renderAddFifthYearButton());
      addedFifthYearButton = true;
    }
    col.appendChild(renderSemesterCard(slotId, idx, order));
    const anchor = slotAnchorAfter(slotId);
    if (anchor && !schedule.activeSummers.includes(anchor)) {
      col.appendChild(renderAddSummerButton(anchor));
    }
  });

  if (!schedule.fifthYear && !addedFifthYearButton) col.appendChild(renderAddFifthYearButton());
}

// ---------------- export schedule (CSV / Excel) ----------------

// Maps each course code to the full section name(s) of `program` it counts
// toward, so the export can show a running per-section tally alongside the
// semester-by-semester course list -- using real section names (not
// abbreviations) so it's unambiguous which requirement each column is.
// Category sections (IP/USC/Tech Electives/Humanities/Social Science) count
// any of their eligible courses, not just one.
function buildCourseSectionMap(program) {
  const map = new Map();
  const addMapping = (code, sectionName) => {
    if (!map.has(code)) map.set(code, new Set());
    map.get(code).add(sectionName);
  };
  for (const section of program.sections) {
    const wholeKind = wholeSectionCategoryKind(section);
    if (wholeKind) {
      for (const code of eligibleCoursesForCategory(wholeKind, program)) addMapping(code, section.name);
      continue;
    }
    for (const group of groupRequirements(section.requirements)) {
      if (group.length === 1 && !group[0].course_code) {
        const kind = categoryKind(group[0].note);
        if (kind) {
          for (const code of eligibleCoursesForCategory(kind, program)) addMapping(code, section.name);
        }
      } else {
        for (const req of group) {
          if (!req.course_code) continue;
          for (const code of splitComboCode(req.course_code)) addMapping(code, section.name);
        }
      }
    }
  }
  return map;
}

function buildExportData() {
  const sectionColumns = [];
  const perProgramMaps = [];
  selectedProgramsWithRoles().forEach(({ program: p, prefix }) => {
    perProgramMaps.push({ prefix, map: buildCourseSectionMap(p) });
    for (const section of p.sections) {
      sectionColumns.push({ name: prefix + section.name, target: parseFloat(section.credits_required) || 0 });
    }
  });

  function codeCreditsBySection(code) {
    const result = {};
    const cr = courseCredits(code);
    for (const { prefix, map } of perProgramMaps) {
      const set = map.get(code);
      if (!set) continue;
      for (const sectionName of set) result[prefix + sectionName] = cr;
    }
    return result;
  }

  const order = buildSlotOrder();
  const cumulative = {};
  sectionColumns.forEach((c) => { cumulative[c.name] = 0; });

  const groups = [];
  order.forEach((slotId, idx) => {
    const codes = schedule.courses[slotId] || [];
    if (!codes.length) return; // skip empty semesters in the export
    const rows = codes.map((code) => {
      const info = courses[code] || {};
      const check = checkRequisites(code, idx, order);
      const bySection = codeCreditsBySection(code);
      for (const sectionName in bySection) cumulative[sectionName] += bySection[sectionName];
      return {
        code,
        description: info.description || "",
        prerequisites: info.prerequisites || "None",
        corequisites: info.corequisites || "None",
        requisitesMet: check.ok ? "Y" : "N",
        credits: info.credits || "",
        grade: schedule.grades[code] || "",
        bySection,
      };
    });
    const creditTotal = codes.reduce((sum, c) => sum + courseCredits(c), 0);
    groups.push({ label: slotMeta(slotId).label, rows, creditTotal, gpa: semesterGPA(slotId), cumulativeSnapshot: { ...cumulative } });
  });

  return { sectionColumns, groups, cumulativeGpa: cumulativeGPA() };
}

function sanitizeFilenamePart(s) {
  return (s || "").replace(/[\\/:*?"<>|,]/g, "").replace(/\s+/g, " ").trim();
}

function buildExportFilename(ext) {
  const name = sanitizeFilenamePart(document.getElementById("export-name-input").value) || "Student";
  const { major, secondMajor, minor } = programSelectIds();
  const parts = [name, sanitizeFilenamePart(programs[major]?.name) || "Major"];
  if (secondMajor) parts.push(sanitizeFilenamePart(programs[secondMajor]?.name));
  if (minor) parts.push(sanitizeFilenamePart(programs[minor]?.name));
  parts.push("ISUClassSchedule");
  return `${parts.join("-")}.${ext}`;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// "Grade" is a per-course column (like Credits); "GPA" is its own column to
// the right of that, used only in the per-semester summary row and the
// bottom-of-sheet cumulative row -- never on individual course rows, the
// same way "Credit hours:" itself only ever appears in that summary row.
// Section columns are appended after both, so LEFT_COLUMN_COUNT (not just
// EXPORT_HEADERS.length) is what everything else must pad/align against.
const EXPORT_HEADERS = ["Class", "Description", "Prerequisites", "Corequisites", "Requisites Met", "Credits", "Grade"];
const LEFT_COLUMN_COUNT = EXPORT_HEADERS.length + 1; // +1 for the GPA column
const GRADE_COLUMN_INDEX = EXPORT_HEADERS.indexOf("Grade");

function formatGpaCell(gpa) {
  return gpa !== null && gpa !== undefined ? gpa.toFixed(2) : "";
}

function exportAsCSV(data, filename) {
  const { sectionColumns, groups, cumulativeGpa } = data;
  const blankLeft = Array(LEFT_COLUMN_COUNT).fill("");
  const lines = [];

  lines.push([...blankLeft, ...sectionColumns.map((c) => c.name)].map(csvEscape).join(","));
  lines.push([...blankLeft, ...sectionColumns.map((c) => c.target)].map(csvEscape).join(","));
  lines.push("");

  for (const group of groups) {
    lines.push(csvEscape(group.label));
    lines.push([...EXPORT_HEADERS, "GPA"].map(csvEscape).join(","));
    for (const r of group.rows) {
      const sectionVals = sectionColumns.map((c) => r.bySection[c.name] || 0);
      lines.push([r.code, r.description, r.prerequisites, r.corequisites, r.requisitesMet, r.credits, r.grade, "", ...sectionVals].map(csvEscape).join(","));
    }
    const cumVals = sectionColumns.map((c) => group.cumulativeSnapshot[c.name] || 0);
    lines.push(["", "", "", "", "Credit hours:", group.creditTotal, "GPA:", formatGpaCell(group.gpa), ...cumVals].map(csvEscape).join(","));
    lines.push("");
  }

  lines.push(["", "", "", "", "", "", "Cumulative GPA:", formatGpaCell(cumulativeGpa)].map(csvEscape).join(","));
  downloadFile(lines.join("\n"), filename, "text/csv");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

const EXPORT_HEADER_COLORS = ["#fecaca", "#fef08a", "#bbf7d0", "#fde68a", "#bfdbfe", "#a5f3fc", "#ddd6fe", "#fbcfe8"];

// Excel opens an HTML <table> saved with a .xls extension just fine (a
// long-standing, widely used trick) -- no library or network fetch needed
// to produce a real spreadsheet file from a static site.
function exportAsExcel(data, filename) {
  const { sectionColumns, groups, cumulativeGpa } = data;
  const totalCols = LEFT_COLUMN_COUNT + sectionColumns.length;
  const blankLeftCells = "<td></td>".repeat(LEFT_COLUMN_COUNT);

  let html = "<table border=\"1\">";
  html += `<tr>${blankLeftCells}${sectionColumns.map((c, i) => `<th style="background:${EXPORT_HEADER_COLORS[i % EXPORT_HEADER_COLORS.length]};">${escapeHtml(c.name)}</th>`).join("")}</tr>`;
  html += `<tr>${blankLeftCells}${sectionColumns.map((c) => `<td style="font-weight:bold;text-align:center;">${c.target}</td>`).join("")}</tr>`;
  html += `<tr><td colspan="${totalCols}">&nbsp;</td></tr>`;

  for (const group of groups) {
    html += `<tr><td colspan="${totalCols}" style="background:#e0e0e8;font-weight:bold;text-align:center;">${escapeHtml(group.label)}</td></tr>`;
    html += `<tr>${[...EXPORT_HEADERS, "GPA"].map((h) => `<th style="background:#f0f0f0;">${h}</th>`).join("")}${sectionColumns.map(() => "<th></th>").join("")}</tr>`;
    for (const r of group.rows) {
      const bg = r.requisitesMet === "Y" ? "#dcfce7" : "#fee2e2";
      const sectionCells = sectionColumns.map((c) => `<td style="text-align:center;">${r.bySection[c.name] || 0}</td>`).join("");
      html += `<tr style="background:${bg};">`
        + `<td>${escapeHtml(r.code)}</td><td>${escapeHtml(r.description)}</td>`
        + `<td>${escapeHtml(r.prerequisites)}</td><td>${escapeHtml(r.corequisites)}</td>`
        + `<td>${r.requisitesMet}</td><td>${r.credits}</td><td style="text-align:center;">${r.grade}</td><td></td>${sectionCells}</tr>`;
    }
    const cumCells = sectionColumns.map((c) => `<td style="font-weight:bold;text-align:center;">${group.cumulativeSnapshot[c.name] || 0}</td>`).join("");
    html += `<tr style="background:#d1d5db;"><td></td><td></td><td></td><td></td>`
      + `<td style="font-weight:bold;">Credit hours:</td><td style="font-weight:bold;">${group.creditTotal}</td>`
      + `<td style="font-weight:bold;">GPA:</td><td style="font-weight:bold;text-align:center;">${formatGpaCell(group.gpa)}</td>${cumCells}</tr>`;
    html += `<tr><td colspan="${totalCols}">&nbsp;</td></tr>`;
  }

  html += `<tr style="background:#9ca3af;"><td></td><td></td><td></td><td></td><td></td><td></td>`
    + `<td style="font-weight:bold;">Cumulative GPA:</td><td style="font-weight:bold;text-align:center;">${formatGpaCell(cumulativeGpa)}</td></tr>`;

  html += "</table>";
  downloadFile(html, filename, "application/vnd.ms-excel");
}

// ---------------- import schedule (reads back our own CSV export) ----------------

function parseCSVLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

// Reverse-maps every semester label (including ones not currently active,
// like a summer term) back to its slot id, so an imported file can restore
// exactly which semesters -- including which summers -- it used.
function labelToSlotId(label) {
  const map = { "Credits From High School": "hs" };
  for (let i = 1; i <= 8; i++) map[slotMeta(`reg-${i}`).label] = `reg-${i}`;
  for (const anchor of SUMMER_ANCHORS) map[slotMeta(`summer-${anchor}`).label] = `summer-${anchor}`;
  return map[label] || null;
}

// Our .xls export is really an HTML <table> saved with an .xls extension
// (see exportAsExcel) -- Excel opens it fine, but that also means we can
// read it back the same way a browser would: as HTML, not as a real binary
// XLSX/OOXML file. A .xlsx saved natively by Excel (not one of our own
// exports) won't parse here; supporting that would need a real binary
// spreadsheet parser, which is out of scope for round-tripping our own
// export format.
function looksLikeHTMLTable(text) {
  return /<table[\s>]/i.test(text) || /<tr[\s>]/i.test(text);
}

function rowsFromCSVText(text) {
  return text.split(/\r?\n/).filter((line) => line.trim()).map(parseCSVLine);
}

function rowsFromHTMLTable(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  return [...doc.querySelectorAll("tr")].map((tr) => [...tr.children].map((cell) => cell.textContent.trim()));
}

function importScheduleFromRows(rows) {
  const newCourses = {};
  const newGrades = {};
  const newSummers = new Set();
  let currentSlot = null;

  for (const cells of rows) {
    if (!cells.some((c) => (c || "").trim())) continue; // fully blank row
    const first = (cells[0] || "").trim();

    const slotId = labelToSlotId(first);
    if (slotId) {
      currentSlot = slotId;
      const m = /^summer-(\d+)$/.exec(slotId);
      if (m) newSummers.add(Number(m[1]));
      continue;
    }
    if (first === "Class" || cells[4] === "Credit hours:" || !currentSlot) continue;
    if (courses[first]) {
      (newCourses[currentSlot] ||= []).push(first);
      // Older exports (from before grade tracking existed) simply don't have
      // this column -- cells[GRADE_COLUMN_INDEX] is undefined/blank for
      // those, which correctly leaves the course ungraded on import.
      const grade = (cells[GRADE_COLUMN_INDEX] || "").trim();
      if (ALL_GRADE_MARKS.includes(grade)) newGrades[first] = grade;
    }
  }
  return { courses: newCourses, grades: newGrades, activeSummers: [...newSummers].sort((a, b) => a - b) };
}

function importScheduleFromText(text) {
  const rows = looksLikeHTMLTable(text) ? rowsFromHTMLTable(text) : rowsFromCSVText(text);
  return importScheduleFromRows(rows);
}

// Every selected *undergrad* program (major, second major, minor) with the
// requirements-checklist rendering they all share -- Masters is handled
// separately (renderMastersProgram) since it has no sections/requirements
// to check off, just a credit total (see build_masters()'s docstring for why).
function selectedPrograms() {
  const { major, secondMajor, minor } = programSelectIds();
  return [major, secondMajor, minor].filter(Boolean).map((id) => programs[id]).filter(Boolean);
}

// Same idea as selectedPrograms(), but keeps each program's export-column
// prefix tied to its actual role (major/second major/minor) instead of
// guessing from array position -- guessing broke as soon as a second major
// could be selected without a minor (position 1 would wrongly get the
// minor's prefix).
function selectedProgramsWithRoles() {
  const { major, secondMajor, minor } = programSelectIds();
  const roles = [];
  if (major && programs[major]) roles.push({ program: programs[major], prefix: "" });
  if (secondMajor && programs[secondMajor]) roles.push({ program: programs[secondMajor], prefix: "(2nd Major) " });
  if (minor && programs[minor]) roles.push({ program: programs[minor], prefix: "(Minor) " });
  return roles;
}

function renderProgressSummary() {
  const scheduledCredits = [...allScheduledCodes()].reduce((sum, c) => sum + courseCredits(c), 0);
  const needed = totalCreditsNeeded();
  const el = document.getElementById("progress-summary");
  el.textContent = needed
    ? `${scheduledCredits} / ${needed} credits scheduled`
    : `${scheduledCredits} credits scheduled`;

  const selected = selectedPrograms();
  const allComplete = selected.length > 0 && selected.every(isProgramComplete);
  el.classList.toggle("complete", allComplete);
}

// ---------------- rendering: major landing page ----------------

function selectMajor(id) {
  document.getElementById("major-select").value = id;
  refreshProgramExclusions();
  // Reveal the rest of setup (second major/minor/masters/honors + the "View
  // My Schedule" button) now that there's a major to attach them to, and
  // reflect the pick back into the typeahead's own text box so it doesn't
  // read as blank/unanswered once the results list collapses.
  document.getElementById("landing-extra-pickers").hidden = false;
  document.getElementById("major-typeahead").value = programs[id]?.name || "";
  document.getElementById("major-typeahead-results").innerHTML = "";
}

function renderMajorTypeahead(query) {
  const container = document.getElementById("major-typeahead-results");
  container.innerHTML = "";
  const all = Object.entries(programs).filter(([, p]) => p.type !== "Minor");
  const q = query.trim().toLowerCase();

  if (!q) {
    const hint = document.createElement("p");
    hint.className = "typeahead-hint";
    hint.textContent = `Start typing to search ${all.length} majors…`;
    container.appendChild(hint);
    return;
  }

  const matches = all
    .filter(([, p]) => p.name.toLowerCase().includes(q))
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .slice(0, 40);

  if (!matches.length) {
    const none = document.createElement("p");
    none.className = "typeahead-hint";
    none.textContent = "No majors match that search.";
    container.appendChild(none);
    return;
  }

  for (const [id, p] of matches) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "typeahead-row";
    row.innerHTML = `<span class="typeahead-name">${p.name}</span><span class="typeahead-college">${p.college}</span>`;
    row.addEventListener("click", () => selectMajor(id));
    container.appendChild(row);
  }
}

// ---------------- top-level render ----------------
// (Light/dark theme toggle now lives in theme.js, shared across every page.)

function renderAll() {
  renderSemesterColumn();
  renderResults();
  runSearch(document.getElementById("course-search").value);
  renderProgressSummary();
}

// Loads/renders the schedule for whatever's currently selected -- does NOT
// touch which screen (setup vs. schedule) is showing, since minor/masters/
// honors only ever change while the setup screen itself is open (they live
// there now, not in an always-visible header), and applying them is a
// separate step (the "View My Schedule" button, see goToSchedule()) from
// picking them.
function applyProgramSelection() {
  const majorId = document.getElementById("major-select").value;
  if (!majorId) return;
  loadSchedule();
  document.getElementById("honors-toggle").checked = schedule.honors;
  renderAll();
  renderSummaryBar();
}

function renderSummaryBar() {
  const parts = selectedProgramsWithRoles().map(({ program, prefix }) => `${prefix}${program.name}`);
  const mastersId = document.getElementById("masters-select").value;
  if (mastersId && mastersPrograms[mastersId]) parts.push(`(Masters) ${mastersPrograms[mastersId].name}`);
  document.getElementById("summary-programs").textContent = parts.join("  +  ");
}

function showLanding() {
  document.getElementById("landing").hidden = false;
  document.getElementById("app").hidden = true;
  document.getElementById("summary-bar").hidden = true;
  // Reopening to edit an existing selection -- the extra pickers should
  // already be relevant (a major is set), so don't make the user retype
  // their major just to reveal them again.
  document.getElementById("landing-extra-pickers").hidden = !document.getElementById("major-select").value;
  // The searchable-select inputs show whatever text was last typed into
  // them, which goes stale the moment something else (e.g. Edit
  // Selections reopening with a schedule that was actually loaded via
  // Import, never through these inputs at all) changes the hidden
  // <select>s without going through onChange -- resync display text to
  // match the real current value every time this screen opens.
  secondMajorSearchable?.setValue(document.getElementById("second-major-select").value);
  minorSearchable?.setValue(document.getElementById("minor-select").value);
  mastersSearchable?.setValue(document.getElementById("masters-select").value);
}

function showApp() {
  document.getElementById("landing").hidden = true;
  document.getElementById("app").hidden = false;
  document.getElementById("summary-bar").hidden = false;
}

// The setup screen's "View My Schedule" button -- both the very first time
// (initial setup) and every later "Edit Selections" round-trip route
// through the same function, since both cases mean the same thing: apply
// whatever's currently selected and show the schedule.
function goToSchedule() {
  if (!document.getElementById("major-select").value) return; // button is only shown once a major exists, but guard anyway
  applyProgramSelection();
  showApp();
}

function initColumnResizer() {
  const resizer = document.getElementById("column-resizer");
  const semesterCol = document.getElementById("semester-column");
  const appEl = document.getElementById("app");

  // Below this width .app-columns stacks vertically instead of side by side
  // (see style.css) and there's nothing left to resize -- a saved inline
  // flexBasis from an earlier drag always outranks a stylesheet media-query
  // rule, so it has to be actively cleared/restored as this crosses, not
  // just left alone.
  const stackedQuery = window.matchMedia("(max-width: 900px)");

  const saved = parseInt(localStorage.getItem(SEMESTER_WIDTH_KEY), 10);
  if (Number.isFinite(saved) && !stackedQuery.matches) semesterCol.style.flexBasis = `${saved}px`;

  stackedQuery.addEventListener("change", (e) => {
    if (e.matches) {
      semesterCol.style.flexBasis = "";
      return;
    }
    const width = parseInt(localStorage.getItem(SEMESTER_WIDTH_KEY), 10);
    if (Number.isFinite(width)) semesterCol.style.flexBasis = `${width}px`;
  });

  let dragging = false;

  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    resizer.classList.add("dragging");
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = appEl.getBoundingClientRect();
    const maxWidth = rect.width - MIN_BROWSE_COLUMN_WIDTH - resizer.getBoundingClientRect().width;
    const width = Math.max(MIN_SEMESTER_COLUMN_WIDTH, Math.min(e.clientX - rect.left, maxWidth));
    semesterCol.style.flexBasis = `${width}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("dragging");
    localStorage.setItem(SEMESTER_WIDTH_KEY, parseInt(semesterCol.style.flexBasis, 10));
  });
}

async function init() {
  initColumnResizer();
  await loadData();
  buildSearchIndex();

  const majorSelect = document.getElementById("major-select");
  const secondMajorSelect = document.getElementById("second-major-select");
  const minorSelect = document.getElementById("minor-select");
  const mastersSelect = document.getElementById("masters-select");
  populateSelect(majorSelect, "Major", "Select a major…");
  populateSelect(secondMajorSelect, "Major", "None (optional)");
  populateSelect(minorSelect, "Minor", "None");
  populateMastersSelect(mastersSelect);
  // Minor/Masters need no listeners of their own -- they (along with
  // second major) only ever change while the setup screen is open, and
  // take effect together when "View My Schedule" is clicked
  // (goToSchedule() -> applyProgramSelection() reads every select fresh).
  majorSelect.addEventListener("change", refreshProgramExclusions);
  secondMajorSelect.addEventListener("change", refreshProgramExclusions);

  // Searchable-select UI over each of those three hidden <select>s -- see
  // wireSearchableSelectToHiddenSelect(). secondMajorSearchable is kept in
  // a module-level variable since refreshProgramExclusions() (above) needs
  // to re-sync it whenever the exclusion logic rebuilds the hidden select's
  // own option list.
  secondMajorSearchable = wireSearchableSelectToHiddenSelect(
    document.getElementById("second-major-mount"), secondMajorSelect, "None -- type to search",
  );
  minorSearchable = wireSearchableSelectToHiddenSelect(document.getElementById("minor-mount"), minorSelect, "None -- type to search");
  mastersSearchable = wireSearchableSelectToHiddenSelect(document.getElementById("masters-mount"), mastersSelect, "None -- type to search");

  document.getElementById("view-schedule-btn").addEventListener("click", goToSchedule);
  document.getElementById("edit-selections-btn").addEventListener("click", showLanding);

  document.getElementById("honors-toggle").addEventListener("change", (e) => {
    localStorage.setItem(HONORS_KEY, e.target.checked ? "1" : "0");
    schedule.honors = e.target.checked;
    renderAll();
  });

  document.getElementById("course-search").addEventListener("input", (e) => runSearch(e.target.value));
  document.getElementById("clear-all-btn").addEventListener("click", clearAllSchedule);

  // Below 900px the schedule and requirements columns are tab-switched
  // instead of both visible at once (see style.css) -- mirrors the same
  // toolbar pattern Classes Connected uses. Above that width these two
  // buttons are hidden and .app-columns just shows both, unaffected.
  const appColumns = document.getElementById("app");
  const scheduleTabBtn = document.getElementById("schedule-tab-btn");
  const requirementsTabBtn = document.getElementById("requirements-tab-btn");
  scheduleTabBtn.addEventListener("click", () => {
    appColumns.classList.replace("showing-requirements", "showing-schedule");
    scheduleTabBtn.classList.add("active");
    requirementsTabBtn.classList.remove("active");
  });
  requirementsTabBtn.addEventListener("click", () => {
    appColumns.classList.replace("showing-schedule", "showing-requirements");
    requirementsTabBtn.classList.add("active");
    scheduleTabBtn.classList.remove("active");
  });

  const courseInfoModal = document.getElementById("course-info-modal");
  document.getElementById("course-info-modal-close").addEventListener("click", () => { courseInfoModal.hidden = true; });
  courseInfoModal.addEventListener("click", (e) => { if (e.target === courseInfoModal) courseInfoModal.hidden = true; });

  const exportModal = document.getElementById("export-modal");
  document.getElementById("export-schedule-btn").addEventListener("click", () => { exportModal.hidden = false; });
  document.getElementById("export-modal-close").addEventListener("click", () => { exportModal.hidden = true; });
  exportModal.addEventListener("click", (e) => { if (e.target === exportModal) exportModal.hidden = true; });
  document.getElementById("export-csv-btn").addEventListener("click", () => {
    if (!document.getElementById("export-name-input").value.trim()) { alert("Enter your name first."); return; }
    const data = buildExportData();
    if (!data.groups.length) { alert("Add some courses to your schedule first."); return; }
    exportAsCSV(data, buildExportFilename("csv"));
    exportModal.hidden = true;
  });
  document.getElementById("export-xls-btn").addEventListener("click", () => {
    if (!document.getElementById("export-name-input").value.trim()) { alert("Enter your name first."); return; }
    const data = buildExportData();
    if (!data.groups.length) { alert("Add some courses to your schedule first."); return; }
    exportAsExcel(data, buildExportFilename("xls"));
    exportModal.hidden = true;
  });

  const importFileInput = document.getElementById("import-schedule-file");
  document.getElementById("import-schedule-btn").addEventListener("click", () => importFileInput.click());
  importFileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Extension check up front -- accept="" on the input is only a picker
    // hint and doesn't stop drag-and-drop, so this is the real gate. A
    // genuine .xlsx isn't supported (see looksLikeHTMLTable's comment);
    // catching it here avoids ever trying to parse it as CSV garbage.
    if (!/\.(csv|xls)$/i.test(file.name)) {
      alert(`"${file.name}" isn't a file this site can import -- it needs to be `
        + `a .csv file, or the .xls file this site's own Export Schedule produces `
        + `(a plain .xlsx saved from Excel isn't supported).`);
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const imported = importScheduleFromText(reader.result);
      const hasCourses = Object.values(imported.courses).some((list) => list.length > 0);
      if (!hasCourses) {
        // Parsing "succeeded" but found nothing real -- almost always means
        // the file wasn't actually one of our exports (e.g. a hand-edited
        // CSV missing the semester-label rows, or content that slipped past
        // the extension check). Bail out WITHOUT touching the existing
        // schedule rather than silently replacing it with an empty one.
        alert(`Couldn't find any recognizable courses in "${file.name}". `
          + `Make sure it's a .csv or .xls file exported from this site -- `
          + `your current schedule hasn't been changed.`);
        e.target.value = "";
        return;
      }
      if (!confirm("Import this schedule? It will replace everything currently in your schedule.")) {
        e.target.value = "";
        return;
      }
      schedule.activeSummers = imported.activeSummers;
      schedule.courses = imported.courses;
      schedule.grades = imported.grades;
      saveSchedule();
      renderAll();
      e.target.value = "";
    };
    reader.readAsText(file);
  });

  const typeahead = document.getElementById("major-typeahead");
  typeahead.addEventListener("input", (e) => renderMajorTypeahead(e.target.value));
  renderMajorTypeahead("");

  showLanding();
}

init();
