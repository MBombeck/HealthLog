/**
 * v1.25 — the briefing failure marker drives the read path's "couldn't
 * refresh" signal WITHOUT touching the cached briefing text. These tests pin
 * that a marker newer than the last successful generation reads as a failure,
 * an older one is treated as superseded, and a write failure never throws.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirst = vi.fn();
const create = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      create: (...a: unknown[]) => create(...a),
    },
  },
}));

import {
  readBriefingFailure,
  recordBriefingFailure,
  classifyBriefingFailure,
  BRIEFING_FAILURE_ACTION,
} from "../briefing-failure-marker";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readBriefingFailure", () => {
  it("returns the failure when the marker is newer than the last success", async () => {
    findFirst.mockResolvedValue({
      createdAt: new Date("2026-06-28T10:00:00Z"),
      details: JSON.stringify({ reason: "provider-error" }),
    });

    const result = await readBriefingFailure({
      userId: "u1",
      since: new Date("2026-06-28T09:00:00Z"),
    });

    expect(result).toEqual(
      expect.objectContaining({ reason: "provider-error" }),
    );
  });

  it("derives a failure class from the recorded reason + httpStatus (v1.25.3)", async () => {
    findFirst.mockResolvedValue({
      createdAt: new Date("2026-06-28T10:00:00Z"),
      details: JSON.stringify({ reason: "provider-error", httpStatus: 401 }),
    });

    const result = await readBriefingFailure({
      userId: "u1",
      since: new Date("2026-06-28T09:00:00Z"),
    });

    expect(result?.failureClass).toBe("auth");
  });

  it("classes a status-less failure as a timeout (the slow-backend case)", async () => {
    findFirst.mockResolvedValue({
      createdAt: new Date("2026-06-28T10:00:00Z"),
      details: JSON.stringify({ reason: "provider-error" }),
    });

    const result = await readBriefingFailure({
      userId: "u1",
      since: new Date("2026-06-28T09:00:00Z"),
    });

    expect(result?.failureClass).toBe("timeout");
  });

  it("treats a marker older than the last success as superseded", async () => {
    findFirst.mockResolvedValue({
      createdAt: new Date("2026-06-28T08:00:00Z"),
      details: JSON.stringify({ reason: "provider-error" }),
    });

    const result = await readBriefingFailure({
      userId: "u1",
      since: new Date("2026-06-28T09:00:00Z"),
    });

    expect(result).toBeNull();
  });

  it("returns null when no marker exists", async () => {
    findFirst.mockResolvedValue(null);
    expect(await readBriefingFailure({ userId: "u1", since: null })).toBeNull();
  });
});

describe("recordBriefingFailure", () => {
  it("writes an append-only marker row under the failure action", async () => {
    create.mockResolvedValue({});
    await recordBriefingFailure({
      userId: "u1",
      reason: "timeout",
      locale: "en",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u1",
          action: BRIEFING_FAILURE_ACTION,
        }),
      }),
    );
  });

  it("never throws when the write fails", async () => {
    create.mockRejectedValue(new Error("db down"));
    await expect(
      recordBriefingFailure({ userId: "u1", reason: "timeout" }),
    ).resolves.toBeUndefined();
  });

  it("persists the upstream httpStatus when one is supplied (v1.25.3)", async () => {
    create.mockResolvedValue({});
    await recordBriefingFailure({
      userId: "u1",
      reason: "provider-error",
      httpStatus: 429,
    });
    const details = create.mock.calls[0][0].data.details as string;
    expect(JSON.parse(details).httpStatus).toBe(429);
  });
});

describe("classifyBriefingFailure", () => {
  it("maps invalid-json to format regardless of status", () => {
    expect(classifyBriefingFailure({ reason: "invalid-json" })).toBe("format");
  });

  it("maps an unrenderable briefing to format (#1499)", () => {
    expect(classifyBriefingFailure({ reason: "invalid-briefing" })).toBe(
      "format",
    );
  });

  it("maps 429 to rate-limit, other 4xx to auth, 5xx to provider", () => {
    expect(
      classifyBriefingFailure({ reason: "provider-error", httpStatus: 429 }),
    ).toBe("rate-limit");
    expect(
      classifyBriefingFailure({ reason: "provider-error", httpStatus: 403 }),
    ).toBe("auth");
    expect(
      classifyBriefingFailure({ reason: "provider-error", httpStatus: 503 }),
    ).toBe("provider");
  });

  it("claims a timeout only for a deadline once the failure kind is known (#1267)", () => {
    const at = (failureKind: string) =>
      classifyBriefingFailure({
        reason: "all-providers-failed",
        httpStatus: 0,
        failureKind,
      });
    expect(at("timeout")).toBe("timeout");
    expect(at("headers_timeout")).toBe("timeout");
    // A 200 that reasoned and never answered is the model's output.
    expect(at("reasoning_only")).toBe("format");
    expect(at("empty_response")).toBe("format");
    // A refused or dropped connection is the provider.
    expect(at("refused")).toBe("provider");
    expect(at("socket")).toBe("provider");
  });

  it("reads the failure kind back from the marker (#1267)", async () => {
    create.mockResolvedValue({});
    await recordBriefingFailure({
      userId: "u1",
      reason: "all-providers-failed",
      httpStatus: 0,
      failureKind: "reasoning_only",
    });
    const details = create.mock.calls[0][0].data.details as string;
    expect(JSON.parse(details).failureKind).toBe("reasoning_only");
    findFirst.mockResolvedValue({
      createdAt: new Date("2026-06-28T10:00:00Z"),
      details,
    });
    const result = await readBriefingFailure({
      userId: "u1",
      since: new Date("2026-06-28T09:00:00Z"),
    });
    expect(result?.failureClass).toBe("format");
  });

  it("maps a missing / sentinel-zero status to timeout", () => {
    expect(classifyBriefingFailure({ reason: "provider-error" })).toBe(
      "timeout",
    );
    expect(
      classifyBriefingFailure({
        reason: "all-providers-failed",
        httpStatus: 0,
      }),
    ).toBe("timeout");
  });
});
