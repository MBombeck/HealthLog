import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readSourceFolder } from "@/__tests__/helpers/source-files";

/**
 * Every link from the app to the docs site lands on a page that exists.
 *
 * The relay dialog linked `https://docs.healthlog.dev/integrations/push-relay`
 * while the page lived at `guides/push-relay`, so the admin who was asked to
 * read it before consenting got a 404. Nothing checked app links against the
 * site. This guard collects every docs-site URL the source builds, in the
 * three forms it uses (a literal URL, `${DOCS}/…` in the server setup steps,
 * `${DOCS_GUIDES_BASE}/…` and `connect-${provider}` in the integration
 * cards), and requires each path, anchor included, to be in `DOCS_SITE_PAGES`.
 *
 * `DOCS_SITE_PAGES` is the list of docs-site pages and anchors the app is
 * allowed to link to. It is checked against the docs repository itself when
 * `HEALTHLOG_DOCS_DIR` points at a checkout of it (the folder that holds
 * `src/content/docs`), which is how the list is kept true: a page that moves
 * on the site fails that run, and a new app link fails every run until its
 * page is listed.
 */
const DOCS_SITE_PAGES: readonly string[] = [
  "",
  "explanation/privacy-architecture/",
  "getting-started/connect-ios-app/",
  "getting-started/first-steps/",
  "guides/",
  "guides/ai-providers/",
  "guides/backups/",
  "guides/connect-dawarich/",
  "guides/connect-garmin/",
  "guides/connect-google-health/",
  "guides/connect-nightscout/",
  "guides/connect-oura/",
  "guides/connect-polar/",
  "guides/connect-strava/",
  "guides/connect-whoop/",
  "guides/connect-withings/",
  "guides/document-vault/",
  "guides/encryption-key-rotation/",
  "guides/import-csv/",
  "guides/invites/",
  "guides/managed-profiles/#connected-services",
  "guides/push-relay/",
  "guides/reminder-channels/",
  "guides/reminder-channels/#web-push-vapid",
  "guides/reverse-proxy/",
  "guides/sign-in-and-security/",
  "reference/api-endpoints/",
  "reference/environment-variables/",
  "self-hosting/geolite2/",
];

const HOST = "https://docs.healthlog.dev";

/** Normalise a site path: no leading slash, a trailing slash before any anchor. */
function normalise(path: string): string {
  const [page, anchor] = path.replace(/^\/+/, "").split("#");
  const withSlash = page && !page.endsWith("/") ? `${page}/` : page;
  return anchor ? `${withSlash}#${anchor}` : withSlash!;
}

/** Docs-site paths a source text links to, in every form the app writes. */
function linkedPaths(text: string): string[] {
  const out: string[] = [];
  const providers = /type IntegrationDocsProvider =([^;]+);/.exec(text);
  for (const match of text.matchAll(
    /https:\/\/docs\.healthlog\.dev([^\s"'`)]*)/g,
  )) {
    const path = match[1]!;
    // The guides base constant is completed by the forms below.
    if (path === "/guides" && /DOCS_GUIDES_BASE\s*=/.test(text)) continue;
    out.push(normalise(path));
  }
  for (const match of text.matchAll(/\$\{DOCS(?:_GUIDES_BASE)?\}([^`]*)`/g)) {
    const prefix = match[0].startsWith("${DOCS_GUIDES_BASE}") ? "guides" : "";
    const rest = match[1]!;
    if (rest.includes("connect-${provider}")) {
      const names = [...(providers?.[1] ?? "").matchAll(/"([\w-]+)"/g)].map(
        (m) => m[1]!,
      );
      for (const name of names) {
        out.push(normalise(`${prefix}${rest.replace("${provider}", name)}`));
      }
    } else {
      out.push(normalise(`${prefix}${rest}`));
    }
  }
  return out;
}

function sourcesLinkingTheSite() {
  return readSourceFolder("src", {
    floor: 1000,
    include: (rel) => !/__tests__|\.test\.|^generated\//.test(rel),
  })
    .filter(([, text]) =>
      /docs\.healthlog\.dev|\$\{DOCS(_GUIDES_BASE)?\}/.test(text),
    )
    .map(([file, text]) => ({ file, text }));
}

describe("docs-site links", () => {
  it("the collector reads every form and catches a dead page", () => {
    const sample = [
      'const A = "https://docs.healthlog.dev/integrations/push-relay";',
      "const DOCS = 'x'; const B = `${DOCS}/guides/backups/`;",
      'export const DOCS_GUIDES_BASE = "https://docs.healthlog.dev/guides";',
      'type IntegrationDocsProvider = | "whoop" | "oura";',
      "const C = `${DOCS_GUIDES_BASE}/connect-${provider}/`;",
    ].join("\n");
    const paths = linkedPaths(sample);
    expect(paths.sort()).toEqual([
      "guides/backups/",
      "guides/connect-oura/",
      "guides/connect-whoop/",
      "integrations/push-relay/",
    ]);
    expect(paths.filter((p) => !DOCS_SITE_PAGES.includes(p))).toEqual([
      "integrations/push-relay/",
    ]);
  });

  it("every app link to the docs site is a listed page", () => {
    const sources = sourcesLinkingTheSite();
    const all = sources.flatMap(({ file, text }) =>
      linkedPaths(text).map((path) => ({ file, path })),
    );
    // A floor: the sweep must keep finding the links it was written for.
    expect(all.length).toBeGreaterThanOrEqual(25);
    const dead = all
      .filter(({ path }) => !DOCS_SITE_PAGES.includes(path))
      .map(({ file, path }) => `${file}: ${HOST}/${path}`);
    expect(dead, `Docs links to unlisted pages:\n${dead.join("\n")}`).toEqual(
      [],
    );
  });

  const docsDir = process.env.HEALTHLOG_DOCS_DIR;
  it.runIf(Boolean(docsDir))(
    "every listed page exists in the docs repository",
    () => {
      const root = join(docsDir!, "src/content/docs");
      const missing: string[] = [];
      for (const entry of DOCS_SITE_PAGES) {
        const [page, anchor] = entry.split("#");
        const base = join(root, page!.replace(/\/$/, ""));
        const file = [
          `${base}.md`,
          `${base}.mdx`,
          join(base, "index.md"),
          join(base, "index.mdx"),
        ].find((candidate) => existsSync(candidate));
        if (!file) {
          missing.push(entry);
          continue;
        }
        if (anchor) {
          const slugs = [
            ...readFileSync(file, "utf8").matchAll(/^#{2,6}\s+(.+)$/gm),
          ].map((m) =>
            m[1]!
              .trim()
              .toLowerCase()
              .replace(/[^\p{L}\p{N}\s-]/gu, "")
              .replace(/\s/g, "-"),
          );
          if (!slugs.includes(anchor)) missing.push(entry);
        }
      }
      expect(missing).toEqual([]);
    },
  );
});
