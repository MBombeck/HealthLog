/**
 * A status in Settings goes through `StatusChip` (`src/components/ui/status-chip.tsx`).
 *
 * Integrations, delivery channels, AI providers and module states said their
 * state five ways: "Working", "On", "Active", "Configured", "Auto-disabled",
 * a red sentence in place of a badge, and on Telegram, ntfy, Webhook and Email
 * nothing at all. Each surface painted its own `Badge` with its own wash and
 * its own word. This guard keeps a new one from appearing beside the chip.
 *
 * Matched, under `components/settings/`:
 *   - a `<Badge …>…</Badge>` whose text is a translation key ending in a
 *     status word (`status…`, `state…`, `active`, `connected`, `configured`,
 *     `enabled`, `expired`, `on`, `off`, …);
 *   - a `<Badge` that paints a status wash itself (`bg-success/15`,
 *     `bg-warning/15`, `bg-destructive/15`, …).
 *
 * Not matched: a badge whose word is not a status (a tag such as "Default",
 * "Beta" or "Override"), or a status word assembled at runtime from a map in
 * another literal. The guard catches the idiom, not every way to paint one.
 */
import { describe, expect, it } from "vitest";

import { readSource, readSourceFolder } from "./helpers/source-files";

/** Status badges that are not an integration, channel, provider or module. */
const ALLOWED: Record<string, string> = {
  "components/settings/sharing-section.tsx":
    "a share link's lifecycle and protection, not a connection",
  "components/settings/mcp-section.tsx":
    "token expiry in the connector token table (the table moves in 1.51)",
  "components/settings/api-section.tsx":
    "token expiry in the API token table (the table moves in 1.51)",
};

const BADGE_RE = /<Badge\b([^>]*)>([\s\S]*?)<\/Badge>/g;
const KEY_RE = /\bt\(\s*["'`]([\w.-]+)["'`]/g;
const STATUS_KEY =
  /(?:^|\.)(?:status\w*|state\w*|\w*(?:Active|Inactive|Connected|Disconnected|Configured|Enabled|Disabled|Expired|Running|Working)\w*|active|inactive|connected|disconnected|configured|enabled|disabled|expired|running|working|on|off)$/;
const STATUS_WASH = /\bbg-(?:success|warning|destructive|info)\/1[05]\b/;

function findStatusBadges(files: { path: string; source: string }[]): string[] {
  const hits = new Set<string>();
  for (const { path, source } of files) {
    for (const match of source.matchAll(BADGE_RE)) {
      const [, attrs, body] = match;
      if (STATUS_WASH.test(attrs)) hits.add(path);
      for (const key of body.matchAll(KEY_RE)) {
        if (STATUS_KEY.test(key[1])) hits.add(path);
      }
    }
  }
  return [...hits].sort();
}

describe("status in Settings goes through StatusChip", () => {
  const files = readSourceFolder("src/components/settings", {
    floor: 150,
    include: (p) => !p.includes("__tests__/"),
  }).map(([path, source]) => ({
    path: `components/settings/${path}`,
    source,
  }));

  it("walks the Settings tree", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it("has no hand-rolled status badge outside the allowlist", () => {
    expect(findStatusBadges(files).filter((p) => !(p in ALLOWED))).toEqual([]);
  });

  it("keeps every allowlist entry live", () => {
    const hits = new Set(findStatusBadges(files));
    for (const key of Object.keys(ALLOWED))
      expect(hits.has(key), key).toBe(true);
  });

  it("recognises the idioms it exists to refuse", () => {
    const sample = (source: string) =>
      findStatusBadges([{ path: "x.tsx", source }]);
    expect(
      sample(
        `<Badge variant="outline">{t("settings.x.statusConnected")}</Badge>`,
      ),
    ).toEqual(["x.tsx"]);
    expect(
      sample(
        `<Badge variant="secondary">{t("settings.moduleState.on")}</Badge>`,
      ),
    ).toEqual(["x.tsx"]);
    expect(
      sample(
        `<Badge className="border-success/30 bg-success/15 text-success">{word}</Badge>`,
      ),
    ).toEqual(["x.tsx"]);
    expect(
      sample(
        `<Badge variant="secondary">{t("settings.ai.defaultBadge")}</Badge>`,
      ),
    ).toEqual([]);
    expect(sample(`<StatusChip tone="active" />`)).toEqual([]);
  });

  it("gives every surface the same three words", () => {
    const chip = readSource(
      "src/components/ui/status-chip.tsx",
      "export function StatusChip",
    );
    for (const word of ["active", "error", "off"])
      expect(chip).toContain(`t("common.status.${word}")`);
  });
});
