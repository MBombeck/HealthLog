/**
 * Structural guard: "this record has a live Wallet pass" has one rule,
 * `walletPassState` and its filter twin `livePassWhere`, both in
 * `src/lib/emergency-card/wallet-pass/void.ts`.
 *
 * The state said `expired` and the card offered a new pass, while the
 * creating POST asked a second rule (a WALLET link with `revokedAt: null`,
 * no expiry) and answered 409. Nothing ended an expired link, so whoever
 * picked an expiry was left with no way back. Four more copies of the
 * filter, all without expiry, decided the sweep, the refresh after a card
 * write, the ready push and the web service.
 *
 * Here, over every production file under `src/lib` and `src/app`:
 *
 *   1. a pass read as live by its stamps (`voidedAt === null`, the pair
 *      `voidedAt: null, link: { revokedAt: null`, or a WALLET link with
 *      `revokedAt: null`) appears only in `void.ts`, the rule, and in
 *      `service.ts`, whose withdrawal stamps what is not stamped yet;
 *   2. `walletPassState(` is called only where listed;
 *   3. the ready push decides from the resolution `/api/auth/me` publishes
 *      (`resolveEmergencyWalletApple`), never from a second reading of the
 *      signer or the pass.
 *
 * Every matcher is whitespace-tolerant and asserts a non-zero count.
 */
import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceFolder,
  requireFloor,
  stripComments,
} from "./helpers/source-files";

const RULE = "lib/emergency-card/wallet-pass/void.ts";
const SERVICE = "lib/emergency-card/wallet-pass/service.ts";

function production(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [root, floor] of [
    ["src/lib", 1500],
    ["src/app", 500],
  ] as const) {
    for (const [rel, text] of readSourceFolder(root, {
      floor,
      include: (r) =>
        !r.includes("__tests__") &&
        !/\.test\.tsx?$/.test(r) &&
        !r.startsWith("generated/"),
    })) {
      out.push([`${root.slice(4)}/${rel}`, stripComments(text)]);
    }
  }
  return out;
}

const FILES = production();

function matches(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const [file, code] of FILES) {
    for (const _ of code.matchAll(pattern)) found.push(file);
  }
  return found;
}

describe("a live Wallet pass has one rule", () => {
  it("reads a pass as live by its stamps only in the rule", () => {
    const found = matches(
      new RegExp(
        [
          String.raw`\bvoidedAt\s*===\s*null`,
          String.raw`\blink\s*\.\s*revokedAt\s*===\s*null`,
          String.raw`\bvoidedAt\s*:\s*null\s*,\s*link\s*:\s*\{\s*revokedAt\s*:\s*null`,
          String.raw`\brevokedAt\s*:\s*null\s*,\s*purpose\s*:\s*"WALLET"`,
          String.raw`\bpurpose\s*:\s*"WALLET"\s*,\s*revokedAt\s*:\s*null`,
        ].join("|"),
        "g",
      ),
    );
    requireFloor("live-by-stamp reads", found, 2);
    expect(found).toContain(RULE);
    expect(
      [...new Set(found.filter((f) => f !== RULE && f !== SERVICE))].sort(),
    ).toEqual([]);
  });

  it("calls walletPassState only where listed", () => {
    const found = matches(/\bwalletPassState\s*\(/g);
    requireFloor("walletPassState( calls", found, 3);
    expect([...new Set(found)].sort()).toEqual([
      // The fetch re-checks what a live pass rests on.
      "app/api/wallet/apple/v1/passes/[passTypeId]/[serial]/route.ts",
      // The summary `/api/auth/me` and the card read, and the signed pass.
      SERVICE,
      RULE,
      // A refresh of an ended pass is not throttled.
      "lib/jobs/wallet-pass.ts",
    ]);
  });

  it("filters live passes through livePassWhere", () => {
    for (const [file, anchor] of [
      ["src/lib/emergency-card/wallet-pass/service.ts", "hasLiveWalletPass"],
      ["src/lib/emergency-card/wallet-pass/queues.ts", "enqueueWalletRefresh"],
      [
        "src/lib/emergency-card/wallet-pass/ready-push.ts",
        "runWalletReadyPushPass",
      ],
      ["src/lib/jobs/wallet-pass.ts", "handleWalletPassSweep"],
    ] as const) {
      expect(stripComments(readSource(file, anchor))).toMatch(
        /\blivePassWhere\s*\(/,
      );
    }
    // The creating POST asks the rule, and replaces an expired pass.
    const post = stripComments(
      readSource("src/app/api/emergency-card/wallet/apple/route.ts", "POST"),
    );
    expect(post).toMatch(/\bhasLiveWalletPass\s*\(/);
    expect(post).toMatch(/\bvoidExpiredWalletPasses\s*\(/);
  });
});

describe("the ready push reads the state /api/auth/me publishes", () => {
  const ready = stripComments(
    readSource(
      "src/lib/emergency-card/wallet-pass/ready-push.ts",
      "sendWalletReadyPush",
    ),
  );

  it("resolves the record's Wallet state once, with the pass it read", () => {
    expect(ready).toMatch(
      /\bresolveEmergencyWalletApple\s*\(\s*\{[^}]*\bpass\b/,
    );
    expect(ready).toMatch(/\bapple\s*\.\s*state\s*!==\s*"available"/);
    expect(ready).toMatch(/\bapple\s*\.\s*pass\s*\?\.\s*state\s*!==\s*"live"/);
  });

  it("has no reading of its own of the signer, the origin or the pass state", () => {
    expect(ready).not.toMatch(
      /\b(?:walletPassState|walletSignerReadiness|walletUnavailableReason|isHttpsOrigin|relayRefusal|relayUsable)\b/,
    );
  });

  it("is the same resolver /api/auth/me publishes", () => {
    const me = stripComments(
      readSource("src/lib/auth/me-payload.ts", "emergencyCardBlock"),
    );
    expect(me).toMatch(/\bresolveEmergencyWalletApple\s*\(/);
  });
});
