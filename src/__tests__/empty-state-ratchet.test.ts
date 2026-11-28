/**
 * An honest no-data state goes through `EmptyState` (or `ChartEmptyState` on
 * a chart body), UI standards §6.
 *
 * Seventy-five surfaces said "nothing here yet" in a hand-written muted
 * paragraph, in five sizes and three alignments, some centred in a padded
 * box, some a bare line under the header. This is a ratchet, not a ban: the
 * hand-written copies that remain are listed by file and key, a new one
 * fails the run, and a site that moves over leaves the list. The ones that
 * stay are not list or section empty states but a field that has no value
 * ("not recorded" in a profile row), where a centred block would be the
 * wrong shape. A count would let a new copy in wherever an old one left.
 *
 * Matched: a `<p>`, `<div>` or `<span>` whose class list carries
 * `text-muted-foreground` and whose only child is `{t("<key>")}` with a last
 * key segment that names an empty state (`empty`, `none`, `noData`,
 * `noResults`, `notRecorded`, `no…Yet`, `nothing…`; a `…Hint` key is a
 * hint, not a state).
 *
 * Not matched (stated, not hidden): a message assembled from several nodes,
 * a key built at runtime, a state without the muted colour. The guard holds
 * the idiom, not every way to say nothing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(__dirname, "..");

/**
 * The hand-written empty states that remain, each a field-level line rather
 * than a list or section state. Remove an entry when its site moves to
 * `EmptyState`; never add one.
 */
const REMAINING = [
  "components/cycle/cycle-phase-crosstab.tsx: cycle.insights.headline.empty",
  "components/insights/workout-detail/day-context.tsx: insights.workouts.detail.dayMoodNone",
  "components/insights/workout-detail/day-context.tsx: insights.workouts.detail.daySleepNone",
  "components/labs/biomarker-aliases.tsx: labs.aliases.empty",
  "components/medications/dose-history-ledger.tsx: medications.detail.verlauf.summaryEmpty",
  "components/medications/scheduling/dose-window-editor.tsx: medications.detail.zeitplan.window.noTimes",
  "components/medications/sections/composition-section.tsx: medications.composition.editorEmpty",
  "components/records/screening-hints-card.tsx: records.life.screening.noReminder",
  "components/settings/ai/fallback-chain-card.tsx: settings.ai.providerChain.addNoneAvailable",
  "components/settings/integrations/apple-health-card.tsx: settings.appleHealth.delivery.noSyncYet",
  "components/settings/report-selection/scope-summary.tsx: reportSelection.scopeNone",
  "components/timeline/selection-bar.tsx: timeline.selection.empty",
];

const ELEMENT_RE =
  /<(p|div|span)\b([^>]*?)>\s*\{t\(\s*"([a-zA-Z0-9_.]+)"[^)]*\)\}\s*<\/\1>/g;
const EMPTY_KEY_RE =
  /(?:^|\.)[A-Za-z0-9]*?(?:empty|Empty|none|None|noData|NoData|noResults|NoResults|notRecorded|NotRecorded|noSeries|NoSeries|noReminder|NoReminder|noMedications|noSymptoms|noTimes|nothing|Nothing)[A-Za-z0-9]*$|(?:^|\.)no[A-Z][A-Za-z0-9]*Yet$/;

function findHandWrittenEmptyStates(
  files: { path: string; source: string }[],
): string[] {
  const hits: string[] = [];
  for (const { path, source } of files) {
    for (const match of source.matchAll(ELEMENT_RE)) {
      const [, , attrs, key] = match;
      if (!attrs.includes("text-muted-foreground")) continue;
      if (!EMPTY_KEY_RE.test(key) || key.endsWith("Hint")) continue;
      hits.push(`${path}: ${key}`);
    }
  }
  return hits;
}

describe("empty states go through EmptyState (ratchet)", () => {
  const files = walkSourceFiles(SRC, { floor: 2500 })
    .filter(
      (p) =>
        p.endsWith(".tsx") &&
        (p.startsWith("components/") || p.startsWith("app/")) &&
        !p.startsWith("components/ui/") &&
        !p.includes("__tests__/"),
    )
    .map((path) => ({ path, source: readFileSync(join(SRC, path), "utf8") }));

  it("walks the UI tree", () => {
    expect(files.length).toBeGreaterThan(800);
  });

  it("adds no hand-written empty state, and lists none that moved over", () => {
    const hits = findHandWrittenEmptyStates(files).sort();
    expect(
      hits,
      'A new hand-written empty state: render it through <EmptyState variant="plain"> (or ChartEmptyState on a chart body). A site that moved over: remove its entry.',
    ).toEqual([...REMAINING].sort());
  });

  it("recognises the idiom it exists to count", () => {
    expect(
      findHandWrittenEmptyStates([
        {
          path: "components/a.tsx",
          source:
            '<p className="text-muted-foreground text-sm">{t("admin.aiQuality.empty")}</p>',
        },
        {
          path: "components/b.tsx",
          source:
            '<p className="text-muted-foreground text-xs">{t("cycle.sheet.emptyHint")}</p>',
        },
        {
          path: "components/c.tsx",
          source: '<EmptyState title={t("labs.detail.emptyTitle")} />',
        },
        {
          path: "components/d.tsx",
          source:
            '<p className="text-muted-foreground text-sm">{t("insights.noAnalysisYet")}</p>',
        },
      ]),
    ).toEqual([
      "components/a.tsx: admin.aiQuality.empty",
      "components/d.tsx: insights.noAnalysisYet",
    ]);
  });
});
