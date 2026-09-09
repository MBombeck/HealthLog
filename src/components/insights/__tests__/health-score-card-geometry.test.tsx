import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Browser, Page } from "@playwright/test";

import { I18nProvider } from "@/lib/i18n/context";
import { locales, type Locale } from "@/lib/i18n/config";
import type {
  HealthScoreReport,
  ScorePillarResult,
} from "@/lib/analytics/score/types";
import { SCORE_VERSION } from "@/lib/analytics/score/types";
import { HeroStrip } from "../hero-strip";

/**
 * The hero band's geometry, measured rather than asserted from source.
 *
 * Two numbers in `health-score-card.tsx` cannot be checked by reading the
 * file: the height the loading reserve holds, and the width of the row's
 * label column. Both were carried for a while as docblock claims with no way
 * to reproduce them. This file is that way: it renders the REAL band with the
 * REAL compiled stylesheet, lays it out in a browser at the real column
 * width, and reads the boxes back.
 *
 * What it does NOT do is pretend to know the shipped typeface. The app loads
 * Inter through `next/font/google` at build time; no font file is committed,
 * so a headless browser here resolves the `font-sans` fallback chain instead.
 * Every assertion below is therefore written to be font-independent — a
 * relative comparison inside one run, or a structural property (does the row
 * push, does the label ellipsise, is the bar still there) that holds in any
 * typeface. The absolute pixel numbers this file prints are true of the run
 * that printed them and are reported as such, never baked into a comment as
 * if they were a property of the design.
 *
 * It needs a Chromium build, and under CI it IS the gate: the quality job
 * installs the headless shell before the unit suite, and a launch failure
 * there fails this suite instead of skipping it. That is the whole point —
 * until v1.38 the job installed no browsers, every run caught the launch
 * error and passed, and the check had never measured anything in CI. On a
 * developer machine without a browser it still skips, loudly, so that
 * `pnpm test` stays usable; run `pnpm exec playwright install --only-shell
 * chromium` once to measure for real.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { unitPreference: "metric", glucoseUnit: "mg/dL" } }),
}));

/** The `md` column: `md:basis-[22rem]`, i.e. 352 CSS px. */
const COLUMN_PX = 352;
/** Wide enough for the two-column split, narrow enough to stay below `xl`. */
const VIEWPORT_PX = 1024;
/** One `text-xs` row is a 16 px line; two lines would exceed this. */
const ONE_LINE_PX = 20;
/**
 * The row's info trigger carries `-mx-2` so its 44 px tap target does not
 * inflate a 20 px row: it reaches 8 px into the card's own padding on each
 * side, which is deliberate and stays inside the panel. Anything past that is
 * a real push, so the row check allows exactly this much and no more.
 */
const TAP_TARGET_OVERHANG_PX = 8;

const require = createRequire(import.meta.url);

/**
 * Compile `globals.css` the way the app does.
 *
 * `postcss` is not a direct dependency — it arrives under the Tailwind
 * PostCSS plugin, which is. Resolving it from that plugin's own location is
 * what keeps this working under pnpm's strict layout without adding a
 * dependency for a check.
 */
async function compileStylesheet(): Promise<string> {
  const pluginEntry = require.resolve("@tailwindcss/postcss");
  const postcss = require(require.resolve("postcss", { paths: [pluginEntry] }));
  const tailwind = require(pluginEntry);
  const fs = await import("node:fs/promises");
  const source = await fs.readFile("src/app/globals.css", "utf8");
  const plugin = tailwind.default ? tailwind.default() : tailwind();
  const result = await postcss([plugin]).process(source, {
    from: "src/app/globals.css",
  });
  return result.css;
}

const provenance = {
  inputs: ["BLOOD_PRESSURE"],
  source: "live" as const,
  windowDays: 90,
  computedAt: "2026-07-28T12:00:00.000Z",
};

const coverage = {
  requiredInputs: 3,
  presentInputs: 3,
  historyDays: 28,
  missing: [] as string[],
};

function scored(id: string, score: number): ScorePillarResult {
  return {
    id,
    domain: "cardiometabolic",
    result: {
      status: "ok",
      value: {
        score,
        observed: {
          value: 126,
          unit: "mmHg",
          label: "126/78 mmHg",
          asOf: "2026-07-27T08:00:00.000Z",
          sources: ["MANUAL"],
        },
        reference: {
          kind: "clinical-threshold",
          low: 120,
          high: 129,
          label: "120 to 129/70 to 79 mmHg",
          source: "ESH 2023",
        },
        noiseFloor: 1,
        deltaEligible: true,
        deltaIdentity: `pillar_${id}`,
      },
      coverage,
      confidence: { score: 100, band: "high" },
      provenance,
    },
  } as ScorePillarResult;
}

/** Every pillar id, so each locale is measured on its own longest label. */
const ALL_PILLARS = [
  "BLOOD_PRESSURE",
  "GLYCAEMIA",
  "ACTIVITY",
  "SLEEP",
  "ADIPOSITY",
  "WELLBEING",
  "LIPIDS",
] as const;

function reportWith(pillars: ScorePillarResult[]): HealthScoreReport {
  return {
    composite: {
      status: "ok",
      value: {
        score: 74,
        band: "green",
        bandSetter: null,
        composition: pillars.map((p) => p.id),
        configured: false,
        noiseFloor: 3,
        scoreVersion: SCORE_VERSION,
      },
      coverage,
      confidence: { score: 100, band: "high" },
      provenance,
    },
    pillars,
    delta: 2,
    deltaReason: null,
    scoreVersion: SCORE_VERSION,
    weightGoal: {
      status: "insufficient",
      coverage: {
        requiredInputs: 2,
        presentInputs: 0,
        historyDays: 0,
        missing: [],
      },
      provenance: { ...provenance, inputs: ["WEIGHT"] },
      reason: "no_personal_goal",
    },
    algorithmNotice: null,
  } as HealthScoreReport;
}

/** N scored rows, the shape the report actually produces (3 to 6, per §5). */
function reportWithRows(rows: number): HealthScoreReport {
  return reportWith(
    ALL_PILLARS.slice(0, rows).map((id, i) => scored(id, 80 - i * 4)),
  );
}

/**
 * v1.38 — the same panel, plus the basis line a narrow score carries.
 *
 * It is the one block the milestone adds to the at-rest column, and it
 * lands on the shortest panels: an account with one or two areas of
 * health has few rows, so this is the shape that decides whether the
 * reserve still brackets what the report produces.
 */
function reportWithBasis(rows: number): HealthScoreReport {
  const report = reportWithRows(rows);
  if (report.composite.status !== "ok") {
    throw new Error("fixture is not scored");
  }
  report.composite.value.scoreBasis = {
    domains: 1,
    recommended: 3,
    tier: "minimal",
    physiological: true,
  };
  return report;
}

function band(node: React.ReactNode, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

let browser: Browser | null = null;
let page: Page | null = null;
let stylesheet = "";
let skipReason: string | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch();
  } catch (error) {
    const reason = `no Chromium build available (${String(error).slice(0, 200)})`;
    // In CI the browser is installed by the job that runs the suite, so a
    // launch failure is the job being wrong, not the machine being bare.
    // Throwing from the hook fails every test in this suite: a geometry check
    // that quietly skips is the same thing as no geometry check, and this repo
    // shipped exactly that for months because the skip only ever reached a
    // console line nobody reads.
    //
    // TWO jobs run `pnpm test`, and naming only one of them here sent a reader
    // to a workflow that was already correct: the quality job in
    // `security.yml` and the auto-merge job in `dependabot-auto-merge.yml`.
    // The second had no install step for three days after this check started
    // failing instead of skipping, and turned every dependency bump red.
    if (process.env.CI) {
      throw new Error(
        `[hero geometry] ${reason}. This check is the gate in CI and it has no browser to measure with. ` +
          `Add the "pnpm exec playwright install --only-shell chromium" step to whichever job ran this suite — ` +
          `the quality job of .github/workflows/security.yml, or the auto-merge job of .github/workflows/dependabot-auto-merge.yml.`,
      );
    }
    skipReason = reason;
    console.warn(`[hero geometry] SKIPPED — ${skipReason}`);
    return;
  }
  stylesheet = await compileStylesheet();
  page = await browser.newPage({
    viewport: { width: VIEWPORT_PX, height: 1200 },
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** Lay the rendered band out and hand the page back for measuring. */
async function layout(html: string, width = VIEWPORT_PX): Promise<Page> {
  const target = page;
  if (!target) throw new Error("browser page was never created");
  await target.setContent(
    `<!doctype html><html class="dark"><body class="font-sans bg-background" style="margin:0">
       <div style="width:${width}px">${html}</div>
     </body></html>`,
  );
  await target.addStyleTag({ content: stylesheet });
  return target;
}

const PANEL = '[data-slot="health-score-card"]';
const RESERVE = '[data-slot="health-score-card-skeleton"]';

describe("hero band geometry", () => {
  it("holds a reserve that sits inside the range the real report produces", async (ctx) => {
    if (skipReason) ctx.skip(skipReason);

    const heights: Record<string, number> = {};
    const shapes: { key: string; report: HealthScoreReport }[] = [
      ...[3, 4, 5, 6].map((rows) => ({
        key: `rows${rows}`,
        report: reportWithRows(rows),
      })),
      // The narrow account: three rows AND the basis line. Measured
      // rather than reasoned about, because whether one extra `text-xs`
      // line pushes a three-row panel past the reserve is a fact about
      // the compiled stylesheet, not about the diff.
      { key: "rows3basis", report: reportWithBasis(3) },
    ];
    for (const shape of shapes) {
      const view = await layout(
        band(
          <HeroStrip
            briefing={null}
            now={new Date("2026-05-10T07:00:00Z")}
            healthScore={shape.report}
          />,
        ),
      );
      heights[shape.key] = await view
        .locator(PANEL)
        .evaluate((el) => Math.round(el.getBoundingClientRect().height));
      const width = await view
        .locator(PANEL)
        .evaluate((el) => Math.round(el.getBoundingClientRect().width));
      expect(width, "the panel is not on the md column width").toBe(COLUMN_PX);
    }

    const view = await layout(
      band(
        <HeroStrip
          briefing={null}
          now={new Date("2026-05-10T07:00:00Z")}
          scorePending
        />,
      ),
    );
    // Measured twice: as it renders, and with the declared minimum removed.
    // If the two agree, the constant is decoration and the reserve is really
    // whatever its blocks happen to add up to — which is how a reserve drifts
    // without anyone touching the number that claims to own it.
    const { reserve, natural } = await view.locator(RESERVE).evaluate((el) => {
      const rendered = Math.round(el.getBoundingClientRect().height);
      const declared = el.style.minHeight;
      (el as HTMLElement).style.minHeight = "0px";
      const content = Math.round(el.getBoundingClientRect().height);
      (el as HTMLElement).style.minHeight = declared;
      return { reserve: rendered, natural: content };
    });

    console.info(
      `[hero geometry] column ${COLUMN_PX}px · panel ${JSON.stringify(heights)} · reserve ${reserve}px (blocks alone ${natural}px)`,
    );

    expect(
      natural,
      `the reserve's own blocks are ${natural}px, so the declared minimum never binds and the reserve is whatever the blocks happen to be`,
    ).toBeLessThan(reserve);

    // The reserve cannot match every report, so it must not be one-sided: a
    // three-row account may not be pushed down, a six-row account may not be
    // left with a gap that collapses. Between the two is the whole rule.
    expect(
      reserve,
      `reserve ${reserve}px is below a three-row panel (${heights.rows3}px): a short report gets pushed`,
    ).toBeGreaterThanOrEqual(heights.rows3);
    expect(
      reserve,
      `reserve ${reserve}px is above a six-row panel (${heights.rows6}px): a long report leaves a collapsing gap`,
    ).toBeLessThanOrEqual(heights.rows6);
    // v1.38 — the narrow account has to sit inside the same range. The
    // basis line only ever renders on a panel below the recommended
    // breadth, so this is the tallest the shortest report can get.
    expect(
      heights.rows3basis,
      `a three-row panel with the basis line is ${heights.rows3basis}px, past the tallest report the reserve brackets (${heights.rows6}px)`,
    ).toBeLessThanOrEqual(heights.rows6);
  }, 60_000);

  it("keeps every row on one line in every locale", async (ctx) => {
    if (skipReason) ctx.skip(skipReason);

    const widest: Record<string, { label: string; natural: number }> = {};

    for (const locale of locales) {
      const view = await layout(
        band(
          <HeroStrip
            briefing={null}
            now={new Date("2026-05-10T07:00:00Z")}
            healthScore={reportWith(
              ALL_PILLARS.map((id, i) => scored(id, 80 - i * 4)),
            )}
          />,
          locale,
        ),
      );

      const rows = await view.locator(`${PANEL} li[data-status="ok"]`).all();
      expect(rows.length, `${locale}: no rows to measure`).toBe(
        ALL_PILLARS.length,
      );

      let localeWidest = { label: "", natural: 0 };
      for (const row of rows) {
        const m = await row.evaluate((el) => {
          const label = el.querySelector("span");
          const bar = el.querySelector(
            '[data-slot="health-score-pillar-bar"]',
          )?.parentElement;
          const value = el.querySelectorAll("span")[1];
          // The natural width the label would take if nothing constrained it.
          const probe = document.createElement("span");
          probe.textContent = label?.textContent ?? "";
          probe.style.cssText =
            "position:absolute;visibility:hidden;white-space:nowrap;width:max-content";
          probe.className = label?.className ?? "";
          document.body.appendChild(probe);
          const natural = Math.ceil(probe.getBoundingClientRect().width);
          probe.remove();
          return {
            id: el.getAttribute("data-pillar") ?? "",
            text: label?.textContent ?? "",
            natural,
            labelWidth: Math.round(label?.getBoundingClientRect().width ?? 0),
            labelHeight: Math.round(label?.getBoundingClientRect().height ?? 0),
            labelOverflow: label
              ? getComputedStyle(label).textOverflow
              : "none",
            barWidth: Math.round(bar?.getBoundingClientRect().width ?? 0),
            valueScroll: value?.scrollWidth ?? 0,
            valueClient: value?.clientWidth ?? 0,
            rowScroll: el.scrollWidth,
            rowClient: el.clientWidth,
          };
        });

        // The row is the invariant, not the label: a long name may ellipsise,
        // but it may never widen the row or wrap it onto a second line. Drop
        // `min-w-0` or `truncate` from the label and the first grid track
        // grows to the longest word instead, which is exactly this.
        expect(
          m.rowScroll,
          `${locale}/${m.id}: the row is pushed wider than its column by "${m.text}"`,
        ).toBeLessThanOrEqual(m.rowClient + TAP_TARGET_OVERHANG_PX);
        expect(
          m.labelWidth,
          `${locale}/${m.id}: the label track grew past 7rem for "${m.text}"`,
        ).toBeLessThanOrEqual(112 + 1);
        expect(
          m.labelHeight,
          `${locale}/${m.id}: "${m.text}" wrapped onto a second line`,
        ).toBeLessThanOrEqual(ONE_LINE_PX);
        expect(
          m.labelOverflow,
          `${locale}/${m.id}: "${m.text}" is cut without an ellipsis`,
        ).toBe("ellipsis");
        // The label column may not eat the two things the row exists to show.
        expect(
          m.barWidth,
          `${locale}/${m.id}: the fill bar was squeezed out by the label column`,
        ).toBeGreaterThan(24);
        expect(
          m.valueScroll,
          `${locale}/${m.id}: the score itself is truncated`,
        ).toBeLessThanOrEqual(m.valueClient + 1);

        if (m.natural > localeWidest.natural) {
          localeWidest = { label: m.text, natural: m.natural };
        }
      }
      widest[locale] = localeWidest;
    }

    // Reported, never asserted: these widths are the measuring browser's
    // fallback typeface, not the shipped Inter, so they say how much room the
    // longest name wants in THIS run — not a pixel budget the design owns.
    console.info(
      `[hero geometry] longest label per locale against a 112px column: ${Object.entries(
        widest,
      )
        .map(([l, w]) => `${l} "${w.label}" ${w.natural}px`)
        .join(" · ")}`,
    );
  }, 60_000);

  it.for([
    { width: VIEWPORT_PX, where: "the md column" },
    { width: 360, where: "a 360px phone, stacked under the greeting" },
  ])(
    "never scrolls sideways in $where",
    { timeout: 60_000 },
    async ({ width }, ctx) => {
      if (skipReason) ctx.skip(skipReason);

      const target = page!;
      await target.setViewportSize({ width, height: 1200 });
      // French carries the longest pillar names of the six, so it is the
      // width-worst case rather than an arbitrary pick.
      const view = await layout(
        band(
          <HeroStrip
            briefing={null}
            now={new Date("2026-05-10T07:00:00Z")}
            healthScore={reportWith(
              ALL_PILLARS.map((id, i) => scored(id, 80 - i * 4)),
            )}
          />,
          "fr",
        ),
        width,
      );

      const m = await view.locator(PANEL).evaluate((el) => {
        let widest = 0;
        let culprit = "";
        for (const child of Array.from(el.querySelectorAll("*"))) {
          const w = child.getBoundingClientRect().width;
          if (w > widest) {
            widest = w;
            culprit = child.getAttribute("data-slot") ?? child.className;
          }
        }
        const strip = el.closest('[data-slot="insights-hero-strip"]')!;
        const stripBox = getComputedStyle(strip);
        return {
          scroll: el.scrollWidth,
          client: el.clientWidth,
          width: Math.round(el.getBoundingClientRect().width),
          widest: Math.round(widest),
          culprit: String(culprit).slice(0, 60),
          // The width the band actually offers, padding taken off.
          available: Math.round(
            strip.getBoundingClientRect().width -
              parseFloat(stripBox.paddingLeft) -
              parseFloat(stripBox.paddingRight),
          ),
          docScroll: document.documentElement.scrollWidth,
          docClient: document.documentElement.clientWidth,
        };
      });

      expect(
        m.scroll,
        `the panel scrolls its own content: ${JSON.stringify(m)}`,
      ).toBeLessThanOrEqual(m.client + 1);
      expect(
        m.widest,
        `a child is wider than the panel: ${JSON.stringify(m)}`,
      ).toBeLessThanOrEqual(m.client + 1);
      // The panel against the room the band gives it. This is the assertion
      // that has to carry the phone case: the band wears `overflow-hidden`
      // for its glow, so a panel wider than the band is silently CLIPPED
      // rather than scrolled, and the document check below stays green while
      // a person loses the right-hand end of every row.
      expect(
        m.width,
        `the panel is wider than the band gives it: ${JSON.stringify(m)}`,
      ).toBeLessThanOrEqual(m.available + 1);
      // Kept anyway, for anything that escapes the band's clip.
      expect(
        m.docScroll,
        `the page scrolls sideways: ${JSON.stringify(m)}`,
      ).toBeLessThanOrEqual(m.docClient + 1);

      await target.setViewportSize({ width: VIEWPORT_PX, height: 1200 });
    },
  );
});
