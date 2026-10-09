/**
 * v1.37.31 — contract for the operator provider-health readout
 * (`/api/admin/provider-health`). The per-user retry ledger existed for a
 * long time with no operator surface; this pins the fold: one row per
 * provider type, failing counted from the LAST result only, the worst
 * uninterrupted failure run taken across failing users, central types
 * sorted first, and no per-user data in the response.
 *
 * It also pins the HTTP status the ledger has recorded on every failure
 * since v1.11.0 and nothing read until now: it must describe the SAME
 * failure the row's instant names, or the card tells the operator to go
 * looking at the wrong thing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    providerHealth: {
      groupBy: vi.fn(),
      // v1.42 — the paused rows.
      findMany: vi.fn(async () => []),
    },
    coachUsage: {
      aggregate: vi.fn(),
    },
    // v1.42 — the operator key's model check reads the admin settings.
    appSettings: { findUnique: vi.fn(async () => null) },
  },
}));

// v1.42 — the model check probes the operator endpoint's listing.
const probeModelListing = vi.fn();
vi.mock("@/lib/ai/model-availability", () => ({
  probeModelListing: (...a: unknown[]) => probeModelListing(...a),
}));
vi.mock("@/lib/crypto", () => ({ decrypt: (v: string) => v }));

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAdmin: vi.fn(),
  };
});

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/api-handler";

const groupBy = vi.mocked(prisma.providerHealth.groupBy);
const aggregate = vi.mocked(prisma.coachUsage.aggregate);

function group(
  providerType: string,
  lastResult: string,
  count: number,
  max: {
    consecutiveFailures?: number;
    lastFailureAt?: Date | null;
    lastOkAt?: Date | null;
    lastStatus?: number | null;
  } = {},
) {
  return {
    providerType,
    lastResult,
    lastStatus: max.lastStatus ?? null,
    _count: { _all: count },
    _max: {
      consecutiveFailures: max.consecutiveFailures ?? 0,
      lastFailureAt: max.lastFailureAt ?? null,
      lastOkAt: max.lastOkAt ?? null,
    },
  };
}

describe("GET /api/admin/provider-health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin1" },
    } as never);
    aggregate.mockResolvedValue({
      _sum: { totalTokens: 0, operatorTokens: 0 },
    } as never);
  });

  it("is admin-gated before it touches the ledger", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("forbidden"));

    await expect(GET()).rejects.toThrow("forbidden");
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("folds ok and failing groups of one type into a single row", async () => {
    groupBy.mockResolvedValue([
      group("admin-openai", "ok", 3, {
        lastOkAt: new Date("2026-08-27T07:00:00Z"),
      }),
      group("admin-openai", "hard_failed", 2, {
        consecutiveFailures: 3334,
        lastFailureAt: new Date("2026-08-27T06:00:00Z"),
        lastStatus: 503,
      }),
    ] as never);

    const res = await GET();
    const body = await res.json();
    expect(body.data.providers).toEqual([
      {
        providerType: "admin-openai",
        tracked: 5,
        failing: 2,
        maxConsecutiveFailures: 3334,
        lastOkAt: "2026-08-27T07:00:00.000Z",
        lastFailureAt: "2026-08-27T06:00:00.000Z",
        lastFailureStatus: 503,
        pausedUsers: 0,
        pausedUntil: null,
        modelListing: null,
      },
    ]);
  });

  it("reports the status of the newest failure, not the highest number", async () => {
    // A 500 an hour ago and a 401 a minute ago: the operator needs the
    // 401, because that is the one that will not clear on its own. Taking
    // a MAX over the column would hand back the 500.
    groupBy.mockResolvedValue([
      group("openai", "hard_failed", 4, {
        consecutiveFailures: 2,
        lastFailureAt: new Date("2026-08-27T05:00:00Z"),
        lastStatus: 500,
      }),
      group("openai", "auth_failed", 1, {
        consecutiveFailures: 1,
        lastFailureAt: new Date("2026-08-27T06:59:00Z"),
        lastStatus: 401,
      }),
    ] as never);

    const res = await GET();
    const body = await res.json();
    expect(body.data.providers[0]).toMatchObject({
      lastFailureAt: "2026-08-27T06:59:00.000Z",
      lastFailureStatus: 401,
    });
  });

  it("leaves the status out for a network-class failure that never had one", async () => {
    groupBy.mockResolvedValue([
      group("local", "hard_failed", 1, {
        consecutiveFailures: 9,
        lastFailureAt: new Date("2026-08-27T06:00:00Z"),
        lastStatus: null,
      }),
    ] as never);

    const res = await GET();
    const body = await res.json();
    expect(body.data.providers[0]).toMatchObject({
      lastFailureAt: "2026-08-27T06:00:00.000Z",
      lastFailureStatus: null,
    });
  });

  it("asks the ledger to split the fold by status rather than aggregate it", async () => {
    groupBy.mockResolvedValue([] as never);
    await GET();

    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["providerType", "lastResult", "lastStatus"],
      }),
    );
  });

  it("counts auth_failed as failing and keeps an all-ok type at zero", async () => {
    groupBy.mockResolvedValue([
      group("codex", "auth_failed", 1, { consecutiveFailures: 7 }),
      group("local", "ok", 4),
    ] as never);

    const res = await GET();
    const body = await res.json();
    const byType = Object.fromEntries(
      body.data.providers.map(
        (p: { providerType: string; failing: number }) => [
          p.providerType,
          p.failing,
        ],
      ),
    );
    expect(byType).toEqual({ codex: 1, local: 0 });
  });

  it("sorts the operator-managed types first, the rest alphabetically", async () => {
    groupBy.mockResolvedValue([
      group("local", "ok", 1),
      group("anthropic", "ok", 1),
      group("admin-codex", "ok", 1),
      group("admin-openai", "ok", 1),
    ] as never);

    const res = await GET();
    const body = await res.json();
    expect(
      body.data.providers.map((p: { providerType: string }) => p.providerType),
    ).toEqual(["admin-openai", "admin-codex", "anthropic", "local"]);
  });

  /**
   * v1.38.19 — the two spend figures side by side.
   *
   * The operator reads this card when the chat refuses. Until now it showed
   * delivery health only, and the day's token figure was one number that mixed
   * his own ChatGPT plan with the instance's key — so a refusal at 513 539
   * tokens looked like his own doing. The split is what tells him which
   * ceiling he hit.
   */
  it("reports the day's spend split by who paid for it", async () => {
    groupBy.mockResolvedValue([] as never);
    aggregate.mockResolvedValue({
      _sum: { totalTokens: 1_240_000, operatorTokens: 151_200 },
    } as never);

    const res = await GET();
    const body = await res.json();

    expect(body.data.spendToday).toEqual({
      dateKey: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      totalTokens: 1_240_000,
      operatorTokens: 151_200,
    });
    // Today only, across every account — the operator's ceiling is per day.
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dateKey: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
      }),
    );
  });

  it("reports a day with no spend as zero, not null", async () => {
    groupBy.mockResolvedValue([] as never);
    aggregate.mockResolvedValue({
      _sum: { totalTokens: null, operatorTokens: null },
    } as never);

    const res = await GET();
    const body = await res.json();
    expect(body.data.spendToday.totalTokens).toBe(0);
    expect(body.data.spendToday.operatorTokens).toBe(0);
  });

  it("answers an empty ledger with an empty list, not an error", async () => {
    groupBy.mockResolvedValue([] as never);

    const res = await GET();
    const body = await res.json();
    expect(body.data.providers).toEqual([]);
  });
});

describe("GET /api/admin/provider-health — pause and model check (v1.42)", () => {
  const findMany = vi.mocked(prisma.providerHealth.findMany);
  const settings = vi.mocked(prisma.appSettings.findUnique);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin" },
    } as never);
    aggregate.mockResolvedValue({
      _sum: { totalTokens: 0, operatorTokens: 0 },
    } as never);
    findMany.mockResolvedValue([] as never);
    settings.mockResolvedValue(null as never);
  });

  it("counts the users a provider is paused for and when the last pause lifts", async () => {
    groupBy.mockResolvedValue([
      group("admin-openai", "hard_failed", 2, {
        consecutiveFailures: 1766,
        lastFailureAt: new Date("2026-10-08T04:31:00Z"),
        lastStatus: 500,
      }),
    ] as never);
    findMany.mockResolvedValue([
      {
        providerType: "admin-openai",
        nextRetryAt: new Date("2026-10-08T05:01:00Z"),
      },
      {
        providerType: "admin-openai",
        nextRetryAt: new Date("2026-10-09T04:31:00Z"),
      },
    ] as never);

    const body = await (await GET()).json();
    expect(body.data.providers[0]).toMatchObject({
      pausedUsers: 2,
      pausedUntil: "2026-10-09T04:31:00.000Z",
    });
    // Only rows past the pause threshold, inside their window, are read.
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: {
        lastResult: "hard_failed",
        consecutiveFailures: { gte: 5 },
      },
    });
  });

  it("names a model the operator's endpoint no longer lists", async () => {
    groupBy.mockResolvedValue([
      group("admin-openai", "hard_failed", 1, {
        consecutiveFailures: 9,
        lastFailureAt: new Date("2026-10-08T04:31:00Z"),
        lastStatus: 500,
      }),
    ] as never);
    settings.mockResolvedValue({
      adminAiModel: "gpt-5.4-mini",
      adminAiBaseUrl: "http://openai-oauth-proxy:10531/v1",
      adminAiKeyEncrypted: "key",
    } as never);
    probeModelListing.mockResolvedValue("not_listed");

    const body = await (await GET()).json();
    expect(body.data.providers[0].modelListing).toEqual({
      model: "gpt-5.4-mini",
      listing: "not_listed",
    });
    expect(probeModelListing).toHaveBeenCalledWith(
      expect.objectContaining({ operatorTrusted: true, model: "gpt-5.4-mini" }),
    );
  });

  it("does not probe while the operator's key is healthy", async () => {
    groupBy.mockResolvedValue([
      group("admin-openai", "ok", 4, {
        lastOkAt: new Date("2026-10-08T04:31:00Z"),
      }),
    ] as never);
    const body = await (await GET()).json();
    expect(body.data.providers[0].modelListing).toBeNull();
    expect(probeModelListing).not.toHaveBeenCalled();
  });
});
