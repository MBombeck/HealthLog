/**
 * The moodLog bridge stays removed.
 *
 * It was retired once before, in pieces: the Settings card went in June, the
 * cron, webhook, credentials, ledger entry and roughly twenty i18n keys stayed
 * behind, and for a month the code ran hourly against an upstream that had
 * stopped answering while nothing on any screen said so. Half-removed was
 * worse than either finished state.
 *
 * This test pins the finished state. It is a structural guard, not a
 * behavioural one: it fails the moment a moodLog surface reappears, so a
 * reintroduction has to be a decision someone writes down rather than a merge
 * that slips through.
 *
 * What it deliberately does NOT forbid: the `MOODLOG` mood-entry source value
 * and its label. Rows the bridge imported are the user's own history, they
 * keep their provenance, and every read path must go on resolving it.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { allJobDefinitions } from "@/lib/jobs/registry/index";
import { describe, expect, it } from "vitest";

import { INTEGRATION_CADENCE } from "@/lib/integrations/sync-verdict";
import { INTEGRATION_DISPLAY_NAMES } from "@/components/settings/integrations/integration-fallback-row";

const ROOT = path.resolve(__dirname, "../..");

const LOCALES = [
  "de",
  "en",
  "es",
  "fr",
  "it",
  "pl",
  "ko",
  "nl",
  "pt-BR",
] as const;

/** Every path the retired bridge occupied. */
const REMOVED_PATHS = [
  "src/lib/moodlog",
  "src/lib/moodlog-secret.ts",
  "src/lib/jobs/reminder/moodlog-sync.ts",
  "src/app/api/integrations/moodlog",
  "src/app/api/settings/moodlog",
  "src/lib/validations/moodlog.ts",
];

/** Columns migration 0271 dropped. */
const REMOVED_SCHEMA_FIELDS = [
  "moodLogUrlEncrypted",
  "moodLogApiKeyEncrypted",
  "moodLogEnabled",
  "moodLogLastSyncedAt",
  "moodLogWebhookSecret",
  "moodLogGlobal",
];

describe("moodLog integration stays removed", () => {
  it("has no moodLog module, route or validation file", () => {
    for (const rel of REMOVED_PATHS) {
      expect(existsSync(path.join(ROOT, rel)), `${rel} is back`).toBe(false);
    }
  });

  it("declares no moodLog column on the Prisma schema", () => {
    const schema = readFileSync(
      path.join(ROOT, "prisma/schema.prisma"),
      "utf8",
    );
    for (const field of REMOVED_SCHEMA_FIELDS) {
      expect(schema, `${field} is back on the schema`).not.toContain(field);
    }
  });

  it("registers no moodlog queue, cron or handler binding", () => {
    const queues = allJobDefinitions().map((job) => job.queue);
    expect(queues.length).toBeGreaterThan(100);
    expect(queues.filter((queue) => /mood-?log/i.test(queue))).toEqual([]);
  });

  it("carries no moodlog integration key on the status envelope", () => {
    expect(Object.keys(INTEGRATION_CADENCE)).not.toContain("moodlog");
    expect(Object.keys(INTEGRATION_DISPLAY_NAMES)).not.toContain("moodlog");
  });

  it("keeps no orphaned moodLog message key in any locale", () => {
    for (const locale of LOCALES) {
      const bundle = JSON.parse(
        readFileSync(path.join(ROOT, `messages/${locale}.json`), "utf8"),
      ) as {
        settings: Record<string, unknown>;
        admin: Record<string, unknown>;
      };
      const orphans = [
        ...Object.keys(bundle.settings),
        ...Object.keys(bundle.admin),
      ].filter((key) => key.startsWith("moodLog"));
      expect(orphans, `${locale} still carries moodLog keys`).toEqual([]);
    }
  });

  it("still resolves the MOODLOG provenance of imported mood rows", () => {
    // The other half of the contract: removing the bridge must not erase the
    // history it wrote. The source badge label has to survive the removal.
    const en = JSON.parse(
      readFileSync(path.join(ROOT, "messages/en.json"), "utf8"),
    ) as { mood: Record<string, string> };
    expect(en.mood.sourceMoodlog).toBeTruthy();
  });
});
