import { describe, it, expect, beforeEach } from "vitest";
import {
  CODEX_CATALOG_RETRY_MS,
  CODEX_CATALOG_TTL_MS,
  CODEX_CREDENTIAL_CACHE_MAX,
  CODEX_REJECTED_SLUG_TTL_MS,
  CODEX_SLUG_CACHE_TTL_MS,
  clearCodexSlugCache,
  codexCredentialCacheSize,
  codexCredentialKey,
  codexGateMemory,
  forgetCodexSignIn,
  getCachedCodexSlug,
  getCodexCatalogState,
  rejectedCodexSlugs,
  rememberRejectedCodexSlug,
  setCachedCodexSlug,
  setCodexCatalogState,
  startCodexSignIn,
} from "../codex-slug-cache";

/**
 * Per-sign-in memory: the working slug (1 h, spec §7b), refused slugs, and
 * the account's model list, each kept under its stored credential.
 */
const A = { key: codexCredentialKey.user("a"), accountId: "acct-a" };
const B = { key: codexCredentialKey.user("b"), accountId: "acct-b" };
const CENTRAL = { key: codexCredentialKey.central, accountId: "acct-op" };

describe("Codex per-sign-in cache", () => {
  beforeEach(() => {
    clearCodexSlugCache();
  });

  it("keys a person's connection and the central one apart", () => {
    expect(codexCredentialKey.user("a")).toBe("user:a");
    expect(codexCredentialKey.central).toBe("central");
  });

  it("starts empty", () => {
    expect(getCachedCodexSlug(A)).toBeNull();
    expect(rejectedCodexSlugs(A).size).toBe(0);
    expect(getCodexCatalogState(A)).toBeNull();
  });

  it("holds the working slug for exactly the TTL", () => {
    setCachedCodexSlug(A, "gpt-6-sol", 1_000);
    expect(getCachedCodexSlug(A, 1_000)).toBe("gpt-6-sol");
    expect(getCachedCodexSlug(A, 1_000 + CODEX_SLUG_CACHE_TTL_MS)).toBe(
      "gpt-6-sol",
    );
    expect(
      getCachedCodexSlug(A, 1_000 + CODEX_SLUG_CACHE_TTL_MS + 1),
    ).toBeNull();
    expect(CODEX_SLUG_CACHE_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("keeps every sign-in's working slug to itself", () => {
    // Two plans: one account works on terra, the other only on gpt-6.
    setCachedCodexSlug(A, "gpt-5.6-terra");
    setCachedCodexSlug(B, "gpt-6.1-sol");
    setCachedCodexSlug(CENTRAL, "gpt-6-sol");
    expect(getCachedCodexSlug(A)).toBe("gpt-5.6-terra");
    expect(getCachedCodexSlug(B)).toBe("gpt-6.1-sol");
    expect(getCachedCodexSlug(CENTRAL)).toBe("gpt-6-sol");

    rememberRejectedCodexSlug(B, "gpt-6.1-sol");
    expect(getCachedCodexSlug(B)).toBeNull();
    expect(getCachedCodexSlug(A)).toBe("gpt-5.6-terra");
    expect(rejectedCodexSlugs(A).size).toBe(0);
  });

  it("a refusal drops the working slot and is held for its own TTL", () => {
    setCachedCodexSlug(A, "gpt-5.6-terra", 0);
    rememberRejectedCodexSlug(A, "gpt-5.6-terra", 10);
    expect(getCachedCodexSlug(A, 10)).toBeNull();
    expect([...rejectedCodexSlugs(A, 10)]).toEqual(["gpt-5.6-terra"]);
    expect([...rejectedCodexSlugs(A, 10 + CODEX_REJECTED_SLUG_TTL_MS)]).toEqual(
      ["gpt-5.6-terra"],
    );
    expect(
      rejectedCodexSlugs(A, 10 + CODEX_REJECTED_SLUG_TTL_MS + 1).size,
    ).toBe(0);
  });

  it("a slug that works again leaves the refused set", () => {
    rememberRejectedCodexSlug(A, "gpt-6-sol");
    setCachedCodexSlug(A, "gpt-6-sol");
    expect(rejectedCodexSlugs(A).size).toBe(0);
  });

  it("a credential reconnected to another account reads as empty before anything is written", () => {
    setCachedCodexSlug(A, "gpt-5.6-terra");
    rememberRejectedCodexSlug(A, "gpt-6-sol");
    setCodexCatalogState(A, { kind: "offered", models: [], at: Date.now() });

    // Same stored credential, a different ChatGPT account (another plan):
    // its first read finds nothing the old account learned.
    const other = { key: A.key, accountId: "acct-other" };
    expect(getCachedCodexSlug(other)).toBeNull();
    expect(rejectedCodexSlugs(other).size).toBe(0);
    expect(getCodexCatalogState(other)).toBeNull();

    // Its first write starts the entry afresh, and the old account's memory
    // is gone with it.
    setCachedCodexSlug(other, "gpt-6-luna");
    expect(getCachedCodexSlug(other)).toBe("gpt-6-luna");
    expect(rejectedCodexSlugs(other).size).toBe(0);
    expect(getCachedCodexSlug(A)).toBeNull();
    expect(getCodexCatalogState(A)).toBeNull();
  });

  it("a connect rebinds the gate's memory and a disconnect forgets it", () => {
    setCachedCodexSlug(A, "gpt-5.6-terra");
    rememberRejectedCodexSlug(A, "gpt-6-sol");
    expect(codexGateMemory(A.key).working).toBe("gpt-5.6-terra");

    // A reconnect to the same account keeps what it learned.
    startCodexSignIn(A);
    expect(codexGateMemory(A.key).working).toBe("gpt-5.6-terra");

    // A reconnect to another account starts it afresh.
    startCodexSignIn({ key: A.key, accountId: "acct-other" });
    expect(codexGateMemory(A.key)).toEqual({
      working: null,
      rejected: new Set(),
      catalog: null,
    });

    setCachedCodexSlug(B, "gpt-6-sol");
    forgetCodexSignIn(B.key);
    expect(codexGateMemory(B.key).working).toBeNull();
    expect(getCachedCodexSlug(B)).toBeNull();
  });

  it("holds a list for its TTL and a failed read for the shorter retry window", () => {
    setCodexCatalogState(A, { kind: "offered", models: [], at: 0 });
    expect(getCodexCatalogState(A, CODEX_CATALOG_TTL_MS)?.kind).toBe("offered");
    expect(getCodexCatalogState(A, CODEX_CATALOG_TTL_MS + 1)).toBeNull();

    setCodexCatalogState(B, { kind: "unreadable", reason: "timeout", at: 0 });
    expect(getCodexCatalogState(B, CODEX_CATALOG_RETRY_MS)?.kind).toBe(
      "unreadable",
    );
    expect(getCodexCatalogState(B, CODEX_CATALOG_RETRY_MS + 1)).toBeNull();
  });

  it("reports the first unreadable read of a stretch, and re-arms on success", () => {
    const unreadable = {
      kind: "unreadable" as const,
      reason: "timeout" as const,
      at: 0,
    };
    expect(setCodexCatalogState(A, unreadable)).toBe(true);
    expect(setCodexCatalogState(A, unreadable)).toBe(false);
    expect(setCodexCatalogState(B, unreadable)).toBe(true);
    expect(
      setCodexCatalogState(A, { kind: "offered", models: [], at: 0 }),
    ).toBe(false);
    expect(setCodexCatalogState(A, unreadable)).toBe(true);
  });

  it("holds at most the cap, dropping the least recently used sign-in", () => {
    for (let i = 0; i < CODEX_CREDENTIAL_CACHE_MAX; i += 1) {
      setCachedCodexSlug(
        { key: codexCredentialKey.user(`u${i}`), accountId: `acct-${i}` },
        "gpt-6-sol",
      );
    }
    // Touch the oldest so the second-oldest is the one to go.
    expect(
      getCachedCodexSlug({
        key: codexCredentialKey.user("u0"),
        accountId: "acct-0",
      }),
    ).toBe("gpt-6-sol");
    setCachedCodexSlug(
      { key: codexCredentialKey.user("new"), accountId: "acct-new" },
      "gpt-6-sol",
    );
    expect(codexCredentialCacheSize()).toBe(CODEX_CREDENTIAL_CACHE_MAX);
    expect(
      getCachedCodexSlug({
        key: codexCredentialKey.user("u0"),
        accountId: "acct-0",
      }),
    ).toBe("gpt-6-sol");
    expect(
      getCachedCodexSlug({
        key: codexCredentialKey.user("u1"),
        accountId: "acct-1",
      }),
    ).toBeNull();
  });
});
