/**
 * A module gate on a page decides from the RECORD's map, never from "am I a
 * delegate".
 *
 * The six surfaces below each resolve one module before they render, and each
 * of them used to read `inSharedRecord || user?.modules?.X`. The prefix was
 * right when it was written: `GET /api/auth/me` published the ACTOR's module
 * map, so a delegate's own preferences would have closed a page in somebody
 * else's record. Since the map became the record's, masked to what the grant
 * opens, the same prefix fails open in the other direction — the navigation
 * correctly drops the entry while a typed URL still renders the page for a
 * record whose owner switched the module off.
 *
 * A structural check rather than a render, because the property is about the
 * EXPRESSION: there is no way to reach these pages in a unit test without
 * standing up the auth query, the router and the shell, and the thing that
 * regressed is one `||`. The matcher asserts it found each gate before it
 * asserts anything about it, so an expression that moves or is renamed fails
 * loudly instead of passing on an empty match.
 *
 * Its limit, stated: it holds these six files and knows nothing about a
 * seventh. A new module page reads none of this.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** file → the gate assignment's left-hand side. */
const GATES: ReadonlyArray<[string, string]> = [
  ["src/app/vaccinations/page.tsx", "enabled"],
  ["src/app/cycle/page.tsx", "enabled"],
  ["src/app/mental-wellbeing/page.tsx", "enabled"],
  ["src/app/illness/page.tsx", "enabled"],
  ["src/app/illness/[id]/page.tsx", "enabled"],
  ["src/components/documents/documents-view.tsx", "moduleEnabled"],
];

describe("a page's module gate reads the record's map alone", () => {
  it.each(GATES)("%s", (file, binding) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    const match = source.match(
      new RegExp(`const ${binding}\\s*=\\s*([^;]+);`, "s"),
    );
    expect(match, `no \`const ${binding} = …\` gate found in ${file}`).not.toBe(
      null,
    );
    const expression = match![1];
    // It has to be a module gate at all — otherwise the assertion below would
    // pass on any expression that simply does not mention sharing.
    expect(
      expression,
      `${binding} in ${file} is not the module gate`,
    ).toContain("modules");
    expect(
      expression,
      `${file} widens its module gate for a delegate; the record's masked map already answers for both cases`,
    ).not.toContain("inSharedRecord");
  });
});
