import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every audit action a delegable write route emits has a verb line.
 *
 * The owner's activity view exists to answer "what did somebody else do in my
 * record". It answers that by mapping the audit action to a sentence, and
 * falling back to "made a change" for anything unmapped. A fallback is the
 * right behaviour for an action nobody anticipated; it is the wrong behaviour
 * for the actions this release deliberately admits.
 *
 * That is not hypothetical. The map was written against the action name the
 * canonical route uses, while the web client posts to a sibling route that has
 * audited under a different name since v1.0.0 — so the single most-used
 * delegated act, a caregiver marking a dose, rendered as the generic fallback
 * for the person whose tablets they are. Nothing failed; the sentence was just
 * vaguer than it needed to be, which is exactly the kind of defect no
 * behavioural test notices.
 *
 * So this reads the actions out of the routes rather than out of a list
 * somebody maintains beside them. A new delegable write whose action has no
 * sentence fails here, at the moment it is added.
 *
 * ## Why the AST
 *
 * Membership used to be `src.includes('requireRecordAuth("write")')` and the
 * action names came out of a regex. Both were satisfiable and both were
 * escapable by formatting alone: putting the argument on its own line — which
 * is what prettier does the moment the call grows a second one — dropped the
 * module out of the scan entirely, and a genuinely-red run went green with no
 * mapping added and nothing else changed. A guard a reformat can silence is
 * not a guard.
 *
 * Membership is decided by parsing now, through the module's own import table,
 * so an aliased or namespace-qualified resolver call resolves back to
 * `requireRecordAuth` and the argument is read off the call node rather than
 * off the neighbouring characters. The same walk finds the awaited `auditLog`
 * calls. `describe("the matcher sees what it looks for")` proves both halves
 * against synthetic modules.
 *
 * ## Why the counts below are of MATCHES
 *
 * The verdict this file returns is an EMPTY list, and an empty list is what a
 * matcher that matches nothing also returns. Counting the modules SCANNED
 * proved only that the directory walk worked — it stayed comfortably above its
 * floor while the membership test found no write routes at all. So the pins
 * are on the matched set: the write modules found, one of them named, and the
 * awaited audit actions read out of them.
 */
const API = join(process.cwd(), "src/app/api");
const VERB_MAP = join(
  process.cwd(),
  "src/lib/record-activity/activity-verb.ts",
);

/** The declaration a delegable write route makes. */
const RECORD_RESOLVER = "requireRecordAuth";

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
  /** Does the module pass `"write"` to the record resolver anywhere. */
  writesToRecord: boolean;
  /**
   * The action names of the module's AWAITED `auditLog("…")` calls.
   *
   * Awaited on purpose: a fire-and-forget breadcrumb on a validation failure
   * is not something to narrate to the owner.
   */
  awaitedAuditActions: string[];
}

/**
 * Read both facts off one parse.
 *
 * The import table resolves a local name back to the symbol it was exported
 * as, so `requireRecordAuth as resolveRecord` and `auth.requireRecordAuth`
 * both count, and a comment naming either symbol counts for nothing.
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
  parsed.forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) return;
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

  let writesToRecord = false;
  const awaitedAuditActions: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === RECORD_RESOLVER && firstStringArg(node) === "write") {
        writesToRecord = true;
      }
    }
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (calleeName(call.expression) === "auditLog") {
        const action = firstStringArg(call);
        if (action !== null) awaitedAuditActions.push(action);
      }
    }
    node.forEachChild(visit);
  };
  parsed.forEachChild(visit);

  return { writesToRecord, awaitedAuditActions };
}

describe("the matcher sees what it looks for", () => {
  const REFORMATTED = `
    import { requireRecordAuth } from "@/lib/api-handler";
    import { auditLog } from "@/lib/auth/audit";

    export const POST = apiHandler(async () => {
      const { user } = await requireRecordAuth(
        "write",
      );
      await auditLog("thing.create", { userId: user.id });
      return apiSuccess({ id: user.id });
    });
  `;

  it("matches a resolver call broken across lines", () => {
    // The shape that silenced this guard: prettier moves the argument onto its
    // own line the moment the call grows, and the substring test that decided
    // membership went quiet without anything about the route changing.
    expect(REFORMATTED.includes('requireRecordAuth("write")')).toBe(false);
    const facts = moduleFacts(REFORMATTED, "r.ts");
    expect(facts.writesToRecord).toBe(true);
    expect(facts.awaitedAuditActions).toEqual(["thing.create"]);
  });

  it("matches an aliased and a namespace-qualified resolver call", () => {
    const ALIASED = `
      import { requireRecordAuth as resolveRecord } from "@/lib/api-handler";
      import { auditLog as record } from "@/lib/auth/audit";

      export const POST = apiHandler(async () => {
        const { user } = await resolveRecord("write");
        await record("thing.aliased");
        return apiSuccess({ id: user.id });
      });
    `;
    expect(moduleFacts(ALIASED, "a.ts")).toEqual({
      writesToRecord: true,
      awaitedAuditActions: ["thing.aliased"],
    });

    const NAMESPACED = `
      import * as auth from "@/lib/api-handler";

      export const POST = auth.apiHandler(async () => {
        const { user } = await auth.requireRecordAuth("write");
        return apiSuccess({ id: user.id });
      });
    `;
    expect(moduleFacts(NAMESPACED, "n.ts").writesToRecord).toBe(true);
  });

  it("does not enrol a read route that only talks about writing", () => {
    const READ_ONLY = `
      /** Delegable for reads. It must never take requireRecordAuth("write"). */
      import { requireRecordAuth } from "@/lib/api-handler";

      const MODE = "write";

      export const GET = apiHandler(async () => {
        const { user } = await requireRecordAuth("read");
        return apiSuccess({ id: user.id, mode: MODE });
      });
    `;
    // The raw text carries the exact substring the old membership test used.
    expect(READ_ONLY.includes('requireRecordAuth("write")')).toBe(true);
    expect(moduleFacts(READ_ONLY, "ro.ts").writesToRecord).toBe(false);
  });

  it("reads only the awaited audit calls", () => {
    const MIXED = `
      import { requireRecordAuth } from "@/lib/api-handler";
      import { auditLog } from "@/lib/auth/audit";

      export const POST = apiHandler(async () => {
        const { user } = await requireRecordAuth("write");
        void auditLog("thing.breadcrumb", {});
        await auditLog("thing.create", { userId: user.id });
        return apiSuccess({ id: user.id });
      });
    `;
    expect(moduleFacts(MIXED, "m.ts").awaitedAuditActions).toEqual([
      "thing.create",
    ]);
  });
});

/**
 * Delegable write routes whose handler bodies live in service modules under
 * `src/lib/`, keyed by the route relative to `src/`. The route keeps the
 * resolver call, so membership is read off the route; the awaited audit
 * actions are read off the route AND these modules, because that is where the
 * rows are written now. Each module has to be imported by its route (leg
 * below), so an entry cannot outlive the delegation it describes.
 */
const HANDLER_BODY_MODULES: Record<string, readonly string[]> = {
  "app/api/medications/route.ts": ["lib/medications/create-medication.ts"],
  "app/api/medications/[id]/intake/route.ts": [
    "lib/medications/record-intake/record-intake.ts",
  ],
  "app/api/medications/intake/route.ts": [
    "lib/medications/update-intake-status/admission.ts",
    "lib/medications/update-intake-status/update-intake-status.ts",
  ],
};

function handlerAuditActions(file: string): string[] {
  const rel = relative(join(process.cwd(), "src"), file);
  return (HANDLER_BODY_MODULES[rel] ?? []).flatMap((body) => {
    const path = join(process.cwd(), "src", body);
    return moduleFacts(readFileSync(path, "utf8"), path).awaitedAuditActions;
  });
}

describe("the owner's activity view names what a delegate did", () => {
  const routes = routeFiles(API);
  const writeModules = routes
    .map((file) => {
      const facts = moduleFacts(readFileSync(file, "utf8"), file);
      return {
        file,
        writesToRecord: facts.writesToRecord,
        awaitedAuditActions: [
          ...facts.awaitedAuditActions,
          ...handlerAuditActions(file),
        ],
      };
    })
    .filter((m) => m.writesToRecord);

  it("reads each moved handler body where its route imports it from", () => {
    const entries = Object.entries(HANDLER_BODY_MODULES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [route, modules] of entries) {
      const source = readFileSync(join(process.cwd(), "src", route), "utf8");
      expect(moduleFacts(source, route).writesToRecord, route).toBe(true);
      for (const body of modules) {
        const specifier = `@/${body.replace(/\.ts$/, "")}`;
        expect(source, `${route} does not import ${specifier}`).toContain(
          `"${specifier}"`,
        );
        expect(
          handlerAuditActions(join(process.cwd(), "src", route)).length,
          `${body} awaits no audit row`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("reads a plausible number of route modules", () => {
    // A walk that finds nothing agrees with a map that covers nothing.
    expect(routes.length).toBeGreaterThan(300);
  });

  it("matches the delegable write modules, and not zero of them", () => {
    // The pin that the leg below actually rests on. "No unmapped actions" is
    // also what an empty match set says, so the match set is measured here
    // rather than inferred from the size of the walk.
    expect(writeModules.length).toBeGreaterThan(0);
    // One named anchor, so a matcher that collapsed to a single stray file
    // fails rather than clearing the floor. Marking a dose is the most-used
    // delegated write in the product and the one whose sentence was wrong.
    expect(writeModules.map((m) => relative(process.cwd(), m.file))).toContain(
      "src/app/api/medications/[id]/intake/route.ts",
    );
    // And the actions themselves were read, not merely looked for.
    expect(
      writeModules.flatMap((m) => m.awaitedAuditActions).length,
    ).toBeGreaterThan(0);
  });

  it("gives every delegable write action its own sentence", () => {
    const map = readFileSync(VERB_MAP, "utf8");

    const unmapped: string[] = [];
    for (const writeModule of writeModules) {
      for (const action of writeModule.awaitedAuditActions) {
        if (!map.includes(`case "${action}"`)) unmapped.push(action);
      }
    }

    expect(
      [...new Set(unmapped)].sort(),
      "a delegable write whose audit action has no verb line renders to the " +
        "owner as the generic 'made a change'. Add a case to activity-verb.ts " +
        "and a string to all six bundles.",
    ).toEqual([]);
  });
});
