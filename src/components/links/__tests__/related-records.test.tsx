import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { RelatedLink } from "@/lib/links/related";

import { RelatedRecordsBlock, RelatedRecordsList } from "../related-records";

const RELATED: RelatedLink[] = [
  {
    kind: "conditionEpisode",
    id: "c1",
    label: "Hypothyroidism",
    date: "2026-01-20T00:00:00.000Z",
    href: "/illness/c1",
    via: "direct",
  },
  {
    kind: "encounter",
    id: "e1",
    label: "SPECIALIST",
    date: "2026-07-01T09:00:00.000Z",
    href: "/checkups?visit=e1",
    via: "direct",
  },
  {
    kind: "labResult",
    id: "l1",
    label: "TSH",
    date: "2026-06-30T09:00:00.000Z",
    href: "/labs/b1",
    via: "efficacyTarget",
  },
];

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<RelatedRecordsList>", () => {
  it("links every chip to the path the server resolved", () => {
    const html = render(<RelatedRecordsList related={RELATED} />);
    expect(html).toContain('href="/illness/c1"');
    expect(html).toContain('href="/checkups?visit=e1"');
    expect(html).toContain('href="/labs/b1"');
    expect(html).toContain("Hypothyroidism");
  });

  it("names a visit labelled by its kind from the reader's bundle", () => {
    const html = render(<RelatedRecordsList related={RELATED} />);
    expect(html).not.toContain(">SPECIALIST<");
  });

  it("names a dose labelled by its catalogue slug from the reader's bundle", () => {
    const html = render(
      <RelatedRecordsList
        related={[
          {
            kind: "vaccination",
            id: "v1",
            label: "tetanus",
            date: "2025-12-20T09:00:00.000Z",
            href: "/vaccinations?dose=v1",
            via: "direct",
          },
          {
            kind: "vaccination",
            id: "v2",
            label: "as-written-on-the-card",
            date: "2025-11-20T09:00:00.000Z",
            href: "/vaccinations?dose=v2",
            via: "direct",
          },
        ]}
      />,
    );
    expect(html).toContain(">Tetanus<");
    expect(html).not.toContain(">tetanus<");
    // A written name that is no catalogue slug stays as written.
    expect(html).toContain("as-written-on-the-card");
  });

  it("says how a derived relation runs", () => {
    const html = render(<RelatedRecordsList related={RELATED} />);
    expect(html).toContain("through the efficacy target");
  });

  it("leaves out the kinds the surface lists elsewhere, and renders nothing when empty", () => {
    const html = render(
      <RelatedRecordsList related={RELATED} omitKinds={["encounter"]} />,
    );
    expect(html).not.toContain("/checkups?visit=e1");
    expect(render(<RelatedRecordsList related={[]} />)).toBe("");
    expect(
      render(
        <RelatedRecordsBlock
          related={RELATED}
          omitKinds={["conditionEpisode", "encounter", "labResult"]}
        />,
      ),
    ).toBe("");
  });
});
