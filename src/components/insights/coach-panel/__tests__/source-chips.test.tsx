import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { SourceChips } from "../source-chips";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

function classesForSlot(html: string, slot: string): string[] {
  const elements =
    html.match(new RegExp(`<[^>]+data-slot="${slot}"[^>]*>`, "g")) ?? [];
  return elements.map(
    (element) => element.match(/\bclass="([^"]*)"/)?.[1] ?? "",
  );
}

describe("<SourceChips>", () => {
  it("renders nothing when provenance is null", () => {
    const html = render(<SourceChips provenance={null} />);
    expect(html).not.toContain('data-slot="coach-source-chips"');
  });

  it("renders nothing when both windows + metrics are empty", () => {
    const html = render(
      <SourceChips provenance={{ windows: [], metrics: [] }} />,
    );
    expect(html).not.toContain('data-slot="coach-source-chips"');
  });

  it("renders one chip per metric, paired with the primary window", () => {
    const html = render(
      <SourceChips
        provenance={{
          windows: ["last30days"],
          metrics: ["bp", "pulse"],
          counts: { bp: 12, pulse: 14 },
        }}
      />,
    );
    expect(html).toContain('data-slot="coach-source-chips"');
    const matches = html.match(/data-slot="coach-source-chip"/g) ?? [];
    expect(matches.length).toBe(2);
    expect(html).toContain('data-metric="bp"');
    expect(html).toContain('data-metric="pulse"');
    expect(html).toContain("Blood pressure");
    expect(html).toContain("Pulse");
    expect(html).toContain("last 30 days");
  });

  it("renders the sample-count suffix when counts are supplied", () => {
    const html = render(
      <SourceChips
        provenance={{
          windows: ["last7days"],
          metrics: ["bp"],
          counts: { bp: 7 },
        }}
      />,
    );
    expect(html).toContain("n=7");
  });

  it("uses full semantic text color on source labels", () => {
    const html = render(
      <SourceChips
        provenance={{
          windows: ["last7days"],
          metrics: ["bp"],
          counts: { bp: 7 },
        }}
      />,
    );
    const classNames = [
      ...classesForSlot(html, "coach-source-chip"),
      ...classesForSlot(html, "coach-source-window"),
      ...classesForSlot(html, "coach-source-count"),
    ];

    expect(classNames).toHaveLength(3);
    for (const className of classNames) {
      expect(className.split(/\s+/)).toContain("text-info");
      expect(className).not.toMatch(/\b(?:opacity-\d+|text-\S+\/\d+)\b/);
    }
  });

  it("does not render n=0 chips for zero counts", () => {
    const html = render(
      <SourceChips
        provenance={{
          windows: ["last7days"],
          metrics: ["bp"],
          counts: { bp: 0 },
        }}
      />,
    );
    expect(html).not.toContain("n=0");
  });

  it("uses German labels when locale is 'de'", () => {
    const html = render(
      <SourceChips provenance={{ windows: ["last30days"], metrics: ["bp"] }} />,
      "de",
    );
    expect(html).toContain("Blutdruck");
    expect(html).toContain("letzte 30 Tage");
  });

  it("renders a metric chip without window when windows are empty", () => {
    const html = render(
      <SourceChips provenance={{ windows: [], metrics: ["general"] }} />,
    );
    expect(html).toContain('data-metric="general"');
    expect(html).toContain("General");
    expect(html).not.toContain("last 30 days");
  });
});
