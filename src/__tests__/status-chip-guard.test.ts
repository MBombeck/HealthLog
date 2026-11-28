/**
 * A status goes through `StatusChip` (`src/components/ui/status-chip.tsx`),
 * everywhere under `src/components` and `src/app`.
 *
 * Integrations, delivery channels, AI providers and module states said their
 * state five ways: "Working", "On", "Active", "Configured", "Auto-disabled",
 * a red sentence in place of a badge, and on Telegram, ntfy, Webhook and Email
 * nothing at all. Each surface painted its own `Badge` with its own wash and
 * its own word. This guard keeps a new one from appearing beside the chip.
 *
 * The guard started in Settings; outside it, admin said "Configured" in a
 * green wash of its own, and the same idiom stood in the catalogue, the
 * token overview and the provider health card. `RATCHET` holds the files
 * that still paint one, with their count; it may only shrink.
 *
 * Matched, under `src/components/` and `src/app/`:
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

/** Settings badges that are not an integration, channel, provider or module. */
const ALLOWED: Record<string, string> = {
  "components/settings/sharing-section.tsx":
    "a share link's lifecycle and protection, not a connection",
  "components/settings/mcp-section.tsx":
    "token expiry in the connector token table (the table moves in 1.51)",
  "components/settings/api-section.tsx":
    "token expiry in the API token table (the table moves in 1.51)",
};

/**
 * Hand-rolled status badges outside Settings today, per file. A count may
 * only fall: a file that paints more fails, and a file that paints fewer
 * fails until its number here is lowered (or its line deleted).
 */
const RATCHET: Record<string, number> = {
  // A run or a health state that StatusChip should say.
  "components/admin/central-codex-section.tsx": 1, // connected / expired / disconnected
  "components/admin/provider-health-section.tsx": 3, // healthy / paused / failing with counts
  "components/admin/recovery-kit-card.tsx": 1, // not configured / new
  "components/admin/glitchtip-section.tsx": 1, // "unproven" warning wash
  "components/admin/encryption-section.tsx": 1, // "safe to drop" success wash
  // Token lifecycle, as in the settings token tables (moves in 1.51).
  "components/admin/api-token-overview-section.tsx": 2,
  // A record's course, not works or fails: TagChip or ScorePill, not here.
  "components/illness/illness-episode-detail.tsx": 1,
  "components/illness/illness-view.tsx": 2,
  "components/medications/card-parts/medication-state-badges.tsx": 1,
  "components/medications/intake-history-list-v2.tsx": 1,
  "app/insights/catalog/page.tsx": 1,
};

const BADGE_RE = /<Badge\b([^>]*)>([\s\S]*?)<\/Badge>/g;
const KEY_RE = /\bt\(\s*["'`]([\w.-]+)["'`]/g;
const STATUS_KEY =
  /(?:^|\.)(?:status\w*|state\w*|\w*(?:Active|Inactive|Connected|Disconnected|Configured|Enabled|Disabled|Expired|Running|Working)\w*|active|inactive|connected|disconnected|configured|enabled|disabled|expired|running|working|on|off)$/;
const STATUS_WASH = /\bbg-(?:success|warning|destructive|info)\/1[05]\b/;

/** Hand-rolled status badges per file (one per matching `<Badge>`). */
function countStatusBadges(
  files: { path: string; source: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { path, source } of files) {
    for (const [, attrs, body] of source.matchAll(BADGE_RE)) {
      const keyed = [...body.matchAll(KEY_RE)].some((k) =>
        STATUS_KEY.test(k[1]),
      );
      if (STATUS_WASH.test(attrs) || keyed)
        counts[path] = (counts[path] ?? 0) + 1;
    }
  }
  return counts;
}

const findStatusBadges = (files: { path: string; source: string }[]) =>
  Object.keys(countStatusBadges(files)).sort();

const readTree = (dir: "components" | "app", floor: number) =>
  readSourceFolder(`src/${dir}`, {
    floor,
    include: (p) => !p.includes("__tests__/") && !/\.test\.tsx?$/.test(p),
  }).map(([path, source]) => ({ path: `${dir}/${path}`, source }));

describe("status goes through StatusChip", () => {
  const all = [...readTree("components", 800), ...readTree("app", 400)];
  const files = all.filter((f) => f.path.startsWith("components/settings/"));
  const outside = all.filter((f) => !f.path.startsWith("components/settings/"));

  it("walks the Settings tree and the rest of components and app", () => {
    expect(files.length).toBeGreaterThan(150);
    expect(outside.length).toBeGreaterThan(1000);
  });

  it("paints no hand-rolled status badge outside Settings beyond the ratchet", () => {
    const counts = countStatusBadges(outside);
    const over = Object.entries(counts)
      .filter(([path, n]) => n > (RATCHET[path] ?? 0))
      .map(([path, n]) => `${path}: ${n} (ratchet ${RATCHET[path] ?? 0})`);
    expect(over).toEqual([]);
  });

  it("lets the ratchet only shrink (lower a count once a badge moves)", () => {
    const counts = countStatusBadges(outside);
    const stale = Object.entries(RATCHET)
      .filter(([path, n]) => (counts[path] ?? 0) < n)
      .map(([path, n]) => `${path}: ${counts[path] ?? 0} < ${n}`);
    expect(stale).toEqual([]);
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

  it("gives every surface the same five words", () => {
    const chip = readSource(
      "src/components/ui/status-chip.tsx",
      "export function StatusChip",
    );
    for (const word of ["active", "error", "off", "running", "done"])
      expect(chip).toContain(`t("common.status.${word}")`);
  });
});
