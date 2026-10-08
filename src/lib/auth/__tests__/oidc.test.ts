import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/safe-fetch", () => ({ safeFetch: vi.fn() }));
vi.mock("jose", () => ({
  jwtVerify: vi.fn(),
  createRemoteJWKSet: vi.fn(() => ({ jwks: "fake" })),
}));

import { safeFetch } from "@/lib/safe-fetch";
import {
  createRemoteJWKSet as mockCreateRemoteJWKSet,
  jwtVerify as mockJwtVerify,
} from "jose";
import {
  _resetOidcCacheForTests,
  buildAuthorizationUrl,
  deriveUniqueUsername,
  discoverOidcMetadata,
  exchangeCodeForTokens,
  fetchUserinfoEmail,
  getOidcConfig,
  getOidcRedirectUri,
  isOidcConfigured,
  isOidcOnly,
  sanitizeOidcNextPath,
  verifyIdToken,
} from "../oidc";

const ENV_KEYS = [
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_SCOPES",
  "OIDC_BUTTON_LABEL",
  "OIDC_ONLY",
  "NEXT_PUBLIC_APP_URL",
] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];
  vi.resetAllMocks();
  _resetOidcCacheForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

function configureEnv() {
  process.env.OIDC_ISSUER_URL = "https://idp.example.com";
  process.env.OIDC_CLIENT_ID = "client-123";
  process.env.OIDC_CLIENT_SECRET = "secret-abc";
  process.env.NEXT_PUBLIC_APP_URL = "https://healthlog.example.com";
}

describe("isOidcConfigured / getOidcConfig", () => {
  it("is unconfigured when any of the three vars is missing", () => {
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    expect(isOidcConfigured()).toBe(false);
    expect(getOidcConfig()).toBeNull();

    process.env.OIDC_ISSUER_URL = "https://idp.example.com";
    process.env.OIDC_CLIENT_ID = "client-123";
    // secret still missing
    expect(isOidcConfigured()).toBe(false);
  });

  it("applies defaults for scopes and button label", () => {
    configureEnv();
    delete process.env.OIDC_SCOPES;
    delete process.env.OIDC_BUTTON_LABEL;
    const config = getOidcConfig();
    expect(config?.scopes).toBe("openid email profile");
    expect(config?.buttonLabel).toBe("Single Sign-On");
    // Trailing slash on the issuer is normalised away.
    process.env.OIDC_ISSUER_URL = "https://idp.example.com/";
    expect(getOidcConfig()?.issuerUrl).toBe("https://idp.example.com");
  });
});

describe("isOidcOnly", () => {
  it("only takes effect when the provider is fully configured", () => {
    delete process.env.OIDC_ISSUER_URL;
    process.env.OIDC_ONLY = "true";
    expect(isOidcOnly()).toBe(false);

    configureEnv();
    process.env.OIDC_ONLY = "true";
    expect(isOidcOnly()).toBe(true);

    process.env.OIDC_ONLY = "false";
    expect(isOidcOnly()).toBe(false);
  });
});

describe("getOidcRedirectUri", () => {
  it("derives the callback URL from NEXT_PUBLIC_APP_URL", () => {
    configureEnv();
    expect(getOidcRedirectUri()).toBe(
      "https://healthlog.example.com/api/auth/oidc/callback",
    );
  });
});

describe("sanitizeOidcNextPath", () => {
  const REQUEST_URL = "https://healthlog.example.com/api/auth/oidc/login";

  it("passes through a plain same-origin path", () => {
    expect(sanitizeOidcNextPath("/dashboard", REQUEST_URL)).toBe("/dashboard");
  });

  it("defaults to / when next is null or empty", () => {
    expect(sanitizeOidcNextPath(null, REQUEST_URL)).toBe("/");
    expect(sanitizeOidcNextPath("", REQUEST_URL)).toBe("/");
  });

  it("rejects a protocol-relative next (//host)", () => {
    expect(sanitizeOidcNextPath("//evil.com", REQUEST_URL)).toBe("/");
  });

  it("rejects an absolute next pointing at another origin", () => {
    expect(sanitizeOidcNextPath("https://evil.com/phish", REQUEST_URL)).toBe(
      "/",
    );
  });

  it("rejects the backslash-normalization bypass (/\\evil.com)", () => {
    // WHATWG URL parsing treats a leading backslash as a path separator
    // for special schemes, so a naive startsWith("/") && !startsWith("//")
    // check would accept this — resolving through URL and comparing the
    // real origin closes that bypass.
    expect(sanitizeOidcNextPath("/\\evil.com", REQUEST_URL)).toBe("/");
    expect(sanitizeOidcNextPath("\\\\evil.com", REQUEST_URL)).toBe("/");
  });

  it("preserves a same-origin path's search and hash", () => {
    expect(
      sanitizeOidcNextPath("/settings?tab=security#top", REQUEST_URL),
    ).toBe("/settings?tab=security#top");
  });

  it("falls back to / on an unparseable value", () => {
    expect(sanitizeOidcNextPath("https://", REQUEST_URL)).toBe("/");
  });
});

const METADATA_DOC = {
  issuer: "https://idp.example.com",
  authorization_endpoint: "https://idp.example.com/authorize",
  token_endpoint: "https://idp.example.com/token",
  jwks_uri: "https://idp.example.com/jwks",
  userinfo_endpoint: "https://idp.example.com/userinfo",
};

describe("discoverOidcMetadata", () => {
  beforeEach(() => configureEnv());

  it("fetches and validates the discovery document", async () => {
    vi.mocked(safeFetch).mockResolvedValue(jsonResponse(METADATA_DOC));
    const config = getOidcConfig()!;
    const metadata = await discoverOidcMetadata(config);
    expect(metadata.token_endpoint).toBe(METADATA_DOC.token_endpoint);
    expect(safeFetch).toHaveBeenCalledWith(
      "https://idp.example.com/.well-known/openid-configuration",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("caches the result — a second call within the TTL does not refetch", async () => {
    vi.mocked(safeFetch).mockResolvedValue(jsonResponse(METADATA_DOC));
    const config = getOidcConfig()!;
    await discoverOidcMetadata(config);
    await discoverOidcMetadata(config);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a discovery doc whose issuer does not match", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      jsonResponse({ ...METADATA_DOC, issuer: "https://evil.example.com" }),
    );
    const config = getOidcConfig()!;
    await expect(discoverOidcMetadata(config)).rejects.toThrow(
      /issuer mismatch/,
    );
  });

  it("tolerates exactly one trailing slash between config and discovery issuer", async () => {
    // Several IdPs mint their issuer with a canonical trailing slash while
    // the operator configures without one. The provider-sent form is kept
    // in the metadata — the ID token's `iss` must match IT byte-exact.
    vi.mocked(safeFetch).mockResolvedValue(
      jsonResponse({ ...METADATA_DOC, issuer: "https://idp.example.com/" }),
    );
    const config = getOidcConfig()!;
    const metadata = await discoverOidcMetadata(config);
    expect(metadata.issuer).toBe("https://idp.example.com/");
  });

  it("does not stretch the slash tolerance beyond a single trailing slash", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      jsonResponse({ ...METADATA_DOC, issuer: "https://idp.example.com//" }),
    );
    const config = getOidcConfig()!;
    await expect(discoverOidcMetadata(config)).rejects.toThrow(
      /issuer mismatch/,
    );
  });

  it("rejects a discovery doc missing required fields", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      jsonResponse({ issuer: METADATA_DOC.issuer }),
    );
    const config = getOidcConfig()!;
    await expect(discoverOidcMetadata(config)).rejects.toThrow(
      /missing required fields/,
    );
  });
});

describe("buildAuthorizationUrl", () => {
  it("includes PKCE, state, nonce, and requested scopes", () => {
    configureEnv();
    const config = getOidcConfig()!;
    const url = new URL(
      buildAuthorizationUrl({
        metadata: METADATA_DOC,
        config,
        state: "state-1",
        nonce: "nonce-1",
        codeChallenge: "challenge-1",
        redirectUri: "https://healthlog.example.com/api/auth/oidc/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe(METADATA_DOC.authorization_endpoint);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("nonce")).toBe("nonce-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(config.scopes);
  });
});

describe("exchangeCodeForTokens", () => {
  beforeEach(() => configureEnv());

  it("posts the authorization code + PKCE verifier and returns the token response", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      jsonResponse({ id_token: "id-token-value", access_token: "at-1" }),
    );
    const config = getOidcConfig()!;
    const tokens = await exchangeCodeForTokens({
      metadata: METADATA_DOC,
      config,
      code: "auth-code",
      codeVerifier: "verifier-1",
      redirectUri: "https://healthlog.example.com/api/auth/oidc/callback",
    });
    expect(tokens.id_token).toBe("id-token-value");
    const [url, init] = vi.mocked(safeFetch).mock.calls[0];
    expect(url).toBe(METADATA_DOC.token_endpoint);
    const body = (init as RequestInit).body as string;
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code");
    expect(body).toContain("code_verifier=verifier-1");
  });

  it("throws on a non-OK response", async () => {
    vi.mocked(safeFetch).mockResolvedValue(jsonResponse({}, false, 400));
    const config = getOidcConfig()!;
    await expect(
      exchangeCodeForTokens({
        metadata: METADATA_DOC,
        config,
        code: "bad-code",
        codeVerifier: "verifier-1",
        redirectUri: "https://healthlog.example.com/api/auth/oidc/callback",
      }),
    ).rejects.toThrow(/token exchange failed/);
  });

  it("throws when the response is missing id_token", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      jsonResponse({ access_token: "at" }),
    );
    const config = getOidcConfig()!;
    await expect(
      exchangeCodeForTokens({
        metadata: METADATA_DOC,
        config,
        code: "code",
        codeVerifier: "verifier",
        redirectUri: "https://healthlog.example.com/api/auth/oidc/callback",
      }),
    ).rejects.toThrow(/missing id_token/);
  });
});

describe("verifyIdToken", () => {
  beforeEach(() => configureEnv());

  it("returns the identity claims on success", async () => {
    // Test payloads deliberately omit the full JWTVerifyResult shape.
    vi.mocked(mockJwtVerify).mockResolvedValue({
      payload: {
        sub: "user-sub-1",
        email: "person@example.com",
        email_verified: true,
        name: "Person",
        nonce: "nonce-1",
      },
    } as never);
    const config = getOidcConfig()!;
    const identity = await verifyIdToken({
      metadata: METADATA_DOC,
      config,
      idToken: "id-token",
      nonce: "nonce-1",
    });
    expect(identity).toEqual({
      sub: "user-sub-1",
      email: "person@example.com",
      emailVerified: true,
      name: "Person",
    });
  });

  it("rejects a nonce mismatch", async () => {
    vi.mocked(mockJwtVerify).mockResolvedValue({
      payload: { sub: "user-sub-1", nonce: "wrong-nonce" },
    } as never);
    const config = getOidcConfig()!;
    await expect(
      verifyIdToken({
        metadata: METADATA_DOC,
        config,
        idToken: "id-token",
        nonce: "nonce-1",
      }),
    ).rejects.toThrow(/nonce mismatch/);
  });

  it("rejects a token missing sub", async () => {
    vi.mocked(mockJwtVerify).mockResolvedValue({
      payload: { nonce: "nonce-1" },
    } as never);
    const config = getOidcConfig()!;
    await expect(
      verifyIdToken({
        metadata: METADATA_DOC,
        config,
        idToken: "id-token",
        nonce: "nonce-1",
      }),
    ).rejects.toThrow(/missing sub claim/);
  });

  it("verifies with a closed asymmetric algorithm allowlist and bounded clock tolerance", async () => {
    vi.mocked(mockJwtVerify).mockResolvedValue({
      payload: { sub: "user-sub-1", nonce: "nonce-1" },
    } as never);
    const config = getOidcConfig()!;
    await verifyIdToken({
      metadata: METADATA_DOC,
      config,
      idToken: "id-token",
      nonce: "nonce-1",
    });
    expect(mockJwtVerify).toHaveBeenCalledWith(
      "id-token",
      expect.anything(),
      expect.objectContaining({
        issuer: METADATA_DOC.issuer,
        audience: config.clientId,
        algorithms: ["RS256", "PS256", "ES256", "EdDSA"],
        clockTolerance: "60s",
      }),
    );
  });

  it("pins the JWKS fetch to the issuer's host with a bounded timeout", async () => {
    vi.mocked(mockJwtVerify).mockResolvedValue({
      payload: { sub: "user-sub-1", nonce: "nonce-1" },
    } as never);
    const config = getOidcConfig()!;
    await verifyIdToken({
      metadata: METADATA_DOC,
      config,
      idToken: "id-token",
      nonce: "nonce-1",
    });
    expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
      new URL(METADATA_DOC.jwks_uri),
      { timeoutDuration: 15_000 },
    );
  });

  it("rejects a discovery doc whose jwks_uri points at a foreign host", async () => {
    const config = getOidcConfig()!;
    await expect(
      verifyIdToken({
        metadata: {
          ...METADATA_DOC,
          jwks_uri: "https://evil.example.com/jwks",
        },
        config,
        idToken: "id-token",
        nonce: "nonce-1",
      }),
    ).rejects.toThrow(/jwks_uri host mismatch/);
    expect(mockCreateRemoteJWKSet).not.toHaveBeenCalled();
  });
});

describe("fetchUserinfoEmail", () => {
  it("returns the userinfo email on success", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      jsonResponse({ email: "fallback@example.com", email_verified: true }),
    );
    const result = await fetchUserinfoEmail({
      metadata: METADATA_DOC,
      accessToken: "at-1",
    });
    expect(result).toEqual({
      email: "fallback@example.com",
      emailVerified: true,
    });
  });

  it("fails soft (null email) when the endpoint is missing or errors", async () => {
    const noEndpoint = await fetchUserinfoEmail({
      metadata: { ...METADATA_DOC, userinfo_endpoint: undefined },
      accessToken: "at-1",
    });
    expect(noEndpoint).toEqual({ email: null, emailVerified: undefined });

    vi.mocked(safeFetch).mockRejectedValue(new Error("network down"));
    const onError = await fetchUserinfoEmail({
      metadata: METADATA_DOC,
      accessToken: "at-1",
    });
    expect(onError).toEqual({ email: null, emailVerified: undefined });
  });
});

describe("deriveUniqueUsername", () => {
  it("sanitises the email local-part into a valid username", async () => {
    const exists = vi.fn().mockResolvedValue(false);
    const username = await deriveUniqueUsername(
      "j.doe+sso@example.com",
      exists,
    );
    expect(username).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(username.length).toBeGreaterThanOrEqual(3);
    expect(username.length).toBeLessThanOrEqual(30);
  });

  it("never derives a name with the managed-profile prefix", async () => {
    const exists = vi.fn().mockResolvedValue(false);
    const username = await deriveUniqueUsername(
      "Managed-managed-alex@example.com",
      exists,
    );
    expect(username).toBe("alex");
  });

  it("appends a numeric suffix on collision", async () => {
    const exists = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const username = await deriveUniqueUsername("taken@example.com", exists);
    expect(username).toBe("taken2");
    expect(exists).toHaveBeenCalledTimes(3);
  });

  it("pads a too-short local-part up to the 3-char minimum", async () => {
    const exists = vi.fn().mockResolvedValue(false);
    const username = await deriveUniqueUsername("a@example.com", exists);
    expect(username.length).toBeGreaterThanOrEqual(3);
  });
});
