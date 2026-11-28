/**
 * A logged fever reads in the reader's temperature unit. The timeline and the
 * day sheet printed a hardcoded °C, so an imperial account read its own
 * fever in Celsius.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const account = vi.hoisted(() => ({
  user: { unitPreference: "imperial", glucoseUnit: null } as Record<
    string,
    unknown
  >,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: account.user, isAuthenticated: true }),
  useAccountOnceMounted: () => account.user,
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ canManageDomain: () => true }),
}));

vi.mock("../use-illness", () => ({
  useIllnessDayLogList: () => ({
    isLoading: false,
    isError: false,
    data: {
      dayLogs: [
        {
          id: "d1",
          episodeId: "e1",
          date: "2026-09-30",
          functionalImpact: null,
          feverC: 38.5,
          symptoms: [],
          note: null,
          updatedAt: "2026-09-30T08:00:00.000Z",
        },
      ],
    },
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { IllnessDayTimeline } from "../illness-day-timeline";

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <IllnessDayTimeline episodeId="e1" onLogDay={() => {}} />
    </I18nProvider>,
  );
}

describe("<IllnessDayTimeline> fever unit", () => {
  it("shows the fever in °F for an imperial reader", () => {
    account.user = { unitPreference: "imperial", glucoseUnit: null };
    const html = render();
    // 38.5 °C = 101.3 °F.
    expect(html).toContain("Temperature: 101.3\u00a0°F");
    expect(html).not.toContain("°C");
  });

  it("keeps °C for a metric reader", () => {
    account.user = { unitPreference: "metric", glucoseUnit: null };
    expect(render()).toContain("Temperature: 38.5\u00a0°C");
  });
});
