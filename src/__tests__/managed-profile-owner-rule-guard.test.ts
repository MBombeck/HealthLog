/**
 * The one rule for a managed profile (#1615): its guardian holds the owner's
 * rights, and a route cannot forget them.
 *
 * `requireAuth()` admits a managed profile's guardian under a switch (see
 * `requireAuth` in `src/lib/auth/guards/record.ts`). A route keeps a guardian
 * out only by resolving the caller with `requireSelfAuth()`, with a step-up
 * helper that resolves the caller's own account, or with a cookie-only helper
 * that never reads a switch. Every such route is on the list below with the
 * reason it stays the caller's own. The reasons fall into the three
 * exceptions the rule allows:
 *
 *   identity  - signing in and proving who you are: passkeys, the second
 *               factor, sessions, sign-in devices, password, email, and the
 *               credentials that sign in as an account (API and MCP tokens).
 *               A managed profile has none of its own, and minting one under
 *               a switch would give it one that outlives the guardian's grant.
 *               The push registration of a device belongs here too: the
 *               device is the person's holding it, the guardian's.
 *   account   - deleting or erasing an account, and who may open it. A
 *               profile is deleted, and its guardians are added and removed,
 *               from the guardian's own account under `managed-profiles/**`.
 *   consent   - the decisions that belong to the person once they have a
 *               login of their own: the handover decision after a claim.
 *
 * Adding a route that calls `requireAuth()` needs no entry: the guardian is
 * admitted. Adding one that keeps the guardian out fails here until it is
 * listed with a reason.
 */
import { describe, expect, it } from "vitest";

import { readSource, readSourceFolder } from "./helpers/source-files";

/** At least this many route modules use the owner rule today. */
const OWNER_RULE_FLOOR = 200;

type Reason = {
  readonly kind: "identity" | "account" | "consent";
  readonly why: string;
};

const SELF_ROUTES: Record<string, Reason> = {
  // ── identity: signing in and proving who you are ────────────────────────
  "auth/me/mfa": { kind: "identity", why: "The caller's second factor." },
  "auth/me/sessions": {
    kind: "identity",
    why: "The caller's signed-in sessions.",
  },
  "auth/me/sessions/[id]": {
    kind: "identity",
    why: "Ending one of the caller's sessions.",
  },
  "auth/me/security-activity": {
    kind: "identity",
    why: "The caller's sign-in and security events.",
  },
  "auth/me/devices": {
    kind: "identity",
    why: "The caller's signed-in devices.",
  },
  "auth/me/devices/[id]": {
    kind: "identity",
    why: "Renaming or signing out one of the caller's devices.",
  },
  "auth/me/trusted-devices": {
    kind: "identity",
    why: "Devices that skip the caller's second factor.",
  },
  "auth/me/trusted-devices/[id]": {
    kind: "identity",
    why: "Forgetting one trusted device.",
  },
  "auth/me/passkey-nudge/dismiss": {
    kind: "identity",
    why: "The caller's passkey prompt.",
  },
  "auth/passkeys": { kind: "identity", why: "The caller's passkeys." },
  "auth/passkeys/[id]": {
    kind: "identity",
    why: "Renaming or removing one of the caller's passkeys.",
  },
  "auth/passkey/register-options": {
    kind: "identity",
    why: "Enrolling a passkey on the caller's account.",
  },
  "auth/passkey/register-verify": {
    kind: "identity",
    why: "Enrolling a passkey on the caller's account.",
  },
  "auth/reproof": {
    kind: "identity",
    why: "Proving the caller is at the keyboard.",
  },
  "auth/oidc/reproof": {
    kind: "identity",
    why: "Proving the caller is at the keyboard through single sign-on.",
  },
  "auth/password": {
    kind: "identity",
    why: "The caller's password. A managed profile has none.",
  },
  "auth/profile": {
    kind: "identity",
    why: "Username and email, which single sign-on links an account by. A profile's name and details are edited under managed-profiles/[id].",
  },
  tokens: {
    kind: "identity",
    why: "API tokens sign in as the account. A profile has no sign-in, and a token would outlive the guardian's grant.",
  },
  "tokens/[id]": {
    kind: "identity",
    why: "Revoking or renaming an API token.",
  },
  "tokens/measurements": {
    kind: "identity",
    why: "Minting a measurements token, a credential.",
  },
  "health-connect/pairing": {
    kind: "identity",
    why: "Minting a pairing code for an Android device, which turns into a credential on the caller's own account.",
  },
  "tokens/workouts": {
    kind: "identity",
    why: "Minting a workouts token, a credential.",
  },
  "tokens/documents": {
    kind: "identity",
    why: "Minting a documents token, a credential.",
  },
  "mcp/tokens": { kind: "identity", why: "MCP tokens sign in as the account." },
  "mcp/tokens/[id]": { kind: "identity", why: "Revoking an MCP token." },
  "mcp/connections": {
    kind: "identity",
    why: "OAuth clients holding a credential for the account.",
  },
  "mcp/connections/[id]": {
    kind: "identity",
    why: "Disconnecting one OAuth client.",
  },
  "medications/[id]/api-endpoint": {
    kind: "identity",
    why: "A per-medication ingest token, a credential.",
  },
  devices: {
    kind: "identity",
    why: "Registering the device in the caller's hand for push. The device is the guardian's; a profile's reminders reach the guardian through the guardian notifications.",
  },
  "devices/[id]": {
    kind: "identity",
    why: "Unregistering the caller's device.",
  },
  "devices/me/push-diagnostics": {
    kind: "identity",
    why: "The push state of the caller's device.",
  },
  "notifications/web-push": {
    kind: "identity",
    why: "This browser's push subscription, the caller's.",
  },
  "notifications/web-push/test": {
    kind: "identity",
    why: "A test push to this browser.",
  },
  "notifications/apns/test": {
    kind: "identity",
    why: "A test push to the caller's iPhone.",
  },
  // ── account: deleting it, and who may open it ───────────────────────────
  "settings/account": {
    kind: "account",
    why: "Deleting the caller's own account. A profile is deleted from managed-profiles/[id].",
  },
  "settings/data": {
    kind: "account",
    why: "Erasing the caller's whole history, grants included. A profile is erased with managed-profiles/[id].",
  },
  "account/grants": {
    kind: "account",
    why: "Who may open the caller's account. A profile's guardians are managed under managed-profiles/[id]/guardians.",
  },
  "account/grants/[id]": {
    kind: "account",
    why: "Changing or revoking a grant the caller gave.",
  },
  "account/grants/[id]/accept": {
    kind: "account",
    why: "Accepting a grant made to the caller.",
  },
  "account/grants/[id]/renounce": {
    kind: "account",
    why: "Giving up a grant made to the caller.",
  },
  "managed-profiles": {
    kind: "account",
    why: "Creating a profile, from the guardian's own account.",
  },
  "managed-profiles/[id]": {
    kind: "account",
    why: "Editing or deleting a profile, from the guardian's own account.",
  },
  "managed-profiles/[id]/activity": {
    kind: "account",
    why: "A profile's activity, read from the guardian's own account.",
  },
  "managed-profiles/[id]/guardians": {
    kind: "account",
    why: "A profile's guardians, managed from the guardian's own account.",
  },
  "managed-profiles/[id]/guardians/[grantId]": {
    kind: "account",
    why: "Removing one guardian.",
  },
  "managed-profiles/[id]/handover": {
    kind: "account",
    why: "Handing a profile over to the person, from the guardian's own account.",
  },
  // ── consent: the person's own decision ─────────────────────────────────
  "account/handover-decision": {
    kind: "consent",
    why: "The new owner's own decision on each former guardian after claiming a profile. It needs the person's login, which is the point of the handover.",
  },
};

/** Proof routes that opt into the owner rule (`record: "owner"`). */
const OWNER_PROOF_ROUTES = [
  "export",
  "export/encrypted",
  "export/full-backup",
  "import/health-connect-remote",
  "share-links",
].sort();

/**
 * Route families no account owner has: the instance's administration, and the
 * sign-in routes that run before there is a caller to switch.
 */
const OUT_OF_SCOPE = [
  "admin/",
  "auth/login",
  "auth/native",
  "auth/oidc/native",
  "auth/passkey/login",
];

/** Helpers that resolve the caller's own account under every switch. */
const SELF_HELPERS = [
  "requireSelfAuth",
  "requireCookieAuth",
  "requireFreshMfa",
  "requireFreshMfaIfEnrolled",
  "requireFreshMfaOrElevationIfEnrolled",
];

/** Source with comments removed, so prose about a helper never counts. */
export function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Does `source` call `name`, however the call is spaced or wrapped. */
export function calls(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(code(source));
}

const routes = readSourceFolder("src/app/api", {
  floor: 300,
  include: (rel) => /(^|\/)route\.ts$/.test(rel) && !rel.includes("__tests__"),
}).map(([rel, source]) => ({
  key: rel.split("/").slice(0, -1).join("/"),
  source,
}));

describe("the matchers see what they look for", () => {
  it("find a call across whitespace and line breaks", () => {
    expect(calls("const a = await requireSelfAuth();", "requireSelfAuth")).toBe(
      true,
    );
    expect(calls("await requireSelfAuth\n  (\n);", "requireSelfAuth")).toBe(
      true,
    );
    expect(calls("await\trequireAuth (FHIR_READ_SCOPE)", "requireAuth")).toBe(
      true,
    );
  });

  it("ignore a name in a comment or inside a longer name", () => {
    expect(calls("// requireSelfAuth() keeps it out", "requireSelfAuth")).toBe(
      false,
    );
    expect(
      calls("/* requireSelfAuth(\n) */ const x = 1;", "requireSelfAuth"),
    ).toBe(false);
    expect(calls("await requireAuthLike()", "requireAuth")).toBe(false);
    expect(calls("await requireSelfAuth()", "requireAuth")).toBe(false);
  });

  it("walk a route tree that is really there", () => {
    expect(routes.length).toBeGreaterThan(300);
  });
});

describe("every owner-capable route admits the guardian or says why not", () => {
  const selfRoutes = routes
    .filter(({ source }) => SELF_HELPERS.some((h) => calls(source, h)))
    .map(({ key }) => key)
    .filter((k) => !OUT_OF_SCOPE.some((prefix) => k.startsWith(prefix)))
    .sort();

  it("the routes that keep the guardian out are exactly the reasoned list", () => {
    expect(selfRoutes.length).toBeGreaterThan(0);
    expect(selfRoutes).toEqual(Object.keys(SELF_ROUTES).sort());
  });

  it("every exclusion names one of the three exceptions and a reason", () => {
    for (const [route, reason] of Object.entries(SELF_ROUTES)) {
      expect(["identity", "account", "consent"], route).toContain(reason.kind);
      expect(reason.why.length, route).toBeGreaterThan(10);
    }
  });

  it("the owner rule is the default for the rest", () => {
    const ownerRule = routes.filter(({ source }) =>
      calls(source, "requireAuth"),
    );
    expect(ownerRule.length).toBeGreaterThan(OWNER_RULE_FLOOR);
    // The owner rule and the self rule never share a module: a route that
    // needs both is two routes.
    const both = ownerRule
      .filter(({ source }) => calls(source, "requireSelfAuth"))
      .map(({ key }) => key);
    expect(both).toEqual([]);
  });

  it("a proof route opts into the owner rule by name, and the list is frozen", () => {
    const proof = routes.filter(({ source }) =>
      calls(source, "requireRecentProof"),
    );
    expect(proof.length).toBeGreaterThan(0);
    const owner = proof
      .filter(({ source }) => /record\s*:\s*"owner"/.test(code(source)))
      .map(({ key }) => key)
      .sort();
    expect(owner).toEqual(OWNER_PROOF_ROUTES);
    // A proof route without the option resolves the caller's own account,
    // so it has to be on the exclusion list.
    for (const { key: k, source } of proof) {
      if (owner.includes(k)) continue;
      expect(
        SELF_ROUTES,
        `${k} keeps the guardian out unlisted`,
      ).toHaveProperty([k]);
      expect(calls(source, "requireRecentProof")).toBe(true);
    }
  });
});

describe("the rule itself", () => {
  const record = readSource("src/lib/auth/guards/record.ts", [
    "admitManagedProfileOwnerRights",
  ]);
  const caller = readSource("src/lib/auth/guards/caller.ts", [
    "requireSelfAuth",
  ]);
  const freshMfa = readSource("src/lib/auth/guards/fresh-mfa.ts", [
    "requireFreshMfaIfEnrolled",
  ]);

  function body(source: string, fn: string): string {
    const start = source.indexOf(`function ${fn}(`);
    expect(start, fn).toBeGreaterThan(-1);
    const next = source.indexOf("\nexport ", start + 1);
    const nextFn = source.indexOf("\nfunction ", start + 1);
    const ends = [next, nextFn].filter((n) => n > 0);
    return source.slice(start, ends.length ? Math.min(...ends) : undefined);
  }

  it("admits a whole-record MANAGE grant on a managed profile, and nothing else", () => {
    const admit = body(record, "admitManagedProfileOwnerRights");
    expect(admit).toContain('grantAllows(grant, "manage")');
    expect(admit).toContain("managedProfileAt === null");
    expect(admit).toContain("grantCoversDomain(grant, ENTIRE_RECORD)");
  });

  it("requireAuth resolves a switch through that admission", () => {
    const rule = body(record, "requireAuth");
    expect(rule).toContain("admitManagedProfileOwnerRights");
    expect(rule).toContain("isScopedCredential(auth)");
    expect(rule).toContain("assertRecordSessionFence(auth");
  });

  it("requireSelfAuth still refuses every switch", () => {
    const self = body(caller, "requireSelfAuth");
    expect(self).toContain('carrier.kind !== "none"');
    expect(self).toContain("refuseUndeclaredMode");
  });

  it("the step-up helpers prove the caller's own account", () => {
    expect(calls(freshMfa, "requireSelfAuth")).toBe(true);
    expect(calls(freshMfa, "requireAuth")).toBe(false);
  });
});
