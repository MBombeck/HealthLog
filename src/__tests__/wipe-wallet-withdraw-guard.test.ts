/**
 * A wipe that deletes Apple Wallet passes withdraws them first (v1.50).
 *
 * "Delete all data" and the admin wipe remove `WalletPass` through the wipe
 * model lists. A pass deleted without being withdrawn stays on the devices
 * that hold it, live-looking, with nothing to tell them. Every route that
 * walks a wipe list including `WalletPass` calls
 * `withdrawWalletPassesBeforeWipe` before its first delete, so the devices
 * get the push while the rows still exist. The sweep has a floor (the user
 * wipe and the admin wipe), so a matcher that finds nothing fails.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ADMIN_WIPE_MODELS, WIPE_MODELS } from "@/lib/data-wipe/wipe-plan";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const WALKS_A_WIPE =
  /\bfor\s*\(\s*const\s+\w+\s+of\s+(ADMIN_WIPE_MODELS|WIPE_MODELS)\b/;
const WITHDRAWS = /\bawait\s+withdrawWalletPassesBeforeWipe\s*\(/;

describe("wipe routes and Apple Wallet passes", () => {
  it("wipe the passes", () => {
    expect(WIPE_MODELS).toContain("WalletPass");
    expect(ADMIN_WIPE_MODELS).toContain("WalletPass");
  });

  it("withdraw them before the first delete", () => {
    const wipes = walkSourceFiles(SRC, { floor: 3000 })
      .filter((p) => p.startsWith("app/") && p.endsWith("/route.ts"))
      .map((p) => ({ p, text: stripComments(readSourceText(join(SRC, p))) }))
      .filter(({ text }) => WALKS_A_WIPE.test(text));
    expect(wipes.length).toBeGreaterThanOrEqual(2);
    const wrong = wipes
      .filter(({ text }) => {
        const withdraw = text.search(WITHDRAWS);
        const tx = text.search(/\bprisma\.\$transaction\s*\(/);
        return withdraw === -1 || tx === -1 || withdraw > tx;
      })
      .map(({ p }) => p);
    expect(wrong).toEqual([]);
  });
});
