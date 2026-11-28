/**
 * Rules that have exactly one home in the source tree.
 *
 * Each was once decided in several places that disagreed, and each bug
 * looked the same: a second reading of a flag, a stamp or a default beside
 * the rule, right for its caller on the day it was written and wrong the
 * next. One table holds them all, so a new rule of this kind is a row, not
 * a file.
 *
 * Two kinds of row:
 *   - `SWEEPS`: a pattern over every production file under `src` (comments
 *     stripped unless the row says otherwise). Hits outside the allowed
 *     files fail, the home must still be among the hits, and the sweep must
 *     reach its floor, so a matcher that drifted from the code fails instead
 *     of passing.
 *   - `CALLERS`: a named file must call the rule (and must not carry its own
 *     reading of it). Each file is read with an anchor, so a file that was
 *     split fails instead of passing for the wrong reason.
 *
 * Mutation checks: put `fresh: latest.night === userDayKey(now, tz)` back in
 * `sleep-score.ts`, `if (!liveActivityRelayEnabled()) return facts;` at the
 * top of `runLiveActivityRelayPass`, or
 * `const RECOVERY_LADDER = DEFAULT_SOURCE_PRIORITY.recovery;` in
 * `recovery-resolve.ts`, and this goes red.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceFolder,
  requireFloor,
  scanSourceMatches,
  stripComments,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const production = (rel: string) =>
  !/(^|\/)(__tests__|generated)\//.test(rel) && !/\.test\.tsx?$/.test(rel);

const LAST_NIGHT = "lib/sleep/last-night.ts";
const LA_VERDICT = "lib/push-relay/live-activity-eligibility.ts";
const RELAY = "lib/push-relay/relay-state.ts";
const RELAY_REG = "lib/push-relay/registration.ts";
const WALLET_RULE = "lib/emergency-card/wallet-pass/void.ts";
const WALLET_SERVICE = "lib/emergency-card/wallet-pass/service.ts";
const WELLNESS = "lib/insights/derived/wellness-scores.ts";

interface Sweep {
  rule: string;
  pattern: RegExp;
  /** Matches the sweep must find. */
  floor: number;
  /** Distinct files the sweep must find, where the rule is a file count. */
  fileFloor?: number;
  /** Files that must be among the hits (`homeFloor` hits each, default 1). */
  home: string[];
  homeFloor?: number;
  /** Files that may match besides `home`; anything else fails. */
  allowed?: string[];
  /** The exact set of files that match, when the set is a closed inventory. */
  exact?: string[];
  /** Only hits under this prefix fail (the rule is local to a folder). */
  forbiddenUnder?: string;
  keepComments?: boolean;
  /** Folders the sweep covers, when narrower than all of `src`. */
  scope?: string[];
}

const LIB_AND_APP = ["lib/", "app/"];

const SWEEPS: Sweep[] = [
  {
    // A nap counted as last night, a night abroad landed a day off.
    rule: "last night: a night is compared with today only in the rule",
    pattern:
      /\bnight\s*===\s*(?:[\w.]*[tT]oday\w*|userDayKey\s*\()|(?:\b[\w.]*[tT]oday\w*|\buserDayKey\s*\([^;]*?\))\s*===\s*[\w.]*\bnight\b/g,
    floor: 1,
    home: [LAST_NIGHT],
    allowed: [],
  },
  {
    // The digest peeked into the morning's cache cell; the fallback filed
    // the snapshot's newest row by the profile zone's calendar.
    rule: "last night: src/lib/daily reads no day off lastSeenAt and peeks into no cell",
    pattern: /\buserDayKey\s*\([^;]*?lastSeenAt|\bgetAllowStale\s*\(/g,
    floor: 1,
    home: ["lib/cache/server-cache.ts"],
    forbiddenUnder: "lib/daily/",
  },
  {
    // A running Activity stayed on the lock screen after the consent was
    // withdrawn or the switch turned off. Writes, selects and types pass.
    rule: "Live Activity verdict: the switch and the consent are read only in laVerdict",
    pattern:
      /\bliveActivityRelayEnabled\s*\(|\.\s*liveActivityConsentAt\b|\bliveActivityConsentAt\s*:\s*\{/g,
    floor: 3,
    home: [LA_VERDICT],
    homeFloor: 3,
    allowed: [
      "lib/push-relay/config.ts", // the definition of the switch
      "lib/push-relay/capability.ts", // publishes both as they are
    ],
  },
  {
    // The recovery resolver and the doctor report read the default ladder,
    // so a person's own order showed only in the charts.
    rule: "source ladder: the default is read only where it is the default",
    pattern: /(?<![`'"\w])DEFAULT_SOURCE_PRIORITY\b/g,
    floor: 5,
    home: ["lib/validations/source-priority.ts"],
    allowed: [
      "components/settings/sources-section.tsx",
      "lib/integrations/sources-in-use.ts",
    ],
  },
  {
    scope: LIB_AND_APP,
    rule: "relay: the breaker is read only by the breaker, the registration and the rule",
    pattern: /\bisCircuitOpen\s*\(/g,
    floor: 3,
    home: [RELAY],
    allowed: ["lib/push-relay/circuit.ts", RELAY_REG],
  },
  {
    scope: LIB_AND_APP,
    rule: "relay: the Wallet signing status is read only by the rule and the registration",
    pattern: /\.\s*wallet\s*\??\.\s*sign\b/g,
    floor: 2,
    home: [RELAY],
    allowed: [RELAY_REG],
  },
  {
    // Wallet asked for `ok` while the signer asked for "not ended".
    scope: LIB_AND_APP,
    rule: "relay: an ended or suspended instance is read only by the rule and the registration",
    pattern:
      /\.\s*state\s*[!=]==?\s*"(?:revoked|suspended|deleting)"|\bnew\s+Set\(\s*\[\s*"(?:revoked|suspended|deleting)"/g,
    floor: 3,
    home: [RELAY],
    allowed: [RELAY_REG],
  },
  {
    scope: LIB_AND_APP,
    rule: "relay: a push pause is compared with the clock only where listed",
    pattern: /\.\s*pausedUntil\s*(?:>|<|&&)/g,
    floor: 2,
    home: [RELAY],
    exact: [
      // A refused registration waits out its pause; no instance, no rule.
      "lib/push-relay/maintenance.ts",
      RELAY,
    ],
  },
  {
    scope: LIB_AND_APP,
    rule: "relay: the instance id is read as a yes/no only where listed",
    pattern:
      /!\s*[\w.?]*\binstanceId\b|\binstanceId\s*(?:&&|\|\||!==?\s*null|===?\s*null)|Boolean\(\s*[\w.?]*\binstanceId\s*\)/g,
    floor: 10,
    home: [RELAY],
    exact: [
      "app/api/admin/push-relay/rotate-key/route.ts", // 409 when never registered
      "lib/push-relay/admin-status.ts", // published as `registered`
      "lib/push-relay/binding.ts", // a binding names this instance, or not
      "lib/push-relay/capability.ts",
      "lib/push-relay/instance-key.ts", // needs an instance to rotate
      "lib/push-relay/live-activity-registration.ts", // statement names it
      "lib/push-relay/maintenance.ts", // registers a server without one
      "lib/push-relay/operator-switch.ts",
      RELAY_REG,
      RELAY,
      "lib/push-relay/unbind-queue.ts", // no binding without registration
    ],
  },
  {
    // The card offered a new pass while the creating POST answered 409 off
    // a second rule without expiry.
    scope: LIB_AND_APP,
    rule: "Wallet: a pass is read as live by its stamps only in the rule",
    pattern: new RegExp(
      [
        String.raw`\bvoidedAt\s*===\s*null`,
        String.raw`\blink\s*\.\s*revokedAt\s*===\s*null`,
        String.raw`\bvoidedAt\s*:\s*null\s*,\s*link\s*:\s*\{\s*revokedAt\s*:\s*null`,
        String.raw`\brevokedAt\s*:\s*null\s*,\s*purpose\s*:\s*"WALLET"`,
        String.raw`\bpurpose\s*:\s*"WALLET"\s*,\s*revokedAt\s*:\s*null`,
      ].join("|"),
      "g",
    ),
    floor: 2,
    home: [WALLET_RULE],
    // The withdrawal stamps what is not stamped yet.
    allowed: [WALLET_SERVICE],
  },
  {
    scope: LIB_AND_APP,
    rule: "Wallet: walletPassState is called only where listed",
    pattern: /\bwalletPassState\s*\(/g,
    floor: 3,
    home: [WALLET_RULE],
    exact: [
      // The fetch re-checks what a live pass rests on.
      "app/api/wallet/apple/v1/passes/[passTypeId]/[serial]/route.ts",
      WALLET_SERVICE,
      WALLET_RULE,
      // A refresh of an ended pass is not throttled.
      "lib/jobs/wallet-pass.ts",
    ],
  },
  {
    // The push read the stall stamps itself; the card folded the watchdog
    // flag in with its own window check.
    rule: "quiet source: the stall stamps are read only through the rule",
    pattern: /\b(?:silentSince|healthQuietSince)\b/g,
    floor: 5,
    fileFloor: 5,
    home: ["lib/sync-stall/quiet.ts"],
    allowed: [
      "lib/sync-stall/devices.ts", // the iPhone pass writes and clears it
      "lib/sync-stall/notice.ts", // claims a stamp once per stall
      "lib/integrations/watchdog.ts", // writes and clears it
      "lib/integrations/watchdog-classify.ts", // the pure judgement
      "lib/integrations/connection-health.ts", // folds it via silenceStands
      "lib/integrations/connection-health-load.ts", // hands it on
      "lib/sync-stall/cadence.ts", // silenceStands itself
      "lib/sync-stall/quiet-load.ts", // the rule's loader
    ],
  },
  {
    rule: "quiet source: only the passes that stamp run the stall judgement",
    pattern: /\bjudgeStall\s*\(/g,
    floor: 2,
    fileFloor: 2,
    home: [],
    allowed: [
      "lib/sync-stall/cadence.ts",
      "lib/sync-stall/devices.ts",
      "lib/integrations/watchdog-classify.ts",
    ],
  },
  {
    // Each client worked out whose number a score is, and could not tell
    // an Oura recovery from HealthLog's own.
    rule: "wellness origin: nothing outside the engine resolves it",
    pattern: /\bwellnessScoreOrigin\s*\(/g,
    floor: 1,
    home: [WELLNESS],
    exact: [WELLNESS],
    keepComments: true,
  },
];

interface Caller {
  file: string;
  anchor: string;
  must: RegExp[];
  mustNot?: RegExp[];
}

const importOf = (symbol: string, from: string) =>
  new RegExp(
    `import\\s*(?:type\\s*)?\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*"${from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`,
  );
const quietSurface = (file: string, from: string, symbol: string): Caller => ({
  file,
  anchor: symbol,
  must: [importOf(symbol, from), new RegExp(`\\b${symbol}\\s*\\(`)],
});

const CALLERS: Caller[] = [
  // Every relay decision reads the relay rule.
  {
    file: "src/lib/push-relay/route-device.ts",
    anchor: "relay-state",
    must: [/\brelayRoutes\s*\(/],
  },
  {
    file: "src/lib/push-relay/relay-send.ts",
    anchor: "relay-state",
    must: [/\brelayRefusal\s*\(/],
  },
  {
    file: "src/lib/push-relay/wallet.ts",
    anchor: "relay-state",
    must: [/\brelayUsable\s*\(/],
  },
  {
    file: "src/lib/emergency-card/wallet-pass/availability.ts",
    anchor: "relay-state",
    must: [/\brelayRefusal\s*\(/],
  },
  {
    file: "src/lib/push-relay/maintenance.ts",
    anchor: "relay-state",
    must: [/\brelayUsable\s*\(/],
  },
  {
    file: "src/lib/push-relay/unbind-queue.ts",
    anchor: "relay-state",
    must: [/\brelayUsable\s*\(/],
  },
  {
    file: "src/lib/push-relay/capability.ts",
    anchor: "relay-state",
    must: [/\brelayRefusal\s*\(/],
  },
  {
    file: "src/lib/push-relay/live-activity.ts",
    anchor: "relay-state",
    must: [/\brelayRoutes\s*\(/],
  },
  // The Live Activity rule builds on the routing rule, never on its own.
  {
    file: `src/${LA_VERDICT}`,
    anchor: "laRelayBlock",
    must: [/\brelayReachable\s*\(/],
  },
  {
    file: "src/lib/push-relay/route-device.ts",
    anchor: "relayReachable",
    must: [/export function relayReachable[\s\S]*?\brouteFor\s*\(/],
  },
  // Live Wallet passes are filtered through livePassWhere.
  {
    file: `src/${WALLET_SERVICE}`,
    anchor: "hasLiveWalletPass",
    must: [/\blivePassWhere\s*\(/],
  },
  {
    file: "src/lib/emergency-card/wallet-pass/queues.ts",
    anchor: "enqueueWalletRefresh",
    must: [/\blivePassWhere\s*\(/],
  },
  {
    file: "src/lib/emergency-card/wallet-pass/ready-push.ts",
    anchor: "runWalletReadyPushPass",
    must: [/\blivePassWhere\s*\(/],
  },
  {
    file: "src/lib/jobs/wallet-pass.ts",
    anchor: "handleWalletPassSweep",
    must: [/\blivePassWhere\s*\(/],
  },
  // The creating POST asks the rule, and replaces an expired pass.
  {
    file: "src/app/api/emergency-card/wallet/apple/route.ts",
    anchor: "POST",
    must: [/\bhasLiveWalletPass\s*\(/, /\bvoidExpiredWalletPasses\s*\(/],
  },
  // The ready push decides from what /api/auth/me publishes, with no
  // reading of its own of the signer, the origin or the pass state.
  {
    file: "src/lib/emergency-card/wallet-pass/ready-push.ts",
    anchor: "sendWalletReadyPush",
    must: [
      /\bresolveEmergencyWalletApple\s*\(\s*\{[^}]*\bpass\b/,
      /\bapple\s*\.\s*state\s*!==\s*"available"/,
      /\bapple\s*\.\s*pass\s*\?\.\s*state\s*!==\s*"live"/,
    ],
    mustNot: [
      /\b(?:walletPassState|walletSignerReadiness|walletUnavailableReason|isHttpsOrigin|relayRefusal|relayUsable)\b/,
    ],
  },
  {
    file: "src/lib/auth/me-payload.ts",
    anchor: "emergencyCardBlock",
    must: [/\bresolveEmergencyWalletApple\s*\(/],
  },
  // Every surface that shows a quiet source imports the rule and calls it.
  quietSurface(
    "src/lib/daily/load-digest.ts",
    "@/lib/sync-stall/quiet-load",
    "loadQuietSources",
  ),
  quietSurface("src/lib/sync-stall/notice.ts", "./quiet", "iphoneDelivers"),
  quietSurface("src/lib/sync-stall/quiet.ts", "./cadence", "silenceStands"),
  quietSurface(
    "src/lib/integrations/connection-health.ts",
    "@/lib/sync-stall/cadence",
    "silenceStands",
  ),
  quietSurface(
    "src/app/api/integrations/healthkit/route.ts",
    "@/lib/sync-stall/devices",
    "loadQuietDevices",
  ),
];

describe("a rule has one home", () => {
  it.each(SWEEPS)("$rule", (row) => {
    const hits = scanSourceMatches(SRC, row.pattern, {
      fileFloor: 2500,
      matchFloor: row.floor,
      stripComments: !row.keepComments,
      include: (rel) =>
        production(rel) &&
        (!row.scope || row.scope.some((dir) => rel.startsWith(dir))),
    });
    const files = [...new Set(hits.map((h) => h.file))].sort();
    if (row.fileFloor) requireFloor(`${row.rule} files`, files, row.fileFloor);
    for (const home of row.home) {
      expect(
        hits.filter((h) => h.file === home).length,
        `${home} must still hold the rule`,
      ).toBeGreaterThanOrEqual(row.homeFloor ?? 1);
    }
    if (row.exact) {
      expect(files).toEqual([...row.exact].sort());
      return;
    }
    const offenders = hits.filter((h) =>
      row.forbiddenUnder
        ? h.file.startsWith(row.forbiddenUnder)
        : !row.home.includes(h.file) && !row.allowed?.includes(h.file),
    );
    expect(offenders.map((h) => `${h.file}:${h.line}`)).toEqual([]);
  });

  it.each(CALLERS)("$file calls the rule ($anchor)", (row) => {
    const code = stripComments(readSource(row.file, row.anchor), row.file);
    for (const pattern of row.must) expect(code).toMatch(pattern);
    for (const pattern of row.mustNot ?? []) expect(code).not.toMatch(pattern);
  });
});

describe("wellness score origin is resolved where the value is built", () => {
  it("every value the engine builds carries the resolved origin", () => {
    const engine = readSource(`src/${WELLNESS}`, "buildOk<WellnessScoreValue>");
    const builds = engine.match(/buildOk<WellnessScoreValue>\s*\(/g) ?? [];
    const resolved = engine.match(/\.\.\.wellnessScoreOrigin\s*\(/g) ?? [];
    expect(builds.length).toBeGreaterThan(0);
    expect(resolved.length).toBe(builds.length);
  });

  it("the web labels a score from the wire's origin", () => {
    const sources = readSourceFolder("src", {
      floor: 2500,
      include: production,
    });
    const sites = sources.flatMap(([path, text]) =>
      [
        ...text.matchAll(
          /\b(scoreOriginLabelKey|scoreNoFactorsKey)\s*\(\s*([^)]*)\)/g,
        ),
      ]
        .filter((match) => !text.includes(`export function ${match[1]}`))
        .map((match) => ({ path, arg: match[2].trim() })),
    );
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      // `v.origin`, or a local read straight off the value as `origin`.
      expect(site.arg, site.path).toMatch(/(^|\.)origin$/);
    }
  });
});
