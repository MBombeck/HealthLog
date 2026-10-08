import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MCP deep links (`/insights?metric=<id>`) used to land on the overview,
 * whatever the id. The RSC now redirects a placeable id to the metric's page
 * and renders the overview for anything else.
 */
const redirect = vi.hoisted(() =>
  vi.fn((href: string) => {
    throw new Error(`REDIRECT ${href}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/auth/acting-carrier", () => ({
  getUnswitchedSession: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/dashboard/snapshot-read", () => ({
  readDashboardSnapshotCached: vi.fn(),
}));
vi.mock("../page-client", () => ({ default: () => null }));

import InsightsPage from "../page";

beforeEach(() => {
  redirect.mockClear();
});

describe("/insights?metric=", () => {
  it("redirects a metric id to its page", async () => {
    await expect(
      InsightsPage({ searchParams: Promise.resolve({ metric: "hrv" }) }),
    ).rejects.toThrow("REDIRECT /insights/hrv");
  });

  it("renders the overview for an id it cannot place, or none", async () => {
    await expect(
      InsightsPage({ searchParams: Promise.resolve({ metric: "nonsense" }) }),
    ).resolves.toBeTruthy();
    await expect(
      InsightsPage({ searchParams: Promise.resolve({}) }),
    ).resolves.toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });
});
