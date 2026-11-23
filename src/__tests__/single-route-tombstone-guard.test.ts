/**
 * Every single create route that takes an `externalId` says what a re-post of
 * an entry deleted in HealthLog gets.
 *
 * The bulk routes refused such a re-post per entry (`deleted_in_healthlog`),
 * and the families guard (`tombstone-repost-guard.test.ts`) held them to it.
 * Nothing held the single routes: `POST /api/mood-entries`, which the app
 * posts State of Mind samples through one by one, upserted onto the
 * tombstone, left it deleted and answered `201`, so the app believed a
 * deleted entry was back. This guard finds every POST route outside the bulk,
 * batch and by-external-ids routes whose code or whose imported body schema
 * names `externalId`, and holds the set to `SINGLE_ROUTE_EXTERNAL_ID_RULES`:
 * a `refuse` route answers through the shared `410`, an `exempt` one states
 * why no re-post can meet an entry the person deleted.
 */
import { describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { SINGLE_ROUTE_EXTERNAL_ID_RULES } from "@/lib/sync/tombstone-repost";
import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const API = join(SRC, "app/api");

function code(abs: string): string {
  return stripComments(readSourceText(abs));
}

/** The files a `@/lib/validations/<module>` import resolves to. */
function validationFiles(module: string): string[] {
  const base = join(SRC, "lib/validations", module);
  if (existsSync(`${base}.ts`)) return [`${base}.ts`];
  if (existsSync(base) && statSync(base).isDirectory()) {
    return walkSourceFiles(base, { floor: 1 })
      .filter((p) => !p.includes("__tests__"))
      .map((p) => join(base, p));
  }
  return [];
}

/** The text of `export const <name> = …` up to the next top-level export. */
function exportBlock(source: string, name: string): string | null {
  const start = source.search(new RegExp(`export\\s+const\\s+${name}\\b`));
  if (start < 0) return null;
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

/** Does a body schema the route imports declare an `externalId` field? */
function importsExternalIdSchema(route: string): boolean {
  const imports = route.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/validations\/([^"]+)"/g,
  );
  for (const [, names, module] of imports) {
    const files = validationFiles(module).map(code);
    for (const raw of names.split(",")) {
      const name = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0];
      if (!name) continue;
      for (const file of files) {
        const block = exportBlock(file, name);
        if (block && /\bexternalId\s*:/.test(block)) return true;
      }
    }
  }
  return false;
}

function singleRoutesTakingExternalId(): string[] {
  return walkSourceFiles(API, { floor: 300 })
    .filter((p) => /(^|\/)route\.ts$/.test(p))
    .filter((p) => !/(^|\/)(by-external-ids|bulk|batch)\//.test(p))
    .filter((p) => !/-batch\/route\.ts$/.test(p))
    .filter((p) => {
      const route = code(join(API, p));
      if (!/export\s+(const|async function)\s+POST\b/.test(route)) {
        return false;
      }
      return /\bexternalId\b/.test(route) || importsExternalIdSchema(route);
    })
    .map((p) => p.replace(/\/?route\.ts$/, ""))
    .sort();
}

const rules = Object.entries(SINGLE_ROUTE_EXTERNAL_ID_RULES);
const refusing = rules.flatMap(([route, rule]) =>
  rule.rule === "refuse" ? [[route, rule.files] as const] : [],
);

describe("single create routes that take an externalId", () => {
  const routes = singleRoutesTakingExternalId();

  it("finds the routes at all, the known ones among them", () => {
    expect(routes.length).toBeGreaterThanOrEqual(6);
    // The sleep-stage arm is reached only through its imported schema.
    expect(routes).toContain("measurements");
    expect(routes).toContain("mood-entries");
  });

  it("lists every such route with a rule", () => {
    expect(routes).toEqual(Object.keys(SINGLE_ROUTE_EXTERNAL_ID_RULES).sort());
  });

  it.each(refusing)(
    "%s: refuses a re-post of an entry deleted in HealthLog with the shared 410",
    (_route, files) => {
      const source = files
        .map((file) => {
          const abs = join(SRC, file);
          expect(existsSync(abs), `${file} exists`).toBe(true);
          return code(abs);
        })
        .join("\n");
      expect(source).toMatch(/\bdeletedInHealthLogRefusal\(/);
    },
  );

  it("every exemption says why", () => {
    for (const [route, rule] of rules) {
      if (rule.rule !== "exempt") continue;
      expect(rule.reason.length, route).toBeGreaterThan(40);
    }
  });
});
