/**
 * A quiet source has one truth, and every surface reads it.
 *
 * "This source has gone quiet" used to be decided per surface: the push read
 * the stall stamps itself, the integration card folded the watchdog flag in
 * with its own window check, and the Today rail knew only broken grants, so a
 * source the person was told about by push had no line on the start page.
 * One rule now answers (`src/lib/sync-stall/quiet.ts`, on top of the stall
 * rule in `cadence.ts`), and this guard holds the surfaces to it:
 *
 *   1. every surface that shows a quiet source imports the rule and calls it;
 *   2. the stall stamps (`silentSince`, `healthQuietSince`) are read only by
 *      the rule's own module, the passes that write them, and the card's
 *      resolver, which folds them through `silenceStands`. A new reader has
 *      to come through the rule or be added here with a reason;
 *   3. the stall judgement itself (`judgeStall`) runs only in the passes
 *      that stamp, never on a surface.
 */
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

/** Each surface that shows a quiet source, and the rule it must call. */
const SURFACES: ReadonlyArray<{
  file: string;
  surface: string;
  from: string;
  symbol: string;
}> = [
  {
    file: "src/lib/daily/load-digest.ts",
    surface: "Today rail",
    from: "@/lib/sync-stall/quiet-load",
    symbol: "loadQuietSources",
  },
  {
    file: "src/lib/sync-stall/notice.ts",
    surface: "SYNC_STALLED push",
    from: "./quiet",
    symbol: "iphoneDelivers",
  },
  {
    file: "src/lib/sync-stall/quiet.ts",
    surface: "the rule itself",
    from: "./cadence",
    symbol: "silenceStands",
  },
  {
    file: "src/lib/integrations/connection-health.ts",
    surface: "integration card state",
    from: "@/lib/sync-stall/cadence",
    symbol: "silenceStands",
  },
  {
    file: "src/app/api/integrations/healthkit/route.ts",
    surface: "Apple Health card, per iPhone",
    from: "@/lib/sync-stall/devices",
    symbol: "loadQuietDevices",
  },
];

/** Files that may read the stall stamps, and why. */
const STAMP_READERS: Record<string, string> = {
  "lib/sync-stall/devices.ts": "the iPhone pass writes and clears the stamp",
  "lib/sync-stall/notice.ts": "claims a stamp once per stall",
  "lib/integrations/watchdog.ts": "the watchdog writes and clears the stamp",
  "lib/integrations/watchdog-classify.ts": "the watchdog's pure judgement",
  "lib/integrations/connection-health.ts": "folds it through silenceStands",
  "lib/integrations/connection-health-load.ts": "hands it to the resolver",
  "lib/sync-stall/cadence.ts": "silenceStands, the flag check itself",
  "lib/sync-stall/quiet.ts": "the rule",
  "lib/sync-stall/quiet-load.ts": "the rule's loader",
};

/** Files that may run the stall judgement: the passes that stamp. */
const JUDGES = new Set([
  "lib/sync-stall/cadence.ts",
  "lib/sync-stall/devices.ts",
  "lib/integrations/watchdog-classify.ts",
]);

const isProductSource = (rel: string) =>
  !rel.startsWith("generated/") &&
  !rel.includes("__tests__/") &&
  !/\.test\.tsx?$/.test(rel);

const FILES = walkSourceFiles("src", { floor: 2000 }).filter(isProductSource);

const code = (rel: string) => stripComments(readSourceText(`src/${rel}`), rel);

function importsSymbol(source: string, from: string, symbol: string): boolean {
  const escaped = from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(
    `import\\s*(?:type\\s*)?\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*"${escaped}"`,
  ).test(source);
}

describe("a quiet source has one rule", () => {
  it.each(SURFACES)(
    "$surface ($file) imports $symbol and calls it",
    ({ file, from, symbol }) => {
      const source = stripComments(readSourceText(file), file);
      expect(
        importsSymbol(source, from, symbol),
        `${file} must import ${symbol} from "${from}"`,
      ).toBe(true);
      expect(
        new RegExp(`\\b${symbol}\\s*\\(`).test(source),
        `${file} imports ${symbol} but never calls it`,
      ).toBe(true);
    },
  );

  it("the stall stamps are read only through the rule", () => {
    const readers = FILES.filter((rel) =>
      /\b(?:silentSince|healthQuietSince)\b/.test(code(rel)),
    );
    // A sweep that matches nothing proves nothing: the writers are there.
    expect(readers.length).toBeGreaterThanOrEqual(5);
    const strangers = readers.filter((rel) => !(rel in STAMP_READERS));
    expect(
      strangers,
      "read the quiet sources through @/lib/sync-stall/quiet-load, not the stamps",
    ).toEqual([]);
  });

  it("only the passes that stamp run the stall judgement", () => {
    const judges = FILES.filter((rel) => /\bjudgeStall\s*\(/.test(code(rel)));
    expect(judges.length).toBeGreaterThanOrEqual(2);
    expect(judges.filter((rel) => !JUDGES.has(rel))).toEqual([]);
  });
});
