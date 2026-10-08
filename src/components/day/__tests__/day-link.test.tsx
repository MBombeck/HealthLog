import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import enMessages from "../../../../messages/en.json";

/**
 * A date that opens its day, and the dates that must not: a future day has
 * nothing to show, so it stays plain text.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/labs" }));
vi.mock("../use-today-key", () => ({ useTodayKey: () => "2026-10-08" }));

beforeEach(() => {
  vi.resetModules();
});

async function render(
  node: (m: typeof import("../day-link")) => React.ReactNode,
) {
  const { I18nProvider } = await import("@/lib/i18n/context");
  const mod = await import("../day-link");
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en" initialMessages={enMessages}>
      {node(mod)}
    </I18nProvider>,
  );
}

describe("<DayLink>", () => {
  it("links a past day to ?day= on the current page", async () => {
    const html = await render(({ DayLink }) => (
      <DayLink date="2025-12-12">12 Dec 2025</DayLink>
    ));
    expect(html).toContain('data-slot="day-link"');
    expect(html).toContain('href="/labs?day=2025-12-12"');
    expect(html).toContain('data-day="2025-12-12"');
  });

  it("leaves a future day as plain text", async () => {
    const html = await render(({ DayLink }) => (
      <DayLink date="2026-10-09">tomorrow</DayLink>
    ));
    expect(html).not.toContain('data-slot="day-link"');
    expect(html).toContain('data-slot="day-link-plain"');
  });

  it("reads a stated date as its calendar day in every zone", async () => {
    const html = await render(({ DayLinkStated }) => (
      <>
        <DayLinkStated at="2025-12-12T12:00:00.000Z">a</DayLinkStated>
        <DayLinkStated at="2025-06-03">b</DayLinkStated>
      </>
    ));
    expect(html).toContain('data-day="2025-12-12"');
    expect(html).toContain('data-day="2025-06-03"');
  });

  it("puts a link where a sentence names its date", async () => {
    const html = await render(({ DAY_LINK_SLOT, DayLink, withDayLinkSlot }) =>
      withDayLinkSlot(
        `Started on ${DAY_LINK_SLOT} at home`,
        <DayLink date="2025-12-31">31 Dec</DayLink>,
      ),
    );
    expect(html).toMatch(/^Started on <a [^>]*>31 Dec<\/a> at home$/);
  });
});
