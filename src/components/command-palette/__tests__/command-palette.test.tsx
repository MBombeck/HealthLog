import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity, Moon, Plus, Smile } from "lucide-react";

import { I18nProvider } from "@/lib/i18n/context";
import type { PaletteEntry } from "@/lib/command-palette/build-index";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
vi.mock("@/hooks/use-module-toggle", () => ({
  useModuleToggle: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/lib/insights/coach-launch-context", () => ({
  useCoachLaunch: () => null,
}));
vi.mock("@/components/day/use-today-key", () => ({
  useTodayKey: () => "2026-10-09",
}));

const ENTRIES: PaletteEntry[] = [
  {
    id: "insights:sleep",
    group: "insights",
    title: "Sleep",
    hint: "Insights",
    keywords: ["schlaf"],
    icon: Moon,
    run: { kind: "href", href: "/insights/sleep" },
  },
  {
    id: "nav:/measurements",
    group: "pages",
    title: "Measurements",
    keywords: [],
    icon: Activity,
    run: { kind: "href", href: "/measurements" },
  },
  {
    id: "module:mood",
    group: "modules",
    title: "Mood",
    keywords: [],
    icon: Smile,
    run: { kind: "module", module: "mood", enabled: true },
  },
  {
    id: "action:capture",
    group: "actions",
    title: "New entry",
    keywords: [],
    icon: Plus,
    run: { kind: "action", action: "capture" },
  },
  {
    id: "action:today",
    group: "actions",
    title: "Open today",
    keywords: [],
    icon: Plus,
    run: { kind: "action", action: "today" },
  },
];

vi.mock("../use-palette-index", () => ({
  usePaletteIndex: () => ENTRIES,
}));

import { PaletteBody, arrangeResults } from "../command-palette";

function render(isMobile = false) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <PaletteBody isMobile={isMobile} />
    </I18nProvider>,
  );
}

describe("arrangeResults", () => {
  it("empty query: recent places first, then the main actions", () => {
    const sections = arrangeResults("", ENTRIES, ["insights:sleep", "gone"]);
    expect(sections.map((s) => s.group)).toEqual(["recent", "actions"]);
    expect(sections[0]?.entries.map((e) => e.id)).toEqual(["insights:sleep"]);
    expect(sections[1]?.entries.map((e) => e.id)).toEqual([
      "action:capture",
      "action:today",
    ]);
  });

  it("a query groups the hits in the order of each group's best hit", () => {
    const sections = arrangeResults("schlaf", ENTRIES, []);
    expect(sections.map((s) => s.group)).toEqual(["insights"]);
    // "mo": Mood is a prefix (modules), Measurements no match; "o" in
    // "Open today" is a word start (actions) and ranks below the prefix.
    const mixed = arrangeResults("mo", ENTRIES, []);
    expect(mixed.map((s) => s.group)).toEqual(["modules"]);
    const both = arrangeResults("o", ENTRIES, []);
    expect(both[0]?.entries[0]?.title).toBe("Open today");
  });

  it("no hit, no sections", () => {
    expect(arrangeResults("zzzz", ENTRIES, [])).toEqual([]);
  });
});

describe("<PaletteBody>", () => {
  it("is a combobox that controls a listbox and points at the first option", () => {
    const html = render();
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}" role="listbox"`);
    const active = html.match(/aria-activedescendant="([^"]+)"/)?.[1];
    expect(html).toContain(`id="${active}" role="option" aria-selected="true"`);
  });

  it("labels its groups and the field", () => {
    const html = render();
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Search"');
    expect(html).toContain('placeholder="Search pages, settings, modules…"');
    expect(html).toContain(">Actions<");
  });

  it("shows the key hints on a desktop and a Cancel button on a phone", () => {
    expect(render(false)).toContain("Esc");
    const phone = render(true);
    expect(phone).not.toContain(">Esc<");
    expect(phone).toContain(">Cancel<");
  });
});
