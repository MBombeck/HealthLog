/**
 * Every `AppSettings` column has a backup verdict, and the payload schema
 * accepts exactly the columns the verdicts carry.
 *
 * The instance-settings section used to be exported by spreading the whole
 * row and restored from a list kept by hand. Four operator settings (the AI
 * usage bounds and the regeneration gap among them) left in the file and came
 * back as defaults, and a column added to the row tomorrow, a secret
 * included, would have ridden into every disaster-recovery file without
 * anyone deciding it should. Both ends now walk `app-settings-columns.ts`;
 * this holds that table to the schema and the payload schema to the table.
 * The table's `satisfies` already refuses a column with no verdict at compile
 * time; this is the same question asked of `prisma/schema.prisma` itself, so
 * a stale client cannot answer it.
 *
 * Mutation check: add a column to `model AppSettings` and the first case
 * names it; drop a key from the payload schema, or carry a new column without
 * adding it there, and the third case names it.
 */
import { describe, expect, it } from "vitest";

import { Prisma, type AppSettings } from "@/generated/prisma/client";
import { readSource } from "@/__tests__/helpers/source-files";
import { parseWipeSchema } from "@/__tests__/helpers/wipe-schema-shape";
import { appSettingsBackupSchema } from "@/lib/export/app-settings-backup-schema";
import {
  appSettingsRowFromFile,
  serialiseAppSettings,
} from "@/lib/export/app-settings-backup";
import {
  APP_SETTINGS_CARRIED_COLUMNS,
  APP_SETTINGS_COLUMNS,
} from "@/lib/export/app-settings-columns";

const columns = parseWipeSchema().get("AppSettings")?.scalars ?? [];
const verdicts = APP_SETTINGS_COLUMNS as Readonly<
  Record<string, { class: string }>
>;

describe("AppSettings column backup classification", () => {
  it("gives every AppSettings column a verdict", () => {
    expect(columns.length).toBeGreaterThan(50);
    expect(
      columns.filter((column) => !Object.hasOwn(verdicts, column)),
      "these AppSettings columns have no backup verdict. Add each to " +
        "app-settings-columns.ts as SETTING or CREDENTIAL (it travels and " +
        "is written back) or OPERATIONAL with the reason it stays behind",
    ).toEqual([]);
  });

  it("names no column the schema no longer has", () => {
    const known = new Set(columns);
    expect(Object.keys(verdicts).filter((c) => !known.has(c))).toEqual([]);
  });

  it("accepts exactly the carried columns in the payload schema", () => {
    expect(Object.keys(appSettingsBackupSchema.shape).sort()).toEqual(
      [...APP_SETTINGS_CARRIED_COLUMNS].sort(),
    );
  });

  it("writes every Json column through the json codec, so its null is DbNull", () => {
    const schema = readSource("prisma/schema.prisma", "model AppSettings {");
    const block = schema.slice(
      schema.indexOf("model AppSettings {"),
      schema.indexOf("\n}", schema.indexOf("model AppSettings {")),
    );
    const jsonColumns = [...block.matchAll(/^\s+(\w+)\s+Json\??/gm)].map(
      (m) => m[1],
    );
    expect(jsonColumns.length).toBeGreaterThan(2);
    const codecs = APP_SETTINGS_COLUMNS as Readonly<
      Record<string, { codec?: string }>
    >;
    expect(
      jsonColumns.filter(
        (c) =>
          verdicts[c].class !== "OPERATIONAL" && codecs[c].codec !== "json",
      ),
    ).toEqual([]);
    expect(
      appSettingsRowFromFile({ serverSetupStepsJson: null }),
    ).toMatchObject({ serverSetupStepsJson: Prisma.DbNull });
  });

  it("classifies every sealed or token-shaped column as a credential", () => {
    const shaped = columns.filter((c) =>
      /Encrypted$|Token|Secret|Dsn|password/i.test(c),
    );
    expect(shaped.length).toBeGreaterThan(4);
    expect(shaped.filter((c) => verdicts[c].class !== "CREDENTIAL")).toEqual(
      [],
    );
  });

  it("writes back what it exported, and nothing operational", () => {
    // A row with every carried column set away from its default, through
    // both ends and the payload schema between them.
    const row: AppSettings = {
      id: "singleton",
      registrationEnabled: false,
      mfaRequired: true,
      defaultLocale: "fr",
      telegramGlobal: false,
      ntfyGlobal: false,
      webPushGlobal: false,
      webPushVapidPublicKey: "pub",
      webPushVapidPrivateKeyEncrypted: "sealed-priv",
      webPushVapidSubject: "mailto:ops@example.test",
      apiGlobal: false,
      umamiEnabled: true,
      umamiScriptUrl: "https://stats.example.test/s.js",
      umamiWebsiteId: "site",
      glitchtipEnabled: true,
      glitchtipDsn: "sealed-dsn",
      glitchtipEnvironment: "prod",
      glitchtipLastOkAt: new Date("2026-11-01T00:00:00.000Z"),
      glitchtipLastFailureAt: new Date("2026-11-02T00:00:00.000Z"),
      glitchtipLastFailureReason: "timeout",
      reminderLateMinutes: 30,
      reminderMissedMinutes: 90,
      adminAiKeyEncrypted: "sealed-key",
      adminAiModel: "model",
      adminAiBaseUrl: "https://ai.example.test/v1",
      adminCodexAccessTokenEncrypted: "sealed-a",
      adminCodexRefreshTokenEncrypted: "sealed-r",
      adminCodexAccountIdEncrypted: "sealed-id",
      adminCodexTokenExpiresAt: new Date("2026-12-01T00:00:00.000Z"),
      adminCodexConnectedAt: new Date("2026-10-01T00:00:00.000Z"),
      adminCodexConnectionStatus: "connected",
      adminAiInsightsFeedbackSummary: { helpful: 3 },
      defaultUserTimezone: "America/Chicago",
      assistantEnabled: false,
      assistantCoachEnabled: false,
      assistantBriefingEnabled: false,
      assistantInsightStatusEnabled: false,
      assistantDocumentAiEnabled: false,
      aiUsageMaxLevel: "FULL",
      aiUsageDefaultLevel: "FRUGAL",
      aiSyncRegenGapHours: 12,
      aiReasoningEnabled: false,
      aiReasoningMaxEffort: "low",
      moduleAvailabilityJson: { labs: false },
      documentMaxFileBytes: 1_048_576,
      documentQuotaBytes: BigInt(5_000_000_000),
      correlationSeasonalEngineSince: new Date("2026-09-01T00:00:00.000Z"),
      pulseDayMeanMethod: "weighted_hour_mean_v2",
      pulseDayMeanAppliedAt: new Date("2026-09-02T00:00:00.000Z"),
      pulseDayMeanDryRunJson: { changed: 1 },
      workoutClimbBackfillCursor: "cursor",
      serverSetupCompletedAt: new Date("2026-11-20T00:00:00.000Z"),
      serverSetupStepsJson: { done: ["registration"] },
      pushRelayDecision: "off",
    };
    // The fixture is itself held to the schema, so a new column cannot be
    // left out of this case.
    expect(Object.keys(row).sort()).toEqual([...columns].sort());

    const file = JSON.parse(
      JSON.stringify(serialiseAppSettings(row)),
    ) as Record<string, unknown>;
    const parsed = appSettingsBackupSchema.parse(file);
    const written = appSettingsRowFromFile(parsed);

    const expected = Object.fromEntries(
      APP_SETTINGS_CARRIED_COLUMNS.filter((c) => c !== "id").map((c) => [
        c,
        row[c],
      ]),
    );
    expect(written).toEqual(expected);
    for (const [column, verdict] of Object.entries(verdicts)) {
      if (verdict.class === "OPERATIONAL") {
        expect(file, column).not.toHaveProperty(column);
        expect(written, column).not.toHaveProperty(column);
      }
    }
  });

  it("restores an older file's missing settings at their defaults, or not at all", () => {
    const written = appSettingsRowFromFile({});
    // Absent from a file older than the column: the host ran on the default.
    expect(written.aiReasoningEnabled).toBe(true);
    expect(written.assistantDocumentAiEnabled).toBe(true);
    // Absent from a file that could have carried them and did not: the
    // file says nothing, so the host keeps its value.
    expect(written).not.toHaveProperty("aiUsageMaxLevel");
    expect(written).not.toHaveProperty("aiUsageDefaultLevel");
    expect(written).not.toHaveProperty("aiSyncRegenGapHours");
    expect(written).not.toHaveProperty("registrationEnabled");
    expect(written).not.toHaveProperty("serverSetupCompletedAt");
    expect(written).not.toHaveProperty("serverSetupStepsJson");
    expect(written).not.toHaveProperty("pushRelayDecision");
  });

  it("refuses a relay decision the column's CHECK would refuse", () => {
    const decision = appSettingsBackupSchema.shape.pushRelayDecision;
    expect(decision.safeParse("maybe").success).toBe(false);
    expect(decision.safeParse("on").success).toBe(true);
    expect(decision.safeParse(null).success).toBe(true);
  });
});
