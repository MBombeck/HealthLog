/**
 * Process-local memory per Codex sign-in: the model that last worked, the
 * models the backend refused, and the model list the account was offered.
 *
 * The ChatGPT-Codex backend offers different models to different plans and
 * retires them without notice (docs/codex-protocol-spec.md §7b). One slot for
 * the whole process meant two sign-ins on different plans overwrote each
 * other's working model, and the vision gate read whichever had answered
 * last. Every entry here belongs to one stored credential instead:
 *
 *   - `user:<id>` for a person's own Codex connection;
 *   - `central` for the operator-shared connection (`admin-codex`).
 *
 * An entry also remembers a digest of the ChatGPT account id it was learned
 * under. A credential reconnected to a different account (a different plan)
 * starts from an empty entry the first time a client runs on it, so nothing
 * learned on the old account carries over. No token, and no raw account id,
 * is ever a key or a value here.
 *
 * Bounded both ways: every part of an entry expires on its own TTL, and the
 * map holds at most `CODEX_CREDENTIAL_CACHE_MAX` sign-ins, the least recently
 * used dropped first. A dropped entry costs one extra model-list read and at
 * most one refused request; it never costs an answer.
 */
import { createHash } from "node:crypto";
import type {
  CodexCatalogFailure,
  CodexOfferedModel,
} from "./codex-model-catalog";

/** How long a working model stays first in line (spec §7b). */
export const CODEX_SLUG_CACHE_TTL_MS = 60 * 60 * 1000;
/** How long a model the backend refused stays at the back of the line. */
export const CODEX_REJECTED_SLUG_TTL_MS = 6 * 60 * 60 * 1000;
/** How long the account's model list is trusted before it is read again. */
export const CODEX_CATALOG_TTL_MS = 60 * 60 * 1000;
/** How long a list that could not be read waits before the next attempt. */
export const CODEX_CATALOG_RETRY_MS = 10 * 60 * 1000;
/** Most sign-ins held at once. */
export const CODEX_CREDENTIAL_CACHE_MAX = 1_000;

/** The keys a sign-in's memory is kept under. */
export const codexCredentialKey = {
  /** A person's own Codex connection (the `codex` chain entry). */
  user: (userId: string): string => `user:${userId}`,
  /** The operator-shared central connection (the `admin-codex` entry). */
  central: "central",
} as const;

/** The sign-in a client runs on: its stored credential and its account. */
export interface CodexCredential {
  key: string;
  accountId: string;
}

/** What the last read of the account's model list left behind. */
export type CodexCatalogState =
  | { kind: "offered"; models: readonly CodexOfferedModel[]; at: number }
  | { kind: "unreadable"; reason: CodexCatalogFailure; at: number };

interface CredentialEntry {
  accountDigest: string;
  working: { slug: string; at: number } | null;
  rejected: Map<string, number>;
  catalog: CodexCatalogState | null;
  /** Whether the current unreadable stretch has been reported. */
  unreadableReported: boolean;
}

const entries = new Map<string, CredentialEntry>();

function accountDigest(accountId: string): string {
  return createHash("sha256")
    .update(`codex-account:${accountId}`)
    .digest("hex")
    .slice(0, 32);
}

/** Read an entry without binding it to an account; LRU-touches a hit. */
function peek(key: string): CredentialEntry | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}

/**
 * The entry for a running client's sign-in, created on first use and started
 * afresh when the credential now belongs to a different account.
 */
function bind(credential: CodexCredential): CredentialEntry {
  const digest = accountDigest(credential.accountId);
  const existing = peek(credential.key);
  if (existing && existing.accountDigest === digest) return existing;
  const fresh: CredentialEntry = {
    accountDigest: digest,
    working: null,
    rejected: new Map(),
    catalog: null,
    unreadableReported: false,
  };
  entries.set(credential.key, fresh);
  while (entries.size > CODEX_CREDENTIAL_CACHE_MAX) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  return fresh;
}

/** The model that last worked for this sign-in, while it is fresh. */
export function getCachedCodexSlug(
  key: string,
  now: number = Date.now(),
): string | null {
  const entry = peek(key);
  if (!entry?.working) return null;
  if (now - entry.working.at > CODEX_SLUG_CACHE_TTL_MS) {
    entry.working = null;
    return null;
  }
  return entry.working.slug;
}

export function setCachedCodexSlug(
  credential: CodexCredential,
  slug: string,
  now: number = Date.now(),
): void {
  const entry = bind(credential);
  entry.working = { slug, at: now };
  entry.rejected.delete(slug);
}

/**
 * Record that the backend refused `slug` for this sign-in (a retired or
 * not-offered model). It drops out of the working slot and goes to the back
 * of the line until `CODEX_REJECTED_SLUG_TTL_MS` passes, even while the
 * account's list still offers it.
 */
export function rememberRejectedCodexSlug(
  credential: CodexCredential,
  slug: string,
  now: number = Date.now(),
): void {
  const entry = bind(credential);
  if (entry.working?.slug === slug) entry.working = null;
  entry.rejected.set(slug, now);
}

/** The models this sign-in was refused recently. */
export function rejectedCodexSlugs(
  key: string,
  now: number = Date.now(),
): ReadonlySet<string> {
  const entry = peek(key);
  if (!entry) return new Set();
  for (const [slug, at] of entry.rejected) {
    if (now - at > CODEX_REJECTED_SLUG_TTL_MS) entry.rejected.delete(slug);
  }
  return new Set(entry.rejected.keys());
}

/** The last read of the account's model list, while it is still trusted. */
export function getCodexCatalogState(
  key: string,
  now: number = Date.now(),
): CodexCatalogState | null {
  const entry = peek(key);
  const state = entry?.catalog;
  if (!entry || !state) return null;
  const ttl =
    state.kind === "offered" ? CODEX_CATALOG_TTL_MS : CODEX_CATALOG_RETRY_MS;
  if (now - state.at > ttl) {
    entry.catalog = null;
    return null;
  }
  return state;
}

/**
 * Store a read of the account's model list. Returns true when this is the
 * first unreadable result since the list last answered, which is the one
 * the caller reports; a later failure in the same stretch returns false.
 */
export function setCodexCatalogState(
  credential: CodexCredential,
  state: CodexCatalogState,
): boolean {
  const entry = bind(credential);
  entry.catalog = state;
  if (state.kind === "offered") {
    entry.unreadableReported = false;
    return false;
  }
  if (entry.unreadableReported) return false;
  entry.unreadableReported = true;
  return true;
}

/** Test-only: forget every sign-in. */
export function clearCodexSlugCache(): void {
  entries.clear();
}

/** Test-only: how many sign-ins are held. */
export function codexCredentialCacheSize(): number {
  return entries.size;
}
