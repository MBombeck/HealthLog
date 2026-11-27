/**
 * The one notice about the server, on the admin start page: an unfinished
 * setup, offered until the admin sets it aside. The relay question stands on
 * that page itself, and the dashboard asks both in its ask card (the digest's
 * `asks`, pinned in `asks.test.ts`), so the notice never names the relay.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

type Setup = {
  offered: boolean;
  completedAt: string | null;
  noticePending: boolean;
};

const state = vi.hoisted(() => ({
  role: "ADMIN" as "ADMIN" | "USER",
  setup: undefined as undefined | Setup,
  enabled: [] as boolean[],
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      role: state.role,
      push: { relay: { operatorDecision: "undecided", canDecide: true } },
    },
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

const UNFINISHED: Setup = {
  offered: true,
  completedAt: null,
  noticePending: true,
};

function render({
  role = "ADMIN",
  setup = UNFINISHED,
}: { role?: "ADMIN" | "USER"; setup?: Setup } = {}) {
  state.role = role;
  state.setup = setup;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ServerSetupNotice />
    </I18nProvider>,
  );
}

describe("<ServerSetupNotice>", () => {
  it("offers an unfinished setup, with a way to set it aside", () => {
    const html = render();
    expect(html).toContain('data-notice="setup"');
    expect(html).toContain('href="/onboarding/server"');
    expect(html).toContain("Not now");
  });

  it("leaves an open relay question to the question itself", () => {
    expect(
      render({
        setup: { ...UNFINISHED, completedAt: "2026-11-01T00:00:00.000Z" },
      }),
    ).toBe("");
  });

  it("is quiet once dismissed, on a demo, or for anyone else", () => {
    expect(render({ setup: { ...UNFINISHED, noticePending: false } })).toBe("");
    expect(render({ setup: { ...UNFINISHED, offered: false } })).toBe("");
    state.enabled.length = 0;
    expect(render({ role: "USER" })).toBe("");
    // The admin-only route is never asked on someone else's behalf.
    expect(state.enabled).toEqual([false]);
  });
});
