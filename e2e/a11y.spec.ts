import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Accessibility regression gate — fails the build if any WCAG 2.1 AA
 * violation lands in the `serious` or `critical` bucket. v1.5 phase-5
 * re-enables the `/admin` surface that phase-3 had parked while phase-4b
 * restructured the admin into per-section dynamic routes:
 *
 *   - `/auth/login`             (public)
 *   - `/`                        (dashboard, authenticated)
 *   - `/settings/integrations`   (authenticated)
 *   - `/admin`                   (admin overview — `<StatusCardGrid>`)
 *   - `/admin/system-status`     (representative admin sub-route)
 *   - `/admin/users`             (admin users management — icon-only buttons)
 *
 * The seeded user (`e2e-tester`) is provisioned with `role: ADMIN` in
 * `e2e/setup/global-setup.ts` so the same fixture covers both regular
 * and admin surfaces without a second user.
 */

function reportBlocking(
  blocking: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"],
) {
  if (blocking.length === 0) return;
  // Pretty-print so failures are actionable in CI logs.
  console.log(
    "axe violations:\n" +
      blocking
        .map(
          (v) =>
            `  - [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes.length} node(s)\n    ${v.helpUrl}`,
        )
        .join("\n"),
  );
}

async function runAxe(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
}

test.describe("axe-core public surfaces", () => {
  for (const path of ["/auth/login"]) {
    test(`${path} has no serious or critical a11y violations`, async ({
      page,
    }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      const blocking = await runAxe(page);
      reportBlocking(blocking);
      expect(blocking).toHaveLength(0);
    });
  }
});

test.describe("axe-core authenticated surfaces", () => {
  // Reuse the cookie jar captured by `e2e/setup/global-setup.ts`. Login
  // ran once in global-setup so we don't burn auth rate-limit attempts.
  test.use({ storageState: STORAGE_STATE_PATH });

  // Stable mocks so the auth'd pages render deterministically — axe scans
  // need fully-painted DOM, and a flaky API would otherwise stall the
  // analyse() call until the 30s test timeout.
  test.beforeEach(async ({ page }) => {
    // v1.4.39.3 — match `/api/analytics` AND any sliced variant
    // (`?slice=summaries`); the v1.4.39.2 dashboard split fires both
    // in parallel and the literal string glob misses the query-
    // string form.
    await page.route(/\/api\/analytics(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { summaries: {}, bpInTargetPct: null, glucoseByContext: {} },
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
  });

  for (const path of [
    "/",
    "/settings/integrations",
    "/admin",
    "/admin/system-status",
    "/admin/users",
  ]) {
    test(`${path} has no serious or critical a11y violations`, async ({
      page,
    }) => {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");

      const blocking = await runAxe(page);
      reportBlocking(blocking);
      expect(blocking).toHaveLength(0);
    });
  }

  // The keyboard-only "skip to content" link is fixed at the top-left
  // corner of every authenticated page. Marc reported it intercepting
  // logo clicks in v1.4.14 — the fix combines `pointer-events-none`
  // with `-translate-y-full` so the element sits offscreen until
  // focused. Regression guard: with no keyboard focus, the logo's own
  // bounding box must accept the click.
  test("skip-link does not block logo click outside focus", async ({
    page,
    viewport,
  }) => {
    // The desktop sidebar (and its logo) is `hidden md:flex` — the
    // mobile profile (Pixel 5) hides it by design. The skip-link
    // regression Marc originally reported in v1.4.14 was a desktop-
    // only artifact (mobile uses the topbar logo, which is a
    // different DOM node). Skip the mobile project so we don't
    // flake on a contract that doesn't apply there.
    test.skip(
      (viewport?.width ?? 0) < 768,
      "desktop sidebar logo is hidden on mobile by design",
    );

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // Find the desktop sidebar logo link — `<Logo>` is rendered inside
    // a `<Link href="/">` and the only logo at the absolute top-left
    // of the layout. We resolve it by role / accessible name to avoid
    // brittle selectors.
    const logoLink = page
      .locator("a[href='/']")
      .filter({ hasText: "HealthLog" })
      .first();
    await expect(logoLink).toBeVisible();

    const logoBox = await logoLink.boundingBox();
    expect(logoBox).not.toBeNull();
    if (!logoBox) return;

    // Click the centre of the logo. If the skip-link is intercepting
    // pointer events, Playwright's auto-waiting click would either time
    // out or report the wrong element. The defensive `force: false`
    // (default) ensures we go through the full hit-test pipeline.
    await logoLink.click({
      position: { x: logoBox.width / 2, y: logoBox.height / 2 },
    });

    // Logo points at "/", so we either stay on "/" or get a no-op
    // reload. Either way the URL must remain on the dashboard.
    await page.waitForURL(/\/$/);
  });
});
