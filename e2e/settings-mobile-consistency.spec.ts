import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

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

    const formInputs = await page
      .locator(
        'section input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), section select',
      )
      .evaluateAll((els) =>
        els.map((el) => ({
          id: el.id || el.getAttribute("name") || "",
          tag: el.tagName,
          type: el.getAttribute("type") || "",
          height: Math.round(el.getBoundingClientRect().height),
        })),
      );

    expect(formInputs.length).toBeGreaterThan(0);
    for (const inp of formInputs) {
      expect.soft(inp.height, `${inp.tag}#${inp.id} (${inp.type})`).toBe(44);
    }
  });

  test("/settings/account: action buttons do not overflow their cards", async ({
    page,
  }) => {
    await page.goto("/settings/account", { waitUntil: "networkidle" });
    await page.waitForLoadState("networkidle");

    // Both the password card and the tour card need the action button
    // to live within (or above the bottom of) the parent card. On
    // mobile the button stacks below the title — it's allowed to
    // extend the card's height, but not push past the right edge.
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
      "expected to find password + tour buttons",
    ).toBeGreaterThanOrEqual(2);

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

  test("/settings/account: Sprache select shares one grid row with date-of-birth", async ({
    page,
  }) => {
    await page.goto("/settings/account", { waitUntil: "networkidle" });
    await page.waitForLoadState("networkidle");

    // The v1.4.27 R1 settings audit pairs date-of-birth with language
    // in a single `grid sm:grid-cols-2` row so the profile form keeps
    // a uniform two-column rhythm and the language field no longer
    // sits alone at the bottom with a `sm:max-w-xs` clamp.
    const sharedGrid = await page.evaluate(() => {
      const lang = document.getElementById("language-select");
      const dob = document.getElementById("dob");
      if (!lang || !dob) return { found: false, sharedGrid: false };
      const langGrid = lang.closest('[class*="grid"]');
      const dobGrid = dob.closest('[class*="grid"]');
      return {
        found: true,
        sharedGrid: langGrid !== null && langGrid === dobGrid,
      };
    });

    expect(sharedGrid.found, "language + dob fields must exist").toBe(true);
    expect(sharedGrid.sharedGrid, "language + dob must share a grid").toBe(
      true,
    );
  });

  test("/settings/dashboard: Compare-to trigger renders at 44 px", async ({
    page,
  }) => {
    await page.goto("/settings/dashboard", { waitUntil: "networkidle" });
    await page.waitForLoadState("networkidle");

    const trigger = page.locator("#comparison-baseline");
    await expect(trigger).toBeVisible();
    const h = await trigger.evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.round(h)).toBe(44);
  });

  test("/settings/ai: every native select renders at 44 px", async ({
    page,
  }) => {
    await page.goto("/settings/ai", { waitUntil: "networkidle" });
    await page.waitForLoadState("networkidle");

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
