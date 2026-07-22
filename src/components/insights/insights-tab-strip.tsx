"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import {
  INSIGHTS_OVERVIEW_PATH,
  PINNED_SUB_PAGE_SLUGS,
  SUB_PAGE_GROUP,
  SUB_PAGE_GROUP_ORDER,
  SUB_PAGE_SLUGS,
  type SubPageGroup,
  type SubPageSlug,
} from "@/lib/insights/sub-page-metric";
import {
  hasMetricData,
  type InsightInputs,
  type InsightMetric,
} from "@/lib/insights/metric-availability";
import type { ModuleKey } from "@/lib/modules/registry";

/**
 * v1.4.25 W4 — routed tab strip for `/insights`.
 *
 * Behaviour evolved from the v1.4.25 W3 scroll-anchor version: each pill
 * is now a `<Link>` to a routed sub-page (`/insights/blood-pressure` …),
 * `usePathname()` decides the active pill, and the strip is mounted in
 * `src/app/insights/layout.tsx` so it persists across navigation
 * without re-rendering. The CoachDrawer is NOT mounted in this layout —
 * the drawer lives in the mother page's body only (the maintainer directive
 * 2026-05-11).
 *
 * Pills:
 *   - "Overview" (the mother page) is the first pill and matches when
 *     `pathname === "/insights"` exactly.
 *   - The seven metric slugs each map to their own sub-route.
 *
 * Accessibility:
 *   - `<nav aria-label>` mirrors the legacy label.
 *   - Active pill gets `aria-current="page"`.
 *   - The regenerate button has an `aria-label` so the icon-only
 *     affordance is announced. The button only renders when
 *     `onRegenerate` is wired — sub-pages don't carry the regenerate
 *     handler today (the mother page owns the advisor query and
 *     forwards the trigger via the layout slot).
 *   - `prefers-reduced-motion` honoured at the global level (no
 *     scroll-into-view here — Next.js routing handles focus + scroll).
 */

export interface InsightsTabStripProps {
  /**
   * Optional regenerate handler. Only the mother page passes this;
   * sub-pages render the strip without the right-slot button.
   * Wiring the strip in `layout.tsx` means we'd need a layout-level
   * advisor query — for v1.4.25 we keep the strip stateless and the
   * regenerate affordance on the mother page only.
   */
  onRegenerate?: () => void;
  /** Spinner state — disables the button and swaps the icon. */
  regenerating?: boolean;
  /**
   * v1.15.18 — the outcome of the last settled regenerate. The falling-edge
   * toast fires "refreshed" ONLY when this is `"fresh"`; a slow generation the
   * client gave up on (`"timeout"`) shows a "still working" hint instead of a
   * misleading success, and a missing provider (`"no-provider"`) stays silent
   * (the surface already shows the connect-AI empty state). v1.15.20 —
   * `"rate-limited"` (quota exhausted) and `"empty"` (transient 503) show
   * their own honest hints instead of the success toast. Absent (legacy
   * mounts / no regenerate) falls back to the prior unconditional success.
   */
  regenerateOutcome?:
    "fresh" | "empty" | "rate-limited" | "timeout" | "no-provider" | null;
  /**
   * v1.4.27 F19 — analytics + event-driven availability inputs the
   * gating helper reads. When omitted the strip falls back to its
   * pre-v1.4.27 behaviour (every pill renders) so legacy mounts
   * stay backward-compatible.
   */
  availability?: InsightInputs;
  /**
   * v1.15.14 W2 — the set of sub-page slugs the user's saved insights
   * layout marks `visible`. A pill shows iff its metric has data AND its
   * slug is in this set, so hiding a sub-page in "Anpassen" removes its
   * nav pill. `undefined` (layout not yet loaded) falls back to the
   * data-only gate so first paint is unchanged. Data availability stays
   * the FLOOR — a layout-visible metric with zero data never gets a pill.
   */
  visibleTileIds?: ReadonlySet<string>;
  /**
   * v1.15.14 W2 — slug → saved-layout `order`. When present the strip
   * orders flat pills, group parent pills (by first member), and group
   * children by this order; absent, it falls back to the natural
   * `SUB_PAGE_SLUGS` / `SUB_PAGE_GROUP_ORDER` order.
   */
  tileOrder?: ReadonlyMap<string, number>;
  /**
   * v1.18.0 — the account's resolved module enable/disable map (the
   * `modules` field from `GET /api/auth/me`; cycle + coach already
   * delegated). A pill belonging to a toggleable module (mood / sleep /
   * glucose / workouts) is hidden when its key is `false`; the Recovery
   * pill gates on `recovery`. Core metric pills carry no module key and are
   * unaffected. Absent (legacy mounts / auth not yet loaded) keeps every
   * pill — fail-open, matching the gate's default-on contract.
   */
  modules?: InsightsModuleMap;
  /**
   * v1.30 (UX/IA audit H1) — true when the account has at least one ECG
   * recording. ECG carries NO `MeasurementType`, so it can't ride the
   * `availability` / `SUB_PAGE_METRIC` model like every metric pill; it is
   * threaded here as a dedicated data-only signal instead. When true, an
   * "ECG" child is appended to the Heart group's popover (and the Heart group
   * is emitted even for an ECG-only device with no other heart-metric data).
   * When false / absent, no ECG pill renders — we never surface a data-less
   * ECG target on the busy nav (the metric catalog is the empty-state home).
   * Absent until the shell's `insightsEcgList` probe resolves, so first paint
   * is unchanged — a data-only gate, exactly like the other availability
   * inputs.
   */
  hasEcgRecordings?: boolean;
}

/**
 * v1.4.34 IW-D — a strip entry is either a flat `<Link>` pill or a
 * group "parent" pill that opens a popover containing the sub-pages
 * in the group. The discriminated union keeps the renderer branch-
 * exhaustive and lets future groups land with one new variant.
 */
type TabEntry =
  | {
      kind: "link";
      /** Pathname this pill links to. */
      href: string;
      /** Translation key for the pill label. */
      labelKey: string;
    }
  | {
      kind: "group";
      /** Group key (e.g. `"vitals"`). Used for keys + a11y wiring. */
      group: SubPageGroup;
      /** Translation key for the parent-pill label. */
      labelKey: string;
      /** Translation key for the popover header. */
      headerKey: string;
      /**
       * Visible sub-pages inside the group (post-availability gating). `slug`
       * is optional because non-metric children (the ECG entry on the Heart
       * group) have no `SubPageSlug` — they render from `href` + `labelKey`
       * alone and are injected outside the slug-driven availability filter.
       */
      children: Array<{ href: string; labelKey: string; slug?: SubPageSlug }>;
    };

/**
 * v1.30 (UX/IA audit H1) — the ECG entry injected into the Heart group's
 * popover when the account has recordings. Not a `SubPageSlug`: ECG carries no
 * `MeasurementType`, so it lives on its own routed page (`/insights/ecg`) and
 * is gated on `hasEcgRecordings`, never on the metric-availability model.
 */
const ECG_TAB_CHILD = {
  href: `${INSIGHTS_OVERVIEW_PATH}/ecg`,
  labelKey: "insights.navEcg",
} as const;

/**
 * Slug → (label key, gating metric) mapping. Keeping the metric here
 * means the tab strip and the empty-state gates on each sub-page can
 * stay in sync from a single source of truth — adding a sub-page is
 * one row.
 */
// v1.4.33 F9 — label + gating-metric for every routed sub-page. Pill
// ORDER is owned by `SUB_PAGE_SLUGS` (which iterates the keys of
// `SUB_PAGE_METRIC`) so adding a new metric is one row in
// `sub-page-metric.ts` and the strip picks it up automatically.
export const SUB_PAGE_TABS: Record<
  SubPageSlug,
  { labelKey: string; metric: InsightMetric }
> = {
  // ── vitals ──
  "blood-pressure": {
    labelKey: "insights.navBloodPressure",
    metric: "BLOOD_PRESSURE_SYS",
  },
  pulse: { labelKey: "insights.navPulse", metric: "PULSE" },
  oxygen: {
    labelKey: "insights.navOxygenSaturation",
    metric: "OXYGEN_SATURATION",
  },
  "body-temperature": {
    labelKey: "insights.navBodyTemperature",
    metric: "BODY_TEMPERATURE",
  },
  "respiratory-rate": {
    labelKey: "insights.navRespiratoryRate",
    metric: "RESPIRATORY_RATE",
  },
  // v1.25 — pain (0–10 NRS).
  pain: { labelKey: "insights.navPainNrs", metric: "PAIN_NRS" },
  // ── body composition ──
  weight: { labelKey: "insights.navWeight", metric: "WEIGHT" },
  bmi: { labelKey: "insights.navBmi", metric: "BMI" },
  "body-water": {
    labelKey: "insights.navTotalBodyWater",
    metric: "TOTAL_BODY_WATER",
  },
  "bone-mass": { labelKey: "insights.navBoneMass", metric: "BONE_MASS" },
  "fat-free-mass": {
    labelKey: "insights.navFatFreeMass",
    metric: "FAT_FREE_MASS",
  },
  "fat-mass": { labelKey: "insights.navFatMass", metric: "FAT_MASS" },
  "muscle-mass": { labelKey: "insights.navMuscleMass", metric: "MUSCLE_MASS" },
  "visceral-fat": {
    labelKey: "insights.navVisceralFat",
    metric: "VISCERAL_FAT",
  },
  "lean-body-mass": {
    labelKey: "insights.navLeanBodyMass",
    metric: "LEAN_BODY_MASS",
  },
  // v1.25 — waist circumference + waist-to-height ratio.
  waist: {
    labelKey: "insights.navWaistCircumference",
    metric: "WAIST_CIRCUMFERENCE",
  },
  "waist-to-height": {
    labelKey: "insights.navWaistToHeight",
    metric: "WAIST_TO_HEIGHT",
  },
  // ── activity ──
  steps: {
    labelKey: "insights.navSteps",
    metric: "ACTIVITY_STEPS",
  },
  "active-energy": {
    labelKey: "insights.navActiveEnergy",
    metric: "ACTIVE_ENERGY_BURNED",
  },
  // v1.4.32 — workouts pill. Gate is event-driven; the
  // availability helper reads `inputs.hasWorkouts` rather than a
  // `summaries[…].count`.
  workouts: { labelKey: "insights.navWorkouts", metric: "WORKOUTS" },
  "flights-climbed": {
    labelKey: "insights.navFlightsClimbed",
    metric: "FLIGHTS_CLIMBED",
  },
  "walking-distance": {
    labelKey: "insights.navWalkingRunningDistance",
    metric: "WALKING_RUNNING_DISTANCE",
  },
  "walking-steadiness": {
    labelKey: "insights.navWalkingSteadiness",
    metric: "WALKING_STEADINESS",
  },
  "walking-heart-rate": {
    labelKey: "insights.navWalkingHeartRateAverage",
    metric: "WALKING_HEART_RATE_AVERAGE",
  },
  "walking-asymmetry": {
    labelKey: "insights.navWalkingAsymmetry",
    metric: "WALKING_ASYMMETRY",
  },
  "double-support-time": {
    labelKey: "insights.navWalkingDoubleSupport",
    metric: "WALKING_DOUBLE_SUPPORT",
  },
  "step-length": {
    labelKey: "insights.navWalkingStepLength",
    metric: "WALKING_STEP_LENGTH",
  },
  "walking-speed": {
    labelKey: "insights.navWalkingSpeed",
    metric: "WALKING_SPEED",
  },
  // v1.10.0 — cardio fitness (VO2 max) + Apple-Health Mobility additions.
  "cardio-fitness": {
    labelKey: "insights.navCardioFitness",
    metric: "VO2_MAX",
  },
  falls: { labelKey: "insights.navFalls", metric: "FALL_COUNT" },
  "six-minute-walk": {
    labelKey: "insights.navSixMinuteWalk",
    metric: "SIX_MINUTE_WALK_DISTANCE",
  },
  "stair-ascent-speed": {
    labelKey: "insights.navStairAscentSpeed",
    metric: "STAIR_ASCENT_SPEED",
  },
  "stair-descent-speed": {
    labelKey: "insights.navStairDescentSpeed",
    metric: "STAIR_DESCENT_SPEED",
  },
  // v1.25 — grip strength.
  "grip-strength": {
    labelKey: "insights.navGripStrength",
    metric: "GRIP_STRENGTH",
  },
  // ── sleep ──
  sleep: { labelKey: "insights.navSleep", metric: "SLEEP_DURATION" },
  // v1.10.0 — sleep breathing-disturbance index.
  "breathing-disturbances": {
    labelKey: "insights.navBreathingDisturbances",
    metric: "BREATHING_DISTURBANCES",
  },
  // ── cardiovascular ──
  "resting-pulse": {
    labelKey: "insights.navRestingHr",
    metric: "RESTING_HEART_RATE",
  },
  hrv: { labelKey: "insights.navHrv", metric: "HEART_RATE_VARIABILITY" },
  "pulse-wave-velocity": {
    labelKey: "insights.navPulseWaveVelocity",
    metric: "PULSE_WAVE_VELOCITY",
  },
  "vascular-age": {
    labelKey: "insights.navVascularAge",
    metric: "VASCULAR_AGE",
  },
  // v1.10.0 — cardio recovery (post-exercise HR drop).
  "cardio-recovery": {
    labelKey: "insights.navCardioRecovery",
    metric: "CARDIO_RECOVERY",
  },
  // ── hearing ──
  "environmental-audio": {
    labelKey: "insights.navAudioExposureEnv",
    metric: "AUDIO_EXPOSURE_ENV",
  },
  "headphone-audio": {
    labelKey: "insights.navAudioExposureHeadphone",
    metric: "AUDIO_EXPOSURE_HEADPHONE",
  },
  "audio-events": {
    labelKey: "insights.navAudioExposureEvent",
    metric: "AUDIO_EXPOSURE_EVENT",
  },
  // ── environment ──
  daylight: {
    labelKey: "insights.navTimeInDaylight",
    metric: "TIME_IN_DAYLIGHT",
  },
  // ── metabolic ──
  "blood-glucose": {
    labelKey: "insights.navBloodGlucose",
    metric: "BLOOD_GLUCOSE",
  },
  "skin-temperature": {
    labelKey: "insights.navSkinTemperature",
    metric: "SKIN_TEMPERATURE",
  },
  // v1.10.0 — overnight wrist temperature.
  "wrist-temperature": {
    labelKey: "insights.navWristTemperature",
    metric: "WRIST_TEMPERATURE",
  },
  // ── mood ──
  mood: { labelKey: "insights.navMood", metric: "MOOD" },
  // ── events ──
  medications: { labelKey: "insights.navMedication", metric: "MEDICATION" },
  // v1.29 — nutrient intake (hydration + micronutrients).
  nutrients: { labelKey: "insights.navNutrients", metric: "NUTRIENTS" },
};

/**
 * v1.18.0 — slug → module gate. A sub-page pill belonging to a toggleable
 * module is hidden when that module is disabled in the account's resolved
 * module map (from `GET /api/auth/me`'s `modules`), on TOP of the data +
 * layout gates. Slugs absent from this map are core metrics (BP, pulse,
 * weight, body composition, activity, cardio, hearing, environment,
 * medications …) and never gate on a module — only on data availability.
 *
 * `labs` has no metric pill; it surfaces via the left nav only. The
 * Recovery pill is gated separately below (it has no slug — it is a
 * composite always-present link, so it reads the `recovery` module key
 * directly in `buildTabs`).
 */
const SUB_PAGE_MODULE: Partial<Record<SubPageSlug, ModuleKey>> = {
  mood: "mood",
  sleep: "sleep",
  "breathing-disturbances": "sleep",
  "blood-glucose": "glucose",
  workouts: "workouts",
  // v1.29 — the nutrients pill gates on the opt-in `nutrients` module
  // alone; there is no data floor on top (see `hasNutrients` in
  // `insights-layout-shell.tsx` — reachability, not row count, is the
  // gate once the user has opted in).
  nutrients: "nutrients",
};

/**
 * v1.18.0 — a partial `ModuleKey → enabled` map (the `modules` field
 * `GET /api/auth/me` returns; cycle + coach already delegated). A pill
 * gated by a module is hidden only when its key resolves to an explicit
 * `false`; a missing key or an absent map (auth not yet loaded) keeps the
 * pill — fail-open, mirroring the gate's default-on contract.
 */
export type InsightsModuleMap = Partial<Record<ModuleKey, boolean>>;

/** True unless the slug's module is explicitly disabled in the map. */
function isSlugModuleEnabled(
  slug: SubPageSlug,
  modules: InsightsModuleMap | undefined,
): boolean {
  const key = SUB_PAGE_MODULE[slug];
  if (!key) return true;
  return modules?.[key] !== false;
}

/**
 * v1.4.34 IW-D — group metadata (label + popover header) keyed by
 * `SubPageGroup`. The strip renders one parent pill per group. v1.7.0
 * adds the body / activity / hearing / environment / metabolic clusters
 * as the previously-orphan metrics each get a sub-page; collapsing them
 * behind a parent pill keeps the strip scannable. The 2026-07-17 UX/IA
 * audit (H2) replaced the old "Cardiovascular" group — which only ever
 * held three rare Withings markers — with a unified "Heart" group that
 * also carries pulse, resting HR, HRV and cardio recovery.
 */
const SUB_PAGE_GROUP_META: Record<
  SubPageGroup,
  { labelKey: string; headerKey: string }
> = {
  vitals: {
    labelKey: "insights.tabStrip.vitalsParent.label",
    headerKey: "insights.tabStrip.vitalsParent.header",
  },
  body: {
    labelKey: "insights.tabStrip.bodyParent.label",
    headerKey: "insights.tabStrip.bodyParent.header",
  },
  activity: {
    labelKey: "insights.tabStrip.activityParent.label",
    headerKey: "insights.tabStrip.activityParent.header",
  },
  heart: {
    labelKey: "insights.tabStrip.heartParent.label",
    headerKey: "insights.tabStrip.heartParent.header",
  },
  hearing: {
    labelKey: "insights.tabStrip.hearingParent.label",
    headerKey: "insights.tabStrip.hearingParent.header",
  },
  environment: {
    labelKey: "insights.tabStrip.environmentParent.label",
    headerKey: "insights.tabStrip.environmentParent.header",
  },
  metabolic: {
    labelKey: "insights.tabStrip.metabolicParent.label",
    headerKey: "insights.tabStrip.metabolicParent.header",
  },
};

function buildTabs(
  availability: InsightInputs | undefined,
  visibleTileIds: ReadonlySet<string> | undefined,
  tileOrder: ReadonlyMap<string, number> | undefined,
  modules: InsightsModuleMap | undefined,
  hasEcgRecordings: boolean | undefined,
): TabEntry[] {
  // v1.4.36 W4d — strict gating contract: a sub-page only surfaces a
  // pill when the availability inputs CONFIRM the metric has at
  // least one observation in the 90-day window. The legacy
  // `if (!availability) return true` fallback rendered every pill
  // while the analytics fetch was in flight, so users with empty
  // metrics briefly saw nav targets they couldn't act on (and on
  // a failed/stale fetch the pills stayed up forever). The new
  // contract: no availability → no metric pills, only Overview.
  // The pills appear progressively as `summaries[METRIC].count`
  // flips from 0 to ≥1 — exactly the auto-light-up behaviour
  // described in `metric-availability.ts` line 26.
  //
  // v1.15.14 W2 — the saved insights layout is now a SECOND gate on top
  // of data availability. A pill shows iff its metric has data AND its
  // slug is layout-`visible`. Data availability stays the FLOOR (a
  // layout-visible metric with zero data still gets no pill). When the
  // layout has not loaded yet (`visibleTileIds === undefined`) we fall
  // back to the data-only gate so first paint matches the pre-W2
  // behaviour — the layout query then narrows the set on resolve. The
  // group child `order` follows the layout (via `orderedSlugs` below),
  // falling back to `SUB_PAGE_GROUP_ORDER` when the layout is absent.
  // v1.18.0 — a THIRD gate on top of data + layout: a pill belonging to a
  // toggleable module (mood / sleep / glucose / workouts) is hidden when
  // that module is disabled in the account's resolved module map. Core
  // metric pills carry no module key and pass this gate unconditionally.
  const visibleSlugs = availability
    ? SUB_PAGE_SLUGS.filter(
        (slug) =>
          hasMetricData(SUB_PAGE_TABS[slug].metric, availability) &&
          (visibleTileIds === undefined || visibleTileIds.has(slug)) &&
          isSlugModuleEnabled(slug, modules),
      )
    : [];

  const visibleSet = new Set(visibleSlugs);

  // v1.15.14 W2 — order the strip by the saved layout when present. The
  // top-level iteration order decides where each flat pill and each group
  // parent pill land; a group parent appears at the position of its
  // first (lowest-order) visible member. Falling back to the natural
  // `SUB_PAGE_SLUGS` order keeps the pre-W2 layout-absent behaviour.
  const orderedSlugs = tileOrder
    ? [...visibleSlugs].sort(
        (a, b) =>
          (tileOrder.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (tileOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
      )
    : visibleSlugs;

  const entries: TabEntry[] = [
    {
      kind: "link",
      href: INSIGHTS_OVERVIEW_PATH,
      labelKey: "insights.navOverview",
    },
  ];

  // v1.18.0 — Recovery is an Insights pill, no longer a left-nav home. It
  // is a composite wearable surface (WHOOP / Polar / Oura recovery, strain,
  // ANS charge, cardio load), not a single MeasurementType, so it has no
  // `summaries[METRIC].count` to gate on — the page data-gates every block
  // and falls back to a calm empty note. The pill is otherwise present like
  // Overview, but it is hidden when the `recovery` module is disabled.
  if (modules?.recovery !== false) {
    entries.push({
      kind: "link",
      href: `${INSIGHTS_OVERVIEW_PATH}/recovery`,
      labelKey: "insights.navRecovery",
    });
  }

  // v1.4.34 IW-D — track which groups have already been emitted so the
  // first encountered group-member triggers the parent pill at the
  // same strip position (preserving categorical order).
  const emittedGroups = new Set<SubPageGroup>();

  for (const slug of orderedSlugs) {
    // 2026-07-17 UX/IA audit (H2/M1) — a pinned slug always renders as
    // its own flat pill, even if it carries a `SUB_PAGE_GROUP` entry (for
    // manager/catalog purposes). It is also excluded below from its
    // group's popover children so it never appears twice.
    const group = PINNED_SUB_PAGE_SLUGS.has(slug)
      ? undefined
      : SUB_PAGE_GROUP[slug];
    if (group) {
      if (emittedGroups.has(group)) continue;
      emittedGroups.add(group);
      const orderedChildren = tileOrder
        ? [...SUB_PAGE_GROUP_ORDER[group]].sort(
            (a, b) =>
              (tileOrder.get(a) ?? Number.MAX_SAFE_INTEGER) -
              (tileOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
          )
        : SUB_PAGE_GROUP_ORDER[group];
      const children: Array<{
        href: string;
        labelKey: string;
        slug?: SubPageSlug;
      }> = orderedChildren
        .filter(
          (childSlug) =>
            visibleSet.has(childSlug) && !PINNED_SUB_PAGE_SLUGS.has(childSlug),
        )
        .map((childSlug) => ({
          slug: childSlug,
          href: `${INSIGHTS_OVERVIEW_PATH}/${childSlug}`,
          labelKey: SUB_PAGE_TABS[childSlug].labelKey,
        }));
      // v1.30 (H1) — ECG is a non-metric child of the Heart group, gated on
      // its own `hasEcgRecordings` signal (ECG has no `MeasurementType`).
      if (group === "heart" && hasEcgRecordings) {
        children.push({ ...ECG_TAB_CHILD });
      }
      if (children.length === 0) continue;
      entries.push({
        kind: "group",
        group,
        labelKey: SUB_PAGE_GROUP_META[group].labelKey,
        headerKey: SUB_PAGE_GROUP_META[group].headerKey,
        children,
      });
      continue;
    }
    entries.push({
      kind: "link",
      href: `${INSIGHTS_OVERVIEW_PATH}/${slug}`,
      labelKey: SUB_PAGE_TABS[slug].labelKey,
    });
  }

  // v1.30 (H1) — an ECG-only device (a recording, but no pulse / resting-HR /
  // HRV rows) never lit up any Heart-group member above, so the loop never
  // emitted the group. Emit it now with ECG as its sole child so the user
  // still has a nav home for their recordings. Positioned after the metric
  // groups (before the catalog tail) since there is no member slug to anchor
  // its natural position to.
  if (hasEcgRecordings && !emittedGroups.has("heart")) {
    emittedGroups.add("heart");
    entries.push({
      kind: "group",
      group: "heart",
      labelKey: SUB_PAGE_GROUP_META.heart.labelKey,
      headerKey: SUB_PAGE_GROUP_META.heart.headerKey,
      children: [{ ...ECG_TAB_CHILD }],
    });
  }

  // 2026-07-17 discoverability audit (R1) — a quiet, always-present pill
  // trailing every other pill, linking to the "what can HealthLog track"
  // catalog. Unlike every metric pill above, it carries no availability
  // gate (like Overview / Recovery): the catalog's whole purpose is
  // listing the metrics that AREN'T visible elsewhere yet, so gating its
  // own entry point on data would defeat it.
  entries.push({
    kind: "link",
    href: `${INSIGHTS_OVERVIEW_PATH}/catalog`,
    labelKey: "insights.navCatalog",
  });

  return entries;
}

function InsightsTabStripImpl({
  onRegenerate,
  regenerating = false,
  regenerateOutcome,
  availability,
  visibleTileIds,
  tileOrder,
  modules,
  hasEcgRecordings,
}: InsightsTabStripProps) {
  const { t } = useTranslations();
  const pathname = usePathname();
  const mounted = useMounted();
  // v1.4.31 — memoise the pill list so the strip's main render
  // path doesn't rebuild the array on every parent re-render. The
  // strip is wrapped in `React.memo` (see export below); the memo
  // here keeps the inner `<Link>` references stable so React's
  // reconciliation short-circuits when neither pathname nor
  // availability changed. Per
  // `.planning/research/v15-insights-blocking-bug.md` fix 2.
  //
  // v1.15.14 W2 — the saved-layout visibility set + order map join the
  // deps so the strip re-derives when the user toggles a sub-page in
  // "Anpassen". The shell memoises both props so an unchanged layout
  // doesn't churn the array.
  const tabs = useMemo(
    () =>
      buildTabs(
        availability,
        visibleTileIds,
        tileOrder,
        modules,
        hasEcgRecordings,
      ),
    [availability, visibleTileIds, tileOrder, modules, hasEcgRecordings],
  );

  // Fire a toast on the falling edge of `regenerating`. Same rising-edge ref
  // guard as the W3 implementation so the toast fires exactly once per
  // regenerate cycle. v1.15.18 — the toast is HONEST: only a `"fresh"`
  // outcome reads "refreshed". v1.15.20 — the honesty extends to the
  // non-fresh outcomes: `"rate-limited"` (429) says the quota is exhausted,
  // `"empty"` (transient 503) says nothing fresh arrived, `"timeout"` keeps
  // its "still working, try again" hint, and `"no-provider"` stays silent
  // (the surface already shows the connect-AI empty state). Previously
  // `"empty"` lumped 429 + 503 together AND toasted success — a rate-limited
  // regenerate claimed "refreshed" while serving the old text. The latest
  // outcome is read through a ref-free dep so the effect fires only on the
  // spinner edge.
  const lastRegeneratingRef = useRef<boolean>(regenerating);
  useEffect(() => {
    if (lastRegeneratingRef.current && !regenerating) {
      if (regenerateOutcome === "timeout") {
        toast.error(t("insights.regenerateError"));
      } else if (regenerateOutcome === "rate-limited") {
        toast.error(t("insights.regenerateRateLimited"));
      } else if (regenerateOutcome === "empty") {
        toast.error(t("insights.regenerateUnavailable"));
      } else if (regenerateOutcome !== "no-provider") {
        // `"fresh"` or legacy `undefined`/null → success.
        toast.success(t("insights.regenerateSuccess"));
      }
    }
    lastRegeneratingRef.current = regenerating;
  }, [regenerating, regenerateOutcome, t]);

  const regenerateLabel = t("insights.regenerateAnalysis");
  const customizeLabel = t("insights.customize");

  // Overflow affordance for the pill row. The row hides its scrollbar
  // (deliberately — see the container classes below), which left desktop
  // users with no signal and no obvious gesture once the pills overflow:
  // mouse wheels scroll vertically and there is nothing to grab. Three
  // complements close that gap:
  //   • chevron buttons (sm+ only — touch keeps native pan) that page the
  //     row ±200 px; they render whenever the row overflows and disable
  //     per-direction so focus never lands on a vanished control;
  //   • a native non-passive wheel listener that turns a dominant vertical
  //     wheel delta into horizontal scroll (React's synthetic onWheel is
  //     passive at the root, so `preventDefault()` must bind natively);
  //   • the existing `<sm` right-edge fade stays as the mobile signal.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollAffordance = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft < maxScroll - 4);
  }, []);

  useEffect(() => {
    // Re-measure on mount, when the pill set changes, and on any resize of
    // the scroll container (sidebar collapse, orientation change).
    updateScrollAffordance();
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateScrollAffordance);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollAffordance, tabs]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const scrollPills = useCallback((direction: -1 | 1) => {
    scrollerRef.current?.scrollBy({
      left: direction * 200,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, []);

  const pillsOverflow = canScrollLeft || canScrollRight;

  return (
    <nav
      data-slot="insights-tab-strip"
      data-tour-id="insights-hero"
      data-hydrated={mounted ? "true" : undefined}
      aria-label={t("insights.navAriaLabel")}
      // v1.4.28 FB-D3 — `touch-action: pan-y` lets vertical swipes that
      // begin on the sticky strip scroll the page through it. The
      // legacy `overflow-x-auto` on the outer `<nav>` claimed the
      // entire touch surface as a horizontal scroll container, so
      // vertical drags that started on the pill row never reached the
      // document. The horizontal pill scroll now lives on the inner
      // `<div>` below; the outer `<nav>` stays sticky but no longer
      // owns the gesture.
      style={{ touchAction: "pan-y" }}
      className={cn(
        // v1.4.27 MB7 / CF-72 — relative wrapper hosts the right-edge
        // fade overlay below so the user reads "there's more to
        // scroll" when the pill row overflows. The fade is a tiny
        // pointer-events-none pseudo-strip painted onto the inner
        // strip via a sibling div; it sits only on `<sm` because the
        // wider viewport above already shows every pill.
        "relative",
        "bg-background/95 sticky top-0 z-30 border-b py-2 backdrop-blur",
      )}
    >
      <div className="flex items-center gap-2">
        {pillsOverflow && (
          <button
            type="button"
            onClick={() => scrollPills(-1)}
            disabled={!canScrollLeft}
            aria-label={t("insights.pillScrollLeft")}
            data-slot="insights-tab-strip-scroll-left"
            className={cn(
              "hidden h-11 w-9 shrink-0 items-center justify-center rounded-full sm:inline-flex",
              "text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
              "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-30",
            )}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        <div
          ref={scrollerRef}
          onScroll={updateScrollAffordance}
          data-slot="insights-tab-strip-scroller"
          // `overflow-x-auto` clips vertically too (overflow-y computes
          // to auto, and the row never scrolls vertically), so a pill
          // border sitting exactly on the content-box edge lost its
          // bottom 1 px at fractional zoom levels — and the 2 px focus
          // ring (+2 px offset) was cut on every side. `py-1` keeps
          // 4 px of paint room inside the clip box; the matching `-my-1`
          // gives that room back to the layout so the strip height is
          // unchanged. `px-1 -mx-1` does the same horizontally so the
          // first/last pill's focus ring isn't clipped at the row edges.
          className="scroll-touch -mx-1 -my-1 flex min-w-0 flex-1 [scrollbar-width:none] gap-2 overflow-x-auto px-1 py-1 [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((tab) => {
            if (tab.kind === "link") {
              // The overview pill matches the mother page exactly; the
              // sub-page pills match a prefix so future nested routes
              // (e.g. `/insights/sleep/2026-05-11`) still highlight the
              // parent tab.
              const isActive =
                tab.href === INSIGHTS_OVERVIEW_PATH
                  ? pathname === INSIGHTS_OVERVIEW_PATH
                  : pathname === tab.href ||
                    pathname.startsWith(`${tab.href}/`);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  // Full route prefetch (RSC payload incl. the dynamic
                  // sub-page, not just the loading boundary) the moment
                  // the pill scrolls into view. The insights sub-pages
                  // are dynamic routes, so the default viewport prefetch
                  // only warms `loading.tsx`; the full prefetch removes
                  // the route-payload round-trip from the pill switch.
                  prefetch={true}
                  aria-current={isActive ? "page" : undefined}
                  data-slot="insights-tab-strip-pill"
                  data-active={isActive ? "true" : undefined}
                  className={cn(
                    // 44px touch-target floor (W8.3) — pills are primary
                    // navigation; the regenerate icon-button to the right
                    // already meets the same minimum.
                    "inline-flex min-h-11 shrink-0 items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                    isActive
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(tab.labelKey)}
                </Link>
              );
            }
            // v1.4.34 IW-D — group parent pill. Renders as a popover
            // trigger so desktop hover (`onMouseEnter` falls through to
            // Radix click semantics — tap-to-open is the same gesture
            // on every device, matching the `<Popover>` MB3 decision).
            // Sub-page navigation happens via the `<Link>` inside the
            // popover; the parent pill never navigates on its own.
            const isGroupActive = tab.children.some(
              (child) =>
                pathname === child.href ||
                pathname.startsWith(`${child.href}/`),
            );
            return (
              <Popover key={`group-${tab.group}`}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-current={isGroupActive ? "page" : undefined}
                    data-slot="insights-tab-strip-group"
                    data-group={tab.group}
                    data-active={isGroupActive ? "true" : undefined}
                    className={cn(
                      "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                      isGroupActive
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(tab.labelKey)}
                    <ChevronDown
                      className="h-3 w-3 opacity-70"
                      aria-hidden="true"
                    />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  data-slot="insights-tab-strip-group-popover"
                  className="w-56 p-2 text-sm"
                >
                  <p className="text-muted-foreground px-2 py-1 text-xs font-semibold tracking-wide uppercase">
                    {t(tab.headerKey)}
                  </p>
                  <ul className="space-y-1" role="list">
                    {tab.children.map((child) => {
                      const isChildActive =
                        pathname === child.href ||
                        pathname.startsWith(`${child.href}/`);
                      return (
                        <li key={child.href}>
                          <Link
                            href={child.href}
                            // Same full-prefetch contract as the flat
                            // pills — fires when the popover opens.
                            prefetch={true}
                            aria-current={isChildActive ? "page" : undefined}
                            data-slot="insights-tab-strip-group-item"
                            data-active={isChildActive ? "true" : undefined}
                            className={cn(
                              "flex min-h-11 items-center rounded-md px-2 py-1.5 text-sm transition-colors",
                              "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                              isChildActive
                                ? "bg-primary/10 text-primary"
                                : "text-foreground hover:bg-accent",
                            )}
                          >
                            {t(child.labelKey)}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </PopoverContent>
              </Popover>
            );
          })}
        </div>
        {pillsOverflow && (
          <button
            type="button"
            onClick={() => scrollPills(1)}
            disabled={!canScrollRight}
            aria-label={t("insights.pillScrollRight")}
            data-slot="insights-tab-strip-scroll-right"
            className={cn(
              "hidden h-11 w-9 shrink-0 items-center justify-center rounded-full sm:inline-flex",
              "text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
              "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-30",
            )}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        {/* v1.4.27 MB7 / CF-72 — right-edge fade. The gradient
            absolute-positions over the rightmost ~24 px of the strip
            so the last visible pill softly fades into the background
            colour, signalling "scroll for more" without a scrollbar.
            Only paints on `<sm` because the wider viewports above
            already fit every pill. The fade is a sibling of the
            scrollable inner row + the regenerate button so it
            visually overlays both without trapping pointer events. */}
        <div
          aria-hidden="true"
          className={cn(
            "from-background/95 pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l to-transparent sm:hidden",
          )}
        />
        {/* v1.18.6 — per-module tour re-entry, travelling with the
            top-right control cluster. Anchors to this strip's
            `insights-hero` and opens the Insights tour card on the spot. */}
        {/* v1.15.18 — customise cog. Sits immediately LEFT of the
            regenerate button and links to the Insights settings section
            (overview arrange + pill sort), matching the Dashboard cog
            idiom. Rendered alongside the regenerate affordance so the two
            top-right controls travel together. The inline "Anpassen"
            button under the hero was removed — this is the single entry
            point. */}
        {onRegenerate && (
          <Link
            href="/settings/layout/insights"
            aria-label={customizeLabel}
            title={customizeLabel}
            data-slot="insights-tab-strip-customize"
            className={cn(
              "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
              "text-muted-foreground hover:text-foreground hover:bg-accent",
              "transition-colors",
              "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
            )}
          >
            <Wrench className="h-4 w-4" aria-hidden="true" />
          </Link>
        )}
        {onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={regenerating}
            aria-label={regenerateLabel}
            title={regenerateLabel}
            data-slot="insights-tab-strip-regenerate"
            className={cn(
              // 44×44 touch target — same WCAG 2.5.5 floor the pill row
              // now honours via `min-h-11`. The button stays circular so
              // its visual weight matches the existing top-bar icon
              // buttons.
              "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
              "text-muted-foreground hover:text-foreground hover:bg-accent",
              "transition-colors",
              "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {regenerating ? (
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    </nav>
  );
}

/**
 * v1.4.31 — `React.memo`'d export. The strip mounts in
 * `<InsightsLayoutShell>` and gets a new `availability` prop on
 * every cache-write of the analytics or comprehensive query; without
 * the memo, every resolve cycle re-runs `buildTabs(availability)` +
 * the eight `<Link>` reconciliations on the main thread inside the
 * same window the iOS touch handler is sitting in. The memo, paired
 * with the `useMemo` on `availability` in the shell, collapses that
 * cascade so the strip only re-renders when the operator-visible
 * pill set actually changed. Per
 * `.planning/research/v15-insights-blocking-bug.md` fix 2.
 */
export const InsightsTabStrip = memo(InsightsTabStripImpl);
