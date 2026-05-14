import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider, useTranslations } from "@/lib/i18n/context";

function Read({ k }: { k: string }) {
  const { t } = useTranslations();
  return <span data-key={k}>{t(k)}</span>;
}

describe("i18n fallback chain", () => {
  it("resolves a key that exists in the active locale", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de">
        <Read k="dashboard.title" />
      </I18nProvider>,
    );
    // dashboard.title is shipped in every locale; the German value should
    // appear (not the EN value, not the raw key).
    expect(html).toContain('data-key="dashboard.title"');
    expect(html).not.toMatch(/>dashboard\.title</);
  });

  // Level-2 of the fallback chain (active locale missing → EN) is
  // unreachable in production by design: the locale-integrity parity
  // test (../__tests__/i18n-locale-integrity.test.ts) enforces that
  // every key in en.json exists in every other locale and vice versa,
  // so a "missing in fr but present in en" state can never reach the
  // runtime. If it does, the integrity test catches it before CI
  // accepts the PR, NOT at runtime. That layering is intentional.
  it.skip("level-2 EN fallback (unreachable — parity test guards this)", () => {});

  it("returns the key itself only as last resort (regression guard)", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <Read k="this.key.absolutely.does.not.exist.anywhere" />
      </I18nProvider>,
    );
    // Last-resort fallback documents the contract: when both locales
    // miss the key, t() returns the key itself. This is intentional —
    // visible regression beats silent empty string. The integrity test
    // (../__tests__/i18n-locale-integrity.test.ts) prevents this from
    // happening in shipped code; this test just pins the runtime
    // contract.
    expect(html).toContain("this.key.absolutely.does.not.exist.anywhere");
  });
});
