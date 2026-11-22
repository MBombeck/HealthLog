/**
 * A background notifier (a component that raises toasts nobody asked for,
 * such as the achievement unlocks) routes every toast through
 * `showInformationalToast`, so it never lands in front of a save's Undo /
 * Edit toast (`src/lib/toast/priority.ts`). Notifiers are named
 * `*-notifier.tsx`; this keeps every one of them, and every future one, on
 * the rule.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/-notifier\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const TOAST_CALL = /\btoast(?:\.(?:success|info|message|warning))?\(/g;

describe("background notifiers yield to action toasts", () => {
  const notifiers = walk(join(ROOT, "src")).map((f) => relative(ROOT, f));

  it("finds the notifiers (the matcher is not blind)", () => {
    expect(notifiers).toContain(
      "src/components/gamification/achievement-unlock-notifier.tsx",
    );
  });

  it.each(notifiers)("%s raises every toast through the queue", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    const toasts = source.match(TOAST_CALL)?.length ?? 0;
    const queued = source.match(/showInformationalToast\(/g)?.length ?? 0;
    expect(queued).toBeGreaterThanOrEqual(toasts);
  });
});
