/**
 * The one direct-URL gate for module pages: top-level pages and Insights
 * sub-pages answer through the surface map, render the inline notice worded
 * from `moduleAccess`, and never redirect.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const pathRef = { value: "/" };
vi.mock("next/navigation", () => ({
  usePathname: () => pathRef.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

type MockUser = {
  modules: Record<string, boolean>;
  moduleAccess?: Record<string, string>;
};
const userRef: { value: MockUser | null } = { value: { modules: {} } };
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: userRef.value, isAuthenticated: true }),
}));

vi.mock("@/hooks/use-module-toggle", () => ({
  useModuleToggle: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ModulePageGate, moduleOwningPath } from "../module-page-gate";

function render(pathname: string, user: MockUser) {
  pathRef.value = pathname;
  userRef.value = user;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ModulePageGate>
        <p data-testid="page">page</p>
      </ModulePageGate>
    </I18nProvider>,
  );
}

describe("moduleOwningPath", () => {
  it.each([
    ["/mood", "mood"],
    ["/labs/123", "labs"],
    ["/insights/mood", "mood"],
    ["/insights/workouts/abc", "workouts"],
    ["/insights/blood-glucose", "glucose"],
    ["/insights/medications", "medications"],
    ["/insights/recovery", "recovery"],
    ["/insights/six-minute-walk", "recovery"],
    ["/insights/breathing-disturbances", "sleep"],
  ])("%s belongs to %s", (path, owner) => {
    expect(moduleOwningPath(path)).toBe(owner);
  });

  it.each([
    "/",
    "/measurements",
    "/insights",
    "/insights/weight",
    "/care",
    "/coach/plans",
    "/coach/conversations",
  ])("%s belongs to no module", (path) => {
    expect(moduleOwningPath(path)).toBeUndefined();
  });
});

describe("<ModulePageGate>", () => {
  it("renders the page while its module is on", () => {
    const html = render("/insights/mood", { modules: { mood: true } });
    expect(html).toContain('data-testid="page"');
    expect(html).not.toContain("module-disabled-notice");
  });

  it("keeps the Insights area with AI analysis off", () => {
    const html = render("/insights", { modules: { insights: false } });
    expect(html).toContain('data-testid="page"');
  });

  it("replaces an Insights sub-page with the notice, Settings link included, when the record switched it off", () => {
    const html = render("/insights/mood", {
      modules: { mood: false },
      moduleAccess: { mood: "disabled" },
    });
    expect(html).not.toContain('data-testid="page"');
    expect(html).toContain('data-slot="module-disabled-notice"');
    expect(html).toContain('data-module="mood"');
    expect(html).toContain('data-module-access="disabled"');
    expect(html).toContain('data-slot="module-off-turn-on"');
  });

  it("offers no Settings link when the operator switched the module off", () => {
    const html = render("/insights/sleep", {
      modules: { sleep: false },
      moduleAccess: { sleep: "unavailable" },
    });
    expect(html).toContain('data-module-access="unavailable"');
    expect(html).not.toContain("module-off-turn-on");
  });

  it("covers a sub-page no nav entry names (medications)", () => {
    const html = render("/insights/medications", {
      modules: { medications: false },
    });
    expect(html).toContain('data-module="medications"');
  });

  // Stored plans and conversations are the person's own records: their pages
  // turn read-only with the Coach unavailable instead of being replaced.
  describe.each(["/coach/plans", "/coach/conversations"])("%s", (path) => {
    it.each([
      ["operator switched the Coach off", "unavailable"],
      ["the person hid the Coach", "disabled"],
    ])("stays reachable when %s", (_label, access) => {
      const html = render(path, {
        modules: { coach: false },
        moduleAccess: { coach: access },
      });
      expect(html).toContain('data-testid="page"');
      expect(html).not.toContain("module-disabled-notice");
    });
  });

  it("still replaces the Coach page itself when the Coach is off", () => {
    const html = render("/coach", {
      modules: { coach: false },
      moduleAccess: { coach: "unavailable" },
    });
    expect(html).not.toContain('data-testid="page"');
    expect(html).toContain('data-module="coach"');
  });
});
