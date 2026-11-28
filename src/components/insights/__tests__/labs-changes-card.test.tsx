/**
 * The card prints a lab figure the way the labs page does: in the reader's
 * notation and with the digits the reading holds. It used to print
 * `String(value)`, so a German reader saw "4.6" beside a labs page that says
 * "4,6", and a converted reading showed every digit of the conversion.
 *
 * Put away, it stays away for that panel on the account
 * (`labs-changes.<latestDate>`), and a newer panel brings it back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let latestDate = "2026-06-01";
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      present: true,
      latestDate,
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

let stored: string[] = [];
const isDismissed = vi.fn((family: string, member?: string) =>
  stored.some((id) => id === family || id === `${family}.${member}`),
);
vi.mock("@/hooks/use-dismissed-hints", () => ({
  useDismissedHints: () => ({ isDismissed, dismiss: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { LabsChangesCard } from "../labs-changes-card";

beforeEach(() => {
  stored = [];
  latestDate = "2026-06-01";
  isDismissed.mockClear();
});

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <LabsChangesCard />
    </I18nProvider>,
  );
}

describe("<LabsChangesCard>", () => {
  it("asks the account about the newest panel and offers to put it away", () => {
    const html = render();
    expect(isDismissed).toHaveBeenCalledWith("labs-changes", "2026-06-01");
    expect(html).toContain('data-slot="labs-changes-dismiss"');
  });

  it("stays away for the panel it was put away on, and comes back with a newer one", () => {
    stored = ["labs-changes.2026-06-01"];
    expect(render()).toBe("");
    latestDate = "2026-09-15";
    expect(render()).toContain('data-slot="labs-changes-section"');
  });

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
