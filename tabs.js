// Tab switching between the three views living in index.html: "Degree
// Planning" (the schedule planner, app.js), "Classes Connected" (the
// prerequisite web, web.js), and "About". Every view's markup is always in
// the DOM; only one is shown at a time -- switching never navigates to a
// new page.

function activateTab(tabName) {
  // Scoped to [data-tab] specifically -- "Help" shares the .nav-link class
  // purely for matching visual styling, but it opens a modal instead of
  // switching a view, so it deliberately has no data-tab and must never be
  // treated as one of the switchable tabs here.
  document.querySelectorAll(".nav-link[data-tab]").forEach((tab) => {
    const isActive = tab.dataset.tab === tabName;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });
  document.getElementById("planner-view").hidden = tabName !== "planner";
  document.getElementById("web-view").hidden = tabName !== "web";
  document.getElementById("about-view").hidden = tabName !== "about";

  if (tabName === "web") ensureWebInitialized();
}

document.querySelectorAll(".nav-link[data-tab]").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

// ---------------- Help modal ----------------

function openHelpModal() {
  document.getElementById("help-modal").hidden = false;
}

function closeHelpModal() {
  document.getElementById("help-modal").hidden = true;
}

document.getElementById("help-tab-btn").addEventListener("click", openHelpModal);
document.getElementById("help-modal-close").addEventListener("click", closeHelpModal);
document.getElementById("help-modal").addEventListener("click", (e) => {
  if (e.target.id === "help-modal") closeHelpModal();
});

// ---------------- feedback modal ----------------
//
// Submissions POST straight to a Formspree endpoint (plain fetch(), no SDK
// needed for one simple form) rather than a mailto: link -- mailto always
// shows the destination address in the visitor's own compose window, which
// is exactly what this avoids: Formspree relays the message to the real
// inbox without the visitor ever seeing where it went. A local copy is
// still kept in localStorage as a redundant backup.

const FEEDBACK_KEY = "isu-planner-feedback";
const FEEDBACK_ENDPOINT = "https://formspree.io/f/mkodalbz";
// Every feedback kind shares this exact subject prefix, on purpose -- it's
// what lets one Gmail filter (matching this text) catch all three kinds and
// apply a single label to them, rather than needing three separate filters.
const FEEDBACK_SUBJECT_TAG = "[ISU Planner Feedback]";

const FEEDBACK_CONFIGS = {
  "cant-find": {
    title: "Can't Find Your Major?",
    showMajorField: true,
    textareaLabel: "Course requirements (as much as you know)",
  },
  incomplete: {
    title: "My Major Isn't Complete",
    showMajorField: true,
    textareaLabel: "What's missing or incorrect?",
  },
  improve: {
    title: "How Can We Improve Your Experience?",
    showMajorField: false,
    textareaLabel: "Your feedback",
  },
};

function openFeedbackModal(kind) {
  const config = FEEDBACK_CONFIGS[kind];
  const modal = document.getElementById("feedback-modal");
  document.getElementById("feedback-modal-title").textContent = config.title;
  document.getElementById("feedback-major-field").hidden = !config.showMajorField;
  document.getElementById("feedback-major-input").value = "";
  document.getElementById("feedback-textarea-label").textContent = config.textareaLabel;
  document.getElementById("feedback-textarea").value = "";
  document.getElementById("feedback-thanks").hidden = true;
  document.getElementById("feedback-submit-btn").hidden = false;
  modal.dataset.kind = kind;
  modal.hidden = false;
}

function closeFeedbackModal() {
  document.getElementById("feedback-modal").hidden = true;
}

async function submitFeedback() {
  const modal = document.getElementById("feedback-modal");
  const kind = modal.dataset.kind;
  const config = FEEDBACK_CONFIGS[kind];
  const entry = {
    kind,
    major: document.getElementById("feedback-major-input").value.trim(),
    details: document.getElementById("feedback-textarea").value.trim(),
    submittedAt: new Date().toISOString(),
  };

  const existing = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || "[]");
  existing.push(entry);
  localStorage.setItem(FEEDBACK_KEY, JSON.stringify(existing));

  const submitBtn = document.getElementById("feedback-submit-btn");
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Sending…";

  try {
    const res = await fetch(FEEDBACK_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        _subject: `${FEEDBACK_SUBJECT_TAG} ${config.title}`,
        type: config.title,
        major: entry.major || "(not provided)",
        message: entry.details || "(none provided)",
      }),
    });
    if (!res.ok) throw new Error(`Formspree responded ${res.status}`);
    document.getElementById("feedback-thanks").hidden = false;
    submitBtn.hidden = true;
  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    alert("Couldn't send that just now. Please try again in a moment.");
  }
}

document.getElementById("cant-find-major-btn").addEventListener("click", () => openFeedbackModal("cant-find"));
document.getElementById("feedback-modal-close").addEventListener("click", closeFeedbackModal);
document.getElementById("feedback-modal").addEventListener("click", (e) => {
  if (e.target.id === "feedback-modal") closeFeedbackModal();
});
document.getElementById("feedback-submit-btn").addEventListener("click", submitFeedback);

document.querySelectorAll(".help-feedback-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    closeHelpModal();
    openFeedbackModal(btn.dataset.feedback);
  });
});

// ---------------- terms / disclaimer modal ----------------
//
// Update this every time the scrapers are re-run (see PROJECT_DOCUMENTATION.md
// §8 Maintenance) -- a stale date is still far more useful to a visitor than
// no date at all, since it tells them how much to trust what they're seeing.
const DATA_LAST_UPDATED = "August 14, 2026";

document.getElementById("terms-last-updated").textContent = DATA_LAST_UPDATED;

function openTermsModal() {
  document.getElementById("terms-modal").hidden = false;
}

function closeTermsModal() {
  document.getElementById("terms-modal").hidden = true;
}

document.getElementById("terms-modal-open").addEventListener("click", openTermsModal);
document.getElementById("about-terms-open").addEventListener("click", openTermsModal);
document.getElementById("terms-modal-close").addEventListener("click", closeTermsModal);
document.getElementById("terms-modal").addEventListener("click", (e) => {
  if (e.target.id === "terms-modal") closeTermsModal();
});

// ---------------- honors program info modal ----------------

function openHonorsInfoModal() {
  document.getElementById("honors-info-modal").hidden = false;
}

function closeHonorsInfoModal() {
  document.getElementById("honors-info-modal").hidden = true;
}

document.getElementById("honors-info-open").addEventListener("click", (e) => {
  e.preventDefault();
  openHonorsInfoModal();
});
document.getElementById("honors-info-modal-close").addEventListener("click", closeHonorsInfoModal);
document.getElementById("honors-info-modal").addEventListener("click", (e) => {
  if (e.target.id === "honors-info-modal") closeHonorsInfoModal();
});

// ---------------- guided tour ----------------

const TOUR_STEPS = [
  {
    title: "Welcome to the ISU Degree Planner",
    text: "This site helps you pick a major, see exactly what it requires, and build a real semester-by-semester schedule. There's also a second page, Classes Connected, that shows how every ISU course links to another by prerequisite. Use the tabs in the top right anytime: Help, About, Classes Connected, and Degree Planning.",
    image: "assets/tour/01-welcome.webp",
    alt: "The ISU Degree Planner landing screen",
  },
  {
    title: "Picking your major",
    text: "Start typing to search. Results narrow as you type. Click a result to select it. Can't find your major listed? Use the \"Can't Find My Major?\" button to let us know.",
    image: "assets/tour/02-pick-major.webp",
    alt: "Searching for a major in the typeahead box",
  },
  {
    title: "Second major, minor, Masters & Honors",
    text: "Once you've picked a major, these optional fields appear. Each one works the same way. Type to search, or leave it blank for none. Check \"Honors student\" if you're in the University Honors Program. Tap the (i) next to it to see exactly what that requires.",
    image: "assets/tour/03-extra-pickers.webp",
    alt: "The optional Second Major, Minor, Masters, and Honors fields",
  },
  {
    title: "Your schedule",
    text: "Your schedule starts pre-filled with an example pathway toward your major, laid out semester by semester. Scroll down to see every semester: Freshman through Senior year, plus any Summer terms or a Fifth Year if you add one.",
    image: "assets/tour/04-schedule.webp",
    alt: "A populated semester-by-semester schedule",
  },
  {
    title: "Adding & removing courses",
    text: "On a computer, drag any course from the requirements list on the right into a semester. On a phone or tablet, tap a course to select it, then tap the semester you want to drop it into. Tap the × on a placed course to remove it.",
    image: "assets/tour/05-add-courses.webp",
    alt: "Dragging a course into a semester",
  },
  {
    title: "Course details & grades",
    text: "Every course in your schedule has a \"Pre/Co-reqs\" button. Click it to see what it needs. It shows a red warning if something is still missing. \"Add Grade\" lets you record your own grade for GPA tracking. This stays stored only on your own device.",
    image: "assets/tour/06-course-details.webp",
    alt: "A course row's Pre/Co-reqs and Add Grade buttons",
  },
  {
    title: "Requirements checklist",
    text: "The right-hand column lists every requirement section for each program you picked. A green checkmark means that section is fully scheduled. Watch the checkmarks fill in as you build your plan.",
    image: "assets/tour/07-requirements.webp",
    alt: "The requirements checklist with completed sections checked off",
  },
  {
    title: "Search",
    text: "The search bar above the requirements list searches course codes, descriptions, departments, and named requirement categories like \"International Perspectives.\" Try searching a department abbreviation like \"ME\" or a topic.",
    image: "assets/tour/08-search.webp",
    alt: "Searching for courses in the browse column",
  },
  {
    title: "Managing your plan",
    text: "Once your schedule exists, a toolbar appears up top. \"Edit Selections\" changes your major, minor, Masters, or Honors status anytime. \"Export Schedule\" saves a copy as a CSV or Excel file. \"Import Schedule\" brings one back in.",
    image: "assets/tour/09-manage-plan.webp",
    alt: "The Edit Selections, Export Schedule, and Import Schedule buttons",
  },
  {
    title: "Classes Connected: what you're looking at",
    text: "This page draws every ISU course as a dot. Bigger dots have more connections. Lines mean two courses are connected: solid gold for a prerequisite, dashed gold for a corequisite, blue for cross-listed or equivalent courses, and dotted gray for courses just mentioned together.",
    image: "assets/tour/10-web-overview.webp",
    alt: "The Classes Connected graph with its legend",
  },
  {
    title: "Classes Connected: the tools",
    text: "Drag to pan and scroll (or pinch, on touch) to zoom. Search for a course by name, or filter by major or department. \"Find Prereq Path\" traces the shortest chain of prerequisites between two courses. Right-click (or press and hold, on touch) any dot to see its full details.",
    image: "assets/tour/11-web-tools.webp",
    alt: "The Classes Connected search, filter, and path-finder controls",
  },
  {
    title: "You're all set",
    text: "That's everything! You can replay this walkthrough anytime from the Help tab. Look for \"Replay the Welcome Tour.\" Enjoy planning your degree.",
    image: "assets/tour/12-wrap-up.webp",
    alt: "The Help menu's Replay the Welcome Tour button",
  },
];

let tourStepIndex = 0;

function renderTourStep() {
  const step = TOUR_STEPS[tourStepIndex];
  document.getElementById("tour-modal-title").textContent = step.title;
  document.getElementById("tour-modal-image").src = step.image;
  document.getElementById("tour-modal-image").alt = step.alt;
  document.getElementById("tour-modal-text").textContent = step.text;
  document.getElementById("tour-step-counter").textContent = `Step ${tourStepIndex + 1} of ${TOUR_STEPS.length}`;
  document.getElementById("tour-back-btn").disabled = tourStepIndex === 0;
  document.getElementById("tour-next-btn").textContent = tourStepIndex === TOUR_STEPS.length - 1 ? "Done" : "Next";
}

function openTourModal() {
  tourStepIndex = 0;
  renderTourStep();
  document.getElementById("tour-modal").hidden = false;
}

function closeTourModal() {
  document.getElementById("tour-modal").hidden = true;
}

document.getElementById("tour-back-btn").addEventListener("click", () => {
  if (tourStepIndex === 0) return;
  tourStepIndex -= 1;
  renderTourStep();
});
document.getElementById("tour-next-btn").addEventListener("click", () => {
  if (tourStepIndex === TOUR_STEPS.length - 1) { closeTourModal(); return; }
  tourStepIndex += 1;
  renderTourStep();
});
document.getElementById("tour-skip-btn").addEventListener("click", closeTourModal);
document.getElementById("tour-modal-close").addEventListener("click", closeTourModal);
document.getElementById("tour-modal").addEventListener("click", (e) => {
  if (e.target.id === "tour-modal") closeTourModal();
});

document.getElementById("help-reopen-tour-btn").addEventListener("click", () => {
  closeHelpModal();
  openTourModal();
});

// ---------------- welcome modal (first-time / returning visitor) ----------------

const ONBOARDING_SEEN_KEY = "isu-planner-onboarding-seen";

function closeWelcomeModal() {
  document.getElementById("welcome-modal").hidden = true;
}

// Shown once per browser, ever -- the flag is set the moment this decides
// to show (or explicitly skip) the prompt, not when the user makes a
// choice, so closing the tab without choosing anything still counts as
// "asked." Anyone who already has a saved schedule from before this
// feature existed is grandfathered past the prompt entirely: asking a
// returning user (in the ordinary sense) "is this your first time?" would
// just be wrong, and they already have their normal landing screen either
// way.
function maybeShowWelcomeModal() {
  if (localStorage.getItem(ONBOARDING_SEEN_KEY)) return;
  const hasExistingSchedule = Object.keys(localStorage).some((k) => k.startsWith("isu-schedule:"));
  localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  if (hasExistingSchedule) return;
  document.getElementById("welcome-modal").hidden = false;
}

document.getElementById("welcome-first-time-btn").addEventListener("click", () => {
  closeWelcomeModal();
  openTourModal();
});

document.getElementById("welcome-returning-btn").addEventListener("click", () => {
  document.getElementById("welcome-returning-panel").hidden = false;
});

document.getElementById("welcome-upload-btn").addEventListener("click", () => {
  document.getElementById("welcome-upload-file").click();
});

document.getElementById("welcome-upload-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("welcome-upload-status");
  statusEl.textContent = "";

  if (!isSupportedImportFilename(file.name)) {
    alert(`"${file.name}" isn't a file this site can import. It needs to be `
      + `a .csv file, or the .xls file this site's own Export Schedule produces. `
      + `A plain .xlsx saved from Excel is not supported.`);
    e.target.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    const rows = parseImportRows(reader.result);
    const metadata = extractProgramMetadata(rows);

    if (!metadata) {
      alert("This file doesn't include a saved major, minor, or Masters "
        + "selection. Either it's from before this feature existed, or it "
        + "isn't one of this site's own exports. Pick your major below, "
        + "then use the \"Import Schedule\" button on your schedule screen "
        + "with this same file to bring your courses and grades in.");
      e.target.value = "";
      closeWelcomeModal();
      return;
    }

    if (programsReadyPromise) await programsReadyPromise;
    const result = await applyRestoredProgramSelection(metadata);
    if (!result.ok) {
      alert(`Couldn't find a major we currently offer that matches "${metadata.majorName}". `
        + `It may have been renamed or removed since this file was exported. `
        + `Pick your major below, then use the "Import Schedule" button on your `
        + `schedule screen with this same file to bring your courses and grades in.`);
      e.target.value = "";
      closeWelcomeModal();
      return;
    }
    if (result.warnings.length) {
      alert(`Everything else was restored, but couldn't match: ${result.warnings.join(", ")}.`);
    }

    const courseData = importScheduleFromRows(rows);
    const hasCourses = Object.values(courseData.courses).some((list) => list.length > 0);
    if (hasCourses && confirm(`Also bring in the courses and grades from "${file.name}"?`)) {
      schedule.activeSummers = courseData.activeSummers;
      schedule.courses = courseData.courses;
      schedule.grades = courseData.grades;
      saveSchedule();
      renderAll();
    }

    e.target.value = "";
    closeWelcomeModal();
  };
  reader.readAsText(file);
});

document.getElementById("welcome-skip-btn").addEventListener("click", closeWelcomeModal);
document.getElementById("welcome-modal-close").addEventListener("click", closeWelcomeModal);
document.getElementById("welcome-modal").addEventListener("click", (e) => {
  if (e.target.id === "welcome-modal") closeWelcomeModal();
});

maybeShowWelcomeModal();
