import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

import { BOTH_PANELS_QUERY, listYields } from "../conversations-panel";
import { NewChatFab } from "../new-chat-fab";

/**
 * The Coach page holds two docked panels beside the conversation: the
 * conversations and, right of them, the day. Below 1600 px only one is open.
 * The list folds when a day opens or the window narrows with both open; it
 * never folds again right after the person opened it beside a day (that
 * folds the day instead). The click paths and focus run in
 * `e2e/coach-layout.spec.ts`.
 */
const base = {
  docked: true,
  fitsBoth: false,
  listOpen: true,
  dayOpen: true,
  dayOpened: false,
  narrowed: false,
};

describe("listYields", () => {
  it("folds the list when a day opens below 1600 px", () => {
    expect(listYields({ ...base, dayOpened: true })).toBe(true);
  });

  it("folds the list when the window narrows with both open", () => {
    expect(listYields({ ...base, narrowed: true })).toBe(true);
  });

  it("keeps both open from 1600 px", () => {
    expect(listYields({ ...base, fitsBoth: true, dayOpened: true })).toBe(
      false,
    );
  });

  it("leaves a list the person opened beside a day alone", () => {
    // No opening and no narrowing: the day is the one that gives way.
    expect(listYields(base)).toBe(false);
  });

  it("does nothing for a folded list, a closed day, or the sheet", () => {
    expect(listYields({ ...base, dayOpened: true, listOpen: false })).toBe(
      false,
    );
    expect(listYields({ ...base, narrowed: true, dayOpen: false })).toBe(false);
    expect(listYields({ ...base, dayOpened: true, docked: false })).toBe(false);
  });

  it("splits at 1600 px", () => {
    expect(BOTH_PANELS_QUERY).toBe("(min-width: 1600px)");
  });
});

describe("the folded list", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "src/components/insights/coach-panel/conversations-panel.tsx",
    ),
    "utf8",
  );

  it("slides to nothing, keeps its own strip, and sits left of the day", () => {
    expect(source).toContain('slot="coach-panel-strip"');
    expect(source).toContain("order={1}");
    expect(source).toContain('dockedOpen ? "w-72" : "w-0"');
    expect(source).toContain("DOCK_SLIDE");
    expect(source).toMatch(/order-1/);
  });

  it("no longer starts a conversation from the list's header", () => {
    expect(source).not.toContain("coach-panel-new-chat");
  });
});

describe("<NewChatFab>", () => {
  it("is the Coach button's round face with a plus, named New conversation", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <NewChatFab onNewChat={() => undefined} />
      </I18nProvider>,
    );
    const button = html.match(/<button[^>]*>/)?.[0] ?? "";
    expect(button).toContain('data-slot="coach-new-chat-fab"');
    expect(button).toContain('aria-label="New conversation"');
    expect(button).toContain("size-14");
    expect(button).toContain("rounded-full");
    expect(button).toContain("from-primary");
    // Above the composer by default, beside it where the column is wide.
    expect(button).toContain("bottom-full");
    expect(button).toContain("@min-[54rem]/composer:bottom-8");
    expect(html).toContain("lucide-plus");
  });
});

describe("coachPageHref", () => {
  it("keeps an open day when the conversation changes", async () => {
    const { coachPageHref } = await import("../coach-conversation");
    expect(coachPageHref("c1")).toBe("/coach?c=c1");
    expect(coachPageHref(null)).toBe("/coach");
    expect(coachPageHref("c1", "?c=c0&day=2026-09-24")).toBe(
      "/coach?c=c1&day=2026-09-24",
    );
    expect(coachPageHref(null, "?day=2026-09-24&c=c0")).toBe(
      "/coach?day=2026-09-24",
    );
  });
});
