/**
 * The overview's setup hint closes with an icon button in its header. On a
 * phone it is the only control on the tile a thumb has to hit, so it carries
 * the 44 px floor every other mobile action does (`size-11`), stepping down
 * from `sm` like the rest of the app.
 *
 * The hint is also an invitation, so it stays away from a person who switched
 * both the Coach and AI analysis off.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  modules: {} as Record<string, boolean>,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", modules: auth.modules },
    isAuthenticated: true,
  }),
}));
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiProviderState: () => ({
    configured: false,
    managedBy: null,
    canConfigure: true,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { AiSetupHint } from "../ai-setup-hint";

function render(surface: "insights" | "settings" = "insights"): string {
  vi.stubGlobal("window", {
    localStorage: { getItem: () => null, setItem: () => undefined },
  });
  const html = renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AiSetupHint surface={surface} />
    </I18nProvider>,
  );
  vi.unstubAllGlobals();
  return html;
}

function dismissButton(): string {
  const html = render();
  const match = html.match(
    /<button[^>]*data-slot="ai-setup-hint-dismiss"[^>]*>/,
  );
  expect(match).not.toBeNull();
  return match![0];
}

describe("the setup hint's dismiss button", () => {
  it("is at least 44 px on a phone", () => {
    const button = dismissButton();
    const cls = button.match(/class="([^"]*)"/)![1]!.split(/\s+/);
    expect(cls).toContain("size-11");
  });
});

describe("the setup hint after an opt-out", () => {
  afterEach(() => {
    auth.modules = {};
  });

  it("is gone on both surfaces once the Coach and AI analysis are off", () => {
    auth.modules = { coach: false, insights: false };
    expect(render("insights")).not.toContain('data-slot="ai-setup-hint"');
    expect(render("settings")).not.toContain('data-slot="ai-setup-hint"');
  });

  it("stays while either one is still on", () => {
    auth.modules = { coach: false, insights: true };
    expect(render("insights")).toContain('data-slot="ai-setup-hint"');
    auth.modules = { coach: true, insights: false };
    expect(render("settings")).toContain('data-slot="ai-setup-hint"');
  });
});
