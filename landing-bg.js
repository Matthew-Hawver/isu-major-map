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

  let effect = null;

  function isLandingVisible() {
    return !landingEl.hidden && !plannerViewEl.hidden;
  }

  function start() {
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
      backgroundColor: 0x000000, // matches the site's plain-black backdrop everywhere else
      color1: 0xc8102e, // ISU cardinal
      color2: 0xf1be48, // ISU gold
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
})();
