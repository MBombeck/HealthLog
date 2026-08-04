import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { AccountAccess } from "@/lib/sharing/account-access-view";

/**
 * v1.4.27 R3d MB4 — Coach launch context smoke contract.
 *
 * The project's test convention is `renderToStaticMarkup` (no
 * `@testing-library/react` dependency). We can't simulate interaction
 * inside SSR, but we can verify:
 *   1. The provider mounts and renders its children.
 *   2. The hook returns a value-shape (open, prefill, askCoach,
 *      setOpen) when called beneath the provider.
 *   3. The hook returns `null` when called outside the provider —
 *      consumers degrade gracefully (e.g. the launch button renders
 *      nothing rather than crashing).
 *   4. v1.36.x — the provider publishes nothing inside somebody else's
 *      record, so (3) also covers every consumer under a switch. The shell
 *      mounts no drawer there, and a launch call that opened nothing was a
 *      button that silently did nothing on every page that offers one.
 *
 * Mutation check, run: dropping the `inSharedRecord` arm from the provider's
 * value memo → "publishes nothing inside somebody else's record" goes red
 * with the full context shape in the diff.
 */

const OWNER = {
  accountId: "acct-owner",
  username: "owner",
  displayName: "Margarethe",
  access: "write" as const,
  level: "write" as const,
  sections: null,
  canWrite: true,
};

const mockAccessRef: { value: AccountAccess } = {
  value: { accounts: [OWNER], active: null, canSwitch: true },
};

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "delegate",
      username: "delegate",
      email: null,
      role: "USER",
      avatarUrl: null,
      modules: {},
      accountAccess: mockAccessRef.value,
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

const { CoachLaunchProvider, resolveLaunchState, useCoachLaunch } =
  await import("../coach-launch-context");

function Probe({ output }: { output: string[] }) {
  const launch = useCoachLaunch();
  if (!launch) {
    output.push("null");
    return null;
  }
  output.push(
    JSON.stringify({
      hasAskCoach: typeof launch.askCoach,
      hasSetOpen: typeof launch.setOpen,
      open: launch.open,
      prefill: launch.prefill,
      documentId: launch.documentId,
    }),
  );
  return <span data-slot="probe-output">{output.join(",")}</span>;
}

describe("CoachLaunchProvider", () => {
  it("returns null when consumed outside the provider", () => {
    const output: string[] = [];
    renderToStaticMarkup(<Probe output={output} />);
    expect(output).toEqual(["null"]);
  });

  it("exposes the full context shape when consumed beneath the provider", () => {
    const output: string[] = [];
    renderToStaticMarkup(
      <CoachLaunchProvider>
        <Probe output={output} />
      </CoachLaunchProvider>,
    );
    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.hasAskCoach).toBe("function");
    expect(parsed.hasSetOpen).toBe("function");
    expect(parsed.open).toBe(false);
    expect(parsed.prefill).toBeNull();
    // v1.28.52 — the document scope defaults to null (health chat).
    expect(parsed.documentId).toBeNull();
  });

  it("renders the children inside the provider mount", () => {
    const html = renderToStaticMarkup(
      <CoachLaunchProvider>
        <div data-slot="child-mount">child</div>
      </CoachLaunchProvider>,
    );
    expect(html).toContain('data-slot="child-mount"');
    expect(html).toContain("child");
  });

  it("publishes nothing inside somebody else's record, at both levels", () => {
    for (const access of ["read", "write"] as const) {
      mockAccessRef.value = {
        accounts: [OWNER],
        active: {
          ...OWNER,
          access,
          level: access,
          canWrite: access === "write",
        },
        canSwitch: true,
      };
      const output: string[] = [];
      renderToStaticMarkup(
        <CoachLaunchProvider>
          <Probe output={output} />
        </CoachLaunchProvider>,
      );
      // The whole recorded value, not a boolean: a failure prints the shape
      // that leaked rather than `false !== true`.
      expect(output, `grant level: ${access}`).toEqual(["null"]);
    }
    mockAccessRef.value = { accounts: [OWNER], active: null, canSwitch: true };
  });

  it("still renders its children there — only the launch value is withheld", () => {
    mockAccessRef.value = {
      accounts: [OWNER],
      active: OWNER,
      canSwitch: true,
    };
    const html = renderToStaticMarkup(
      <CoachLaunchProvider>
        <div data-slot="child-mount">child</div>
      </CoachLaunchProvider>,
    );
    mockAccessRef.value = { accounts: [OWNER], active: null, canSwitch: true };
    expect(html).toContain('data-slot="child-mount"');
  });
});

/**
 * v1.28.52 (Documents R3) — the pure open-state derivation the provider's
 * `askCoach(...)` applies. Testing it directly pins the precedence rules
 * (document scope, ambient inheritance, auto-send gating) without simulating
 * React state.
 */
describe("resolveLaunchState", () => {
  const NO_AMBIENT = { ambientScope: null, ambientPrefill: null } as const;

  it("threads an explicit documentId through so the drawer opens doc-scoped", () => {
    const result = resolveLaunchState({
      nextPrefill: null,
      nextAutoSend: false,
      nextDocumentId: "doc-123",
      ...NO_AMBIENT,
    });
    expect(result).toEqual({
      prefill: null,
      scope: null,
      documentId: "doc-123",
      // v1.31.0 — a document launch never carries a workout scope; the two
      // are set by different call sites and never together.
      workoutId: null,
      autoSend: false,
    });
  });

  it("defaults documentId to null for a plain (health) launch", () => {
    expect(resolveLaunchState({ ...NO_AMBIENT }).documentId).toBeNull();
  });

  it("never inherits a document scope from ambient page state", () => {
    // A document scope is only ever explicit — ambient scope must not leak one.
    const result = resolveLaunchState({
      ambientScope: { metric: "weight" },
      ambientPrefill: "How is my weight?",
    });
    expect(result.documentId).toBeNull();
    // Ambient scope + opener still inherited for the health path.
    expect(result.scope).toEqual({ metric: "weight" });
    expect(result.prefill).toBe("How is my weight?");
  });

  it("gates auto-send on an explicit prefill (a doc/blank open never auto-sends)", () => {
    expect(
      resolveLaunchState({
        nextAutoSend: true,
        nextDocumentId: "doc-1",
        ...NO_AMBIENT,
      }).autoSend,
    ).toBe(false);
    expect(
      resolveLaunchState({
        nextPrefill: "Explain this",
        nextAutoSend: true,
        ...NO_AMBIENT,
      }).autoSend,
    ).toBe(true);
  });

  it("lets an explicit scope win over ambient scope", () => {
    const result = resolveLaunchState({
      nextScope: { metric: "pulse" },
      ambientScope: { metric: "weight" },
      ambientPrefill: "ambient opener",
    });
    expect(result.scope).toEqual({ metric: "pulse" });
    // Explicit scope means the ambient opener is NOT inherited.
    expect(result.prefill).toBeNull();
  });
});
