import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Recharts measures every tick label in one shared off-screen span
 * (`#recharts_measurement_span`). Under `<body>` each read cost a
 * document-wide style recalc, because the stylesheet's descendant-subject
 * `:has()` rules leave Chromium no way to scope the invalidation; on a
 * seeded dashboard that was about 1.8 s of main-thread time under a 4x CPU
 * slowdown. The chart runtime now parks the span in a contained host under
 * `<html>` (`src/components/charts/text-measurement-host.ts`).
 *
 * Pinned here, in a real engine:
 *  - the span Recharts uses is the one in the host, not a second one it
 *    created under `<body>`, including after a client-side round trip;
 *  - every string the charts drew measures exactly as it does under
 *    `<body>`, so the move cannot change a single tick or label.
 */
test.describe("chart text measurement host", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  async function assertHostInPlace(page: import("@playwright/test").Page) {
    const placement = await page.evaluate(() => {
      const spans = document.querySelectorAll("#recharts_measurement_span");
      const span = spans[0] as HTMLElement | undefined;
      return {
        count: spans.length,
        hostSlot: span?.parentElement?.dataset.slot ?? null,
        hostParent: span?.parentElement?.parentElement?.tagName ?? null,
      };
    });
    expect(placement).toEqual({
      count: 1,
      hostSlot: "chart-text-measurement-host",
      hostParent: "HTML",
    });
  }

  test("the dashboard charts measure text outside <body>, with identical results", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".recharts-wrapper").first()).toBeVisible({
      timeout: 20_000,
    });
    await assertHostInPlace(page);

    const parity = await page.evaluate(() => {
      const host = document.getElementById(
        "recharts_measurement_span",
      ) as HTMLElement;
      const reference = document.createElement("span");
      document.body.appendChild(reference);
      // Recharts' own measurement style (`getStringSize`).
      const base = {
        position: "absolute",
        top: "-20000px",
        left: "0",
        padding: "0",
        margin: "0",
        border: "none",
        whiteSpace: "pre",
      };
      const strings = [
        ...new Set(
          [...document.querySelectorAll(".recharts-wrapper text")]
            .map((el) => el.textContent ?? "")
            .filter(Boolean),
        ),
      ];
      const mismatches: string[] = [];
      for (const fontSize of ["10px", "12px", "14px"]) {
        for (const text of strings) {
          Object.assign(host.style, base, { fontSize });
          Object.assign(reference.style, base, { fontSize });
          host.textContent = text;
          reference.textContent = text;
          const a = host.getBoundingClientRect();
          const b = reference.getBoundingClientRect();
          if (a.width !== b.width || a.height !== b.height) {
            mismatches.push(`${text}@${fontSize}`);
          }
        }
      }
      reference.remove();
      return { measured: strings.length, mismatches };
    });
    // A chart with no labels would make the parity check vacuous.
    expect(parity.measured).toBeGreaterThan(0);
    expect(parity.mismatches).toEqual([]);

    // A client-side round trip re-renders the shell; the host must survive
    // it, or Recharts quietly recreates its span under <body>.
    await page.locator('a[href="/insights"]:visible').first().click();
    await page.waitForURL((url) => url.pathname === "/insights");
    await page.locator('a[href="/"]:visible').first().click();
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.locator(".recharts-wrapper").first()).toBeVisible({
      timeout: 20_000,
    });
    await assertHostInPlace(page);
  });
});
