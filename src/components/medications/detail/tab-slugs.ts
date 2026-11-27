/**
 * The medication detail page's tab slugs, and what an old `?tab=` value maps
 * to. Slugs are ASCII and the same in every locale so a link stays stable;
 * the visible labels resolve through i18n.
 */
export const TAB_SLUGS = [
  "overview",
  "history",
  "effect",
  "injection",
  "settings",
] as const;
export type TabSlug = (typeof TAB_SLUGS)[number];

/**
 * Slugs an old link may still carry, and the tab each one opens now. The
 * tabs had German slugs in every language until v1.44, and six tabs until
 * v1.50: the schedule, supply and advanced tabs folded into the settings
 * tab, so a bookmark, a report or a low-stock push sent before either change
 * still opens the page where its controls live.
 */
export const LEGACY_TAB_SLUGS: Record<string, TabSlug> = {
  uebersicht: "overview",
  wirkung: "effect",
  verlauf: "history",
  injektion: "injection",
  schedule: "settings",
  supply: "settings",
  advanced: "settings",
  zeitplan: "settings",
  bestand: "settings",
  erweitert: "settings",
  erinnerung: "settings",
  api: "settings",
  einstellungen: "settings",
};

/**
 * The settings sheet an old slug opens on arrival: the supply tab's links
 * (the low-stock push among them) land on the supply sheet, not only on the
 * tab that holds it.
 */
export const LEGACY_TAB_SHEETS: Record<string, "supply"> = {
  supply: "supply",
  bestand: "supply",
};

/** The tab labels. */
export const TAB_LABEL_KEYS: Record<TabSlug, string> = {
  overview: "medications.detail.tabs.uebersicht",
  history: "medications.detail.tabs.verlauf",
  effect: "medications.detail.tabs.wirkung",
  injection: "medications.detail.tabs.injektion",
  settings: "medications.detail.tabs.einstellungen",
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

/** Scroll the tab row sideways (never the page) so the active tab shows. */
export function scrollActiveIntoRow(
  row: HTMLDivElement | null,
  active: string,
) {
  const tab = row?.querySelector<HTMLElement>(
    `[data-slot="medication-tab-${active}"]`,
  );
  if (!row || !tab) return;
  row.scrollLeft = Math.max(
    0,
    tab.offsetLeft - (row.clientWidth - tab.offsetWidth) / 2,
  );
}
