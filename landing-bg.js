// Animated "birds avoid the mouse" backdrop for the landing/home screen
// only (https://www.vantajs.com/?effect=birds) -- vendored locally
// (assets/vendor/three.r134.min.js + vanta.birds.min.js), not loaded from a
// CDN, to match the rest of this site being fully self-hosted/offline-safe.
//
// Mounted/torn down (VANTA.BIRDS(...) / effect.destroy()) exactly while
// #landing is actually the visible screen, tracked via MutationObserver on
// the `hidden` attribute rather than hooking every call site in app.js/
// tabs.js that shows or hides #landing or #planner-view -- keeps this
// entirely decoupled from (and safe against future changes to) that logic.
// A running Vanta effect is a live WebGL animation loop; destroying it
// while off-screen avoids burning GPU/battery for an invisible background.
(function () {
  const landingEl = document.getElementById("landing");
  const plannerViewEl = document.getElementById("planner-view");
  const bgEl = document.getElementById("vanta-landing-bg");
  if (!landingEl || !plannerViewEl || !bgEl) return;

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Light Mode should turn every part of the site light, birds included --
  // gold reads fine on black but nearly disappears on a light background,
  // so light mode gets a darker gold instead of the site's usual --gold
  // (that variable stays one fixed value everywhere else on purpose; this
  // is a birds-only adjustment for contrast, not a change to the brand
  // color itself).
  const THEME_COLORS = {
    dark: { backgroundColor: 0x000000, color1: 0xc8102e, color2: 0xf1be48 },
    light: { backgroundColor: 0xf7f7fb, color1: 0xc8102e, color2: 0xb8860b },
  };

  function currentColors() {
    const theme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    return THEME_COLORS[theme];
  }

  let effect = null;

  function isLandingVisible() {
    return !landingEl.hidden && !plannerViewEl.hidden;
  }

  // `theme` is an explicit override for the toggle's own change handler
  // below -- reading data-theme there directly would race theme.js's own
  // change listener on the same checkbox (registered later, since it's
  // gated behind DOMContentLoaded while this file's top-level code isn't,
  // so listener registration order -- which is what decides firing order
  // for two listeners on the same event -- put this file's handler first).
  // The checkbox's own .checked is already correct the instant "change"
  // fires, regardless of listener order, so the toggle handler passes the
  // theme through explicitly instead of relying on data-theme being
  // updated yet. Every other caller (initial load, tab switching) has no
  // such race and can keep reading data-theme normally.
  function start(theme) {
    if (effect || prefersReducedMotion || typeof VANTA === "undefined") return;
    effect = VANTA.BIRDS({
      el: bgEl,
      mouseControls: true,
      touchControls: true,
      gyroControls: false,
      minHeight: 200.0,
      minWidth: 200.0,
      scale: 1.0,
      scaleMobile: 1.0,
      ...(theme ? THEME_COLORS[theme] : currentColors()),
      // "variance" assigns each bird fully to color1 OR color2 (not a
      // per-bird blend) -- reads as a clean mix of cardinal-red and gold
      // birds, closer to ISU's actual two-color palette than
      // "varianceGradient"'s in-between orange blending.
      colorMode: "variance",
      birdSize: 1.1,
      wingSpan: 26.0,
      separation: 60.0,
      alignment: 40.0,
      cohesion: 40.0,
      quantity: 3.0,
    });
  }

  function stop() {
    if (!effect) return;
    effect.destroy();
    effect = null;
  }

  function sync() {
    if (isLandingVisible()) start();
    else stop();
  }

  new MutationObserver(sync).observe(landingEl, { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(sync).observe(plannerViewEl, { attributes: true, attributeFilter: ["hidden"] });
  sync();

  // Restart with the other theme's colors on toggle -- only matters while
  // the effect is actually running (stop()/start() are both already no-ops
  // otherwise), so this stays cheap when the toggle is used from any other
  // screen.
  const themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) {
    themeToggle.addEventListener("change", (e) => {
      if (!effect) return;
      stop();
      start(e.target.checked ? "dark" : "light"); // matches theme.js's own toggle.checked = theme === "dark" convention
    });
  }
})();
