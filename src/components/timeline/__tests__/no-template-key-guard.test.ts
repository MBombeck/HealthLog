/**
 * v1.42 (#613) — no template message keys in the timeline or the day view.
 *
 * `t(\`timeline.zoom.${zoom}\`)` reads fine and is invisible to
 * `i18n-call-site-coverage.test.ts`, which only resolves literal keys. A
 * value without its key then ships as the key's raw name. These two trees
 * word codes through the typed maps in `label-keys.ts` instead, which
 * `label-keys.test.ts` resolves value by value; this keeps the template form
 * from coming back.
 *
 * One call stays, by name: `wordKey` words the readiness keys the server
 * sends (a detail, a gap), and it asks the bundle whether the key exists
 * before it uses it, so a key the bundle lacks is left out, never shown.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  stripComments,
  walkSourceFiles,
} from "@/__tests__/helpers/source-files";

const ROOTS = ["src/components/timeline", "src/components/day"] as const;

/** `t(` or `tCount(` whose key is a template literal, across line breaks. */
const TEMPLATE_KEY = /(?<![\w.])(?:t|tCount)\(\s*`/g;

const ALLOWED: Readonly<Record<string, { count: number; why: string }>> = {
  "src/components/timeline/readiness-inventory.tsx": {
    count: 1,
    why: "wordKey checks the server-sent key exists before it words it",
  },
};

function templateCalls(): Map<string, number> {
  const out = new Map<string, number>();
  for (const root of ROOTS) {
    const dir = join(process.cwd(), root);
    for (const rel of walkSourceFiles(dir, { floor: 10 })) {
      if (rel.includes("__tests__")) continue;
      const src = stripComments(readFileSync(join(dir, rel), "utf8"));
      const count = [...src.matchAll(TEMPLATE_KEY)].length;
      if (count > 0) out.set(`${root}/${rel}`, count);
    }
  }
  return out;
}

describe("template message keys", () => {
  it("finds the one sanctioned call, so the matcher is live", () => {
    const calls = templateCalls();
    expect(calls.size).toBeGreaterThanOrEqual(1);
    expect(calls.get("src/components/timeline/readiness-inventory.tsx")).toBe(
      1,
    );
  });

  it("are not used in the timeline or the day view", () => {
    const offenders = [...templateCalls()]
      .filter(([file, count]) => ALLOWED[file]?.count !== count)
      .map(([file, count]) => `${file}: ${count}`);
    expect(offenders).toEqual([]);
  });
});
