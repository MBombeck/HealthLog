/**
 * Structural guard: "may this server use the relay for X now" has one home,
 * `relayRefusal` / `relayUsable` / `relayRoutes` in
 * `src/lib/push-relay/relay-state.ts`.
 *
 * It had six. Wallet asked for `state === "ok"` while the signer asked for
 * "not revoked, suspended or deleting", so a `429` on the push path
 * (`degraded`, paused) turned Wallet off with `409` while the signer would
 * have signed. Routing asked for an instance id alone, the outbox for the
 * id and a closed breaker, the status check for the id, the breaker, the
 * state and the pause. Each was right for its caller on the day it was
 * written and none agreed with the next.
 *
 * Here, over every production file under `src/lib` and `src/app`:
 *
 *   1. the breaker (`isCircuitOpen(`) is read only by the breaker itself,
 *      by `registration.ts`, which moves it, and by the rule;
 *   2. the relay's last status about Wallet signing (`.wallet?.sign`) only
 *      by the rule and by `registration.ts`, which stores it and announces
 *      the change;
 *   3. a registration state that ends or suspends the instance
 *      (`"revoked"`, `"suspended"`, `"deleting"`) only by the rule and by
 *      `registration.ts`;
 *   4. a push pause compared with the clock only where listed;
 *   5. the instance id as a yes/no only where listed, each for a reason
 *      that is not "may I call the relay now";
 *   6. the callers that decide it read the rule.
 *
 * Every matcher is whitespace-tolerant and asserts a non-zero count, so a
 * matcher that drifted from the code fails instead of passing.
 */
import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceFolder,
  requireFloor,
  stripComments,
} from "./helpers/source-files";

const HOME = "lib/push-relay/relay-state.ts";

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

function outside(found: string[], allowed: readonly string[]): string[] {
  return [...new Set(found.filter((f) => !allowed.includes(f)))].sort();
}

describe("relay usability has one home", () => {
  it("reads the breaker only in the breaker, the registration and the rule", () => {
    const found = matches(/\bisCircuitOpen\s*\(/g);
    requireFloor("isCircuitOpen( calls", found, 3);
    expect(found).toContain(HOME);
    expect(
      outside(found, [
        HOME,
        "lib/push-relay/circuit.ts",
        "lib/push-relay/registration.ts",
      ]),
    ).toEqual([]);
  });

  it("reads the relay's Wallet signing only in the rule and the registration", () => {
    const found = matches(/\.\s*wallet\s*\??\.\s*sign\b/g);
    requireFloor(".wallet.sign reads", found, 2);
    expect(found).toContain(HOME);
    expect(outside(found, [HOME, "lib/push-relay/registration.ts"])).toEqual(
      [],
    );
  });

  it("reads an ended or suspended instance only in the rule and the registration", () => {
    const found = matches(
      /\.\s*state\s*[!=]==?\s*"(?:revoked|suspended|deleting)"|\bnew\s+Set\(\s*\[\s*"(?:revoked|suspended|deleting)"/g,
    );
    requireFloor("ended or suspended state reads", found, 3);
    expect(found).toContain(HOME);
    expect(outside(found, [HOME, "lib/push-relay/registration.ts"])).toEqual(
      [],
    );
  });

  it("compares a push pause with the clock only where listed", () => {
    const found = matches(/\.\s*pausedUntil\s*(?:>|<|&&)/g);
    requireFloor("pausedUntil comparisons", found, 2);
    expect([...new Set(found)].sort()).toEqual([
      // A registration the relay refused waits out its pause before the
      // minute pass registers again: no instance yet, so no rule to ask.
      "lib/push-relay/maintenance.ts",
      HOME,
    ]);
  });

  it("reads the instance id as a yes/no only where listed", () => {
    const found = matches(
      /!\s*[\w.?]*\binstanceId\b|\binstanceId\s*(?:&&|\|\||!==?\s*null|===?\s*null)|Boolean\(\s*[\w.?]*\binstanceId\s*\)/g,
    );
    requireFloor("instance id gates", found, 10);
    expect([...new Set(found)].sort()).toEqual([
      // The admin key rotation answers 409 for a server never registered.
      "app/api/admin/push-relay/rotate-key/route.ts",
      // Published as `registered` on the admin card and on /me.
      "lib/push-relay/admin-status.ts",
      // A binding statement names this server's instance, or not.
      "lib/push-relay/binding.ts",
      "lib/push-relay/capability.ts",
      // The instance key needs an instance to rotate.
      "lib/push-relay/instance-key.ts",
      // A Live Activity statement names this server's instance, or not.
      "lib/push-relay/live-activity-registration.ts",
      // The minute pass registers a server that has no instance yet.
      "lib/push-relay/maintenance.ts",
      "lib/push-relay/operator-switch.ts",
      "lib/push-relay/registration.ts",
      HOME,
      // No relay holds a binding of a server that never registered.
      "lib/push-relay/unbind-queue.ts",
    ]);
  });

  it("is what every relay decision reads", () => {
    const callers: Array<[string, RegExp]> = [
      ["src/lib/push-relay/route-device.ts", /\brelayRoutes\s*\(/],
      ["src/lib/push-relay/relay-send.ts", /\brelayRefusal\s*\(/],
      ["src/lib/push-relay/wallet.ts", /\brelayUsable\s*\(/],
      [
        "src/lib/emergency-card/wallet-pass/availability.ts",
        /\brelayRefusal\s*\(/,
      ],
      ["src/lib/push-relay/maintenance.ts", /\brelayUsable\s*\(/],
      ["src/lib/push-relay/unbind-queue.ts", /\brelayUsable\s*\(/],
      ["src/lib/push-relay/capability.ts", /\brelayRefusal\s*\(/],
      ["src/lib/push-relay/live-activity.ts", /\brelayRoutes\s*\(/],
    ];
    for (const [file, call] of callers) {
      expect(stripComments(readSource(file, "relay-state"))).toMatch(call);
    }
    // The Live Activity rule builds on the routing rule, never on its own.
    const la = stripComments(
      readSource(
        "src/lib/push-relay/live-activity-eligibility.ts",
        "laRelayBlock",
      ),
    );
    expect(la).toMatch(/\brelayReachable\s*\(/);
    expect(
      stripComments(
        readSource("src/lib/push-relay/route-device.ts", "relayReachable"),
      ),
    ).toMatch(/export function relayReachable[\s\S]*?\brouteFor\s*\(/);
  });
});
