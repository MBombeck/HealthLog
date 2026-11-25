/**
 * Every field a PATCH / PUT body schema accepts reaches the handler.
 *
 * The failure this exists for: `PATCH /api/cycle/day-logs/{id}` declared
 * `temperatureExcluded` and the three cervix fields in its body schema, so a
 * client sending them got a 200, but the handler never read them and the row
 * kept its old values. Nothing failed, because every other check proves one
 * end: the schema accepts the field, the OpenAPI document advertises it, the
 * create path writes it. A field the parser admits and the handler drops is
 * an edit that silently does nothing.
 *
 * For each route module under `src/app/api` that exports `PATCH` or `PUT`,
 * the guard finds the body schema it parses (`parseJsonBody(request, X, …)`
 * or `X.safeParse(…)` on an imported schema), loads it, lists its top-level
 * keys, and asserts each key is named in the route's own source (comments
 * stripped, import lines removed). A route that hands the parsed body to a
 * helper declares that helper in `DELEGATES`; its keys are then looked up in
 * the helper as well. A route that stores or applies the body as one
 * document (a JSON column, a loop over its entries) is listed in `WHOLE`.
 * A key that is accepted on purpose and never written goes in `IGNORED`
 * with the reason.
 *
 * It cannot pass by reading nothing: the walk carries a floor, the number of
 * schemas it resolved carries a floor, and every `DELEGATES` / `WHOLE` /
 * `IGNORED` entry must still be needed (a stale entry fails).
 *
 * Its honest limit: "named in the source" is not "written to the row". A key
 * read into a variable that is then thrown away passes. The guard catches
 * the shape that shipped (a key the handler never mentions); review catches
 * the rest. Locally declared schemas are out of scope, since their keys are
 * named in the route by construction.
 *
 * It loads each body schema's module with `import()`, so it runs as an
 * isolated test with its own timeout, not in the shared guard project
 * (`guard-dynamic-import-guard.test.ts`).
 */
// vitest-isolate: loads the schema modules with import().
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const ROOT = process.cwd();

/** The medication edit is spread over the files of one folder. */
const MEDICATION_UPDATE_DIR = "src/lib/medications/update-medication";
const MEDICATION_UPDATE_FILES = walkSourceFiles(
  join(ROOT, MEDICATION_UPDATE_DIR),
  {
    floor: 1,
    extensions: [".ts"],
  },
)
  .filter((f) => !f.includes("__tests__"))
  .map((f) => `${MEDICATION_UPDATE_DIR}/${f}`);

/**
 * Routes whose parsed body is consumed by a helper. Keys absent from the
 * route are looked up in these files.
 */
const DELEGATES: Record<string, string[]> = {
  "src/app/api/activity/goals/route.ts": [
    "src/lib/validations/activity-goals.ts",
  ],
  "src/app/api/admin/push-relay/route.ts": [
    "src/lib/push-relay/operator-switch.ts",
  ],
  "src/app/api/anamnesis/emergency/route.ts": [
    "src/lib/profile/emergency-profile.ts",
  ],
  "src/app/api/auth/me/notification-prefs/route.ts": [
    "src/lib/validations/notification-prefs.ts",
  ],
  "src/app/api/encounters/[id]/route.ts": ["src/lib/encounters/service.ts"],
  "src/app/api/managed-profiles/[id]/route.ts": [
    "src/lib/managed-profiles/lifecycle.ts",
  ],
  "src/app/api/medications/[id]/intake/[eventId]/route.ts": [
    "src/lib/medications/update-intake-event.ts",
  ],
  "src/app/api/medications/[id]/route.ts": MEDICATION_UPDATE_FILES,
  "src/app/api/onboarding/answers/route.ts": [
    "src/lib/onboarding/needs-apply.ts",
  ],
};

/**
 * Routes that store or apply the parsed body as one document (a JSON column,
 * a merge over every key), so no key is named one by one.
 */
const WHOLE: Record<string, string> = {
  "src/app/api/auth/me/coach-prefs/route.ts":
    "stored whole as `coachPrefsJson`",
  "src/app/api/auth/me/modules/route.ts":
    "applied by iterating `Object.entries(parsed.data)` over a strict schema",
  "src/app/api/auth/me/source-priority/route.ts":
    "stored whole as `sourcePriorityJson`",
  "src/app/api/user/thresholds/route.ts":
    "merged whole over the stored overrides document",
};

/** Keys accepted on purpose and not written, per route, with the reason. */
const IGNORED: Record<string, Record<string, string>> = {
  "src/app/api/admin/users/[id]/route.ts": {
    confirm: "a literal the schema itself checks; parsing it is the whole use",
  },
  "src/app/api/cycle/day-logs/[id]/route.ts": {
    loggedAt:
      "the client's capture instant; a day log has no column for it, the create path only bounds it",
  },
};

function keysOf(schema: z.ZodType): string[] {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })
    ._zod.def;
  switch (def.type) {
    case "object":
      return Object.keys(def.shape as Record<string, unknown>);
    case "pipe":
      return keysOf(def.in as z.ZodType);
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "catch":
      return keysOf(def.innerType as z.ZodType);
    case "union":
      return [
        ...new Set((def.options as z.ZodType[]).flatMap((o) => keysOf(o))),
      ];
    case "intersection":
      return [
        ...new Set([
          ...keysOf(def.left as z.ZodType),
          ...keysOf(def.right as z.ZodType),
        ]),
      ];
    default:
      return [];
  }
}

function resolveLibModule(specifier: string): string | null {
  const base = join(ROOT, "src", specifier.replace(/^@\//, ""));
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface RouteBodySchema {
  route: string;
  schemaName: string;
  modulePath: string;
}

function bodySchemasOf(route: string, source: string): RouteBodySchema[] {
  const names = new Set<string>();
  for (const m of source.matchAll(
    /parseJsonBody\(\s*request\s*,\s*([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*safeParse\(/g)) {
    names.add(m[1]);
  }
  const found: RouteBodySchema[] = [];
  for (const name of names) {
    const importRe = new RegExp(
      String.raw`import\s*(?:type\s*)?\{[^}]*\b${name}\b[^}]*\}\s*from\s*"(@/lib/[^"]+)"`,
    );
    const imported = source.match(importRe);
    if (!imported) continue; // declared locally: named in the route already
    const modulePath = resolveLibModule(imported[1]);
    if (modulePath) found.push({ route, schemaName: name, modulePath });
  }
  return found;
}

const routes = requireFloor(
  "PATCH / PUT route modules",
  walkSourceFiles(join(ROOT, "src/app/api"), {
    floor: 300,
    extensions: [".ts"],
  })
    .filter((f) => f.endsWith("route.ts") && !f.includes("__tests__"))
    .map((f) => `src/app/api/${f}`)
    .filter((f) =>
      /export\s+const\s+(?:PATCH|PUT)\b/.test(readSourceText(join(ROOT, f))),
    ),
  60,
);

describe("PATCH / PUT body fields reach the handler", () => {
  it(
    "every accepted key is named in the route or a declared delegate",
    { timeout: 120_000 },
    async () => {
      const violations: string[] = [];
      const usedDelegates = new Set<string>();
      const usedIgnores = new Set<string>();
      const usedWhole = new Set<string>();
      let resolved = 0;

      for (const route of routes) {
        const raw = readSourceText(join(ROOT, route));
        const source = stripComments(raw, route)
          .split("\n")
          .filter((line) => !/^\s*import\b/.test(line))
          .join("\n");
        const delegateSources = (DELEGATES[route] ?? []).map((p) =>
          stripComments(readSourceText(join(ROOT, p)), p),
        );

        for (const body of bodySchemasOf(route, raw)) {
          const mod = (await import(body.modulePath)) as Record<
            string,
            unknown
          >;
          const schema = mod[body.schemaName] as z.ZodType | undefined;
          if (!schema || typeof schema !== "object" || !("_zod" in schema)) {
            continue;
          }
          const keys = keysOf(schema);
          if (keys.length === 0) continue;
          resolved += 1;
          for (const key of keys) {
            const word = new RegExp(String.raw`\b${key}\b`);
            if (word.test(source)) continue;
            const delegate = (DELEGATES[route] ?? []).find((_, i) =>
              word.test(delegateSources[i]),
            );
            if (delegate) {
              usedDelegates.add(route);
              continue;
            }
            if (WHOLE[route]) {
              usedWhole.add(route);
              continue;
            }
            if (IGNORED[route]?.[key]) {
              usedIgnores.add(`${route}#${key}`);
              continue;
            }
            violations.push(`${route}: ${body.schemaName}.${key}`);
          }
        }
      }

      // The routes it resolved a body schema for; a matcher that drifted from
      // the code would resolve far fewer and report a clean sweep.
      expect(resolved).toBeGreaterThan(75);
      expect(violations).toEqual([]);

      // A route whose keys are all named in the route itself no longer needs
      // its delegate entry.
      const staleDelegates = Object.keys(DELEGATES).filter(
        (route) => !usedDelegates.has(route),
      );
      const staleIgnores = Object.entries(IGNORED).flatMap(([route, keys]) =>
        Object.keys(keys)
          .filter((k) => !usedIgnores.has(`${route}#${k}`))
          .map((k) => `${route}#${k}`),
      );
      const staleWhole = Object.keys(WHOLE).filter((r) => !usedWhole.has(r));
      expect(staleDelegates).toEqual([]);
      expect(staleWhole).toEqual([]);
      expect(staleIgnores).toEqual([]);
    },
  );
});
