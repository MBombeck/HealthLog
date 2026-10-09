import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachHero } from "../coach-hero";
import { splitProseSegments } from "../streamed-prose";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<CoachHero>", () => {
  it("renders the centred greeting and the composer slot", () => {
    const html = render(
      <CoachHero composer={<div data-slot="test-composer">composer</div>} />,
    );
    expect(html).toContain('data-slot="coach-hero"');
    // Greeting copy from insights.coach.heroGreeting — one line now.
    expect(html).toContain("Ask me anything about your data");
    // The earlier two-line subline was dropped.
    expect(html).not.toContain("Ask about your trends, medications");
    // The composer is re-parented into the hero, not forked.
    expect(html).toContain('data-slot="coach-hero-composer"');
    expect(html).toContain('data-slot="test-composer"');
  });

  it("renders the German greeting under the de locale", () => {
    const html = render(<CoachHero composer={null} />, "de");
    expect(html).toContain("Frage mich etwas zu deinen Daten");
  });

  it("leaves nothing under the composer", () => {
    // No starter chips, no seeded opener, no scope pill: the empty
    // conversation is the greeting and the field.
    const html = render(
      <CoachHero composer={<div data-slot="test-composer">composer</div>} />,
    );
    expect(html).not.toContain('data-slot="coach-hero-chips"');
    expect(html).not.toContain('data-slot="coach-hero-scope-hint"');
    expect(html).not.toContain("coach-scope-hint");
    const afterComposer = html.split('data-slot="test-composer"')[1] ?? "";
    expect(afterComposer.replace(/<\/div>|composer|>/g, "")).toBe("");
  });
});

describe("splitProseSegments", () => {
  it("splits prose into word+trailing-space segments", () => {
    expect(splitProseSegments("Looking at your data")).toEqual([
      "Looking ",
      "at ",
      "your ",
      "data",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(splitProseSegments("")).toEqual([]);
  });

  it("keeps a single whitespace-free token intact", () => {
    expect(splitProseSegments("Drafting…")).toEqual(["Drafting…"]);
  });
});
