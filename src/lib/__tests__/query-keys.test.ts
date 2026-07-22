import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  queryKeys,
  measurementDependentKeys,
  moodDependentKeys,
  medicationDependentKeys,
  invalidateKeys,
  refetchInactiveDailyReads,
} from "../query-keys";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

describe("queryKeys factory", () => {
  it("returns stable tuples for simple keys", () => {
    expect(queryKeys.measurements()).toEqual(["measurements"]);
    expect(queryKeys.analytics()).toEqual(["analytics"]);
    expect(queryKeys.moodEntries()).toEqual(["mood-entries"]);
  });

  it("includes locale in insights status keys", () => {
    expect(queryKeys.insightsBpStatus("en")).toEqual([
      "insights",
      "blood-pressure-status",
      "en",
    ]);
  });

  // v1.4.33 IW2 — slice param routes the slim consumer onto its own
  // cache slot but leaves `["analytics"]` (the root) as a prefix so
  // mutation invalidations sweep both shapes.
  it("exposes the unified dashboard-snapshot key", () => {
    expect(queryKeys.dashboardSnapshot()).toEqual(["dashboard", "snapshot"]);
  });

  // v1.21.3 (b) — the snapshot key takes an optional `locale` segment so a
  // locale switch reads freshly-localised prose on its own cell. The zero-arg
  // call MUST stay byte-identical to the legacy literal so every prefix-based
  // invalidation bundle + zero-arg reader keeps prefix-matching the new cells.
  it("threads an optional locale segment through dashboardSnapshot", () => {
    expect(queryKeys.dashboardSnapshot("en")).toEqual([
      "dashboard",
      "snapshot",
      "en",
    ]);
    expect(queryKeys.dashboardSnapshot("de")).toEqual([
      "dashboard",
      "snapshot",
      "de",
    ]);
  });

  it("keeps the zero-arg dashboardSnapshot call byte-identical to the legacy literal", () => {
    expect(queryKeys.dashboardSnapshot()).toEqual(["dashboard", "snapshot"]);
    expect(queryKeys.dashboardSnapshot(undefined)).toEqual([
      "dashboard",
      "snapshot",
    ]);
  });

  it("makes a zero-arg dashboardSnapshot key a prefix of a locale-keyed cell", () => {
    // TanStack `invalidateQueries({ queryKey })` matches by prefix, so a
    // zero-arg invalidate must reach every locale-keyed snapshot cell.
    const zeroArg = queryKeys.dashboardSnapshot();
    const localeKeyed = queryKeys.dashboardSnapshot("en");
    expect(localeKeyed.slice(0, zeroArg.length)).toEqual(zeroArg);
  });

  it("threads the slim slice through queryKeys.analytics", () => {
    expect(queryKeys.analytics("summaries")).toEqual([
      "analytics",
      "summaries",
    ]);
  });

  it("keeps the no-arg call byte-identical to the legacy literal", () => {
    expect(queryKeys.analytics()).toEqual(["analytics"]);
    expect(queryKeys.analytics(undefined)).toEqual(["analytics"]);
  });

  // v1.4.40 W-RSC — the four new factory entries from this wave each
  // need a byte-stable contract so the audit-cited drift cases stay
  // pinned. A future rename of any of these literals would land a
  // matching test failure rather than silently breaking cache layout.
  it("exposes the authMe shape so useAuth doesn't drift back to a bare literal", () => {
    expect(queryKeys.authMe()).toEqual(["auth", "me"]);
  });

  it("exposes the userThresholds shape for Settings + targets", () => {
    expect(queryKeys.userThresholds()).toEqual(["user", "thresholds"]);
  });

  // v1.4.41 W-FRONTEND-FACTORY — pin the shapes that auth/login + the
  // notifications surface migrated to so a future rename can't drift
  // the cache layout silently.
  it("exposes auth + notifications keys for the factory-migrated surfaces", () => {
    expect(queryKeys.authRegistrationStatus()).toEqual([
      "auth",
      "registration-status",
    ]);
    expect(queryKeys.notificationsPreferences()).toEqual([
      "notifications",
      "preferences",
    ]);
    expect(queryKeys.notificationsStatus()).toEqual([
      "notifications",
      "status",
    ]);
    expect(queryKeys.authNotificationPrefs()).toEqual([
      "auth",
      "me",
      "notification-prefs",
    ]);
    expect(queryKeys.apiVersion()).toEqual(["api", "version"]);
  });

  it("packs chartData params into a stable tuple prefixed by chart-data", () => {
    const key = queryKeys.chartData(
      "WEIGHT",
      "raw",
      "no-bmi",
      "Europe/Berlin",
      "2026-04-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
    );
    expect(key[0]).toBe("chart-data");
    // v1.7.0 — the tuple trails with the display `valueScale` (default 1).
    expect(key.length).toBe(8);
    expect(key[7]).toBe(1);
    expect(
      queryKeys.chartData(
        "WALKING_SPEED",
        "raw",
        "no-bmi",
        "Europe/Berlin",
        "2026-04-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
        3.6,
      )[7],
    ).toBe(3.6);
    // Numeric bmiDivisor is allowed (BMI charts pass `heightCm * heightCm`).
    const bmiKey = queryKeys.chartData(
      "WEIGHT",
      "bmi",
      30625,
      "Europe/Berlin",
      "2026-04-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
    );
    expect(bmiKey[3]).toBe(30625);
  });

  it("prefixes the dashboard medication-compliance key under one root", () => {
    expect(queryKeys.dashboardMedicationCompliance(7)).toEqual([
      "dashboard-medication-compliance",
      7,
    ]);
    expect(queryKeys.dashboardMedicationCompliance(30)[0]).toBe(
      "dashboard-medication-compliance",
    );
  });

  // v1.4.42 W3-QUERYKEY-LONGTAIL — pin the shapes of the new factory
  // entries so a future rename can't drift the cache layout silently.
  it("exposes the per-medication sub-keys under the medications prefix", () => {
    expect(queryKeys.medicationCompliance("med1")).toEqual([
      "medications",
      "med1",
      "compliance",
    ]);
    expect(queryKeys.medicationCadence("med1")).toEqual([
      "medications",
      "med1",
      "cadence",
    ]);
    expect(queryKeys.medicationGlp1Details("med1")).toEqual([
      "medications",
      "med1",
      "glp1-details",
    ]);
    expect(queryKeys.medicationIntakeDrugLevelChart("med1")).toEqual([
      "medications",
      "med1",
      "intake",
      "drug-level-chart",
    ]);
    const listKey = queryKeys.medicationIntakeList("med1", {
      sortBy: "takenAt",
      sortDir: "desc",
      limit: 25,
      offset: 0,
      status: "completed",
    });
    expect(listKey).toEqual([
      "medications",
      "med1",
      "intake",
      "list",
      "takenAt",
      "desc",
      25,
      0,
      "completed",
    ]);
  });

  it("exposes withingsStatus under the withings prefix", () => {
    expect(queryKeys.withingsStatus()).toEqual(["withings", "status"]);
  });

  it("packs adminAuditLogFiltered params into a stable filtered shape", () => {
    const key = queryKeys.adminAuditLogFiltered({
      filter: "all",
      page: 1,
      perPage: 50,
      actor: "",
      actionFilter: "",
      target: "",
      range: "7d",
    });
    expect(key[0]).toBe("admin");
    expect(key[1]).toBe("audit-log");
    expect(key[2]).toBe("filtered");
    expect(key.length).toBe(10);
  });

  it("packs workoutsRecentList opts under the workouts-recent prefix", () => {
    const key = queryKeys.workoutsRecentList({ limit: 3 });
    expect(key[0]).toBe("workouts");
    expect(key[1]).toBe("recent");
  });

  it("exposes a per-metric custom-entry prefix for broad invalidation", () => {
    expect(queryKeys.customMetricEntriesPrefix("metric-1")).toEqual([
      "custom-metric-entries",
      "metric-1",
    ]);
  });

  it("exposes the nutrients prefix for broad invalidation", () => {
    expect(queryKeys.nutrientsRoot()).toEqual(["nutrients"]);
  });
});

describe("dependent-key bundles", () => {
  it("measurementDependentKeys invalidates analytics/insights/targets", () => {
    const keyStrings = measurementDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["measurements"]));
    expect(keyStrings).toContain(JSON.stringify(["analytics"]));
    expect(keyStrings).toContain(JSON.stringify(["insights"]));
    expect(keyStrings).toContain(JSON.stringify(["insights", "targets"]));
    expect(keyStrings).toContain(
      JSON.stringify(["gamification", "achievements"]),
    );
  });

  // v1.4.40 W-RSC — chart-data prefix now lives in the bundle so a
  // fresh measurement evicts every per-chart daily-aggregate cache.
  // Pre-fix the chart row stayed 60 s stale after a measurement save
  // (audit-C2). Pin the bundle membership so a refactor of the chart
  // queryKey factory can't silently drop the dependency.
  it("measurementDependentKeys bundles the chart-data prefix (v1.4.40)", () => {
    const keyStrings = measurementDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["chart-data"]));
  });

  // v1.18.9 (#38) — the dashboard snapshot must ride the measurement
  // bundle too. The hero band / score ring / tile strip read ONE snapshot
  // query with refetch-on-mount/focus options that otherwise leave an
  // in-app-added reading invisible on the Startseite until the 120 s poll
  // or a hard reload. Mirror the v1.16.11 medication-bundle fix.
  it("measurementDependentKeys bundles the dashboard snapshot (v1.18.9)", () => {
    const keyStrings = measurementDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["dashboard", "snapshot"]));
  });

  // v1.29.x — a manual measurement write never invalidated the Today
  // digest, so its score / rail items lingered stale after a save from
  // the values list or the dashboard quick-entry sheet. Mirror the
  // v1.29.1 medication fix.
  it("measurementDependentKeys bundles the daily digest", () => {
    const keyStrings = measurementDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["daily", "digest"]));
  });

  it("moodDependentKeys bundle covers mood + analytics + targets", () => {
    const keyStrings = moodDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["mood-entries"]));
    expect(keyStrings).toContain(JSON.stringify(["mood-analytics"]));
    expect(keyStrings).toContain(JSON.stringify(["insights"]));
  });

  // v1.28.42 (M2) — the dashboard snapshot embeds a mood block + feeds the
  // score ring, but a mood write only invalidated the mood bundle, leaving the
  // Startseite tile / score stale for up to ~120 s. Mirror the measurement
  // (v1.18.9) and medication (v1.16.11) bundles. Pin the membership so a future
  // refactor can't silently drop the dependency again.
  it("moodDependentKeys bundles the dashboard snapshot (v1.28.42)", () => {
    const keyStrings = moodDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["dashboard", "snapshot"]));
  });

  // v1.29.x — mirrors the measurement fix: a manual mood write never
  // invalidated the Today digest.
  it("moodDependentKeys bundles the daily digest", () => {
    const keyStrings = moodDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["daily", "digest"]));
  });

  it("medicationDependentKeys bundle covers medications + analytics + achievements", () => {
    const keyStrings = medicationDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["medications"]));
    expect(keyStrings).toContain(JSON.stringify(["analytics"]));
    expect(keyStrings).toContain(
      JSON.stringify(["gamification", "achievements"]),
    );
  });

  // v1.4.40 W-RSC — dashboard-medication-compliance prefix now lives in
  // the bundle so an intake POST refreshes the dashboard chart in
  // lockstep with the per-medication compliance-chart-inline tile
  // (audit-L4).
  it("medicationDependentKeys bundles the dashboard-medication-compliance prefix (v1.4.40)", () => {
    const keyStrings = medicationDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(
      JSON.stringify(["dashboard-medication-compliance"]),
    );
  });

  // v1.5.5 D-3 §10 invariant 20 — the per-medication inline compliance
  // chart cache key (`["compliance-chart-inline", medicationId]`) needs
  // its prefix in the bundle so every detail-page mutation evicts the
  // tile in one tick. Hierarchical prefix-match catches every per-id
  // slot beneath it.
  it("medicationDependentKeys bundles the compliance-chart-inline prefix (v1.5.5)", () => {
    const keyStrings = medicationDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["compliance-chart-inline"]));
  });

  // v1.16.11 — the dashboard snapshot feeds the hero band, dose tally,
  // verdict and checklist from ONE query with refetch-on-mount/focus
  // off and a 120 s poll. Without this key in the bundle a dose taken
  // from the dashboard stayed visibly due until the next poll (#316).
  it("medicationDependentKeys bundles the dashboard snapshot (v1.16.11)", () => {
    const keyStrings = medicationDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["dashboard", "snapshot"]));
  });

  // v1.29.1 — the Today digest reads `medsToday` from the same server
  // snapshot the intake routes hard-evict, but nothing invalidated the client
  // query, so the digest's dose-window rail item lingered until a hard reload.
  it("medicationDependentKeys bundles the daily digest (v1.29.1)", () => {
    const keyStrings = medicationDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["daily", "digest"]));
  });
});

/**
 * Factory-bypass source guard.
 *
 * Components and hooks are client-facing by convention. App and lib modules
 * join the guarded surface when they declare `"use client"`. Tests and the
 * factory definition directory are excluded because they intentionally build
 * literal fixtures and key tuples.
 */
describe("queryKey factory enforcement", () => {
  const repoRoot = join(__dirname, "..", "..", "..");
  const sourceRoots = [
    join(repoRoot, "src", "components"),
    join(repoRoot, "src", "hooks"),
    join(repoRoot, "src", "app"),
    join(repoRoot, "src", "lib"),
  ];

  function listFiles(dir: string): string[] {
    const entries = readdirSync(dir);
    const out: string[] = [];
    for (const name of entries) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (
          name === "__tests__" ||
          name === "__mocks__" ||
          name === "node_modules"
        ) {
          continue;
        }
        out.push(...listFiles(full));
      } else if (
        (name.endsWith(".ts") || name.endsWith(".tsx")) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)
      ) {
        out.push(full);
      }
    }
    return out;
  }

  function isClientSource(file: string, text: string): boolean {
    const relative = file.slice(repoRoot.length + 1).replaceAll("\\", "/");
    if (
      relative.startsWith("src/components/") ||
      relative.startsWith("src/hooks/")
    ) {
      return true;
    }
    return /^\s*["']use client["'];/.test(text);
  }

  it("no client module declares a bare-literal TanStack key", () => {
    const offenders: Array<{ file: string; line: number; snippet: string }> =
      [];
    const files = sourceRoots.flatMap(listFiles).filter(
      (file) =>
        !file
          .slice(repoRoot.length + 1)
          .replaceAll("\\", "/")
          .startsWith("src/lib/query-keys/"),
    );

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (!isClientSource(file, text)) continue;

      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.replace(/\/\/.*$/, "").trim();
        if (!/(?:queryKey|mutationKey)\s*:\s*\[/.test(trimmed)) continue;
        offenders.push({
          file: file.slice(repoRoot.length + 1),
          line: i + 1,
          snippet: trimmed,
        });
      }
    }

    expect(
      offenders,
      `Factory bypass — every client TanStack key must come from \`queryKeys.<entry>()\`. ` +
        `Offenders:\n${offenders
          .map((o) => `  ${o.file}:${o.line}  ${o.snippet}`)
          .join("\n")}`,
    ).toEqual([]);
  });
});

describe("invalidateKeys", () => {
  it("calls invalidateQueries for every key in the bundle", async () => {
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const client = { invalidateQueries: invalidate } as unknown as QueryClient;
    const keys: QueryKey[] = [["a"], ["b", "c"], ["d"]];

    await invalidateKeys(client, keys);

    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenNthCalledWith(1, { queryKey: ["a"] });
    expect(invalidate).toHaveBeenNthCalledWith(2, { queryKey: ["b", "c"] });
    expect(invalidate).toHaveBeenNthCalledWith(3, { queryKey: ["d"] });
  });

  it("continues on partial failure (allSettled semantics)", async () => {
    const invalidate = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const client = { invalidateQueries: invalidate } as unknown as QueryClient;
    const keys: QueryKey[] = [["a"], ["b"], ["c"]];

    const results = await invalidateKeys(client, keys);

    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(results[2].status).toBe("fulfilled");
  });
});

// v1.29.x — the shared helper behind the measurement / mood / water fix.
// `invalidateKeys` (default `refetchType: "active"`) only refetches MOUNTED
// queries, so the dashboard hero and Today digest — both typically unmounted
// while the user is on the measurement/mood/nutrients surface — are marked
// stale but never refetched. Mirrors the v1.29.1 medication-intake fix
// (`invalidateMedicationReads`); this is the shared version every other
// write seam now calls alongside its own `*DependentKeys` bundle.
describe("refetchInactiveDailyReads", () => {
  it("forces an inactive refetch of both the dashboard snapshot and the Today digest", async () => {
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const client = { invalidateQueries: invalidate } as unknown as QueryClient;

    await refetchInactiveDailyReads(client);

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.dashboardSnapshot(),
      refetchType: "inactive",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.dailyDigest(),
      refetchType: "inactive",
    });
  });
});
