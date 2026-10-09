import { afterEach, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => v.replace(/^enc:/, "")),
}));

import {
  generatePKCE,
  generateState,
  requestDeviceCode,
  pollDeviceCode,
  refreshDeviceTokens,
  CodexRefreshError,
  codexReconnectRequired,
  encryptCodexCreds,
  decryptCodexCreds,
  getCodexClientId,
} from "../codex-oauth";

/**
 * Minimal id_token JWT for tests — only the payload matters; signature
 * is unverified by our client. Payload includes the
 * `chatgpt_account_id` claim and a far-future `exp`.
 */
function makeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.`;
}

describe("codex-oauth", () => {
  describe("generatePKCE", () => {
    it("generates verifier and challenge of correct format", () => {
      const { verifier, challenge } = generatePKCE();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(challenge.length).toBeGreaterThanOrEqual(43);
    });
    it("generates different values each time", () => {
      const a = generatePKCE();
      const b = generatePKCE();
      expect(a.verifier).not.toBe(b.verifier);
    });
  });

  describe("generateState", () => {
    it("generates a non-empty base64url string", () => {
      const state = generateState();
      expect(state.length).toBeGreaterThan(20);
    });
  });

  describe("getCodexClientId", () => {
    const ORIGINAL = process.env.CODEX_OAUTH_CLIENT_ID;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.CODEX_OAUTH_CLIENT_ID;
      else process.env.CODEX_OAUTH_CLIENT_ID = ORIGINAL;
    });
    it("falls back to the public Codex CLI client ID when env is unset", () => {
      delete process.env.CODEX_OAUTH_CLIENT_ID;
      expect(getCodexClientId()).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    });
  });

  describe("device-code flow", () => {
    let originalFetch: typeof fetch;
    beforeEachInit();
    afterEach(() => {
      global.fetch = originalFetch;
    });
    function beforeEachInit() {
      originalFetch = global.fetch;
    }

    it("requestDeviceCode returns user code + verification URL", async () => {
      global.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              device_auth_id: "dev-1",
              user_code: "ABCD-1234",
              interval: "5",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ) as never;

      const code = await requestDeviceCode();
      expect(code.userCode).toBe("ABCD-1234");
      expect(code.deviceAuthId).toBe("dev-1");
      expect(code.intervalSeconds).toBe(5);
      expect(code.verificationUrl).toBe("https://auth.openai.com/codex/device");
    });

    it("pollDeviceCode returns 'pending' on 403", async () => {
      global.fetch = vi.fn(
        async () => new Response("", { status: 403 }),
      ) as never;
      const r = await pollDeviceCode({ deviceAuthId: "x", userCode: "y" });
      expect(r.status).toBe("pending");
    });

    it("pollDeviceCode resolves to creds with account id from id_token", async () => {
      const idToken = makeIdToken({
        chatgpt_account_id: "acct-test",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      let call = 0;
      global.fetch = vi.fn(async () => {
        call += 1;
        if (call === 1) {
          // device-poll: returns auth code + PKCE values
          return new Response(
            JSON.stringify({
              authorization_code: "auth-code",
              code_challenge: "challenge",
              code_verifier: "verifier",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // /oauth/token exchange
        return new Response(
          JSON.stringify({
            id_token: idToken,
            access_token: "oauth-access",
            refresh_token: "refresh-1",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as never;

      const r = await pollDeviceCode({ deviceAuthId: "x", userCode: "y" });
      expect(r.status).toBe("connected");
      if (r.status === "connected") {
        expect(r.creds.accessToken).toBe("oauth-access");
        expect(r.creds.refreshToken).toBe("refresh-1");
        expect(r.creds.accountId).toBe("acct-test");
      }
    });

    it("refreshDeviceTokens uses JSON body and returns rotated tokens", async () => {
      const idToken = makeIdToken({
        chatgpt_account_id: "acct-test",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const calls: string[] = [];
      global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(String(init?.body ?? ""));
        return new Response(
          JSON.stringify({
            id_token: idToken,
            access_token: "oauth-fresh",
            refresh_token: "refresh-2",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as never;

      const r = await refreshDeviceTokens("refresh-1");
      expect(r.accessToken).toBe("oauth-fresh");
      expect(r.refreshToken).toBe("refresh-2");
      expect(r.accountId).toBe("acct-test");
      // Body must be JSON (not form-urlencoded), per the spec.
      expect(calls[0]).toMatch(/^\{/);
      expect(JSON.parse(calls[0])).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "refresh-1",
      });
    });
  });

  describe("refreshDeviceTokens failures", () => {
    function failWith(status: number, body: string) {
      global.fetch = vi.fn(
        async () =>
          new Response(body, {
            status,
            headers: { "content-type": "application/json" },
          }),
      ) as never;
    }

    async function refreshError(): Promise<CodexRefreshError> {
      try {
        await refreshDeviceTokens("refresh-dead");
      } catch (err) {
        return err as CodexRefreshError;
      }
      throw new Error("refresh unexpectedly succeeded");
    }

    it("reads a dead refresh token as an expired credential with an auth status", async () => {
      // The production shape: 401 with `invalid_refresh_token`.
      failWith(401, JSON.stringify({ error: "invalid_refresh_token" }));
      const err = await refreshError();
      expect(err).toBeInstanceOf(CodexRefreshError);
      expect(err.httpStatus).toBe(401);
      expect(err.credentialExpired).toBe(true);
      expect(err.oauthError).toBe("invalid_refresh_token");
    });

    it("classifies invalid_grant on a 400 as a dead credential (401), not a request bug", async () => {
      failWith(
        400,
        JSON.stringify({
          error: { code: "invalid_grant", message: "Refresh token revoked" },
        }),
      );
      const err = await refreshError();
      expect(err.httpStatus).toBe(401);
      expect(err.credentialExpired).toBe(true);
      expect(err.oauthError).toBe("invalid_grant");
    });

    it("keeps the status of a refusal that is not about the credential", async () => {
      failWith(503, "upstream unavailable");
      const err = await refreshError();
      expect(err.httpStatus).toBe(503);
      expect(err.credentialExpired).toBe(false);
      expect(err.oauthError).toBeNull();
    });

    it("never quotes the response body in the message", async () => {
      failWith(
        401,
        JSON.stringify({
          error: "invalid_refresh_token",
          error_description: "token rt-secret-value was revoked",
        }),
      );
      const err = await refreshError();
      expect(err.message).not.toContain("rt-secret-value");
    });

    it("codexReconnectRequired carries the same auth contract", () => {
      const err = codexReconnectRequired("no refresh token");
      expect(err.httpStatus).toBe(401);
      expect(err.credentialExpired).toBe(true);
    });
  });

  describe("encryptCodexCreds / decryptCodexCreds", () => {
    it("round-trips access token, refresh token, and account id", () => {
      const expiresAt = new Date(Date.now() + 3600_000);
      const enc = encryptCodexCreds({
        accessToken: "oauth-access",
        refreshToken: "refresh-test",
        accountId: "acct-123",
        expiresAt,
      });

      const dec = decryptCodexCreds({
        accessEncrypted: enc.accessEncrypted,
        refreshEncrypted: enc.refreshEncrypted,
      });
      expect(dec).not.toBeNull();
      expect(dec!.accessToken).toBe("oauth-access");
      expect(dec!.refreshToken).toBe("refresh-test");
      expect(dec!.accountId).toBe("acct-123");
      expect(dec!.expiresAt.getTime()).toBe(expiresAt.getTime());
    });

    it("returns null for legacy v1.4.7-v1.4.11 token storage (raw string)", () => {
      // Pre-v1.4.12 stored just the access token plaintext. Decoder
      // detects this (not JSON) and returns null so the caller can
      // mark the connection expired.
      const dec = decryptCodexCreds({
        accessEncrypted: "enc:legacy-raw-token",
        refreshEncrypted: "enc:refresh",
      });
      expect(dec).toBeNull();
    });
  });
});
