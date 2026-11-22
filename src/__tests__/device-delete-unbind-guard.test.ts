/**
 * Structural guard: no device row goes without its relay unbind.
 *
 * A device row that is deleted while the relay still binds its APNs token
 * leaves that token bound to this instance until the relay's own idle
 * expiry. Account deletion queued the unbind; sign-out, the device DELETE
 * routes, a takeover, a duplicate install row and a token Apple reported
 * dead each deleted the row their own way, and only some of them queued it.
 * So the row deletes are frozen to one module, `lib/devices/delete-devices.ts`,
 * which queues the unbind in the same transaction, and every path that drops
 * device rows wholesale (an account delete, a data wipe) queues them first
 * or says why it cannot hold one.
 *
 * Limits, stated plainly. The matchers are textual and whitespace-tolerant;
 * a delete spelt as raw SQL, or through a delegate held in a variable, is
 * invisible to them. The behavioural half lives in the integration tests of
 * each path.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const DEVICE_DELETE = /\bdevice\s*\.\s*(?:delete|deleteMany)\s*\(/;
const ACCOUNT_DELETE = /\buser\s*\.\s*(?:delete|deleteMany)\s*\(/;
const WIPE_LOOP = /\bresolve(?:Global)?WipeDelegate\s*\(/;
const QUEUES = /\bqueueRelayUnbinds(?:ForAccount|Where)\s*\(/;

const SEAM = "lib/devices/delete-devices.ts";
/** Where the wipe delegates are defined; their callers are checked. */
const DELEGATES = "lib/data-wipe/wipe-delegates.ts";

/** Wholesale deleters that cannot hold a device row, and why. */
const EXEMPT: Record<string, string> = {
  "app/api/admin/backups/upload/route.ts":
    "discards the empty account the upload itself just created; nobody signed into it",
};

function code(file: string): string {
  return stripComments(readSourceText(join(SRC, file)));
}

const files = walkSourceFiles(SRC, { floor: 3000 }).filter(
  (file) => !/__tests__|\.test\.|^generated\//.test(file),
);

describe("device rows go with their relay unbind", () => {
  it("deletes device rows in one module only", () => {
    const deleters = files.filter((file) => DEVICE_DELETE.test(code(file)));
    expect(deleters).toEqual([SEAM]);
  });

  it("queues the unbinds before an account delete or a wipe drops devices", () => {
    const wholesale = files.filter(
      (file) =>
        file !== DELEGATES &&
        (ACCOUNT_DELETE.test(code(file)) || WIPE_LOOP.test(code(file))),
    );
    // The two wipes and account deletion at least; an empty set agrees
    // with anything.
    expect(wholesale.length).toBeGreaterThanOrEqual(3);
    expect(
      wholesale.filter((file) => !(file in EXEMPT) && !QUEUES.test(code(file))),
    ).toEqual([]);
  });

  it("lists no exemption that no longer deletes", () => {
    expect(
      Object.keys(EXEMPT).filter(
        (file) => !files.includes(file) || !ACCOUNT_DELETE.test(code(file)),
      ),
    ).toEqual([]);
  });
});
