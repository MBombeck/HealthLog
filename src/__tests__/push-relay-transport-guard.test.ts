/**
 * Structural guard over the push relay client (`src/lib/push-relay/`).
 *
 * 1. Nothing the relay answers deletes a device row except Apple's
 *    `Unregistered`. The relay path's one deletion sits in
 *    `releaseUnregistered`, behind the server-side cap; the sealed direct path
 *    deletes only on the same reason. Any other `device.delete*` in the folder
 *    fails here.
 * 2. Relay failures never touch the notification channel: the folder imports
 *    no channel-state mutation. The one rule for a relay failure that reaches
 *    the dispatcher (`relayTransport`) lives in `channel-state.ts` and is
 *    pinned there too.
 * 3. The envelope sealer takes no ephemeral key: no function signature under
 *    the folder names one, and the only key generation inside `sealPadded` is
 *    its own.
 *
 * Every matcher asserts a non-zero count, so a guard that matches nothing
 * fails instead of passing.
 */
import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceFolder,
  requireFloor,
  stripComments,
} from "./helpers/source-files";

const production = () =>
  readSourceFolder("src/lib/push-relay", {
    floor: 10,
    include: (rel) => !rel.includes("__tests__"),
  }).map(([rel, text]) => [rel, stripComments(text)] as const);

describe("push relay transport guard", () => {
  it("deletes a device only on Unregistered", () => {
    const deletions: string[] = [];
    for (const [rel, code] of production()) {
      for (const m of code.matchAll(
        /\b(?:device\s*\.\s*delete(?:Many)?|deleteDeviceRows)\s*\(|\bforgetGoneRegistrations\s*\(\s*"device"/g,
      )) {
        const before = code.slice(0, m.index);
        const fn = [
          ...before.matchAll(/(?:async\s+)?function\s+(\w+)/g),
        ].pop()?.[1];
        deletions.push(`${rel}::${fn ?? "?"}`);
      }
    }
    requireFloor("device deletions under push-relay", deletions, 2);
    expect(deletions.sort()).toEqual([
      "relay-send.ts::releaseUnregistered",
      "route-device.ts::sendSealed",
    ]);
    const direct = readSource(
      "src/lib/push-relay/route-device.ts",
      "sendSealed",
    );
    expect(direct).toMatch(
      /direct\.reason\s*===\s*"Unregistered"\)\s*\{\s*await\s+forgetGoneRegistrations\(\s*"device"/,
    );
    const relay = readSource(
      "src/lib/push-relay/relay-send.ts",
      "releaseUnregistered",
    );
    // Only a 410 `unregistered` reads as gone, and only that reading
    // releases the device.
    expect(relay).toMatch(
      /status\s*===\s*410\s*&&\s*code\s*===\s*"unregistered"\)\s*return\s+"unregistered"/,
    );
    expect(relay).toMatch(
      /kind\s*===\s*"unregistered"\)\s*\{\s*await\s+releaseUnregistered/,
    );
  });

  it("never records a channel failure for a relay failure", () => {
    const files = production();
    requireFloor("push-relay files", files, 10);
    for (const [rel, code] of files) {
      expect(code, rel).not.toMatch(
        /recordChannel(?:TransientFailure|HardReject|NoRecipient)|channel-state/,
      );
    }
    const state = readSource(
      "src/lib/notifications/channel-state.ts",
      "recordChannelTransientFailure",
    );
    expect(stripComments(state)).toMatch(
      /if\s*\(\s*outcome\.relayTransport\s*\)\s*\{[\s\S]*?return\s*\{\s*autoDisabled:\s*false,\s*nextRetryAt:\s*null\s*\}/,
    );
  });

  it("takes no ephemeral key from any caller", () => {
    const signatures: string[] = [];
    for (const [rel, code] of production()) {
      for (const m of code.matchAll(/function\s+\w+\s*\(([^)]*)\)/g)) {
        signatures.push(`${rel}:${m[1]}`);
      }
    }
    requireFloor("push-relay function signatures", signatures, 30);
    for (const s of signatures) {
      expect(s).not.toMatch(/ephemeral|skE\b|injected/i);
    }
    const hpke = stripComments(
      readSource("src/lib/push-relay/hpke.ts", "export function sealPadded"),
    );
    const seal = hpke.slice(hpke.indexOf("export function sealPadded"));
    expect(seal).toMatch(
      /const ephemeral = generateKeyPairSync\("x25519"\)\.privateKey;/,
    );
    expect(seal).not.toMatch(/input\.\w*ephemeral/i);
  });
});
