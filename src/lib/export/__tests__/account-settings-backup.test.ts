/**
 * The account-settings section at both ends, without a database.
 *
 * The integration round trip proves every setting column comes back; this
 * file pins what the restore refuses and why, and what a portable file shows
 * a person instead of ciphertext. Every refusal here leaves the account's
 * current value in place and names the column in the restore's skip report.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { Prisma } from "@/generated/prisma/client";
import { decrypt, encrypt } from "@/lib/crypto";
import {
  ACCOUNT_SETTING_COLUMNS,
  admitAccountSettings,
  buildAccountSettingsBackupSection,
} from "@/lib/export/account-settings-backup";
import { UNREADABLE_EXPORT_MARKER } from "@/lib/export/unreadable-marker";
import { reasoningEffortFor } from "@/lib/ai/reasoning-effort";
import {
  coachReasoningLevel,
  parseCoachPrefs,
} from "@/lib/validations/coach-prefs";

/** A 1x1 PNG, the smallest image the avatar upload accepts. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const ctx = { operatorTrusted: false };

function rowWith(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = Object.fromEntries(
    ACCOUNT_SETTING_COLUMNS.map((column) => [column, null]),
  );
  return { ...row, ...overrides };
}

function prismaReturning(row: Record<string, unknown> | null) {
  return { user: { findUnique: vi.fn().mockResolvedValue(row) } } as never;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildAccountSettingsBackupSection", () => {
  it("writes only setting columns, plus the readable insurance number alias", async () => {
    const { accountSettings } = await buildAccountSettingsBackupSection(
      prismaReturning(rowWith()),
      "u1",
      { purpose: "disaster-recovery" },
    );
    const allowed = new Set<string>([
      ...ACCOUNT_SETTING_COLUMNS,
      "insuranceNumber",
    ]);
    expect(
      Object.keys(accountSettings!).filter((key) => !allowed.has(key)),
    ).toEqual([]);
  });

  it("carries the insurance number sealed in a disaster-recovery file", async () => {
    const sealed = encrypt("A123456789");
    const { accountSettings } = await buildAccountSettingsBackupSection(
      prismaReturning(rowWith({ insuranceNumberEncrypted: sealed })),
      "u1",
      { purpose: "disaster-recovery" },
    );
    expect(accountSettings).toMatchObject({
      insuranceNumber: null,
      insuranceNumberEncrypted: sealed,
    });
  });

  it("carries it readable in a portable file, and never the ciphertext", async () => {
    const { accountSettings } = await buildAccountSettingsBackupSection(
      prismaReturning(
        rowWith({ insuranceNumberEncrypted: encrypt("A123456789") }),
      ),
      "u1",
      { purpose: "portable-export" },
    );
    expect(accountSettings!.insuranceNumber).toBe("A123456789");
    expect(accountSettings).not.toHaveProperty("insuranceNumberEncrypted");
  });

  it("writes the marker for an insurance number this host cannot open", async () => {
    const { accountSettings } = await buildAccountSettingsBackupSection(
      prismaReturning(rowWith({ insuranceNumberEncrypted: "zz.notreal" })),
      "u1",
      { purpose: "portable-export" },
    );
    expect(accountSettings!.insuranceNumber).toBe(UNREADABLE_EXPORT_MARKER);
  });

  it("answers null for an account that is not there", async () => {
    expect(
      await buildAccountSettingsBackupSection(prismaReturning(null), "u1"),
    ).toEqual({ accountSettings: null });
  });
});

describe("admitAccountSettings", () => {
  it("leaves out what the file does not carry", () => {
    expect(admitAccountSettings({}, ctx)).toEqual({ data: {}, refused: [] });
  });

  it("refuses a language, unit or time zone this release does not know", () => {
    const { data, refused } = admitAccountSettings(
      {
        locale: "xx",
        unitPreference: "furlongs",
        glucoseUnit: "mmol/L",
        timezone: "Mars/Olympus_Mons",
        homeTimezone: "Europe/Lisbon",
        timeFormat: "H36",
        dateFormat: "YMD",
      },
      ctx,
    );
    expect(refused.sort()).toEqual([
      "locale",
      "timeFormat",
      "timezone",
      "unitPreference",
    ]);
    expect(data).toEqual({
      glucoseUnit: "mmol/L",
      homeTimezone: "Europe/Lisbon",
      dateFormat: "YMD",
    });
  });

  it("refuses an AI endpoint on a private address this host has not allowed", () => {
    vi.stubEnv("AI_PRIVATE_ORIGINS", "");
    const { data, refused } = admitAccountSettings(
      {
        aiProvider: "LOCAL",
        aiBaseUrl: "http://192.168.1.20:11434",
        aiCompatBaseUrl: "http://169.254.169.254/latest",
      },
      ctx,
    );
    expect(refused.sort()).toEqual(["aiBaseUrl", "aiCompatBaseUrl"]);
    expect(data).toEqual({ aiProvider: "LOCAL" });
  });

  it("keeps a private AI endpoint the operator allowed here", () => {
    vi.stubEnv("AI_PRIVATE_ORIGINS", "http://ollama.lan:11434");
    const { data, refused } = admitAccountSettings(
      { aiProvider: "LOCAL", aiBaseUrl: "http://ollama.lan:11434" },
      ctx,
    );
    expect(refused).toEqual([]);
    expect(data.aiBaseUrl).toBe("http://ollama.lan:11434");
  });

  it("does not attach a base URL to a provider other than Local", () => {
    const { data, refused } = admitAccountSettings(
      { aiProvider: "OPENAI", aiBaseUrl: "https://llm.example.com/v1" },
      ctx,
    );
    expect(refused).toEqual(["aiBaseUrl"]);
    expect(data).toEqual({ aiProvider: "OPENAI" });
  });

  it("reads the provider the account already has when the file names none", () => {
    expect(
      admitAccountSettings(
        { aiBaseUrl: "https://llm.example.com/v1" },
        ctx,
        "LOCAL",
      ).data,
    ).toEqual({ aiBaseUrl: "https://llm.example.com/v1" });
  });

  it("keeps the valid threshold bands and names the ones it drops", () => {
    const { data, refused } = admitAccountSettings(
      {
        thresholdsJson: {
          WEIGHT: { min: 60, max: 80 },
          PULSE: { min: 100, max: 50 },
          RETIRED_METRIC: { min: 1, max: 2 },
        },
      },
      ctx,
    );
    expect(data.thresholdsJson).toEqual({ WEIGHT: { min: 60, max: 80 } });
    expect(refused.sort()).toEqual([
      "thresholdsJson.PULSE",
      "thresholdsJson.RETIRED_METRIC",
    ]);
  });

  // #1126 — the reasoning setting lives on the provider chain entries, so
  // the chain column carries it through a backup unchanged.
  it("carries the provider chain's reasoning settings through a round trip", async () => {
    const chain = [
      {
        providerType: "local",
        priority: 1,
        enabled: true,
        reasoningEffort: "none",
      },
      {
        providerType: "openai-compatible",
        priority: 2,
        enabled: false,
        reasoningEffort: "high",
      },
      { providerType: "openai", priority: 3, enabled: true },
    ];
    const { accountSettings } = await buildAccountSettingsBackupSection(
      prismaReturning(rowWith({ aiProviderChain: chain })),
      "u1",
      { purpose: "disaster-recovery" },
    );
    const restored = admitAccountSettings(
      JSON.parse(JSON.stringify(accountSettings)),
      ctx,
    ).data.aiProviderChain;
    expect(restored).toEqual(chain);
    expect(reasoningEffortFor(restored, "local")).toBe("none");
    expect(reasoningEffortFor(restored, "openai-compatible")).toBe("high");
  });

  it("carries the Coach's thinking depth through a round trip", async () => {
    const prefs = {
      tone: "warm",
      verbosity: "default",
      excludeMetrics: [],
      showEvidenceByDefault: false,
      defaultWindow: "allTime",
      reasoning: "high",
    };
    const { accountSettings } = await buildAccountSettingsBackupSection(
      prismaReturning(rowWith({ coachPrefsJson: prefs })),
      "u1",
      { purpose: "portable-export" },
    );
    const restored = admitAccountSettings(
      JSON.parse(JSON.stringify(accountSettings)),
      ctx,
    ).data.coachPrefsJson;
    expect(restored).toEqual(prefs);
    expect(coachReasoningLevel(parseCoachPrefs(restored))).toBe("high");
  });

  it("writes a database null for a JSON setting the file clears", () => {
    expect(
      admitAccountSettings({ dashboardWidgetsJson: null }, ctx).data
        .dashboardWidgetsJson,
    ).toBe(Prisma.DbNull);
  });

  it("drops an injection site this release does not know and keeps the rest", () => {
    const { data, refused } = admitAccountSettings(
      { globalExcludedInjectionSites: ["THIGH_LEFT", "EARLOBE"] },
      ctx,
    );
    expect(data.globalExcludedInjectionSites).toEqual(["THIGH_LEFT"]);
    expect(refused).toEqual(["globalExcludedInjectionSites.EARLOBE"]);
  });

  it("takes the avatar's type from its bytes, not from the file", () => {
    const { data, refused } = admitAccountSettings(
      {
        avatarBytes: PNG_1X1,
        avatarContentType: "text/html",
        avatarUpdatedAt: "2026-06-30T12:00:00.000Z",
      },
      ctx,
    );
    expect(refused).toEqual([]);
    expect(data.avatarContentType).toBe("image/png");
    expect(data.avatarUpdatedAt).toEqual(new Date("2026-06-30T12:00:00.000Z"));
    expect(data.avatarBytes).toBeInstanceOf(Uint8Array);
  });

  it("refuses an avatar that is not an image the upload accepts", () => {
    const { data, refused } = admitAccountSettings(
      {
        avatarBytes: Buffer.from("<svg onload=alert(1)>....").toString(
          "base64",
        ),
        avatarContentType: "image/svg+xml",
      },
      ctx,
    );
    expect(refused).toEqual(["avatarBytes"]);
    expect(data).toEqual({});
  });

  it("seals a readable insurance number under this host's key", () => {
    const { data } = admitAccountSettings({ insuranceNumber: "A123" }, ctx);
    expect(decrypt(data.insuranceNumberEncrypted as string)).toBe("A123");
  });

  it("refuses the unreadable marker as an insurance number", () => {
    const { data, refused } = admitAccountSettings(
      { insuranceNumber: UNREADABLE_EXPORT_MARKER },
      ctx,
    );
    expect(refused).toEqual(["insuranceNumberEncrypted"]);
    expect(data).toEqual({});
  });

  it("never admits a column that is not a setting, whatever the file says", () => {
    const { data } = admitAccountSettings(
      {
        passwordHash: "x",
        role: "ADMIN",
        email: "someone@example.test",
        aiOpenaiKeyEncrypted: encrypt("sk-test"),
        managedProfileAt: "2026-01-01T00:00:00.000Z",
        syncResetAt: "2026-01-01T00:00:00.000Z",
        heightCm: 180,
      },
      ctx,
    );
    expect(data).toEqual({ heightCm: 180 });
  });
});
