/**
 * The comprehensive-briefing cache is one slot per user. When it holds prose
 * in a language other than the reader's, the dashboard snapshot serves no
 * briefing text at all rather than the wrong language.
 *
 * This runs the real Prisma path end to end: the cache row is written with
 * its locale tag through the client, and the snapshot is read through the
 * same `readDashboardSnapshotCached` the dashboard route and the Today
 * digest use, with the reader's locale resolved from the cookie the client
 * sets when the user switches language.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const BRIEFING = {
  greeting: "Good morning",
  paragraph: "Your readings this week stayed inside their usual range.",
  keyFindings: [],
};

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedUserWithCachedBriefing(cachedLocale: string | null) {
  const prisma = getPrismaClient();
  return prisma.user.create({
    data: {
      username: "briefing-user",
      email: "briefing@example.test",
      role: "USER",
      // A German-language account: the stored preference is what the
      // snapshot read resolves the reader's locale from.
      locale: "de",
      insightsCachedAt: new Date(),
      // Generated now: only text written today is served as today's read.
      insightsCachedText: JSON.stringify({
        dailyBriefing: BRIEFING,
        briefingGeneratedAt: new Date().toISOString(),
      }),
      insightsCachedLocale: cachedLocale,
      // The briefing is shown only while its AI capability is available, so
      // the account has its own provider (presence only) and a receipt.
      aiProvider: "ANTHROPIC",
      aiModel: "claude-sonnet-4-6",
      aiAnthropicKeyEncrypted: "v1:presence-only",
      consentReceipts: {
        create: { kind: "ai_full", artefact: "test", signedAt: new Date() },
      },
    },
  });
}

describe("dashboard snapshot — briefing cache written in another language", () => {
  it("serves NO briefing prose to a 'de' reader from a cache tagged 'en'", async () => {
    const user = await seedUserWithCachedBriefing("en");
    const { readDashboardSnapshotCached } =
      await import("@/lib/dashboard/snapshot-read");

    const { body, locale } = await readDashboardSnapshotCached(user);

    expect(locale).toBe("de");
    expect(body.briefing).toBeNull();
    expect(body.briefingStale).toBe(false);
    expect(body.briefingUpdatedAt).toBeNull();
    // A provider is configured, so a warm pass will refill the slot.
    expect(body.briefingState).toBe("preparing");
  });

  it("serves the briefing when the tag matches the reader", async () => {
    const user = await seedUserWithCachedBriefing("de");
    const { readDashboardSnapshotCached } =
      await import("@/lib/dashboard/snapshot-read");

    const { body } = await readDashboardSnapshotCached(user);

    expect(body.briefingState).toBe("ready");
    expect(body.briefing?.paragraph).toBe(BRIEFING.paragraph);
  });

  it("serves an untagged row written before the tag existed", async () => {
    const user = await seedUserWithCachedBriefing(null);
    const { readDashboardSnapshotCached } =
      await import("@/lib/dashboard/snapshot-read");

    const { body } = await readDashboardSnapshotCached(user);

    expect(body.briefingState).toBe("ready");
    expect(body.briefing?.paragraph).toBe(BRIEFING.paragraph);
  });
});
