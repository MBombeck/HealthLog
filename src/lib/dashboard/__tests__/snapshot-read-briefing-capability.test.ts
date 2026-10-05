/**
 * The briefing capability is applied on every read of the cached snapshot,
 * never baked into the cached body.
 *
 * The body is cached for minutes and rebuilt in the background, where no
 * request exists to resolve a capability for. If the decision rode inside
 * the cached body, a switch flip, an AI opt-out or a withdrawn consent would
 * keep showing model text until the entry aged out. So: warm the cell while
 * the briefing is available, flip the capability, and require the very next
 * read (served from the same cell, no rebuild) to hide the text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/generated/prisma/client";
import {
  AI_AVAILABLE,
  aiUnavailable,
} from "@/__tests__/helpers/ai-capability-fixtures";

const briefingBody = {
  tiles: {},
  briefing: { greeting: "Hi", paragraph: "Model prose.", keyFindings: [] },
  briefingMemory: null,
  briefingState: "ready",
  briefingUpdatedAt: "2026-07-17T06:00:00.000Z",
  briefingStale: false,
  briefingAi: null,
};
const buildDashboardSnapshot = vi.fn(async () => briefingBody);
const aiCapabilityToServe = vi.fn();

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/dashboard/snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/snapshot")>()),
  buildDashboardSnapshot: () => buildDashboardSnapshot(),
}));
vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: async () => "en",
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityToServe: (...args: unknown[]) => aiCapabilityToServe(...args),
}));

const { readDashboardSnapshotCached } = await import("../snapshot-read");
const { __resetAllCachesForTests } = await import("@/lib/cache/server-cache");

// Generated a moment ago, so the today rule keeps it and these tests see
// only the capability decision.
const USER = {
  id: "user-briefing-gate",
  locale: "en",
  timezone: "UTC",
  insightsCachedText: JSON.stringify({
    briefingGeneratedAt: new Date().toISOString(),
  }),
} as unknown as User;

beforeEach(() => {
  __resetAllCachesForTests();
  buildDashboardSnapshot.mockClear();
  aiCapabilityToServe.mockReset();
});

describe("readDashboardSnapshotCached — briefing capability per read", () => {
  it("resolves the briefing capability for the record being read", async () => {
    aiCapabilityToServe.mockResolvedValue(AI_AVAILABLE);
    await readDashboardSnapshotCached(USER);
    expect(aiCapabilityToServe).toHaveBeenCalledWith(
      "user-briefing-gate",
      "briefing",
    );
  });

  it("hides the cached briefing on the next read once the capability goes away", async () => {
    aiCapabilityToServe.mockResolvedValue(AI_AVAILABLE);
    const first = await readDashboardSnapshotCached(USER);
    expect(first.body.briefing).not.toBeNull();
    expect(first.body.briefingAi).toEqual(AI_AVAILABLE);

    aiCapabilityToServe.mockResolvedValue(aiUnavailable("consent_required"));
    const second = await readDashboardSnapshotCached(USER);

    // Served from the same cell: the builder ran once.
    expect(buildDashboardSnapshot).toHaveBeenCalledTimes(1);
    expect(second.body.briefing).toBeNull();
    expect(second.body.briefingState).toBe("disabled");
    expect(second.body.briefingAi).toEqual(aiUnavailable("consent_required"));
  });

  it("shows it again when the capability comes back, without a rebuild", async () => {
    aiCapabilityToServe.mockResolvedValue(aiUnavailable("operator_disabled"));
    const hidden = await readDashboardSnapshotCached(USER);
    expect(hidden.body.briefing).toBeNull();

    aiCapabilityToServe.mockResolvedValue(AI_AVAILABLE);
    const shown = await readDashboardSnapshotCached(USER);
    expect(buildDashboardSnapshot).toHaveBeenCalledTimes(1);
    expect(shown.body.briefing).not.toBeNull();
  });
});
