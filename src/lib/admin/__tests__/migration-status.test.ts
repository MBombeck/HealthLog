import { describe, expect, it } from "vitest";

import { migrationStatusOf } from "@/lib/admin/migration-status";
import {
  UPDATE_CHANNEL_TAG,
  UPDATE_CHANNELS,
  resolveUpdateChannel,
} from "@/lib/admin/update-channel";

const at = (iso: string) => new Date(iso);

describe("migrationStatusOf", () => {
  const shipped = ["0001_a", "0002_b", "0003_c", "0004_d"];

  it("counts applied, pending and the last one in apply order", () => {
    const status = migrationStatusOf(shipped, [
      {
        migration_name: "0001_a",
        finished_at: at("2026-11-01T10:00:00Z"),
        rolled_back_at: null,
      },
      {
        migration_name: "0002_b",
        finished_at: at("2026-11-20T10:00:00Z"),
        rolled_back_at: null,
      },
    ]);
    expect(status).toEqual({
      shipped: 4,
      applied: 2,
      pending: 2,
      pendingNames: ["0003_c", "0004_d"],
      failedNames: [],
      lastApplied: { name: "0002_b", at: "2026-11-20T10:00:00.000Z" },
    });
  });

  it("reports a migration that started and did not finish as failed, not pending", () => {
    const status = migrationStatusOf(shipped, [
      {
        migration_name: "0001_a",
        finished_at: at("2026-11-01T10:00:00Z"),
        rolled_back_at: null,
      },
      { migration_name: "0002_b", finished_at: null, rolled_back_at: null },
    ]);
    expect(status.failedNames).toEqual(["0002_b"]);
    expect(status.pendingNames).toEqual(["0003_c", "0004_d"]);
  });

  it("does not count a rolled-back migration as applied", () => {
    const status = migrationStatusOf(shipped, [
      {
        migration_name: "0001_a",
        finished_at: at("2026-11-01T10:00:00Z"),
        rolled_back_at: at("2026-11-01T10:05:00Z"),
      },
    ]);
    expect(status.applied).toBe(0);
    expect(status.pending).toBe(4);
  });

  it("answers without a shipped folder", () => {
    const status = migrationStatusOf(null, []);
    expect(status.shipped).toBeNull();
    expect(status.pending).toBe(0);
    expect(status.lastApplied).toBeNull();
  });

  it("lists at most twenty names, and counts all of them", () => {
    const many = Array.from(
      { length: 25 },
      (_, i) => `${String(i).padStart(4, "0")}_m`,
    );
    const status = migrationStatusOf(many, []);
    expect(status.pending).toBe(25);
    expect(status.pendingNames).toHaveLength(20);
  });
});

describe("resolveUpdateChannel", () => {
  it("takes the image line the build was given", () => {
    expect(resolveUpdateChannel("abc123def456", "release")).toBe("release");
    expect(resolveUpdateChannel("abc123def456", "edge")).toBe("edge");
    expect(resolveUpdateChannel("abc123def456", "nightly")).toBe("nightly");
  });

  it("calls an image with a commit and no known line a release", () => {
    expect(resolveUpdateChannel("abc123def456", undefined)).toBe("release");
    expect(resolveUpdateChannel("abc123def456", "")).toBe("release");
    expect(resolveUpdateChannel("abc123def456", "beta")).toBe("release");
  });

  it("calls a build without a commit a development build, whatever it was told", () => {
    expect(resolveUpdateChannel(null, undefined)).toBe("development");
    expect(resolveUpdateChannel(null, "nightly")).toBe("development");
  });

  it("names a tag for every line but development", () => {
    expect(Object.keys(UPDATE_CHANNEL_TAG).sort()).toEqual(
      [...UPDATE_CHANNELS].sort(),
    );
    expect(UPDATE_CHANNEL_TAG.nightly).toBe(":nightly");
    expect(UPDATE_CHANNEL_TAG.development).toBeNull();
  });
});
