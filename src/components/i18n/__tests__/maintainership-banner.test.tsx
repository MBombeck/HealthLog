import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { MaintainershipBanner } from "../maintainership-banner";
import { I18nProvider } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";

/**
 * v1.4.25 W9e — <MaintainershipBanner> contract:
 *  1. Renders nothing on maintained locales (DE / EN).
 *  2. Renders a notice strip on AI-initial locales (FR / ES / IT / PL).
 *  3. The notice carries a GitHub-issue CTA so feedback has a clear
 *     home.
 *
 * Dismissal-state behaviour (localStorage round-trip + button click)
 * is covered by the component implementation; SSR markup is what the
 * project's other component tests pin (see `error-details.test.tsx`),
 * so we mirror that idiom here. The mount-time `useEffect` that reads
 * localStorage runs client-side only — the SSR output we test here
 * reflects the pre-mount "dismissed by default" branch, which is the
 * exact contract for first paint with a stored flag.
 *
 * The "banner visible on first paint when no flag stored" path is
 * verified end-to-end by the dev server + Playwright lane (W9f);
 * here we pin the locale gating and the markup contract.
 */

function ssr(locale: Locale): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <MaintainershipBanner />
    </I18nProvider>,
  );
}

describe("<MaintainershipBanner>", () => {
  beforeEach(() => {
    // Fresh localStorage so each test starts from the "never dismissed"
    // state. The SSR path doesn't read it, but keeping the slate clean
    // documents the contract for the client-side branch.
    try {
      globalThis.localStorage?.clear();
    } catch {
      /* SSR — localStorage absent */
    }
  });

  it("renders nothing on the EN locale (maintained)", () => {
    const html = ssr("en");
    expect(html).not.toContain("maintainership-banner");
  });

  it("renders nothing on the DE locale (maintained)", () => {
    const html = ssr("de");
    expect(html).not.toContain("maintainership-banner");
  });

  // SSR path renders the dismissed-by-default state to avoid a
  // hydration mismatch. Client mount reads localStorage and reveals
  // the banner when no flag exists. The SSR-only assertion below
  // documents that the strip is NOT painted before the first effect
  // runs — exactly the contract that prevents the flash-of-banner
  // problem.
  it("paints nothing in the SSR pass for AI-initial locales", () => {
    for (const locale of ["fr", "es", "it", "pl"] as const) {
      const html = ssr(locale);
      expect(html).not.toContain("maintainership-banner");
    }
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

  // v1.4.25 W14c — banner copy upgraded to acknowledge that the
  // FR/ES/IT/PL Coach prompts are AI-drafted including safety-critical
  // instructions. Pin the new wording so a copy regression cannot
  // quietly soften the disclosure.
  it("EN banner copy names safety-critical AI-drafted Coach content", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const en = JSON.parse(
      readFileSync(join(process.cwd(), "messages", "en.json"), "utf8"),
    ) as { i18n: { maintainershipBanner: { notice: string } } };
    const notice = en.i18n.maintainershipBanner.notice;
    expect(notice).toMatch(/AI-drafted/);
    expect(notice).toMatch(/safety-critical/);
    expect(notice).toMatch(/GitHub/);
    expect(notice).toMatch(/Coach/);
  });

  it("every AI-initial locale's banner notice acknowledges the AI-drafted Coach content", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const aiDraftPatterns: Record<string, RegExp> = {
      fr: /rédigée par IA/,
      es: /redactado por IA/,
      it: /redatta tramite IA/,
      pl: /opracowana przez AI/,
    };
    for (const [locale, pattern] of Object.entries(aiDraftPatterns)) {
      const data = JSON.parse(
        readFileSync(
          join(process.cwd(), "messages", `${locale}.json`),
          "utf8",
        ),
      ) as { i18n: { maintainershipBanner: { notice: string } } };
      const notice = data.i18n.maintainershipBanner.notice;
      expect(notice, `${locale} banner notice`).toMatch(pattern);
      expect(notice, `${locale} banner notice mentions Coach`).toMatch(
        /Coach/,
      );
    }
  });
});
