/**
 * The activity file card is a title and rows: one picker row (label, meta,
 * button) and, once files are chosen, one row per file. What the card is for,
 * the steps and the GPS note sit behind the (i); the body is not folded into
 * a card of its own. SSR markup, as the other card tests.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/export",
}));

import { I18nProvider } from "@/lib/i18n/context";
import en from "../../../../../messages/en.json";
import { FitImportCard } from "../fit-import-card";

const fit = en.settings.sections.export.import.fit;

function render() {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <FitImportCard />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<FitImportCard>", () => {
  const html = render();

  it("shows the title and the picker row", () => {
    expect(html).toContain(fit.title);
    expect(html).toContain("data-import-picker");
    expect(html).toContain('data-testid="import-action-fit"');
    expect(html).toContain(fit.fileHint);
    expect(html).toContain(">Choose<");
    expect(html).toContain("multiple");
  });

  it("keeps the steps and the GPS note behind the (i)", () => {
    expect(html).toContain('data-slot="info-popover-trigger"');
    expect(html).not.toContain(fit.description);
    expect(html).not.toContain(fit.steps.garmin);
    expect(html).not.toContain(fit.steps.other);
    expect(html).not.toContain(fit.privacyNote);
  });

  it("does not fold the body into a frame of its own", () => {
    expect(html).not.toContain("data-fold");
    expect(html).toContain('data-slot="list-group"');
    expect(html).toContain('data-slot="list-item"');
  });
});
