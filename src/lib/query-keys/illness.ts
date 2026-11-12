/**
 * Query keys — illness / condition journal (v1.18.1): the episode list,
 * a single episode, and a single episode-day day-log.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const illnessKeys = {
  /**
   * v1.18.1 — illness-journal surfaces. `illness()` is the root prefix
   * every illness write invalidates through (`illnessDependentKeys` in
   * `./index.ts`). The episode list, a single episode read, and a per-day
   * day-log each get their own slot; any episode / day-log write evicts
   * the whole `["illness"]` prefix so the history list and the open sheet
   * repaint in lockstep.
   */
  illness: () => ["illness"] as const,
  illnessEpisodes: (includeResolved: boolean) =>
    ["illness", "episodes", includeResolved] as const,
  // The visit form's episode picker: one paged direction from the visit's
  // date or a search, with its own page shape; a shared key would serve one
  // read to the other.
  illnessEpisodesPicker: (
    direction: string,
    pivot: string | null,
    term: string,
  ) => ["illness", "episodes-picker", direction, pivot ?? "", term] as const,
  illnessEpisode: (id: string) => ["illness", "episode", id] as const,
  illnessEpisodeUpdate: (id: string) =>
    ["illness", "episode", id, "update"] as const,
  illnessDayLog: (episodeId: string, date: string) =>
    ["illness", "day-log", episodeId, date] as const,
  /**
   * v1.18.3 — the date-less day-log LIST for an episode (full historical
   * scroll on the detail timeline + iOS healthlog-iOS#30). Distinct slot from
   * the single-day read above; an illness write evicts the whole `["illness"]`
   * prefix so both repaint together.
   */
  illnessDayLogList: (episodeId: string, sortDir: string) =>
    ["illness", "day-log-list", episodeId, sortDir] as const,
  /**
   * v1.18.1 — the per-episode retrospective correlation findings
   * (pre-onset scan, nadir, recovery-gap). Server-authoritative; the read
   * is gated, so the surface pattern-matches `status` rather than recomputing.
   */
  illnessCorrelation: (id: string) => ["illness", "correlation", id] as const,
  /**
   * v1.18.1 — the cross-episode retrospective summary ("sick N times ·
   * typical recovery gap X days") over a trailing window in days.
   *
   * v1.18.9 — `includeRecoveryGap` is part of the key: the lightweight
   * count-only read (list load) and the heavy recovery-gap read (the
   * "Analyse" expansion) hit the same endpoint with a different response
   * shape, so they MUST cache under distinct keys (same-key + different
   * payload silently poisons the cache).
   */
  illnessInsights: (windowDays: number, includeRecoveryGap: boolean) =>
    ["illness", "insights", windowDays, includeRecoveryGap] as const,
  /**
   * v1.40 — person-defined symptoms. Under the `["illness"]` root because they
   * ride the illness module and the episode detail reads them: an illness
   * write and a symptom write each evict the whole tree. The definition list
   * with and without hidden ones are two payloads, so two keys.
   */
  symptomDefinitions: (includeHidden: boolean) =>
    ["illness", "symptoms", "definitions", includeHidden] as const,
  /** One window of occurrences; the window bounds and the filters are the key. */
  symptomEvents: (from: string, to: string, episodeId: string | null) =>
    ["illness", "symptoms", "events", from, to, episodeId] as const,
};
