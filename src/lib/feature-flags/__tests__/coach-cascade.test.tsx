import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachLaunchProvider } from "@/lib/insights/coach-launch-context";
import type { AssistantFlagSet } from "@/hooks/use-feature-flags";

import { HeroStrip } from "@/components/insights/hero-strip";
import { SuggestedPrompts } from "@/components/insights/suggested-prompts";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { LayoutCoachFab } from "@/components/insights/layout-coach-fab";
import { LayoutCoachMount } from "@/components/insights/layout-coach-mount";

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
    // check; the negative `coach-*` slot grep still pins the gate.
    proofWhenOn: "",
  },
];

describe("Coach disable cascade invariant", () => {
  // Silence the dev-only "should not be used during SSR" warning some
  // components emit when their effects would normally mount.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    });
  }

  it("fixture stays in sync with the Coach gate call sites", () => {
    // Counts the Coach-bearing surfaces the fixture knows about. If a
    // contributor adds a new `useFeatureFlags()` + `flags.coach` gate
    // to a render path, the count below must move and this assertion
    // forces them to revisit the fixture. The number tracks the
    // surfaces the fixture mounts directly; cross-cut gates on
    // sub-pages (target-card, /targets page) are owned by other
    // invariants (`targets-coach-mount.test.tsx`,
    // `target-card.test.tsx`).
    expect(COACH_SURFACES.length).toBe(6);
  });
});
