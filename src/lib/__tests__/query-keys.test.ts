import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  queryKeys,
  measurementDependentKeys,
  moodDependentKeys,
  medicationDependentKeys,
  invalidateKeys,
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
  it("threads the slim slice through queryKeys.analytics", () => {
    expect(queryKeys.analytics("summaries")).toEqual(["analytics", "summaries"]);
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
    expect(key.length).toBe(7);
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
    expect(queryKeys.medicationTitration("med1")).toEqual([
      "medications",
      "med1",
      "titration",
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

  it("moodDependentKeys bundle covers mood + analytics + targets", () => {
    const keyStrings = moodDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["mood-entries"]));
    expect(keyStrings).toContain(JSON.stringify(["mood-analytics"]));
    expect(keyStrings).toContain(JSON.stringify(["insights"]));
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
    expect(keyStrings).toContain(JSON.stringify(["dashboard-medication-compliance"]));
  });
});

/**
 * v1.4.40 W-RSC — factory-bypass guard.
 *
 * Walks every `.ts` / `.tsx` file in `src/components/charts` and
 * `src/app/page.tsx` (the dashboard + chart files we own in this wave)
 * and fails if a literal `queryKey: [...]` slipped past the factory.
 * Acts as a lint-style enforcement check in the absence of a custom
 * ESLint rule — keeps the CI gate cheap and the failure message
 * pointed at the exact file the contributor needs to fix.
 *
 * The audit (`.planning/round-v1439-arch-qa-frontend.md` §H1) found
 * 154 bare queryKey sites at v1.4.39.3. We intentionally scope this
 * guard tight to the dashboard + chart files this wave touched so a
 * future wave can extend the directory list as it migrates the
 * remaining sites — opt-in expansion beats a giant red CI on
 * landing.
 */
describe("queryKey factory enforcement", () => {
  function listFiles(dir: string): string[] {
    const entries = readdirSync(dir);
    const out: string[] = [];
    for (const name of entries) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name === "__tests__" || name === "node_modules") continue;
        out.push(...listFiles(full));
      } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
        out.push(full);
      }
    }
    return out;
  }

  const repoRoot = join(__dirname, "..", "..", "..");
  // Files this wave migrated to the factory. Extend this list as
  // future waves migrate their own surface; the audit-H1 long tail
  // (admin/, settings/, medications/, integrations) stays out of the
  // guard's scope until a follow-up wave routes those keys.
  const guardedRoots = [
    join(repoRoot, "src", "components", "charts"),
    join(repoRoot, "src", "components", "comparison"),
    join(repoRoot, "src", "app", "page.tsx"),
    join(repoRoot, "src", "hooks", "use-auth.ts"),
    // v1.4.41 W-FRONTEND-FACTORY — auth, notifications, and the
    // about-section migrated to the factory.
    join(repoRoot, "src", "app", "auth"),
    join(repoRoot, "src", "app", "notifications"),
    join(repoRoot, "src", "components", "settings", "about-section.tsx"),
    // v1.4.42 W3-QUERYKEY-LONGTAIL — settings / medications /
    // admin / hooks now route every read through the factory.
    join(repoRoot, "src", "components", "settings"),
    join(repoRoot, "src", "components", "medications"),
    join(repoRoot, "src", "components", "admin"),
    join(repoRoot, "src", "hooks"),
    join(repoRoot, "src", "app", "medications", "page.tsx"),
    join(repoRoot, "src", "app", "medications", "[id]", "history", "page.tsx"),
    join(repoRoot, "src", "app", "targets", "page.tsx"),
  ];

  function collect(): string[] {
    const all: string[] = [];
    for (const root of guardedRoots) {
      const st = statSync(root);
      if (st.isDirectory()) {
        all.push(...listFiles(root));
      } else {
        all.push(root);
      }
    }
    return all;
  }

  it("no guarded file declares a bare-literal `queryKey:` (factory enforcement)", () => {
    const offenders: Array<{ file: string; line: number; snippet: string }> = [];
    const files = collect();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match `queryKey:` followed by a `[` on the same line. We
        // explicitly allow `queryKey: queryKeys.<entry>(…)` patterns
        // and any indirect identifier the call site passes through
        // (a `key` local, a `listKey` constant, etc.) so the guard
        // only flags the literal-array shape that drove audit-H1.
        const match = line.match(/queryKey\s*:\s*\[/);
        if (!match) continue;
        // Strip trailing comments + JSX comments before deciding.
        const trimmed = line.replace(/\/\/.*$/, "").trim();
        if (!/queryKey\s*:\s*\[/.test(trimmed)) continue;
        offenders.push({
          file: file.slice(repoRoot.length + 1),
          line: i + 1,
          snippet: trimmed,
        });
      }
    }

    expect(
      offenders,
      `Factory bypass — every \`queryKey:\` in guarded files must go through \`queryKeys.<entry>()\`. ` +
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
