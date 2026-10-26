import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { revokeBody } from "@/components/settings/access/grants-given-card";
import { recordActivityVerbLine } from "@/lib/record-activity/activity-verb";

/**
 * Every MANAGE-admitted action names itself, in all six locales.
 *
 * ## What this asks that the sibling guard does not
 *
 * `src/lib/record-activity/__tests__/verb-map-covers-routes.test.ts` asks the
 * same question of the WRITE surface: a delegable write whose audit action has
 * no sentence renders as "made a change". MANAGE is where that answer stops
 * being merely vague and starts being wrong. A WRITE delegate can only add,
 * and "somebody added something" is at least the right shape of fact. A MANAGE
 * delegate can change and remove entries the owner made themselves, so the
 * generic line would tell an owner that something happened in their record
 * while withholding the only part they need — whether a reading was corrected
 * or deleted, whether a medication was stopped, whether the dose history was
 * purged. The level ships under "reconstructable or refused", and a feed that
 * cannot say which verb ran does not reconstruct anything.
 *
 * So the inventory here is the MANAGE half of the same sweep, and it goes two
 * steps further than its sibling:
 *
 *   1. it resolves the sentence by CALLING the map rather than by matching
 *      `case "…"` in its source, because a `case` inside a comment matches and
 *      an action whose arm falls through to the fallback does not;
 *   2. it follows the resolved key into all six bundles, because a key that
 *      exists only in English renders as its own dotted path to everyone else.
 *
 * ## PHI
 *
 * Two legs, and both are about the same failure. The activity feed reads out
 * of the audit table, the audit table is not encrypted, and the temptation
 * whenever a sentence feels thin is to put the value in it — "{name} changed
 * your weight from 81 to 78". That is a health figure in a second store with
 * its own retention and no rotation story. So: every verb line interpolates
 * `name` and nothing else, in every locale, and the feed's own DTO carries no
 * `details` field for a future caller to reach for.
 *
 * ## Why the counts are of MATCHES
 *
 * The verdict is an empty list of unmapped actions, and an empty match set
 * says exactly the same thing. Every leg therefore pins the size of what it
 * matched — modules walked, MANAGE modules found, one of them named, actions
 * read, sentences resolved — so a matcher that quietly stopped matching fails
 * instead of passing. `describe("the matcher sees what it looks for")` proves
 * both halves against synthetic modules, including the one shape that silenced
 * the sibling guard: a resolver call prettier broke across lines.
 */
const SRC = join(process.cwd(), "src");
const API = join(SRC, "app/api");
const MESSAGES = join(process.cwd(), "messages");
const ACTIVITY_ROUTE = join(
  process.cwd(),
  "src/app/api/account/activity/route.ts",
);
const GRANTS_GIVEN_CARD = join(
  process.cwd(),
  "src/components/settings/access/grants-given-card.tsx",
);

/** The declaration a record-delegated route makes, at any level. */
const RECORD_RESOLVER = "requireRecordAuth";

/**
 * Rows the feed cannot show, and the reason each one cannot.
 *
 * `src/lib/api-handler.ts` is a direct import of every route, and it
 * re-exports the guards in `src/lib/auth/guards/`, so the walk below reaches
 * the three actions the auth kit files itself. None of them can
 * appear in a record owner's activity view, and the reason is the same for all
 * three: they are filed under `auth.user.id` — the CALLER — at a point where
 * no record has been resolved. The feed selects rows where `userId` is the
 * owner and `actorUserId` is somebody else, so a caller-filed row is excluded
 * twice over.
 *
 * Frozen at three. A fourth entry is a claim about a row nobody looked at, and
 * the leg below fails rather than letting one join quietly.
 */
const NOT_IN_THE_FEED = [
  // The bearer path never resolves a record at all.
  "auth.bearer.failure",
  // Step-up is cookie-only and filed under the account being elevated.
  "auth.stepup.elevation.rejected",
  // `auditRefusal` files under the refused caller, before a record exists.
  "sharing.access.denied",
] as const;
/** What an action with no sentence of its own renders as. */
const FALLBACK_KEY = "recordSharing.activity.acted";
/** The six bundles the product ships. */
const LOCALES = [
  "de",
  "en",
  "es",
  "fr",
  "it",
  "pl",
  "ko",
  "nl",
  "pt-BR",
] as const;

/** Every `route.ts` under `src/app/api`, walked rather than globbed: a glob's
 *  `*` skips a leading dot and this tree has dot-directories. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

interface ModuleFacts {
  /** Does the module reach the record resolver at ANY level. */
  delegatesRecord: boolean;
  /**
   * Every level the module passes to `requireRecordAuth`, in source order.
   *
   * Recorded so the inclusion rule's LEVEL axis has something that can
   * falsify it. `delegatesRecord` used to be set only for `"manage"`, and the
   * legs below could not tell the corrected rule from the old one: every
   * assertion about coverage passed either way, because a manage-only sweep
   * still finds every manage action. The leg that separates them asks whether
   * the walked set STRICTLY EXCEEDS the manage-only one, and it needs the
   * levels to ask.
   */
  recordLevels: string[];
  /**
   * Every action the module hands to `auditLog("…")`, awaited or not.
   *
   * v1.37.0 — this used to keep only the AWAITED calls, on the reasoning that
   * a fire-and-forget breadcrumb is not worth narrating. The feed disagrees,
   * and the feed is what the owner reads: `/api/account/activity` selects on
   * `actorUserId IS NOT NULL` with no action filter and no await in sight, so
   * a `void auditLog(…)` breadcrumb lands in the view exactly like an awaited
   * row. Ten `*.validation-failed` actions were invisible to this guard for
   * that reason and rendered to owners as "made a change in your record" —
   * including one a READ delegate can trigger. A guard whose inclusion rule
   * differs from its subject's proves a property about the wrong set.
   */
  auditActions: string[];
  /** First-party modules this one imports, resolved to files. */
  imports: string[];
  /**
   * First-party modules this one re-exports with `export … from`, resolved to
   * files. A re-export makes the named module's bindings this module's own,
   * so its actions count as this module's (`lib/api-handler.ts` re-exports
   * the guards in `lib/auth/guards/`).
   */
  reexports: string[];
}

/**
 * Read both facts off one parse.
 *
 * AST rather than substrings, for the reason the sibling guard learned by
 * going green while matching nothing: prettier moves a call's argument onto
 * its own line the moment the call grows a second one, and
 * `requireRecordAuth("manage"` stops appearing in the source text without
 * anything about the route changing. The import table resolves a local name
 * back to its exported one, so an alias and a namespace-qualified call both
 * count, and a comment naming either symbol counts for nothing.
 */
export function moduleFacts(source: string, fileName: string): ModuleFacts {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  const importPaths: string[] = [];
  const reexportPaths: string[] = [];
  parsed.forEachChild((node) => {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const resolved = resolveFirstParty(node.moduleSpecifier.text, fileName);
      if (resolved !== null && !resolved.includes("__tests__")) {
        reexportPaths.push(resolved);
      }
      return;
    }
    if (!ts.isImportDeclaration(node)) return;
    if (ts.isStringLiteral(node.moduleSpecifier)) {
      const resolved = resolveFirstParty(node.moduleSpecifier.text, fileName);
      if (resolved !== null && !resolved.includes("__tests__")) {
        importPaths.push(resolved);
      }
    }
    const bindings = node.importClause?.namedBindings;
    if (!bindings) return;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      return;
    }
    for (const spec of bindings.elements) {
      aliases.set(spec.name.text, (spec.propertyName ?? spec.name).text);
    }
  });

  /** The original exported name behind this callee, or null. */
  const calleeName = (callee: ts.Expression): string | null => {
    if (ts.isIdentifier(callee)) return aliases.get(callee.text) ?? callee.text;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text)
    ) {
      return callee.name.text;
    }
    return null;
  };

  /** The first argument when it is a plain string literal. */
  const firstStringArg = (node: ts.CallExpression): string | null => {
    const first = node.arguments[0];
    return first && ts.isStringLiteralLike(first) ? first.text : null;
  };

  let delegatesRecord = false;
  const recordLevels: string[] = [];
  const auditActions: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === RECORD_RESOLVER) {
        delegatesRecord = true;
        const level = firstStringArg(node);
        if (level !== null) recordLevels.push(level);
      }
      if (name === "auditLog") {
        const action = firstStringArg(node);
        if (action !== null) auditActions.push(action);
      }
    }
    node.forEachChild(visit);
  };
  parsed.forEachChild(visit);

  return {
    delegatesRecord,
    recordLevels,
    auditActions,
    imports: importPaths,
    reexports: reexportPaths,
  };
}

/**
 * A module specifier resolved to a first-party file, or null.
 *
 * `@/…` and relative paths only. A package import is somebody else's tree and
 * cannot be walked usefully.
 */
export function resolveFirstParty(
  specifier: string,
  fromFile: string,
): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = join(dirname(fromFile), specifier);
  else return null;
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Every action one route module can file, including through what it imports.
 *
 * One level deep, deliberately. The transitive closure pulls in the whole auth
 * and grant machinery through `api-handler`, which reports actions no request
 * to this route can file; one level is where a route's own collaborators live
 * — the import-admission module and the medication lifecycle module are both
 * direct imports of the routes that use them, and both were invisible to a
 * walk that read only `route.ts`. A module an import re-exports is part of
 * that import, not a level below it, so its actions count at the same level.
 */
function actionsReachableFrom(
  file: string,
  read: (path: string) => ModuleFacts,
): string[] {
  const own = read(file);
  const out = [...own.auditActions];
  for (const imported of own.imports) {
    const facts = read(imported);
    out.push(...facts.auditActions);
    for (const reexported of facts.reexports) {
      out.push(...packageActions(reexported, read));
    }
  }
  for (const body of HANDLER_BODY_MODULES[relative(SRC, file)] ?? []) {
    out.push(...actionsReachableFrom(join(SRC, body), read));
  }
  return out;
}

/**
 * Delegated routes whose handler bodies live in service modules under
 * `src/lib/`, keyed by the route relative to `src/`. A handler body is the
 * route's own code moved, so it counts at the route's level: its actions and
 * those of its direct imports (the medication lifecycle a dose write
 * reconciles through) are reached as they were before the move. Each module
 * has to be a direct import of its route (leg below), so an entry cannot
 * outlive the delegation it describes.
 */
const HANDLER_BODY_MODULES: Record<string, readonly string[]> = {
  "app/api/medications/route.ts": ["lib/medications/create-medication.ts"],
  "app/api/medications/[id]/route.ts": [
    "lib/medications/read-medication.ts",
    "lib/medications/update-medication/update-medication.ts",
    "lib/medications/delete-medication.ts",
  ],
  "app/api/medications/[id]/intake/route.ts": [
    "lib/medications/record-intake/record-intake.ts",
    "lib/medications/list-intake-events.ts",
  ],
  "app/api/medications/[id]/intake/[eventId]/route.ts": [
    "lib/medications/update-intake-event.ts",
    "lib/medications/delete-intake-event.ts",
  ],
  "app/api/medications/intake/route.ts": [
    "lib/medications/intake-today.ts",
    "lib/medications/intake-compliance.ts",
    "lib/medications/update-intake-status/admission.ts",
    "lib/medications/update-intake-status/update-intake-status.ts",
  ],
};

/**
 * The actions of a re-exported module together with the sibling modules it
 * imports from its own folder. The re-exported module is a package's public
 * face; the siblings are its private parts, which run inside the same call
 * (`lib/auth/guards/record.ts` files its refusals through `./acting.ts`).
 * Bounded to the one folder, so this does not become the transitive closure
 * the walk above deliberately avoids.
 */
function packageActions(
  file: string,
  read: (path: string) => ModuleFacts,
): string[] {
  const folder = dirname(file);
  const seen = new Set<string>([file]);
  const queue = [file];
  const out: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const facts = read(current);
    out.push(...facts.auditActions);
    for (const next of [...facts.imports, ...facts.reexports]) {
      if (dirname(next) === folder && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return out;
}

/** The message key one action resolves to, or the fallback. */
function verbKeyFor(action: string): { key: string; params: string[] } {
  let key = "";
  let params: string[] = [];
  recordActivityVerbLine(
    (resolved, given) => {
      key = resolved;
      params = Object.keys(given ?? {});
      return resolved;
    },
    action,
    "Alex",
  );
  return { key, params };
}

function bundle(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(MESSAGES, `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
}

/** The leaf at a dotted path, or undefined. */
function leaf(root: Record<string, unknown>, key: string): unknown {
  let node: unknown = root;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** The `{placeholders}` a translated sentence interpolates. */
function placeholders(sentence: string): string[] {
  return [...sentence.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe("the matcher sees what it looks for", () => {
  const REFORMATTED = `
    import { requireRecordAuth } from "@/lib/api-handler";
    import { auditLog } from "@/lib/auth/audit";

    export const DELETE = apiHandler(async () => {
      const { user } = await requireRecordAuth(
        "manage",
        "labs",
      );
      await auditLog("thing.delete", { userId: user.id });
      return apiSuccess({ id: user.id });
    });
  `;

  it("matches a resolver call broken across lines", () => {
    // The shape that silenced the sibling guard: the argument moves onto its
    // own line and a substring test goes quiet with nothing else changed.
    expect(REFORMATTED.includes('requireRecordAuth("manage"')).toBe(false);
    const facts = moduleFacts(REFORMATTED, "r.ts");
    expect(facts.delegatesRecord).toBe(true);
    expect(facts.auditActions).toEqual(["thing.delete"]);
  });

  it("matches an aliased and a namespace-qualified resolver call", () => {
    const ALIASED = `
      import { requireRecordAuth as resolveRecord } from "@/lib/api-handler";
      import { auditLog as record } from "@/lib/auth/audit";

      export const DELETE = apiHandler(async () => {
        const { user } = await resolveRecord("manage", "labs");
        await record("thing.aliased");
        return apiSuccess({ id: user.id });
      });
    `;
    const facts = moduleFacts(ALIASED, "a.ts");
    expect(facts.delegatesRecord).toBe(true);
    expect(facts.auditActions).toEqual(["thing.aliased"]);

    const NAMESPACED = `
      import * as auth from "@/lib/api-handler";

      export const DELETE = auth.apiHandler(async () => {
        const { user } = await auth.requireRecordAuth("manage", "labs");
        return apiSuccess({ id: user.id });
      });
    `;
    expect(moduleFacts(NAMESPACED, "n.ts").delegatesRecord).toBe(true);
  });

  it("does not enrol a route that only talks about delegating", () => {
    const ACTOR_ONLY = `
      /** An actor surface. It must never take requireRecordAuth("manage"). */
      import { requireActorAuth } from "@/lib/api-handler";

      export const POST = apiHandler(async () => {
        const { user } = await requireActorAuth();
        return apiSuccess({ id: user.id });
      });
    `;
    // The raw text carries the exact substring a naive membership test uses.
    expect(ACTOR_ONLY.includes('requireRecordAuth("manage")')).toBe(true);
    expect(moduleFacts(ACTOR_ONLY, "ao.ts").delegatesRecord).toBe(false);
  });

  it("reads the fire-and-forget audit calls too", () => {
    // The defect this file shipped with. `void auditLog(…)` was invisible
    // here and perfectly visible in the owner's feed, so ten refusal
    // breadcrumbs rendered as "made a change in your record".
    const MIXED = `
      import { requireRecordAuth } from "@/lib/api-handler";
      import { auditLog } from "@/lib/auth/audit";

      export const DELETE = apiHandler(async () => {
        const { user } = await requireRecordAuth("manage", "labs");
        void auditLog("thing.breadcrumb", {});
        await auditLog("thing.delete", { userId: user.id });
        return apiSuccess({ id: user.id });
      });
    `;
    expect(moduleFacts(MIXED, "m.ts").auditActions).toEqual([
      "thing.breadcrumb",
      "thing.delete",
    ]);
  });

  it("resolves a first-party import and skips a package one", () => {
    // The other half of the same defect: two of the twelve unmapped actions
    // were filed by library modules the routes import, which a walk over
    // `route.ts` alone could not see.
    const admission = resolveFirstParty(
      "@/lib/medications/intake-import-admission",
      join(API, "medications/route.ts"),
    );
    expect(admission).not.toBeNull();
    expect(readFileSync(admission!, "utf8")).toContain(
      "medication.intake.import.kickoff.denied",
    );
    expect(resolveFirstParty("next/server", "x.ts")).toBeNull();
    expect(resolveFirstParty("@/lib/nothing-here", "x.ts")).toBeNull();
  });

  it("still reports the fallback for an action nobody mapped", () => {
    // The positive control for the recording translator below. Without it, a
    // `verbKeyFor` that always returned the same string would report every
    // action as specific and this file would prove nothing.
    expect(verbKeyFor("nothing.anybody.mapped").key).toBe(FALLBACK_KEY);
  });
});

describe("every delegated action has a sentence of its own", () => {
  const routes = routeFiles(API);
  const cache = new Map<string, ModuleFacts>();
  const read = (file: string): ModuleFacts => {
    let facts = cache.get(file);
    if (!facts) {
      facts = moduleFacts(readFileSync(file, "utf8"), file);
      cache.set(file, facts);
    }
    return facts;
  };

  const delegatedModules = routes.filter((file) => read(file).delegatesRecord);
  const excluded = new Set<string>(NOT_IN_THE_FEED);
  const reachable = [
    ...new Set(
      delegatedModules.flatMap((file) => actionsReachableFrom(file, read)),
    ),
  ].sort();
  const actions = reachable.filter((action) => !excluded.has(action));

  it("matches the delegated modules, and not zero of them", () => {
    // A walk that finds nothing agrees with an inventory that covers nothing.
    expect(routes.length).toBeGreaterThan(300);
    expect(delegatedModules.length).toBeGreaterThan(0);
    // Named anchors, so a matcher that collapsed to one stray file fails
    // rather than clearing the floor. Deleting a reading and purging a dose
    // history are the two acts MANAGE exists for; the mood list is the READ
    // route whose refusal breadcrumb reaches the feed, and it is here because
    // the level is no longer part of the inclusion rule.
    const found = delegatedModules.map((file) => relative(process.cwd(), file));
    expect(found).toContain("src/app/api/measurements/[id]/route.ts");
    expect(found).toContain(
      "src/app/api/medications/[id]/intake/purge/route.ts",
    );
    expect(found).toContain("src/app/api/mood-entries/route.ts");
    // And the actions themselves were read, not merely looked for.
    expect(actions.length).toBeGreaterThan(60);
  });

  it("walks strictly more modules than a manage-only sweep would", () => {
    // The level axis of the inclusion rule, with something that can falsify
    // it. Every other leg in this file passes under BOTH rules — a manage-only
    // sweep still finds every manage action, so coverage cannot tell the two
    // apart. This one can: the corrected rule is "any module that reaches
    // `requireRecordAuth` at any level", so the walked set must strictly
    // exceed the subset that names `manage` anywhere.
    const manageOnly = delegatedModules.filter((file) =>
      read(file).recordLevels.includes("manage"),
    );
    expect(manageOnly.length).toBeGreaterThan(0);
    expect(delegatedModules.length).toBeGreaterThan(manageOnly.length);

    // A named anchor, so the claim does not rest on a count that could drift
    // to equality without anybody noticing. The custom-metrics list resolves
    // `requireRecordAuth("read", …)` and nothing else, so a manage-only filter
    // drops it — along with the refusal breadcrumbs it and its neighbours file.
    const anchor = join(API, "custom-metrics/route.ts");
    expect(read(anchor).recordLevels).toEqual(["read"]);
    expect(read(anchor).recordLevels).not.toContain("manage");
    expect(delegatedModules).toContain(anchor);
    expect(manageOnly).not.toContain(anchor);
  });

  it("reads each moved handler body where its route imports it from", () => {
    const entries = Object.entries(HANDLER_BODY_MODULES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [route, bodies] of entries) {
      const file = join(SRC, route);
      expect(delegatedModules, route).toContain(file);
      for (const body of bodies) {
        expect(
          read(file).imports,
          `${route} does not import ${body}`,
        ).toContain(join(SRC, body));
      }
    }
  });

  it("reaches the actions a route files through what it imports", () => {
    // Both halves of the fix, pinned against the two that were invisible.
    expect(actions).toContain("medication.intake.import.kickoff.denied");
    expect(actions).toContain("medication.oneShot.reconciled");
    // And the fire-and-forget half, on the READ route that started this.
    expect(actions).toContain("mood-entries.list.validation-failed");
  });

  it("excludes exactly the three rows the feed cannot show", () => {
    // The exclusion list is the one place a real action could be hidden, so
    // its size is pinned and every member is asserted to have been REACHED —
    // an entry naming an action nothing files would be a claim about nothing.
    expect(NOT_IN_THE_FEED).toHaveLength(3);
    for (const action of NOT_IN_THE_FEED) {
      expect(reachable, action).toContain(action);
    }
  });

  it("gives every one of them a specific verb rather than the fallback", () => {
    const generic = actions.filter(
      (action) => verbKeyFor(action).key === FALLBACK_KEY,
    );

    expect(
      generic,
      "a delegated action with no verb line renders to the owner as the " +
        "generic 'made a change'. Add a case to activity-verb.ts and a " +
        "sentence to all six bundles — or, if the row genuinely should not " +
        "reach the feed, stop stamping the actor on it.",
    ).toEqual([]);
  });

  it("never reports a refused attempt as something that happened", () => {
    // The half of the HIGH finding that a coverage count cannot express. Every
    // one of these rows is an attempt that changed NOTHING, and the generic
    // line told the owner their record had been edited. A future arm that maps
    // `…validation-failed` onto an ordinary verb would be the same defect with
    // coverage, so the shape of the key is asserted rather than its presence.
    const attempts = actions.filter(
      (action) =>
        action.endsWith(".validation-failed") || action.endsWith(".denied"),
    );
    expect(attempts.length).toBeGreaterThan(10);

    const dishonest = attempts.filter(
      (action) => !/\.(rejected|denied)[A-Z]/.test(verbKeyFor(action).key),
    );
    expect(
      dishonest,
      "an attempt that was refused must not render as an act that happened",
    ).toEqual([]);

    // And the sentences themselves say so, in the source language. A key named
    // `rejected…` whose EN text read "added a reading" would pass the check
    // above and be exactly the lie it exists to stop.
    const en = bundle("en");
    for (const action of attempts) {
      const sentence = leaf(en, verbKeyFor(action).key);
      expect(typeof sentence, action).toBe("string");
      expect(String(sentence), action).toMatch(
        /tried to|could not|was refused|search this record/,
      );
    }
  });

  it("resolves every verb key in all six bundles", () => {
    const bundles = new Map(LOCALES.map((l) => [l, bundle(l)] as const));
    const missing: string[] = [];
    let resolved = 0;

    for (const action of actions) {
      const { key } = verbKeyFor(action);
      for (const locale of LOCALES) {
        const value = leaf(bundles.get(locale)!, key);
        if (typeof value === "string" && value.length > 0) resolved += 1;
        else missing.push(`${locale}: ${key}`);
      }
    }

    expect(missing.sort()).toEqual([]);
    // Six locales for every action, and the actions were counted above.
    expect(resolved).toBe(actions.length * LOCALES.length);
  });

  it("interpolates the actor's name and nothing else, in every locale", () => {
    const bundles = new Map(LOCALES.map((l) => [l, bundle(l)] as const));
    const leaky: string[] = [];
    let checked = 0;

    for (const action of actions) {
      const { key, params } = verbKeyFor(action);
      // The call site's own parameters first: a sentence cannot leak a value
      // the map never hands it.
      if (params.join(",") !== "name") leaky.push(`${key} passes ${params}`);
      for (const locale of LOCALES) {
        const value = leaf(bundles.get(locale)!, key);
        if (typeof value !== "string") continue;
        checked += 1;
        const found = placeholders(value);
        if (found.length !== 1 || found[0] !== "name") {
          leaky.push(`${locale}: ${key} interpolates ${found.join(", ")}`);
        }
      }
    }

    expect(leaky.sort()).toEqual([]);
    expect(checked).toBe(actions.length * LOCALES.length);
  });
});

describe("the retention disclosure does not depend on a race", () => {
  /**
   * The sentence that bounds attribution — "who entered what is answerable for
   * the next N days" — used to appear only if a SECOND query had already
   * answered. The revoke dialog reads the grant list; the number came off the
   * activity feed. Two independent requests, and whichever lost decided
   * whether the owner was told. An owner who clicked quickly, or whose
   * activity read failed, ended a manage grant having read one sentence fewer
   * than an owner who clicked slowly, with nothing on screen to indicate that
   * a sentence was missing.
   *
   * The number now rides the same payload as the row: if there is a grant to
   * revoke, `retentionDays` is already in hand. Deterministic means there is
   * no branch left, which is what both legs below check from opposite sides —
   * one that the sentence is always composed, one that the second query is
   * gone.
   */
  const t = (key: string, params?: Record<string, string | number>) =>
    params ? `${key}(${JSON.stringify(params)})` : key;

  it("states the window on every grant that could have written something", () => {
    for (const access of ["WRITE", "MANAGE"] as const) {
      const body = revokeBody({ t, access, name: "Alex", retentionDays: 90 });
      expect(body).toContain("recordSharing.given.revokeEntriesStay");
      expect(body).toContain(
        'recordSharing.given.revokeAttribution({"days":90})',
      );
    }
    // READ keeps neither: a read grant never put anything in the record, so
    // saying what happens to what they entered would describe an act that
    // cannot have occurred.
    const read = revokeBody({
      t,
      access: "READ",
      name: "Alex",
      retentionDays: 90,
    });
    expect(read).not.toContain("recordSharing.given.revokeAttribution");
  });

  it("takes the number from the read that produced the row", () => {
    const source = readFileSync(GRANTS_GIVEN_CARD, "utf8");
    // Positive control: the matcher can see a hook name in this file at all.
    expect(source.match(/useAccountGrants/g)?.length ?? 0).toBeGreaterThan(0);
    // And the second query, whose arrival used to decide the copy, is gone.
    expect(source).not.toContain("useRecordActivity");
    // The branch it fed is gone with it. A required number cannot be absent,
    // so there is nothing left for a caller to omit — which is the difference
    // between "the sentence is usually there" and "there is no path without
    // it". Both halves are named: the optional marker and the guard.
    expect(source).not.toContain("retentionDays?:");
    expect(source).not.toContain("retentionDays !== undefined");
    expect(source.match(/retentionDays: number/g)?.length ?? 0).toBe(1);
  });
});

describe("the activity feed carries no audit detail", () => {
  /**
   * The DTO the owner's feed publishes, read off the route.
   *
   * A field-level assertion rather than a sentence in a comment, because the
   * pressure to widen it is real and constant: every thin sentence in the feed
   * looks like it wants the value that would make it specific, and the audit
   * row usually has one. `details` is a free-form JSON column written by sixty
   * handlers; publishing it would put whatever any of them decided to file in
   * front of the record owner, and some of them file a label.
   */
  it("publishes five fields, and `details` is not one of them", () => {
    const source = readFileSync(ACTIVITY_ROUTE, "utf8");
    const parsed = ts.createSourceFile(
      ACTIVITY_ROUTE,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    let members: string[] | null = null;
    parsed.forEachChild((node) => {
      if (!ts.isInterfaceDeclaration(node)) return;
      if (node.name.text !== "RecordActivityEntry") return;
      members = node.members
        .map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : ""))
        .filter((n) => n.length > 0)
        .sort();
    });

    // The interface was found at all. `toEqual` against null would report the
    // absence as a mismatch of the list, which reads like the wrong failure.
    expect(
      members,
      "RecordActivityEntry not found in the route",
    ).not.toBeNull();
    expect(members).toEqual(["accesses", "action", "actor", "createdAt", "id"]);
  });
});
