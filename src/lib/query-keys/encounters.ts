/**
 * Query keys — visits and the address book behind them.
 * Part of the centralized factory; aggregated in `./index.ts`.
 *
 * These exist before any client reads them, because the in-repo
 * `healthlog/queryKey-factory` rule errors on a bare array: the first
 * component that lists visits cannot compile without a slot here. Same key
 * with a different `queryFn` shape silently poisons the cache, which is the
 * whole reason the factory is the only legal source.
 *
 * There is deliberately no matching `invalidateUserVisits` in
 * `src/lib/cache/invalidate.ts`. That module evicts SERVER-side cached
 * payloads, and no cached payload reads a visit: the dashboard snapshot, the
 * insights targets and the analytics buckets are all computed from
 * measurements, medications and mood. Adding a sweep over caches nothing reads
 * would be a placeholder that looks like coverage. It belongs in the release
 * that puts visits into one of those payloads, alongside the reader that makes
 * it necessary.
 */
export const encounterKeys = {
  /**
   * The root prefix every visit write invalidates through
   * (`encounterDependentKeys` in `./index.ts`). TanStack's hierarchical
   * prefix semantics mean evicting `["encounters"]` clears the windowed list
   * and every open detail in one tick, so a visit edited in a sheet and the
   * list behind it never disagree.
   */
  encounters: () => ["encounters"] as const,
  /**
   * The windowed list. The window is part of the key: the page can ask for a
   * year at a time, and two windows are two different answers rather than one
   * answer that overwrites the other.
   */
  encounterList: (
    from: string | null,
    to: string | null,
    status?: string,
    episodeId?: string,
  ) =>
    [
      "encounters",
      "list",
      from,
      to,
      status ?? null,
      episodeId ?? null,
    ] as const,
  encounter: (id: string) => ["encounters", "detail", id] as const,
  /**
   * The procedure history for one filter. Under the `["encounters"]` root, so
   * every visit write (switching a kind, editing a site) evicts it with the
   * list. The filter is part of the key because it is part of the question:
   * the search runs server-side over the decrypted site.
   */
  encounterProcedures: (q: string, laterality: string | null) =>
    ["encounters", "procedures", q, laterality] as const,
  /**
   * v1.39.2 — the body-site view and the body-site suggestions. Under the
   * `["encounters"]` root, so a visit write evicts it with the list; a
   * condition write reaches it through `bodySitesAll` in
   * `illnessDependentKeys`, because conditions are the other half of it. The
   * picked site and side are part of the key: the selection is resolved on the
   * server after the decrypt. The suggestions read is the no-site slot.
   */
  bodySitesAll: () => ["encounters", "body-sites"] as const,
  bodySites: (site: string | null, laterality: string | null) =>
    ["encounters", "body-sites", site, laterality] as const,
  /**
   * The "which visit does this belong to" verdict for one anchor date. The
   * anchor is part of the key because it IS the question: a document dated the
   * 3rd and one dated the 20th get different answers, and one overwriting the
   * other would pre-select the wrong visit on the second review step.
   */
  encounterSuggestion: (anchor: string) =>
    ["encounters", "suggest", anchor] as const,
  /**
   * The address book. Under its own root rather than nested beneath
   * `["encounters"]`: a practitioner outlives the visits that name it, and a
   * visit write should not evict a list that did not change.
   */
  practitioners: () => ["practitioners"] as const,
  practitionerList: (q?: string) =>
    ["practitioners", "list", q ?? null] as const,
  practitioner: (id: string) => ["practitioners", "detail", id] as const,

  /* ── mutation keys ──────────────────────────────────────────────── */

  encounterCreate: () => ["encounters", "create"] as const,
  encounterUpdate: () => ["encounters", "update"] as const,
  encounterDelete: () => ["encounters", "delete"] as const,
  practitionerCreate: () => ["practitioners", "create"] as const,
  practitionerUpdate: () => ["practitioners", "update"] as const,
  practitionerDelete: () => ["practitioners", "delete"] as const,
};
