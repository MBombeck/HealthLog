/**
 * Structural guard: every generation path runs the shared briefing reader
 * before it commits, and every reader of a stored briefing renders through
 * the same one (#1499).
 *
 * A reply that parsed as JSON used to be stored as a success whatever its
 * `dailyBriefing` held. The server validated the loose top level only, the
 * Insights hook ran `dailyBriefingSchema` on the block and dropped it without
 * a word, and the card read "no briefing yet" after a generation that had
 * "succeeded". The fix is one parser (`parseInsightReply`) that runs one gate
 * (`gateBriefingBlocks`) on every reply, and one reader (`readDailyBriefing`)
 * on every stored payload. This guard holds the three in place:
 *
 *   1. The modules that write the cached briefing are named. A new writer
 *      fails here until it is listed, and listing it means routing its reply
 *      through the parser below.
 *   2. Inside the generation modules, every model reply (`….result.content`)
 *      is handed to `parseInsightReply`, first passes and corrective retries
 *      alike. The one exception is the paragraph re-roll, which reads a
 *      single string off its reply and must re-read the merged briefing with
 *      `readDailyBriefing` before it is stored.
 *   3. `parseInsightReply` calls the gate, and no module outside the reader
 *      parses a briefing with the schema directly, so the server and the
 *      card cannot drift onto two definitions again.
 *
 * Its limit, like every guard of this shape: it proves a call exists, not
 * that it sits on every branch. `comprehensive-briefing-gate.test.ts` and the
 * `insights-generate` parity walk prove the behaviour.
 */
import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceFolder,
  stripComments,
} from "./helpers/source-files";

/** Every production source file under `src/`, with its text. */
const SOURCES = readSourceFolder("src", {
  floor: 3000,
  include: (rel) =>
    !rel.startsWith("generated/") &&
    !rel.includes("__tests__") &&
    !rel.endsWith(".test.ts") &&
    !rel.endsWith(".test.tsx"),
});

/** A named file without its comments, anchored on what this guard reads. */
function read(rel: string, anchor: string): string {
  return stripComments(readSource(`src/${rel}`, anchor), rel);
}

/** The files whose code (comments aside) matches `needle`. */
function filesNaming(needle: RegExp): string[] {
  return SOURCES.filter(
    ([rel, text]) => needle.test(text) && needle.test(stripComments(text, rel)),
  )
    .map(([rel]) => rel)
    .sort();
}

/** The modules that commit a generated briefing to the cache. */
const CACHE_WRITERS = [
  "lib/insights/briefing-request/commit.ts",
  "lib/insights/comprehensive-steps.ts",
];

/** The modules that turn a model reply into a payload to commit. */
const GENERATION_MODULES = [
  "lib/insights/briefing-request/generate.ts",
  "lib/insights/briefing-request/grounding.ts",
  "lib/insights/comprehensive-steps.ts",
  "lib/insights/comprehensive-support.ts",
];

/** The one module that may read a reply's text without the parser. */
const REROLL_MODULE = "lib/insights/comprehensive-support.ts";

/** A model reply's text: `result.content`, `retry.result.content`, … */
const REPLY_TEXT = /\b(?:\w+\.)*result\.content\b/g;
/** A reply's text handed straight to the shared parser. */
const PARSED_REPLY_TEXT =
  /\bparseInsightReply\(\s*(?:\w+\.)*result\.content\b/g;

/** The stored-payload readers the card and the snapshots render through. */
const STORED_READERS = [
  "components/insights/use-insights-advisor.ts",
  "lib/dashboard/snapshot.ts",
  "lib/daily/briefing-today-read.ts",
  "lib/insights/briefing-payload.ts",
];

const count = (text: string, re: RegExp) => [...text.matchAll(re)].length;

describe("briefing commit gate guard", () => {
  it("names every module that writes the cached briefing", () => {
    const writers = filesNaming(/\binsightsCacheWrite\s*\(/).filter(
      (rel) => rel !== "lib/insights/cached-text-cipher.ts",
    );
    expect(writers).toEqual(CACHE_WRITERS);
  });

  it("hands every model reply in the generation modules to the shared parser", () => {
    let replies = 0;
    for (const rel of GENERATION_MODULES) {
      const text = read(rel, "result.content");
      const all = count(text, REPLY_TEXT);
      const parsed = count(text, PARSED_REPLY_TEXT);
      replies += all;
      if (rel === REROLL_MODULE) {
        // The re-roll reads one string off its reply; the merged briefing
        // goes back through the reader before it is stored.
        expect(all - parsed, rel).toBe(1);
        expect(text, rel).toMatch(/\breadDailyBriefing\s*\(/);
      } else {
        expect(parsed, `${rel}: a reply read outside parseInsightReply`).toBe(
          all,
        );
      }
    }
    // An empty match set would make the loop above prove nothing.
    expect(replies).toBeGreaterThanOrEqual(7);
  });

  it("runs the gate inside the shared parser", () => {
    const parser = read("lib/insights/insight-reply.ts", "parseInsightReply");
    const body = parser.slice(parser.indexOf("function parseInsightReply"));
    expect(body).toMatch(/\bgateBriefingBlocks\s*\(/);
    const gate = read("lib/ai/briefing-blocks.ts", "gateBriefingBlocks");
    const gateBody = gate.slice(gate.indexOf("function gateBriefingBlocks"));
    expect(gateBody).toMatch(/\breadDailyBriefing\s*\(/);
    expect(gateBody).toMatch(/\breadTrendAnnotations\s*\(/);
  });

  it("renders every stored briefing through the same reader", () => {
    for (const rel of STORED_READERS) {
      expect(read(rel, "readDailyBriefing"), rel).toMatch(
        /\breadDailyBriefing\b/,
      );
    }
    const direct = filesNaming(
      /\b(?:dailyBriefingSchema|trendAnnotationsSchema)\s*\.\s*(?:safeParse|parse)\s*\(/,
    ).filter((rel) => rel !== "lib/ai/briefing-blocks.ts");
    expect(direct).toEqual([]);
  });
});
