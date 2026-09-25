import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// v1.18.0 — the GET alias resolves the module map. Stub it so these
// tests assert the projection wiring without standing up the gate's
// own DB round-trips (operator availability + assistant flags + cycle).
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: vi.fn().mockResolvedValue({
    sleep: true,
    glucose: true,
    cycle: false,
    coach: true,
  }),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PATCH } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { resolveModuleMap } from "@/lib/modules/gate";

const MODULE_MAP = {
  sleep: true,
  glucose: true,
  cycle: false,
  coach: true,
} as const;

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveModuleMap).mockResolvedValue(MODULE_MAP as never);
  // The operator's default zone, which the server falls back to when a
  // stored one is unusable. Distinct from the built-in default so a test can
  // tell the resolver ran.
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
    defaultUserTimezone: "America/Chicago",
  } as never);
});

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeGetReq(): NextRequest {
  return new NextRequest("http://localhost/api/user/profile");
}

describe("GET /api/user/profile", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeGetReq());
    expect(res.status).toBe(401);
  });

  it("returns flattened iOS-style fields", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      username: "testuser",
      displayName: "Alex T.",
      email: "user@example.com",
      dateOfBirth: new Date("1985-03-12T00:00:00.000Z"),
      gender: "MALE",
      heightCm: 180,
      locale: "de",
      timezone: "Europe/Berlin",
    } as never);

    const res = await callGet(makeGetReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        username: string;
        displayName: string | null;
        heightCm: number;
        locale: string | null;
      };
    };
    expect(body.data.username).toBe("testuser");
    expect(body.data.displayName).toBe("Alex T.");
    expect(body.data.heightCm).toBe(180);
    expect(body.data.locale).toBe("de");
  });

  it("echoes the insurer IK number on GET", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      username: "testuser",
      displayName: null,
      email: null,
      dateOfBirth: null,
      gender: null,
      heightCm: null,
      locale: null,
      timezone: "Europe/Berlin",
      moodReminderEnabled: false,
      fullName: null,
      insurerName: "Example Insurer",
      insurerIkNumber: "101234567",
      insuranceNumberEncrypted: null,
    } as never);

    const res = await callGet(makeGetReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { insurerIkNumber: string | null; insurerName: string | null };
    };
    expect(body.data.insurerIkNumber).toBe("101234567");
    expect(body.data.insurerName).toBe("Example Insurer");
  });

  // v1.18.0 — the alias the iOS app reads must carry the resolved module
  // map, matching the /api/auth/me projection so the client gets module
  // flags from the endpoint it actually fetches.
  it("includes the resolved module map", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      username: "testuser",
      displayName: null,
      email: null,
      dateOfBirth: null,
      gender: null,
      heightCm: null,
      locale: null,
      timezone: "Europe/Berlin",
      moodReminderEnabled: false,
      fullName: null,
      insurerName: null,
      insurerIkNumber: null,
      insuranceNumberEncrypted: null,
    } as never);

    const res = await callGet(makeGetReq());
    expect(res.status).toBe(200);
    expect(resolveModuleMap).toHaveBeenCalledWith("user-1");
    const body = (await res.json()) as {
      data: { modules: Record<string, boolean> };
    };
    expect(body.data.modules).toEqual(MODULE_MAP);
  });
});

describe("PATCH /api/user/profile", () => {
  function req(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/user/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await PATCH(req({ displayName: "Test" }));
    expect(res.status).toBe(401);
  });

  it("returns 422 for invalid heightCm", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PATCH(req({ heightCm: 9999 }));
    expect(res.status).toBe(422);
  });

  it("persists displayName + locale via shared helper", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: "user-1",
      username: "testuser",
      displayName: "Alex T.",
      email: null,
      role: "USER",
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      timezone: "Europe/Berlin",
      locale: "de",
    } as never);

    const res = await PATCH(req({ displayName: "Alex T.", locale: "de" }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({
          displayName: "Alex T.",
          locale: "de",
        }),
      }),
    );
  });

  it("accepts a valid IKNR and echoes it back", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: "user-1",
      username: "testuser",
      displayName: null,
      email: null,
      role: "USER",
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      timezone: "Europe/Berlin",
      locale: null,
      moodReminderEnabled: false,
      fullName: null,
      insurerName: null,
      insurerIkNumber: "101234567",
      insuranceNumberEncrypted: null,
    } as never);

    const res = await PATCH(req({ insurerIkNumber: "101234567" }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ insurerIkNumber: "101234567" }),
      }),
    );
    const body = (await res.json()) as {
      data: { insurerIkNumber: string | null };
    };
    expect(body.data.insurerIkNumber).toBe("101234567");
  });

  it("returns 422 for a malformed IKNR", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PATCH(req({ insurerIkNumber: "abc" }));
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  // v1.15.20 — hour-cycle display preference rides the shared profile
  // update path: a valid enum value persists field-by-field and echoes
  // back; anything outside AUTO/H12/H24 is rejected by the Zod schema.
  it("persists a valid timeFormat and echoes it back", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: "user-1",
      username: "testuser",
      displayName: null,
      email: null,
      role: "USER",
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      timezone: "Europe/Berlin",
      locale: null,
      timeFormat: "H24",
      moodReminderEnabled: false,
      fullName: null,
      insurerName: null,
      insurerIkNumber: null,
      insuranceNumberEncrypted: null,
    } as never);

    const res = await PATCH(req({ timeFormat: "H24" }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({ timeFormat: "H24" }),
      }),
    );
    const body = (await res.json()) as {
      data: { timeFormat: string };
    };
    expect(body.data.timeFormat).toBe("H24");
  });

  it("returns 422 for an invalid timeFormat", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PATCH(req({ timeFormat: "12h" }));
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  /**
   * The whole profile PATCH is one write, so a rejected gender took every
   * sibling change down with it — someone switching their time format lost
   * the save over a field they never touched.
   */
  it("clears gender on an empty string and still persists the sibling change", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: "user-1",
      username: "testuser",
      displayName: null,
      email: null,
      role: "USER",
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      timezone: "Europe/Berlin",
      locale: null,
      timeFormat: "H24",
      dateFormat: "AUTO",
      moodReminderEnabled: false,
      fullName: null,
      insurerName: null,
      insurerIkNumber: null,
      insuranceNumberEncrypted: null,
    } as never);

    const res = await PATCH(req({ timeFormat: "H24", gender: "" }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ timeFormat: "H24", gender: null }),
      }),
    );
  });

  it("accepts OTHER and writes it through", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: "user-1",
      username: "testuser",
      displayName: null,
      email: null,
      role: "USER",
      heightCm: null,
      dateOfBirth: null,
      gender: "OTHER",
      timezone: "Europe/Berlin",
      locale: null,
      timeFormat: "AUTO",
      dateFormat: "AUTO",
      moodReminderEnabled: false,
      fullName: null,
      insurerName: null,
      insurerIkNumber: null,
      insuranceNumberEncrypted: null,
    } as never);

    const res = await PATCH(req({ gender: "OTHER" }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ gender: "OTHER" }),
      }),
    );
    const body = (await res.json()) as { data: { gender: string | null } };
    expect(body.data.gender).toBe("OTHER");
  });

  it("still refuses an unsupported gender alone, with a message that names the field", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PATCH(req({ gender: "diverse" }));
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      error: string;
      details?: { issues?: Array<{ path: string; message: string }> };
    };
    // The top-level message is a sentence for a person — it names the
    // field but never repeats the validator's own enum-literal prose.
    expect(body.error).toMatch(/nothing was saved/i);
    expect(body.error).toContain("gender");
    expect(body.error).not.toContain("Invalid option");
    // The specific reason is relocated, not deleted.
    expect(body.details?.issues?.[0]).toMatchObject({ path: "gender" });
  });

  // Reported regression: a rejected `gender` took a sibling `timeFormat`
  // edit down with it because the whole PATCH was one transaction. The
  // schema has no cross-field dependency, so the valid field must now
  // land even when `gender` is rejected in the same body.
  it("persists a valid sibling field even when gender in the same body is unsupported", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: "user-1",
      username: "testuser",
      displayName: null,
      email: null,
      role: "USER",
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      timezone: "Europe/Berlin",
      locale: null,
      timeFormat: "H24",
      dateFormat: "AUTO",
      moodReminderEnabled: false,
      fullName: null,
      insurerName: null,
      insurerIkNumber: null,
      insuranceNumberEncrypted: null,
    } as never);

    const res = await PATCH(req({ timeFormat: "H24", gender: "diverse" }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ timeFormat: "H24" }),
      }),
    );
    const arg = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect("gender" in arg.data).toBe(false);
    const body = (await res.json()) as {
      error: string | null;
      data: {
        timeFormat: string;
        rejectedFields?: Array<{ path: string }>;
      };
    };
    expect(body.error).toBeNull();
    expect(body.data.timeFormat).toBe("H24");
    expect(body.data.rejectedFields).toEqual([
      expect.objectContaining({ path: "gender" }),
    ]);
  });
});

/**
 * `/api/auth/me` has returned the zone the server actually cuts days in —
 * the stored one, or the instance default when the stored value is unusable
 * — while this alias returned the raw column. A client reading this endpoint
 * could bucket a day differently from the server. Both now go through the
 * same resolution.
 */
describe("/api/user/profile — timezone is the resolved zone", () => {
  function profileRow(timezone: string | null) {
    return {
      username: "testuser",
      displayName: null,
      email: null,
      dateOfBirth: null,
      gender: null,
      heightCm: null,
      locale: null,
      timezone,
      moodReminderEnabled: false,
      fullName: null,
      insurerName: null,
      insurerIkNumber: null,
      insuranceNumberEncrypted: null,
    };
  }

  async function getZone(stored: string | null): Promise<string> {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      profileRow(stored) as never,
    );
    const res = await callGet(makeGetReq());
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { timezone: string } }).data.timezone;
  }

  it("returns a usable stored zone as stored", async () => {
    expect(await getZone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("returns the instance default in place of a bare offset", async () => {
    expect(await getZone("+05:30")).toBe("America/Chicago");
  });

  it("returns the instance default in place of a name no runtime knows", async () => {
    expect(await getZone("Mars/Olympus_Mons")).toBe("America/Chicago");
  });

  it("returns the instance default when the row is missing", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const res = await callGet(makeGetReq());
    const body = (await res.json()) as { data: { timezone: string } };
    expect(body.data.timezone).toBe("America/Chicago");
  });

  it("answers a PATCH that leaves an unusable zone untouched with the resolved one", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({
      ...profileRow("+05:30"),
      id: "user-1",
      role: "USER",
      displayName: "Alex T.",
    } as never);
    const res = await PATCH(
      new NextRequest("http://localhost/api/user/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Alex T." }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { timezone: string } };
    expect(body.data.timezone).toBe("America/Chicago");
  });
});
