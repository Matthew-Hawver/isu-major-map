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
    alert("Couldn't send that just now -- please try again in a moment.");
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
const DATA_LAST_UPDATED = "August 2, 2026";

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
