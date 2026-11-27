/**
 * One vocabulary for a dose. The card, the table and the history name a dose
 * state through `DOSE_STATE_TERM` and render it through `DoseStateLabel`, and
 * the buttons are verbs. These cases pin the parts a person reads:
 *
 *   - an open history slot reads the state the server resolved (due,
 *     overdue), not a generic "upcoming";
 *   - a clock marks a dose still to take, a check one that was taken;
 *   - the take / skip controls are verbs, the states are participles;
 *   - every locale has a distinct word for skipped and missed.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canWriteDomain: () => true,
    canManageDomain: () => true,
  }),
  useActiveRecordName: () => null,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { LedgerDoseCell } from "@/components/medications/dose-history/ledger-row-item";
import { DoseStateLabel } from "@/components/medications/dose-state-label";
import type { LedgerRow } from "@/components/medications/dose-history-ledger-compute";
import {
  DOSE_STATE_TERM,
  doseStateFromWire,
  doseStateOfHistoryRow,
} from "@/lib/medications/dose-state/terms";
import { DOSE_STATES } from "@/lib/medications/dose-state/resolve";
import { locales } from "@/lib/i18n/config";

function slotRow(overrides: Partial<LedgerRow>): LedgerRow {
  return {
    kind: "slot",
    at: "2026-11-21T07:00:00.000Z",
    timeOfDay: "08:00",
    status: "upcoming",
    intake: null,
    ...overrides,
  };
}

function renderRow(row: LedgerRow) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <LedgerDoseCell row={row} marking={null} isToday onMark={() => {}} />
    </I18nProvider>,
  );
}

describe("dose vocabulary", () => {
  it("an open history slot reads the server's resolved state", () => {
    expect(renderRow(slotRow({ state: "due" }))).toContain('data-state="due"');
    expect(renderRow(slotRow({ state: "overdue" }))).toContain(
      'data-state="overdue"',
    );
    // An older payload without `state` still reads pending, never "upcoming".
    const html = renderRow(slotRow({}));
    expect(html).toContain('data-state="pending"');
    expect(html).toContain(">Pending<");
  });

  it("labels the row's take button with the verb", () => {
    const html = renderRow(slotRow({ state: "due" }));
    expect(html).toMatch(/data-slot="ledger-mark-taken"[^>]*>.*Take<\/button>/);
  });

  it("marks a dose to take with a clock and a taken one with a check", () => {
    const due = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <DoseStateLabel state="due" />
      </I18nProvider>,
    );
    expect(due).toContain("lucide-clock");
    expect(due).not.toContain("lucide-circle-check");
    for (const state of ["taken", "taken_late"] as const) {
      const html = renderToStaticMarkup(
        <I18nProvider initialLocale="en">
          <DoseStateLabel state={state} />
        </I18nProvider>,
      );
      expect(html).toContain("lucide-circle-check");
    }
  });

  it("maps the wire and history vocabularies onto the resolver's states", () => {
    expect(doseStateFromWire("upcoming")).toBe("pending");
    expect(doseStateFromWire("taken", true)).toBe("taken_late");
    expect(doseStateFromWire("taken", false)).toBe("taken");
    expect(doseStateFromWire("bogus")).toBeNull();
    expect(doseStateOfHistoryRow({ status: "taken_on_time" })).toBe("taken");
    expect(doseStateOfHistoryRow({ status: "ad_hoc" })).toBeNull();
    expect(doseStateOfHistoryRow({ status: "upcoming", state: "taken" })).toBe(
      "pending",
    );
  });

  it("has one distinct word per state in every locale", () => {
    for (const locale of locales) {
      const bundle = JSON.parse(
        readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
      );
      const words = DOSE_STATES.map((state) => {
        const value = DOSE_STATE_TERM[state]
          .split(".")
          .reduce((node, part) => node?.[part], bundle);
        expect(typeof value, `${locale} ${state}`).toBe("string");
        return value as string;
      });
      expect(new Set(words).size, locale).toBe(words.length);
    }
  });
});
