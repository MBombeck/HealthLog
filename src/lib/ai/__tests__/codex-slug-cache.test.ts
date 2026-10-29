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
  getCachedCodexSlug,
  getCodexCatalogState,
  rejectedCodexSlugs,
  rememberRejectedCodexSlug,
  setCachedCodexSlug,
  setCodexCatalogState,
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
    expect(getCachedCodexSlug(A.key)).toBeNull();
    expect(rejectedCodexSlugs(A.key).size).toBe(0);
    expect(getCodexCatalogState(A.key)).toBeNull();
  });

  it("holds the working slug for exactly the TTL", () => {
    setCachedCodexSlug(A, "gpt-6-sol", 1_000);
    expect(getCachedCodexSlug(A.key, 1_000)).toBe("gpt-6-sol");
    expect(getCachedCodexSlug(A.key, 1_000 + CODEX_SLUG_CACHE_TTL_MS)).toBe(
      "gpt-6-sol",
    );
    expect(
      getCachedCodexSlug(A.key, 1_000 + CODEX_SLUG_CACHE_TTL_MS + 1),
    ).toBeNull();
    expect(CODEX_SLUG_CACHE_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("keeps every sign-in's working slug to itself", () => {
    // Two plans: one account works on terra, the other only on gpt-6.
    setCachedCodexSlug(A, "gpt-5.6-terra");
    setCachedCodexSlug(B, "gpt-6.1-sol");
    setCachedCodexSlug(CENTRAL, "gpt-6-sol");
    expect(getCachedCodexSlug(A.key)).toBe("gpt-5.6-terra");
    expect(getCachedCodexSlug(B.key)).toBe("gpt-6.1-sol");
    expect(getCachedCodexSlug(CENTRAL.key)).toBe("gpt-6-sol");

    rememberRejectedCodexSlug(B, "gpt-6.1-sol");
    expect(getCachedCodexSlug(B.key)).toBeNull();
    expect(getCachedCodexSlug(A.key)).toBe("gpt-5.6-terra");
    expect(rejectedCodexSlugs(A.key).size).toBe(0);
  });

  it("a refusal drops the working slot and is held for its own TTL", () => {
    setCachedCodexSlug(A, "gpt-5.6-terra", 0);
    rememberRejectedCodexSlug(A, "gpt-5.6-terra", 10);
    expect(getCachedCodexSlug(A.key, 10)).toBeNull();
    expect([...rejectedCodexSlugs(A.key, 10)]).toEqual(["gpt-5.6-terra"]);
    expect([
      ...rejectedCodexSlugs(A.key, 10 + CODEX_REJECTED_SLUG_TTL_MS),
    ]).toEqual(["gpt-5.6-terra"]);
    expect(
      rejectedCodexSlugs(A.key, 10 + CODEX_REJECTED_SLUG_TTL_MS + 1).size,
    ).toBe(0);
  });

  it("a slug that works again leaves the refused set", () => {
    rememberRejectedCodexSlug(A, "gpt-6-sol");
    setCachedCodexSlug(A, "gpt-6-sol");
    expect(rejectedCodexSlugs(A.key).size).toBe(0);
  });

  it("a credential reconnected to another account starts afresh", () => {
    setCachedCodexSlug(A, "gpt-5.6-terra");
    rememberRejectedCodexSlug(A, "gpt-6-sol");
    setCodexCatalogState(A, { kind: "offered", models: [], at: Date.now() });

    // Same stored credential, a different ChatGPT account (another plan).
    setCachedCodexSlug({ key: A.key, accountId: "acct-other" }, "gpt-6-luna");
    expect(getCachedCodexSlug(A.key)).toBe("gpt-6-luna");
    expect(rejectedCodexSlugs(A.key).size).toBe(0);
    expect(getCodexCatalogState(A.key)).toBeNull();
  });

  it("holds a list for its TTL and a failed read for the shorter retry window", () => {
    setCodexCatalogState(A, { kind: "offered", models: [], at: 0 });
    expect(getCodexCatalogState(A.key, CODEX_CATALOG_TTL_MS)?.kind).toBe(
      "offered",
    );
    expect(getCodexCatalogState(A.key, CODEX_CATALOG_TTL_MS + 1)).toBeNull();

    setCodexCatalogState(B, { kind: "unreadable", reason: "timeout", at: 0 });
    expect(getCodexCatalogState(B.key, CODEX_CATALOG_RETRY_MS)?.kind).toBe(
      "unreadable",
    );
    expect(getCodexCatalogState(B.key, CODEX_CATALOG_RETRY_MS + 1)).toBeNull();
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
    expect(getCachedCodexSlug(codexCredentialKey.user("u0"))).toBe("gpt-6-sol");
    setCachedCodexSlug(
      { key: codexCredentialKey.user("new"), accountId: "acct-new" },
      "gpt-6-sol",
    );
    expect(codexCredentialCacheSize()).toBe(CODEX_CREDENTIAL_CACHE_MAX);
    expect(getCachedCodexSlug(codexCredentialKey.user("u0"))).toBe("gpt-6-sol");
    expect(getCachedCodexSlug(codexCredentialKey.user("u1"))).toBeNull();
  });
});
