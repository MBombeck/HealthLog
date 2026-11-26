/**
 * The one notice about the server. On the dashboard it names the relay
 * question while that is open, so an admin who never opens the admin pages
 * still hears of it; on the admin start page it does not, because the
 * question itself stands there. An unfinished setup comes first on both.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

type Relay = {
  operatorDecision: "undecided" | "on" | "off";
  canDecide: boolean;
};
type Setup = {
  offered: boolean;
  completedAt: string | null;
  noticePending: boolean;
};

const state = vi.hoisted(() => ({
  role: "ADMIN" as "ADMIN" | "USER",
  relay: null as null | Relay,
  setup: undefined as undefined | Setup,
  enabled: [] as boolean[],
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: state.role, push: { relay: state.relay } },
  }),
}));
vi.mock("@/lib/queries/use-server-setup", () => ({
  useServerSetup: ({ enabled }: { enabled: boolean }) => {
    state.enabled.push(enabled);
    return { data: enabled ? state.setup : undefined };
  },
  useDismissServerSetupNotice: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ServerSetupNotice } from "../server-setup-notice";

const OPEN: Relay = { operatorDecision: "undecided", canDecide: true };
const FINISHED: Setup = {
  offered: true,
  completedAt: "2026-11-01T00:00:00.000Z",
  noticePending: true,
};

function render(
  surface: "admin" | "dashboard",
  {
    role = "ADMIN",
    relay = OPEN,
    setup = FINISHED,
  }: { role?: "ADMIN" | "USER"; relay?: Relay | null; setup?: Setup } = {},
) {
  state.role = role;
  state.relay = relay;
  state.setup = setup;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ServerSetupNotice surface={surface} />
    </I18nProvider>,
  );
}

describe("<ServerSetupNotice>", () => {
  it("names the open relay question on the dashboard and links to the admin start page", () => {
    const html = render("dashboard");
    expect(html).toContain('data-notice="relay"');
    expect(html).toContain("Use the HealthLog push relay?");
    expect(html).toContain('href="/admin"');
    expect(html).toContain("Not now");
  });

  it("leaves the relay to the question itself on the admin start page", () => {
    expect(render("admin")).toBe("");
  });

  it("offers an unfinished setup first, on both pages", () => {
    const setup = { ...FINISHED, completedAt: null };
    for (const surface of ["admin", "dashboard"] as const) {
      const html = render(surface, { setup });
      expect(html).toContain('data-notice="setup"');
      expect(html).toContain('href="/onboarding/server"');
    }
  });

  it("is quiet once answered, dismissed, on a demo, or for anyone else", () => {
    expect(
      render("dashboard", { relay: { ...OPEN, operatorDecision: "on" } }),
    ).toBe("");
    expect(
      render("dashboard", { relay: { ...OPEN, operatorDecision: "off" } }),
    ).toBe("");
    expect(render("dashboard", { relay: { ...OPEN, canDecide: false } })).toBe(
      "",
    );
    expect(
      render("dashboard", { setup: { ...FINISHED, noticePending: false } }),
    ).toBe("");
    expect(
      render("dashboard", { setup: { ...FINISHED, offered: false } }),
    ).toBe("");
    state.enabled.length = 0;
    expect(render("dashboard", { role: "USER" })).toBe("");
    // The admin-only route is never asked on someone else's behalf.
    expect(state.enabled).toEqual([false]);
  });
});
