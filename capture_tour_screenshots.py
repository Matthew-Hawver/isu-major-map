"""Captures the screenshots used by the guided tour (tabs.js's TOUR_STEPS).

Drives the real site (must already be served locally, e.g.
`python3 -m http.server 8000` from this directory) into each step's exact
state with Playwright, clips to the relevant region, and saves directly as
compressed WebP into assets/tour/ -- kept in the repo as the reproducible
source for these images rather than only shipping raw originals, so they
can be regenerated after a UI change instead of going stale.

Usage: python3 -m http.server 8000 (in another terminal, from this dir)
       python3 capture_tour_screenshots.py [base_url]
"""
import io
import os
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
OUT_DIR = os.path.join(os.path.dirname(__file__), "assets", "tour")
os.makedirs(OUT_DIR, exist_ok=True)


def save_webp(png_bytes, name, max_width=1280):
    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    if img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
    path = os.path.join(OUT_DIR, name)
    img.save(path, format="WEBP", quality=82, method=6)
    size_kb = os.path.getsize(path) / 1024
    print(f"  {name}: {img.width}x{img.height}, {size_kb:.0f}KB")


def clip_for(page, selector, pad=16):
    box = page.eval_on_selector(selector, """el => {
        const r = el.getBoundingClientRect();
        return {x: r.x, y: r.y, width: r.width, height: r.height};
    }""")
    return {
        "x": max(0, box["x"] - pad),
        "y": max(0, box["y"] - pad),
        "width": box["width"] + pad * 2,
        "height": box["height"] + pad * 2,
    }


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        # Taller than a typical viewport specifically so the setup card (step
        # 3 especially -- major + all four optional fields + Honors + the
        # submit button) fits in one shot with no need to scroll past the
        # bottom bar mid-capture.
        page = browser.new_page(viewport={"width": 1280, "height": 1150})
        page.goto(f"{BASE_URL}/index.html")
        page.wait_for_timeout(600)
        page.evaluate("() => { try { document.getElementById('welcome-modal').hidden = true; localStorage.setItem('isu-planner-onboarding-seen', '1'); } catch (e) {} }")

        # 1. Welcome -- the plain landing screen
        print("01-welcome")
        save_webp(page.screenshot(clip=clip_for(page, ".landing-card-wrap", pad=24)), "01-welcome.webp")

        # 2. Picking your major -- typed query + results open
        print("02-pick-major")
        page.fill("#major-typeahead", "engineering")
        page.wait_for_timeout(300)
        save_webp(page.screenshot(clip=clip_for(page, ".landing-inner", pad=16)), "02-pick-major.webp")

        # 3. Extra pickers -- major picked, second major/minor/masters/honors visible
        print("03-extra-pickers")
        page.fill("#major-typeahead", "Mechanical Engineering")
        page.wait_for_timeout(300)
        page.click(".typeahead-row")
        page.wait_for_timeout(300)
        save_webp(page.screenshot(clip=clip_for(page, ".landing-inner", pad=16)), "03-extra-pickers.webp")

        page.click("#view-schedule-btn")
        page.wait_for_timeout(700)

        # 4. Your schedule -- the populated semester column
        print("04-schedule")
        save_webp(page.screenshot(clip=clip_for(page, "#semester-column", pad=12)), "04-schedule.webp")

        # 5. Adding courses -- both columns together (drag source + drop target)
        print("05-add-courses")
        save_webp(page.screenshot(clip=clip_for(page, ".app-columns", pad=8)), "05-add-courses.webp")

        # 6. Course details & grades -- expand Pre/Co-reqs on the first placed course
        print("06-course-details")
        first_row = page.query_selector(".course-row")
        req_btn = first_row.query_selector(".row-info-btn:has-text('Pre/Co-reqs')")
        req_btn.click()
        page.wait_for_timeout(200)
        box = first_row.bounding_box()
        save_webp(page.screenshot(clip={"x": max(0, box["x"] - 12), "y": max(0, box["y"] - 12), "width": box["width"] + 24, "height": box["height"] + 140}), "06-course-details.webp")

        # 7. Requirements checklist -- right column with checked-off sections
        print("07-requirements")
        save_webp(page.screenshot(clip=clip_for(page, ".browse-column", pad=8)), "07-requirements.webp")

        # 8. Search -- a query with results
        print("08-search")
        page.fill("#course-search", "international perspectives")
        page.wait_for_timeout(300)
        save_webp(page.screenshot(clip=clip_for(page, ".browse-column", pad=8)), "08-search.webp")
        page.fill("#course-search", "")
        page.wait_for_timeout(200)

        # 9. Managing your plan -- the summary bar toolbar
        print("09-manage-plan")
        save_webp(page.screenshot(clip=clip_for(page, "#summary-bar", pad=10)), "09-manage-plan.webp")

        # Classes Connected
        page.click("[data-tab=web]")
        page.wait_for_timeout(1200)

        # 10. Overview -- graph + legend
        print("10-web-overview")
        save_webp(page.screenshot(clip=clip_for(page, ".web-canvas-wrap", pad=0)), "10-web-overview.webp")

        # 11. Tools -- header controls + ranking panel
        print("11-web-tools")
        box_header = page.eval_on_selector(".web-header", "el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; }")
        box_ranking = page.eval_on_selector("#ranking-panel", "el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; }")
        combined = {
            "x": 0,
            "y": box_header["y"],
            "width": box_header["width"],
            "height": (box_ranking["y"] + box_ranking["height"]) - box_header["y"],
        }
        save_webp(page.screenshot(clip=combined), "11-web-tools.webp")

        # 12. Wrap-up -- Help modal with the replay button
        print("12-wrap-up")
        page.click("#help-tab-btn")
        page.wait_for_timeout(300)
        save_webp(page.screenshot(clip=clip_for(page, ".help-feedback-section", pad=16)), "12-wrap-up.webp")

        browser.close()
    print("\nDone. Files in", OUT_DIR)


if __name__ == "__main__":
    main()
