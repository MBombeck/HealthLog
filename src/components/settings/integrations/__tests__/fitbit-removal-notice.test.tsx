/**
 * The note an account that had Fitbit connected finds on Settings →
 * Integrations after the integration is gone: what stopped, that the data
 * stays, and where to go instead.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { FitbitRemovalNoticeView } from "../fitbit-removal-notice";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <FitbitRemovalNoticeView dismissing={false} onDismiss={() => {}} />
    </I18nProvider>,
  );
}

describe("<FitbitRemovalNoticeView>", () => {
  it("says what stopped and that the imported data stays", () => {
    const html = render();
    expect(html).toContain('data-testid="fitbit-removal-notice"');
    expect(html).toContain("Fitbit Web API");
    expect(html).toContain("marked as Fitbit");
  });

  it("points at Google Health on this page and at the Health Connect import", () => {
    const html = render();
    expect(html).toContain('href="#google-health"');
    expect(html).toContain('href="/settings/export#import-health-connect"');
  });

  it("offers one way to put it away", () => {
    const html = render();
    expect(html).toContain('data-testid="fitbit-removal-dismiss"');
  });
});
