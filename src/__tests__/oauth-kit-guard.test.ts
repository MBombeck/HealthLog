/**
 * Every OAuth provider integration goes through the one token lifecycle.
 *
 * `src/lib/integrations/oauth-kit/token.ts` owns reading a grant, deciding it
 * needs a refresh, refreshing under the advisory lock, and writing the result
 * back conditionally. It replaced seven copies of that sequence, which had
 * drifted into four different safety levels, one of them a status route that
 * refreshed a one-time token with no guard at all. This file is what stops an
 * eighth copy:
 *
 *   A. Each kit provider has `src/lib/<provider>/oauth-descriptor.ts`, and the
 *      descriptor names that provider.
 *   B. A provider's refresh (`<provider>OAuth.refresh(…)`, from the shared
 *      OAuth client factory) is called by that provider's descriptor and by
 *      nothing else outside tests.
 *   C. The refresh lock is taken by the kit and by the AI provider store
 *      (`src/lib/ai/provider.ts`, which is not an integration) only.
 *   D. A token is sealed into a connection row only by a callback route
 *      (the connect-time write). The kit writes ciphertext the descriptor is
 *      handed and never encrypts on its own.
 *   E. A provider integration speaks to a token endpoint only through the
 *      factory (`oauth-kit/client.ts`): no other integration module builds a
 *      `grant_type` form. Sign-in (OIDC), the MCP authorization server and
 *      the Codex device login are not provider integrations.
 *
 * Fitbit is the one listed exception to the lifecycle: the classic Fitbit Web
 * API is retired on 2026-10-30 and its integration rides out on its own
 * refresh until then, rather than being migrated onto a lifecycle it will
 * never use. Its wire goes through the factory like every other provider's.
 *
 * Every leg asserts a non-empty match set before it compares, so a matcher
 * that stops matching fails instead of passing.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readSourceText, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** The providers whose tokens the kit manages. */
const KIT_PROVIDERS = [
  "withings",
  "whoop",
  "oura",
  "strava",
  "google-health",
  "polar",
] as const;

/** Retired on 2026-10-30; keeps its own refresh until it is removed. */
const RETIRED = new Set(["src/lib/fitbit/sync-core.ts"]);

function productionFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((f) => !f.startsWith("generated/"))
    .filter((f) => !f.includes("__tests__/") && !/\.test\.tsx?$/.test(f))
    .map((f) => `src/${f}`);
}

function read(rel: string): string {
  return readSourceText(join(process.cwd(), rel));
}

describe("OAuth token lifecycle guard", () => {
  const files = productionFiles();

  it("A: every kit provider has a descriptor naming it", () => {
    for (const provider of KIT_PROVIDERS) {
      const rel = `src/lib/${provider}/oauth-descriptor.ts`;
      expect(existsSync(join(process.cwd(), rel)), rel).toBe(true);
      expect(read(rel)).toMatch(new RegExp(`provider:\\s*"${provider}"`));
    }
  });

  it("B: a provider's refresh is called only by its descriptor", () => {
    const callers = files.filter((f) =>
      /\b[a-z][A-Za-z]*OAuth\.refresh\s*\(/.test(read(f)),
    );
    expect(callers.length).toBeGreaterThan(0);
    const allowed = new Set([
      ...KIT_PROVIDERS.filter((p) => p !== "polar").map(
        (p) => `src/lib/${p}/oauth-descriptor.ts`,
      ),
      ...RETIRED,
    ]);
    expect(callers.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it("C: only the kit and the AI provider store take the refresh lock", () => {
    const callers = files.filter((f) =>
      /\bacquireProviderTokenRefreshLock\s*\(/.test(read(f)),
    );
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.sort()).toEqual([
      "src/lib/ai/provider.ts",
      "src/lib/integrations/oauth-kit/token.ts",
      "src/lib/integrations/oauth-refresh.ts",
    ]);
  });

  it("D: tokens are sealed into a connection only by a callback", () => {
    const sealing = files.filter((f) =>
      /\b(?:accessToken|refreshToken|[a-z]+AccessTokenEncrypted|[a-z]+RefreshTokenEncrypted):\s*encrypt\(/.test(
        read(f),
      ),
    );
    expect(sealing.length).toBeGreaterThan(0);
    const offenders = sealing.filter(
      (f) =>
        !RETIRED.has(f) &&
        !/^src\/app\/api\/[a-z-]+\/callback\/route\.ts$/.test(f),
    );
    expect(offenders).toEqual([]);
  });

  it("E: provider integrations reach a token endpoint only through the factory", () => {
    const forms = files.filter((f) => /\bgrant_type\b/.test(read(f)));
    expect(forms.length).toBeGreaterThan(0);
    const NOT_INTEGRATIONS = new Set([
      "src/lib/integrations/oauth-kit/client.ts",
      "src/lib/auth/oidc.ts",
      "src/lib/ai/codex-oauth.ts",
      "src/lib/mcp/oauth/metadata.ts",
      "src/app/api/mcp/oauth/token/route.ts",
      "src/app/api/mcp/oauth/register/route.ts",
    ]);
    expect(forms.filter((f) => !NOT_INTEGRATIONS.has(f)).sort()).toEqual([]);
  });
});
