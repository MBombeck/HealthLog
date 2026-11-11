/**
 * A computed score offers neither edit nor delete in the measurement list;
 * a reading of the person's own, or one a device or provider sent, keeps
 * both.
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
