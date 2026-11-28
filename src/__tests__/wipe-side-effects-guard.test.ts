/**
 * A wipe tells the outside world before it deletes.
 *
 * "Delete all data" and the admin wipe remove rows through the wipe model
 * lists (`WIPE_MODELS`, `ADMIN_WIPE_MODELS`). Two of those rows stand for
 * something held elsewhere, and deleting them silently leaves it behind:
 *
 *   - `Device`: the relay kept its bindings to this instance. Account
 *     deletion queued the unbinds, the wipe did not. Every wipe route
 *     queues them in the same transaction: `queueRelayUnbindsForAccount`
 *     for one account's rows, `queueRelayUnbindsWhere` for the admin wipe.
 *     `device-delete-unbind-guard.test.ts` covers the other deleters.
 *   - `WalletPass` (v1.50): a pass deleted without being withdrawn stays on
 *     the devices that hold it, live-looking, with nothing to tell them.
 *     Every wipe route awaits `withdrawWalletPassesBeforeWipe` before its
 *     transaction, so the devices get the push while the rows still exist.
 *
 * One row per model. The sweep of wipe routes has a floor (the user wipe
 * and the admin wipe), so a matcher that finds nothing fails.
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
const TRANSACTION = /\bprisma\.\$transaction\s*\(/;

const RULES: Array<{
  model: string;
  call: RegExp;
  /** The call must come before the wipe's transaction opens. */
  beforeTransaction: boolean;
}> = [
  {
    model: "Device",
    call: /\bqueueRelayUnbinds(?:ForAccount|Where)\s*\(/,
    beforeTransaction: false,
  },
  {
    model: "WalletPass",
    call: /\bawait\s+withdrawWalletPassesBeforeWipe\s*\(/,
    beforeTransaction: true,
  },
];

const wipes = walkSourceFiles(SRC, { floor: 3000 })
  .filter((p) => p.startsWith("app/") && p.endsWith("/route.ts"))
  .map((p) => ({ p, text: stripComments(readSourceText(join(SRC, p))) }))
  .filter(({ text }) => WALKS_A_WIPE.test(text));

describe("wipe routes", () => {
  it("are found", () => {
    expect(wipes.length).toBeGreaterThanOrEqual(2);
  });

  it.each(RULES)(
    "wipe $model and call its side effect",
    ({ model, call, beforeTransaction }) => {
      expect(WIPE_MODELS).toContain(model);
      expect(ADMIN_WIPE_MODELS).toContain(model);
      const wrong = wipes
        .filter(({ text }) => {
          const at = text.search(call);
          if (at === -1) return true;
          if (!beforeTransaction) return false;
          const tx = text.search(TRANSACTION);
          return tx === -1 || at > tx;
        })
        .map(({ p }) => p);
      expect(wrong).toEqual([]);
    },
  );
});
