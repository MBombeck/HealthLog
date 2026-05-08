import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/geo", () => ({
  lookupIpLocation: vi.fn(),
}));

import { auditLog } from "../audit";
import { prisma } from "@/lib/db";
import { lookupIpLocation } from "@/lib/geo";

const ENTRY = { id: "audit-1" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.auditLog.create).mockResolvedValue(ENTRY as never);
  vi.mocked(prisma.auditLog.update).mockResolvedValue(ENTRY as never);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Wait for any micro/macrotask `Promise.race` resolutions to flush.
 * Real timers are used because the Promise wrapping `setTimeout` resolves
 * via the event loop — vi.useFakeTimers() would block the geo-lookup
 * Promise from resolving in tests that need it.
 */
async function flush(): Promise<void> {
  // Two `setImmediate`-equivalent cycles are enough: one for `Promise.race`
  // to resolve and one for the `.then(...)` continuation.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("auditLog", () => {
  it("creates an audit-log row with action, userId, JSON-stringified details, ipAddress and null location", async () => {
    vi.mocked(lookupIpLocation).mockResolvedValueOnce(null);

    await auditLog("auth.login", {
      userId: "user-7",
      details: { reason: "passkey", browser: "firefox" },
      ipAddress: "203.0.113.5",
    });

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.auditLog.create).mock.calls[0][0];
    expect(args.data).toEqual({
      action: "auth.login",
      userId: "user-7",
      details: JSON.stringify({ reason: "passkey", browser: "firefox" }),
      ipAddress: "203.0.113.5",
    });
    // Location is intentionally not set on insert — it's filled later by the
    // geo lookup. The schema column itself is not in the create payload.
    expect(args.data).not.toHaveProperty("location");
  });

  it("persists null userId / null ipAddress / null details when none supplied", async () => {
    await auditLog("auth.bearer.failure");

    const args = vi.mocked(prisma.auditLog.create).mock.calls[0][0];
    expect(args.data).toEqual({
      action: "auth.bearer.failure",
      userId: null,
      details: null,
      ipAddress: null,
    });
    // No IP → no geo lookup enqueued.
    expect(lookupIpLocation).not.toHaveBeenCalled();
  });

  it("for auth.* actions with an ip address, runs geo lookup and updates the row with the resolved location", async () => {
    vi.mocked(lookupIpLocation).mockResolvedValueOnce("Berlin, DE");

    await auditLog("auth.login", {
      userId: "user-8",
      ipAddress: "8.8.8.8",
    });
    await flush();

    expect(lookupIpLocation).toHaveBeenCalledWith("8.8.8.8");
    expect(prisma.auditLog.update).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { location: "Berlin, DE" },
    });
  });

  it("does NOT update the row when geo lookup resolves to null", async () => {
    vi.mocked(lookupIpLocation).mockResolvedValueOnce(null);

    await auditLog("auth.login", {
      userId: "user-9",
      ipAddress: "1.2.3.4",
    });
    await flush();

    expect(lookupIpLocation).toHaveBeenCalledOnce();
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it("does NOT update the row when geo lookup outruns the 3s race timeout", async () => {
    // Lookup that never resolves within 3 s — must lose the Promise.race.
    let neverResolve: (value: string | null) => void;
    vi.mocked(lookupIpLocation).mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          neverResolve = resolve;
        }),
    );

    vi.useFakeTimers();
    const promise = auditLog("auth.login", {
      userId: "user-10",
      ipAddress: "1.2.3.4",
    });
    await promise; // create resolves immediately; race continues in background

    // Advance past the 3 s timeout — race resolves to null path.
    await vi.advanceTimersByTimeAsync(3001);
    vi.useRealTimers();
    await flush();

    expect(prisma.auditLog.update).not.toHaveBeenCalled();
    // Caller stays unblocked — the awaited promise above already resolved.
    // Resolve the dangling lookup so the test process exits cleanly.
    neverResolve!("Tokyo, JP");
    await flush();
  });

  it("non-auth actions never enqueue a geo lookup, even with an IP", async () => {
    await auditLog("medication.create", {
      userId: "user-11",
      ipAddress: "203.0.113.99",
    });
    await flush();

    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    expect(lookupIpLocation).not.toHaveBeenCalled();
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it("silently swallows geo-lookup throws — caller stays unblocked, no update emitted", async () => {
    vi.mocked(lookupIpLocation).mockRejectedValueOnce(
      new Error("upstream 503"),
    );

    // The auditLog promise itself must NOT reject.
    await expect(
      auditLog("auth.login", {
        userId: "user-12",
        ipAddress: "8.8.8.8",
      }),
    ).resolves.toBeUndefined();
    await flush();

    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it("silently swallows update() throws (e.g. row deleted between create + update)", async () => {
    vi.mocked(lookupIpLocation).mockResolvedValueOnce("Paris, FR");
    vi.mocked(prisma.auditLog.update).mockRejectedValueOnce(
      new Error("row gone"),
    );

    await expect(
      auditLog("auth.login", {
        userId: "user-13",
        ipAddress: "8.8.4.4",
      }),
    ).resolves.toBeUndefined();
    await flush();

    expect(prisma.auditLog.update).toHaveBeenCalledOnce();
  });
});
