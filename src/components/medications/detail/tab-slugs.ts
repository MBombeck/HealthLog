/**
 * The medication detail page's tab slugs, and what an old `?tab=` value maps
 * to. Slugs are ASCII and the same in every locale so a link stays stable;
 * the visible labels resolve through i18n.
 */
export const TAB_SLUGS = [
  "overview",
  "effect",
  "schedule",
  "supply",
  "history",
  "injection",
  "advanced",
] as const;
export type TabSlug = (typeof TAB_SLUGS)[number];

/**
 * Slugs an old link may still carry. The tabs used to have German slugs in
 * every language; links in old reports, notifications and bookmarks keep
 * landing on the same tab. The Erinnerung tab folded into the schedule tab,
 * and the API tab into the advanced one.
 */
export const LEGACY_TAB_SLUGS: Record<string, TabSlug> = {
  uebersicht: "overview",
  wirkung: "effect",
  zeitplan: "schedule",
  bestand: "supply",
  verlauf: "history",
  injektion: "injection",
  erweitert: "advanced",
  erinnerung: "schedule",
  api: "advanced",
};

/** The tab labels; the message keys predate the English slugs. */
export const TAB_LABEL_KEYS: Record<TabSlug, string> = {
  overview: "medications.detail.tabs.uebersicht",
  effect: "medications.detail.tabs.wirkung",
  schedule: "medications.detail.tabs.zeitplan",
  supply: "medications.detail.tabs.bestand",
  history: "medications.detail.tabs.verlauf",
  injection: "medications.detail.tabs.injektion",
  advanced: "medications.detail.tabs.erweitert",
};

/**
 * The tab a `?tab=` value opens: its own slug, or the one an old slug maps
 * to, when that tab is available for this medication; the overview
 * otherwise.
 */
export function resolveTabSlug(
  raw: string | null | undefined,
  available: readonly TabSlug[],
): TabSlug {
  const slug =
    raw && Object.hasOwn(LEGACY_TAB_SLUGS, raw) ? LEGACY_TAB_SLUGS[raw] : raw;
  return available.find((tab) => tab === slug) ?? "overview";
}
