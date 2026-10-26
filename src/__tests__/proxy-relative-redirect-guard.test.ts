/**
 * A redirect must not name the host the process happens to be bound to.
 *
 * `NextResponse.redirect()` requires an absolute URL, and the obvious way to
 * build one is `new URL("/somewhere", req.url)`. Behind a reverse proxy that
 * does not pass `Host` through, `req.url` is the bind address, so the redirect
 * comes back as `https://0.0.0.0:3000/...`. A browser cannot follow it and iOS
 * refuses the port outright.
 *
 * It shipped on the native sign-in handoff, which is the primary onboarding
 * path. Two things made it invisible:
 *
 *   - every error branch of that route builds a fixed `healthlog://` scheme
 *     with no host in it, so the route was correct on every failure and broken
 *     only on success, and
 *   - a test that builds its own `Request` names a host that matches, so the
 *     absolute URL it produced looked right.
 *
 * This file therefore checks the two halves separately. The behavioural test
 * calls the real route with a request whose own URL points somewhere the
 * public origin is not, which is what a proxy hop looks like from inside the
 * handler. The structural test freezes the pattern out of the four files that
 * had it, because a behavioural test can only cover the route somebody
 * remembered to write one for.
 *
 * Mutation check: put `NextResponse.redirect(new URL("/auth/login?flow=native",
 * req.url))` back in the login route and both tests fail, the first on the
 * host appearing in `Location` and the second on the file list.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { relativeRedirect } from "@/lib/http/relative-redirect";

const REPO_ROOT = resolve(__dirname, "../..");

/**
 * The files that carried the pattern when it was found. Frozen as a list
 * rather than a repo-wide sweep so a new occurrence somewhere else is a
 * failure of the sweep below rather than a silent pass here.
 */
const FILES_THAT_HAD_IT = [
  "src/app/api/auth/native/login/route.ts",
  "src/app/api/withings/connect/route.ts",
  "src/app/api/whoop/connect/route.ts",
  "src/app/api/fitbit/connect/route.ts",
] as const;

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

describe("redirects to this deployment do not name a host", () => {
  it("no route builds a redirect target out of the request URL", () => {
    // Matches `new URL(<anything>, req.url)` and the `request.url` spelling,
    // across a line break, which is how prettier formats the longer ones.
    const pattern = /new URL\([\s\S]*?,\s*(?:req|request)\.url\s*\)/g;

    const offenders: string[] = [];
    for (const file of FILES_THAT_HAD_IT) {
      const source = read(file);
      const hits = source.match(pattern);
      if (hits) offenders.push(`${file}: ${hits.length}`);
    }

    expect(
      offenders,
      "these files built a redirect out of the request URL, which is the bind address behind a proxy",
    ).toEqual([]);
  });

  it("each of those files reaches for the relative helper instead", () => {
    // The counterpart to the check above: proving the pattern is gone says
    // nothing about whether the redirect still happens. A file that simply
    // deleted its redirect would pass the first test and fail its users.
    const missing = FILES_THAT_HAD_IT.filter(
      (file) => !read(file).includes("relativeRedirect("),
    );

    expect(
      missing,
      "a file that lost the pattern without gaining the helper has lost its redirect",
    ).toEqual([]);
  });

  it("the helper refuses a value that is a host in disguise", () => {
    // `//evil.example` is protocol-relative: a browser reads it as a host.
    expect(() => relativeRedirect("//evil.example/auth/login")).toThrow(
      /root-relative/,
    );
    // Without the leading slash it resolves against the current path instead
    // of the root, which lands somewhere nobody intended.
    expect(() => relativeRedirect("auth/login")).toThrow(/root-relative/);

    const ok = relativeRedirect("/auth/login?flow=native");
    expect(ok.status).toBe(307);
    expect(ok.headers.get("location")).toBe("/auth/login?flow=native");
  });
});
