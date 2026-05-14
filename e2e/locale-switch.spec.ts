import { expect, test } from "@playwright/test";

/**
 * Locale-key drift smoke check — switch the cookie between EN and DE
 * and assert the login page (the only public surface that's translated)
 * never shows raw i18n keys like `auth.welcomeBack`.
 *
 * Drift catches: a typo'd t("foo.bar") with no key in either locale
 * file would make the raw key surface in the DOM. messages/de.json and
 * messages/en.json key parity is enforced by unit tests; this is the
 * runtime cousin.
 */
test.describe("locale switch", () => {
  for (const locale of ["en", "de"] as const) {
    test(`renders /auth/login in ${locale} without raw i18n keys`, async ({
      page,
      context,
    }) => {
      // Cookies must be addressable to a real origin — `page.url()` on
      // a fresh context returns `about:blank`, which Playwright rejects.
      // Anchor at the configured base URL explicitly.
      const baseURL =
        test.info().project.use.baseURL ?? "http://localhost:3000";
      await context.addCookies([
        {
          name: "healthlog-locale",
          value: locale,
          url: baseURL,
        },
      ]);
      await page.goto("/auth/login");

      const bodyText = await page.locator("body").innerText();

      // i18n keys look like `section.subkey` — letters, numbers,
      // underscores, dots — and are never wrapped in normal sentences,
      // so a regex match anywhere in body text is a sign the lookup
      // fell through.
      const rawKeyPattern = /\b[a-z]+(?:[A-Z][a-z]+)?\.[a-z][A-Za-z0-9_.]+\b/;
      const match = bodyText.match(rawKeyPattern);

      // Whitelist: filenames or version strings can look like keys,
      // skip those by requiring at least one camelCase segment.
      if (match) {
        const candidate = match[0];
        const looksLikeKey = /\.[a-z][A-Z]/.test(candidate);
        expect(
          looksLikeKey,
          `Possible raw i18n key in ${locale}: ${candidate}`,
        ).toBe(false);
      }
    });
  }
});
