import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.10.0 — categorical events (WX-B). `<RhythmEventsCard>` unit tests.
 *
 * The card is the device-flagged event awareness surface. The load-bearing
 * behaviour under test:
 *   - data-availability gating: the card un-mounts entirely (renders
 *     nothing) when the user has no events or while the payload is in
 *     flight — never an empty / alarming card.
 *   - the device-verdict framing ("Your device flagged …") and the
 *     permanent regulatory disclaimer that states HealthLog does not make a
 *     medical assessment.
 *
 * The component depends on `useAuth` (gate) + TanStack Query (`useQuery`)
 * for the payload, so both are mocked and the assertions run through SSR.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: vi.fn(() => ({ isAuthenticated: true, user: null })),
}));

const useQueryMock = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => useQueryMock(opts),
}));

const apiGetMock = vi.fn();
vi.mock("@/lib/api/api-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/api-fetch")>()),
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiGetList: (...args: unknown[]) => apiGetMock(...args),
}));

const { RhythmEventsCard } = await import("../rhythm-events-card");
const { ApiError } = await import("@/lib/api/api-fetch");

interface RhythmEvent {
  id: string;
  type: string;
  classification: string | null;
  occurredAt: string;
  source: string;
  deviceType: string | null;
}

function renderWith(
  data: { events: RhythmEvent[]; hasEvents: boolean } | undefined,
) {
  useQueryMock.mockReturnValue({
    data: data ? { data, cap: null } : undefined,
    isLoading: false,
  });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <RhythmEventsCard />
    </I18nProvider>,
  );
}

const IRREGULAR_EVENT: RhythmEvent = {
  id: "evt_1",
  type: "IRREGULAR_RHYTHM_NOTIFICATION",
  classification: "IRREGULAR",
  occurredAt: "2026-06-01T09:15:00.000Z",
  source: "APPLE_HEALTH",
  deviceType: "watch",
};

const STEADINESS_EVENT: RhythmEvent = {
  id: "evt_2",
  type: "WALKING_STEADINESS_EVENT",
  classification: "VERY_LOW",
  occurredAt: "2026-05-20T17:00:00.000Z",
  source: "APPLE_HEALTH",
  deviceType: "phone",
};

describe("<RhythmEventsCard>", () => {
  it("hands the read's ApiError through, so a 401 offers sign-in", async () => {
    useQueryMock.mockReturnValue({ data: undefined, isLoading: true });
    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <RhythmEventsCard />
      </I18nProvider>,
    );
    const { queryFn } = useQueryMock.mock.calls.at(-1)![0] as {
      queryFn: () => Promise<unknown>;
    };
    const refusal = new ApiError("Unauthorized", 401);
    apiGetMock.mockRejectedValueOnce(refusal);
    await expect(queryFn()).rejects.toBe(refusal);
  });

  it("renders nothing before the payload resolves", () => {
    useQueryMock.mockReturnValue({ data: undefined, isLoading: true });
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <RhythmEventsCard />
      </I18nProvider>,
    );
    expect(html).toBe("");
  });

  it("renders nothing when the user has no events (data-availability gate)", () => {
    const html = renderWith({ events: [], hasEvents: false });
    expect(html).toBe("");
  });

  it("renders the timeline + each event row when events exist", () => {
    const html = renderWith({
      events: [IRREGULAR_EVENT, STEADINESS_EVENT],
      hasEvents: true,
    });
    expect(html).toContain('data-slot="rhythm-events-card"');
    expect(html).toContain('data-slot="rhythm-events-timeline"');
    const rows = (html.match(/data-slot="rhythm-event-row"/g) ?? []).length;
    expect(rows).toBe(2);
    expect(html).toContain('data-event-type="IRREGULAR_RHYTHM_NOTIFICATION"');
    expect(html).toContain('data-event-type="WALKING_STEADINESS_EVENT"');
  });

  it("frames the verdict as the DEVICE's decision, never HealthLog's", () => {
    const html = renderWith({ events: [IRREGULAR_EVENT], hasEvents: true });
    expect(html).toContain('data-slot="rhythm-event-verdict"');
    // Verbatim device-decision framing — load-bearing regulatory copy.
    expect(html).toContain("Your device flagged a possible irregular rhythm.");
  });

  it("renders the permanent regulatory disclaimer", () => {
    const html = renderWith({ events: [IRREGULAR_EVENT], hasEvents: true });
    expect(html).toContain('data-slot="rhythm-events-disclaimer"');
    // The disclaimer must state the alert is the device's, not an
    // assessment by HealthLog, and point to the doctor.
    expect(html).toContain("not an assessment by HealthLog");
    expect(html).toContain("talk to your doctor");
  });
});
