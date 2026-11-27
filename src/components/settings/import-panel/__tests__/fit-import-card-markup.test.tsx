/**
 * The activity file source is one row on the page: icon, name, one meta line
 * and Choose, which opens the file dialog for several files at once. The step
 * (picker row, one row per file) lives in the sheet the row opens, and what
 * the source is for, the steps and the GPS note sit behind the sheet's (i).
 * SSR markup, so the closed sheet renders nothing.
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
import { FitImportSource } from "../fit-import-card";

const fit = en.settings.sections.export.import.fit;

function render() {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <ul>
          <FitImportSource />
        </ul>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<FitImportSource>", () => {
  const html = render();

  it("is one row: name, what it takes, Choose", () => {
    expect(html).toContain('data-testid="import-card-fit"');
    expect(html).toContain(fit.title);
    expect(html).toContain(fit.fileHint);
    expect(html).toContain('data-testid="import-choose-fit"');
    expect(html).toContain(">Choose<");
    expect(html.match(/data-slot="list-item"/g)?.length).toBe(1);
  });

  it("opens the file dialog for several files from the row", () => {
    expect(html).toMatch(/<input[^>]*type="file"[^>]*multiple/);
  });

  it("keeps the step, the steps and the GPS note off the page", () => {
    expect(html).not.toContain("data-import-picker");
    expect(html).not.toContain(fit.description);
    expect(html).not.toContain(fit.steps.garmin);
    expect(html).not.toContain(fit.privacyNote);
    expect(html).not.toContain("data-fold");
  });
});
