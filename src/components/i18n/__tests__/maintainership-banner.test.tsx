import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.25 — <MaintainershipBanner> contract:
 *  1. Renders nothing on maintained locales (DE / EN).
 *  2. Renders a notice strip on machine-translated locales, with a
 *     GitHub-issue CTA so feedback has a clear home.
 *  3. Closed per language on the account (`i18n-banner.<locale>`), so it
 *     stays closed on every device, and paints nothing until the account
 *     has loaded, so a closed banner never flashes.
 */
let auth: { user: { id: string } | null; isLoading: boolean };
let stored: string[];
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("@/hooks/use-dismissed-hints", () => ({
  useDismissedHints: () => ({
    isDismissed: (family: string, member?: string) =>
      stored.includes(family) || stored.includes(`${family}.${member}`),
    dismiss: async () => true,
  }),
}));

import { MaintainershipBanner } from "../maintainership-banner";
import { I18nProvider } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";

function ssr(locale: Locale): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <MaintainershipBanner />
    </I18nProvider>,
  );
}

describe("<MaintainershipBanner>", () => {
  beforeEach(() => {
    auth = { user: { id: "u1" }, isLoading: false };
    stored = [];
  });

  it("renders nothing on the EN locale (maintained)", () => {
    expect(ssr("en")).not.toContain("maintainership-banner");
  });

  it("renders nothing on the DE locale (maintained)", () => {
    expect(ssr("de")).not.toContain("maintainership-banner");
  });

  it("shows on a machine-translated locale with the feedback link", () => {
    for (const locale of ["fr", "es", "it", "pl"] as const) {
      const html = ssr(locale);
      expect(html).toContain("maintainership-banner");
      expect(html).toContain("template=translation.yml");
    }
  });

  it("stays closed for a language closed on the account, and only that one", () => {
    stored = ["i18n-banner.fr"];
    expect(ssr("fr")).not.toContain("maintainership-banner");
    expect(ssr("it")).toContain("maintainership-banner");
  });

  it("paints nothing until the account has loaded", () => {
    auth = { user: null, isLoading: true };
    expect(ssr("fr")).not.toContain("maintainership-banner");
  });

  it("the component module exports the locale gate as a named symbol", async () => {
    // Sanity check: the gate (`isMaintainedLocale`) must stay re-exported
    // from the same `config` module so admin tooling / the future
    // settings switch can read the source of truth without importing
    // the banner itself.
    const cfg = await import("@/lib/i18n/config");
    expect(typeof cfg.isMaintainedLocale).toBe("function");
    expect(cfg.isMaintainedLocale("en")).toBe(true);
    expect(cfg.isMaintainedLocale("de")).toBe(true);
    expect(cfg.isMaintainedLocale("fr")).toBe(false);
    expect(cfg.isMaintainedLocale("es")).toBe(false);
    expect(cfg.isMaintainedLocale("it")).toBe(false);
    expect(cfg.isMaintainedLocale("pl")).toBe(false);
  });

  // v1.4.27 — the banner copy was rewritten to "machine-translated"
  // wording in the convention-compliance pass. The disclosure still
  // names the safety-critical Coach content and points at GitHub;
  // pin the new shape so a future regression cannot quietly soften
  // the disclosure or re-introduce the retired vocabulary.
  it("EN banner copy names the machine-translated safety-critical Coach content", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const en = JSON.parse(
      readFileSync(join(process.cwd(), "messages", "en.json"), "utf8"),
    ) as { i18n: { maintainershipBanner: { notice: string } } };
    const notice = en.i18n.maintainershipBanner.notice;
    expect(notice).toMatch(/machine-translated/);
    expect(notice).toMatch(/safety-critical/);
    expect(notice).toMatch(/GitHub/);
    expect(notice).toMatch(/Coach/);
  });

  it("every machine-translated locale's banner notice acknowledges the Coach content", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const machineTranslatedPatterns: Record<string, RegExp> = {
      fr: /traduite automatiquement/,
      es: /traducido automáticamente/i,
      it: /tradotta automaticamente/i,
      pl: /tłumaczona maszynowo|tłumaczone maszynowo/i,
    };
    for (const [locale, pattern] of Object.entries(machineTranslatedPatterns)) {
      const data = JSON.parse(
        readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
      ) as { i18n: { maintainershipBanner: { notice: string } } };
      const notice = data.i18n.maintainershipBanner.notice;
      expect(notice, `${locale} banner notice`).toMatch(pattern);
      expect(notice, `${locale} banner notice mentions Coach`).toMatch(/Coach/);
    }
  });
});
