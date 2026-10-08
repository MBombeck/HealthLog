import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { aiBlockAvailable, serveAiBlock } from "./setup/ai-capabilities";

/**
 * An add / edit dialog must not pan sideways, and nothing you have to operate
 * may sit outside its visible box.
 *
 * A report named four surfaces — measurements add, mood add, the medication
 * intake editor, the cycle log sheet — and four surfaces sharing one symptom
 * is one defect in something shared, not four. Two shared mechanisms were
 * behind it, and this spec pins the outcome of both rather than either
 * implementation:
 *
 *   1. `<DateField>` / `<TimeField>` wrap a text `<input>`. A flex item's
 *      `min-width: auto` resolves to a content-based minimum, and for a text
 *      input that minimum is its intrinsic `size` (20 characters, ~180 px).
 *      The date + time row therefore demanded ~470 px inside a 400 px dialog
 *      body and put the clock button ~58 px past the right edge — the picker
 *      was not merely ugly, it was unreachable without scrolling sideways.
 *
 *   2. The body scrolls (`overflow-y-auto`), and CSS promotes the OTHER axis
 *      from `visible` to `auto`. So every intentional outward bleed in the
 *      tree — `<SheetSection>`'s trigger row, `<Switch>`'s `inset-[-13px]`
 *      hit-target pseudo — turned the whole form into a horizontally
 *      scrollable surface. That is why the desktop dialog showed two
 *      scrollbars while the phone sheet, whose body has padding, looked fine.
 *
 * The two assertions map onto the two harms and neither is a restatement of a
 * class name:
 *
 *   - `expectNoSidewaysScroll` — the surface is not a horizontal scroll
 *     container. Fails against mechanism 2 (the axis was promoted to `auto`).
 *   - `expectControlsInsideBox` — every focusable control is within the
 *     surface's visible content box. Fails against mechanism 1 (the clock
 *     button was outside it), and keeps failing if a future change clips a
 *     control out of sight instead of fitting it.
 *
 * Both widths run: the defect was desktop-only for the date/time row, and the
 * phone sheet is the branch where a regression would be least visible.
 *
 * NOT covered here: the medication intake editor and the cycle log sheet, the
 * other two reported surfaces. Both need account state the shared fixture does
 * not carry (a medication with a logged dose; a profile with cycle tracking
 * on), and a spec that silently measures an empty page proves nothing. They
 * share the primitives asserted below — `<ResponsiveSheet>` + `<DateTimeField>`
 * for the editor, `<ResponsiveSheet>` + `<SheetSection>` for the log sheet —
 * so a regression in either mechanism surfaces here first.
 */

const SURFACE =
  '[data-slot="responsive-sheet-content"], [data-slot="dialog-content"]';
const BODY = '[data-slot="responsive-sheet-body"]';

interface DialogCase {
  name: string;
  path: string;
  /** Accessible name of the control that opens the dialog. */
  trigger: RegExp;
  /** Reach the state the report describes, when the form does not open in it. */
  prepare?: (page: import("@playwright/test").Page) => Promise<void>;
  /** Something inside the dialog that proves it rendered its form, not a shell. */
  ready: string;
  /** Render in this locale instead of the suite's pinned English. */
  locale?: "de";
}

const DIALOGS: DialogCase[] = [
  {
    name: "measurements add",
    path: "/measurements",
    // While a list is empty the header drops its add button and the empty
    // state carries the action, so either one opens the dialog.
    trigger: /^(add|add your first measurement)$/i,
    ready: '[data-slot="date-time-field"]',
  },
  {
    name: "mood add",
    path: "/mood",
    trigger: /^(add|log your first mood)$/i,
    // The mood sheet opens on the five-face quick check; the timestamp row
    // (and everything else) appears once a face is picked. Measuring the
    // quick check alone would measure a sheet that has almost nothing in it.
    prepare: async (page) => {
      await page.locator('[data-slot="mood-face"]').first().click();
      await page
        .locator('[data-slot="mood-annotate-panel"]')
        .first()
        .waitFor({ state: "visible" });
    },
    ready: '[data-slot="date-time-field"]',
  },
  {
    name: "labs add",
    path: "/labs",
    trigger: /^(add|add your first result)$/i,
    ready: '[data-slot="date-time-field"]',
  },
  // The labs sheet's footer holds three buttons (Cancel, Save & add another,
  // Save). They fit a phone row in English; the German labels are ~100px
  // wider and pushed Cancel off the sheet's left edge, at every width.
  {
    name: "labs add (German)",
    path: "/labs",
    trigger: /^(hinzufügen|ersten wert erfassen)$/i,
    ready: '[data-slot="date-time-field"]',
    locale: "de",
  },
];

const VIEWPORTS = [
  { label: "desktop 1280", width: 1280, height: 800 },
  { label: "phone 390", width: 390, height: 844 },
  // The narrowest common Android width.
  { label: "phone 360", width: 360, height: 780 },
];

/**
 * The surface and its scrolling body must not be horizontal scroll
 * containers. Read from the COMPUTED style, because the promotion that caused
 * the defect happens in the cascade and is invisible in the class list.
 */
async function expectNoSidewaysScroll(
  page: import("@playwright/test").Page,
  label: string,
): Promise<void> {
  const boxes = await page.evaluate(
    ([surfaceSel, bodySel]) => {
      const nodes = [
        ...document.querySelectorAll<HTMLElement>(surfaceSel),
        ...document.querySelectorAll<HTMLElement>(bodySel),
      ];
      return nodes.map((el) => ({
        slot: el.dataset.slot ?? el.tagName.toLowerCase(),
        overflowX: getComputedStyle(el).overflowX,
      }));
    },
    [SURFACE, BODY] as const,
  );

  expect(
    boxes.length,
    `${label}: no dialog surface found to measure`,
  ).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(
      ["auto", "scroll"].includes(box.overflowX),
      `${label}: ${box.slot} computes overflow-x:${box.overflowX} — the surface can be panned sideways`,
    ).toBe(false);
  }
}

/**
 * No focusable control may lie outside the surface's visible content box.
 * This is the reachability claim: a picker pushed past the edge (or clipped
 * out of sight by a later "fix") fails here regardless of how the layout got
 * there.
 */
async function expectControlsInsideBox(
  page: import("@playwright/test").Page,
  label: string,
): Promise<void> {
  const result = await page.evaluate((surfaceSel) => {
    const surface = document.querySelector<HTMLElement>(surfaceSel);
    if (!surface) return null;
    const box = surface.getBoundingClientRect();
    // The visible content box: `clientWidth` excludes a vertical scrollbar,
    // so a control hidden behind one counts as outside.
    const visibleRight = box.left + surface.clientWidth;
    const controls = [
      ...surface.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ];
    const outside = controls
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el, r };
      })
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .filter(({ r }) => r.right > visibleRight + 1 || r.left < box.left - 1)
      .map(({ el, r }) => ({
        tag: el.tagName.toLowerCase(),
        slot: el.dataset.slot ?? null,
        label:
          el.getAttribute("aria-label") ??
          el.textContent?.trim().slice(0, 30) ??
          "",
        left: Math.round(r.left),
        right: Math.round(r.right),
      }));
    return {
      controlCount: controls.length,
      surfaceLeft: Math.round(box.left),
      visibleRight: Math.round(visibleRight),
      outside,
    };
  }, SURFACE);

  expect(result, `${label}: dialog surface not found`).not.toBeNull();
  // Guard the guard: a dialog with no controls would pass vacuously.
  expect(
    result!.controlCount,
    `${label}: the dialog rendered no focusable controls, so this assertion proves nothing`,
  ).toBeGreaterThan(2);
  expect(
    result!.outside,
    `${label}: control(s) outside the dialog's visible box [${result!.surfaceLeft}..${result!.visibleRight}]`,
  ).toEqual([]);
}

test.describe("add/edit dialogs do not scroll sideways", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  for (const vp of VIEWPORTS) {
    for (const dialog of DIALOGS) {
      test(`${dialog.name} fits its surface at ${vp.label}`, async ({
        page,
        context,
      }, testInfo) => {
        if (dialog.locale) {
          await context.addCookies([
            {
              name: "healthlog-locale",
              value: dialog.locale,
              url: testInfo.project.use.baseURL ?? "http://localhost:3000",
            },
          ]);
        }
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(dialog.path, { waitUntil: "domcontentloaded" });

        await page
          .getByRole("button", { name: dialog.trigger })
          .first()
          .click();

        const surface = page.locator(SURFACE).first();
        await expect(surface).toBeVisible();
        await dialog.prepare?.(page);
        // Gate on the form's own content, not the shell: the surface mounts
        // before the fields do, and measuring the empty frame would pass
        // against exactly the layout this spec exists to catch.
        await expect(surface.locator(dialog.ready).first()).toBeVisible();

        const label = `${dialog.name} @${vp.label}`;
        await expectNoSidewaysScroll(page, label);
        await expectControlsInsideBox(page, label);
      });
    }
  }

  /**
   * The reachability assertion has to be able to FAIL, or the six tests above
   * are decoration. Inject a control that deliberately sits past the right
   * edge and assert the helper reports it — the same shape the time-field
   * button had before the fix.
   */
  test("the reachability check detects a control pushed past the edge", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/measurements", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /^add$/i }).first().click();

    const surface = page.locator(SURFACE).first();
    await expect(surface).toBeVisible();
    await expect(
      surface.locator('[data-slot="date-time-field"]').first(),
    ).toBeVisible();

    await page.evaluate((surfaceSel) => {
      const el = document.querySelector<HTMLElement>(surfaceSel)!;
      const probe = document.createElement("button");
      probe.id = "reach-canary";
      probe.textContent = "canary";
      probe.style.position = "absolute";
      probe.style.left = `${el.clientWidth + 40}px`;
      probe.style.top = "0";
      probe.style.width = "30px";
      probe.style.height = "30px";
      el.appendChild(probe);
    }, SURFACE);

    await expect(
      page.locator(`${SURFACE} #reach-canary`).first(),
      "the canary is not inside the dialog — the fixture failed, not the helper",
    ).toBeAttached();

    await expect(expectControlsInsideBox(page, "canary probe")).rejects.toThrow(
      /outside the dialog's visible box/,
    );
  });
});

/**
 * The lab-scan review stage is a list of readings to compare and correct, so
 * it takes the room a large screen offers while phones keep the bottom sheet.
 * Measured at the widths that matter: a phone, a tablet, the shared 1280 px
 * frame, full HD and an ultrawide.
 *
 * The rows lay themselves out from the width of the dialog (a container
 * query), so the assertion is about the RESULT: where the reading and its
 * fields sit relative to each other, not which class produced it.
 */
const REVIEW_VIEWPORTS = [
  {
    label: "phone 390",
    width: 390,
    height: 844,
    wide: false,
    threeAcross: false,
  },
  // Below the window `sm` breakpoint (640 px) yet with a dialog body well past
  // the container `@md` breakpoint (448 px): the fields have room for three
  // columns even though the window is "small". This is the width that tells
  // "follows the dialog" from "follows the window".
  {
    label: "small tablet 560",
    width: 560,
    height: 900,
    wide: false,
    threeAcross: true,
  },
  {
    label: "tablet 768",
    width: 768,
    height: 1024,
    wide: false,
    threeAcross: true,
  },
  {
    label: "desktop 1280",
    width: 1280,
    height: 800,
    wide: true,
    threeAcross: true,
  },
  {
    label: "full HD 1920",
    width: 1920,
    height: 1080,
    wide: true,
    threeAcross: true,
  },
  {
    label: "ultrawide 3440",
    width: 3440,
    height: 1440,
    wide: true,
    threeAcross: true,
  },
];

const REVIEW_ROWS = ["LDL", "HDL", "Glucose", "Creatinine", "ALT", "CRP"].map(
  (analyte, index) => ({
    analyte,
    value: 1 + index,
    valueText: null,
    unit: "mmol/L",
    referenceLow: 0,
    referenceHigh: 5,
    referenceText: "0 - 5",
    takenAt: index === 0 ? null : "2026-06-10",
    confidence: { analyte: 0.9, value: 0.9, unit: 0.9, range: 0.9 },
    biomarkerMatch: "existing",
    markerUnit: "mmol/L",
    duplicateOf: null,
  }),
);

// One pixel: enough to be a valid image for the picker, and never decoded.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("lab-scan review dialog uses the width it is given", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  for (const vp of REVIEW_VIEWPORTS) {
    test(`review stage @${vp.label}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await serveAiBlock(page, aiBlockAvailable());
      await page.route("**/api/labs/ocr/capability", (route) =>
        route.fulfill({
          json: {
            data: {
              available: true,
              mode: "vision",
              reason: null,
              pdfSupported: true,
            },
            error: null,
          },
        }),
      );
      await page.route("**/api/labs/ocr/extract", (route) =>
        route.fulfill({
          json: {
            data: {
              reportDate: null,
              providerType: "stub",
              rows: REVIEW_ROWS,
            },
            error: null,
          },
        }),
      );

      await page.goto("/labs", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: /^add$/i }).first().click();
      await page.getByRole("menuitem", { name: /scan/i }).click();

      const surface = page.locator(SURFACE).first();
      await expect(surface).toBeVisible();

      // The picking stage is a single control and stays narrow.
      const pickWidth = (await surface.boundingBox())!.width;
      if (!vp.wide) expect(pickWidth).toBeLessThanOrEqual(vp.width);
      else expect(pickWidth).toBeLessThan(500);

      await page.locator('input[type="file"]').first().setInputFiles({
        name: "report.png",
        mimeType: "image/png",
        buffer: PIXEL_PNG,
      });
      const rows = surface.locator("input[id$='-val']");
      await expect(rows.first()).toBeVisible();
      await expect(rows).toHaveCount(REVIEW_ROWS.length);

      const label = `scan review @${vp.label}`;
      // The sheet widens from the picking stage to the review stage, and on a
      // phone or small tablet it also slides up from the bottom. Measuring
      // while either runs compares fields from different frames (the width
      // settles before the slide ends, so waiting on width alone was not
      // enough). Wait for every running animation and transition to finish,
      // then for the surface to hold still across two frames.
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .map((animation) => animation.finished.catch(() => undefined)),
        ),
      );
      await expect
        .poll(
          async () => {
            const before = (await surface.boundingBox())!;
            await page.evaluate(
              () =>
                new Promise<void>((resolve) =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve()),
                  ),
                ),
            );
            const after = (await surface.boundingBox())!;
            return (
              Math.abs(after.width - before.width) +
              Math.abs(after.y - before.y)
            );
          },
          { message: `${label}: dialog settles` },
        )
        .toBeLessThan(0.5);
      await expectNoSidewaysScroll(page, label);
      await expectControlsInsideBox(page, label);

      const box = (await surface.boundingBox())!;
      const analyte = (await surface
        .getByLabel("Test name")
        .first()
        .boundingBox())!;
      const value = (await rows.first().boundingBox())!;
      const unit = (await surface
        .locator("input[id$='-unit']")
        .first()
        .boundingBox())!;
      const date = (await surface
        .locator('[data-slot="date-field"]')
        .first()
        .boundingBox())!;

      // Value, unit and date share a line when the fields have room for three
      // columns, and the date wraps under them when they do not.
      // "Beside" means the same grid row: to the right of the value and
      // starting above the value's bottom edge. Comparing the tops alone was
      // too strict, because a field label that wraps onto a second line (it
      // depends on the runner's font metrics) moves that field's input down
      // by one line while it stays in the same row.
      const besideValue = (field: { x: number; y: number }, name: string) => {
        expect(field.x, `${label}: ${name} right of value`).toBeGreaterThan(
          value.x,
        );
        expect(field.y, `${label}: ${name} in the value's row`).toBeLessThan(
          value.y + value.height,
        );
      };
      if (vp.threeAcross) {
        besideValue(unit, "unit");
        besideValue(date, "date");
      } else {
        besideValue(unit, "unit");
        expect(date.y, `${label}: date wraps`).toBeGreaterThan(
          value.y + value.height - 1,
        );
      }

      if (vp.wide) {
        // Room to compare: clearly wider than the old 448 px column, and never
        // past the readable cap (72rem = 1152 px).
        expect(box.width, `${label}: dialog width`).toBeGreaterThan(700);
        expect(box.width, `${label}: dialog width`).toBeLessThanOrEqual(1153);
        // The reading and its fields share a line: the value sits to the right
        // of the analyte, not underneath it.
        expect(value.x, `${label}: value beside analyte`).toBeGreaterThan(
          analyte.x + analyte.width - 1,
        );
        expect(Math.abs(value.y - analyte.y)).toBeLessThan(80);
      } else {
        // Narrow: stacked exactly as before.
        expect(value.y, `${label}: value under analyte`).toBeGreaterThan(
          analyte.y + analyte.height - 1,
        );
      }
    });
  }
});
