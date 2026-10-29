/**
 * The routes that connect or disconnect a stored Codex credential tell the
 * per-sign-in memory, so the vision gate, which holds no account id, stops
 * reading what the previous sign-in learned (`codex-slug-cache.ts`). The
 * account-checked client reads cover every other path; this file holds the
 * four call sites.
 */
import { describe, expect, it } from "vitest";

import { readSource } from "@/__tests__/helpers/source-files";

describe("Codex sign-in routes", () => {
  it("tells the sign-in memory about every connect and disconnect", () => {
    const routes: Array<[string, RegExp]> = [
      [
        "src/app/api/auth/codex/device-poll/route.ts",
        /startCodexSignIn\(\{\s*key: codexCredentialKey\.user\(user\.id\),\s*accountId: result\.creds\.accountId/,
      ],
      [
        "src/app/api/admin/central-codex/device-poll/route.ts",
        /startCodexSignIn\(\{\s*key: codexCredentialKey\.central,\s*accountId: result\.creds\.accountId/,
      ],
      [
        "src/app/api/auth/codex/disconnect/route.ts",
        /forgetCodexSignIn\(codexCredentialKey\.user\(user\.id\)\)/,
      ],
      [
        "src/app/api/admin/central-codex/route.ts",
        /forgetCodexSignIn\(codexCredentialKey\.central\)/,
      ],
    ];
    for (const [file, call] of routes) {
      expect(readSource(file, call), file).toMatch(call);
    }
  });
});
