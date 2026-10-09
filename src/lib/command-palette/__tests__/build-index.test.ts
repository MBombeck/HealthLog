import { describe, expect, it } from "vitest";

import {
  buildPaletteIndex,
  type PaletteIndexInput,
} from "@/lib/command-palette/build-index";

const t = (key: string) => key;

function index(over: Partial<PaletteIndexInput> = {}) {
  return buildPaletteIndex({
    t,
    modules: {},
    navModules: {},
    inSharedRecord: false,
    sections: null,
    isAdmin: false,
    settingsListed: () => true,
    canCapture: true,
    moduleToggles: [
      { key: "mood", enabled: true },
      { key: "timeline", enabled: false },
    ],
    ...over,
  });
}

const ids = (entries: ReturnType<typeof index>) => entries.map((e) => e.id);

describe("buildPaletteIndex — modules", () => {
  it("a switched-off module takes its page, its Insights page and its cards along", () => {
    const off = { mood: false, timeline: false, environment: false };
    const entries = ids(index({ modules: off, navModules: off }));
    expect(entries).not.toContain("nav:/mood");
    expect(entries).not.toContain("nav:/timeline");
    expect(entries).not.toContain("insights:mood");
    expect(entries).not.toContain("settings:notifications#mood-reminder");
    expect(entries).not.toContain("settings:environment");
    expect(entries).not.toContain("settings:environment#home-location");
  });

  it("and they come back while it is on", () => {
    const on = { mood: true, timeline: true, environment: true };
    const entries = ids(index({ modules: on, navModules: on }));
    expect(entries).toContain("nav:/mood");
    expect(entries).toContain("nav:/timeline");
    expect(entries).toContain("insights:mood");
    expect(entries).toContain("insights:sleep");
    expect(entries).toContain("settings:notifications#mood-reminder");
    expect(entries).toContain("settings:environment#home-location");
  });

  it("a layout sub-page follows its module", () => {
    expect(ids(index({ modules: { labs: false } }))).not.toContain(
      "settings:layout/labs",
    );
    expect(ids(index({ modules: { labs: true } }))).toContain(
      "settings:layout/labs",
    );
  });

  it("the Coach page and action follow the capability folded into the nav map", () => {
    const without = ids(index({ navModules: { coach: false } }));
    expect(without).not.toContain("nav:/coach");
    expect(without).not.toContain("action:coach");
    const withIt = ids(index({ navModules: { coach: true } }));
    expect(withIt).toContain("nav:/coach");
    expect(withIt).toContain("action:coach");
  });

  it("offers the switches it is given, with their state", () => {
    const toggles = index().filter((e) => e.group === "modules");
    expect(toggles.map((e) => e.run)).toEqual([
      { kind: "module", module: "mood", enabled: true },
      { kind: "module", module: "timeline", enabled: false },
    ]);
  });
});

describe("buildPaletteIndex — admin", () => {
  it("lists the admin pages for an admin only", () => {
    expect(ids(index()).some((id) => id.startsWith("admin:"))).toBe(false);
    const admin = index({ isAdmin: true }).filter((e) =>
      e.id.startsWith("admin:"),
    );
    expect(admin.length).toBeGreaterThan(5);
    expect(admin[0]?.run).toEqual({
      kind: "href",
      href: `/admin/${admin[0]?.id.slice("admin:".length)}`,
    });
  });
});

describe("buildPaletteIndex — a shared record", () => {
  const shared = (over: Partial<PaletteIndexInput> = {}) =>
    index({
      inSharedRecord: true,
      isAdmin: true,
      moduleToggles: [],
      settingsListed: (slug) => slug === "anamnesis",
      ...over,
    });

  it("offers only the doors sharing opens", () => {
    const entries = ids(shared());
    expect(entries).toContain("nav:/");
    expect(entries).not.toContain("nav:/insights");
    expect(entries).not.toContain("nav:/coach");
    expect(entries).not.toContain("nav:/notifications");
    expect(entries.some((id) => id.startsWith("insights:"))).toBe(false);
  });

  it("never the account around it: no admin, no cards, no switches, no backup", () => {
    const entries = ids(shared());
    expect(entries.some((id) => id.startsWith("admin:"))).toBe(false);
    expect(entries.some((id) => id.includes("#"))).toBe(false);
    expect(entries.some((id) => id.startsWith("module:"))).toBe(false);
    expect(entries).not.toContain("action:backup");
    expect(entries).not.toContain("action:coach");
  });

  it("lists the Settings pages the record lists, and those only", () => {
    const settings = shared().filter((e) => e.group === "settings");
    expect(settings.map((e) => e.id)).toEqual(["settings:anamnesis"]);
  });

  it("drops the add action when the grant cannot write", () => {
    expect(ids(shared({ canCapture: false }))).not.toContain("action:capture");
  });
});

describe("buildPaletteIndex — links", () => {
  it("a card links to its section with its anchor", () => {
    const passkeys = index().find((e) => e.id === "settings:security#passkeys");
    expect(passkeys?.run).toEqual({
      kind: "href",
      href: "/settings/security#passkeys",
    });
    expect(passkeys?.hint).toBe("settings.sections.security.title");
  });

  it("every id is unique", () => {
    const all = ids(index({ isAdmin: true }));
    expect(new Set(all).size).toBe(all.length);
  });
});
