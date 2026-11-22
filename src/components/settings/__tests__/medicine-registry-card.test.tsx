/**
 * #1430 — Settings → Medications: the medicine registry select. SSR pins the
 * options (NONE plus the twelve registries, named in the interface language)
 * and the selected value; the write contract is asserted against the source,
 * because nothing here can dispatch a change event.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { readSource } from "@/__tests__/helpers/source-files";

const state = vi.hoisted(() => ({ registry: "PL" }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { medicineRegistry: state.registry },
    isAuthenticated: true,
  }),
}));

import { MedicineRegistryCard } from "../medicine-registry-card";

function render(locale: "en" | "de"): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale={locale}>
        <MedicineRegistryCard isAuthenticated />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("MedicineRegistryCard", () => {
  it("lists None and every registry, with the stored one selected", () => {
    const html = render("en");
    const values = [...html.matchAll(/<option value="([A-Z]+)"/g)].map(
      (m) => m[1],
    );
    expect(values[0]).toBe("NONE");
    expect([...values].sort()).toEqual([
      "AU",
      "BE",
      "BR",
      "CA",
      "DE",
      "ES",
      "EU",
      "FR",
      "GB",
      "NL",
      "NONE",
      "PL",
      "US",
    ]);
    expect(html).toMatch(/<option value="PL" selected="">Poland \(Rejestr/);
    expect(html).toContain('id="medicine-registry"');
  });

  it("names the countries in the interface language", () => {
    expect(render("de")).toContain("Polen (Rejestr Produktów Leczniczych)");
  });

  it("writes through the registry route and refreshes the account and medications", () => {
    const source = readSource(
      "src/components/settings/medicine-registry-card.tsx",
      ["function MedicineRegistryCard("],
    );
    expect(source).toContain('"/api/auth/me/medicine-registry"');
    expect(source).toContain('method: "PATCH"');
    expect(source).toContain("JSON.stringify({ medicineRegistry: next })");
    expect(source).toContain("queryKeys.authMe()");
    expect(source).toContain("queryKeys.medications()");
  });
});
