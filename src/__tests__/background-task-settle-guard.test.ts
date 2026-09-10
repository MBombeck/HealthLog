/**
 * Background work started inside a test must not outlive it.
 *
 * Several paths in this codebase start a promise, return without awaiting it,
 * and log on the detached handle so the failure is not swallowed. Vitest
 * replaces `globalThis.console` with a sink that forwards every write to the
 * main thread as an `onUserConsoleLog` RPC call, awaits the calls in flight
 * when it tears a test file down, and then REJECTS whatever was started after
 * that point. A detached write that lands in that window fails the whole run
 * with `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was
 * pending` — blamed on the file the worker was tearing down, which is not the
 * test that started the work and need not contain a console call of its own.
 *
 * Both suite setups therefore await `settleBackgroundTasks()` after every
 * test, and that only works while the detached paths keep registering what
 * they start.
 *
 * These are tripwires, not proofs. The sweep below matches a detached
 * `.catch()` / `.then()` whose handler writes to the console — the shape that
 * actually produced the failure. A background path that logs some other way,
 * or that logs from a callee rather than from the handler, is invisible to it.
 *
 * It was narrower than that until the window below was widened. An
 * eight-line handler window and a five-line registration preamble were both
 * measured against the sites that existed when the guard was written, and
 * both cut through real code: the console write in `mood-rollups.ts` sits
 * nine lines into its handler, so the sweep never saw the one detached
 * `Promise.all` in the tree that was genuinely unregistered, and the
 * registration in `fire-and-forget.ts` sits BELOW its handler rather than
 * above it, so a site that is correct read as a violation. The window now
 * spans a plausible handler body and registration counts wherever it wraps
 * the statement — above the handle or on the line that files the settled
 * result.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import {
  pendingBackgroundTaskCount,
  settleBackgroundTasks,
  trackBackgroundTask,
} from "@/lib/logging/background-tasks";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/**
 * Detached console writers that deliberately stay unregistered.
 *
 * `cli/mcp-stdio.ts` is a process entrypoint: its `main().catch(...)` is the
 * top-level failure handler and there is no test that runs it, so there is
 * nothing for a registry to hold. `jobs/boss-instance.ts` awaits its handle —
 * the matcher sees the `console` call in the following lines, not a detached
 * promise.
 */
const UNREGISTERED_BY_DESIGN = new Set([
  "cli/mcp-stdio.ts",
  "lib/jobs/boss-instance.ts",
]);

/** Every non-test source file under `src/`, minus the generated Prisma client. */
function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((rel) => !rel.startsWith("generated/"))
    .filter((rel) => !rel.includes("__tests__"))
    .filter((rel) => !rel.endsWith(".test.ts") && !rel.endsWith(".test.tsx"));
}

/**
 * How far past the `.catch(` / `.then(` line a handler's console write still
 * counts as this handler's. Twenty lines covers every handler body in the
 * tree with room to spare; eight did not.
 */
const HANDLER_WINDOW = 20;

const registers = (text: string) => /trackBackgroundTask\(/.test(text);

/**
 * The source lines that open a call still unclosed at the start of `line` —
 * the chain of enclosing calls the handler sits inside, innermost last.
 *
 * Paren counting is a coarse reading of TypeScript: a `(` inside a string or a
 * comment counts like any other. That costs nothing here, because the question
 * asked of the result is only whether one of those lines names
 * `trackBackgroundTask`, and a stray paren can at worst widen the chain by a
 * line that does not.
 */
function enclosingOpenCallLines(source: string, line: number): string[] {
  const lines = source.split("\n");
  const open: number[] = [];
  for (let i = 0; i < line - 1; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "(") open.push(i);
      else if (ch === ")") open.pop();
    }
  }
  return open.map((i) => lines[i]);
}

/** Lines starting a `.catch()` / `.then()` whose handler writes to the console. */
function consoleWritingHandlers(): { file: string; line: number }[] {
  const found: { file: string; line: number }[] = [];
  for (const rel of sourceFiles()) {
    const lines = readFileSync(join(SRC, rel), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!/\.(catch|then)\(/.test(line)) return;
      const handler = lines.slice(index, index + HANDLER_WINDOW).join("\n");
      if (!/console\.(log|warn|error|info|debug|trace)\(/.test(handler)) return;
      found.push({ file: rel, line: index + 1 });
    });
  }
  return found;
}

describe("background-task settle contract", () => {
  it("registers an in-flight task and drains it on settle", async () => {
    let release: () => void = () => {};
    const task = new Promise<void>((resolve) => {
      release = resolve;
    });

    trackBackgroundTask(task);
    expect(pendingBackgroundTaskCount()).toBe(1);

    let settled = false;
    const settling = settleBackgroundTasks().then(() => {
      settled = true;
    });

    // Settle must not resolve ahead of the task it is waiting on — that is the
    // whole reason the registry exists.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release();
    await settling;
    expect(settled).toBe(true);
    // And nothing is retained once the task is done.
    expect(pendingBackgroundTaskCount()).toBe(0);
  });

  it("registers what fireAndForget starts", async () => {
    let release: () => void = () => {};
    fireAndForget(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
      { action: "guard.background.registered" },
    );
    expect(pendingBackgroundTaskCount()).toBe(1);

    release();
    await settleBackgroundTasks();
    expect(pendingBackgroundTaskCount()).toBe(0);
  });

  it("also awaits work a settling task starts itself", async () => {
    let innerDone = false;

    fireAndForget(
      Promise.resolve().then(() => {
        fireAndForget(
          new Promise<void>((resolve) =>
            setTimeout(() => {
              innerDone = true;
              resolve();
            }, 10),
          ),
          { action: "guard.background.cascade.inner" },
        );
      }),
      { action: "guard.background.cascade.outer" },
    );

    await settleBackgroundTasks();
    expect(innerDone).toBe(true);
    expect(pendingBackgroundTaskCount()).toBe(0);
  });

  it("keeps every detached console writer registered", () => {
    const sites = consoleWritingHandlers();

    // An empty sweep must not read as a pass: if the matcher stops finding the
    // shape it is the matcher that broke, not the tree that got clean. Pinned
    // below the five sites that exist today, so removing one legitimately does
    // not trip a guard that is about the sweep being alive, not about freezing
    // a count.
    expect(sites.length).toBeGreaterThanOrEqual(3);

    const unregistered = sites.filter(({ file, line }) => {
      if (UNREGISTERED_BY_DESIGN.has(file)) return false;
      const source = readFileSync(join(SRC, file), "utf8");
      // Registered either by wrapping the handle — `trackBackgroundTask(` is
      // then one of the calls still open where the handler starts, however
      // many lines above that is — or by filing the settled handle just after
      // the handler closes. Both shapes are in the tree; a fixed window above
      // the match saw neither reliably.
      if (enclosingOpenCallLines(source, line).some(registers)) return false;
      const lines = source.split("\n");
      const trailer = lines
        .slice(line, line + HANDLER_WINDOW + 5)
        .filter((l) => registers(l));
      return trailer.length === 0;
    });

    expect(
      unregistered.map(({ file, line }) => `src/${file}:${line}`),
      "a detached promise logs to the console without registering — wrap the " +
        "handled handle in trackBackgroundTask() so the suite can await it",
    ).toEqual([]);
  });

  it("keeps the settle hook wired into both suite setups", () => {
    for (const setup of [
      "vitest.setup.ts",
      join("tests", "integration", "environment-setup.ts"),
    ]) {
      const source = readFileSync(join(ROOT, setup), "utf8");
      expect(
        source.includes("settleBackgroundTasks"),
        `${setup} no longer awaits background tasks after each test`,
      ).toBe(true);
    }
  });
});
