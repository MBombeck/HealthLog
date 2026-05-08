import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Accessibility regression gate — fails the build if any WCAG 2.1 AA
 * violation lands in the `serious` or `critical` bucket on a public
 * surface. Authenticated pages are out of scope here (need seeded
 * data); they're covered by the per-flow specs that already touch
 * those routes.
 */
test.describe("axe-core public surfaces", () => {
  for (const path of ["/auth/login"]) {
    test(`${path} has no serious or critical a11y violations`, async ({
      page,
    }) => {
      await page.goto(path);
      // Wait briefly for any reduced-motion fades to settle.
      await page.waitForLoadState("networkidle");

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      const blocking = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );

      if (blocking.length > 0) {
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

      expect(blocking).toHaveLength(0);
    });
  }
});
