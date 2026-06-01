/**
 * v1.4.50 — reverse-sync push helper.
 *
 * The push side mirrors the pull (`sync.ts`) tier by tier: stored
 * credentials → SSRF guard → bounded fetch → typed response folding.
 * The tests pin the contract the iOS + web mood-entry create handlers
 * rely on, so a future refactor of the helper can't silently break
 * the fire-and-forget call sites that no longer await the result.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ""),
}));
vi.mock("@/lib/validations/notifications", () => ({
  isPublicUrl: (u: string) => /^https?:\/\/(?!127\.|localhost|10\.)/.test(u),
}));
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({
    addWarning: vi.fn(),
    addExternalCall: vi.fn(),
  }),
}));

import { pushMoodEntriesToMoodLog } from "../push";
import { prisma } from "@/lib/db";

const USER_OK = {
  moodLogEnabled: true,
  moodLogUrlEncrypted: "enc:https://moodlog.example.com",
  moodLogApiKeyEncrypted: "enc:secret-key-123",
};

const ENTRY = {
  date: "2026-05-24",
  moodLoggedAt: new Date("2026-05-24T08:30:00Z"),
  mood: "GUT",
  note: "Felt productive after my run.",
  tags: JSON.stringify(["exercise", "morning"]),
  source: "MANUAL",
};

describe("pushMoodEntriesToMoodLog", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ imported: 1, updated: 0, failed: 0 }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as never;
    vi.mocked(prisma.user.findUnique).mockResolvedValue(USER_OK as never);
  });

  it("skips entirely when no entries pass the MOODLOG filter", async () => {
    const result = await pushMoodEntriesToMoodLog("user-1", [
      { ...ENTRY, source: "MOODLOG" },
    ]);
    expect(result).toEqual({ pushed: 0, skipped: 1, status: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips when the user has no moodLog credentials stored", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      moodLogEnabled: false,
      moodLogUrlEncrypted: null,
      moodLogApiKeyEncrypted: null,
    } as never);
    const result = await pushMoodEntriesToMoodLog("user-1", [ENTRY]);
    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to push when the stored URL points at a non-public host", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...USER_OK,
      moodLogUrlEncrypted: "enc:http://127.0.0.1:3000",
    } as never);
    const result = await pushMoodEntriesToMoodLog("user-1", [ENTRY]);
    expect(result.status).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the entry to /api/integrations/health-log/mood with HEALTHLOG source", async () => {
    const result = await pushMoodEntriesToMoodLog("user-1", [ENTRY]);
    expect(result.status).toBe("ok");
    expect(result.pushed).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/integrations/health-log/mood");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-key-123",
    );
    const body = JSON.parse(init.body as string) as {
      entries: Array<{
        source: string;
        time: string;
        date: string;
        mood: string;
        tags?: string[];
      }>;
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].source).toBe("HEALTHLOG");
    expect(body.entries[0].date).toBe("2026-05-24");
    expect(body.entries[0].time).toBe("2026-05-24T08:30:00.000Z");
    expect(body.entries[0].mood).toBe("GUT");
    // Tags are parsed from the JSON-string column into an array of
    // key strings the MoodLog endpoint accepts directly.
    expect(body.entries[0].tags).toEqual(["exercise", "morning"]);
  });

  it("returns ok with pushed=0 when MoodLog responds 200 but no rows were accepted", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ imported: 0, updated: 0, failed: 1 }),
        { status: 200 },
      ),
    );
    const result = await pushMoodEntriesToMoodLog("user-1", [ENTRY]);
    expect(result.status).toBe("ok");
    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("reports failed on a 5xx without throwing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream down", { status: 502 }));
    const result = await pushMoodEntriesToMoodLog("user-1", [ENTRY]);
    expect(result.status).toBe("failed");
    expect(result.pushed).toBe(0);
  });

  it("reports failed on a network blip (fetch reject) without throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const result = await pushMoodEntriesToMoodLog("user-1", [ENTRY]);
    expect(result.status).toBe("failed");
    expect(result.pushed).toBe(0);
  });

  it("refuses to follow a 3xx redirect (SSRF defence)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 302 }));
    const result = await pushMoodEntriesToMoodLog("user-1", [ENTRY]);
    expect(result.status).toBe("failed");
  });

  it("omits the tags field when the column is null or malformed JSON", async () => {
    await pushMoodEntriesToMoodLog("user-1", [
      { ...ENTRY, tags: null },
    ]);
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as { entries: Array<{ tags?: unknown }> };
    expect("tags" in body.entries[0]).toBe(false);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ imported: 1 }), { status: 200 }),
    );
    await pushMoodEntriesToMoodLog("user-1", [
      { ...ENTRY, tags: "not-valid-json{{" },
    ]);
    const body2 = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as { entries: Array<{ tags?: unknown }> };
    expect("tags" in body2.entries[0]).toBe(false);
  });
});
