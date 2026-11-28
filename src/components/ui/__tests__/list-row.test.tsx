import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ListItem } from "../list-row";

// lucide marks every icon with its name; the chevron is the only one here.
const CHEVRON = /lucide-chevron-(right|down)/;

describe("<ListItem>", () => {
  it("a row with a trailing value renders no chevron", () => {
    for (const nav of [
      { href: "/custom-metrics/x" },
      { onSelect: () => {} },
      { onSelect: () => {}, expanded: false },
    ]) {
      const html = renderToStaticMarkup(
        <ListItem
          title="VO₂max"
          trailing={<span>48.3 mL/(kg·min)</span>}
          {...nav}
        />,
      );
      expect(html).not.toMatch(CHEVRON);
    }
  });

  it("no caller can opt a valued row back into a chevron", () => {
    const html = renderToStaticMarkup(
      <ListItem title="Steps" trailing="8,412" chevron href="/x" />,
    );
    expect(html).not.toMatch(CHEVRON);
  });

  it("keeps value and unit on one line", () => {
    const html = renderToStaticMarkup(
      <ListItem
        title="Respiratory rate"
        trailing="14.5 breaths/min"
        href="/x"
      />,
    );
    const cell = /data-slot="list-item-trailing"[^>]*class="([^"]*)"/.exec(
      html,
    );
    expect(cell?.[1]).toContain("whitespace-nowrap");
    expect(cell?.[1]).toContain("shrink-0");
  });

  it("a row without a value that leads somewhere keeps its chevron", () => {
    expect(
      renderToStaticMarkup(<ListItem title="Stock" href="/stock" />),
    ).toMatch(CHEVRON);
    expect(
      renderToStaticMarkup(<ListItem title="Stock" onSelect={() => {}} />),
    ).toMatch(CHEVRON);
  });

  it("a row that leads nowhere has no chevron", () => {
    expect(renderToStaticMarkup(<ListItem title="Stock" />)).not.toMatch(
      CHEVRON,
    );
  });
});
