/**
 * v1.25.11 (#148) — the shared Appearance group registry.
 *
 * `layout-groups` is the single source of truth consumed by BOTH the client
 * hub (`layout-section.tsx`) and the server subpage route
 * (`app/settings/layout/[module]/page.tsx`, via `LAYOUT_GROUP_IDS` in
 * `generateStaticParams()`). These tests pin the param → section mapping: the
 * id list (the statically-generated subpage params), the guard, the per-module
 * gate expectations, and that each group resolves a distinct section body.
 */
import { describe, expect, it, vi } from "vitest";

// Stub the section components at the import boundary — each has its own test;
// here we only assert the registry's metadata + identity mapping, and we keep
// the heavy section trees out of the unit import graph.
vi.mock("../dashboard-section", () => ({ DashboardSection: () => null }));
vi.mock("../insights-section", () => ({ InsightsSection: () => null }));
vi.mock("../medications-section", () => ({ MedicationsSection: () => null }));
vi.mock("../mood-section", () => ({ MoodSection: () => null }));
vi.mock("../labs-section", () => ({ LabsSection: () => null }));
vi.mock("../illness-section", () => ({ IllnessSection: () => null }));
vi.mock("../vorsorge-section", () => ({ VorsorgeSection: () => null }));

import {
  LAYOUT_GROUPS,
  LAYOUT_GROUP_IDS,
  isLayoutGroupId,
  layoutGroupModule,
} from "../layout-groups";

describe("layout-groups registry", () => {
  it("exposes the eight Appearance modules as statically-generated subpage params", () => {
    expect(LAYOUT_GROUP_IDS).toEqual([
      "dashboard",
      "insights",
      "medications",
      "mood",
      "labs",
      "illness",
      "documents",
      "vorsorge",
    ]);
    // generateStaticParams() shape.
    expect(LAYOUT_GROUP_IDS.map((module) => ({ module }))).toEqual([
      { module: "dashboard" },
      { module: "insights" },
      { module: "medications" },
      { module: "mood" },
      { module: "labs" },
      { module: "illness" },
      { module: "documents" },
      { module: "vorsorge" },
    ]);
  });

  it("guards unknown segments", () => {
    expect(isLayoutGroupId("medications")).toBe(true);
    expect(isLayoutGroupId("vorsorge")).toBe(true);
    expect(isLayoutGroupId("nope")).toBe(false);
    expect(isLayoutGroupId("")).toBe(false);
  });

  it("gates the toggleable tracking modules and leaves the rest always-on", () => {
    const gate = (id: string) =>
      LAYOUT_GROUPS.some((group) => group.id === id)
        ? layoutGroupModule(id)
        : "not-a-group";
    expect(gate("medications")).toBe("medications");
    expect(gate("mood")).toBe("mood");
    expect(gate("labs")).toBe("labs");
    expect(gate("illness")).toBe("illness");
    // dashboard / insights / vorsorge are never gated.
    expect(gate("dashboard")).toBeUndefined();
    expect(gate("insights")).toBeUndefined();
    expect(gate("vorsorge")).toBeUndefined();
  });

  it("maps every id to a distinct section body and the canonical i18n keys", () => {
    const bodies = new Set(LAYOUT_GROUPS.map((group) => group.Body));
    expect(bodies.size).toBe(LAYOUT_GROUPS.length);
    for (const group of LAYOUT_GROUPS) {
      expect(group.titleKey).toBe(`settings.sections.layout.${group.id}.title`);
      expect(group.descriptionKey).toBe(
        `settings.sections.layout.${group.id}.description`,
      );
    }
  });
});
