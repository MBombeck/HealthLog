/**
 * `/settings/layout/<module>` is a real URL (a bookmark, the hub's own link,
 * a shared screenshot), so with its module off it answers in place with the
 * module notice, like every module page, rather than bouncing to the hub.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
}));
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));
const userRef: {
  value: {
    modules: Record<string, boolean>;
    moduleAccess?: Record<string, string>;
  };
} = { value: { modules: {} } };
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: userRef.value }),
}));

vi.mock("@/hooks/use-module-toggle", () => ({
  useModuleToggle: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { LayoutModuleGate } from "../layout-module-gate";

function render(moduleKey: "mood" | undefined) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <LayoutModuleGate moduleKey={moduleKey}>
        <p data-testid="section">section</p>
      </LayoutModuleGate>
    </I18nProvider>,
  );
}

describe("<LayoutModuleGate>", () => {
  it("renders the section while its module is on, and always for an unowned group", () => {
    userRef.value = { modules: { mood: true } };
    expect(render("mood")).toContain('data-testid="section"');
    userRef.value = { modules: { mood: false } };
    expect(render(undefined)).toContain('data-testid="section"');
  });

  it("answers in place with the module notice when its module is off, never redirecting", () => {
    userRef.value = {
      modules: { mood: false },
      moduleAccess: { mood: "disabled" },
    };
    const html = render("mood");
    expect(html).not.toContain('data-testid="section"');
    expect(html).toContain('data-slot="module-disabled-notice"');
    expect(html).toContain('data-module="mood"');
    expect(html).toContain('data-slot="module-off-turn-on"');
    expect(replace).not.toHaveBeenCalled();
  });
});
