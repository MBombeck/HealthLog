import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/modules/gate", () => ({ isModuleEnabled: vi.fn() }));
vi.mock("@/lib/seizures/server", () => ({ readSeizureDiary: vi.fn() }));

import { isModuleEnabled } from "@/lib/modules/gate";
import { readSeizureDiary } from "@/lib/seizures/server";
import type { SeizureDiaryDTO } from "@/lib/seizures/shared";

import { buildSeizuresSnapshotBlock } from "../seizures-snapshot";

const NOW = new Date("2026-11-22T12:00:00.000Z");

function diary(events: number): SeizureDiaryDTO {
  const dto = {
    types: [{ id: "t1", label: "Her own name for it" }],
    settings: { rule: { count: 3, windowHours: 24 } },
    events: Array.from({ length: events }, (_, i) => ({ id: `e${i}` })),
    summary: {
      seizures: 4,
      suspected: 1,
      seizureDays: 2,
      streak: { daysSinceLast: 3 },
      clusters: [
        {
          startAt: "2026-11-01T02:00:00.000Z",
          endAt: "2026-11-01T09:00:00.000Z",
          seizureCount: 3,
          eventIds: ["e0"],
        },
        {
          startAt: "2026-11-18T02:00:00.000Z",
          endAt: "2026-11-18T05:00:00.000Z",
          seizureCount: 3,
          eventIds: ["e1"],
        },
      ],
      niceClusterCount: 2,
      rescueDoses: 1,
      emergencies: { emsCalled: 0, edVisits: 1, admissions: 0 },
      monthly: {
        months: ["2026-11"],
        rows: [{ typeProfileId: "t1", counts: {}, days: {}, total: 4 }],
        total: {
          typeProfileId: null,
          counts: { "2026-11": 4 },
          days: { "2026-11": 2 },
          total: 4,
        },
      },
    },
    truncated: false,
  };
  return dto as unknown as SeizureDiaryDTO;
}

beforeEach(() => {
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(readSeizureDiary).mockResolvedValue(diary(3));
});

describe("buildSeizuresSnapshotBlock", () => {
  it("is nothing with the seizure diary switched off", async () => {
    vi.mocked(isModuleEnabled).mockResolvedValue(false);
    expect(
      await buildSeizuresSnapshotBlock("u1", "Europe/Berlin", NOW),
    ).toBeNull();
    expect(readSeizureDiary).not.toHaveBeenCalled();
  });

  it("is nothing without a recorded seizure", async () => {
    vi.mocked(readSeizureDiary).mockResolvedValue(diary(0));
    expect(
      await buildSeizuresSnapshotBlock("u1", "Europe/Berlin", NOW),
    ).toBeNull();
  });

  it("carries counts, clusters newest first and month totals, never the family's words", async () => {
    const block = await buildSeizuresSnapshotBlock("u1", "Europe/Berlin", NOW);
    expect(block).toMatchObject({
      windowDays: 90,
      recordedSeizures: 4,
      daysSinceLastRecorded: 3,
      clusterEpisodes: 2,
      clusterEpisodesNice3In24h: 2,
      monthly: { seizures: { "2026-11": 4 } },
    });
    expect(block!.recentClusters[0].startAt).toBe("2026-11-18T02:00:00.000Z");
    expect(JSON.stringify(block)).not.toContain("Her own name");
  });

  it("stays inside the Coach's history reach", async () => {
    await buildSeizuresSnapshotBlock("u1", "Europe/Berlin", NOW, {
      window: "last30days",
      days: 30,
    });
    const from = vi.mocked(readSeizureDiary).mock.calls[0][0].from!;
    expect(NOW.getTime() - from.getTime()).toBe(30 * 86_400_000);
  });
});
