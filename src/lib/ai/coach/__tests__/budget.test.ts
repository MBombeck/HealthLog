import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  buildDateKey,
  OPERATOR_COST_CAP,
  USER_PLAN_CAP,
  INTERACTIVE_RESERVE_SHARE,
  resolveCostOwner,
  resolveDailyCap,
  resolveDailyCapFor,
  resolveTotalCapFor,
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
      "coach",
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
      "coach",
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
      "coach",
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
      "coach",
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
      "coach",
    );
    expect(res.allowed).toBe(false);
    // Refund of the reservation fired on refusal.
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
  });
});

/**
 * v1.38.19 — the cap is enforced against the counter it is ABOUT.
 *
 * Production evidence (2026-09-11): the operator's day held 1.0–1.45 M tokens,
 * almost all served by `codex` on his own ChatGPT plan after the shared
 * `admin-openai` key answered 500 — and the chat refused at
 * `totalAfter: 513539` against the 200 k operator ceiling. Comparing the total
 * is the defect; the operator ceiling may only see operator-funded tokens.
 */
/**
 * v1.38.20 — the interactive surface is never locked out by background work.
 *
 * Production evidence (2026-09-11): 150–330 ledger rows a day on the
 * operator's account, 172 `insights.metric` generations by 06:42Z — the
 * automatic jobs had spent the day's ceiling before he opened the chat.
 *
 * The guarantee is a floor under the person waiting, NOT a quota over the
 * jobs: background generation runs freely until the day's spend would leave
 * less than the reserve for interactive use. That distinction is the whole
 * design. An account doing 1.45 M tokens of background work a day on its own
 * plan costs nobody anything and keeps all of it; what it cannot do is take
 * the last 400 000 the chat is holding.
 */
describe("resolveDailyCapFor — the interactive reserve", () => {
  it("lets a background surface reach everything but the reserve", () => {
    expect(resolveDailyCapFor("job", [{ providerType: "admin-openai" }])).toBe(
      OPERATOR_COST_CAP -
        Math.floor(OPERATOR_COST_CAP * INTERACTIVE_RESERVE_SHARE),
    );
    expect(resolveDailyCapFor("job", [{ providerType: "admin-openai" }])).toBe(
      160_000,
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

  it("holds the reserve on a chain the operator does not pay for too", () => {
    // The earlier cut exempted these chains entirely, on the grounds that the
    // operator's invoice is what a quota protects. True of a quota, and beside
    // the point here: a self-hoster's chat is locked out by his own background
    // jobs exactly as painfully, and the recommended remedy for the operator's
    // own account — put Codex first — moves him onto this arm. The reserve is
    // about who is waiting, not about who is billed.
    expect(resolveDailyCapFor("job", [{ providerType: "codex" }])).toBe(
      1_600_000,
    );
    expect(resolveDailyCapFor("job", [{ providerType: "local" }])).toBe(
      1_600_000,
    );
    // ...and what is held back is the reserve, exactly.
    expect(
      USER_PLAN_CAP - resolveDailyCapFor("job", [{ providerType: "codex" }]),
    ).toBe(400_000);
  });
});

describe("resolveTotalCapFor — the abuse ceiling", () => {
  it("keeps the user-plan ceiling on the day's mixed total", () => {
    // The operator arm compares `operator_tokens`, a counter that returns to
    // ~0 on every reconcile the user's own plan settled. Without a ceiling on
    // the total, an operator-primary chain has no ceiling at all: every job
    // reservation is admitted forever and a runaway client loop writes an
    // unbounded row.
    expect(resolveTotalCapFor("coach")).toBe(USER_PLAN_CAP);
  });

  it("holds the same reserve on the total for a background surface", () => {
    expect(resolveTotalCapFor("job")).toBe(1_600_000);
    expect(USER_PLAN_CAP - resolveTotalCapFor("job")).toBe(400_000);
  });
});

describe("reserveBudget — the cap follows the cost owner", () => {
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
      "coach",
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
      "coach",
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
      "coach",
    );
    expect(res.allowed).toBe(false);
  });

  // v1.38.19 — the abuse ceiling survives the owner split.
  //
  // The first cut compared `operator_tokens` and NOTHING else for an
  // operator-funded chain. On the 2026-09-11 shape that counter never grows:
  // `admin-openai` 500s, `codex` serves, and every reconcile moves the
  // reservation back out of the operator's column. So an operator-primary chain
  // had no ceiling at all — every job reservation admitted forever, and a
  // runaway client loop free to write an unbounded row.
  it("refuses a JOB on an operator chain once the day's TOTAL fills its share", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { total_tokens: 1_900_000 + 1_200, operator_tokens: 0 },
    ]);
    const { reserveBudget, resolveDailyCapFor } = await import("../budget");
    const res = await reserveBudget(
      "u",
      1_200,
      "2026-09-11",
      resolveDailyCapFor("job", [{ providerType: "admin-openai" }]),
      "operator",
      "job",
    );
    expect(res.allowed).toBe(false);
    expect(res.limit).toBe("total-cap");
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
  });

  it("still admits the interactive chat on that same day", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { total_tokens: 1_900_000 + 1_200, operator_tokens: 0 },
    ]);
    const { reserveBudget } = await import("../budget");
    const res = await reserveBudget(
      "u",
      1_200,
      "2026-09-11",
      OPERATOR_COST_CAP,
      "operator",
      "coach",
    );
    expect(res.allowed).toBe(true);
    expect(res.limit).toBeNull();
  });

  it("refuses an operator chain once the TOTAL reaches the abuse ceiling", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { total_tokens: USER_PLAN_CAP + 1_200, operator_tokens: 0 },
    ]);
    const { reserveBudget } = await import("../budget");
    const res = await reserveBudget(
      "u",
      1_200,
      "2026-09-11",
      OPERATOR_COST_CAP,
      "operator",
      "coach",
    );
    expect(res.allowed).toBe(false);
    expect(res.limit).toBe("total-cap");
  });

  // v1.38.20 — the reserve, from the reservation's side.
  //
  // `resolveDailyCapFor` only answers what a surface MAY reach; these pin what
  // actually happens at the edge of it, on both cost owners, because the claim
  // the ceiling exists to support is behavioural: the person waiting gets a
  // turn no matter how much background work ran first.
  it("admits the chat on a USER-funded chain whose background work is at its limit", async () => {
    // Nobody is billed for this egress — the user's own ChatGPT plan served
    // every one of those tokens — so the jobs were never rationed. They still
    // cannot take the last of the day.
    prismaMock.$queryRaw.mockResolvedValue([
      { total_tokens: 1_600_000 + 3_000, operator_tokens: 0 },
    ]);
    const { reserveBudget, resolveDailyCapFor, resolveCostOwner } =
      await import("../budget");
    const chain = [{ providerType: "codex" as const }];

    const job = await reserveBudget(
      "u",
      3_000,
      "2026-09-11",
      resolveDailyCapFor("job", chain),
      resolveCostOwner(chain),
      "job",
    );
    expect(job.allowed).toBe(false);

    const chat = await reserveBudget(
      "u",
      3_000,
      "2026-09-11",
      resolveDailyCapFor("coach", chain),
      resolveCostOwner(chain),
      "coach",
    );
    expect(chat.allowed).toBe(true);
    expect(chat.limit).toBeNull();
  });

  it("admits the chat on an OPERATOR-funded chain whose background work is at its limit", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { total_tokens: 160_000 + 3_000, operator_tokens: 160_000 + 3_000 },
    ]);
    const { reserveBudget, resolveDailyCapFor, resolveCostOwner } =
      await import("../budget");
    const chain = [{ providerType: "admin-openai" as const }];

    const job = await reserveBudget(
      "u",
      3_000,
      "2026-09-11",
      resolveDailyCapFor("job", chain),
      resolveCostOwner(chain),
      "job",
    );
    expect(job.allowed).toBe(false);
    expect(job.limit).toBe("owner-cap");

    const chat = await reserveBudget(
      "u",
      3_000,
      "2026-09-11",
      resolveDailyCapFor("coach", chain),
      resolveCostOwner(chain),
      "coach",
    );
    expect(chat.allowed).toBe(true);
  });

  it("admits the background reservation one token below that boundary", async () => {
    // The ledger's rule throughout is that a request is admitted when the spend
    // BEFORE it was under the ceiling, so the boundary is exact: at the ceiling
    // the job stops, one token below it runs.
    const { reserveBudget, resolveDailyCapFor, resolveCostOwner } =
      await import("../budget");
    const chain = [{ providerType: "codex" as const }];
    const jobCap = resolveDailyCapFor("job", chain);

    prismaMock.$queryRaw.mockResolvedValue([
      { total_tokens: jobCap - 1 + 3_000, operator_tokens: 0 },
    ]);
    const admitted = await reserveBudget(
      "u",
      3_000,
      "2026-09-11",
      jobCap,
      resolveCostOwner(chain),
      "job",
    );
    expect(admitted.allowed).toBe(true);

    prismaMock.$queryRaw.mockResolvedValue([
      { total_tokens: jobCap + 3_000, operator_tokens: 0 },
    ]);
    const refused = await reserveBudget(
      "u",
      3_000,
      "2026-09-11",
      jobCap,
      resolveCostOwner(chain),
      "job",
    );
    expect(refused.allowed).toBe(false);
  });

  it("names the owner cap when that is the ceiling that tripped", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      {
        total_tokens: 300_000 + 1_200,
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
      "coach",
    );
    expect(res.allowed).toBe(false);
    expect(res.limit).toBe("owner-cap");
    expect(res.operatorAfter).toBe(OPERATOR_COST_CAP);
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
