/**
 * The token revoke confirmation names the act.
 *
 * Both token lists (API tokens and MCP connections) labelled the dialog's
 * confirm button with `settings.tokenRevoked` — "Revoked", the status word the
 * admin overview shows for a token that is already gone — so the button that
 * performs the revoke read as if it had happened. The phone layout's trigger
 * carried the dialog title instead, question mark included.
 *
 * Read from the source because the dialog content only mounts while open, and
 * an SSR render never sees it. What is pinned: every `AlertDialogAction` that
 * calls `handleRevoke` is labelled with the action key, and no trigger or
 * action on these two surfaces uses the status word.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const FILES = [
  "src/components/settings/api-section.tsx",
  "src/components/settings/mcp-section.tsx",
];

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/**
 * Every confirm the source spells: an `<AlertDialogAction …>…</AlertDialogAction>`
 * block, or a `<ConfirmButton … />` / `<ConfirmDialog … />` whose
 * `confirmLabel` is the action label.
 */
function actions(source: string): string[] {
  return [
    ...source.matchAll(/<AlertDialogAction\b[\s\S]*?<\/AlertDialogAction>/g),
    ...source.matchAll(/<ConfirmButton\b[\s\S]*?\/>/g),
    ...source.matchAll(/<ConfirmDialog\b[\s\S]*?\/>/g),
  ].map((m) => m[0]);
}

describe("token revoke labels", () => {
  for (const rel of FILES) {
    it(`${rel}: the revoke confirm says "Revoke token"`, () => {
      const revokes = actions(read(rel)).filter(
        (a) => a.includes("handleRevoke(tok.id)") || a.includes("revoke()"),
      );
      expect(revokes.length).toBeGreaterThan(0);
      for (const action of revokes) {
        expect(action).toMatch(
          /(confirmLabel=\{|>\s*\{)t\("settings\.tokenRevokeAction"\)/,
        );
      }
    });

    it(`${rel}: never labels a control with the status word`, () => {
      expect(read(rel)).not.toContain('t("settings.tokenRevoked")');
    });
  }
});
