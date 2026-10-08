import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.12.4 — canonical metric-detail spine guard.
 *
 * v1.12.6 — the unified subpage spine is: intro → stat strip → chart →
 * target card → assessment. The stat strip moved ABOVE the chart (the
 * shell renders the `statStrip` prop before `children`); the assessment
 * stays the LAST content block the page hands to `<SubPageShell>` as
 * `children`. This source-order guard is unaffected by the render-position
 * move because `statStrip` is a prop on the opening tag and the assessment
 * is still the final child element. The generic `HealthKitMetricPage` scaffold enforces
 * this for the ~29 HealthKit pages structurally; the bespoke pages each
 * hand-write their body, so a future edit can silently slot a card after the
 * assessment (as `mood` and `medications` did before).
 *
 * This is a source-level structural guard:
 *   1. the assessment card element is the last JSX child of `<SubPageShell>`;
 *   2. the target card (`MetricTargetSummary`) precedes the assessment;
 *   3. the retired range row (`MetricRangeControls`) and the retired
 *      "Letzte Messung" card (`MetricLastMeasurementCard`) appear nowhere.
 *
 * Asserting on the source (rather than rendered markup) keeps the test
 * deterministic — the preceding blocks all self-suppress on a data miss, so a
 * render-order assertion would depend on mocking the whole data layer.
 */

const PAGES_DIR = join(process.cwd(), "src", "app", "insights");

// Each bespoke page + the element that mounts its assessment card. The five
// `useInsightStatus`-backed pages render `<SlugInsightStatusCard>`; the
// medications page reads the richer `summary`-shaped route inline, so it
// renders `<InsightStatusCard>` directly.
const BESPOKE_PAGES: ReadonlyArray<{
  slug: string;
  assessmentTag: string;
  /**
   * v1.12.8 — pulse intentionally trails its assessment with the
   * cardio-fitness CTA (the operator-requested "Einschätzung above the VO₂
   * max cross-link" order). The CTA is a navigation affordance, not a data
   * card, so it is the one sanctioned block that may render after the
   * assessment; the guard skips the last-block check for these slugs but
   * still enforces that the target card precedes the assessment.
   */
  assessmentMayTrail?: boolean;
}> = [
  { slug: "weight", assessmentTag: "<SlugInsightStatusCard" },
  { slug: "bmi", assessmentTag: "<SlugInsightStatusCard" },
  {
    slug: "pulse",
    assessmentTag: "<SlugInsightStatusCard",
    assessmentMayTrail: true,
  },
  { slug: "blood-pressure", assessmentTag: "<SlugInsightStatusCard" },
  { slug: "mood", assessmentTag: "<SlugInsightStatusCard" },
  { slug: "medications", assessmentTag: "<InsightStatusCard" },
];

describe("bespoke metric-detail spine — assessment is the last block", () => {
  for (const { slug, assessmentTag, assessmentMayTrail } of BESPOKE_PAGES) {
    it(`renders the assessment card as the last SubPageShell child on /insights/${slug}`, () => {
      // A page split into an RSC prefetch wrapper and its client body keeps
      // the spine in the client file.
      const client = join(PAGES_DIR, slug, "page-client.tsx");
      const source = readFileSync(
        existsSync(client) ? client : join(PAGES_DIR, slug, "page.tsx"),
        "utf8",
      );

      // The render branch that carries the assessment is the final
      // `<SubPageShell>…</SubPageShell>` in the module (the empty-state
      // branches close their own shell earlier and never mount the card).
      const shellClose = source.lastIndexOf("</SubPageShell>");
      expect(shellClose, `${slug}: no closing </SubPageShell>`).toBeGreaterThan(
        -1,
      );
      const shellOpen = source.lastIndexOf("<SubPageShell", shellClose);
      expect(shellOpen, `${slug}: no opening <SubPageShell`).toBeGreaterThan(
        -1,
      );

      const body = source.slice(shellOpen, shellClose);

      const assessmentIndex = body.lastIndexOf(assessmentTag);
      expect(
        assessmentIndex,
        `${slug}: assessment card ${assessmentTag} not found inside the shell`,
      ).toBeGreaterThan(-1);

      // Pages where the assessment is the last block (the default) must have
      // nothing but whitespace after the assessment element's `/>`. Pages that
      // intentionally trail the assessment with a navigation CTA
      // (`assessmentMayTrail`, today only pulse) skip the last-block check —
      // the target-before-assessment guard below still applies.
      if (!assessmentMayTrail) {
        // The assessment renders as a self-closing element. The icon passed
        // as a prop (`<Scale … />`) self-closes BEFORE the element's own `/>`,
        // so the last `/>` in the body belongs to the trailing assessment
        // element by construction.
        const selfClose = body.lastIndexOf("/>");
        expect(
          selfClose,
          `${slug}: assessment card is not self-closing as expected`,
        ).toBeGreaterThan(assessmentIndex);

        const trailing = body.slice(selfClose + 2).trim();
        expect(
          trailing,
          `${slug}: "${trailing.slice(0, 40)}" renders AFTER the assessment card — ` +
            `the assessment must be the last block on the canonical spine`,
        ).toBe("");
      }

      // v1.12.4 — the target card precedes the assessment when present.
      const targetIndex = body.indexOf("<MetricTargetSummary");
      if (targetIndex > -1) {
        expect(
          targetIndex,
          `${slug}: target card must render before the assessment`,
        ).toBeLessThan(assessmentIndex);
      }
    });
  }
});

describe("metric subpages — retired range row + Letzte-Messung are gone", () => {
  // The whole insights subpage tree (bespoke + the values/scores detail pages).
  for (const { slug } of BESPOKE_PAGES) {
    it(`/insights/${slug} carries no range row and no last-measurement card`, () => {
      const source = readFileSync(join(PAGES_DIR, slug, "page.tsx"), "utf8");
      // Match a real JSX element start (`<Name ` or `<Name\n` or `<Name/>`),
      // not the back-ticked references inside explanatory comments
      // (`<MetricRangeControls>`) that mood / medications keep to document
      // why the row is intentionally absent.
      expect(
        /<MetricRangeControls[\s/]/.test(source),
        `${slug}: the 7T/30T/90T/1J range row was removed in v1.12.4`,
      ).toBe(false);
      expect(
        /<MetricLastMeasurementCard[\s/]/.test(source),
        `${slug}: the "Letzte Messung" card was removed from subpages in v1.12.4`,
      ).toBe(false);
    });
  }
});

describe("assessment presentation contract", () => {
  it("uses the shared readable foreground and compact rhythm for populated prose", () => {
    const cardSource = readFileSync(
      join(
        process.cwd(),
        "src",
        "components",
        "insights",
        "insight-status-card.tsx",
      ),
      "utf8",
    );
    const moodSource = readFileSync(
      join(
        process.cwd(),
        "src",
        "components",
        "insights",
        "mood",
        "mood-insights-sections.tsx",
      ),
      "utf8",
    );
    const moodBodySource = readFileSync(
      join(
        process.cwd(),
        "src",
        "components",
        "insights",
        "mood",
        "mood-better-days.tsx",
      ),
      "utf8",
    );

    expect(cardSource).toContain(
      'className="animate-insight-in gap-2 py-3 md:py-4"',
    );
    expect(cardSource).toContain('className="text-foreground text-sm"');
    expect(moodSource).toContain(
      'className="animate-insight-in gap-2 py-3 md:py-4"',
    );
    expect(moodSource).toContain('data-slot="insight-assessment"');
    expect(moodBodySource).toContain(
      'className="text-foreground mb-2 text-sm"',
    );
  });
});
