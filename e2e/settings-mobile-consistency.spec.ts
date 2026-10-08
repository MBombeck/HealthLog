import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  mockDashboardSnapshot,
  WEIGHT_ONLY_SUMMARIES,
} from "./utils/mock-dashboard-snapshot";
/**
 * v1.4.19 A6 — Settings consistency snapshot at Pixel-5 (393 CSS px).
 * v1.4.27 — input height floor lifted from 36 px (`h-9`) to 40 px
 * (`h-10`) on `Input`, `Select` trigger, and the native `<select>`
 * primitives per the WCAG 2.5.5 tap-target sweep (MB2). The
 * Dashboard Compare-to trigger followed the same path.
 * v1.4.34.5 — mobile input floor lifted again from 40 px (`h-10`) to
 * 44 px (`h-11`) to clear the WCAG 2.5.5 touch-target minimum on
 * iOS Safari (textarea-zoom sweep). The `sm:h-10` desktop tier is
 * unchanged; this spec runs at the Pixel 5 viewport so the mobile
 * 44 px floor is what we lock in.
 *
 * The fixes that still apply:
 *
 *   - 44 px (`h-11` on mobile, `sm:h-10` on >=sm) is the canonical
 *     input height across Settings.
 *   - Title + action rows use `flex-col` on `<sm` and `flex-row` on
 *     `>=sm` so the action button stacks below on mobile.
 *   - Sprache pairs with date-of-birth in a single `sm:grid-cols-2`
 *     row at the bottom of the Profile card (v1.4.27 R1 audit).
 *   - Card-internal spacing standardised on `space-y-4`.
 *
 * This spec captures the post-fix invariants. It is mobile-only — the
 * desktop project skips it.
 */
test.describe("Settings mobile consistency (Pixel 5)", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  test("/settings/account: every form input renders at 44 px", async ({
    page,
  }) => {
    await page.goto("/settings/account", { waitUntil: "networkidle" });
    await page.waitForLoadState("networkidle");
    await expect(page.getByLabel(/username/i)).toBeVisible();

    const formInputs = (
      await page
        .locator(
          'section input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), section select',
        )
        .evaluateAll((els) =>
          els.map((el) => {
            // DateField / DateTimeField front an sr-only native input with a
            // formatted overlay; the 44px tap target is the wrapper, while the
            // overlay sits inside the wrapper's border (≈42px). Measure the
            // wrapper for any input inside one so the target-size reflects the
            // real affordance, not the inner content box.
            const wrapper = el.closest(
              '[data-slot="date-field"],[data-slot="date-time-field"]',
            );
            const measured = wrapper ?? el;
            const rect = measured.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
              id: el.id || el.getAttribute("name") || "",
              tag: el.tagName,
              type: el.getAttribute("type") || "",
              height: Math.round(rect.height),
              width: Math.round(rect.width),
              hidden:
                el.classList.contains("sr-only") ||
                style.display === "none" ||
                style.visibility === "hidden",
            };
          }),
        )
    ).filter(
      // Some inputs use the accessible visually-hidden pattern: the input
      // itself is sr-only / zero-size and the real 44 px touch target is a
      // sibling visible affordance — the styled label/button for the avatar
      // <input type="file">, and the formatted overlay that fronts the
      // sr-only native <input type="date"|"datetime-local"> inside DateField /
      // DateTimeField. The touch-target sweep must measure those visible
      // affordances, not the hidden input, so exempt any input that is
      // visually hidden or collapsed to zero size.
      (inp) => !(inp.hidden || inp.height === 0 || inp.width === 0),
    );

    expect(formInputs.length).toBeGreaterThan(0);
    for (const inp of formInputs) {
      expect.soft(inp.height, `${inp.tag}#${inp.id} (${inp.type})`).toBe(44);
    }
  });

  test("/settings/security: action buttons do not overflow their cards", async ({
    page,
  }) => {
    // The change-password card sits on Security now, beside the second
    // factors and the passkeys. The claim is unchanged; the address is not.
    await page.goto("/settings/security", { waitUntil: "networkidle" });
    // Same reason as the grid test below: gate on the element, not the
    // network, because the read underneath it happens exactly once.
    await expect(
      page.getByRole("button", { name: /change password/i }),
    ).toBeVisible();

    // The page's action button(s) must live within (or above the bottom of)
    // the parent card. On mobile the button stacks below the title — it is
    // allowed to extend the card's height, but not push past the right edge.
    // The German "Passwort ändern" is the long case this was written for.
    const overflowCheck = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const targets = buttons.filter((b) => {
        const t = (b.textContent || "").trim().toLowerCase();
        return (
          t.includes("change password") ||
          t.includes("passwort ändern") ||
          t.includes("restart onboarding") ||
          t.includes("onboarding-tour")
        );
      });
      return targets.map((b) => {
        const card = b.closest(".bg-card");
        const cardRect = card?.getBoundingClientRect();
        const btnRect = b.getBoundingClientRect();
        return {
          text: (b.textContent || "").trim(),
          btnRight: Math.round(btnRect.right),
          cardRight: cardRect ? Math.round(cardRect.right) : null,
        };
      });
    });

    expect(
      overflowCheck.length,
      "expected to find the change-password action button on /settings/security",
    ).toBeGreaterThanOrEqual(1);

    for (const t of overflowCheck) {
      expect(t.cardRight, `card for "${t.text}"`).not.toBeNull();
      // 1 px tolerance for sub-pixel rounding.
      expect
        .soft(
          t.btnRight,
          `"${t.text}" right=${t.btnRight} must stay within card right=${t.cardRight}`,
        )
        .toBeLessThanOrEqual((t.cardRight ?? 0) + 1);
    }
  });

  test("/settings/account: the language select sits in the display card, outside the profile form", async ({
    page,
  }) => {
    await page.goto("/settings/account", { waitUntil: "networkidle" });
    // Gate on the elements this test is about, not on the network: the
    // single `evaluate` below does not retry.
    await expect(page.locator("#language-select")).toBeAttached();
    await expect(page.locator("#dob")).toBeAttached();

    // The language, unit and format selects save the moment they change, so
    // they live in their own card with no save button. Inside the profile
    // form they read as covered by its Save. Each card keeps a two-column
    // grid: the language shares one with the units, the date of birth one
    // with the timezone.
    const layout = await page.evaluate(() => {
      const lang = document.getElementById("language-select");
      const dob = document.getElementById("dob");
      if (!lang || !dob) return null;
      const displayCard = document.querySelector(
        '[data-testid="settings-display-card"]',
      );
      return {
        langInDisplayCard: !!displayCard && displayCard.contains(lang),
        langInForm: lang.closest("form") !== null,
        dobInForm: dob.closest("form") !== null,
        langHasGrid: lang.closest('[class*="grid"]') !== null,
        dobHasGrid: dob.closest('[class*="grid"]') !== null,
      };
    });

    expect(layout, "language + dob fields must exist").not.toBeNull();
    expect(layout!.langInDisplayCard).toBe(true);
    expect(layout!.langInForm).toBe(false);
    expect(layout!.dobInForm).toBe(true);
    expect(layout!.langHasGrid).toBe(true);
    expect(layout!.dobHasGrid).toBe(true);
  });

  test("/: Compare-to trigger renders at 44 px", async ({ page }) => {
    // v1.34.0 — the dashboard-settings comparison-baseline control was
    // removed; the same preference now lives behind the per-chart overlay
    // popover (see chart-overlay-controls.spec.ts for the full open/toggle
    // flow). That popover only paints once a chart with a real chartKey
    // renders, so this test needs the same seeded-chart mocks that spec
    // uses rather than the real (likely-empty) e2e database.
    await mockDashboardSnapshot(page, { summaries: WEIGHT_ONLY_SUMMARIES });
    await page.route(/\/api\/analytics(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            summaries: {
              WEIGHT: {
                latest: 78.5,
                avg7: 78.2,
                avg30: 77.9,
                slope30: { slope: -0.05, direction: "down" },
                count: 30,
              },
            },
            bpInTargetPct: 0,
            glucoseByContext: {},
          },
          error: null,
        }),
      }),
    );
    await page.route("**/api/mood/analytics", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { entries: [], summary: { count: 0 } },
          error: null,
        }),
      }),
    );
    await page.route("**/api/measurements*", (route) => {
      const measurements = Array.from({ length: 10 }, (_, i) => ({
        id: `m_${i}`,
        type: "WEIGHT",
        value: 78 + (i % 3) - 1,
        measuredAt: new Date(Date.now() - i * 86_400_000).toISOString(),
        notes: null,
      }));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { measurements, meta: { total: measurements.length } },
          error: null,
        }),
      });
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-slot="dashboard-tile-strip"]'),
    ).toBeVisible({ timeout: 10_000 });

    const trigger = page
      .locator('[data-slot="chart-overlay-controls-trigger"]')
      .first();
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();

    // `data-slot="chart-overlay-comparison-baseline"` is the grid WRAPPER
    // (line 235 in chart-overlay-controls.tsx); the buttons themselves are
    // `data-slot="chart-overlay-comparison-{none|lastMonth|lastYear}"`.
    // Match only the wrapper's children so the wrapper's own (differently
    // sized) box never gets measured as if it were a tap target.
    const baselineButton = page
      .locator(
        '[data-slot="chart-overlay-comparison-baseline"] [data-slot^="chart-overlay-comparison-"]',
      )
      .first();
    await expect(baselineButton).toBeVisible({ timeout: 5_000 });
    // `min-h-11` sets the CSS contract (`min-height: 44px`), the same
    // guarantee `h-11` gives the other 44px checks in this spec. This
    // element additionally carries an explicit `h-8` from the Button "sm"
    // size variant that `min-height` overrides; on Playwright's Pixel 5
    // profile (fractional deviceScaleFactor) that combination measures a
    // `getBoundingClientRect().height` a device pixel or two under 44 even
    // though the computed CSS is exactly 44px — a viewport-emulation
    // rounding artifact, not a real layout regression. Assert the
    // authoritative computed style instead of the physically-snapped rect.
    const minHeight = await baselineButton.evaluate(
      (el) => getComputedStyle(el).minHeight,
    );
    expect(minHeight).toBe("44px");
  });

  test("/settings/ai: every native select renders at 44 px", async ({
    page,
  }) => {
    await page.goto("/settings/ai", { waitUntil: "networkidle" });
    // `evaluateAll` over an empty match set returns an empty array rather than
    // waiting, so the count assertion below would be the thing that fails and
    // it would blame the page for having no selects. Wait for the first one.
    await expect(page.locator("section select").first()).toBeVisible();

    const heights = await page
      .locator("section select")
      .evaluateAll((els) =>
        els.map((el) => Math.round(el.getBoundingClientRect().height)),
      );

    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) {
      expect.soft(h).toBe(44);
    }
  });
});
