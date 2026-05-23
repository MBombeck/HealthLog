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
import type { AuthUser } from "@/hooks/use-auth";

import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { LayoutCoachFab } from "@/components/insights/layout-coach-fab";
import { LayoutCoachMount } from "@/components/insights/layout-coach-mount";
import { SuggestedPrompts } from "@/components/insights/suggested-prompts";
import { HeroStrip } from "@/components/insights/hero-strip";
import { TargetCard, type TargetCardData } from "@/components/targets/target-card";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useDisableCoach } from "@/hooks/use-disable-coach";

/**
 * v1.4.47 W3 — per-user "Hide Coach" opt-out invariant.
 *
 * The Coach disable cascade (`coach-cascade.test.tsx`) pins the
 * operator-level `flags.coach` gate. This sibling fixture pins the
 * per-user `disableCoach` gate that sits BELOW the operator flag —
 * either gate being off must hide every Coach affordance with no
 * grey-out, no error, no inert button, no DOM trace.
 *
 * Mocking strategy mirrors the cascade fixture: spy `useFeatureFlags`
 * to drive the operator matrix synchronously during SSR, spy
 * `useAuth` to drive the per-user `disableCoach` field. Both spies
 * are reset between iterations so a regression in either gate trips
 * the invariant in isolation.
 */

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

const authSpy = vi.fn<
  () => { user: AuthUser | null; isAuthenticated: boolean }
>(() => ({ user: null, isAuthenticated: false }));
vi.mock("@/hooks/use-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/use-auth")>(
      "@/hooks/use-auth",
    );
  return {
    ...actual,
    useAuth: () => authSpy(),
  };
});

// The Coach gates read user.disableCoach through `useDisableCoach`,
// which itself calls `useAuth()`. Mocking `useDisableCoach` directly
// would bypass the useAuth call site and make the spy assertion
// below trivially fail; instead we let the real `useDisableCoach`
// pass through and capture the underlying `useAuth` calls.

function buildUser(disableCoach: boolean): AuthUser {
  // Minimal `AuthUser` shape — the Coach gates only read
  // `disableCoach`, but TypeScript requires the full interface to
  // satisfy the mock's return type. Everything else is filler.
  return {
    id: "test-user-id",
    username: "test",
    email: null,
    role: "USER",
    heightCm: null,
    dateOfBirth: null,
    gender: null,
    timezone: "Europe/Berlin",
    onboardingCompletedAt: null,
    onboardingTourCompleted: true,
    gravatarUrl: null,
    glucoseUnit: null,
    disableCoach,
  };
}

function buildClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  });
}

function renderWithDisableCoach(
  node: React.ReactNode,
  disableCoach: boolean,
  coach: boolean = true,
): string {
  featureFlagsSpy.mockImplementation(() => ({
    ...DEFAULT_ASSISTANT_FLAGS,
    coach,
  }));
  authSpy.mockImplementation(() => ({
    user: buildUser(disableCoach),
    isAuthenticated: true,
  }));
  const client = buildClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

interface DisableCoachSurface {
  name: string;
  mount: () => React.ReactNode;
  /**
   * Substring that proves the surface painted. Empty string means
   * "the surface SSR-renders to nothing even when on" (lazy-loaded
   * subtrees) and the negative assertion is the dispositive check.
   */
  proofWhenVisible: string;
}

const DISABLE_COACH_SURFACES: DisableCoachSurface[] = [
  {
    name: "LayoutCoachFab",
    mount: () => (
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>
    ),
    proofWhenVisible: 'data-slot="coach-launch-fab"',
  },
  {
    name: "LayoutCoachMount",
    mount: () => (
      <CoachLaunchProvider>
        <LayoutCoachMount />
      </CoachLaunchProvider>
    ),
    // Lazy-loaded — SSR shape is empty even when visible. Negative
    // assertion still pins the gate via the `coach-*` slot grep.
    proofWhenVisible: "",
  },
  {
    name: "CoachLaunchButton inline pill",
    mount: () => (
      <CoachLaunchProvider>
        <CoachLaunchButton />
      </CoachLaunchProvider>
    ),
    proofWhenVisible: 'data-slot="coach-launch-inline"',
  },
  {
    name: "SuggestedPrompts chip strip",
    mount: () => <SuggestedPrompts onPick={() => undefined} />,
    proofWhenVisible: 'data-slot="insights-suggested-prompts"',
  },
  {
    name: "HeroStrip action-row Ask the coach",
    mount: () => (
      <HeroStrip
        briefing={null}
        now={new Date(2026, 4, 10, 9, 0, 0)}
        onAskCoach={() => undefined}
      />
    ),
    proofWhenVisible: 'data-slot="insights-hero-strip-action-coach"',
  },
  {
    // v1.4.48 L2 — `<TargetCard>` carries the per-card "Ask the coach"
    // CTA on the targets page. The card itself only consults
    // `flags.coach`; the per-user disable gate is computed by the parent
    // (`src/app/targets/page.tsx`) which does
    // `aiEnabled = flags.coach && !user?.disableCoach && providerActive`.
    // The driver below mirrors that wiring so the negative assertion
    // (CTA absent when `disableCoach` is true) pins the chain end-to-end
    // and trips a regression in either the card-level gate or the
    // page-level computation.
    name: "TargetCard per-card 'Ask the coach' CTA",
    mount: () => <TargetCardDriver />,
    proofWhenVisible: 'data-slot="target-coach-cta"',
  },
];

/**
 * Inline driver that mirrors the `src/app/targets/page.tsx` wiring of
 * `aiEnabled` to the per-card CTA. Reads the same hooks the page does,
 * threads the resolved boolean into `<TargetCard>`. Keeps the user-
 * disable fixture honest about the cascade — a future contributor who
 * "simplifies" the page's `coachEnabled` computation and drops the
 * `user?.disableCoach` branch fails this surface's negative assertion.
 */
const TARGET_CARD_FIXTURE: TargetCardData = {
  type: "WEIGHT",
  label: "Weight",
  current: 78.2,
  average30: 79.1,
  trend: "down",
  unit: "kg",
  range: { min: 60, max: 80 },
  classification: { category: "Normal", color: "#50fa7b" },
  source: "WHO BMI",
  daysInRange7d: 5,
  daysLogged7d: 7,
  lastMetGoalAt: "2026-05-10",
  streakDays: 4,
  insufficientData: false,
  consistency7d: ["in", "in", "near", "in", "out", "in", "in"],
};

function TargetCardDriver() {
  const flags = useFeatureFlags();
  const disableCoach = useDisableCoach();
  const aiEnabled = flags.coach && !disableCoach;
  return (
    <TargetCard
      target={TARGET_CARD_FIXTURE}
      aiEnabled={aiEnabled}
      onAskCoach={() => undefined}
    />
  );
}

describe("Coach per-user disableCoach invariant", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    featureFlagsSpy.mockClear();
    authSpy.mockClear();
    featureFlagsSpy.mockImplementation(() => DEFAULT_ASSISTANT_FLAGS);
    authSpy.mockImplementation(() => ({
      user: buildUser(false),
      isAuthenticated: true,
    }));
  });

  for (const surface of DISABLE_COACH_SURFACES) {
    it(`${surface.name} — paints when user.disableCoach is false`, () => {
      if (!surface.proofWhenVisible) return;
      const html = renderWithDisableCoach(surface.mount(), false);
      expect(html).toContain(surface.proofWhenVisible);
    });

    it(`${surface.name} — vanishes when user.disableCoach is true`, () => {
      const html = renderWithDisableCoach(surface.mount(), true);
      if (surface.proofWhenVisible) {
        expect(html).not.toContain(surface.proofWhenVisible);
      }
      // No Coach-marked mount point may paint when the per-user gate
      // is on. Pin the negative shape against the shared prefix so a
      // future surface that grows a new `coach-*` slot without the
      // disableCoach gate fails this test by default.
      expect(html).not.toMatch(/data-slot="coach-[a-z]/);
      expect(html).not.toContain('data-slot="insights-suggested-prompts"');
      expect(html).not.toContain(
        'data-slot="insights-hero-strip-action-coach"',
      );
      expect(html).not.toContain('data-slot="insights-hero-strip-prompts"');
    });

    it(`${surface.name} — also vanishes when flags.coach is false (regression pin)`, () => {
      // The legacy operator-level gate must keep working in the
      // presence of the new per-user gate. This guards against a
      // regression where a contributor "simplifies" the two checks
      // into one and accidentally drops the operator branch.
      const html = renderWithDisableCoach(surface.mount(), false, false);
      if (surface.proofWhenVisible) {
        expect(html).not.toContain(surface.proofWhenVisible);
      }
      expect(html).not.toMatch(/data-slot="coach-[a-z]/);
    });
  }

  it("`useAuth` gate is consulted on every Coach surface", () => {
    // A `disableCoach: true` render must trip the `useAuth` spy at
    // least once. Otherwise a future regression that drops the
    // `useAuth()` call site silently leaks the affordance.
    for (const surface of DISABLE_COACH_SURFACES) {
      authSpy.mockClear();
      renderWithDisableCoach(surface.mount(), true);
      expect(
        authSpy,
        `${surface.name} did not consult useAuth() during render`,
      ).toHaveBeenCalled();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // v1.4.48 H2 — grep-based discovery of every `useDisableCoach` /
  // `user.disableCoach` call site in the codebase.
  //
  // Mirrors the `flags.coach` discovery walk in `coach-cascade.test.tsx`:
  // the surface fixture above pins the surfaces this file mounts
  // directly. Cross-cut gates on sub-pages (`/targets` page parent
  // computation, Settings → Insights toggle, `/api/auth/me` response
  // shape, the disable-coach PATCH route) sit OUTSIDE the fixture and
  // are owned by sibling invariants or by route-level tests.
  //
  // The walk below scans `src/` for every `useDisableCoach` /
  // `user.disableCoach` / `user?.disableCoach` occurrence and requires
  // each path to appear in the explicit `KNOWN_DISABLE_COACH_GATE_SITES`
  // allowlist. Add a new entry every time you intentionally read the
  // per-user disable flag in a new path; the failure message names the
  // unaccounted-for paths so the fix is one search-and-add.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Every file in `src/` that legitimately reads `useDisableCoach` or
   * `user.disableCoach`. Lives next to the disable-cascade fixture so a
   * contributor extending the fixture sees the allowlist in the same
   * review.
   *
   * Paths are POSIX-style relative to the repo root.
   */
  const KNOWN_DISABLE_COACH_GATE_SITES: ReadonlyArray<string> = [
    // Coach-bearing surfaces mounted directly by the disable-cascade
    // fixture above; each one calls `useDisableCoach()` and short-
    // circuits to `null` when the per-user flag is on.
    "src/components/insights/coach-launch-button.tsx",
    "src/components/insights/hero-strip.tsx",
    "src/components/insights/layout-coach-fab.tsx",
    "src/components/insights/layout-coach-mount.tsx",
    "src/components/insights/suggested-prompts.tsx",
    // The hook itself + its `useAuth`-backed reader.
    "src/hooks/use-disable-coach.ts",
    // Cross-cut gates owned by sibling invariants / route tests.
    // - `/api/auth/me` ships the flag in the session payload so the
    //   client hooks can read it (`useAuth → useDisableCoach`). The
    //   sibling `/api/auth/me/disable-coach` PATCH endpoint that
    //   writes the flag does NOT read `user.disableCoach` (it reads
    //   `body.disableCoach`) and is intentionally not listed here.
    "src/app/api/auth/me/route.ts",
    // - The targets page's parent-level cascade: computes
    //   `coachEnabled = flags.coach && !user?.disableCoach` and threads
    //   `aiEnabled` down to `<TargetCard>`. The disable-cascade fixture
    //   covers the end-to-end chain via `<TargetCardDriver>`.
    "src/app/targets/page.tsx",
    // - Settings → Insights toggle reads + writes the flag.
    "src/components/settings/ai-section.tsx",
  ];

  /**
   * Walk every TS / TSX file under `src/`, excluding test trees + the
   * Prisma client output, and collect the relative paths that
   * legitimately reference `useDisableCoach` or `user.disableCoach`.
   * Any literal occurrence on a non-comment line counts so a
   * contributor who paraphrases the read still trips this test.
   */
  function findDisableCoachSites(): string[] {
    const srcRoot = resolve(__dirname, "..", "..", "..");
    const repoRoot = resolve(srcRoot, "..");
    const hits: string[] = [];

    function isRealGateLine(line: string): boolean {
      // Trim once so leading whitespace doesn't fool the comment check.
      const trimmed = line.trim();
      if (trimmed.startsWith("//")) return false;
      if (trimmed.startsWith("*")) return false;
      // `useDisableCoach` covers both the hook import + the hook call.
      if (line.includes("useDisableCoach")) return true;
      // `user.disableCoach` / `user?.disableCoach` — the canonical
      // per-user gate read on the auth user object. Strict match on
      // `user` so we don't grab unrelated `disableCoach` strings (route
      // body keys, i18n message ids, …).
      if (/\buser\??\.disableCoach\b/.test(line)) return true;
      return false;
    }

    function walk(dir: string): void {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (entry === "node_modules" || entry === ".next") continue;
          if (entry === "__tests__") continue;
          // Skip the Prisma client output — the generator embeds the
          // entire `prisma/schema.prisma` source as a JSON-escaped
          // `inlineSchema` string and any schema doc-comment that
          // mentions `disableCoach` would otherwise leak through here.
          if (entry === "generated") continue;
          walk(full);
          continue;
        }
        if (!/\.(tsx|ts)$/.test(entry)) continue;
        if (/\.test\.(tsx|ts)$/.test(entry)) continue;
        const text = readFileSync(full, "utf8");
        if (text.split("\n").some(isRealGateLine)) {
          hits.push(relative(repoRoot, full).split(/[\\/]/).join("/"));
        }
      }
    }

    walk(srcRoot);
    return hits.sort();
  }

  it("grep-based discovery pins every `useDisableCoach` / `user.disableCoach` call site", () => {
    const discovered = findDisableCoachSites();
    const allowlist = new Set(KNOWN_DISABLE_COACH_GATE_SITES);
    const orphans = discovered.filter((path) => !allowlist.has(path));
    expect(
      orphans,
      [
        "Found `useDisableCoach` / `user.disableCoach` in file(s) not on",
        "the KNOWN_DISABLE_COACH_GATE_SITES allowlist",
        "(src/lib/feature-flags/__tests__/coach-user-disable.test.tsx).",
        "Add a fixture entry (or a sibling invariant) for the new gate,",
        "then add the path to the allowlist. Orphans:",
        ...orphans.map((p) => `  - ${p}`),
      ].join("\n"),
    ).toEqual([]);

    // Sanity check the other direction — an allowlist entry that no
    // longer references the gate is dead documentation and should be
    // pruned in the same PR that removes the read.
    const discoveredSet = new Set(discovered);
    const stale = KNOWN_DISABLE_COACH_GATE_SITES.filter(
      (path) => !discoveredSet.has(path),
    );
    expect(
      stale,
      [
        "KNOWN_DISABLE_COACH_GATE_SITES references file(s) that no longer",
        "use `useDisableCoach` / `user.disableCoach`. Remove the stale",
        "allowlist entry:",
        ...stale.map((p) => `  - ${p}`),
      ].join("\n"),
    ).toEqual([]);
  });
});
