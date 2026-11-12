/**
 * v1.28.x — the metric catalog data model.
 *
 * Backs `/insights/catalog`: a single, on-purpose surface answering "what
 * can HealthLog track, and what feeds it" for the ~90 metric types the
 * primary Insights nav deliberately hides while they carry zero data (see
 * `metric-availability.ts` docblock — "a metric with zero observations
 * doesn't surface a navigation target the user can't act on"). That floor
 * is correct for the daily nav; it also means an account with a sparse
 * device kit has NO reachable surface that says a capability exists at
 * all (2026-07-17 discoverability audit, "the availability floor" finding).
 * This module is the one place that lists every capability regardless of
 * whether the account has data for it yet.
 *
 * Every entry's name + source copy is SOURCED from the existing, already-
 * localised per-metric empty-state strings — never hand-duplicated here.
 * `insights.<slug>.emptyState.description` (the `HealthKitMetricPage`
 * pattern) or `insights.emptyState.<key>.description` (the seven
 * specialised metrics) already say honestly, per metric, what supplies it
 * ("HRV samples land here once Apple Watch — or a compatible Withings
 * device — starts syncing nightly readings."). Reusing them means the
 * catalog cannot drift from the copy shown on the metric's own empty
 * state, and adding a new sub-page's source line is a one-place change
 * (write its `emptyState.description`; the catalog picks it up via the
 * same derivation the tab strip already uses for the pill label).
 */
import type { InsightMetric } from "@/lib/insights/metric-availability";
import {
  INSIGHTS_OVERVIEW_PATH,
  MANAGER_GROUP_ORDER,
  SUB_PAGE_MANAGER_GROUP,
  SUB_PAGE_SLUGS,
  type ManagerGroup,
  type SubPageSlug,
} from "@/lib/insights/sub-page-metric";
import { SUB_PAGE_TABS } from "@/components/insights/insights-tab-strip";

export type CatalogEntryKind = "metric" | "info";

export interface CatalogEntry {
  /** Stable row id — the sub-page slug for routed metrics, a bespoke id otherwise. */
  id: string;
  group: ManagerGroup;
  /** i18n key resolving to the display name (reused from the tab-strip pill label). */
  nameKey: string;
  /** i18n key resolving to the one-line "what supplies this" copy. */
  sourceKey: string;
  kind: CatalogEntryKind;
  /** `kind === "metric"` — the gating metric `hasMetricData` reads. Absent for the ECG row, which resolves presence from its own probe. */
  metric?: InsightMetric;
  /** Route to the metric's own page, once it has data (or always, for ECG). */
  href?: string;
  /** Whether an absent row offers the "connect a source" CTA into `/settings/integrations`. */
  connectable: boolean;
  /** Manual-only metrics (no device path) offer a log CTA instead. */
  manualHref?: string;
  manualCtaKey?: string;
}

/**
 * Group section heading — the descriptive `.header` copy where the tab
 * strip's grouped popover carries one (e.g. "Vital signs" vs the pill's
 * short "Vitals"), the plain manager-group label otherwise. Reused
 * verbatim from the existing tab-strip / pill-order-manager namespace —
 * zero new group-heading strings.
 */
export const CATALOG_GROUP_HEADER_KEYS: Record<ManagerGroup, string> = {
  vitals: "insights.tabStrip.vitalsParent.header",
  body: "insights.tabStrip.bodyParent.header",
  activity: "insights.tabStrip.activityParent.header",
  sleep: "insights.editMode.groupSleep",
  heart: "insights.tabStrip.heartParent.header",
  hearing: "insights.tabStrip.hearingParent.header",
  environment: "insights.tabStrip.environmentParent.header",
  metabolic: "insights.tabStrip.metabolicParent.header",
  mood: "insights.editMode.groupMood",
  events: "insights.editMode.groupEvents",
};

export const CATALOG_GROUP_ORDER: readonly ManagerGroup[] = MANAGER_GROUP_ORDER;

/**
 * The eight slugs whose source copy does NOT live at
 * `insights.<camelSlug>.emptyState.description` (the `HealthKitMetricPage`
 * convention) — the seven specialised metrics carry it at
 * `insights.emptyState.<key>.description` instead, and nutrients (event-
 * driven, module-gated) carries it under its own page namespace. Every
 * value below is an EXISTING key already shown on that metric's own
 * empty-state branch — see `src/app/insights/<slug>/page.tsx`.
 */
const SOURCE_KEY_OVERRIDES: Partial<Record<SubPageSlug, string>> = {
  "blood-pressure": "insights.emptyState.bloodPressure.description",
  pulse: "insights.emptyState.pulse.description",
  weight: "insights.emptyState.weight.description",
  bmi: "insights.emptyState.bmi.description",
  sleep: "insights.emptyState.sleep.description",
  mood: "insights.emptyState.mood.description",
  medications: "insights.emptyState.medication.description",
  nutrients: "nutrients.page.emptyDescription",
  // The nav-key → emptyState-key derivation (below) strips the `nav`
  // prefix and lowercases the first letter; these two sub-pages' empty
  // state key is shorter than their nav label suffix (`navPainNrs` →
  // `pain`, not `painNrs`; `navWaistCircumference` → `waist`, not
  // `waistCircumference`), so they need an explicit override.
  pain: "insights.pain.emptyState.description",
  waist: "insights.waist.emptyState.description",
};

/**
 * Metrics with no device path at all — manual entry is the only source.
 * Mood and medications are inherently self-report (no sensor produces a
 * mood score or an adherence event). Pain, grip strength, waist-to-height
 * ratio and blood ketones are ALSO manual-only despite sitting beside
 * device-fed siblings in their group: none carries an Apple Health mapping
 * (`apple-health-mapping.ts`) or a Withings/wearable source — pain is a
 * 0–10 self-rating, grip strength is read off a hand dynamometer,
 * waist-to-height is logged directly (not derived like BMI), and ketones
 * come off a fingerstick meter that no integration reads. Cross-
 * checked against every routed sub-page's `emptyStateCtaType` +
 * `emptyState.description` copy so this list can't silently drift from
 * what the metric's own empty state actually offers.
 */
const MANUAL_ONLY_SLUGS: ReadonlySet<SubPageSlug> = new Set([
  "mood",
  "medications",
  "pain",
  "grip-strength",
  "waist-to-height",
  "ketones",
]);

const MANUAL_CTA: Partial<
  Record<SubPageSlug, { href: string; ctaKey: string }>
> = {
  mood: { href: "/mood", ctaKey: "insights.emptyState.mood.cta" },
  medications: {
    href: "/medications",
    ctaKey: "insights.emptyState.medication.cta",
  },
  pain: {
    href: "/measurements?add=PAIN_NRS",
    ctaKey: "insights.pain.emptyState.cta",
  },
  "grip-strength": {
    href: "/measurements?add=GRIP_STRENGTH",
    ctaKey: "insights.gripStrength.emptyState.cta",
  },
  "waist-to-height": {
    href: "/measurements?add=WAIST_TO_HEIGHT",
    ctaKey: "insights.waistToHeight.emptyState.cta",
  },
  ketones: {
    href: "/measurements?add=BLOOD_KETONES",
    ctaKey: "insights.bloodKetones.emptyState.cta",
  },
};

/**
 * Derive the `insights.<camel>.emptyState.*` namespace segment from a
 * `SUB_PAGE_TABS` nav label key (`insights.navOxygenSaturation` →
 * `oxygenSaturation`). Mirrors the pill label exactly, so a slug whose nav
 * key and empty-state key already agree (41 of the 49 routed sub-pages)
 * needs no entry in `SOURCE_KEY_OVERRIDES` at all.
 */
function camelFromNavLabelKey(labelKey: string): string {
  const suffix = labelKey.replace(/^insights\.nav/, "");
  return suffix.charAt(0).toLowerCase() + suffix.slice(1);
}

function buildMetricEntries(): CatalogEntry[] {
  return SUB_PAGE_SLUGS.map((slug) => {
    const tab = SUB_PAGE_TABS[slug];
    const group = SUB_PAGE_MANAGER_GROUP[slug];
    const camel = camelFromNavLabelKey(tab.labelKey);
    const sourceKey =
      SOURCE_KEY_OVERRIDES[slug] ?? `insights.${camel}.emptyState.description`;
    const manual = MANUAL_CTA[slug];
    const entry: CatalogEntry = {
      id: slug,
      group,
      nameKey: tab.labelKey,
      sourceKey,
      kind: "metric",
      metric: tab.metric,
      href: `${INSIGHTS_OVERVIEW_PATH}/${slug}`,
      connectable: !MANUAL_ONLY_SLUGS.has(slug),
    };
    if (manual) {
      entry.manualHref = manual.href;
      entry.manualCtaKey = manual.ctaKey;
    }
    return entry;
  });
}

/**
 * ECG recordings (v1.28.50) carry no `MeasurementType` — the section reads
 * a dedicated `hasRecordings` flag off `GET /api/insights/ecg`, not
 * `summaries[…].count` — so it is not a `SUB_PAGE_SLUGS` entry and needs
 * its own catalog row. Source is Withings ScanWatch today (see
 * `.planning/ios-coord/v1.28.50-server-to-ios-ecg.md`) — Apple Watch ECG
 * (`HKElectrocardiogramType`) is explicitly deferred in the HealthKit
 * ingest map, so the copy names ScanWatch only rather than overclaiming.
 */
const ECG_ENTRY: CatalogEntry = {
  id: "ecg",
  group: "heart",
  nameKey: "insights.ecg.sectionTitle",
  sourceKey: "metricCatalog.ecg.source",
  kind: "metric",
  // v1.30 — ECG now has its own routed page; the catalog "View" button
  // points there instead of the overview teaser anchor.
  href: `${INSIGHTS_OVERVIEW_PATH}/ecg`,
  connectable: true,
};

/**
 * Discoverability audit finding A5 — the alert-style watchdogs (rhythm-
 * event notifications, breathing-disturbance screening, baseline-drift
 * health status, and the labs "what changed since your last panel" card)
 * are CORRECT to stay unmounted when there is nothing to flag ("no
 * alert" must not render an alarming empty shell), but nothing anywhere
 * told the user they were running. This is the "single line" fix the
 * audit recommended in place of per-card empty states: an always-shown
 * info row, no present/absent gate, no CTA. The description copy covers
 * all four watchdogs — extend it (not a new catalog row) if a fifth one
 * ships.
 */
const WATCHDOG_ENTRY: CatalogEntry = {
  id: "watchdog",
  group: "heart",
  nameKey: "metricCatalog.watchdog.title",
  sourceKey: "metricCatalog.watchdog.description",
  kind: "info",
  connectable: false,
};

export const METRIC_CATALOG_ENTRIES: readonly CatalogEntry[] = [
  ...buildMetricEntries(),
  ECG_ENTRY,
  WATCHDOG_ENTRY,
];

/** Group the catalog entries in canonical manager-group order. */
export function catalogEntriesByGroup(): ReadonlyMap<
  ManagerGroup,
  CatalogEntry[]
> {
  const map = new Map<ManagerGroup, CatalogEntry[]>();
  for (const group of MANAGER_GROUP_ORDER) map.set(group, []);
  for (const entry of METRIC_CATALOG_ENTRIES) {
    map.get(entry.group)?.push(entry);
  }
  return map;
}
