import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Locale } from "@/lib/i18n/config";
import { I18nProvider } from "@/lib/i18n/context";
import de from "../../../../../messages/de.json";
import en from "../../../../../messages/en.json";
import es from "../../../../../messages/es.json";
import fr from "../../../../../messages/fr.json";
import itMessages from "../../../../../messages/it.json";
import pl from "../../../../../messages/pl.json";

let statusPayload: { lastSyncedAt: string | null } | undefined;
let statusLoading = false;
let statusError = false;

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: statusPayload,
    isLoading: statusLoading,
    isError: statusError,
  }),
}));

import { AppleHealthCard } from "../apple-health-card";

function render(locale: Locale = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <AppleHealthCard enabled />
    </I18nProvider>,
  );
}

describe("<AppleHealthCard>", () => {
  beforeEach(() => {
    statusPayload = undefined;
    statusLoading = false;
    statusError = false;
  });

  it("explains that live sync uses the iOS app rather than OAuth", () => {
    statusPayload = { lastSyncedAt: null };
    statusLoading = false;

    const html = render();

    expect(html).toContain('data-testid="apple-health-card"');
    expect(html).toContain("HealthLog iOS app");
    expect(html).toContain("not a web or OAuth connection");
    expect(html).toContain("Settings → Apple Health");
    expect(html).toContain("when iOS grants background time");
    expect(html).not.toContain(">Connected<");
  });

  it("keeps the status neutral when no Apple Health data has been observed", () => {
    statusPayload = { lastSyncedAt: null };
    statusLoading = false;

    const html = render();

    expect(html).toContain('data-testid="apple-health-status"');
    expect(html).toContain('data-state="setup"');
    expect(html).toContain("Set up in iOS app");
    expect(html).not.toContain('data-state="connected"');
  });

  it("reports only observed data freshness without claiming a connection", () => {
    statusPayload = { lastSyncedAt: "2026-07-20T10:30:00.000Z" };
    statusLoading = false;

    const html = render();

    expect(html).toContain('data-state="recent-data"');
    expect(html).toContain("Apple Health data received");
    expect(html).toContain("Last Apple Health data:");
    expect(html).toContain('dateTime="2026-07-20T10:30:00.000Z"');
    expect(html).not.toContain(">Connected<");
    expect(html).not.toContain('data-state="connected"');
  });

  it("links to the existing one-shot Apple Health import fallback", () => {
    statusPayload = { lastSyncedAt: null };
    statusLoading = false;

    const html = render();

    expect(html).toContain('data-testid="apple-health-import-link"');
    expect(html).toContain(
      'href="/settings/export#settings-section-import-title"',
    );
    expect(html).toContain("Open one-shot import");
  });

  it("uses a non-committal checking state while status is loading", () => {
    statusPayload = undefined;
    statusLoading = true;

    const html = render();

    expect(html).toContain('data-state="checking"');
    expect(html).toContain("Checking Apple Health data…");
    expect(html).not.toContain("Connected");
  });
  it("does not turn a failed status read into a setup or connection claim", () => {
    statusError = true;

    const html = render();

    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain("Apple Health status unavailable");
    expect(html).not.toContain('data-state="setup"');
    expect(html).not.toContain("Connected");
  });

  it("defines every card key in all six locale catalogs", () => {
    const requiredKeys = [
      "title",
      "description",
      "lastDataLabel",
      "setupTitle",
      "permissionStep",
      "backgroundStep",
      "importNote",
      "importAction",
    ] as const;

    for (const catalog of [en, de, es, fr, itMessages, pl]) {
      const appleHealth = catalog.settings.appleHealth;
      for (const key of requiredKeys) {
        expect(appleHealth[key]).toBeTypeOf("string");
        expect(appleHealth[key].length).toBeGreaterThan(0);
      }
      expect(Object.keys(appleHealth.status).sort()).toEqual([
        "checking",
        "dataReceived",
        "setup",
        "unavailable",
      ]);
    }
  });

  it.each(["en", "de", "es", "fr", "it", "pl"] as const)(
    "renders localized Apple Health copy for %s without leaking keys",
    (locale) => {
      statusPayload = { lastSyncedAt: null };
      statusLoading = false;

      const html = render(locale);

      expect(html).toContain("Apple Health");
      expect(html).not.toContain("settings.appleHealth.");
    },
  );
});
