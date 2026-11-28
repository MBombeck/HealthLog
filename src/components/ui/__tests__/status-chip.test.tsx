import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import en from "../../../../messages/en.json";

import { StatusChip, type StatusChipTone } from "../status-chip";

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nProvider initialLocale="en">{node}</I18nProvider>);

const TONES: [StatusChipTone, string][] = [
  ["active", "bg-success/15 text-success"],
  ["error", "bg-destructive"],
  ["off", "text-muted-foreground"],
  ["running", "bg-info/15 text-info"],
  ["done", "bg-success/15 text-success"],
];

describe("<StatusChip>", () => {
  it.each(TONES)(
    "renders the %s tone with its word and colour",
    (tone, cls) => {
      const html = render(<StatusChip tone={tone} />);
      const word = (en.common.status as Record<string, string>)[tone];
      expect(word, `common.status.${tone} in en.json`).toBeTruthy();
      expect(html).toContain('data-slot="status-chip"');
      expect(html).toContain(`data-tone="${tone}"`);
      expect(html).toContain(cls);
      expect(html).toContain(`>${word}</`);
    },
  );

  it("never paints purple", () => {
    for (const [tone] of TONES)
      expect(render(<StatusChip tone={tone} />)).not.toMatch(/\bbg-primary\b/);
  });
});
