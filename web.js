// "The Web": a pannable, zoomable node-link diagram of every ISU course
// connected to another by a prerequisite, corequisite, cross-listing/
// equivalence, or related-by-mention relationship (see build_web_graph.py's
// EDGE_TYPES -- the index of that list is each edge's 3rd element here).
// Node positions are precomputed once by build_web_graph.py (a small
// force-directed layout, followed by a radius-aware pass that nudges apart
// any bubbles whose actual rendered circles would otherwise overlap) --
// this page only ever has to draw the static result and respond to
// pan/zoom/hover, which is what keeps it smooth with ~4,200 nodes.
//
// Hovering (or clicking, to "pin" the highlight) a course lights up its
// direct neighbors -- both the prerequisites feeding into it and the
// courses that need it -- and dims everything else, which is how "a select
// few flow outwards into different classes" becomes visible: hub courses
// like MATH 1650 or ENGL 2500 light up dozens of connections at once.
//
// Wrapped in an IIFE since this file is loaded on the same page as app.js
// (the planner) as a classic, non-module script -- without this, any name
// declared at the top level here would collide in the shared global scope
// with a same-named one in app.js (this happened for real with `render`,
// each file's own top-level render function, before this wrapper existed).
// Only ensureWebInitialized needs to escape, for tabs.js to call.
(function () {

// Mirrors build_web_graph.py's NODE_MIN_R/NODE_MAX_R -- both live in the
// same world-coordinate space (this file only scales by view.scale at draw
// time), so if either changes, update the other or the Python de-overlap
// pass stops guaranteeing what it's supposed to.
const NODE_MIN_R = 2.0;
const NODE_MAX_R = 20.0;
const MIN_SCALE = 0.03;
const MAX_SCALE = 10;
const HOVER_PIXEL_RADIUS = 10;
// A fingertip's effective contact precision is much coarser than a mouse
// cursor's -- touch taps hit-test against this larger radius instead (see
// the pointerup tap-to-pin handling in wireEvents()).
const TOUCH_HIT_PIXEL_RADIUS = 22;

let graph = { nodes: [], edges: [] };
const nodeById = new Map();
const neighbors = new Map(); // node index -> Set of neighbor indices (both directions)
let radiusByDegree = new Map(); // degree value -> world-space radius, built once per graph load

let canvas, ctx;
let cssWidth = 0;
let cssHeight = 0;
const view = { x: 0, y: 0, scale: 1 };

let hoveredNode = null;
let pinnedNode = null;
let dragging = false;
let dragMoved = false;
let lastMouse = { x: 0, y: 0 };

// ---------------- touch: pan + pinch-zoom via Pointer Events ----------------
// pointerId -> last known {x, y} in client coordinates, for every pointer
// currently down. Size 1 = panning (unified with the mouse-drag path
// below); size 2 = pinch (see wireEvents()).
const activePointers = new Map();
let pinchStartDist = null;
let pinchStartScale = null;
let pinchStartWorldX = null;
let pinchStartWorldY = null;

function pointerMidpoint() {
  const pts = [...activePointers.values()];
  return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
}

function pointerDistance() {
  const pts = [...activePointers.values()];
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

// ---------------- touch: long-press shows a node's info ----------------
// A plain tap only pins/unpins a node (highlights its connections) -- the
// info tooltip itself needs a deliberate hold on touch (mirrors right-click
// on desktop, see the canvas "contextmenu" listener in wireEvents()) so it
// doesn't pop up over whatever a user meant as an ordinary tap or the start
// of a pan.
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 12; // px -- looser than dragMoved's tap-vs-pan threshold, since a held finger drifts more than a quick tap does
let longPressTimer = null;
let longPressFired = false;

function clearLongPressTimer() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

// Pins (or unpins) whichever node is at the given screen point and shows
// its tooltip there -- the actual "reveal info" action, reached via
// long-press (touch), right-click (mouse), or the ranking list's own click
// handler already uses the pin half of this directly (see centerOn()).
function pinAndShowInfo(clientX, clientY, pixelRadius) {
  const rect = canvas.getBoundingClientRect();
  const world = screenToWorld(clientX - rect.left, clientY - rect.top);
  const found = findNodeNear(world.x, world.y, pixelRadius);
  pinnedNode = found !== null && found === pinnedNode ? null : found;
  render();
  renderRankingList();
  if (found !== null) showTooltip(found, clientX, clientY);
  else hideTooltip();
}

// ---------------- filter by major/department ----------------
// null filterCourseSet means "no major filter"; "" filterDept means "no
// department filter". Combined with AND: a node passes if it satisfies
// every currently-active filter.
let filterCourseSet = null;
let filterDept = "";

function isInScope(node) {
  if (filterCourseSet && !filterCourseSet.has(node.id)) return false;
  if (filterDept && node.dept !== filterDept) return false;
  return true;
}

function filtersActive() {
  return filterCourseSet !== null || filterDept !== "";
}

// Every course code a program's requirements name, anywhere in any section
// -- same source data app.js's own requirement checklists read
// (program.sections[].requirements[].course_code), including combo codes
// like "CE 2710 & CE 2720" split the same way app.js's splitComboCode()
// already does. `programs` and `splitComboCode` are both globals from
// app.js (not IIFE-wrapped there), loaded well before a user can reach this
// tab -- see ensureWebInitialized().
function courseSetForProgram(programId) {
  const program = programs[programId];
  if (!program) return null;
  const codes = new Set();
  for (const section of program.sections || []) {
    for (const req of section.requirements || []) {
      if (!req.course_code) continue;
      for (const code of splitComboCode(req.course_code)) codes.add(code);
    }
  }
  return codes;
}

// ---------------- prerequisite path-finder ----------------
let pathHighlightNodes = null; // Set of node indices, or null when no path is shown
let pathHighlightEdges = null; // Set of "a-b" directed-edge keys, or null

async function loadGraph() {
  const res = await fetch("data/prereq_graph.json");
  graph = await res.json();
  graph.nodes.forEach((n, i) => {
    nodeById.set(n.id, i);
    neighbors.set(i, new Set());
  });
  for (const [a, b] of graph.edges) {
    neighbors.get(a).add(b);
    neighbors.get(b).add(a);
  }
  radiusByDegree = buildRadiusLookup(graph.nodes);
}

// Mirrors build_web_graph.py's radius_for_degrees() EXACTLY: bubble size by
// RANK among the distinct degree values actually present, not raw degree.
// Degree is heavily right-skewed (most nodes have very few connections), so
// a plain sqrt(degree) formula put the great majority of nodes at the same
// minimum size with no visible difference -- ranking the unique degree
// values and spacing them evenly across [NODE_MIN_R, NODE_MAX_R] guarantees
// every distinct connection-count tier is visibly distinct, while nodes
// sharing the same degree still render at the same size.
function buildRadiusLookup(nodes) {
  const uniqueDegrees = [...new Set(nodes.map((n) => n.degree))].sort((a, b) => a - b);
  const lookup = new Map();
  uniqueDegrees.forEach((d, i) => {
    const t = uniqueDegrees.length === 1 ? 0.5 : i / (uniqueDegrees.length - 1);
    lookup.set(d, NODE_MIN_R + t * (NODE_MAX_R - NODE_MIN_R));
  });
  return lookup;
}

// Must match build_web_graph.py's EDGE_TYPES list index-for-index.
const EDGE_STYLE = {
  prereq: { colorVar: "--gold", dash: [] },
  coreq: { colorVar: "--gold", dash: [5, 4] }, // same relationship "family" as prereq, dashed for "same semester" rather than "before"
  cross_listed: { colorVar: "--course", dash: [] }, // deliberately a different color -- this is an equivalence, not a requirement
  related: { colorVar: "--muted", dash: [2, 3] }, // a softer signal (mentioned in prose, not stated as equivalent/required) -- deliberately understated
};

function edgeStyle(edgeTypeIndex) {
  const name = graph.edge_types?.[edgeTypeIndex] || "prereq";
  return EDGE_STYLE[name] || EDGE_STYLE.prereq;
}

function nodeRadius(node) {
  return radiusByDegree.get(node.degree) ?? NODE_MIN_R;
}

function worldToScreen(x, y) {
  return { x: x * view.scale + view.x, y: y * view.scale + view.y };
}

function screenToWorld(x, y) {
  return { x: (x - view.x) / view.scale, y: (y - view.y) / view.scale };
}

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cssWidth = rect.width;
  cssHeight = rect.height;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
}

function fitView() {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of graph.nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  const graphW = maxX - minX || 1;
  const graphH = maxY - minY || 1;
  view.scale = Math.max(MIN_SCALE, Math.min(cssWidth / graphW, cssHeight / graphH) * 0.9);
  view.x = cssWidth / 2 - ((minX + maxX) / 2) * view.scale;
  view.y = cssHeight / 2 - ((minY + maxY) / 2) * view.scale;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const courseColor = cssVar("--accent"); // ISU Cardinal red bubbles
  const pinnedColor = cssVar("--gold"); // the clicked/pinned node stands out in gold
  const pathColor = cssVar("--ok"); // a found prereq path stands out in green -- distinct from pin-gold and edge-gold
  const textColor = cssVar("--text");

  // Three highlight modes, in priority order -- a found path (an explicit,
  // targeted "show me just this") wins over a pinned node, which wins over
  // plain major/department filter dimming, which only applies when neither
  // of the other two (more specific) modes is active.
  const pathMode = pathHighlightNodes !== null;
  // Only a clicked (pinned) node drives the highlight/label reveal -- mere
  // hovering used to do this too, but with ~4,200 nodes that meant the
  // highlight flickered constantly while just moving the mouse across the
  // cluster. Hovering still shows the info tooltip, just not the on-canvas
  // highlight or label.
  const active = pathMode ? null : pinnedNode;
  const activeNeighbors = active !== null ? neighbors.get(active) : null;
  const filterMode = !pathMode && active === null && filtersActive();

  ctx.lineWidth = 1;
  for (const [a, b, edgeType] of graph.edges) {
    if (pathMode) {
      if (!pathHighlightEdges.has(`${a}-${b}`)) continue; // path mode only ever draws the path's own edges
      ctx.strokeStyle = pathColor;
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 3;
    } else {
      const isHighlighted = active !== null && (a === active || b === active);
      if (active !== null && !isHighlighted) continue; // skip drawing dimmed edges entirely once something's pinned -- cheap and keeps focus clear
      const aInScope = isInScope(graph.nodes[a]);
      const bInScope = isInScope(graph.nodes[b]);
      if (filterMode && !aInScope && !bInScope) continue; // both ends outside every active filter -- not worth drawing at all
      const style = edgeStyle(edgeType);
      ctx.strokeStyle = cssVar(style.colorVar);
      ctx.setLineDash(style.dash);
      ctx.globalAlpha = filterMode ? (aInScope && bInScope ? 1 : 0.15) : (isHighlighted ? 1 : 0.4);
      ctx.lineWidth = isHighlighted ? 2 : 1;
    }
    const na = graph.nodes[a];
    const nb = graph.nodes[b];
    const pa = worldToScreen(na.x, na.y);
    const pb = worldToScreen(nb.x, nb.y);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;

  graph.nodes.forEach((n, i) => {
    const p = worldToScreen(n.x, n.y);
    if (p.x < -20 || p.x > cssWidth + 20 || p.y < -20 || p.y > cssHeight + 20) return;
    const isActive = i === active;
    const isNeighbor = activeNeighbors && activeNeighbors.has(i);
    const isOnPath = pathMode && pathHighlightNodes.has(i);
    const r = Math.max(1.5, Math.min(nodeRadius(n) * view.scale, 40));
    if (pathMode) {
      ctx.globalAlpha = isOnPath ? 1 : 0.1;
    } else if (active !== null) {
      ctx.globalAlpha = isActive || isNeighbor ? 1 : 0.12;
    } else if (filterMode) {
      ctx.globalAlpha = isInScope(n) ? 1 : 0.1;
    } else {
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = isOnPath ? pathColor : (isActive ? pinnedColor : courseColor);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  if (active !== null || pathMode) {
    graph.nodes.forEach((n, i) => {
      const isActive = i === active;
      const isNeighbor = activeNeighbors && activeNeighbors.has(i);
      const isOnPath = pathMode && pathHighlightNodes.has(i);
      if (!isActive && !isNeighbor && !isOnPath) return;
      const p = worldToScreen(n.x, n.y);
      if (p.x < -60 || p.x > cssWidth + 60 || p.y < -20 || p.y > cssHeight + 20) return;
      const r = Math.max(1.5, Math.min(nodeRadius(n) * view.scale, 40));
      ctx.fillStyle = isOnPath ? pathColor : (isActive ? pinnedColor : textColor);
      ctx.font = isActive || isOnPath ? "bold 12px sans-serif" : "11px sans-serif";
      ctx.fillText(n.id, p.x + r + 3, p.y + 4);
    });
  }
}

function findNodeNear(wx, wy, pixelRadius = HOVER_PIXEL_RADIUS) {
  const worldRadius = pixelRadius / view.scale;
  let closest = null;
  let closestDist = worldRadius;
  graph.nodes.forEach((n, i) => {
    const dx = n.x - wx;
    const dy = n.y - wy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < closestDist) {
      closestDist = d;
      closest = i;
    }
  });
  return closest;
}

function showTooltip(nodeIdx, clientX, clientY) {
  const n = graph.nodes[nodeIdx];
  const tip = document.getElementById("web-tooltip");
  tip.innerHTML = `<div class="tooltip-code"><span>${n.id}</span><span class="tooltip-credits">${n.credits || ""} cr</span></div>`
    + `<div class="tooltip-desc">${n.description || "No description available."}</div>`
    + `<div class="tooltip-row">${n.degree} connection${n.degree === 1 ? "" : "s"}</div>`;
  tip.hidden = false;
  const pad = 14;
  let x = clientX + pad;
  let y = clientY + pad;
  const rect = tip.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = clientY - rect.height - pad;
  tip.style.left = `${Math.max(0, x)}px`;
  tip.style.top = `${Math.max(0, y)}px`;
}

function hideTooltip() {
  document.getElementById("web-tooltip").hidden = true;
}

function centerOn(nodeIdx) {
  const n = graph.nodes[nodeIdx];
  view.scale = Math.max(view.scale, 1.2);
  view.x = cssWidth / 2 - n.x * view.scale;
  view.y = cssHeight / 2 - n.y * view.scale;
  pinnedNode = nodeIdx;
  render();
}

// ---------------- filter controls ----------------

let majorFilterSearchable = null;
let deptFilterSearchable = null;

function populateFilterControls() {
  const majorSelect = document.getElementById("web-major-filter");
  Object.entries(programs)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .forEach(([id, p]) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = p.name;
      majorSelect.appendChild(opt);
    });

  const deptSelect = document.getElementById("web-dept-filter");
  [...new Set(graph.nodes.map((n) => n.dept))].sort().forEach((dept) => {
    const opt = document.createElement("option");
    opt.value = dept;
    opt.textContent = dept;
    deptSelect.appendChild(opt);
  });

  // Searchable-select UI over both hidden <select>s (createSearchableSelect/
  // wireSearchableSelectToHiddenSelect are globals from app.js -- this file
  // is IIFE-wrapped but can still call any pre-existing global, same as it
  // already does for `programs`/`splitComboCode`).
  majorFilterSearchable = wireSearchableSelectToHiddenSelect(
    document.getElementById("web-major-filter-mount"), majorSelect, "All majors / minors, type to search",
  );
  deptFilterSearchable = wireSearchableSelectToHiddenSelect(
    document.getElementById("web-dept-filter-mount"), deptSelect, "All departments, type to search",
  );
}

function applyFilters() {
  const majorId = document.getElementById("web-major-filter").value;
  filterCourseSet = majorId ? courseSetForProgram(majorId) : null;
  filterDept = document.getElementById("web-dept-filter").value;
  document.getElementById("web-clear-filters-btn").hidden = !filtersActive();
  render();
}

function clearFilters() {
  majorFilterSearchable.setValue("");
  deptFilterSearchable.setValue("");
  document.getElementById("web-major-filter").value = "";
  document.getElementById("web-dept-filter").value = "";
  applyFilters();
}

// ---------------- prerequisite path-finder ----------------

function findCourseIndex(query) {
  const q = query.trim().toUpperCase();
  if (!q) return null;
  let idx = nodeById.get(q);
  if (idx === undefined) idx = graph.nodes.findIndex((n) => n.id.startsWith(q));
  return idx === undefined || idx === -1 ? null : idx;
}

// Directed BFS over prereq-type edges only (build_prereq_edges in
// build_web_graph.py stores each as (prereq, dependent, 0), so [a, b] here
// already means "a is a prerequisite of b") -- answers "what sequence of
// prerequisites leads from `from` to `to`", not just "are these connected
// at all" the way the undirected `neighbors` map used for pin-highlighting
// does. Returns an array of node indices (the path, both ends inclusive) or
// null if `to` isn't reachable from `from` this way.
function findPrereqPath(from, to) {
  const prereqType = graph.edge_types.indexOf("prereq");
  const forward = new Map();
  for (const [a, b, t] of graph.edges) {
    if (t !== prereqType) continue;
    if (!forward.has(a)) forward.set(a, []);
    forward.get(a).push(b);
  }

  const parent = new Map();
  const visited = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) {
      const path = [cur];
      let node = cur;
      while (parent.has(node)) {
        node = parent.get(node);
        path.unshift(node);
      }
      return path;
    }
    for (const next of forward.get(cur) || []) {
      if (!visited.has(next)) {
        visited.add(next);
        parent.set(next, cur);
        queue.push(next);
      }
    }
  }
  return null;
}

function fitViewToNodes(indices, marginFactor) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const idx of indices) {
    const n = graph.nodes[idx];
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(cssWidth / w, cssHeight / h) * marginFactor));
  view.x = cssWidth / 2 - ((minX + maxX) / 2) * view.scale;
  view.y = cssHeight / 2 - ((minY + maxY) / 2) * view.scale;
}

function runPathFinder() {
  const resultEl = document.getElementById("web-path-result");
  const clearBtn = document.getElementById("web-path-clear-btn");
  const fromIdx = findCourseIndex(document.getElementById("web-path-from").value);
  const toIdx = findCourseIndex(document.getElementById("web-path-to").value);

  if (fromIdx === null || toIdx === null) {
    resultEl.textContent = "Couldn't find one or both of those courses.";
    return;
  }
  if (fromIdx === toIdx) {
    resultEl.textContent = "That's the same course.";
    return;
  }

  let path = findPrereqPath(fromIdx, toIdx);
  let reversed = false;
  if (!path) {
    path = findPrereqPath(toIdx, fromIdx);
    reversed = true;
  }
  if (!path) {
    resultEl.textContent = `No prerequisite chain connects ${graph.nodes[fromIdx].id} and ${graph.nodes[toIdx].id}.`;
    pathHighlightNodes = null;
    pathHighlightEdges = null;
    clearBtn.hidden = true;
    render();
    return;
  }

  pathHighlightNodes = new Set(path);
  pathHighlightEdges = new Set();
  for (let i = 0; i < path.length - 1; i++) pathHighlightEdges.add(`${path[i]}-${path[i + 1]}`);

  const codes = path.map((i) => graph.nodes[i].id).join(" → ");
  resultEl.textContent = reversed
    ? `${graph.nodes[toIdx].id} is actually a prerequisite toward ${graph.nodes[fromIdx].id}: ${codes}`
    : codes;
  clearBtn.hidden = false;

  fitViewToNodes(path, 0.7);
  pinnedNode = null; // path highlight and pin highlight are mutually exclusive display modes
  render();
  renderRankingList();
}

function clearPathHighlight() {
  pathHighlightNodes = null;
  pathHighlightEdges = null;
  document.getElementById("web-path-result").textContent = "";
  document.getElementById("web-path-clear-btn").hidden = true;
  document.getElementById("web-path-from").value = "";
  document.getElementById("web-path-to").value = "";
  render();
}

function wireEvents() {
  // Unified pointerdown/move/up/cancel drive both mouse-drag-to-pan (a
  // drop-in behavioral replacement for the old mouse-only handlers) and
  // touch pan/pinch-zoom -- see the module-level activePointers/pinchStart*
  // state above. setPointerCapture keeps a fast gesture tracked even if a
  // finger briefly slides outside the canvas's own bounds mid-move.
  canvas.addEventListener("pointerdown", (e) => {
    // Best-effort -- can throw in rare real-world edge cases (a pointer
    // that's already gone by the time this runs), and the pan/pinch math
    // below only listens on window anyway, so capture is a nice-to-have
    // (keeps a fast gesture tracked past the canvas's own edge) rather than
    // something the rest of this handler depends on.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not critical, see above */ }
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 1) {
      dragging = true;
      dragMoved = false;
      lastMouse = { x: e.clientX, y: e.clientY };

      longPressFired = false;
      clearLongPressTimer();
      if (e.pointerType !== "mouse") {
        const pointerId = e.pointerId;
        const startX = e.clientX;
        const startY = e.clientY;
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          const current = activePointers.get(pointerId);
          if (!current) return; // already lifted
          if (Math.hypot(current.x - startX, current.y - startY) > LONG_PRESS_MOVE_TOLERANCE) return; // was a pan, not a hold
          longPressFired = true;
          pinAndShowInfo(current.x, current.y, TOUCH_HIT_PIXEL_RADIUS);
        }, LONG_PRESS_MS);
      }
    } else if (activePointers.size === 2) {
      // A second finger just landed -- stop single-pointer panning and
      // start tracking the pinch from here. Anchoring to the gesture's
      // OWN start (not recomputed incrementally each move) avoids
      // floating-point drift over a long pinch.
      dragging = false;
      clearLongPressTimer();
      const rect = canvas.getBoundingClientRect();
      const mid = pointerMidpoint();
      const world = screenToWorld(mid.x - rect.left, mid.y - rect.top);
      pinchStartDist = pointerDistance();
      pinchStartScale = view.scale;
      pinchStartWorldX = world.x;
      pinchStartWorldY = world.y;
      hideTooltip();
    }
  });

  window.addEventListener("pointermove", (e) => {
    // Only update tracked position for pointers that are actually down --
    // a hovering mouse (no button pressed) never fired pointerdown, so it
    // never entered activePointers, and falls through to the hover-preview
    // branch below exactly like the old mousemove handler did.
    if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size >= 2) {
      const rect = canvas.getBoundingClientRect();
      const mid = pointerMidpoint();
      const factor = pointerDistance() / pinchStartDist;
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinchStartScale * factor));
      // Solve view.x/y so the world point that was under the pinch's
      // starting midpoint stays under the midpoint's current position --
      // the same "keep the point under the gesture fixed" technique the
      // wheel handler below uses for a mouse-wheel zoom, generalized to a
      // (possibly moving) two-finger midpoint so pinch and 2-finger pan
      // both fall out of one calculation.
      view.scale = newScale;
      view.x = (mid.x - rect.left) - pinchStartWorldX * newScale;
      view.y = (mid.y - rect.top) - pinchStartWorldY * newScale;
      dragMoved = true;
      render();
      return;
    }

    if (dragging) {
      const dx = e.clientX - lastMouse.x;
      const dy = e.clientY - lastMouse.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        dragMoved = true;
        clearLongPressTimer(); // a real pan started -- not a hold
      }
      view.x += dx;
      view.y += dy;
      lastMouse = { x: e.clientX, y: e.clientY };
      hideTooltip();
      render();
      return;
    }

    // Hover preview -- mouse only. A touch contact always fires its own
    // pointerdown before any pointermove, so this branch is unreachable
    // for touch without needing an explicit pointerType check.
    const rect = canvas.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      if (hoveredNode !== null) {
        hoveredNode = null;
        hideTooltip();
        render();
      }
      return;
    }
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const found = findNodeNear(world.x, world.y);
    if (found !== hoveredNode) {
      hoveredNode = found;
      render();
    }
    if (found !== null) showTooltip(found, e.clientX, e.clientY);
    else hideTooltip();
  });

  // pointercancel fires when the OS/browser interrupts a gesture mid-flight
  // (e.g. an incoming call, or the browser reclaiming it for its own
  // navigation gesture) -- handled identically to pointerup, or panning/
  // pinching can get stuck thinking a pointer is still down.
  function endPointer(e) {
    activePointers.delete(e.pointerId);
    clearLongPressTimer();

    if (activePointers.size === 1) {
      // Dropped from a pinch back to a single finger -- resume panning
      // from here instead of jumping via a stale lastMouse, and don't
      // treat the eventual final lift as a tap (a real gesture already
      // happened this touch sequence).
      const [remaining] = activePointers.values();
      dragging = true;
      dragMoved = true;
      lastMouse = { x: remaining.x, y: remaining.y };
      pinchStartDist = null;
      pinchStartScale = null;
      return;
    }

    if (activePointers.size > 0) return; // still mid-gesture with other pointers down

    if (dragging && !dragMoved && !longPressFired) {
      // A genuine tap/click, not a drag, pinch, or already-handled long
      // press -- pins (or unpins) the node under it, same as always, but
      // deliberately does NOT show the info tooltip: that's reserved for a
      // long press (touch, see the pointerdown timer above) or a
      // right-click (mouse, see the "contextmenu" listener below), so a
      // plain tap/click while panning around doesn't pop it up unasked for.
      const rect = canvas.getBoundingClientRect();
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const isTouch = e.pointerType !== "mouse";
      const found = findNodeNear(world.x, world.y, isTouch ? TOUCH_HIT_PIXEL_RADIUS : HOVER_PIXEL_RADIUS);
      pinnedNode = found !== null && found === pinnedNode ? null : found;
      render();
      renderRankingList();
    }
    dragging = false;
    dragMoved = false;
    longPressFired = false;
    pinchStartDist = null;
    pinchStartScale = null;
  }
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);

  // Desktop equivalent of the touch long-press above -- right-click shows
  // (and pins) a node's info instead of the browser's own context menu.
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    pinAndShowInfo(e.clientX, e.clientY, HOVER_PIXEL_RADIUS);
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.001);
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
    const worldX = (mx - view.x) / view.scale;
    const worldY = (my - view.y) / view.scale;
    view.x = mx - worldX * newScale;
    view.y = my - worldY * newScale;
    view.scale = newScale;
    render();
  }, { passive: false });

  window.addEventListener("resize", () => {
    if (document.getElementById("web-view").hidden) return;
    resizeCanvas();
    render();
  });

  document.getElementById("web-search").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = e.target.value.trim().toUpperCase();
    if (!q) return;
    let idx = nodeById.get(q);
    if (idx === undefined) idx = graph.nodes.findIndex((n) => n.id.startsWith(q));
    if (idx === undefined || idx === -1) return;
    centerOn(idx);
    renderRankingList();
  });

  document.getElementById("theme-toggle").addEventListener("change", () => render());

  document.getElementById("web-major-filter").addEventListener("change", applyFilters);
  document.getElementById("web-dept-filter").addEventListener("change", applyFilters);
  document.getElementById("web-clear-filters-btn").addEventListener("click", clearFilters);

  document.getElementById("web-path-find-btn").addEventListener("click", runPathFinder);
  document.getElementById("web-path-clear-btn").addEventListener("click", clearPathHighlight);
  for (const inputId of ["web-path-from", "web-path-to"]) {
    document.getElementById(inputId).addEventListener("keydown", (e) => {
      if (e.key === "Enter") runPathFinder();
    });
  }

  // Below 900px both the ranking panel (a fixed off-canvas drawer) and the
  // search/filter/path-finder controls (a drop-down overlay) default to
  // closed, each toggled by its own button in the slim always-visible
  // .web-toolbar, and closed by tapping anywhere outside an open one --
  // see style.css for what "open" looks like for each. Opening either one
  // closes the other, so they never end up both open and overlapping.
  const rankingPanel = document.getElementById("ranking-panel");
  const rankingToggleBtn = document.getElementById("ranking-panel-toggle-btn");
  const controlsPanel = document.getElementById("web-controls-panel");
  const controlsToggleBtn = document.getElementById("web-controls-toggle-btn");

  function setPanelOpen(panel, toggleBtn, open) {
    panel.classList.toggle("open", open);
    toggleBtn.classList.toggle("active", open);
  }

  rankingToggleBtn.addEventListener("click", () => {
    const opening = !rankingPanel.classList.contains("open");
    setPanelOpen(rankingPanel, rankingToggleBtn, opening);
    if (opening) setPanelOpen(controlsPanel, controlsToggleBtn, false);
  });
  controlsToggleBtn.addEventListener("click", () => {
    const opening = !controlsPanel.classList.contains("open");
    setPanelOpen(controlsPanel, controlsToggleBtn, opening);
    if (opening) setPanelOpen(rankingPanel, rankingToggleBtn, false);
  });
  document.addEventListener("click", (e) => {
    if (rankingPanel.classList.contains("open")
      && !rankingPanel.contains(e.target) && e.target !== rankingToggleBtn) {
      setPanelOpen(rankingPanel, rankingToggleBtn, false);
    }
    if (controlsPanel.classList.contains("open")
      && !controlsPanel.contains(e.target) && e.target !== controlsToggleBtn) {
      setPanelOpen(controlsPanel, controlsToggleBtn, false);
    }
  });

  document.getElementById("web-legend-toggle-btn").addEventListener("click", () => {
    document.getElementById("web-legend").classList.toggle("collapsed");
  });
}

let webInitialized = false;

// Called by tabs.js the moment the "Classes Connected" tab is shown. The
// canvas has zero size while its view is hidden (display:none), so nothing
// here can run until the tab is actually visible; on later visits we just
// re-measure and redraw in case the window was resized while hidden --
// the loaded graph/view/pan state all stay exactly as the user left them.
// ---------------- ranking panel (most-connected classes) ----------------

let rankingSort = "conn1";

function renderRankingList() {
  const container = document.getElementById("ranking-list");
  const sorted = [...graph.nodes.keys()].sort((a, b) => graph.nodes[b][rankingSort] - graph.nodes[a][rankingSort]);

  container.innerHTML = "";
  sorted.forEach((i, rank) => {
    const n = graph.nodes[i];
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ranking-row" + (i === pinnedNode ? " active" : "");
    row.innerHTML = `<span class="ranking-rank">${rank + 1}</span>`
      + `<span class="ranking-code">${n.id}</span>`
      + `<span class="ranking-count ${rankingSort === "conn1" ? "current" : ""}">${n.conn1}</span>`
      + `<span class="ranking-count ${rankingSort === "conn2" ? "current" : ""}">${n.conn2}</span>`
      + `<span class="ranking-count ${rankingSort === "conn3" ? "current" : ""}">${n.conn3}</span>`;
    row.addEventListener("click", () => {
      centerOn(i);
      renderRankingList();
    });
    container.appendChild(row);
  });
}

function wireRankingSort() {
  document.querySelectorAll(".ranking-sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      rankingSort = btn.dataset.sort;
      document.querySelectorAll(".ranking-sort-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderRankingList();
    });
  });
}

async function ensureWebInitialized() {
  if (webInitialized) {
    resizeCanvas();
    render();
    return;
  }
  webInitialized = true;
  canvas = document.getElementById("graph-canvas");
  ctx = canvas.getContext("2d");
  await loadGraph();
  populateFilterControls();
  resizeCanvas();
  fitView();
  wireEvents();
  wireRankingSort();
  // Phone-tier default: the legend starts collapsed to its title only (see
  // the matching CSS media query) -- only sets the initial state, the
  // toggle button (wired in wireEvents()) governs it from here on.
  if (window.matchMedia("(max-width: 480px)").matches) {
    document.getElementById("web-legend").classList.add("collapsed");
  }
  render();
  renderRankingList();
  document.getElementById("web-hint").textContent =
    `${graph.nodes.length.toLocaleString()} connected courses, `
    + `${graph.edges.length.toLocaleString()} connections (prerequisite, corequisite, cross-listed, or related)`;
}

window.ensureWebInitialized = ensureWebInitialized;

})();
