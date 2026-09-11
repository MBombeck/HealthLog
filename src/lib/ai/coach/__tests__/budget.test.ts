import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  buildDateKey,
  OPERATOR_COST_CAP,
  USER_PLAN_CAP,
  JOB_SURFACE_SHARE,
  resolveCostOwner,
  resolveDailyCap,
  resolveDailyCapFor,
} from "../budget";

vi.mock("@/lib/db", () => ({
  prisma: {
    coachUsage: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

describe("buildDateKey", () => {
  it("formats UTC YYYY-MM-DD", () => {
    // 2026-05-10T22:30Z is UTC May 10 — Berlin would be May 11 already
    const key = buildDateKey(new Date("2026-05-10T22:30:00.000Z"));
    expect(key).toBe("2026-05-10");
  });

  it("rolls forward at UTC midnight", () => {
    const key = buildDateKey(new Date("2026-05-11T00:01:00.000Z"));
    expect(key).toBe("2026-05-11");
  });
});

/**
 * Ledger-poisoning guard. These clamps used to live on `recordSpend`, which is
 * gone along with `enforceBudget` — the read-then-write pair that carried both
 * a TOCTOU window and an `OPERATOR_COST_CAP` default that rationed a
 * self-hoster's own key. The PROPERTY they protected still matters and now
 * belongs to the reservation path, so it is asserted there: a provider that
 * reports `tokensUsed: NaN` or a negative count must not poison the meter.
 */
describe("reserveBudget — ledger clamps", () => {
  let prismaMock: {
    $queryRaw: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    const dbModule = await import("@/lib/db");
    prismaMock = dbModule.prisma as unknown as typeof prismaMock;
    prismaMock.$queryRaw.mockReset();
    prismaMock.$queryRaw.mockResolvedValue([{ total_tokens: 0 }]);
    prismaMock.$executeRaw.mockReset();
    prismaMock.$executeRaw.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clamps a non-finite reservation to 0", async () => {
    const { reserveBudget } = await import("../budget");
    const res = await reserveBudget(
      "u",
      Number.NaN,
      "2026-05-10",
      OPERATOR_COST_CAP,
      "operator",
    );
    expect(res.reserved).toBe(0);
  });

  it("clamps a negative reservation to 0", async () => {
    const { reserveBudget } = await import("../budget");
    const res = await reserveBudget(
      "u",
      -42,
      "2026-05-10",
      OPERATOR_COST_CAP,
      "operator",
    );
    expect(res.reserved).toBe(0);
  });

  it("floors a fractional reservation", async () => {
    const { reserveBudget } = await import("../budget");
    const res = await reserveBudget(
      "u",
      12.7,
      "2026-05-10",
      OPERATOR_COST_CAP,
      "operator",
    );
    expect(res.reserved).toBe(12);
  });
});

describe("resolveDailyCap (F1 — provider-aware cap)", () => {
  it("applies the operator-cost cap to an operator-key (admin-openai) primary", () => {
    expect(resolveDailyCap([{ providerType: "admin-openai" }])).toBe(
      OPERATOR_COST_CAP,
    );
  });

  it("applies the operator-cost cap to the shared central-codex (admin-codex) primary", () => {
    // The operator's shared ChatGPT-subscription account drains the operator's
    // allowance, so it is billed against the operator cap, not the user plan.
    expect(resolveDailyCap([{ providerType: "admin-codex" }])).toBe(
      OPERATOR_COST_CAP,
    );
  });

  it("applies the generous user-plan cap to a ChatGPT-OAuth (codex) primary", () => {
    expect(resolveDailyCap([{ providerType: "codex" }])).toBe(USER_PLAN_CAP);
  });

  it("applies the user-plan cap to BYOK openai / anthropic / local primaries", () => {
    expect(resolveDailyCap([{ providerType: "openai" }])).toBe(USER_PLAN_CAP);
    expect(resolveDailyCap([{ providerType: "anthropic" }])).toBe(
      USER_PLAN_CAP,
    );
    expect(resolveDailyCap([{ providerType: "local" }])).toBe(USER_PLAN_CAP);
  });

  it("classifies on the PRIMARY entry — a user-egress chain with an admin-openai fallback stays user-plan", () => {
    expect(
      resolveDailyCap([
        { providerType: "codex" },
        { providerType: "admin-openai" },
      ]),
    ).toBe(USER_PLAN_CAP);
  });

  it("defaults an empty chain to the conservative operator cap", () => {
    expect(resolveDailyCap([])).toBe(OPERATOR_COST_CAP);
  });
});

describe("reserveBudget cap (F1 — user-plan path not locked out)", () => {
  let prismaMock: {
    $queryRaw: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    const dbModule = await import("@/lib/db");
    prismaMock = dbModule.prisma as unknown as typeof prismaMock;
    prismaMock.$queryRaw.mockReset();
    prismaMock.$executeRaw.mockReset();
  });

  it("a user-plan chain does NOT trip after a spend that exceeds the operator cap", async () => {
    // Prior spend well past the 200k operator cap, but under the user-plan cap.
    const priorSpend = OPERATOR_COST_CAP + 50_000;
    prismaMock.$queryRaw.mockResolvedValue([
      { total_tokens: priorSpend + 1_200 },
    ]);
    const { reserveBudget } = await import("../budget");
    const res = await reserveBudget(
      "u",
      1_200,
      "2026-05-10",
      resolveDailyCap([{ providerType: "codex" }]),
      resolveCostOwner([{ providerType: "codex" }]),
    );
    expect(res.allowed).toBe(true);
    // The reservation upsert ran; no refund executeRaw fired.
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("the operator-key path STILL trips once prior spend reaches the operator cap", async () => {
    const priorSpend = OPERATOR_COST_CAP;
    prismaMock.$queryRaw.mockResolvedValue([
      { total_tokens: priorSpend + 1_200, operator_tokens: priorSpend + 1_200 },
    ]);
    prismaMock.$executeRaw.mockResolvedValue(0);
    const { reserveBudget } = await import("../budget");
    const res = await reserveBudget(
      "u",
      1_200,
      "2026-05-10",
      resolveDailyCap([{ providerType: "admin-openai" }]),
      resolveCostOwner([{ providerType: "admin-openai" }]),
    );
    expect(res.allowed).toBe(false);
    // Refund of the reservation fired on refusal.
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
  });
});

/**
 * v1.38.19 (Wave E) — the cap is enforced against the counter it is ABOUT.
 *
 * Production evidence (2026-09-11): the operator's day held 1.0–1.45 M tokens,
 * almost all served by `codex` on his own ChatGPT plan after the shared
 * `admin-openai` key answered 500 — and the chat refused at
 * `totalAfter: 513539` against the 200 k operator ceiling. Comparing the total
 * is the defect; the operator ceiling may only see operator-funded tokens.
 */
/**
 * v1.38.19 (Wave E) — background generation gets a bounded slice of the day.
 *
 * Production evidence (2026-09-11): 150–330 ledger rows a day on the
 * operator's account, 172 `insights.metric` generations by 06:42Z — the
 * automatic jobs had spent the day's ceiling before he opened the chat. A
 * background surface may reserve at most half of the interactive ceiling.
 */
describe("resolveDailyCapFor (Wave E — the job share)", () => {
  it("gives a background surface half the operator ceiling", () => {
    expect(resolveDailyCapFor("job", [{ providerType: "admin-openai" }])).toBe(
      OPERATOR_COST_CAP * JOB_SURFACE_SHARE,
    );
    expect(resolveDailyCapFor("job", [{ providerType: "admin-openai" }])).toBe(
      100_000,
    );
  });

  it("leaves the interactive surfaces the whole ceiling", () => {
    expect(
      resolveDailyCapFor("coach", [{ providerType: "admin-openai" }]),
    ).toBe(OPERATOR_COST_CAP);
    expect(resolveDailyCapFor("coach", [{ providerType: "codex" }])).toBe(
      USER_PLAN_CAP,
    );
  });

  it("shares the user-plan ceiling the same way", () => {
    expect(resolveDailyCapFor("job", [{ providerType: "codex" }])).toBe(
      USER_PLAN_CAP * JOB_SURFACE_SHARE,
    );
  });
});

describe("reserveBudget cap by cost owner (Wave E)", () => {
  let prismaMock: {
    $queryRaw: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    const dbModule = await import("@/lib/db");
    prismaMock = dbModule.prisma as unknown as typeof prismaMock;
    prismaMock.$queryRaw.mockReset();
    prismaMock.$executeRaw.mockReset();
    prismaMock.$executeRaw.mockResolvedValue(0);
  });

  it("admits an operator turn on a day the user's own plan filled", async () => {
    // 1.2 M tokens on the day, but only 150 k of them on the operator's key.
    prismaMock.$queryRaw.mockResolvedValue([
      { total_tokens: 1_200_000 + 1_200, operator_tokens: 150_000 + 1_200 },
    ]);
    const { reserveBudget } = await import("../budget");
    const res = await reserveBudget(
      "u",
      1_200,
      "2026-09-11",
      OPERATOR_COST_CAP,
      "operator",
    );
    expect(res.allowed).toBe(true);
    expect(res.operatorAfter).toBe(151_200);
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("refuses an operator turn once the OPERATOR-funded share reaches the cap", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      {
        total_tokens: 1_200_000 + 1_200,
        operator_tokens: OPERATOR_COST_CAP + 1_200,
      },
    ]);
    const { reserveBudget } = await import("../budget");
    const res = await reserveBudget(
      "u",
      1_200,
      "2026-09-11",
      OPERATOR_COST_CAP,
      "operator",
    );
    expect(res.allowed).toBe(false);
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
  });

  it("keeps the user-plan ceiling on the TOTAL, not on the operator share", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { total_tokens: USER_PLAN_CAP + 1_200, operator_tokens: 0 },
    ]);
    const { reserveBudget } = await import("../budget");
    const res = await reserveBudget(
      "u",
      1_200,
      "2026-09-11",
      USER_PLAN_CAP,
      "user",
    );
    expect(res.allowed).toBe(false);
  });
});

describe("reconcileSpend cached-token subtraction (F3)", () => {
  let prismaMock: { $executeRaw: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    const dbModule = await import("@/lib/db");
    prismaMock = dbModule.prisma as unknown as typeof prismaMock;
    prismaMock.$executeRaw.mockReset();
    prismaMock.$executeRaw.mockResolvedValue(0);
  });

  it("bills total_tokens minus cached input as the signed delta", async () => {
    const { reconcileSpend } = await import("../budget");
    // reserved 1200, gross 20000, cached 13000 → net actual 7000 → delta 5800.
    await reconcileSpend("u", 1_200, 20_000, "2026-05-10", 13_000, {
      servedBy: "admin-openai",
      reservedOwner: "operator",
    });
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    // The tagged-template interpolations carry the delta; assert it is 5800.
    const interpolations = prismaMock.$executeRaw.mock.calls[0].slice(1);
    expect(interpolations).toContain(5_800);
  });

  it("clamps a cached count larger than gross to a zero charge (delta = -reserved)", async () => {
    const { reconcileSpend } = await import("../budget");
    await reconcileSpend("u", 1_200, 5_000, "2026-05-10", 9_999, {
      servedBy: "admin-openai",
      reservedOwner: "operator",
    });
    const interpolations = prismaMock.$executeRaw.mock.calls[0].slice(1);
    // net actual clamped to 0 → delta = 0 - 1200 = -1200.
    expect(interpolations).toContain(-1_200);
  });

  it("defaults cachedTokens to 0 (back-compat) — bills gross", async () => {
    const { reconcileSpend } = await import("../budget");
    await reconcileSpend("u", 1_000, 4_000, "2026-05-10", 0, {
      servedBy: "admin-openai",
      reservedOwner: "operator",
    });
    const interpolations = prismaMock.$executeRaw.mock.calls[0].slice(1);
    expect(interpolations).toContain(3_000);
  });
});

describe("OPERATOR_COST_CAP (F2 — reasoning-aware operator cap)", () => {
  it("is sized for reasoning turns, not a single non-reasoning reply", () => {
    // Was 25_000 (≈ one gpt-5.x reasoning turn). Raised so the operator-key
    // path survives a normal day of reasoning turns.
    expect(OPERATOR_COST_CAP).toBeGreaterThanOrEqual(150_000);
    // The user-plan cap is far more generous — a user's own egress is never
    // gated on the operator-cost ceiling.
    expect(USER_PLAN_CAP).toBeGreaterThan(OPERATOR_COST_CAP);
  });
});
