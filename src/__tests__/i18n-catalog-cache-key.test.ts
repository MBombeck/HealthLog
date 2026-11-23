/**
 * The locale catalog's boot script is cached by its URL: the service worker
 * serves `/i18n/<locale>.js?v=…` cache-first. Keyed by the package version,
 * every build of one release shared one URL, so a beta updated within a
 * release kept its first catalog and every key added since read as its raw
 * name ("timeline.zoom.range"). The key is the catalogs' content hash now.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("the locale catalog's cache key", () => {
  it("moves with the catalogs, not with the release", () => {
    const layout = read("src/app/layout.tsx");
    const src =
      /src=\{`\/i18n\/\$\{initialLocale\}\.js\?v=\$\{([^}]*)\}`\}/.exec(layout);
    expect(src?.[1]).toContain("NEXT_PUBLIC_I18N_CATALOG_VERSION");
    expect(src?.[1]).not.toContain("NEXT_PUBLIC_APP_VERSION");
  });

  it("is computed from the message catalogs at build time", () => {
    const config = read("next.config.ts");
    expect(config).toMatch(
      /NEXT_PUBLIC_I18N_CATALOG_VERSION:\s*catalogVersion\(\)/,
    );
    expect(config).toMatch(/join\(process\.cwd\(\), "messages"\)/);
  });

  it("is kept for good under its versioned URL, and only there", async () => {
    // Without it the page-wide `private, max-age=0, must-revalidate` rule
    // covered the catalog too, and every cold load without a service worker
    // revalidated the largest file of the page.
    const rules = (await nextConfig.headers?.()) ?? [];
    const i18n = rules.findIndex((rule) => rule.source === "/i18n/:file*");
    expect(i18n).toBeGreaterThan(-1);
    expect(rules[i18n].has).toEqual([{ type: "query", key: "v" }]);
    expect(rules[i18n].headers).toEqual([
      { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
    ]);
    // Later rules win in Next; the page-wide rule must come before it.
    const pageWide = rules.findIndex((rule) =>
      rule.headers.some(
        (h) => h.value === "private, max-age=0, must-revalidate",
      ),
    );
    expect(pageWide).toBeGreaterThan(-1);
    expect(pageWide).toBeLessThan(i18n);
  });
});
