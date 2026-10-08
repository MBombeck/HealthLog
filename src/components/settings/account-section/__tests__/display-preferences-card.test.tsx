/**
 * Settings → Account: the controls that save on change (language, units,
 * glucose unit, hour and date format) sit in their own card with no save
 * button, apart from the profile form whose Save does not cover them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import { DisplayPreferencesCard } from "../index";

function render(): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, enabled: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <DisplayPreferencesCard isAuthenticated={false} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("Settings → Account display card", () => {
  it("holds the language select and carries no form or save button", () => {
    const html = render();
    expect(html).toContain('data-testid="settings-display-card"');
    expect(html).toContain('id="language-select"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain('type="submit"');
  });

  it("leaves the save-on-change controls out of the profile form", () => {
    const src = readFileSync(join(__dirname, "../index.tsx"), "utf8");
    const form = src.slice(src.indexOf("<form"), src.indexOf("</form>"));
    expect(form.length).toBeGreaterThan(0);
    for (const control of [
      "language-select",
      "UnitPreferenceSelect",
      "GlucoseUnitSelect",
      "TimeFormatSelect",
      "DateFormatSelect",
    ]) {
      expect(form).not.toContain(control);
    }
    // The timezone saves with the form, so it stays inside it.
    expect(form).toContain("TimezonePicker");
  });
});
