import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  // The shared single-record write ceiling. Allowed here: this file is about
  // what the handler does with a body it accepted, not about the bucket.
  checkRecordWriteRateLimit: vi.fn(async () => ({
    allowed: true,
    limit: 300,
    remaining: 299,
    resetAt: Date.now() + 60_000,
  })),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserCorrelationPatterns: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    customMetric: { findFirst: vi.fn() },
    customMetricEntry: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/idempotency", () => ({
  withIdempotency: (fn: unknown) => fn,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, POST } from "../route";
import { PATCH } from "../[entryId]/route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";

/**
 * v1.39.3 — the note on a custom-metric reading is encrypted at rest. A write
 * stores ciphertext and leaves the readable column empty; a read opens the
 * ciphertext and falls back to the readable column only for a row the backfill
 * has not reached.
 */

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "u", role: "USER" as const, locale: "en" },
};

const ENTRY = {
  id: "e-1",
  userId: "user-1",
  customMetricId: "cm-1",
  value: 42,
  unit: "kg",
  measuredAt: new Date("2026-06-10T00:00:00.000Z"),
  note: null as string | null,
  noteEncrypted: null as Uint8Array | null,
  createdAt: new Date("2026-06-10T00:00:00.000Z"),
  deletedAt: null,
};

function jsonRequest(url: string, method: string, body: unknown) {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

describe("custom-metric reading note at rest", () => {
  it("POST stores the note as ciphertext and answers with the readable note", async () => {
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue({
      id: "cm-1",
      unit: "kg",
    } as never);
    vi.mocked(prisma.customMetricEntry.create).mockImplementation(
      (async (args: { data: Record<string, unknown> }) => ({
        ...ENTRY,
        ...args.data,
      })) as never,
    );

    const res = await POST(
      jsonRequest("http://localhost/api/custom-metrics/cm-1/entries", "POST", {
        value: 42,
        measuredAt: "2026-06-10T00:00:00.000Z",
        note: "after the long ride",
      }),
      { params: Promise.resolve({ id: "cm-1" }) },
    );
    expect(res.status).toBe(201);
    const data = vi.mocked(prisma.customMetricEntry.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(data).not.toHaveProperty("note");
    expect(decryptFromBytes(data.noteEncrypted as Uint8Array)).toBe(
      "after the long ride",
    );
    const body = await res.json();
    expect(body.data.note).toBe("after the long ride");
    expect(body.data).not.toHaveProperty("noteEncrypted");
  });

  it("GET opens sealed notes and still shows a legacy readable one", async () => {
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue({
      id: "cm-1",
    } as never);
    vi.mocked(prisma.customMetricEntry.findMany).mockResolvedValue([
      { ...ENTRY, id: "e-1", noteEncrypted: encryptToBytes("sealed note") },
      { ...ENTRY, id: "e-2", note: "legacy note" },
      { ...ENTRY, id: "e-3" },
    ] as never);
    vi.mocked(prisma.customMetricEntry.count).mockResolvedValue(3 as never);

    const res = await GET(
      new NextRequest("http://localhost/api/custom-metrics/cm-1/entries"),
      { params: Promise.resolve({ id: "cm-1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      body.data.entries.map((e: { note: string | null }) => e.note),
    ).toEqual(["sealed note", "legacy note", null]);
    for (const entry of body.data.entries) {
      expect(entry).not.toHaveProperty("noteEncrypted");
    }
  });

  it("PATCH seals a new note and clears the legacy readable column", async () => {
    vi.mocked(prisma.customMetricEntry.findFirst).mockResolvedValue({
      ...ENTRY,
      note: "old readable note",
    } as never);
    vi.mocked(prisma.customMetricEntry.update).mockImplementation(
      (async (args: { data: Record<string, unknown> }) => ({
        ...ENTRY,
        ...args.data,
      })) as never,
    );

    const res = await PATCH(
      jsonRequest(
        "http://localhost/api/custom-metrics/cm-1/entries/e-1",
        "PATCH",
        { note: "edited" },
      ),
      { params: Promise.resolve({ id: "cm-1", entryId: "e-1" }) },
    );
    expect(res.status).toBe(200);
    const data = vi.mocked(prisma.customMetricEntry.update).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(data.note).toBeNull();
    expect(decryptFromBytes(data.noteEncrypted as Uint8Array)).toBe("edited");
    expect((await res.json()).data.note).toBe("edited");
  });

  it("PATCH with an explicit null clears both columns", async () => {
    vi.mocked(prisma.customMetricEntry.findFirst).mockResolvedValue({
      ...ENTRY,
      noteEncrypted: encryptToBytes("to be cleared"),
    } as never);
    vi.mocked(prisma.customMetricEntry.update).mockImplementation(
      (async (args: { data: Record<string, unknown> }) => ({
        ...ENTRY,
        ...args.data,
      })) as never,
    );

    const res = await PATCH(
      jsonRequest(
        "http://localhost/api/custom-metrics/cm-1/entries/e-1",
        "PATCH",
        { note: null },
      ),
      { params: Promise.resolve({ id: "cm-1", entryId: "e-1" }) },
    );
    expect(res.status).toBe(200);
    const data = vi.mocked(prisma.customMetricEntry.update).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(data).toMatchObject({ note: null, noteEncrypted: null });
    expect((await res.json()).data.note).toBeNull();
  });

  it("PATCH without a note leaves both note columns untouched", async () => {
    vi.mocked(prisma.customMetricEntry.findFirst).mockResolvedValue(
      ENTRY as never,
    );
    vi.mocked(prisma.customMetricEntry.update).mockResolvedValue(
      ENTRY as never,
    );
    await PATCH(
      jsonRequest(
        "http://localhost/api/custom-metrics/cm-1/entries/e-1",
        "PATCH",
        { value: 43 },
      ),
      { params: Promise.resolve({ id: "cm-1", entryId: "e-1" }) },
    );
    const data = vi.mocked(prisma.customMetricEntry.update).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(data).not.toHaveProperty("note");
    expect(data).not.toHaveProperty("noteEncrypted");
  });
});
