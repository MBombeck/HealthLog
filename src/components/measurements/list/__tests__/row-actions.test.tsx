/**
 * A computed score offers neither edit nor delete in the measurement list,
 * and no selection checkbox for the bulk delete; a reading of the person's
 * own, or one a device or provider sent, keeps all three.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canManageDomain: () => true,
    inSharedRecord: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import type { Measurement } from "../list-model";
import { MeasurementCardList } from "../measurement-card-list";
import { MeasurementTable } from "../measurement-table";
import {
  MeasurementRowActions,
  type MeasurementRowContext,
} from "../row-actions";

const rows: MeasurementRowContext = {
  canManage: true,
  selectedIds: new Set<string>(),
  expandedDayKeys: new Set<string>(),
  toggleExpand: () => {},
  navigateForType: () => {},
  startEdit: () => {},
  onToggleRow: () => {},
  onDelete: () => {},
  // The row's value formatting; the actions never read it.
  display: {} as MeasurementRowContext["display"],
};

function render(source: string): string {
  const m: Measurement = {
    id: "m1",
    type: "RECOVERY_SCORE",
    value: 85,
    unit: "score",
    source,
    measuredAt: "2026-11-10T12:00:00.000Z",
    notes: null,
  };
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MeasurementRowActions
        m={m}
        rows={rows}
        isGrouped={false}
        isExpanded={false}
        drilldownId="d1"
        layout="desktop"
      />
    </I18nProvider>,
  );
}

describe("MeasurementRowActions", () => {
  it("offers no edit and no delete for a computed score", () => {
    const html = render("COMPUTED");
    expect(html).not.toContain('aria-label="Edit"');
    expect(html).not.toContain('aria-label="Delete"');
  });

  it.each(["MANUAL", "WITHINGS", "APPLE_HEALTH"])(
    "keeps edit and delete for a %s reading",
    (source) => {
      const html = render(source);
      expect(html).toContain('aria-label="Edit"');
      expect(html).toContain('aria-label="Delete"');
    },
  );
});

describe("the row checkbox", () => {
  const listRows: MeasurementRowContext = {
    ...rows,
    display: {
      rowDisplay: (m: Measurement) => ({ value: m.value, unit: m.unit }),
      rowIdentityAttrs: () => ({}),
    } as unknown as MeasurementRowContext["display"],
  };
  const reading = (id: string, source: string): Measurement => ({
    id,
    type: "RECOVERY_SCORE",
    value: 85,
    unit: "score",
    source,
    measuredAt: "2026-11-10T12:00:00.000Z",
    notes: null,
  });
  const checkboxes = (html: string) =>
    html.split('aria-label="Select row"').length - 1;

  it("is offered for a reading and not for a computed score, on both layouts", () => {
    const measurements = [reading("m1", "MANUAL"), reading("m2", "COMPUTED")];
    const wrap = (node: React.ReactNode) =>
      renderToStaticMarkup(
        <I18nProvider initialLocale="en">{node}</I18nProvider>,
      );
    expect(
      checkboxes(
        wrap(
          <MeasurementCardList measurements={measurements} rows={listRows} />,
        ),
      ),
    ).toBe(1);
    expect(
      checkboxes(
        wrap(
          <MeasurementTable
            measurements={measurements}
            rows={listRows}
            filters={
              {
                sortBy: "measuredAt",
                sortDir: "desc",
                toggleSort: () => {},
              } as unknown as Parameters<typeof MeasurementTable>[0]["filters"]
            }
            list={
              {
                selectAll: "none",
                pageIds: [],
                onToggleSelectAll: () => {},
              } as unknown as Parameters<typeof MeasurementTable>[0]["list"]
            }
          />,
        ),
      ),
    ).toBe(1);
  });
});
