/**
 * #1430 — the leaflet surfaces on the web: the detail section ("Find
 * leaflet", the saved "Official leaflet", the disclaimer) and the two items
 * on the medication card's menu. SSR, like the other medication sections:
 * the markup pins the hrefs, `target`, `rel` and the stable data attributes.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import {
  buildLeafletSearch,
  type MedicineRegistryChoice,
} from "@/lib/medications/leaflet-registries";

const state = vi.hoisted(() => ({
  registry: "PL" as string,
  canManage: true,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { medicineRegistry: state.registry },
    isAuthenticated: true,
  }),
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canManageDomain: () => state.canManage,
    inSharedRecord: false,
  }),
}));

// The menu's content only mounts when open; render it flat so the items can
// be read from the markup.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-slot="medication-card-menu">{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { MedicationLeafletSection } from "@/components/medications/detail/medication-leaflet-section";
import { MedicationCardMenu } from "@/components/medications/medication-card-menu";

const SAVED =
  "https://rejestry.ezdrowie.gov.pl/api/rpl/medicinal-products/1/leaflet";

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

function anchor(html: string, slot: string): string {
  const match = new RegExp(`<a[^>]*data-slot="${slot}"[^>]*>`).exec(html);
  expect(match, `no <a data-slot="${slot}">`).not.toBeNull();
  return match![0];
}

beforeEach(() => {
  state.registry = "PL";
  state.canManage = true;
});

describe("MedicationLeafletSection", () => {
  const medication = {
    id: "med-1",
    name: "Ramipril",
    dose: "5mg",
    leafletUrl: null,
  };

  it("opens the server-built registry search in a new tab", () => {
    const search = buildLeafletSearch("AU", medication);
    const html = render(
      <MedicationLeafletSection
        medication={{ ...medication, leafletSearch: search }}
      />,
    );
    const link = anchor(html, "medication-leaflet-find-link");
    expect(link).toContain(
      'href="https://www.tga.gov.au/resources/artg?keywords=Ramipril%205%20mg"',
    );
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(link).toContain('data-registry="AU"');
    expect(link).toContain('data-prefill="nameAndStrength"');
    expect(html).toContain('data-slot="medication-leaflet-disclaimer"');
    expect(html).toContain("national medicine registry");
  });

  it("builds the same link from the account when the read did not carry one", () => {
    const html = render(<MedicationLeafletSection medication={medication} />);
    const link = anchor(html, "medication-leaflet-find-link");
    expect(link).toContain(
      'href="https://rejestry.ezdrowie.gov.pl/rpl/search?name=Ramipril"',
    );
  });

  it("asks the person to search on a registry that takes nothing from the address", () => {
    const html = render(
      <MedicationLeafletSection
        medication={{
          ...medication,
          leafletSearch: buildLeafletSearch("DE", medication),
        }}
      />,
    );
    expect(anchor(html, "medication-leaflet-find-link")).toContain(
      'href="https://portal.bfarm.de/amguifree/"',
    );
    expect(html).toContain('data-slot="medication-leaflet-search-hint"');
    expect(html).toContain("Ramipril");
    expect(html).toContain("BfArM AMIce");
  });

  it("offers the registry setting instead of a search when none is chosen", () => {
    const html = render(
      <MedicationLeafletSection
        medication={{ ...medication, leafletSearch: null }}
      />,
    );
    expect(html).not.toContain("medication-leaflet-find-link");
    expect(html).toContain('data-slot="medication-leaflet-no-registry"');
    expect(html).toContain('href="/settings/medications#medicine-registry"');
  });

  it("shows the saved leaflet as an external link only", () => {
    const html = render(
      <MedicationLeafletSection
        medication={{ ...medication, leafletUrl: SAVED, leafletSearch: null }}
      />,
    );
    const link = anchor(html, "medication-leaflet-saved-link");
    expect(link).toContain(`href="${SAVED}"`);
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Official leaflet");
    expect(html).not.toMatch(/<iframe|<embed|<object/);
    expect(html).toContain('data-slot="medication-leaflet-edit"');
    expect(html).toContain('data-slot="medication-leaflet-remove"');
  });

  it("keeps the saved link readable but not editable without manage access", () => {
    state.canManage = false;
    const html = render(
      <MedicationLeafletSection
        medication={{ ...medication, leafletUrl: SAVED, leafletSearch: null }}
      />,
    );
    expect(html).toContain('data-slot="medication-leaflet-saved-link"');
    expect(html).not.toContain('data-slot="medication-leaflet-edit"');
    expect(html).not.toContain('data-slot="medication-leaflet-remove"');
  });
});

describe("MedicationCardMenu leaflet items", () => {
  function menu(registry: MedicineRegistryChoice, leafletUrl: string | null) {
    state.registry = registry;
    return render(
      <MedicationCardMenu
        onEdit={() => {}}
        onOpenHistory={() => {}}
        leaflet={{ name: "Ramipril", dose: "5mg", leafletUrl }}
      />,
    );
  }

  it("offers the saved leaflet and the registry search, both in a new tab", () => {
    const html = menu("US", SAVED);
    const saved = anchor(html, "medication-card-menu-leaflet-saved");
    expect(saved).toContain(`href="${SAVED}"`);
    expect(saved).toContain('rel="noopener noreferrer"');
    const find = anchor(html, "medication-card-menu-leaflet-find");
    expect(find).toContain(
      'href="https://dailymed.nlm.nih.gov/dailymed/search.cfm?labeltype=all&amp;query=Ramipril"',
    );
    expect(find).toContain('target="_blank"');
  });

  it("offers neither without a saved link or a registry", () => {
    const html = menu("NONE", null);
    expect(html).not.toContain("medication-card-menu-leaflet-saved");
    expect(html).not.toContain("medication-card-menu-leaflet-find");
  });
});
