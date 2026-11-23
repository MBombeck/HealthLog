/**
 * A background pass that catches a failed item inside its loop says so.
 *
 * The class: a fan-out pass over devices, accounts, sources or days catches
 * one item's failure, logs a warning and carries on. Carrying on is right;
 * ending there is not. The run then returned `jobDone` with counts of what
 * worked, the admin page read it as green, and the warning lived only in a
 * log nobody was reading. The push wakes, the Live Activity pass, the
 * anomaly notice, the dense-tier drains and the import tails all did it.
 *
 * So a `catch` inside a loop, in the code the background jobs run, has to
 * leave a trace the run can report: rethrow, return an outcome, count (an
 * increment, a `FanOutTally.fail()`), keep it in a result (an assignment, a
 * `push` / `set` / `add`), or stamp the item's own status row (a call named
 * `stamp…`, `record…Failure` or `mark…Failed`). A catch that only logs, or
 * does nothing, fails here by file and line, unless it is listed below with
 * the reason it is right not to count.
 *
 * Limit, stated: it sees loops by syntax (`for`, `for…of`, `for…in`,
 * `while`, `do`), not a per-item callback such as `onBucketError` or a
 * `Promise.all(items.map(...))`, and it trusts the names above. The callback
 * walks are counted by hand in the drains (`daysFailed`).
 *
 * Mutation check: delete `tally.fail();` from the per-device catch in
 * `src/lib/push-relay/data-changed.ts` and the case goes red naming it.
 */
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  walkSourceFiles,
} from "@/__tests__/helpers/source-files";

/** The code the background jobs run, by folder under `src/lib`. */
const ROOTS = [
  "jobs",
  "push-relay",
  "measurements",
  "rollups",
  "import",
  "apple-health",
] as const;

/**
 * Catches inside a loop that are right not to count, by `file:function`, each
 * with the reason. A key whose catch no longer exists fails the run.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "src/lib/jobs/boss-instance.ts:superviseProducerReconnect":
    "the queue producer's own reconnect loop: it retries until it connects and is no job run to report",
  "src/lib/jobs/registry/register.ts:runBootDiscovery":
    "boot-time discovery, not a job run; the next boot discovers again, and the error is logged at error",
  "src/lib/jobs/registry/register.ts:preloadHandlers":
    "the report of a handler load failure failing; the failure itself is already in the result, and stderr is the last place left",
  "src/lib/jobs/reminder/registrar-shared.ts:retireQueues":
    "retiring a queue at boot, logged at error; it is retried on the next boot and is no job run",
  "src/lib/jobs/document-thumbnail-backfill.ts:enqueueBootTimeThumbnailBackfill":
    "a boot-time enqueue; the next boot discovers the still-missing thumbnails again",
  "src/lib/jobs/reminder/telegram-deletion-cleanup.ts:cleanupScheduledTelegramDeletions":
    "deleting a Telegram message that is often gone already; the record is cleared either way, nothing is owed",
  "src/lib/import/apple-health-staging.ts:sweepStaleImportStaging":
    "a staged file gone between the listing and the removal, or not this process's to remove",
  "src/lib/jobs/coach-nudge.ts:runCoachNudgeTick":
    "an AI job: its run outcome belongs to the AI job reporter (`reportJobRun`), owned with the AI jobs",
  "src/lib/jobs/insight-pregenerate.ts:warmStatusBatch":
    "an AI job: its run outcome belongs to the AI job reporter (`reportJobRun`), owned with the AI jobs",
};

const LOOP_KINDS = new Set([
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
]);

/**
 * Calls that leave the failure somewhere the run reads: a tally, a stamp on
 * the item's own row, or a result collection (`steps.push`, `failed.set`).
 */
const RECORDING_CALL =
  /^(fail|push|set|add|stamp\w*|record\w*Failure|record\w*Failed|mark\w*Failed)$/;

function isFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** The catch sits in a loop body of its own function. */
function insideLoop(node: ts.Node): boolean {
  for (let at = node.parent; at; at = at.parent) {
    if (isFunctionBoundary(at)) return false;
    if (LOOP_KINDS.has(at.kind)) return true;
  }
  return false;
}

function enclosingFunctionName(node: ts.Node): string {
  for (let at = node.parent; at; at = at.parent) {
    if (
      (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) &&
      at.name
    ) {
      return at.name.getText();
    }
    if (
      (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
      ts.isVariableDeclaration(at.parent) &&
      ts.isIdentifier(at.parent.name)
    ) {
      return at.parent.name.text;
    }
  }
  return "<module>";
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** The catch leaves a trace: rethrow, return, count or stamp. */
function records(block: ts.Block): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // A nested function is its own story: its body runs later, if at all.
    if (node !== block && isFunctionBoundary(node)) return;
    if (ts.isThrowStatement(node) || ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      node.operator === ts.SyntaxKind.PlusPlusToken
    ) {
      found = true;
      return;
    }
    // An increment, or an assignment the code after the loop reads (the
    // last error of a retry loop, a fallback a later check decides on).
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    ) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && RECORDING_CALL.test(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(block);
  return found;
}

interface Swallow {
  key: string;
  at: string;
}

function swallowsIn(rel: string, text: string): Swallow[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const out: Swallow[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && insideLoop(node) && !records(node.block)) {
      const line =
        source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      out.push({
        key: `${rel}:${enclosingFunctionName(node)}`,
        at: `${rel}:${line}`,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function productionFiles(): string[] {
  return ROOTS.flatMap((root) =>
    walkSourceFiles(join(process.cwd(), "src/lib", root), { floor: 1 })
      .filter((rel) => !rel.includes("__tests__/") && !rel.endsWith(".d.ts"))
      .map((rel) => `src/lib/${root}/${rel}`),
  );
}

describe("a per-item failure in a background pass is counted", () => {
  const files = requireFloor("background pass files", productionFiles(), 300);
  const swallows = files.flatMap((file) =>
    swallowsIn(file, readSourceText(file)),
  );

  it("finds every catch inside a loop that only logs", () => {
    // The guard reads real catches: there are many in loops that do count.
    const inLoops = files.reduce((n, file) => {
      const source = ts.createSourceFile(
        file,
        readSourceText(file),
        ts.ScriptTarget.Latest,
        true,
      );
      let count = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isCatchClause(node) && insideLoop(node)) count += 1;
        ts.forEachChild(node, visit);
      };
      visit(source);
      return n + count;
    }, 0);
    expect(inLoops).toBeGreaterThan(20);

    expect(
      swallows
        .filter((s) => !Object.hasOwn(ALLOWED, s.key))
        .map((s) => `${s.at} (${s.key})`),
      "these catches inside a loop only log. Count the item (a " +
        "`FanOutTally`, an increment the run reports), stamp its own status, " +
        "rethrow, or list the function in ALLOWED with the reason",
    ).toEqual([]);
  });

  it("lists no function whose swallowing catch is gone", () => {
    const live = new Set(swallows.map((s) => s.key));
    expect(Object.keys(ALLOWED).filter((key) => !live.has(key))).toEqual([]);
  });

  it("catches a catch that only logs, and passes one that counts", () => {
    const logs = `
      async function pass(items: string[]) {
        for (const item of items) {
          try { await send(item); } catch (err) { warn(err); }
        }
      }`;
    const counts = `
      async function pass(items: string[], tally: { fail(): void }) {
        for (const item of items) {
          try { await send(item); } catch (err) { tally.fail(); warn(err); }
        }
      }`;
    expect(swallowsIn("probe.ts", logs).map((s) => s.key)).toEqual([
      "probe.ts:pass",
    ]);
    expect(swallowsIn("probe.ts", counts)).toEqual([]);
  });
});
