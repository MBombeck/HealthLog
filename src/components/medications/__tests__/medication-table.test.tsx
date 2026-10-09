/**
 * v1.16.10 — the compact /medications table view.
 *
 * Pins:
 *   - real `<table>` semantics with `scope="col"` headers and a sticky
 *     first column (the responsive horizontal-scroll pattern);
 *   - every column renders from the SAME payloads the cards consume
 *     (the list row's `nextDueAt` / `stockDosesRemaining`, the batched
 *     compliance-summary cache entry the cards share);
 *   - the action buttons are per-row labelled ("Take {name}") and the
 *     row rides the cards' shared intake hook (source-level guard);
 *   - tri-state sorting semantics incl. `aria-sort` and null-last
 *     ordering, with `null` sort = the manual order the page passed in;
 *   - inactive rows pin after the active block, muted, without actions.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import {
  MedicationTable,
  MedicationTableSkeleton,
  nextSortState,
  sortMedicationRows,
  type TableMedication,
} from "@/components/medications/medication-table";

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
}

function render(node: React.ReactNode, client: QueryClient) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

// Seed the SAME batched summary key the cards read — the table's
// compliance column must come from this shared cache entry.
function seedCompliance(
  client: QueryClient,
  medId: string,
  rate7: number,
  rate30: number,
) {
  const key = ["medications", "compliance-summary"];
  const existing =
    (client.getQueryData(key) as Array<{ medicationId: string }>) ?? [];
  client.setQueryData(key, [
    ...existing.filter((row) => row.medicationId !== medId),
    {
      medicationId: medId,
      applicable: true,
      notApplicableReason: null,
      compliance7: { rate: rate7, streak: 0 },
      compliance30: { rate: rate30 },
      complianceDisplay: null,
    },
  ]);
}

function seedComplianceNotApplicable(client: QueryClient, medId: string) {
  const key = ["medications", "compliance-summary"];
  const existing =
    (client.getQueryData(key) as Array<{ medicationId: string }>) ?? [];
  client.setQueryData(key, [
    ...existing.filter((row) => row.medicationId !== medId),
    {
      medicationId: medId,
      applicable: false,
      notApplicableReason: "NO_LOCAL_SCHEDULE",
      compliance7: null,
      compliance30: null,
      complianceDisplay: null,
    },
  ]);
}

// Seed the SAME reminder-thresholds key the cards read — the stock
// cell's amber tier rides the per-user low-stock runway threshold
// (v1.16.11); `null` = the alert (and the tier) is off.
function seedThresholds(
  client: QueryClient,
  lowStockRunwayDays: number | null,
) {
  client.setQueryData(["settings", "reminder-thresholds"], {
    lateMinutes: 120,
    missedMinutes: 240,
    lowStockRunwayDays,
  });
}

// A schedule whose window has already passed for today (01:00–02:00) so
// the row shows the next-intake value rather than the take-now pill,
// regardless of host clock.
const pastWindow = {
  windowStart: "01:00",
  windowEnd: "02:00",
  label: null,
  daysOfWeek: null,
  dose: null,
};

function med(
  partial: Partial<TableMedication> & { id: string; name: string },
): TableMedication {
  return {
    dose: "5 mg",
    active: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    stockDosesRemaining: null,
    schedules: [{ id: `s-${partial.id}`, ...pastWindow }],
    ...partial,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

function tomorrowNoonIso(): string {
  const due = new Date();
  due.setDate(due.getDate() + 1);
  due.setHours(12, 0, 0, 0);
  return due.toISOString();
}

describe("<MedicationTable> — structure + shared payloads", () => {
  it("renders real table semantics: scope=col headers, sticky first column, sr caption", () => {
    const client = makeClient();
    const html = render(
      <MedicationTable
        activeMedications={[med({ id: "m1", name: "Ramipril" })]}
        inactiveMedications={[]}
      />,
      client,
    );

    expect(html).toContain("<table");
    expect((html.match(/scope="col"/g) ?? []).length).toBe(6);
    // All six column headers, localised.
    for (const label of [
      "Name",
      "Status",
      "Next dose",
      "Adherence",
      "Stock",
      "Actions",
    ]) {
      expect(html).toContain(label);
    }
    // Sticky first column for the horizontal-scroll mobile pattern.
    expect(html).toContain("sticky left-0");
    // Screen-reader caption names the table.
    expect(html).toContain("Medications as a table");
  });

  it("renders one row per medication from the list payload: name, dose, next due, stock", () => {
    const client = makeClient();
    seedCompliance(client, "m1", 90, 88);
    const html = render(
      <MedicationTable
        activeMedications={[
          med({
            id: "m1",
            name: "Ramipril",
            dose: "5 mg",
            nextDueAt: tomorrowNoonIso(),
            stockDosesRemaining: 12,
          }),
        ]}
        inactiveMedications={[]}
      />,
      client,
    );

    expect(html).toContain("Ramipril");
    expect(html).toContain("5 mg");
    // Server-computed next due — the same `nextDueAt` the cards render.
    expect(html).toContain("Tomorrow,");
    // Dose-derived stock from the list payload.
    expect(html).toContain("12 doses");
  });

  it("renders the compliance column from the cards' shared batched summary cache", () => {
    const client = makeClient();
    seedCompliance(client, "m1", 92, 87);
    const html = render(
      <MedicationTable
        activeMedications={[med({ id: "m1", name: "Ramipril" })]}
        inactiveMedications={[]}
      />,
      client,
    );

    expect(html).toContain("92%");
    expect(html).toContain("87%");
    // The cadence-window labels (7-/30-day defaults).
    expect(html).toContain("7 d");
    expect(html).toContain("30 d");
  });

  it("renders a settled not-applicable state for a scheduled mirror with no local schedule", () => {
    const client = makeClient();
    seedComplianceNotApplicable(client, "mirror1");
    const html = render(
      <MedicationTable
        activeMedications={[
          med({
            id: "mirror1",
            name: "Apple Health mirror",
            asNeeded: false,
            schedules: [],
          }),
        ]}
        inactiveMedications={[]}
      />,
      client,
    );

    expect(html).toContain("Adherence not applicable");
    expect(html).toContain(
      'data-slot="medication-table-compliance-not-applicable"',
    );
    expect(html).not.toContain('data-slot="progress"');
    expect(html).not.toContain('aria-hidden="true"><div class="space-y-1.5"');
  });

  it("labels the action buttons per row and keeps the 44px tap floor", () => {
    const client = makeClient();
    seedCompliance(client, "m1", 90, 88);
    const html = render(
      <MedicationTable
        activeMedications={[med({ id: "m1", name: "Ramipril" })]}
        inactiveMedications={[]}
      />,
      client,
    );

    expect(html).toContain('aria-label="Take Ramipril"');
    expect(html).toContain('aria-label="Skip Ramipril"');
    // 44-px mobile floor on the action buttons (shrinks at sm).
    expect(html).toContain("size-11 sm:size-9");
  });

  it("hides stock for an untracked medication and tints a low stock", () => {
    const client = makeClient();
    seedCompliance(client, "m1", 90, 88);
    seedCompliance(client, "m2", 90, 88);
    const html = render(
      <MedicationTable
        activeMedications={[
          med({ id: "m1", name: "Aspirin", stockDosesRemaining: null }),
          med({ id: "m2", name: "Mounjaro", stockDosesRemaining: 2 }),
        ]}
        inactiveMedications={[]}
      />,
      client,
    );

    expect(html).toContain("2 doses");
    expect(html).toContain("text-warning");
  });

  it("warns on runway DAYS below the user's threshold, not a legacy dose count", () => {
    const client = makeClient();
    seedCompliance(client, "m1", 90, 88);
    seedCompliance(client, "m2", 90, 88);
    // Per-user threshold: 3 runway days (the same value the low-stock
    // notification fires on).
    seedThresholds(client, 3);
    const html = render(
      <MedicationTable
        activeMedications={[
          // Daily schedule → 5 doses = 5 runway days ≥ 3 → calm, even
          // though the retired 4-dose constant would have tinted it.
          med({ id: "m1", name: "Aspirin", stockDosesRemaining: 5 }),
          // 2 doses = 2 runway days < 3 → amber.
          med({ id: "m2", name: "Mounjaro", stockDosesRemaining: 2 }),
        ]}
        inactiveMedications={[]}
      />,
      client,
    );

    expect((html.match(/text-warning/g) ?? []).length).toBe(1);
    expect(html.indexOf("text-warning")).toBeGreaterThan(
      html.indexOf("Mounjaro"),
    );
  });

  it("threshold OFF (null) disables the amber tier; an exhausted stock stays destructive", () => {
    const client = makeClient();
    seedCompliance(client, "m1", 90, 88);
    seedCompliance(client, "m2", 90, 88);
    seedThresholds(client, null);
    const html = render(
      <MedicationTable
        activeMedications={[
          med({ id: "m1", name: "Aspirin", stockDosesRemaining: 1 }),
          med({ id: "m2", name: "Mounjaro", stockDosesRemaining: 0 }),
        ]}
        inactiveMedications={[]}
      />,
      client,
    );

    expect(html).not.toContain("text-warning");
    // Stock 0 is destructive red regardless of the threshold switch.
    expect(html).toContain("text-destructive");
  });

  it("pins inactive rows after the active block, muted and without actions", () => {
    const client = makeClient();
    seedCompliance(client, "m1", 90, 88);
    const html = render(
      <MedicationTable
        activeMedications={[med({ id: "m1", name: "Zyrtec" })]}
        inactiveMedications={[
          med({ id: "m2", name: "Amoxicillin", active: false }),
        ]}
      />,
      client,
    );

    // Active row first despite alphabetical order saying otherwise.
    expect(html.indexOf("Zyrtec")).toBeLessThan(html.indexOf("Amoxicillin"));
    expect(html).toContain("opacity-60");
    expect(html).toContain("Inactive");
    // No take/skip affordance on the inactive row.
    expect(html).not.toContain('aria-label="Take Amoxicillin"');
  });

  // v1.29.x — the Today digest's "Log dose" deep-link
  // (`/medications?highlight=<id>`) rings the matching row, mirroring the
  // card grid's transient highlight.
  it("carries the medication id and rings the row matching highlightId", () => {
    const client = makeClient();
    seedCompliance(client, "m1", 90, 88);
    seedCompliance(client, "m2", 90, 88);
    const html = render(
      <MedicationTable
        activeMedications={[
          med({ id: "m1", name: "Ramipril" }),
          med({ id: "m2", name: "Metformin" }),
        ]}
        inactiveMedications={[]}
        highlightId="m2"
      />,
      client,
    );

    expect(html).toContain('data-medication-id="m1"');
    expect(html).toContain('data-medication-id="m2"');
    expect(html).toContain("ring-primary");
  });

  it("rings no row when highlightId matches nothing", () => {
    const client = makeClient();
    seedCompliance(client, "m1", 90, 88);
    const html = render(
      <MedicationTable
        activeMedications={[med({ id: "m1", name: "Ramipril" })]}
        inactiveMedications={[]}
        highlightId="does-not-exist"
      />,
      client,
    );

    expect(html).not.toContain("ring-primary");
  });

  it("renders a GLP-1 medication like any other row", () => {
    const client = makeClient();
    seedCompliance(client, "g1", 100, 100);
    const html = render(
      <MedicationTable
        activeMedications={[
          med({
            id: "g1",
            name: "Mounjaro",
            treatmentClass: "GLP1",
            nextDueAt: tomorrowNoonIso(),
            stockDosesRemaining: 4,
          }),
        ]}
        inactiveMedications={[]}
      />,
      client,
    );

    expect(html).toContain("Mounjaro");
    expect(html).toContain('aria-label="Take Mounjaro"');
    expect(html).toContain("4 doses");
  });

  it("offers no dose actions on an ended course and names it; the last course day keeps them (#1040)", () => {
    const client = makeClient();
    seedCompliance(client, "ended", 90, 88);
    seedCompliance(client, "last", 90, 88);
    const html = render(
      <MedicationTable
        activeMedications={[
          med({
            id: "ended",
            name: "Amoxicillin",
            courseStatus: "ENDED",
            intakeActionable: false,
          }),
          med({
            id: "last",
            name: "Prednisolone",
            courseStatus: "CURRENT",
            intakeActionable: true,
          }),
        ]}
        inactiveMedications={[]}
      />,
      client,
    );

    expect(html).not.toContain('aria-label="Take Amoxicillin"');
    expect(html).not.toContain('aria-label="Skip Amoxicillin"');
    expect(html).toContain('data-slot="medication-table-course-ended-marker"');
    expect(html).toContain(">Ended<");
    expect(html).toContain('aria-label="Take Prednisolone"');
    expect(html).toContain('aria-label="Skip Prednisolone"');
  });

  it("renders an as-needed row: calm marker, no compliance bars (v1.16.11 #316)", () => {
    const client = makeClient();
    // Deliberately NOT seeding compliance for the PRN row — the batched
    // payload excludes as-needed medications, and the column must show
    // the en-dash instead of an eternal skeleton.
    const lastTaken = new Date();
    lastTaken.setHours(lastTaken.getHours() - 3);
    const html = render(
      <MedicationTable
        activeMedications={[
          med({
            id: "prn1",
            name: "Ibuprofen",
            asNeeded: true,
            schedules: [],
            nextDueAt: null,
            lastTakenAt: lastTaken.toISOString(),
            stockDosesRemaining: 10,
          }),
        ]}
        inactiveMedications={[]}
      />,
      client,
    );

    expect(html).toContain('data-slot="medication-table-as-needed-marker"');
    expect(html).toContain("As needed");
    // No due/overdue presentation in the status or next-dose cells.
    expect(html).not.toContain("Overdue");
    // Compliance column shows the en-dash, not bars or a skeleton.
    expect(html).not.toContain("Adherence (");
    // The quick actions stay — an as-needed dose is loggable inline.
    expect(html).toContain('aria-label="Take Ibuprofen"');
    // Stock column still renders (inventory tracking works for PRN).
    expect(html).toContain("10 doses");
  });
});

describe("<MedicationTable> — manual order + aria-sort", () => {
  const rows = [
    med({ id: "m1", name: "Ramipril", nextDueAt: tomorrowNoonIso() }),
    med({ id: "m2", name: "Aspirin", nextDueAt: null }),
  ];

  it("renders rows in the order the page passed in when no sort is active (manual order)", () => {
    const client = makeClient();
    const html = render(
      <MedicationTable activeMedications={rows} inactiveMedications={[]} />,
      client,
    );

    // The page already applied the manual order; with sort=null the
    // table must not re-sort (Ramipril stays before Aspirin).
    expect(html.indexOf("Ramipril")).toBeLessThan(html.indexOf("Aspirin"));
    // Every sortable header is unsorted.
    expect((html.match(/aria-sort="none"/g) ?? []).length).toBe(4);
  });

  it("sorts by name ascending with the matching aria-sort", () => {
    const client = makeClient();
    const html = render(
      <MedicationTable
        activeMedications={rows}
        inactiveMedications={[]}
        initialSort={{ column: "name", direction: "asc" }}
      />,
      client,
    );

    expect(html.indexOf("Aspirin")).toBeLessThan(html.indexOf("Ramipril"));
    expect(html).toContain('aria-sort="ascending"');
  });

  it("sorts by name descending with the matching aria-sort", () => {
    const client = makeClient();
    const html = render(
      <MedicationTable
        activeMedications={rows}
        inactiveMedications={[]}
        initialSort={{ column: "name", direction: "desc" }}
      />,
      client,
    );

    expect(html.indexOf("Ramipril")).toBeLessThan(html.indexOf("Aspirin"));
    expect(html).toContain('aria-sort="descending"');
  });

  it("names the sort affordance on every sortable header", () => {
    const client = makeClient();
    const html = render(
      <MedicationTable activeMedications={rows} inactiveMedications={[]} />,
      client,
    );
    expect(html).toContain('aria-label="Sort by Name"');
    expect(html).toContain('aria-label="Sort by Next dose"');
    expect(html).toContain('aria-label="Sort by Adherence"');
    expect(html).toContain('aria-label="Sort by Stock"');
  });
});

describe("nextSortState — tri-state cycle", () => {
  it("cycles none → asc → desc → none per column", () => {
    const asc = nextSortState(null, "name");
    expect(asc).toEqual({ column: "name", direction: "asc" });
    const desc = nextSortState(asc, "name");
    expect(desc).toEqual({ column: "name", direction: "desc" });
    expect(nextSortState(desc, "name")).toBeNull();
  });

  it("switching column resets to ascending", () => {
    expect(
      nextSortState({ column: "name", direction: "desc" }, "nextDue"),
    ).toEqual({ column: "nextDue", direction: "asc" });
  });
});

describe("sortMedicationRows — null-last semantics", () => {
  const a = med({
    id: "a",
    name: "Alpha",
    nextDueAt: null,
    stockDosesRemaining: null,
  });
  const b = med({
    id: "b",
    name: "Beta",
    nextDueAt: "2026-06-03T10:00:00Z",
    stockDosesRemaining: 2,
  });
  const c = med({
    id: "c",
    name: "Gamma",
    nextDueAt: "2026-06-02T18:00:00Z",
    stockDosesRemaining: 9,
  });

  it("returns the input order untouched for a null sort", () => {
    expect(sortMedicationRows([b, a, c], null).map((m) => m.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("sorts by next due ascending, rows without a due date last", () => {
    expect(
      sortMedicationRows([a, b, c], {
        column: "nextDue",
        direction: "asc",
      }).map((m) => m.id),
    ).toEqual(["c", "b", "a"]);
  });

  it("keeps rows without a due date last in descending order too", () => {
    expect(
      sortMedicationRows([a, b, c], {
        column: "nextDue",
        direction: "desc",
      }).map((m) => m.id),
    ).toEqual(["b", "c", "a"]);
  });

  it("sorts by compliance via the shared summary rates, unknown rows last", () => {
    const rates = new Map([
      ["b", 50],
      ["c", 95],
    ]);
    expect(
      sortMedicationRows(
        [a, b, c],
        { column: "compliance", direction: "desc" },
        rates,
      ).map((m) => m.id),
    ).toEqual(["c", "b", "a"]);
  });

  it("sorts by stock, untracked medications last", () => {
    expect(
      sortMedicationRows([a, b, c], {
        column: "stock",
        direction: "asc",
      }).map((m) => m.id),
    ).toEqual(["b", "c", "a"]);
  });

  it("collates names by the active locale, not a hardcoded one", () => {
    // Swedish sorts Ö after Z; German folds Ö next to O. The same two
    // rows must order differently under the two locales.
    const oe = med({ id: "oe", name: "Övriga" });
    const z = med({ id: "z", name: "Zyrtec" });
    const sort = { column: "name", direction: "asc" } as const;
    expect(
      sortMedicationRows([z, oe], sort, undefined, "sv").map((m) => m.id),
    ).toEqual(["z", "oe"]);
    expect(
      sortMedicationRows([z, oe], sort, undefined, "de").map((m) => m.id),
    ).toEqual(["oe", "z"]);
  });
});

describe("<MedicationTableSkeleton> — reserved footprint", () => {
  it("mirrors the loaded table shell (container, table, action slots) and hides from AT", () => {
    const html = renderToStaticMarkup(<MedicationTableSkeleton />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("<table");
    expect(html).toContain("size-11");
  });
});

describe("medication-table — shared mutation/status sources (source guard)", () => {
  const source = readFileSync(
    join(process.cwd(), "src/components/medications/medication-table.tsx"),
    "utf8",
  );

  it("rides the cards' shared intake hook instead of its own POST", () => {
    expect(source).toContain(
      'from "@/components/medications/use-medication-intake"',
    );
    expect(source).not.toContain("/intake");
  });

  it("reads compliance through the cards' batched summary hook", () => {
    expect(source).toContain("useMedicationComplianceSummary");
  });

  it("gates the status pill on the server next-due exactly like the cards", () => {
    expect(source).toContain("reduceCurrentWindowStatus");
    expect(source).toContain("nextDue:");
    expect(source).toContain("resolveDisplayedSlotInstant");
  });
});
