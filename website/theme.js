// Shared light/dark theme toggle -- used by every page (index.html,
// planner.html, web.html) so the choice made on one carries over to the
// others. Applies the saved/system theme immediately (before the toggle
// switch even exists in the DOM yet) to avoid a flash of the wrong theme,
// then wires up the switch once the page finishes parsing.

const THEME_KEY = "isu-planner-theme";

function currentTheme() {
  return localStorage.getItem(THEME_KEY) || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const toggle = document.getElementById("theme-toggle");
  const label = document.getElementById("theme-switch-label");
  if (toggle) toggle.checked = theme === "dark";
  if (label) label.textContent = theme === "dark" ? "Dark Mode" : "Light Mode";
}

applyTheme(currentTheme());

function initTheme() {
  applyTheme(currentTheme());
  document.getElementById("theme-toggle").addEventListener("change", (e) => {
    const theme = e.target.checked ? "dark" : "light";
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  });
}

document.addEventListener("DOMContentLoaded", initTheme);
