import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachDrawerBody } from "../coach-drawer-body";

/**
 * v1.4.20 phase B4 — Coach drawer mobile rail trays.
 *
 * The drawer hides the history + sources rails on `<lg`. B4 adds two
 * chevron-button triggers along the edges of the message thread that
 * open side-sheets surfacing the same rails.
 *
 * Phase D reconcile narrowed the lg drawer cap (was 1080px → now
 * min(960px,75vw)) so the inline sources rail no longer fits below
 * xl. The history rail surfaces inline on lg; the sources rail
 * surfaces inline on xl. Mobile chevron triggers cover the missing
 * rails: history hidden on lg+, sources hidden on xl+.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const baseProps = {
  historyRail: <span>history</span>,
  sourcesRail: <span>sources</span>,
  thread: <span>thread</span>,
  composer: <span>composer</span>,
  onOpenHistoryTray: () => undefined,
  onOpenSourcesTray: () => undefined,
};

describe("<CoachDrawerBody> — mobile rail trays", () => {
  it("renders both tray triggers", () => {
    const html = render(<CoachDrawerBody {...baseProps} />);
    expect(html).toMatch(/data-slot="coach-drawer-history-tray-trigger"/);
    expect(html).toMatch(/data-slot="coach-drawer-sources-tray-trigger"/);
  });

  it("hides the history trigger on >=lg and the sources trigger on >=xl", () => {
    // v1.4.27 R3d MB2 — the strip wrapper carries `xl:hidden` so the
    // sources trigger inherits the breakpoint; the history trigger
    // keeps its own `lg:hidden` because the history rail mounts
    // inline already on lg+ while the sources rail still needs the
    // chevron until xl.
    const html = render(<CoachDrawerBody {...baseProps} />);
    const strip = html.match(
      /<div[^>]*data-slot="coach-drawer-rail-tray-strip"[^>]*>/,
    );
    expect(strip?.[0]).toContain("xl:hidden");

    const historyTrigger = html.match(
      /<button[^>]*data-slot="coach-drawer-history-tray-trigger"[^>]*>/,
    );
    expect(historyTrigger).not.toBeNull();
    expect(historyTrigger?.[0]).toContain("lg:hidden");
  });

  it("renders the desktop history rail (lg+) and sources rail (xl+)", () => {
    const html = render(<CoachDrawerBody {...baseProps} />);
    expect(html).toMatch(
      /<aside[^>]*data-slot="coach-drawer-history"[^>]*lg:flex/,
    );
    expect(html).toMatch(
      /<aside[^>]*data-slot="coach-drawer-sources"[^>]*xl:flex/,
    );
  });

  it("renders the message thread + composer slots", () => {
    const html = render(<CoachDrawerBody {...baseProps} />);
    expect(html).toMatch(/data-slot="coach-drawer-thread"/);
    expect(html).toMatch(/data-slot="coach-drawer-composer"/);
    // Slot content forwarded verbatim.
    expect(html).toContain("thread");
    expect(html).toContain("composer");
  });

  it("uses chevron-style trigger labels — History on the left, Sources on the right", () => {
    const html = render(<CoachDrawerBody {...baseProps} />);
    const historyTrigger = html.match(
      /<button[^>]*data-slot="coach-drawer-history-tray-trigger"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(historyTrigger).not.toBeNull();
    expect(historyTrigger?.[0]).toContain("Conversations");

    const sourcesTrigger = html.match(
      /<button[^>]*data-slot="coach-drawer-sources-tray-trigger"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(sourcesTrigger).not.toBeNull();
    expect(sourcesTrigger?.[0]).toContain("What I can see");
  });

  it("renders the German trigger labels in the de locale", () => {
    const html = render(<CoachDrawerBody {...baseProps} />, "de");
    expect(html).toContain("Unterhaltungen");
    expect(html).toContain("Worauf ich zugreife");
  });

  it("renders the rail triggers in a sub-header strip above the thread", () => {
    // v1.4.27 R3d MB2 — the triggers were lifted out of the absolute
    // overlay into a sub-header strip so the chevrons sit at a 44 px
    // tap target and never overlay the first message bubble. The
    // strip lives above the thread within the centre column.
    const html = render(<CoachDrawerBody {...baseProps} />);
    expect(html).toMatch(/data-slot="coach-drawer-rail-tray-strip"/);
    const trigger = html.match(
      /<button[^>]*data-slot="coach-drawer-history-tray-trigger"[^>]*>/,
    );
    expect(trigger?.[0]).toContain("min-h-11");
  });
});
