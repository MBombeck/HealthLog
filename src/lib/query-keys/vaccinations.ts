/**
 * Query keys — the immunization log.
 * Part of the centralized factory; aggregated in `./index.ts`.
 *
 * These exist before any client reads them, because the in-repo
 * `healthlog/queryKey-factory` rule errors on a bare array: the first
 * component that lists doses cannot compile without a slot here. Same key with
 * a different `queryFn` shape silently poisons the cache, which is the whole
 * reason the factory is the only legal source.
 *
 * There is deliberately no matching `invalidateUserVaccinations` in
 * `src/lib/cache/invalidate.ts`, for the same reason the visits module next
 * door has none. That module evicts SERVER-side cached payloads, and no cached
 * payload reads a dose: the dashboard snapshot, the insights targets and the
 * analytics buckets are computed from measurements, medications and mood.
 * Adding a sweep over caches nothing reads would be a placeholder that looks
 * like coverage. It belongs in the release that puts doses into one of those
 * payloads, alongside the reader that makes it necessary.
 *
 * There is no dependent-keys bundle here yet either, and that omission is the
 * same rule one layer up: a bundle with no caller is dead code, and the gate
 * says so. When the capture surface lands it brings its own, and that bundle
 * has to evict the preventive-care root alongside this one — logging a dose
 * satisfies the booster reminders it answers, so the checkups list goes stale
 * in the same tick. Evicting only the immunization list would leave a booster
 * on screen that the server had already moved a decade out.
 */
export const vaccinationKeys = {
  /**
   * The root prefix every dose write invalidates through
   * (`vaccinationDependentKeys` in `./index.ts`). TanStack's hierarchical
   * prefix semantics mean evicting `["vaccinations"]` clears the list and
   * every open detail in one tick, so a dose edited in a sheet and the list
   * behind it never disagree.
   */
  vaccinations: () => ["vaccinations"] as const,
  /**
   * The list. The filter is part of the key: a page showing one antigen's
   * history and the page showing everything are two different answers rather
   * than one answer that overwrites the other.
   */
  vaccinationList: (antigenSlug?: string | null) =>
    ["vaccinations", "list", antigenSlug ?? null] as const,
  vaccination: (id: string) => ["vaccinations", "detail", id] as const,
  /** The upload suggestion for one anchor date; the anchor is part of the key. */
  vaccinationSuggestion: (anchor: string) =>
    ["vaccinations", "suggest", anchor] as const,
  /** Mutation keys — the factory is the only legal source of these too. */
  vaccinationCreate: () => ["vaccinations", "create"] as const,
  vaccinationUpdate: () => ["vaccinations", "update"] as const,
  vaccinationDelete: () => ["vaccinations", "delete"] as const,
  vaccinationRestore: () => ["vaccinations", "restore"] as const,
  vaccinationBooster: () => ["vaccinations", "booster"] as const,
  vaccinationLink: () => ["vaccinations", "link"] as const,
  /**
   * v1.42 (#1005) — the record's own vaccine definitions. Under the
   * `["vaccinations"]` root on purpose: editing or removing a definition
   * re-reads every dose that names it, and the root eviction repaints both.
   */
  customVaccines: () => ["vaccinations", "custom"] as const,
  customVaccineCreate: () => ["vaccinations", "custom", "create"] as const,
  customVaccineUpdate: () => ["vaccinations", "custom", "update"] as const,
  customVaccineDelete: () => ["vaccinations", "custom", "delete"] as const,
} as const;
