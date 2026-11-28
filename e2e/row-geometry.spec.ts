import { expect, test } from "./setup/test";

import { MOBILE_ROUTES_STORAGE_STATE_PATH } from "./setup/global-setup";
import heights from "./mobile-height-budgets.json";

/**
 * Rows line up (design system 2, section 3.5a).
 *
 * At 390 and 1440 px, on every route of the height budgets, every
 * `ListGroup` row is measured against its group's frame:
 *
 * - where the text column starts,
 * - where a trailing value ends, and where a trailing glyph ends,
 * - the size of the row icon,
 * - the height of a row of its type (title only, title with a meta line),
 * - the gap from the text column to the trailing glyph.
 *
 * Within one group these must agree within 1 px. They must also agree across
 * every group the run measures at that width: a row is one block, so a
 * vaccination row and a measurement row are built the same. The measure
 * points are attributes the blocks set on themselves (`data-list-group` on
 * the group, `list-item-row`, `list-item-icon`, `list-item-text`,
 * `list-item-trailing`, `list-item-glyph` on the row), so no call site can
 * move them.
 *
 * It cannot pass empty: each width must measure at least two rows.
 */
const ROUTES = Object.keys(heights.pages);
// The phone width runs in the phone project (Pixel 5, 393 px, touch), so
// the lists render their phone form; the desktop project sets 1440 px.
const WIDTHS = [
  { width: 390, height: 844, project: "chromium-mobile" },
  { width: 1440, height: 900, project: "chromium-desktop" },
];
const TOLERANCE = 1;
const MIN_ROWS = 2;

/** One row, measured against the frame of its group. */
interface RowMetrics {
  where: string;
  type: string;
  height: number;
  textLeft: number | null;
  valueRight: number | null;
  glyphRight: number | null;
  glyphGap: number | null;
  iconWidth: number | null;
  iconHeight: number | null;
}

const MEASURES: Array<[keyof RowMetrics, string]> = [
  ["valueRight", "value right edges"],
  ["glyphRight", "glyph right edges"],
  ["glyphGap", "text-to-glyph gaps"],
  ["iconWidth", "icon widths"],
  ["iconHeight", "icon heights"],
];

/** Every measure on which the rows disagree by more than the tolerance. */
function disagreements(rows: RowMetrics[], scope: string): string[] {
  const out: string[] = [];
  const spread = (values: number[]) =>
    values.length < 2 ? 0 : Math.max(...values) - Math.min(...values);
  const check = (
    label: string,
    picked: RowMetrics[],
    key: keyof RowMetrics,
  ) => {
    const values = picked
      .map((r) => r[key])
      .filter((v): v is number => typeof v === "number");
    const s = spread(values);
    if (s > TOLERANCE) {
      const at = picked
        .filter((r) => typeof r[key] === "number")
        .map((r) => `${r.where}=${(r[key] as number).toFixed(1)}`)
        .join(", ");
      out.push(`${scope}: ${label} differ by ${s.toFixed(1)} px (${at})`);
    }
  };
  // A row with an icon starts its text after the icon, so the text edge is
  // compared among rows of the same kind.
  check(
    "text left edges (with icon)",
    rows.filter((r) => r.iconWidth !== null),
    "textLeft",
  );
  check(
    "text left edges (without icon)",
    rows.filter((r) => r.iconWidth === null),
    "textLeft",
  );
  for (const [key, label] of MEASURES) check(label, rows, key);
  for (const type of ["single", "meta"]) {
    check(
      `${type} row heights`,
      rows.filter((r) => r.type === type),
      "height",
    );
  }
  return out;
}

test.describe("rows line up", () => {
  test.use({
    storageState: MOBILE_ROUTES_STORAGE_STATE_PATH,
    openFolds: false,
  });

  for (const viewport of WIDTHS) {
    test(`at ${viewport.width} px`, async ({ page }, testInfo) => {
      test.skip(
        testInfo.project.name !== viewport.project,
        `measured in ${viewport.project}`,
      );
      test.setTimeout(ROUTES.length * 30_000);
      if (viewport.project === "chromium-desktop") {
        await page.setViewportSize(viewport);
      }
      const all: RowMetrics[] = [];
      const failures: string[] = [];
      for (const route of ROUTES) {
        await page.goto(route);
        await expect(page.locator("main")).toBeVisible();
        await page.waitForLoadState("networkidle").catch(() => {});
        await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, {
          timeout: 30_000,
        });
        const groups: RowMetrics[][] = await page.evaluate((path) => {
          const box = (el: Element | null) =>
            el ? el.getBoundingClientRect() : null;
          const out: RowMetrics[][] = [];
          document
            .querySelectorAll("main [data-list-group]")
            .forEach((group, index) => {
              const g = group.getBoundingClientRect();
              if (g.width < 2 || g.height < 2) return;
              const rows = Array.from(
                group.querySelectorAll('[data-slot="list-item-row"]'),
              ).filter(
                // This group's own rows: a call site may rename the item's
                // slot, never the row's, and a nested group has its own.
                (r) =>
                  r.closest("[data-list-group]") === group &&
                  r.getBoundingClientRect().height > 1,
              );
              out.push(
                rows.map((row, n) => {
                  const part = (slot: string) =>
                    box(row.querySelector(`:scope > [data-slot="${slot}"]`));
                  const text = part("list-item-text");
                  const value = part("list-item-trailing");
                  const glyph = part("list-item-glyph");
                  const iconBox = box(
                    row.querySelector(
                      ':scope > [data-slot="list-item-icon"] > *',
                    ),
                  );
                  return {
                    where: `${path} group ${index} row ${n}`,
                    type: row.getAttribute("data-row-type") ?? "single",
                    height: row.getBoundingClientRect().height,
                    textLeft: text ? text.left - g.left : null,
                    valueRight: value ? g.right - value.right : null,
                    glyphRight: glyph ? g.right - glyph.right : null,
                    glyphGap: text && glyph ? glyph.left - text.right : null,
                    iconWidth: iconBox ? iconBox.width : null,
                    iconHeight: iconBox ? iconBox.height : null,
                  };
                }),
              );
            });
          return out;
        }, route);
        groups.forEach((rows, index) => {
          all.push(...rows);
          if (rows.length >= 2) {
            failures.push(...disagreements(rows, `${route} group ${index}`));
          }
        });
      }
      expect(
        all.length,
        `only ${all.length} rows measured at ${viewport.width} px`,
      ).toBeGreaterThanOrEqual(MIN_ROWS);
      failures.push(
        ...disagreements(all, `every group at ${viewport.width} px`),
      );
      expect(failures).toEqual([]);
    });
  }
});
