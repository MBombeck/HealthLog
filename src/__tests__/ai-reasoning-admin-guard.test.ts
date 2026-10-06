/**
 * v1.41 — the operator's reasoning switch and cap cannot be bypassed.
 *
 * Two halves.
 *
 * Behaviour: `resolveReasoning` is the one decision. With the switch off it
 * answers `off` for the Coach and every background job, whatever the person
 * chose, whoever pays and whatever the provider can do; with it on, no answer
 * is above the cap. Proven exhaustively over the whole input space.
 *
 * Structure: a call carries reasoning only through `CompletionParams.reasoning`.
 * Every production file outside the provider clients that puts that key on a
 * call must take its value from the resolver (`@/lib/ai/reasoning/resolve` or
 * `@/lib/ai/reasoning/controls`). A file that hand-built `{ effort: "high" }`
 * would skip the switch, and goes red here.
 *
 * Its limit: the structural half reads source text for the setter shapes in
 * use (`reasoning: { effort`, `{ reasoning }`, `reasoning: completionReasoning(`,
 * `reasoning: resolveJobReasoning(`). A value laundered through another name
 * slips it; the resolver import is still required of the file that sets it.
 *
 * Mutation check: replace `resolveJobReasoning(...)` in `status-provider.ts`
 * with `{ effort: "high", summaries: false }` and drop the import: red.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BACKGROUND_REASONING_JOBS,
  REASONING_LEVELS,
  REASONING_MAX_EFFORTS,
} from "@/lib/ai/reasoning/levels";
import {
  completionReasoning,
  resolveReasoning,
  type ReasoningSurface,
} from "@/lib/ai/reasoning/resolve";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const SURFACES: ReasoningSurface[] = ["coach", ...BACKGROUND_REASONING_JOBS];

describe("the switch and the cap win, behaviourally", () => {
  const supports = [
    null,
    {
      effort: true,
      summaries: true,
      liveSummaries: true,
      stateRoundTrip: true,
      offIsReal: false,
    },
  ];

  it("off reaches no surface as anything but off", () => {
    let cases = 0;
    for (const surface of SURFACES)
      for (const userPref of REASONING_LEVELS)
        for (const costOwner of ["user", "operator"] as const)
          for (const support of supports) {
            const r = resolveReasoning({
              surface,
              userPref,
              admin: { enabled: false, maxEffort: "high" },
              costOwner,
              support,
            });
            expect(r.effort).toBe("off");
            expect(r.source).toBe("admin_off");
            const sent = completionReasoning(r, surface);
            // A job sends nothing; the Coach sends an explicit off.
            if (surface === "coach") {
              expect(sent).toEqual({ effort: "off", summaries: false });
            } else {
              expect(sent).toBeUndefined();
            }
            cases++;
          }
    expect(cases).toBeGreaterThanOrEqual(100);
  });

  it("no surface ever resolves above the cap", () => {
    for (const surface of SURFACES)
      for (const userPref of REASONING_LEVELS)
        for (const maxEffort of REASONING_MAX_EFFORTS) {
          const r = resolveReasoning({
            surface,
            userPref,
            admin: { enabled: true, maxEffort },
            costOwner: "user",
          });
          expect(REASONING_LEVELS.indexOf(r.effort)).toBeLessThanOrEqual(
            REASONING_LEVELS.indexOf(maxEffort),
          );
        }
  });
});

/** The provider clients map an already-resolved value onto their wire. */
const WIRE_LAYER = (rel: string) =>
  /^lib\/ai\/[a-z-]+-client\.ts$/.test(rel) ||
  rel === "lib/ai/provider-runner.ts" ||
  rel.startsWith("lib/ai/reasoning/");

const SETTERS = [
  /\breasoning\s*:\s*\{\s*effort\b/,
  /\{\s*reasoning\s*\}/,
  /\breasoning\s*:\s*(?:completionReasoning|resolveJobReasoning)\s*\(/,
];

const RESOLVER_IMPORT =
  /from\s+["']@\/lib\/ai\/reasoning\/(?:resolve|controls)["']/;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("every call that carries reasoning took it from the resolver", () => {
  const files = walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    // Client components bind a form field called `reasoning`, not a call.
    .filter((p) => !p.startsWith("components/"))
    .filter((p) => !WIRE_LAYER(p));
  const setters = files.filter((rel) => {
    const code = stripComments(readFileSync(join(SRC, rel), "utf8"));
    return SETTERS.some((re) => re.test(code));
  });

  it("finds the setters (an empty set is a failure, not a pass)", () => {
    expect(setters.length).toBeGreaterThanOrEqual(2);
    expect(setters).toContain("lib/insights/status-provider.ts");
    expect(setters).toContain("lib/insights/briefing-provider.ts");
  });

  it("each one imports the resolver", () => {
    expect(
      setters.filter(
        (rel) => !RESOLVER_IMPORT.test(readFileSync(join(SRC, rel), "utf8")),
      ),
      "A call carries reasoning that did not come from resolveReasoning, so the operator's switch and cap do not reach it.",
    ).toEqual([]);
  });
});

/**
 * The Coach turn receives its level on `TurnInput.reasoningLevel` and carries
 * it through the loop under its own names, which the setter shapes above do
 * not see. The one place that level is decided is the chat route, so the
 * route is pinned: it resolves the level, and it does not fall back to a
 * constant that would skip the operator's switch.
 */
describe("the Coach turn's level comes from the resolver", () => {
  const route = stripComments(
    readFileSync(join(SRC, "app/api/insights/chat/route.ts"), "utf8"),
  );

  it("resolves the level in the chat route", () => {
    expect(route).toMatch(
      /reasoningLevel[^=]*=\s*await\s+resolveCoachTurnReasoningLevel\s*\(/,
    );
    expect(route).toMatch(RESOLVER_IMPORT);
  });

  it("never hands the turn a constant level", () => {
    expect(route).not.toMatch(/\bDEFAULT_REASONING_LEVEL\b/);
    expect(route).not.toMatch(/reasoningLevel\s*:\s*["']/);
  });
});
