/**
 * v1.18.0 — Settings → Module ("Was du trackst") hub contract.
 *
 * `<ModulesSection>` lists every toggleable module with a `<Switch>` bound
 * to the resolved module map (`useAuth().user.modules`), plus a read-only
 * "always on" group for the four core domains. Flipping a toggle PATCHes
 * `/api/auth/me/modules` (a DISABLED allowlist) and invalidates the
 * `authMe()` query so nav / pills / tiles re-gate live. The two delegated
 * modules (coach, cycle) render a live switch too, but their flip drives the
 * canonical column (`disableCoach` / `cycleTrackingEnabled`) via the existing
 * per-column endpoints — never the module-allowlist the gate ignores for them.
 *
 * Test strategy mirrors `advanced-account-delete.test.tsx`: mock
 * `@tanstack/react-query` so the rendered tree executes under SSR
 * (`renderToStaticMarkup`), capture the `useMutation` config to assert the
 * PATCH body + the `authMe()` invalidation directly, and mock `useAuth` to
 * drive the disabled-module case.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { AuthUser } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { MODULE_KEYS, isCodeDisabledModule } from "@/lib/modules/registry";

// Capture the latest useMutation config + a shared mutate spy so we can
// invoke `mutationFn` / `onSuccess` by hand (the SSR pass can't fire a
// real DOM click).
type MutationConfig = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onSuccess?: (data?: unknown, variables?: unknown) => void;
  onError?: (err?: unknown) => void;
};
let lastMutation: MutationConfig | null = null;
const mutateSpy = vi.fn();
const invalidateSpy = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: invalidateSpy,
    getQueryCache: () => ({ findAll: () => [] }),
    // v1.32.22 — the writer reads/seeds the optimistic-concurrency token
    // via the query cache; no token seeded → tokenless (unconditional) write.
    getQueryData: () => undefined,
    setQueryData: vi.fn(),
    removeQueries: vi.fn(),
  }),
  useMutation: (config: MutationConfig) => {
    lastMutation = config;
    return { mutate: mutateSpy, isPending: false };
  },
}));

const authSpy = vi.fn<
  () => { user: AuthUser | null; isAuthenticated: boolean }
>(() => ({ user: buildUser({}), isAuthenticated: true }));
vi.mock("@/hooks/use-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/use-auth")>(
      "@/hooks/use-auth",
    );
  return { ...actual, useAuth: () => authSpy() };
});

// The hub renders a live coach switch and reads the `coach` AI capability to
// decide whether the operator switched the Coach off server-wide. Mock the
// hook directly so the SSR pass doesn't need a `<QueryClientProvider>`.
import type { AiCapabilityState } from "@/lib/ai/capabilities/types";
const COACH_AVAILABLE: AiCapabilityState = {
  available: true,
  reason: null,
  onDeviceAllowed: true,
};
const coachSpy = vi.fn<() => AiCapabilityState>(() => COACH_AVAILABLE);
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => coachSpy(),
}));

function buildUser(
  modules: AuthUser["modules"],
  overrides: Partial<AuthUser> = {},
): AuthUser {
  return {
    id: "user-1",
    username: "testuser",
    email: null,
    role: "USER",
    heightCm: null,
    dateOfBirth: null,
    gender: null,
    timezone: "Europe/Berlin",
    onboardingCompletedAt: null,
    onboardingTourCompleted: true,
    onboardingTourProgress: null,
    avatarUrl: null,
    glucoseUnit: null,
    unitPreference: "metric",
    timeFormat: "AUTO",
    dateFormat: "AUTO",
    disableCoach: false,
    fullName: null,
    insurerName: null,
    insurerIkNumber: null,
    insuranceNumber: null,
    lastReportPracticeName: null,
    reportSelection: null,
    cycleTrackingEnabled: false,
    modules,
    moduleAvailability: {},
    ...overrides,
  };
}

import { ModulesSection } from "../modules-section";

function render(locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ModulesSection />
    </I18nProvider>,
  );
}

beforeEach(() => {
  lastMutation = null;
  mutateSpy.mockClear();
  invalidateSpy.mockClear();
  authSpy.mockImplementation(() => ({
    user: buildUser({}),
    isAuthenticated: true,
  }));
  coachSpy.mockImplementation(() => COACH_AVAILABLE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<ModulesSection>", () => {
  it("renders a live Switch for every toggleable module, including the delegated ones", () => {
    // v1.18.6 — the "Always on" core-domains card was removed (a domain
    // that can't be turned off doesn't need listing), so this section now
    // only renders the toggleable modules.
    const html = render();
    for (const key of MODULE_KEYS) {
      if (isCodeDisabledModule(key)) {
        // v1.25.3 — a module switched off in code (pending a rebuild) drops
        // out of the hub entirely: no Switch, no deep-link, no row.
        expect(html, `code-disabled has no switch ${key}`).not.toContain(
          `id="module-toggle-${key}"`,
        );
      } else {
        // Delegated modules (coach, cycle) now render a real Switch too — it
        // drives their canonical column — alongside a "manage" deep-link.
        expect(html, `toggleable switch ${key}`).toContain(
          `id="module-toggle-${key}"`,
        );
      }
    }
  });

  it("keeps a manage deep-link beside the delegated coach switch", () => {
    const html = render();
    // Coach → Coach settings. Coach is the only delegated module with more
    // to configure than on/off (cadence, memory) at a settings address.
    expect(html).toContain('href="/settings/coach"');
  });

  it("offers no Account deep-link beside the cycle switch", () => {
    // Cycle used to carry a second enable surface in Settings → Account,
    // and this link pointed at it. The switch here drives the same column,
    // so the Account card went and the link with it — a deep-link to an
    // anchor nothing renders is a door into a wall.
    const html = render();
    expect(html).not.toContain("/settings/account#cycle-tracking");
  });

  it("no longer renders the 'Always on' core-domains card", () => {
    // v1.18.6 — the read-only core card (weight / BP / pulse) was
    // removed; the core domains are always active regardless.
    const html = render();
    for (const key of ["weight", "bloodPressure", "pulse"]) {
      expect(html, `core ${key} not rendered`).not.toContain(
        `id="module-toggle-${key}"`,
      );
    }
  });

  it("seeds an enabled module checked (default-on) and a disabled one unchecked", () => {
    authSpy.mockImplementation(() => ({
      user: buildUser({ sleep: false }),
      isAuthenticated: true,
    }));
    const html = render();

    // The disabled `sleep` toggle surfaces data-state="unchecked".
    const sleepTag = html.match(
      /<button[^>]*id="module-toggle-sleep"[^>]*>/,
    )?.[0];
    expect(sleepTag).toBeDefined();
    expect(sleepTag).toMatch(/data-state="unchecked"/);

    // An absent key (`mood`) reads as enabled → checked.
    const moodTag = html.match(
      /<button[^>]*id="module-toggle-mood"[^>]*>/,
    )?.[0];
    expect(moodTag).toMatch(/data-state="checked"/);
  });

  it("PATCHes only the flipped key as a disabled-allowlist entry", async () => {
    render();
    expect(lastMutation?.mutationFn).toBeTypeOf("function");

    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { modules: {} } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await lastMutation!.mutationFn!({ key: "glucose", enabled: false });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/auth/me/modules");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ glucose: false });
  });

  it("invalidates the authMe query on a successful toggle", () => {
    render();
    expect(lastMutation?.onSuccess).toBeTypeOf("function");

    // onSuccess reads `variables.key` to decide the extra evictions; a
    // non-delegated key only touches authMe.
    lastMutation!.onSuccess!(undefined, { key: "glucose", enabled: false });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.authMe(),
    });
  });

  describe("delegated coach row", () => {
    it("reflects `!disableCoach`: checked when Coach is active, unchecked when hidden", () => {
      authSpy.mockImplementation(() => ({
        user: buildUser({}, { disableCoach: false }),
        isAuthenticated: true,
      }));
      let coachTag = render().match(
        /<button[^>]*id="module-toggle-coach"[^>]*>/,
      )?.[0];
      expect(coachTag).toMatch(/data-state="checked"/);

      authSpy.mockImplementation(() => ({
        user: buildUser({}, { disableCoach: true }),
        isAuthenticated: true,
      }));
      coachTag = render().match(
        /<button[^>]*id="module-toggle-coach"[^>]*>/,
      )?.[0];
      expect(coachTag).toMatch(/data-state="unchecked"/);
    });

    it("writes the inverted `disableCoach` to the canonical endpoint", async () => {
      render();
      const fetchSpy = vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { disableCoach: true } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      // Turning the hub switch OFF (enabled:false) writes disableCoach:true.
      await lastMutation!.mutationFn!({ key: "coach", enabled: false });

      const [url, init] = fetchSpy.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toContain("/api/auth/me/disable-coach");
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body as string)).toEqual({ disableCoach: true });
    });

    it("disables the switch + shows a hint when the operator killed Coach", () => {
      // Operator assistant master flag off → coach is unavailable server-wide.
      coachSpy.mockImplementation(() => ({
        available: false,
        reason: "operator_disabled",
        onDeviceAllowed: false,
      }));
      const html = render();
      const coachTag = html.match(
        /<button[^>]*id="module-toggle-coach"[^>]*>/,
      )?.[0];
      expect(coachTag).toMatch(/disabled/);
      expect(html).toContain("Disabled server-wide");
    });

    it("also disables the switch when the module-availability blob kills Coach", () => {
      authSpy.mockImplementation(() => ({
        user: buildUser({}, { moduleAvailability: { coach: false } }),
        isAuthenticated: true,
      }));
      const coachTag = render().match(
        /<button[^>]*id="module-toggle-coach"[^>]*>/,
      )?.[0];
      expect(coachTag).toMatch(/disabled/);
    });
  });

  describe("delegated cycle row", () => {
    it("reflects the resolved `cycleTrackingEnabled`", () => {
      authSpy.mockImplementation(() => ({
        user: buildUser({}, { cycleTrackingEnabled: true }),
        isAuthenticated: true,
      }));
      const cycleTag = render().match(
        /<button[^>]*id="module-toggle-cycle"[^>]*>/,
      )?.[0];
      expect(cycleTag).toMatch(/data-state="checked"/);
    });

    it("writes `{ enabled }` to the cycle-prefs endpoint", async () => {
      render();
      const fetchSpy = vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { enabled: true } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      await lastMutation!.mutationFn!({ key: "cycle", enabled: true });

      const [url, init] = fetchSpy.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toContain("/api/auth/me/cycle-prefs");
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
    });

    it("evicts cyclePrefs + cycle + authMe on a successful cycle toggle", () => {
      render();
      lastMutation!.onSuccess!(undefined, { key: "cycle", enabled: true });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: queryKeys.authMe(),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: queryKeys.cyclePrefs(),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: queryKeys.cycle(),
      });
    });

    it("disables the switch + shows a hint when the operator killed cycle", () => {
      authSpy.mockImplementation(() => ({
        user: buildUser({}, { moduleAvailability: { cycle: false } }),
        isAuthenticated: true,
      }));
      const html = render();
      const cycleTag = html.match(
        /<button[^>]*id="module-toggle-cycle"[^>]*>/,
      )?.[0];
      expect(cycleTag).toMatch(/disabled/);
      expect(html).toContain("Disabled server-wide");
    });
  });
});
