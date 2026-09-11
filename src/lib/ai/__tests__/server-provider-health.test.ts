/**
 * v1.38.19 (wave D) — the instance-wide health of the operator's shared
 * provider, as a tri-state a FRESH account is allowed to read.
 *
 * The ledger itself is per-user and fails OPEN (an optimisation, never a
 * gate). This projection is the opposite on both counts: it folds rows
 * across every account into one instance-level verdict, and it fails
 * CLOSED — anything but a demonstrated recent success is not an offer.
 *
 * What it must never leak: how many accounts are tracked, when any of them
 * last succeeded, or which account a row belongs to. The return type is the
 * whole contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    providerHealth: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  SERVER_PROVIDER_FRESH_WINDOW_MS,
  readServerProviderHealth,
} from "../server-provider-health";

const NOW = new Date("2026-09-11T12:00:00.000Z");

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function ahead(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

function rows(
  ...list: Array<{
    lastResult: string;
    lastOkAt?: Date | null;
    nextRetryAt?: Date | null;
  }>
) {
  vi.mocked(prisma.providerHealth.findMany).mockResolvedValue(
    list.map((row) => ({
      lastResult: row.lastResult,
      lastOkAt: row.lastOkAt ?? null,
      nextRetryAt: row.nextRetryAt ?? null,
    })) as never,
  );
}

beforeEach(() => {
  vi.mocked(prisma.providerHealth.findMany).mockReset();
  vi.mocked(annotate).mockReset();
});

describe("readServerProviderHealth", () => {
  it("is healthy when some account saw the shared provider work inside the window", async () => {
    rows({ lastResult: "ok", lastOkAt: ago(60 * 60 * 1000) });
    await expect(readServerProviderHealth(NOW)).resolves.toBe("healthy");
  });

  it("is unhealthy when the last success is older than the window", async () => {
    rows({
      lastResult: "ok",
      lastOkAt: ago(SERVER_PROVIDER_FRESH_WINDOW_MS + 60_000),
    });
    await expect(readServerProviderHealth(NOW)).resolves.toBe("unhealthy");
  });

  it("is unhealthy when rows exist but none ever succeeded", async () => {
    rows({ lastResult: "hard_failed", lastOkAt: null });
    await expect(readServerProviderHealth(NOW)).resolves.toBe("unhealthy");
  });

  it("lets a 401 in cooldown beat a fresh ok — a dead key means the same for everyone", async () => {
    rows(
      { lastResult: "ok", lastOkAt: ago(60 * 1000) },
      {
        lastResult: "auth_failed",
        lastOkAt: ago(3 * 60 * 60 * 1000),
        nextRetryAt: ahead(60 * 60 * 1000),
      },
    );
    await expect(readServerProviderHealth(NOW)).resolves.toBe("unhealthy");
  });

  it("ignores an auth failure whose cooldown has run out", async () => {
    rows(
      { lastResult: "ok", lastOkAt: ago(60 * 1000) },
      {
        lastResult: "auth_failed",
        lastOkAt: null,
        nextRetryAt: ago(60 * 1000),
      },
    );
    await expect(readServerProviderHealth(NOW)).resolves.toBe("healthy");
  });

  it("is unknown when the instance has no rows for either shared provider", async () => {
    rows();
    await expect(readServerProviderHealth(NOW)).resolves.toBe("unknown");
  });

  it("is unknown when the read throws, and says so in the event", async () => {
    vi.mocked(prisma.providerHealth.findMany).mockRejectedValue(
      new Error("connection terminated"),
    );
    await expect(readServerProviderHealth(NOW)).resolves.toBe("unknown");
    expect(vi.mocked(annotate)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "ai.server_health.read_failed" },
      }),
    );
  });

  it("reads only the operator-funded provider tags, and no per-account column", async () => {
    rows({ lastResult: "ok", lastOkAt: ago(1000) });
    await readServerProviderHealth(NOW);
    const args = vi.mocked(prisma.providerHealth.findMany).mock.calls[0]![0]!;
    expect(args.where).toEqual({
      providerType: { in: ["admin-openai", "admin-codex"] },
    });
    expect(Object.keys(args.select ?? {}).sort()).toEqual([
      "lastOkAt",
      "lastResult",
      "nextRetryAt",
    ]);
  });
});
