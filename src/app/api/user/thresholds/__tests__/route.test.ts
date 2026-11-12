/**
 * v1.4.43 — multi-issue 422 envelope on PUT /api/user/thresholds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));
// The thresholds validator imports METRIC_BOUNDS at module top-level
// to build its strict-object schema, so we need to keep the real export
// surface around when we mock the module.
vi.mock("@/lib/analytics/effective-range", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/analytics/effective-range")>();
  return {
    ...actual,
    getAllEffectiveRanges: vi.fn().mockReturnValue({}),
  };
});
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserProfile: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PUT, DELETE } from "../route";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { getAllEffectiveRanges } from "@/lib/analytics/effective-range";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function putReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/user/thresholds", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteReq(
  options: { metric?: string; body?: unknown } = {},
): NextRequest {
  const url = options.metric
    ? `http://localhost/api/user/thresholds?metric=${options.metric}`
    : "http://localhost/api/user/thresholds";
  return new NextRequest(url, {
    method: "DELETE",
    ...(options.body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options.body),
        }),
  });
}

/** The stored override set the DELETE branches read before they write. */
function armOverrides(overrides: Record<string, unknown>) {
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    thresholdsJson: overrides,
  } as never);
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("PUT /api/user/thresholds — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // WEIGHT bounds are min=1, max=300. Sending min > max + a value
    // out of bounds on PULSE forces two range errors.
    const res = await PUT(
      putReq({
        WEIGHT: { min: 100, max: 50 }, // refine min < max
        PULSE: { min: 1000, max: 2000 }, // out of bounds
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    const res = await PUT(
      putReq({
        WEIGHT: { min: 100, max: 50 },
        PULSE: { min: 1000, max: 2000 },
        BODY_FAT: { min: 999, max: 1000 },
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * The parameterless DELETE erases every band the account has tuned, and it
 * used to do it on an omitted query parameter alone — no confirmation, no dry
 * run, and no rate limit of its own while the PUT beside it had one.
 *
 * The confirmation is the same shape the other two wide deletes use
 * (`/api/settings/account` wants `DELETE_ACCOUNT`, `/api/settings/data` wants
 * `DELETE`): a literal in the body, compared exactly. What is pinned here is
 * the pair of properties that make it worth anything — the refusal happens,
 * AND nothing was written when it does. A status assertion on its own would
 * stay green if the wipe ran first and the 422 came after it.
 *
 * The single-metric form is pinned as UNCHANGED in the same block, because the
 * failure mode of a confirmation is that it spreads to the narrow path and
 * breaks the targets sheet, which resets metrics in a loop.
 *
 * Mutation check: drop the `confirm !== RESET_ALL_CONFIRMATION` branch and the
 * first two cases go red; drop the rate-limit call and the fourth goes red;
 * extend the confirmation to the `?metric=` arm and the fifth goes red.
 */
describe("DELETE /api/user/thresholds — the wide form asks first", () => {
  it("refuses the parameterless form with no body", async () => {
    armOverrides({ WEIGHT: { min: 60, max: 80 } });

    const res = await DELETE(deleteReq());

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("RESET_THRESHOLDS");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses a body whose confirmation is the wrong token", async () => {
    armOverrides({ WEIGHT: { min: 60, max: 80 } });

    const res = await DELETE(deleteReq({ body: { confirm: "DELETE" } }));

    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("wipes every override once the confirmation is present", async () => {
    armOverrides({ WEIGHT: { min: 60, max: 80 }, PULSE: { min: 50, max: 90 } });

    const res = await DELETE(
      deleteReq({ body: { confirm: "RESET_THRESHOLDS" } }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { overrides: unknown } };
    expect(body.data.overrides).toEqual({});
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("runs the sibling's rate limit and honours a refusal", async () => {
    armOverrides({ WEIGHT: { min: 60, max: 80 } });
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

    const res = await DELETE(
      deleteReq({ body: { confirm: "RESET_THRESHOLDS" } }),
    );

    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith(
      "thresholds:reset:user-1",
      30,
      5 * 60 * 1000,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  /**
   * The other end. A confirmation the server demands and the only client that
   * sends the wide form does not send is not a safeguard, it is an outage —
   * and it would look like a passing suite, because the route tests above
   * construct their own requests. So the token is compared across the two
   * files rather than assumed to match.
   */
  it("is the same token the settings card sends", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const route = readFileSync(
      join(process.cwd(), "src/app/api/user/thresholds/route.ts"),
      "utf8",
    );
    const client = readFileSync(
      join(
        process.cwd(),
        "src/components/settings/thresholds-editor-section.tsx",
      ),
      "utf8",
    );

    const declared = route.match(/RESET_ALL_CONFIRMATION = "([^"]+)"/)?.[1];
    expect(declared, "the route no longer declares a confirmation").toBe(
      "RESET_THRESHOLDS",
    );
    expect(client).toContain(`confirm: "${declared}"`);
  });

  it("leaves the single-metric form exactly as it was", async () => {
    armOverrides({ WEIGHT: { min: 60, max: 80 }, PULSE: { min: 50, max: 90 } });

    // No body at all — the targets sheet sends none, and must keep working.
    const res = await DELETE(deleteReq({ metric: "WEIGHT" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { overrides: Record<string, unknown> };
    };
    expect(Object.keys(body.data.overrides)).toEqual(["PULSE"]);
  });
});

/**
 * The docblock promised a key the handler has never returned.
 *
 * For as long as this route has existed its header said GET answers
 * `{ defaults, overrides, effective }`. It answers `{ effective, overrides }`;
 * the per-metric defaults live inside `effective[metric].default`. Anyone
 * reading the file to find out what to decode was told to expect a top-level
 * key that is not there.
 *
 * Asserting the shape alone would not have caught it — the code was always
 * right. So this compares the two: the keys the response actually carries
 * against the keys the docblock advertises. A comment that drifts from the
 * handler fails here, in either direction.
 */
describe("GET /api/user/thresholds — the docblock describes the response", () => {
  const RESPONSE_KEYS = ["effective", "overrides"];

  it("returns exactly the documented top-level keys", async () => {
    // `beforeEach` calls `vi.resetAllMocks()`, which clears the module-level
    // `mockReturnValue({})` — without re-arming it the resolver returns
    // undefined and `effective` vanishes from the JSON entirely.
    vi.mocked(getAllEffectiveRanges).mockReturnValue({
      WEIGHT: {
        range: { greenMin: 60, greenMax: 80, orangeMin: 57, orangeMax: 83 },
        isOverride: false,
        default: { greenMin: 60, greenMax: 80, orangeMin: 57, orangeMax: 83 },
        bounds: { min: 30, max: 300, unit: "kg" },
      },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 180,
      dateOfBirth: null,
      gender: null,
      thresholdsJson: null,
    } as never);

    const res = await (GET as unknown as () => Promise<Response>)();
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual([...RESPONSE_KEYS].sort());
    expect(body.data).not.toHaveProperty("defaults");
  });

  it("names those same keys in the route's own header comment", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "src/app/api/user/thresholds/route.ts"),
      "utf8",
    );
    const docblock = source.slice(0, source.indexOf("*/"));

    // The promise the header makes, as a brace list: `{ effective, overrides }`.
    const promised = docblock.match(/GET returns `\{([^}]+)\}`/);
    expect(
      promised,
      "the header no longer states what GET returns",
    ).not.toBeNull();

    const promisedKeys = (promised?.[1] ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean)
      .sort();

    expect(promisedKeys).toEqual([...RESPONSE_KEYS].sort());
  });
});
