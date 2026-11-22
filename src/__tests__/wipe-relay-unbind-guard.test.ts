/**
 * A wipe that deletes devices tells the push relay.
 *
 * "Delete all data" removed the account's `Device` rows through the wipe
 * model list and left the relay holding their bindings to this instance;
 * account deletion queued the unbinds, the wipe did not. Every route that
 * walks a wipe list which includes `Device` must queue them in the same
 * transaction (`queueRelayUnbindsForAccount`). The sweep has a floor (the
 * user wipe and the admin wipe), so a matcher that finds nothing fails.
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

describe("wipe routes and the push relay", () => {
  it("wipe the devices", () => {
    expect(WIPE_MODELS).toContain("Device");
    expect(ADMIN_WIPE_MODELS).toContain("Device");
  });

  it("queue the relay unbinds", () => {
    const wipes = walkSourceFiles(SRC, { floor: 3000 })
      .filter((p) => p.startsWith("app/") && p.endsWith("/route.ts"))
      .filter((p) =>
        WALKS_A_WIPE.test(stripComments(readSourceText(join(SRC, p)))),
      );
    expect(wipes.length).toBeGreaterThanOrEqual(2);
    const missing = wipes.filter(
      (p) =>
        !/\bqueueRelayUnbindsForAccount\s*\(/.test(
          stripComments(readSourceText(join(SRC, p))),
        ),
    );
    expect(missing).toEqual([]);
  });
});
