#!/usr/bin/env python3
"""Measure the static demo in a real browser.

    python3 scripts/check-demo.py [--shots DIR]

Checks, at 1440, 1920 and 390x844: the page never scrolls sideways
(documentElement.scrollWidth <= innerWidth, and no element wider than the viewport),
the twenty claims and the five counters render, Why? opens a trace, and Verify
fingerprint recomputes the digest to VERIFIED MATCH. Saves a desktop and a mobile
screenshot so the two measurements can be looked at, not just read.

Needs Playwright (python) with its bundled Chromium. No server: the page is opened
from disk, which is the claim being tested.
"""
import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent.parent
PAGE = HERE / "docs" / "demo" / "index.html"
SHOTS = HERE.parent / "screenshots"

WIDTHS = [
    ("desktop-1440", 1440, 900, "pages-desktop-ux.png"),
    ("desktop-1920", 1920, 1080, None),
    ("mobile-390", 390, 844, "pages-mobile-ux.png"),
]


def widest_overflow(page):
    return page.evaluate(
        """() => {
            const vw = window.innerWidth;
            const over = [];
            for (const el of document.querySelectorAll('body *')) {
                if (el.classList.contains('skip-link')) continue;
                const r = el.getBoundingClientRect();
                if (r.right > vw + 1 || r.left < -1) {
                    over.push({tag: el.tagName, cls: el.className && String(el.className).slice(0, 40),
                               right: Math.round(r.right), left: Math.round(r.left)});
                }
            }
            return over.slice(0, 6);
        }"""
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shots", default=str(SHOTS))
    args = parser.parse_args()
    shots = pathlib.Path(args.shots)

    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, width, height, shot in WIDTHS:
            page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=2)
            errors = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(PAGE.as_uri())
            page.wait_for_selector('[data-claim="AC-01/jira_work_item"]')

            scroll_width = page.evaluate("() => document.documentElement.scrollWidth")
            inner_width = page.evaluate("() => window.innerWidth")
            body_scroll = page.evaluate("() => document.body.scrollWidth")
            rows = page.evaluate("() => document.querySelectorAll('[data-claims-table] .tr[data-claim]').length")
            counters = page.evaluate("() => document.querySelectorAll('.counter').length")
            print(f"{name}: innerWidth {inner_width}, scrollWidth {scroll_width}, body.scrollWidth {body_scroll}, "
                  f"claim rows {rows}, counters {counters}")

            if scroll_width > inner_width:
                failures.append(f"{name}: the page scrolls sideways ({scroll_width} > {inner_width})")
            if body_scroll > inner_width:
                failures.append(f"{name}: body is wider than the viewport ({body_scroll} > {inner_width})")
            overflow = widest_overflow(page)
            if overflow:
                failures.append(f"{name}: {len(overflow)} element(s) cross the viewport edge: {overflow}")
            if rows != 20:
                failures.append(f"{name}: {rows} claim rows rendered, expected 20")
            if counters != 5:
                failures.append(f"{name}: {counters} counters rendered, expected 5")
            if errors:
                failures.append(f"{name}: console errors {errors[:3]}")

            if shot:
                page.click('[data-tab], #tab-pack')
                page.click('[data-verify]')
                result = page.inner_text("[data-pack-result]")
                if "VERIFIED MATCH" not in result:
                    failures.append(f"{name}: Verify fingerprint returned {result[:80]!r}")
                else:
                    print(f"  fingerprint: {result[:60]}")
                page.click("#tab-control-room")
                page.click('[data-claim="AC-01/approval_independence"] [data-why]', force=True)
                if page.locator('.trace').count() == 0:
                    failures.append(f"{name}: Why? did not open a trace")
                page.click("[data-expand]")
                expanded = page.evaluate("() => !document.querySelector('[data-boundary-full]').hasAttribute('hidden')")
                if not expanded:
                    failures.append(f"{name}: Show all did not expand the guarantee text")
                page.click("[data-expand]")
                collapsed = page.evaluate("() => document.querySelector('[data-boundary-full]').hasAttribute('hidden')")
                if not collapsed:
                    failures.append(f"{name}: Show all did not collapse the guarantee text again")
                shots.mkdir(parents=True, exist_ok=True)
                if width > 620:
                    page.locator('[data-claims-table] [data-claim="AC-01/approval_independence"]').scroll_into_view_if_needed()
                page.screenshot(path=str(shots / shot), full_page=True)
                print(f"  saved {shots / shot}")
            page.close()
        browser.close()

    if failures:
        print("\nFAILED")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("\nall viewports: no horizontal scroll, 20 claims, 5 counters, Why? and Verify work")
    return 0


if __name__ == "__main__":
    sys.exit(main())
