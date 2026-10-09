/**
 * Settings → Data & privacy: "What's stored" is read off the module registry,
 * so every module that keeps records is named and a new one joins the list
 * without an edit here.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: true, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/components/settings/security-sessions-card", () => ({
  SecuritySessionsCard: () => null,
}));
vi.mock("@/components/settings/security-activity-card", () => ({
  SecurityActivityCard: () => null,
}));
vi.mock("@/components/settings/trusted-devices-card", () => ({
  TrustedDevicesCard: () => null,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MODULE_KEYS, MODULE_REGISTRY } from "@/lib/modules/registry";
import { PrivacySection, storedModuleLabelKeys } from "../privacy-section";

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <PrivacySection />
    </I18nProvider>,
  );
}

describe("Data & privacy — what's stored", () => {
  it("names every module that keeps records", () => {
    const keys = storedModuleLabelKeys();
    for (const key of MODULE_KEYS) {
      const { category, labelKey } = MODULE_REGISTRY[key];
      const holdsRecords = category !== "export" && category !== "integration";
      expect(keys.includes(labelKey), key).toBe(holdsRecords);
    }
  });

  it("lists documents, vaccinations, the cycle and workouts on the page", () => {
    const html = render();
    const row = html.match(/data-slot="privacy-stored-modules"[^>]*>([^<]*)</);
    expect(row).not.toBeNull();
    for (const label of ["Documents", "Vaccinations", "Workouts"]) {
      expect(row![1]).toContain(label);
    }
    expect(row![1]).toMatch(/Cycle/);
    expect(row![1]).not.toContain("Doctor report");
  });
});
