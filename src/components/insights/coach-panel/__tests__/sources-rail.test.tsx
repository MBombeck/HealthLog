import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { SourcesRail } from "../sources-rail";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<SourcesRail>", () => {
  it("renders the rail wrapper + label", () => {
    const html = render(<SourcesRail />);
    expect(html).toContain('data-slot="coach-sources-rail"');
    expect(html).toContain("What I can see");
  });

  it("renders the rail label as a real `<h3>` heading (v1.4.33)", () => {
    // The rail mounts inline on `xl+` desktop where no `SheetTitle`
    // wrapper covers it. Promoting the label to `<h3>` restores the
    // drawer's semantic outline so screen-reader users can navigate
    // by heading.
    const html = render(<SourcesRail />);
    expect(html).toMatch(
      /<h3[^>]*data-slot="coach-sources-rail-heading"[^>]*>[\s\S]*What I can see[\s\S]*<\/h3>/,
    );
  });

  it("lists exactly five rows (BP, weight, pulse, mood, compliance)", () => {
    const html = render(<SourcesRail />);
    const rows = html.match(/data-slot="coach-sources-row"/g) ?? [];
    expect(rows.length).toBe(5);
    expect(html).toContain('data-source="bp"');
    expect(html).toContain('data-source="weight"');
    expect(html).toContain('data-source="pulse"');
    expect(html).toContain('data-source="mood"');
    expect(html).toContain('data-source="compliance"');
  });

  it("renders the localised metric labels in English", () => {
    const html = render(<SourcesRail />);
    expect(html).toContain("Blood pressure");
    expect(html).toContain("Weight");
    expect(html).toContain("Pulse");
    expect(html).toContain("Mood");
    expect(html).toContain("Compliance");
  });

  it("renders the German labels when locale is 'de'", () => {
    const html = render(<SourcesRail />, "de");
    expect(html).toContain("Blutdruck");
    expect(html).toContain("Gewicht");
    expect(html).toContain("Einnahmetreue");
  });

  it("renders the medical disclaimer in the footer (relocated from the composer in v1.4.22)", () => {
    const html = render(<SourcesRail />);
    expect(html).toContain('data-slot="coach-sources-disclaimer"');
    expect(html).toContain("Clinical decisions belong with your doctor");
  });

  it("renders a checkbox per row + a window selector trigger", () => {
    const html = render(<SourcesRail />);
    const checkboxes = (html.match(/data-slot="coach-sources-checkbox"/g) ?? [])
      .length;
    expect(checkboxes).toBe(5);
    expect(html).toContain('data-slot="coach-sources-window-trigger"');
  });

  it("paints checkboxes as checked when scope.sources includes the row", () => {
    const html = render(
      <SourcesRail
        scope={{ sources: ["bp", "weight"], window: "last7days" }}
        onScopeChange={() => undefined}
      />,
    );
    // The bp + weight rows should be marked active; others inactive.
    expect(html).toMatch(/data-source="bp"[^>]*data-active="true"/);
    expect(html).toMatch(/data-source="weight"[^>]*data-active="true"/);
    expect(html).toMatch(/data-source="pulse"[^>]*data-active="false"/);
  });
});
