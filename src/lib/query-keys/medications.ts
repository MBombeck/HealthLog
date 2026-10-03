/**
 * Query keys — medications: detail, compliance, cadence, inventory,
 * dose history, intake lists, and the api-endpoint status row.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const medicationKeys = {
  medications: () => ["medications"] as const,
  medicationDetail: (id: string) => ["medications", id] as const,
  medicationComplianceChart: (medicationId: string) =>
    ["compliance-chart-inline", medicationId] as const,
  /**
   * v1.18.7 — the bare `["compliance-chart-inline"]` prefix, for fan-out
   * invalidation across every per-medication inline compliance tile in one
   * tick (e.g. a dashboard quick-add intake). `medicationComplianceChart(id)`
   * above keys an individual tile; this routes the parent prefix through the
   * factory so the fan-out is not a bare array at the call site.
   */
  complianceChartInline: () => ["compliance-chart-inline"] as const,
  /**
   * v1.18.7 — per-medication side-effects list, last 30 days
   * (`GET /api/medications/[id]/side-effects`). Rides under the
   * `["medications", id, …]` prefix so a CRUD mutation reaches it through
   * `medicationDependentKeys`.
   */
  medicationSideEffects: (medicationId: string) =>
    ["medications", medicationId, "side-effects", "list"] as const,
  /**
   * v1.4.42 W3-QUERYKEY-LONGTAIL — per-medication compliance KPI used
   * by `medication-card` + `glp1-medication-card`. Centralising lets
   * the intake mutation invalidate every compliance read through the
   * `["medications"]` prefix instead of one bare-literal at a time.
   */
  medicationCompliance: (medicationId: string) =>
    ["medications", medicationId, "compliance"] as const,
  /**
   * v1.16.8 — the batched card-compliance read
   * (`GET /api/medications/compliance`, one round trip for every card on
   * the medications page). Replaces the per-card fan-out over the per-id
   * endpoint; `medicationCompliance(id)` above stays for the detail page,
   * which needs the per-id payload's heatmap grid. Rides under the
   * `["medications"]` prefix so every intake / CRUD mutation reaches it
   * through `medicationDependentKeys`. The static second segment cannot
   * collide with `medicationDetail(id)` — ids are cuids.
   */
  medicationComplianceSummary: () =>
    ["medications", "compliance-summary"] as const,
  /**
   * v1.16.10 — the medications list presentation (cards/table view +
   * manual order, `GET /api/medications/layout`). Deliberately OUTSIDE
   * the `["medications"]` prefix: an intake mutation must not refetch a
   * pure UI preference. Writes update the slot directly through the
   * layout PUT's response.
   */
  medicationListLayout: () => ["medication-list-layout"] as const,
  /**
   * v1.40 (#1041) — the record's own medication categories
   * (`GET /api/medications/categories`). Under the `["medications"]` prefix:
   * a delete moves medications to Other, so the list must refetch with it,
   * and a medication write changes the per-category counts.
   */
  medicationCategories: () => ["medications", "categories"] as const,
  medicationCadence: (medicationId: string) =>
    ["medications", medicationId, "cadence"] as const,
  medicationGlp1Details: (medicationId: string) =>
    ["medications", medicationId, "glp1-details"] as const,
  /**
   * v1.15.18 — per-medication pen/vial inventory list, consumed by the
   * detail page's Bestand (supply) tab. Rides under the `["medications"]`
   * prefix so an intake mutation that decrements a pen invalidates it.
   */
  medicationInventory: (medicationId: string) =>
    ["medications", medicationId, "inventory"] as const,
  /**
   * v1.16.5 — archived schedule eras + `currentSince`
   * (`GET /api/medications/[id]/schedule-revisions`), consumed by the
   * Zeitplan tab's history timeline. Rides under the `["medications"]`
   * prefix so a schedule replace (which may archive a new era)
   * invalidates it together with the detail read.
   */
  medicationScheduleRevisions: (medicationId: string) =>
    ["medications", medicationId, "schedule-revisions"] as const,
  /**
   * v1.15.18 — per-medication dose-history ledger
   * (`GET /api/medications/[id]/dose-history?from=&to=`), consumed by the
   * detail page's Verlauf tab. Keyed by the `(from, to)` window so paging the
   * range caches each span independently; rides under the `["medications"]`
   * prefix so an intake mutation (take / skip / edit / delete) reaches it
   * through `medicationDependentKeys`. The Verlauf tab also mutates this slot
   * optimistically on Genommen / Übersprungen so the row status + the
   * Übersicht headline % flip in the same paint, then reconciles on the
   * authoritative refetch.
   */
  medicationDoseHistory: (medicationId: string, windowDays: number) =>
    ["medications", medicationId, "dose-history", windowDays] as const,
  medicationIntakeDrugLevelChart: (medicationId: string) =>
    ["medications", medicationId, "intake", "drug-level-chart"] as const,
  /**
   * v1.4.42 — intake-history list with sort / paging / status filter.
   * The opaque params object lives at index 4 so the
   * `["medications", id, "intake", "list"]` prefix invalidates every
   * sort/page combination on an intake mutation.
   */
  medicationIntakeList: (
    medicationId: string,
    params: {
      sortBy: string;
      sortDir: string;
      limit: number;
      offset: number;
      status: string;
    },
  ) =>
    [
      "medications",
      medicationId,
      "intake",
      "list",
      params.sortBy,
      params.sortDir,
      params.limit,
      params.offset,
      params.status,
    ] as const,
  /**
   * v1.4.40 W-RSC — the dashboard-level compliance chart (aggregate
   * across every scheduled medication) was a bare `["medication-
   * compliance-chart", days]` key; route it through the factory so
   * `medicationDependentKeys` invalidates it on intake-mutation just
   * like the per-medication compliance-chart-inline tile. `days` is the
   * range (7 / 30 / 90); kept as the only param so the prefix
   * `["dashboard-medication-compliance"]` invalidates every range at
   * once.
   */
  dashboardMedicationCompliance: (days: number) =>
    ["dashboard-medication-compliance", days] as const,
  medicationPhaseConfig: (medicationId: string) =>
    ["phase-config", medicationId] as const,
  /**
   * v1.5.5 F-1 H-2 — per-medication api-endpoint status (enabled +
   * active-token-count) used by the detail-page Externe Integration
   * row. The key rides under the `["medications", id, …]` prefix so
   * `medicationDependentKeys` catches it on token mint / disable.
   * Centralising the tuple closes the bare-array bypass the
   * useMemo inside `<ApiTokensRow>` was using.
   */
  medicationApiEndpoint: (medicationId: string) =>
    ["medications", medicationId, "api-endpoint"] as const,
  /**
   * v1.28 — per-medication efficacy view ("Wirkung")
   * (`GET /api/medications/[id]/efficacy`), consumed by the detail page's
   * Wirkung tab and the Insights medication summary. Rides under the
   * `["medications", id, …]` prefix so an intake mutation (which moves the
   * adherence lane) reaches it through `medicationDependentKeys`.
   */
  medicationEfficacy: (medicationId: string) =>
    ["medications", medicationId, "efficacy"] as const,
};
