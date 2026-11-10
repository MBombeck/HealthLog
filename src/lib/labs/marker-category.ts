/**
 * Categories for the labs list (`GET /api/labs/overview`).
 *
 * A marker's category is its panel: the serialised `latest.panel`, which is
 * the biomarker's panel for a linked marker and the row's own for a legacy
 * unlinked one (the same value the card shows as its chip). The server
 * resolves the category, its label, its order, and combined counts and status
 * for the full category once; clients (the web list and the iOS app) render
 * that as given when unfiltered, while the web list summarizes the visible
 * subset client-side when filters are active.
 *
 * Resolution, first match wins:
 *   1. the panel folds to a catalog panel label in any shipped locale
 *      ("Lipide", "Lipids", "Lipides" are one category);
 *   2. any other panel is the person's own grouping, keyed by a hash of its
 *      fold so the key carries no user text;
 *   3. a marker without a panel whose name the catalog knows lands in that
 *      analyte's catalog panel;
 *   4. everything else is "other".
 *
 * SERVER-ONLY: it reads every message bundle through the label index.
 */
import { createHash } from "node:crypto";

import { foldLabel } from "@/lib/i18n/fold-label";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { buildLocalisedLabelIndex } from "@/lib/i18n/localised-label-index";
import type { Locale } from "@/lib/i18n/config";
import { resolveIntlLocale } from "@/lib/format-locale";
import {
  priorityReferenceRangeStatus,
  type ReferenceRangeStatus,
  type ReferenceRangeStatusCounts,
} from "@/lib/labs/reference-range";

import { catalogKeyForName } from "./analyte-match";
import {
  ALIAS_PANEL,
  BIOMARKER_CATALOG,
  BIOMARKER_PANELS,
  type BiomarkerPanelKey,
} from "./biomarker-catalog";

export const OTHER_CATEGORY = "other";
const CUSTOM_PREFIX = "custom:";

export type MarkerCategoryKind = "builtin" | "custom" | "other";

export interface MarkerCategoryRef {
  key: string;
  kind: MarkerCategoryKind;
}

export type CategoryCounts = ReferenceRangeStatusCounts;

export interface LabOverviewCategory {
  /** A catalog panel key, `custom:<hash>`, or `other`. Opaque to clients. */
  key: string;
  /** Rendered as given. */
  label: string;
  /** The overview `markers[].key` values in this category, in list order. */
  markerKeys: string[];
  counts: CategoryCounts;
  /** Combined status of the members' newest readings. */
  status: ReferenceRangeStatus;
}

let panelIndex: ReadonlyMap<string, BiomarkerPanelKey> | null = null;

/** Folded catalog panel label (every locale) -> panel key. Built once. */
export function panelLabelIndex(): ReadonlyMap<string, BiomarkerPanelKey> {
  panelIndex ??= buildLocalisedLabelIndex(
    BIOMARKER_PANELS.map((key) => ({
      id: key,
      messageKey: `labs.catalog.panel.${key}`,
      value: key,
    })),
  ).index;
  return panelIndex;
}

const SEED_PANEL = new Map<string, BiomarkerPanelKey>(
  BIOMARKER_CATALOG.map((seed) => [seed.slug, seed.panel as BiomarkerPanelKey]),
);

/** The catalog panel of an analyte key, from its seed or the alias table. */
export function panelForAnalyte(key: string): BiomarkerPanelKey | null {
  return SEED_PANEL.get(key) ?? ALIAS_PANEL[key] ?? null;
}

function customKey(folded: string): string {
  return (
    CUSTOM_PREFIX +
    createHash("sha256").update(folded, "utf8").digest("hex").slice(0, 12)
  );
}

export function resolveMarkerCategory(input: {
  panel: string | null;
  name: string;
}): MarkerCategoryRef {
  const panel = input.panel?.trim() ?? "";
  if (panel !== "") {
    const folded = foldLabel(panel);
    const builtin = panelLabelIndex().get(folded);
    if (builtin) return { key: builtin, kind: "builtin" };
    if (folded !== "") return { key: customKey(folded), kind: "custom" };
  }
  const analyte = catalogKeyForName(input.name);
  const fromName = analyte ? panelForAnalyte(analyte) : null;
  if (fromName) return { key: fromName, kind: "builtin" };
  return { key: OTHER_CATEGORY, kind: "other" };
}

/**
 * Counts and one status for a category. Any value above its range makes the
 * category "above", else any below makes it "below", else one assessed value
 * makes it "in-range"; a category of qualitative or rangeless values only is
 * "unknown". Never an alarm tone: the client maps these to the same calm
 * tones the per-reading badge uses.
 */
export function summariseCategory(statuses: readonly ReferenceRangeStatus[]): {
  counts: CategoryCounts;
  status: ReferenceRangeStatus;
} {
  const counts: CategoryCounts = { inRange: 0, below: 0, above: 0, unknown: 0 };
  for (const status of statuses) {
    if (status === "in-range") counts.inRange += 1;
    else if (status === "below") counts.below += 1;
    else if (status === "above") counts.above += 1;
    else counts.unknown += 1;
  }
  const status = priorityReferenceRangeStatus(counts);
  return { counts, status };
}

/**
 * The label of a custom category: the spelling most members carry, ties to
 * the smallest by `localeCompare`, so it does not flip when a newer reading
 * lands.
 */
export function customCategoryLabel(spellings: readonly string[]): string {
  const tally = new Map<string, number>();
  for (const spelling of spellings) {
    tally.set(spelling, (tally.get(spelling) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [spelling, count] of tally) {
    if (
      best === null ||
      count > bestCount ||
      (count === bestCount && spelling.localeCompare(best) < 0)
    ) {
      best = spelling;
      bestCount = count;
    }
  }
  return best ?? "";
}

/**
 * The person's panels that are no catalog panel, one spelling per fold, for
 * the panel suggestions in the marker form.
 */
export function customPanelSuggestions(
  panels: readonly (string | null)[],
): string[] {
  const byFold = new Map<string, string[]>();
  for (const raw of panels) {
    const panel = raw?.trim() ?? "";
    if (panel === "") continue;
    const folded = foldLabel(panel);
    if (folded === "" || panelLabelIndex().has(folded)) continue;
    const list = byFold.get(folded) ?? [];
    list.push(panel);
    byFold.set(folded, list);
  }
  return [...byFold.values()]
    .map(customCategoryLabel)
    .sort((a, b) => a.localeCompare(b));
}

export interface CategorisableMarker {
  key: string;
  latest: {
    panel: string | null;
    analyte: string;
    rangeStatus: ReferenceRangeStatus;
  };
}

/**
 * Every category of an overview, in display order (catalog panels in catalog
 * order, then the person's own by label, then "other"), and whether the list
 * groups at all: it does when there are two categories or more and at least
 * one is not "other". One category, or only "other", stays a flat list.
 */
export function categoriseOverview(
  markers: readonly CategorisableMarker[],
  locale: Locale,
): { categories: LabOverviewCategory[]; grouped: boolean } {
  const { t } = getServerTranslator(locale);
  const buckets = new Map<
    string,
    {
      kind: MarkerCategoryKind;
      keys: string[];
      spellings: string[];
      statuses: ReferenceRangeStatus[];
    }
  >();
  for (const marker of markers) {
    const ref = resolveMarkerCategory({
      panel: marker.latest.panel,
      name: marker.latest.analyte,
    });
    let bucket = buckets.get(ref.key);
    if (!bucket) {
      bucket = { kind: ref.kind, keys: [], spellings: [], statuses: [] };
      buckets.set(ref.key, bucket);
    }
    bucket.keys.push(marker.key);
    bucket.statuses.push(marker.latest.rangeStatus);
    if (ref.kind === "custom" && marker.latest.panel) {
      bucket.spellings.push(marker.latest.panel.trim());
    }
  }

  const categories: LabOverviewCategory[] = [];
  for (const [key, bucket] of buckets) {
    const label =
      bucket.kind === "builtin"
        ? t(`labs.catalog.panel.${key}`)
        : bucket.kind === "custom"
          ? customCategoryLabel(bucket.spellings)
          : t("labs.groups.other");
    categories.push({
      key,
      label,
      markerKeys: bucket.keys,
      ...summariseCategory(bucket.statuses),
    });
  }

  const intlLocale = resolveIntlLocale(locale);
  const rank = (category: LabOverviewCategory): number => {
    const builtin = (BIOMARKER_PANELS as readonly string[]).indexOf(
      category.key,
    );
    if (builtin >= 0) return builtin;
    return category.key === OTHER_CATEGORY
      ? BIOMARKER_PANELS.length + 1
      : BIOMARKER_PANELS.length;
  };
  categories.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return (
      a.label.localeCompare(b.label, intlLocale) || (a.key < b.key ? -1 : 1)
    );
  });

  const grouped =
    categories.length >= 2 &&
    categories.some((category) => category.key !== OTHER_CATEGORY);
  return { categories, grouped };
}
