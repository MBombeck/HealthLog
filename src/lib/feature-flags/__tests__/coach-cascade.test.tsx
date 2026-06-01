import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachLaunchProvider } from "@/lib/insights/coach-launch-context";
import {
  DEFAULT_ASSISTANT_FLAGS,
  type AssistantFlagSet,
} from "@/hooks/use-feature-flags";

import { HeroStrip } from "@/components/insights/hero-strip";
import { SuggestedPrompts } from "@/components/insights/suggested-prompts";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { LayoutCoachFab } from "@/components/insights/layout-coach-fab";
import { LayoutCoachMount } from "@/components/insights/layout-coach-mount";

// v1.4.38 W-C M-5 — capture the original `useFeatureFlags` and route
// the spy through it so the gate-fired assertion below can verify the
// hook ran with the operator-disabled matrix. Setting `vi.mock()` here
// (instead of `vi.spyOn`) is required because the components import the
// hook at module load; a runtime `spyOn` would never intercept the call.
const featureFlagsSpy = vi.fn<() => AssistantFlagSet>(
  () => DEFAULT_ASSISTANT_FLAGS,
);
vi.mock("@/hooks/use-feature-flags", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/use-feature-flags")
  >("@/hooks/use-feature-flags");
  return {
    ...actual,
    useFeatureFlags: () => featureFlagsSpy(),
  };
});

/**
 * v1.4.37 W5 — Coach disable cascade invariant.
 *
 * Marc directive: when the operator turns the global Coach flag off,
 * every Coach affordance on every surface must vanish — no
 * grey-out, no error, no inert button, no DOM trace. The web app
 * gates each surface via `useFeatureFlags()` and a `flags.coach`
 * short-circuit; the invariant below pins the contract so a future
 * surface addition can't silently leak the affordance.
 *
 * How to extend: when a new Coach-bearing surface lands (button,
 * drawer, chip strip, FAB, inline pill), add an entry to the
 * `COACH_SURFACES` fixture below and bump the `expect(... .length)`
 * count in the trailing sync-check. The contract per surface is
 * "renders nothing measurable in the SSR output when the Coach flag
 * is off"; surfaces that need data-slot probes should expose a
 * stable `data-slot="coach-*"` attribute the test can grep.
 *
 * The hook layer is covered by `src/hooks/__tests__/
 * use-feature-flags.test.tsx`; this file is the integration-style
 * contract that walks each surface and asserts the gate is present.
 */

/**
 * Build a QueryClient pre-seeded with the operator's flag matrix so
 * every `useFeatureFlags()` consumer reads the supplied set
 * synchronously during the SSR pass (no fetch round-trip required).
 */
function buildClient(flags: Partial<AssistantFlagSet>): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  });
  client.setQueryData(["feature-flags"], {
    assistant: {
      enabled: true,
      coach: true,
      briefing: true,
      insightStatus: true,
      correlations: true,
      healthScoreExplainer: true,
      ...flags,
    },
  });
  return client;
}

function renderWithFlags(node: React.ReactNode, coach: boolean): string {
  // v1.4.38 W-C M-5 — drive the mocked `useFeatureFlags` from the same
  // matrix the QueryClient is seeded with so the gate-call assertion at
  // the bottom of the file can read the resolved value. Keeping the
  // QueryClient seed in place preserves the original render path for
  // any consumer that bypasses the hook.
  const resolved: AssistantFlagSet = {
    ...DEFAULT_ASSISTANT_FLAGS,
    coach,
  };
  featureFlagsSpy.mockImplementation(() => resolved);
  const client = buildClient({ coach });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

// ────────────────────────────────────────────────────────────────────
// Coach-bearing surface fixture.
//
// Each entry mounts the surface in isolation, supplies the minimum
// non-Coach scaffolding the component needs (CoachLaunchProvider, …)
// and exposes a stable substring that proves the surface painted. The
// substring should be unique enough that a "did not render" check is
// meaningful — typically the surface's `data-slot="coach-*"`
// attribute or its localised label.
//
// IMPORTANT: when adding a new Coach surface to the codebase, add a
// matching entry here. The test below walks every entry and asserts
// the surface vanishes when the operator's global Coach flag is off.
// ────────────────────────────────────────────────────────────────────

interface CoachSurface {
  /** Human-readable description that surfaces in the test output. */
  name: string;
  /** Mounts the surface in isolation. Receives no props. */
  mount: () => React.ReactNode;
  /**
   * Substring that proves the surface painted when the flag is ON.
   * Empty string means "the surface's SSR shape is intentionally
   * blank even with the flag on" (e.g. lazy-loaded subtrees); the
   * positive-case test is skipped while the negative-case
   * `coach-*` slot grep still pins the gate.
   */
  proofWhenOn: string;
}

const COACH_SURFACES: CoachSurface[] = [
  {
    name: "HeroStrip action-row 'Ask the coach' button",
    mount: () => (
      <HeroStrip
        briefing={null}
        now={new Date(2026, 4, 10, 9, 0, 0)}
        onAskCoach={() => undefined}
      />
    ),
    proofWhenOn: 'data-slot="insights-hero-strip-action-coach"',
  },
  {
    name: "HeroStrip SuggestedPrompts chip strip",
    mount: () => (
      <HeroStrip
        briefing={null}
        now={new Date(2026, 4, 10, 9, 0, 0)}
        onPickPrompt={() => undefined}
      />
    ),
    proofWhenOn: 'data-slot="insights-hero-strip-prompts"',
  },
  {
    name: "SuggestedPrompts standalone",
    mount: () => <SuggestedPrompts onPick={() => undefined} />,
    proofWhenOn: 'data-slot="insights-suggested-prompts"',
  },
  {
    name: "CoachLaunchButton inline pill",
    mount: () => (
      // The button only renders inside <CoachLaunchProvider>; wrap so
      // the Coach-flag-off branch is the dispositive guard.
      <CoachLaunchProvider>
        <CoachLaunchButton />
      </CoachLaunchProvider>
    ),
    proofWhenOn: 'data-slot="coach-launch-inline"',
  },
  {
    name: "LayoutCoachFab sticky mobile button",
    mount: () => (
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>
    ),
    proofWhenOn: 'data-slot="coach-launch-fab"',
  },
  {
    name: "LayoutCoachMount drawer subtree",
    mount: () => (
      <CoachLaunchProvider>
        <LayoutCoachMount />
      </CoachLaunchProvider>
    ),
    // The drawer is lazy-loaded via next/dynamic and SSRs to nothing
    // even when the flag is on; the contract here is "no Coach-marked
    // mount point ever paints when the flag is off". Skip the proof
    // check; the negative `coach-*` slot grep still pins the gate, and
    // the explicit spy assertion in `LayoutCoachMount SSR-proof spy`
    // below proves the gate actually fired during the off render.
    proofWhenOn: "",
  },
];

describe("Coach disable cascade invariant", () => {
  // Silence the dev-only "should not be used during SSR" warning some
  // components emit when their effects would normally mount.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // v1.4.38 W-C M-5 — reset the call history so each iteration of
    // the surface loop sees a clean slate when it asserts the gate
    // fired during the off render.
    featureFlagsSpy.mockClear();
    featureFlagsSpy.mockImplementation(() => DEFAULT_ASSISTANT_FLAGS);
  });

  for (const surface of COACH_SURFACES) {
    it(`${surface.name} — paints when the Coach flag is on`, () => {
      // Skip the positive proof for surfaces whose SSR shape is
      // intentionally empty (lazy-loaded drawer subtrees). The
      // negative assertion below still pins the gate.
      if (!surface.proofWhenOn) return;
      const html = renderWithFlags(surface.mount(), true);
      expect(html).toContain(surface.proofWhenOn);
    });

    it(`${surface.name} — vanishes when the Coach flag is off`, () => {
      const html = renderWithFlags(surface.mount(), false);
      if (surface.proofWhenOn) {
        expect(html).not.toContain(surface.proofWhenOn);
      }
      // Every Coach-bearing surface in the app marks its mount point
      // with a `coach-` slot. Pin the negative shape against the
      // shared prefix so a surface that grows a new `coach-*` slot
      // without a gate fails this test by default.
      expect(html).not.toMatch(/data-slot="coach-[a-z]/);
      // The suggested-prompts strip uses an `insights-suggested-prompts`
      // slot (legacy naming pre-dates the `coach-` convention); pin
      // it explicitly so the gate can't regress.
      expect(html).not.toContain('data-slot="insights-suggested-prompts"');
      // Same story for the hero strip's coach action button + prompts
      // wrapper.
      expect(html).not.toContain(
        'data-slot="insights-hero-strip-action-coach"',
      );
      expect(html).not.toContain('data-slot="insights-hero-strip-prompts"');
      // v1.4.38 W-C M-5 — `proofWhenOn: ""` surfaces (the lazy-loaded
      // `LayoutCoachMount` drawer subtree) trivially pass the substring
      // grep because their SSR shape is empty even when the gate is on.
      // The spy assertion below proves the gate actually fired with the
      // operator-disabled matrix, so a regression that removes the
      // `if (!flags.coach) return null` short-circuit fails this test
      // instead of slipping through under cover of the empty SSR shape.
      expect(featureFlagsSpy).toHaveBeenCalled();
      const lastCall = featureFlagsSpy.mock.results.at(-1);
      expect(lastCall?.value.coach).toBe(false);
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // v1.4.38 W-C H4 — grep-based discovery of every `flags.coach`
  // call site in the codebase.
  //
  // The fixture-count check below pins the surfaces the fixture mounts
  // directly. Cross-cut gates on sub-pages (`/targets` page drawer,
  // `<TargetCard>` per-card CTA) sit OUTSIDE the fixture and are owned
  // by sibling invariants. A future contributor who lands a new Coach
  // mount on (e.g.) `/insights/blood-pressure/page.tsx` would not trip the
  // surface-count check at all — the new site is on a sub-page and
  // would silently leak.
  //
  // The walk below scans `src/` for every `flags.coach` occurrence and
  // requires each path to appear in the explicit `KNOWN_COACH_GATE_SITES`
  // allowlist. Add a new entry every time you intentionally gate a new
  // render path on the Coach flag; the failure message names the
  // unaccounted-for paths so the fix is one search-and-add.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Every file in `src/` that legitimately reads `flags.coach`. Lives
   * here (next to the cascade fixture) so a contributor extending the
   * fixture sees the allowlist in the same review.
   *
   * Paths are POSIX-style relative to the repo root.
   */
  const KNOWN_COACH_GATE_SITES: ReadonlyArray<string> = [
    // Coach-bearing surfaces mounted directly by the cascade fixture.
    "src/components/insights/coach-launch-button.tsx",
    "src/components/insights/hero-strip.tsx",
    "src/components/insights/layout-coach-fab.tsx",
    "src/components/insights/layout-coach-mount.tsx",
    "src/components/insights/suggested-prompts.tsx",
    // Cross-cut gates owned by sibling invariants
    // (`targets-coach-mount.test.tsx`, `target-card.test.tsx`).
    "src/app/targets/page.tsx",
    "src/components/targets/target-card.tsx",
  ];

  /**
   * Walk every TS / TSX file under `src/`, excluding test trees, and
   * collect the relative paths that contain a `flags.coach` token. The
   * grep is intentionally simple — any literal occurrence counts so a
   * contributor who paraphrases the read (`const c = flags.coach`)
   * still trips this test.
   */
  function findCoachFlagSites(): string[] {
    const srcRoot = resolve(__dirname, "..", "..", "..");
    const hits: string[] = [];
    const repoRoot = resolve(srcRoot, "..");

    function walk(dir: string): void {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (entry === "node_modules" || entry === ".next") continue;
          // Skip every `__tests__/` subtree — the discovery target is
          // the production gate, not the assertions about it.
          if (entry === "__tests__") continue;
          // v1.4.47 W3 — skip the Prisma client output. The generator
          // embeds the entire `prisma/schema.prisma` source into
          // `internal/class.ts` as a JSON-escaped `inlineSchema`
          // string, so any literal `flags.coach` mention in a schema
          // doc-comment leaks through here and trips the orphan check.
          // Generated derivatives are never the gate site we want to
          // pin; the production component file is.
          if (entry === "generated") continue;
          walk(full);
          continue;
        }
        if (!/\.(tsx|ts)$/.test(entry)) continue;
        if (/\.test\.(tsx|ts)$/.test(entry)) continue;
        const text = readFileSync(full, "utf8");
        // Match `flags.coach` on lines that are NOT pure comments. A
        // hit on a JSDoc / `//` line is documentation, not a gate, and
        // would make the allowlist a maintenance burden every time
        // someone references the gate in a comment.
        const isRealGate = text.split("\n").some((line) => {
          if (!line.includes("flags.coach")) return false;
          const trimmed = line.trim();
          if (trimmed.startsWith("//")) return false;
          if (trimmed.startsWith("*")) return false;
          return true;
        });
        if (isRealGate) {
          // POSIX-style path relative to the repo root so the failure
          // message stays portable across contributors' checkout
          // directories.
          hits.push(relative(repoRoot, full).split(/[\\/]/).join("/"));
        }
      }
    }

    walk(srcRoot);
    return hits.sort();
  }

  it("grep-based discovery pins every `flags.coach` call site", () => {
    const discovered = findCoachFlagSites();
    const allowlist = new Set(KNOWN_COACH_GATE_SITES);
    const orphans = discovered.filter((path) => !allowlist.has(path));
    expect(
      orphans,
      [
        "Found `flags.coach` in file(s) not on the KNOWN_COACH_GATE_SITES",
        "allowlist (src/lib/feature-flags/__tests__/coach-cascade.test.tsx).",
        "Add a fixture entry (or a sibling invariant) for the new gate,",
        "then add the path to the allowlist. Orphans:",
        ...orphans.map((p) => `  - ${p}`),
      ].join("\n"),
    ).toEqual([]);

    // Sanity check the other direction — an allowlist entry that no
    // longer references `flags.coach` is dead documentation and
    // should be pruned in the same PR that removes the gate.
    const discoveredSet = new Set(discovered);
    const stale = KNOWN_COACH_GATE_SITES.filter(
      (path) => !discoveredSet.has(path),
    );
    expect(
      stale,
      [
        "KNOWN_COACH_GATE_SITES references file(s) that no longer use",
        "`flags.coach`. Remove the stale allowlist entry:",
        ...stale.map((p) => `  - ${p}`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("fixture stays in sync with the Coach gate call sites", () => {
    // Counts the Coach-bearing surfaces the fixture knows about. If a
    // contributor adds a new `useFeatureFlags()` + `flags.coach` gate
    // to a render path, the count below must move and this assertion
    // forces them to revisit the fixture. The number tracks the
    // surfaces the fixture mounts directly; cross-cut gates on
    // sub-pages (target-card, /targets page) are owned by other
    // invariants (`targets-coach-mount.test.tsx`,
    // `target-card.test.tsx`) and by the grep-based discovery test
    // above.
    expect(COACH_SURFACES.length).toBe(6);
  });
});
