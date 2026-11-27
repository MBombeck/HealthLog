/**
 * Claiming a fresh instance: the setup token for the first account.
 *
 * The first account on an instance becomes its admin. Until v1.50 whoever
 * reached a freshly started, publicly reachable instance first got that role.
 * Now creating the first account, by password registration or by the first
 * single sign-on, needs a setup token, which only somebody who can read the
 * server's log or set its environment has:
 *
 *   - `SETUP_TOKEN` from the environment (at least 32 characters), or else
 *   - a token derived from `API_TOKEN_HMAC_KEY`, which every web and worker
 *     process prints to its log at start while the instance has no account.
 *
 * Derived rather than stored, so every process prints the same token, a
 * restart does not change it, and nothing about it sits in the database. The
 * derivation is HKDF with its own salt and label: no value `hashToken` (an
 * HMAC keyed with the same secret) ever writes can equal it. Once an account
 * exists the token opens nothing.
 *
 * The browser proves the token once (`POST /api/auth/register/setup`) and gets
 * a short-lived, signed, httpOnly cookie, which carries the proof through the
 * registration form or across the identity provider's redirect.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

import { apiError } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { annotate } from "@/lib/logging/context";
import { operatorLine } from "@/lib/logging/operator-line";

/** Minimum length of an operator-chosen `SETUP_TOKEN`. */
export const MIN_SETUP_TOKEN_LENGTH = 32;

/** The proof cookie, and how long it lasts. */
export const SETUP_PROOF_COOKIE = "hl_setup";
const SETUP_PROOF_MAX_AGE_S = 30 * 60;

function hmacKey(): string {
  const key = process.env.API_TOKEN_HMAC_KEY;
  if (!key || key.length < 32) {
    throw new Error("API_TOKEN_HMAC_KEY must be set to claim the instance");
  }
  return key;
}

function derive(info: string, bytes: number): Buffer {
  return Buffer.from(
    hkdfSync("sha256", hmacKey(), "healthlog-first-account", info, bytes),
  );
}

/**
 * The token that claims the instance, or null when the operator set a
 * `SETUP_TOKEN` too short to trust: then no first account can be created
 * until it is fixed, and the boot log says so.
 */
export function expectedSetupToken(): string | null {
  const configured = process.env.SETUP_TOKEN?.trim();
  if (configured) {
    return configured.length >= MIN_SETUP_TOKEN_LENGTH ? configured : null;
  }
  return `hlu_${derive("setup token", 24).toString("hex")}`;
}

function sameSecret(a: string, b: string): boolean {
  const digest = (v: string) =>
    createHmac("sha256", "compare").update(v).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Whether `candidate` is this instance's setup token. */
export function isSetupToken(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const expected = expectedSetupToken();
  return expected !== null && sameSecret(candidate.trim(), expected);
}

function proofSignature(expiresAtMs: number): string {
  return createHmac("sha256", derive("setup proof", 32))
    .update(String(expiresAtMs))
    .digest("hex");
}

/** A fresh proof value: its expiry and a signature over it. */
export function mintSetupProof(now = Date.now()): string {
  const expiresAtMs = now + SETUP_PROOF_MAX_AGE_S * 1000;
  return `${expiresAtMs}.${proofSignature(expiresAtMs)}`;
}

/** Whether a proof cookie value is one this instance signed and still live. */
export function isSetupProof(value: string | undefined | null): boolean {
  if (!value) return false;
  const match = /^(\d{13})\.([0-9a-f]{64})$/.exec(value);
  if (!match) return false;
  const expiresAtMs = Number(match[1]);
  if (expiresAtMs <= Date.now()) return false;
  return sameSecret(match[2], proofSignature(expiresAtMs));
}

/** Cookie options for the proof: httpOnly, Lax so the SSO return carries it. */
export function setupProofCookieOptions() {
  return {
    httpOnly: true,
    secure: shouldEmitSecureCookie(),
    sameSite: "lax" as const,
    maxAge: SETUP_PROOF_MAX_AGE_S,
    path: "/",
  };
}

/**
 * Print the setup token while the instance has no account. Called once per
 * process at start; never throws.
 */
export async function logSetupTokenAtBoot(prisma: {
  user: { count(): Promise<number> };
}): Promise<void> {
  try {
    if ((await prisma.user.count()) > 0) return;
    if (process.env.SETUP_TOKEN?.trim()) {
      if (expectedSetupToken() === null) {
        console.warn(
          `[setup] SETUP_TOKEN is shorter than ${MIN_SETUP_TOKEN_LENGTH} characters, so no first account can be created. Set a longer one, or remove it to use the token this log prints.`,
        );
      } else {
        operatorLine(
          "[setup] This server has no account yet. Create the first one (it becomes the admin) with the SETUP_TOKEN you set.",
        );
      }
      return;
    }
    operatorLine(
      `[setup] This server has no account yet. The setup token for the first account (it becomes the admin) is: ${expectedSetupToken()}`,
    );
  } catch {
    // A notice must never break boot.
  }
}

/** Raised inside the first-account lock when the setup token was not shown. */
export class SetupRequired extends Error {
  constructor() {
    super("setup token required");
    this.name = "SetupRequired";
  }
}

/**
 * Whether this request may create the first account: the token in the body,
 * or the proof cookie a browser got from `POST /api/auth/register/setup`.
 */
export async function isProven(bodyToken: unknown): Promise<boolean> {
  if (isSetupToken(bodyToken)) return true;
  try {
    return isSetupProof((await cookies()).get(SETUP_PROOF_COOKIE)?.value);
  } catch {
    // No request scope, so no cookie to read: not proven.
    return false;
  }
}

/** The refusal for a first account without the setup token. */
export function setupRefusal(): Response {
  annotate({ action: { name: "auth.register.setup_required" } });
  return apiError(
    "This server has no account yet. Enter the setup token from the server log to create the first one.",
    403,
    { errorCode: "auth.register.setup_required" },
  );
}

/** Inside the first-account lock: no first account without the token. */
export function claimIfFirst(priorUsers: number, setupProven: boolean): void {
  if (priorUsers === 0 && !setupProven) throw new SetupRequired();
}

/** After the first account exists: the proof is spent, and the claim audited. */
export async function afterClaim(userId: string, ip: string): Promise<void> {
  (await cookies()).delete(SETUP_PROOF_COOKIE);
  await auditLog("auth.setup.claimed", { userId, ipAddress: ip });
}
