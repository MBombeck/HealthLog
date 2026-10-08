/**
 * The account's own settings, with both backup ends in one file.
 *
 * Which `User` columns these are is decided in `USER_COLUMN_BACKUP_CLASS`
 * (`src/lib/export/backup-plan.ts`); this file is how each one travels. The
 * table below is keyed by that type, so a column classified as a setting
 * without a way to carry it does not compile, and neither does a way to carry
 * a column that is not one.
 *
 * ── What the restore does with them ────────────────────────────────────────
 *
 * Writes them to the account being restored, column by column, and nothing
 * else on the row. The value from the file is not trusted just because this
 * host once wrote it: the file may come from another host, from an older
 * release, or from an operator's text editor, so each column is checked the
 * way the settings route that writes it checks it. A value that fails is not
 * written, the account keeps what it had, and the column is named in the
 * restore's skip report, so a setting that did not come back is never
 * reported as one that did. The checks that can actually fail on a real file:
 *
 *   - an AI endpoint on a private address the receiving host has not allowed
 *     (`AI_PRIVATE_ORIGINS`), or one the account's role no longer covers;
 *   - a language, unit or time zone this release does not know;
 *   - a threshold for a metric this release does not range, or out of range;
 *   - an avatar that is not one of the image types the upload accepts.
 *
 * A setting naming something the receiving host does not have (a provider
 * with no key, a source that is not connected, a module the operator has
 * turned off) is kept: the app already reads that state as "not available"
 * everywhere, because it is exactly the state after a key is removed or an
 * integration disconnected.
 *
 * ── Encryption ─────────────────────────────────────────────────────────────
 *
 * Two values are sealed, the insurance number and (v1.42) the environment
 * home, and both follow the split every other section uses: a disaster-recovery file carries the ciphertext
 * verbatim (so the restore's key check sees it), a portable file carries the
 * readable value and the restore seals it under this host's key.
 */
import { Buffer } from "node:buffer";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  DateFormatPreference,
  InjectionSite,
  TimeFormatPreference,
} from "@/generated/prisma/enums";
import { isLocalAiHostAllowed } from "@/lib/ai/local-host-allowlist";
import {
  AVATAR_MAX_BYTES,
  detectAvatarMimeType,
  readAvatarDimensions,
} from "@/lib/avatar";
import { decrypt, encrypt } from "@/lib/crypto";
import { readLocation, sealLocation } from "@/lib/environment/location-cipher";
import {
  USER_COLUMN_BACKUP_CLASS,
  type AccountSettingColumn,
} from "@/lib/export/backup-plan";
import { UNREADABLE_EXPORT_MARKER } from "@/lib/export/unreadable-marker";
import { locales } from "@/lib/i18n/config";
import { thresholdsUpdateSchema } from "@/lib/validations/thresholds";
import { isPublicUrl } from "@/lib/validations/notifications";
import {
  glucoseUnitPatchSchema,
  unitPreferencePatchSchema,
} from "@/lib/validations/user-prefs";

export interface AccountSettingsBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** The section as it rides the wire: setting columns by name, JSON-safe. */
export type AccountSettingsBackupEntry = Record<string, unknown>;

export interface AccountSettingsBackupSection {
  accountSettings: AccountSettingsBackupEntry | null;
}

/** Every setting column, in the order the table below declares them. */
export const ACCOUNT_SETTING_COLUMNS = Object.entries(USER_COLUMN_BACKUP_CLASS)
  .filter(([, verdict]) => verdict === "SETTING")
  .map(([column]) => column as AccountSettingColumn);

type SettingsRow = Record<AccountSettingColumn, unknown>;

/** What the restore knows about the account it writes into. */
export interface AccountSettingsRestoreContext {
  /** Whether the account is an admin, which widens the AI endpoint policy. */
  operatorTrusted: boolean;
}

/** One column's two ends. */
interface SettingCodec {
  /** The wire fragment for this column, read from the database row. */
  write(row: SettingsRow, disasterRecovery: boolean): Record<string, unknown>;
  /**
   * The database value for this column from the file, `undefined` when the
   * file does not carry it (the account keeps what it has), or a refusal.
   */
  read(
    entry: AccountSettingsBackupEntry,
    ctx: AccountSettingsRestoreContext,
  ): unknown;
}

/** A value from the file that this host will not write. */
class Refused {
  constructor(readonly key: string) {}
}

/** A value that came back in part, with the parts that did not named. */
class PartlyRefused {
  constructor(
    readonly value: unknown,
    readonly refused: string[],
  ) {}
}

function has(entry: AccountSettingsBackupEntry, key: string): boolean {
  return Object.hasOwn(entry, key) && entry[key] !== undefined;
}

/** Carried as it is: a string, number, boolean or list, or null. */
function plain(column: AccountSettingColumn): SettingCodec {
  return {
    write: (row) => ({ [column]: row[column] }),
    read: (entry) => (has(entry, column) ? entry[column] : undefined),
  };
}

/** A timestamp, carried as ISO-8601. */
function instant(column: AccountSettingColumn): SettingCodec {
  return {
    write: (row) => ({
      [column]:
        row[column] instanceof Date
          ? (row[column] as Date).toISOString()
          : null,
    }),
    read: (entry) => {
      if (!has(entry, column)) return undefined;
      const value = entry[column];
      return value === null ? null : new Date(value as string);
    },
  };
}

/**
 * A JSON column, carried as it is stored. Every reader of these parses
 * fail-soft (a key it does not know is ignored, a malformed blob reads as the
 * default), so a value written by another release restores rather than being
 * refused here on a stricter opinion than the app's own.
 */
function json(column: AccountSettingColumn): SettingCodec {
  return {
    write: (row) => ({ [column]: row[column] ?? null }),
    read: (entry) => {
      if (!has(entry, column)) return undefined;
      const value = entry[column];
      return value === null ? Prisma.DbNull : value;
    },
  };
}

/** A closed vocabulary. A value outside it is refused, not coerced. */
function oneOf(
  column: AccountSettingColumn,
  values: readonly string[],
  nullable: boolean,
): SettingCodec {
  return {
    write: (row) => ({ [column]: row[column] }),
    read: (entry) => {
      if (!has(entry, column)) return undefined;
      const value = entry[column];
      if (value === null && nullable) return null;
      if (typeof value === "string" && values.includes(value)) return value;
      return new Refused(column);
    },
  };
}

function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** An IANA zone this runtime knows, the check the settings routes apply. */
function timeZone(
  column: AccountSettingColumn,
  nullable: boolean,
): SettingCodec {
  return {
    write: (row) => ({ [column]: row[column] }),
    read: (entry) => {
      if (!has(entry, column)) return undefined;
      const value = entry[column];
      if (value === null && nullable) return null;
      return isTimeZone(value) ? value : new Refused(column);
    },
  };
}

/**
 * An AI endpoint, held to the rule `PATCH /api/user/ai-provider` applies when
 * it is saved: a public address, or a private one the operator of THIS host
 * allowed for this account. The address arrived from a file, so it has never
 * been through that check here.
 */
function aiEndpoint(column: "aiBaseUrl" | "aiCompatBaseUrl"): SettingCodec {
  return {
    write: (row) => ({ [column]: row[column] }),
    read: (entry, ctx) => {
      if (!has(entry, column)) return undefined;
      const value = entry[column];
      if (value === null) return null;
      if (typeof value !== "string") return new Refused(column);
      const trimmed = value.trim();
      if (trimmed === "") return null;
      const allowed =
        isLocalAiHostAllowed(trimmed, {
          operatorTrusted: ctx.operatorTrusted,
        }) || isPublicUrl(trimmed);
      return allowed ? trimmed : new Refused(column);
    },
  };
}

/**
 * The threshold overrides, metric by metric. The readers that apply a band
 * cast the column rather than parse it, so a band this release does not
 * range, or one outside the metric's bounds, is dropped here and named,
 * while the valid bands beside it still come back.
 */
const thresholds: SettingCodec = {
  write: (row) => ({ thresholdsJson: row.thresholdsJson ?? null }),
  read: (entry) => {
    if (!has(entry, "thresholdsJson")) return undefined;
    const value = entry.thresholdsJson;
    if (value === null) return Prisma.DbNull;
    if (typeof value !== "object" || Array.isArray(value)) {
      return new Refused("thresholdsJson");
    }
    const kept: Record<string, unknown> = {};
    const refused: string[] = [];
    for (const [metric, band] of Object.entries(value)) {
      if (thresholdsUpdateSchema.safeParse({ [metric]: band }).success) {
        kept[metric] = band;
      } else {
        refused.push(`thresholdsJson.${metric}`);
      }
    }
    return new PartlyRefused(
      Object.keys(kept).length === 0 ? Prisma.DbNull : kept,
      refused,
    );
  },
};

const injectionSites = Object.values(InjectionSite) as string[];

/** The injection sites to avoid everywhere; an unknown site is dropped. */
const excludedSites: SettingCodec = {
  write: (row) => ({
    globalExcludedInjectionSites: row.globalExcludedInjectionSites,
  }),
  read: (entry) => {
    if (!has(entry, "globalExcludedInjectionSites")) return undefined;
    const value = entry.globalExcludedInjectionSites;
    if (!Array.isArray(value))
      return new Refused("globalExcludedInjectionSites");
    const kept = value.filter(
      (site): site is string =>
        typeof site === "string" && injectionSites.includes(site),
    );
    const refused = value
      .filter((site) => !kept.includes(site as string))
      .map((site) => `globalExcludedInjectionSites.${String(site)}`);
    return new PartlyRefused(kept, refused);
  },
};

/**
 * The picture, re-checked the way the upload route checks one: sniffed from
 * its bytes, within the size and dimension limits. The stored content type
 * is the sniffed one, never the file's, because the avatar is served with it.
 * The three avatar columns travel as one: the bytes decide, the type and the
 * stamp follow them.
 */
const avatar: SettingCodec = {
  write: (row) => ({
    avatarBytes:
      row.avatarBytes instanceof Uint8Array
        ? Buffer.from(row.avatarBytes).toString("base64")
        : null,
    avatarContentType: row.avatarContentType,
    avatarUpdatedAt:
      row.avatarUpdatedAt instanceof Date
        ? row.avatarUpdatedAt.toISOString()
        : null,
  }),
  read: (entry) => {
    if (!has(entry, "avatarBytes")) return undefined;
    const value = entry.avatarBytes;
    if (value === null) {
      return {
        avatarBytes: null,
        avatarContentType: null,
        avatarUpdatedAt: null,
      };
    }
    if (typeof value !== "string") return new Refused("avatarBytes");
    const buffer = Buffer.from(value, "base64");
    if (buffer.byteLength === 0 || buffer.byteLength > AVATAR_MAX_BYTES) {
      return new Refused("avatarBytes");
    }
    const mime = detectAvatarMimeType(buffer);
    const dimensions = mime ? readAvatarDimensions(buffer, mime) : null;
    if (!mime || !dimensions) return new Refused("avatarBytes");
    if (dimensions.width > 2048 || dimensions.height > 2048) {
      return new Refused("avatarBytes");
    }
    const bytes = new Uint8Array(new ArrayBuffer(buffer.byteLength));
    bytes.set(buffer);
    const stamp = entry.avatarUpdatedAt;
    return {
      avatarBytes: bytes,
      avatarContentType: mime,
      avatarUpdatedAt: typeof stamp === "string" ? new Date(stamp) : new Date(),
    };
  },
};

/** Carried by the avatar codec above. */
const ridesWithAvatar: SettingCodec = {
  write: () => ({}),
  read: () => undefined,
};

/**
 * The insurance number. Sealed at rest; see the file comment for the split.
 * A portable file written while this host could not open the value carries
 * the unreadable marker, and the marker is not an insurance number, so it is
 * refused rather than sealed as one.
 */
const insuranceNumber: SettingCodec = {
  write: (row, disasterRecovery) => {
    const sealed = row.insuranceNumberEncrypted as string | null;
    if (disasterRecovery) {
      return { insuranceNumber: null, insuranceNumberEncrypted: sealed };
    }
    if (sealed === null) return { insuranceNumber: null };
    try {
      return { insuranceNumber: decrypt(sealed) };
    } catch {
      return { insuranceNumber: UNREADABLE_EXPORT_MARKER };
    }
  },
  read: (entry) => {
    if (has(entry, "insuranceNumberEncrypted")) {
      const sealed = entry.insuranceNumberEncrypted;
      if (sealed === null) return null;
      return typeof sealed === "string"
        ? sealed
        : new Refused("insuranceNumberEncrypted");
    }
    if (!has(entry, "insuranceNumber")) return undefined;
    const readable = entry.insuranceNumber;
    if (readable === null || readable === "") return null;
    if (typeof readable !== "string" || readable === UNREADABLE_EXPORT_MARKER) {
      return new Refused("insuranceNumberEncrypted");
    }
    return encrypt(readable);
  },
};

/**
 * v1.42 (#615) — the environment home, sealed at rest as one value
 * (`homeLocationEncrypted`, see `src/lib/environment/location-cipher.ts`)
 * beside the readable `homeLat` / `homeLon` / `homeLabel` that the
 * encryption backfill empties. The four columns travel as one, the way the
 * avatar's three do:
 *
 *   - a portable file carries the home readable, opened from the sealed copy
 *     when there is one, and no sealed value;
 *   - a disaster-recovery file carries the sealed value verbatim (base64)
 *     beside whatever the readable columns still hold.
 *
 * The restore writes the sealed value as it came, or seals a readable home
 * under this host's key, and writes the readable columns empty either way. A
 * file whose home is null clears the account's home. A home without a label
 * (allowed since v1.25) is sealed with an empty label, which every reader
 * shows as no label.
 */
const homeLocation: SettingCodec = {
  write: (row, disasterRecovery) => {
    const sealed =
      row.homeLocationEncrypted instanceof Uint8Array
        ? row.homeLocationEncrypted
        : null;
    if (disasterRecovery) {
      return {
        homeLat: row.homeLat,
        homeLon: row.homeLon,
        homeLabel: row.homeLabel,
        homeLocationEncrypted:
          sealed && sealed.byteLength > 0
            ? Buffer.from(sealed).toString("base64")
            : null,
      };
    }
    const home = readLocation({
      sealed,
      lat: row.homeLat as number | null,
      lon: row.homeLon as number | null,
      label: (row.homeLabel as string | null) ?? "",
    });
    return home
      ? {
          homeLat: home.lat,
          homeLon: home.lon,
          homeLabel: home.label === "" ? null : home.label,
        }
      : { homeLat: null, homeLon: null, homeLabel: null };
  },
  read: (entry) => {
    const cleared = {
      homeLocationEncrypted: null,
      homeLat: null,
      homeLon: null,
      homeLabel: null,
    };
    const sealedValue = entry.homeLocationEncrypted;
    if (has(entry, "homeLocationEncrypted") && sealedValue !== null) {
      if (typeof sealedValue !== "string") {
        return new Refused("homeLocationEncrypted");
      }
      const buffer = Buffer.from(sealedValue, "base64");
      if (buffer.byteLength === 0) return new Refused("homeLocationEncrypted");
      const bytes = new Uint8Array(new ArrayBuffer(buffer.byteLength));
      bytes.set(buffer);
      return { ...cleared, homeLocationEncrypted: bytes };
    }
    if (!has(entry, "homeLat") && !has(entry, "homeLon")) {
      // Neither form in the file: a sealed null alone still says "no home".
      return has(entry, "homeLocationEncrypted") ? cleared : undefined;
    }
    const lat = entry.homeLat ?? null;
    const lon = entry.homeLon ?? null;
    const label = entry.homeLabel ?? null;
    if (lat === null || lon === null) return cleared;
    if (
      typeof lat !== "number" ||
      typeof lon !== "number" ||
      (label !== null && typeof label !== "string")
    ) {
      return new Refused("homeLat");
    }
    return {
      ...cleared,
      homeLocationEncrypted: sealLocation({ lat, lon, label: label ?? "" }),
    };
  },
};

/** Carried by the home codec above. */
const ridesWithHome: SettingCodec = {
  write: () => ({}),
  read: () => undefined,
};

const ACCOUNT_SETTING_CODECS: Readonly<
  Record<AccountSettingColumn, SettingCodec>
> = {
  heightCm: plain("heightCm"),
  dateOfBirth: instant("dateOfBirth"),
  gender: oneOf("gender", ["MALE", "FEMALE", "OTHER"], true),
  hasDiabetes: plain("hasDiabetes"),
  displayName: plain("displayName"),
  fullName: plain("fullName"),
  insurerName: plain("insurerName"),
  insuranceNumberEncrypted: insuranceNumber,
  insurerIkNumber: plain("insurerIkNumber"),
  lastReportPracticeName: plain("lastReportPracticeName"),
  avatarBytes: avatar,
  avatarContentType: ridesWithAvatar,
  avatarUpdatedAt: ridesWithAvatar,
  homeLat: ridesWithHome,
  homeLon: ridesWithHome,
  homeLabel: ridesWithHome,
  homeTimezone: timeZone("homeTimezone", true),
  homeSince: instant("homeSince"),
  homeLocationEncrypted: homeLocation,
  environmentAirQualityEnabled: plain("environmentAirQualityEnabled"),
  timezone: timeZone("timezone", false),
  locale: oneOf("locale", locales, true),
  // The vocabularies the two preference routes accept, read from their own
  // schemas so the restore cannot drift from them.
  unitPreference: oneOf(
    "unitPreference",
    unitPreferencePatchSchema.shape.unitPreference.options,
    true,
  ),
  glucoseUnit: oneOf(
    "glucoseUnit",
    glucoseUnitPatchSchema.shape.glucoseUnit.options,
    true,
  ),
  timeFormat: oneOf("timeFormat", Object.values(TimeFormatPreference), false),
  dateFormat: oneOf("dateFormat", Object.values(DateFormatPreference), false),
  modulePreferencesJson: json("modulePreferencesJson"),
  thresholdsJson: thresholds,
  healthScoreConfigJson: json("healthScoreConfigJson"),
  sourcePriorityJson: json("sourcePriorityJson"),
  dashboardWidgetsJson: json("dashboardWidgetsJson"),
  insightsLayoutJson: json("insightsLayoutJson"),
  medicationListLayoutJson: json("medicationListLayoutJson"),
  moodTagLayoutJson: json("moodTagLayoutJson"),
  reportSelectionJson: json("reportSelectionJson"),
  globalExcludedInjectionSites: excludedSites,
  healthKitConfigJson: json("healthKitConfigJson"),
  notificationPrefs: json("notificationPrefs"),
  moodReminderEnabled: plain("moodReminderEnabled"),
  aiProvider: plain("aiProvider"),
  aiModel: plain("aiModel"),
  aiBaseUrl: aiEndpoint("aiBaseUrl"),
  aiCompatBaseUrl: aiEndpoint("aiCompatBaseUrl"),
  aiCompatModel: plain("aiCompatModel"),
  aiProviderChain: json("aiProviderChain"),
  aiResponseTimeoutSeconds: plain("aiResponseTimeoutSeconds"),
  useCentralCodex: plain("useCentralCodex"),
  insightsPrivacyMode: oneOf(
    "insightsPrivacyMode",
    ["aggregated", "raw"],
    false,
  ),
  insightsExcludeMetrics: plain("insightsExcludeMetrics"),
  disableCoach: plain("disableCoach"),
  coachPrefsJson: json("coachPrefsJson"),
  documentsAutoAiRead: plain("documentsAutoAiRead"),
  labsLocalOcrEnabled: plain("labsLocalOcrEnabled"),
  onboardingCompletedAt: instant("onboardingCompletedAt"),
  onboardingTourCompleted: plain("onboardingTourCompleted"),
  onboardingTourProgressJson: json("onboardingTourProgressJson"),
  disclaimerAcknowledgedAt: instant("disclaimerAcknowledgedAt"),
  disclaimerAcknowledgedVersion: plain("disclaimerAcknowledgedVersion"),
  passkeyUpgradeNudgeDismissed: plain("passkeyUpgradeNudgeDismissed"),
};

/** Exactly the setting columns, so the read is the declaration. */
const SETTINGS_SELECT = Object.fromEntries(
  ACCOUNT_SETTING_COLUMNS.map((column) => [column, true]),
) as Record<AccountSettingColumn, true>;

/**
 * Build the account-settings slice of a user's full backup.
 *
 * Takes the delegate it uses rather than a whole `PrismaClient`, matching the
 * other section builders.
 */
export async function buildAccountSettingsBackupSection(
  prisma: Pick<PrismaClient, "user">,
  userId: string,
  options: AccountSettingsBackupOptions = {},
): Promise<AccountSettingsBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  const row = (await prisma.user.findUnique({
    where: { id: userId },
    select: SETTINGS_SELECT,
  })) as SettingsRow | null;
  if (!row) return { accountSettings: null };

  const entry: AccountSettingsBackupEntry = {};
  for (const column of ACCOUNT_SETTING_COLUMNS) {
    Object.assign(
      entry,
      ACCOUNT_SETTING_CODECS[column].write(row, disasterRecovery),
    );
  }
  return { accountSettings: entry };
}

/** What the file's settings section turned into, before anything is written. */
export interface AdmittedAccountSettings {
  /** Column -> the value to write. Only setting columns ever appear here. */
  data: Partial<Record<AccountSettingColumn, unknown>>;
  /** Columns (or `column.part`) the file carried and this host refused. */
  refused: string[];
}

/**
 * Decide, without writing, what the file's settings section may put on the
 * account. Pure, so every refusal rule is testable without a database.
 *
 * `currentAiProvider` is the account's provider before the restore, for the
 * one rule that spans two columns: only the Local provider uses
 * `aiBaseUrl`, and the settings route clears the address whenever the
 * provider moves away from Local so that a cloud key is never sent to it.
 */
export function admitAccountSettings(
  entry: AccountSettingsBackupEntry,
  ctx: AccountSettingsRestoreContext,
  currentAiProvider: string | null = null,
): AdmittedAccountSettings {
  const data: Partial<Record<AccountSettingColumn, unknown>> = {};
  const refused: string[] = [];

  for (const column of ACCOUNT_SETTING_COLUMNS) {
    const value = ACCOUNT_SETTING_CODECS[column].read(entry, ctx);
    if (value === undefined) continue;
    if (value instanceof Refused) {
      refused.push(value.key);
      continue;
    }
    if (value instanceof PartlyRefused) {
      data[column] = value.value;
      refused.push(...value.refused);
      continue;
    }
    if (column === "avatarBytes" || column === "homeLocationEncrypted") {
      // The avatar codec answers for all three of its columns at once, the
      // home codec for all four of its.
      Object.assign(data, value);
      continue;
    }
    data[column] = value;
  }

  const provider =
    "aiProvider" in data
      ? (data.aiProvider as string | null)
      : currentAiProvider;
  if (typeof data.aiBaseUrl === "string" && provider !== "LOCAL") {
    delete data.aiBaseUrl;
    refused.push("aiBaseUrl");
  }

  return { data, refused };
}

/** The slice of a parsed backup this restore consumes. */
export interface AccountSettingsRestoreInput {
  /** Absent from every file written before the section existed. */
  accountSettings?: AccountSettingsBackupEntry | null;
}

export interface AccountSettingsRestoreResult {
  /** How many setting columns were written. */
  applied: number;
  /** What the file carried and the account did not take, by column. */
  refused: string[];
  /** Whether a unit preference changed, so stored texts quote old units. */
  unitsChanged: boolean;
}

/**
 * Put the account's settings back, inside the caller's transaction.
 *
 * Only the columns `admitAccountSettings` admitted, and only setting columns
 * can be admitted. Identity, credentials and the host's own bookkeeping on
 * the row are never in the write, so they stay exactly as the receiving
 * account has them. A file without the section leaves the row untouched,
 * which is how every backup written before the section existed restores.
 */
export async function restoreAccountSettings(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: AccountSettingsRestoreInput,
): Promise<AccountSettingsRestoreResult> {
  const entry = payload.accountSettings;
  if (!entry) return { applied: 0, refused: [], unitsChanged: false };

  const current = await tx.user.findUniqueOrThrow({
    where: { id: ownerId },
    select: {
      role: true,
      aiProvider: true,
      unitPreference: true,
      glucoseUnit: true,
    },
  });
  const { data, refused } = admitAccountSettings(
    entry,
    { operatorTrusted: current.role === "ADMIN" },
    current.aiProvider,
  );

  const columns = Object.keys(data);
  if (columns.length > 0) {
    await tx.user.update({
      where: { id: ownerId },
      data: data as Prisma.UserUpdateInput,
    });
  }

  return {
    applied: columns.length,
    refused,
    unitsChanged:
      ("unitPreference" in data &&
        data.unitPreference !== current.unitPreference) ||
      ("glucoseUnit" in data && data.glucoseUnit !== current.glucoseUnit),
  };
}
