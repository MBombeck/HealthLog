/**
 * Structural guard: every list the server caps has a client that reads the
 * cap.
 *
 * A capped list says so on the envelope (`apiListSuccess`, `meta.truncated`
 * / `meta.limit`). The web client read only `data` (`apiGet`), so the signal
 * reached nobody: twelve routes sent it and no surface showed it. A capped
 * route is now bound to a reader, a production file outside the API tree
 * that fetches the route's path through `apiGetList`, the one client reader
 * of the cap, which a surface pairs with `ListCapNotice`.
 *
 * The routes are derived from the tree (every route file that answers with
 * `apiListSuccess`), never listed by hand, so a newly capped route fails here
 * until something reads its cap. Comments are stripped first; the planted
 * cases prove the matchers fire.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** Capped routes with no list on screen, and why. */
const NO_LIST_ON_SCREEN: Record<string, string> = {
  "/api/personal-records":
    "The web reads it for one decorative badge (a record set in the last 30 days), not as a list; the native client owns the list.",
};

/** `app/api/a/[id]/b/route.ts` → `/api/a/[id]/b`. */
function routePathOf(file: string): string {
  return `/${file.replace(/^app\//, "").replace(/\/route\.tsx?$/, "")}`;
}

/** A matcher for the route's path as a client spells it. */
function clientPathPattern(route: string): RegExp {
  const body = route
    .split("/")
    .map((seg) =>
      /^\[.+\]$/.test(seg)
        ? "\\$\\{[^}]+\\}"
        : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(
    `\\bapiGetList\\s*<[\\s\\S]{0,200}?>\\s*\\(\\s*["\`]${body}(?:[?"\`])|\\bapiGetList\\s*\\(\\s*["\`]${body}(?:[?"\`])`,
  );
}

describe("capped lists have a reader", () => {
  const files = walkSourceFiles(SRC, { floor: 3000 }).filter(
    (file) =>
      !file.startsWith("generated/") &&
      !file.includes("__tests__/") &&
      !/\.test\.tsx?$/.test(file),
  );
  const read = (file: string) =>
    stripComments(readFileSync(join(SRC, file), "utf8"));

  const cappedRoutes = files
    .filter((f) => /^app\/api\/.+\/route\.tsx?$/.test(f))
    .filter((f) => /\bapiListSuccess\s*\(/.test(read(f)))
    .map(routePathOf)
    .sort();
  const clients = files
    .filter((f) => !f.startsWith("app/api/"))
    .map((f) => read(f));

  it("the matcher binds a client spelling to its route", () => {
    expect(
      clientPathPattern("/api/medications/[id]/side-effects").test(
        "apiGetList<{ items: Row[] }>(`/api/medications/${medicationId}/side-effects?from=1`)",
      ),
    ).toBe(true);
    expect(
      clientPathPattern("/api/allergies").test(
        'apiGetList<AllergyDTO[]>("/api/allergies")',
      ),
    ).toBe(true);
    // A plain `apiGet` reads `data` only and does not count.
    expect(
      clientPathPattern("/api/allergies").test(
        'apiGet<AllergyDTO[]>("/api/allergies")',
      ),
    ).toBe(false);
    // A longer path that shares the prefix does not count either.
    expect(
      clientPathPattern("/api/allergies").test(
        'apiGetList<AllergyDTO>("/api/allergies/x")',
      ),
    ).toBe(false);
  });

  it("finds the capped routes", () => {
    expect(cappedRoutes.length).toBeGreaterThanOrEqual(12);
  });

  it("binds every capped route to a client that reads its cap", () => {
    const unread = cappedRoutes.filter(
      (route) =>
        !(route in NO_LIST_ON_SCREEN) &&
        !clients.some((code) => clientPathPattern(route).test(code)),
    );
    expect(unread).toEqual([]);
  });

  it("keeps the exemptions to routes that are still capped", () => {
    for (const route of Object.keys(NO_LIST_ON_SCREEN)) {
      expect(cappedRoutes).toContain(route);
    }
  });
});
