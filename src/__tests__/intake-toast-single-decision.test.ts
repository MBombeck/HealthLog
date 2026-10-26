/**
 * Every surface that records a dose confirms it the same way.
 *
 * Two things ride a successful intake toast and both are decisions about
 * delegation, not about copy:
 *
 *   - inside somebody else's record, name the record. "Saved" alone is the one
 *     confirmation a person acting for somebody else does not need.
 *   - and drop the Undo there. A delegate may record a dose and may not remove
 *     one, so an Undo they can see is an Undo the server refuses.
 *
 * `intakeToastOptions` in `use-medication-intake.ts` is where that is decided,
 * and its docblock claimed three surfaces had been collapsed into it. There
 * were five. The dashboard quick-add still built its own toast, with a live
 * Undo pointing at `DELETE /api/medications/{id}/intake/{eventId}` — a route
 * that is not delegable at all — and the ledger's add dialog still confirmed
 * with a bare "Taken". Both are reachable by a write delegate.
 *
 * Counting the copies by hand is what let a fourth and a fifth exist while the
 * comment said three, so this counts them. A module that posts an intake and
 * raises a success toast routes that toast through the shared helper.
 *
 * ## What decides
 *
 * The AST, and the population is the interesting half: modules are found by
 * an `apiPost` whose URL template ends in the intake path, read off the
 * template literal rather than off a substring, so a module that merely names
 * the route in prose is not enrolled and one that builds the URL across lines
 * is not missed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** The helper that owns the decision. */
const HELPER = "intakeToastOptions";

/**
 * The modules that post an intake through one of the shared orchestrators
 * rather than directly, and therefore inherit the decision instead of making
 * it. Frozen so that a surface leaving the orchestrator has to leave this list
 * in the same diff.
 */
const VIA_ORCHESTRATOR: Record<string, string> = {
  "components/medications/log-intake-dialog.tsx":
    "Posts through `runLogIntake`, which calls the helper itself.",
};

function candidateFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map((p) => String(p).split(sep).join("/"))
    .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"))
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.startsWith("app/api/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

interface IntakeFacts {
  /** Does the module POST to the per-medication intake route. */
  postsIntake: boolean;
  /** Does it raise a `toast.success` of its own. */
  raisesSuccessToast: boolean;
  /** Does it call the shared helper. */
  callsHelper: boolean;
}

/** The URL a call expression's first argument spells, when it is a template. */
function urlText(node: ts.CallExpression): string | null {
  const first = node.arguments[0];
  if (!first) return null;
  if (ts.isStringLiteralLike(first)) return first.text;
  if (ts.isTemplateExpression(first)) {
    // `${expr}` collapses to a placeholder so the SHAPE survives: the caller
    // interpolates a medication id, and what matters is the tail.
    return (
      first.head.text +
      first.templateSpans.map((s) => `\u0000${s.literal.text}`).join("")
    );
  }
  return null;
}

export function intakeFacts(source: string, fileName: string): IntakeFacts {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const aliases = new Map<string, string>();
  parsed.forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || ts.isNamespaceImport(bindings)) return;
    for (const spec of bindings.elements) {
      aliases.set(spec.name.text, (spec.propertyName ?? spec.name).text);
    }
  });

  const facts: IntakeFacts = {
    postsIntake: false,
    raisesSuccessToast: false,
    callsHelper: false,
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        const name = aliases.get(callee.text) ?? callee.text;
        if (name === "apiPost") {
          const url = urlText(node);
          if (url !== null && url.endsWith("/intake")) facts.postsIntake = true;
        }
        if (name === HELPER) facts.callsHelper = true;
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "toast" &&
        callee.name.text === "success"
      ) {
        facts.raisesSuccessToast = true;
      }
    }
    node.forEachChild(visit);
  };
  parsed.forEachChild(visit);
  return facts;
}

describe("the intake confirmation is decided in one place", () => {
  const scanned = candidateFiles().map((rel) => ({
    rel,
    ...intakeFacts(readFileSync(join(SRC, rel), "utf8"), rel),
  }));
  const posting = scanned.filter((m) => m.postsIntake);

  it("finds the surfaces that record a dose", () => {
    // The count of MATCHES. The verdict below is an empty list, which an
    // empty match set also produces — this is what tells them apart, and the
    // absence of it is why a fourth and a fifth copy could exist under a
    // comment claiming three.
    expect(posting.length).toBeGreaterThan(2);
    for (const rel of [
      "components/medications/use-medication-intake.ts",
      "components/medications/dose-history/use-dose-history-ledger.ts",
      "components/dashboard/medication-intake-quick-add.tsx",
      "components/medications/dose-history-add-dialog.tsx",
    ]) {
      expect(
        posting.map((m) => m.rel),
        rel,
      ).toContain(rel);
    }
  });

  it("routes every one of their success toasts through the shared helper", () => {
    const offenders = posting
      .filter((m) => !(m.rel in VIA_ORCHESTRATOR))
      .filter((m) => m.raisesSuccessToast && !m.callsHelper)
      .map((m) => m.rel);
    expect(
      offenders,
      `a surface that records a dose and builds its own success toast will offer a delegate an Undo the server refuses, and confirm with no record name. Route it through ${HELPER}().`,
    ).toEqual([]);
  });

  it("the matcher reads the call, not the file", () => {
    const OWN_TOAST = `
      import { toast } from "sonner";
      import { apiPost } from "@/lib/api/api-fetch";

      // Confirms with intakeToastOptions one day.
      export function QuickAdd({ id }: { id: string }) {
        const save = async () => {
          await apiPost(\`/api/medications/\${id}/intake\`, { skipped: false });
          toast.success("Saved");
        };
        return save;
      }
    `;
    // The helper's name is in the file as prose, which a substring matcher
    // accepts as compliance.
    expect(OWN_TOAST.includes(HELPER)).toBe(true);
    expect(intakeFacts(OWN_TOAST, "q.tsx")).toEqual({
      postsIntake: true,
      raisesSuccessToast: true,
      callsHelper: false,
    });

    const SHARED = `
      import { toast } from "sonner";
      import { apiPost } from "@/lib/api/api-fetch";
      import { intakeToastOptions } from "@/components/medications/use-medication-intake";

      export function QuickAdd({ id }: { id: string }) {
        const save = async () => {
          await apiPost(\`/api/medications/\${id}/intake\`, { skipped: false });
          toast.success("Saved", intakeToastOptions({ recordName, eventId, t }));
        };
        return save;
      }
    `;
    expect(intakeFacts(SHARED, "s.tsx").callsHelper).toBe(true);

    const ALIASED = `
      import { intakeToastOptions as options } from "@/components/medications/use-medication-intake";
      export const x = () => options({});
    `;
    expect(intakeFacts(ALIASED, "a.tsx").callsHelper).toBe(true);

    // A POST to a neighbouring route is not an intake.
    const OTHER = `
      import { apiPost } from "@/lib/api/api-fetch";
      export const x = (id: string) =>
        apiPost(\`/api/medications/\${id}/side-effects\`, {});
    `;
    expect(intakeFacts(OTHER, "o.ts").postsIntake).toBe(false);
  });
});
