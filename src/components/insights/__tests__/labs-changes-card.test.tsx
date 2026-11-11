/**
 * The card prints a lab figure the way the labs page does: in the reader's
 * notation and with the digits the reading holds. It used to print
 * `String(value)`, so a German reader saw "4.6" beside a labs page that says
 * "4,6", and a converted reading showed every digit of the conversion.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      present: true,
      latestDate: "2026-06-01",
      previousDate: "2026-03-01",
      generatedAt: "2026-06-02T00:00:00.000Z",
      changes: [
        {
          analyte: "TSH",
          unit: "mIU/L",
          latest: 0.009,
          previous: 0.004,
          delta: 0.005,
          direction: "up",
          status: "unknown",
        },
        {
          analyte: "Potassium",
          unit: "mmol/L",
          latest: 4.6,
          previous: 4.9,
          delta: -0.3,
          direction: "down",
          status: "unknown",
        },
      ],
    },
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { LabsChangesCard } from "../labs-changes-card";

describe("<LabsChangesCard>", () => {
  it("prints values and deltas in the reader's notation", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de">
        <LabsChangesCard />
      </I18nProvider>,
    );
    expect(html).toContain("0,009 mIU/L");
    expect(html).toContain("+0,005 mIU/L");
    expect(html).toContain("4,6 mmol/L");
    expect(html).toContain("-0,3 mmol/L");
  });
});
