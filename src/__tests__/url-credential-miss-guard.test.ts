/**
 * Every URL-credential surface answers a dead link the same way: a link that
 * is unknown, malformed, revoked or expired gets one answer, and for a page
 * or a record that answer is a real 404.
 *
 * `/e/<token>` and `/c/<token>` once answered 200 with a "not found" body:
 * they were pages, and a page under the root loading boundary has sent its
 * status line before its lookup ends. So no page under a credential segment
 * may be the first to answer: each is listed with the edge hop that answers
 * a dead link before it renders, and the proxy is called here to prove it.
 * The routes are listed with their miss status, and
 * `tests/integration/url-credential-miss.test.ts` calls every one of them
 * against a real database.
 *
 * The list is the tree: a file under a `[token]` or `[secret]` segment that
 * is not classified here fails, and so does an entry for a file that is gone.
 */
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/process-type", () => ({ shouldRunWeb: () => true }));

import { proxy } from "../proxy";
import { readSourceFolder } from "./helpers/source-files";
import {
  CREDENTIAL_PAGES,
  CREDENTIAL_ROUTES,
  CREDENTIAL_SUPPORT_FILES,
  URL_CREDENTIAL_SEGMENT,
} from "./helpers/url-credential-surfaces";

const files = readSourceFolder("src/app", {
  floor: 10,
  include: (rel) =>
    !rel.includes("__tests__") &&
    rel.split("/").some((seg) => URL_CREDENTIAL_SEGMENT.test(seg)),
}).map(([rel]) => rel);

const classified = new Set([
  ...Object.keys(CREDENTIAL_PAGES),
  ...Object.keys(CREDENTIAL_ROUTES),
  ...Object.keys(CREDENTIAL_SUPPORT_FILES),
]);

describe("URL-credential surfaces answer a dead link with one 404", () => {
  it("finds the surfaces (the walk is not blind)", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(files).toContain("e/[token]/route.ts");
    expect(files).toContain("c/[token]/view/page.tsx");
  });

  it("classifies every file under a credential segment", () => {
    expect(files.filter((f) => !classified.has(f))).toEqual([]);
  });

  it("lists no file that is gone", () => {
    expect([...classified].filter((f) => !files.includes(f))).toEqual([]);
  });

  it("lets no page answer first: a page cannot send a 404", () => {
    const pages = files.filter((f) => /\/page\.tsx$/.test(f));
    expect(pages.filter((f) => !(f in CREDENTIAL_PAGES))).toEqual([]);
  });

  it.each(Object.entries(CREDENTIAL_PAGES))(
    "%s is answered at the edge before it renders",
    (_file, page) => {
      const res = proxy(new NextRequest(`http://localhost${page.probe}`));
      expect(res.status).toBe(307);
      expect(res.headers.get("location") ?? "").toMatch(page.redirectsTo);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    },
  );

  it("lets the share view through once the entry route set its gate cookie", () => {
    const { probe } = CREDENTIAL_PAGES["c/[token]/view/page.tsx"];
    const res = proxy(
      new NextRequest(`http://localhost${probe}`, {
        headers: { cookie: "hls_view=1" },
      }),
    );
    expect(res.status).not.toBe(307);
  });

  it("names a 404 for every route that serves a page or a record", () => {
    for (const [file, route] of Object.entries(CREDENTIAL_ROUTES)) {
      if (!file.startsWith("api/")) {
        expect(route.missStatus, file).toBe(404);
        expect(route.method, file).toBe("GET");
      }
    }
  });
});
