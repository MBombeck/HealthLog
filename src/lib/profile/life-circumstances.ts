/**
 * v1.43 (#614) — the life circumstances of a record: the read model behind
 * `GET /api/anamnesis/life-circumstances`, the AI switches, the "still true"
 * confirmations and the AUDIT-C entries.
 *
 * The answers are fact revisions (`HealthProfileFactRevision`, sealed values,
 * dated, corrected by a successor) and AUDIT-C entries
 * (`MentalHealthAssessment` with `instrument = AUDIT_C`, sealed item answers,
 * soft delete). Everything a client shows is resolved here: pack-years,
 * minutes per week, free weekdays, screening hints, the AUDIT-C cut-off, and
 * the instrument wording in the account language.
 *
 * Server-only.
 */
import { ageInYears } from "@/lib/tz/date-only";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { Prisma } from "@/generated/prisma/client";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  AUDIT_C_HISTORY_LIMIT,
  loadNewestReadableAuditC,
  newestReadableAuditC,
  openAuditCResponses,
  type AuditCResponses,
} from "@/lib/profile/audit-c-entries";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import {
  auditCCutoff,
  auditCInstrument,
  auditCTotal,
  isValidatedAuditCLocale,
  normaliseAuditCLocale,
  type AuditCCutoff,
  type AuditCInstrument,
} from "@/lib/mental-health/audit-c";
import { isModuleEnabled } from "@/lib/modules/gate";
import {
  decryptHealthProfileFactValue,
  decryptLifeFactValue,
  invalidateHealthProfileFactConsumers,
  toLifeFactRevisionDto,
  type LifeFactRevisionDto,
} from "@/lib/profile/health-facts";
import {
  LIFE_SECTIONS,
  activityMinutesPerWeek,
  computePackYears,
  DEFAULT_FREE_WEEKDAYS,
  isReviewDue,
  LIFE_KIND_AI_SECTION,
  screeningHints,
  type FreeWeekdaysSpan,
  type PackYears,
  type LifeClinicalSummary,
  type ScreeningHint,
} from "@/lib/profile/life-derived";
import {
  DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
  type StoredHealthProfileAiSection,
} from "@/lib/validations/health-profile-facts";
import {
  LIFE_AI_SECTIONS,
  LIFE_SECTION_KEYS,
  type ActivityHabitValue,
  type FreeWeekdaysValue,
  type LifeAiSection,
  type LifeFactKind,
  type LifeSectionKey,
  type TobaccoDetailValue,
  type WorkContextValue,
} from "@/lib/validations/life-circumstances";

const MS_PER_DAY = 86_400_000;
/** AUDIT-C is offered again once the newest entry is this old. */
const AUDIT_C_OFFER_AFTER_DAYS = 365;
/** A step count this recent means activity is measured, not only reported. */
const MEASURED_STEPS_DAYS = 30;

export interface AuditCResult {
  id: string;
  takenAt: string;
  items: [number, number, number];
  totalScore: number;
  locale: string;
  cutoff: AuditCCutoff | null;
  aboveCutoff: boolean | null;
  validatedLocale: boolean;
}

export interface LifeCircumstancesDto {
  sections: Array<{
    key: LifeSectionKey;
    aiSection: Exclude<LifeAiSection, "SHIFT_SCHEDULE">;
    aiIncluded: boolean;
    lastConfirmedAt: string | null;
    reviewDue: boolean;
    facts: LifeFactRevisionDto[];
  }>;
  extraAiSections: { SHIFT_SCHEDULE: boolean };
  derived: {
    packYears: PackYears;
    activityMinutesPerWeek: {
      value: number | null;
      meetsWho150: boolean | null;
      measuredStepsAvailable: boolean;
    };
    freeWeekdays: { days: number[]; source: "fact" | "default_weekend" };
    screeningHints: ScreeningHint[];
  };
  auditC: {
    latest: AuditCResult | null;
    history: Array<{ id: string; takenAt: string; totalScore: number }>;
    offerDue: boolean;
    instrument: AuditCInstrument;
  };
  takeOver: Array<{
    field: "conditions" | "allergies";
    freeTextPresent: boolean;
    structuredCount: number;
    available: boolean;
  }>;
}

/** The kinds the read route shows: the six new ones and the two closed ones living in a section. */
const SECTION_KINDS = [
  ...new Set(LIFE_SECTIONS.flatMap((section) => section.kinds)),
];

function storedSections(
  stored: readonly string[] | null | undefined,
): Set<StoredHealthProfileAiSection> {
  return new Set(
    (stored ??
      DEFAULT_HEALTH_PROFILE_AI_SECTIONS) as StoredHealthProfileAiSection[],
  );
}

/** The stored confirmations, read leniently: a stamp that does not parse counts as none. */
function confirmations(
  value: Prisma.JsonValue | null | undefined,
): Map<string, Date> {
  const out = new Map<string, Date>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, stamp] of Object.entries(value)) {
    if (typeof stamp !== "string") continue;
    const at = new Date(stamp);
    if (!Number.isNaN(at.getTime())) out.set(key, at);
  }
  return out;
}

function latest(...dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const date of dates) {
    if (date && (!best || date > best)) best = date;
  }
  return best;
}

/** One stored entry scored for a profile sex; the source line follows `labelLocale`. */
export function toAuditCResult(
  row: { id: string; takenAt: Date; totalScore: number; locale: string },
  items: [number, number, number],
  sex: string | null,
  labelLocale: string,
): AuditCResult {
  const cutoff = auditCCutoff(row.locale, sex, labelLocale);
  return {
    id: row.id,
    takenAt: row.takenAt.toISOString(),
    items,
    totalScore: row.totalScore,
    locale: row.locale,
    cutoff,
    aboveCutoff: cutoff ? row.totalScore >= cutoff.value : null,
    validatedLocale: isValidatedAuditCLocale(row.locale),
  };
}

/**
 * The dated free-weekday answers of a record, oldest first, for the
 * night-by-night day type. Fail-soft: the answers refine a chronotype the
 * weekend default already produces, so a failed read falls back to that
 * default with a warning instead of taking the sleep surfaces down with it.
 */
export async function loadFreeWeekdaySpans(
  userId: string,
): Promise<FreeWeekdaysSpan[]> {
  try {
    const rows = await prisma.healthProfileFactRevision.findMany({
      where: { userId, kind: "FREE_WEEKDAYS" },
      orderBy: { validFrom: "asc" },
      select: { validFrom: true, validUntil: true, valueEncrypted: true },
    });
    return rows.flatMap((row) => {
      const opened = decryptLifeFactValue("FREE_WEEKDAYS", row.valueEncrypted);
      const value = opened.value as FreeWeekdaysValue | null;
      return value
        ? [
            {
              validFrom: row.validFrom,
              validUntil: row.validUntil,
              days: value.days,
            },
          ]
        : [];
    });
  } catch (error) {
    getEvent()?.addWarning(
      `free weekdays read failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

/**
 * The free-weekday answers for a prompt: only when the section they belong
 * to (`WORK`) is released to the AI. Otherwise the answers are never read or
 * decrypted for a prompt, and the night-by-night day type falls back to the
 * weekend default, exactly as for a record that never answered. The data
 * surfaces (the sleep page, the dashboard) read `loadFreeWeekdaySpans`
 * directly: they show the person their own answer, no model sees it.
 */
export async function loadFreeWeekdaySpansForPrompt(
  userId: string,
): Promise<FreeWeekdaysSpan[]> {
  // Fail-soft and fail-closed, like the read below: a failed switch read
  // gives the weekend default and never the answers.
  try {
    const profile = await prisma.userHealthProfile.findUnique({
      where: { userId },
      select: { aiIncludedSections: true },
    });
    if (
      !storedSections(profile?.aiIncludedSections).has(
        LIFE_KIND_AI_SECTION.FREE_WEEKDAYS,
      )
    ) {
      return [];
    }
  } catch (error) {
    getEvent()?.addWarning(
      `free weekdays switch read failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
  return loadFreeWeekdaySpans(userId);
}

/** Assemble the whole read model for one record. */
export async function buildLifeCircumstances(
  userId: string,
  now: Date = new Date(),
): Promise<LifeCircumstancesDto> {
  const [
    user,
    profile,
    factRows,
    auditRows,
    steps,
    illnessCount,
    allergyCount,
    illnessOn,
  ] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { dateOfBirth: true, gender: true, locale: true, timezone: true },
    }),
    prisma.userHealthProfile.findUnique({
      where: { userId },
      select: {
        aiIncludedSections: true,
        lifeConfirmedJson: true,
        conditionsEncrypted: true,
        allergiesEncrypted: true,
      },
    }),
    prisma.healthProfileFactRevision.findMany({
      where: {
        userId,
        kind: { in: SECTION_KINDS },
        validUntil: null,
        supersededByRevisionId: null,
      },
      select: {
        id: true,
        kind: true,
        valueEncrypted: true,
        validFrom: true,
        provenance: true,
        createdAt: true,
      },
    }),
    prisma.mentalHealthAssessment.findMany({
      where: { userId, instrument: "AUDIT_C", deletedAt: null },
      orderBy: [{ takenAt: "desc" }, { id: "desc" }],
      take: AUDIT_C_HISTORY_LIMIT,
      select: {
        id: true,
        takenAt: true,
        totalScore: true,
        locale: true,
        responsesEncrypted: true,
      },
    }),
    prisma.measurement.findFirst({
      where: {
        userId,
        type: "ACTIVITY_STEPS",
        deletedAt: null,
        measuredAt: {
          gte: new Date(now.getTime() - MEASURED_STEPS_DAYS * MS_PER_DAY),
        },
      },
      select: { id: true },
    }),
    prisma.illnessEpisode.count({
      where: { userId, lifecycle: "CHRONIC_ONGOING", deletedAt: null },
    }),
    prisma.allergy.count({
      where: { userId, status: "ACTIVE", deletedAt: null },
    }),
    isModuleEnabled(userId, "illness"),
  ]);

  const locale = user?.locale ?? "en";
  const sex = user?.gender ?? null;
  const included = storedSections(profile?.aiIncludedSections);
  const confirmed = confirmations(profile?.lifeConfirmedJson);
  const facts = factRows.map(toLifeFactRevisionDto);
  const factOf = <T>(kind: string): T | null =>
    (facts.find((fact) => fact.kind === kind)?.value as T | undefined) ?? null;

  // AUDIT-C: the newest entry whose answers this host can open is the
  // result, and the offer is timed from it, as every other reader times it
  // (`audit-c-entries.ts`). The history lists totals, which need no
  // decryption, so an unreadable entry can still be removed.
  const readable = newestReadableAuditC(auditRows);
  const latestAuditC: AuditCResult | null = readable
    ? toAuditCResult(readable.row, readable.items, sex, locale)
    : null;
  const newestAuditC = auditRows[0]?.takenAt ?? null;
  const newestReadableAt = readable?.row.takenAt ?? null;

  const sections = LIFE_SECTIONS.map((section) => {
    const sectionFacts = facts.filter((fact) =>
      (section.kinds as readonly string[]).includes(fact.kind),
    );
    const lastAnswer = latest(
      ...sectionFacts.map((fact) => new Date(fact.createdAt)),
      section.key === "alcohol" ? newestAuditC : null,
    );
    const lastConfirmed = latest(lastAnswer, confirmed.get(section.key));
    return {
      key: section.key,
      aiSection: section.aiSection,
      aiIncluded: included.has(section.aiSection),
      lastConfirmedAt: lastConfirmed?.toISOString() ?? null,
      reviewDue: isReviewDue(lastConfirmed, now),
      facts: sectionFacts,
    };
  });

  const smokingStatus = factOf<string>("SMOKING_STATUS");
  const tobacco = factOf<TobaccoDetailValue>("TOBACCO_DETAIL");
  const activity = factOf<ActivityHabitValue>("ACTIVITY_HABIT");
  const freeDays = factOf<FreeWeekdaysValue>("FREE_WEEKDAYS");
  const packYears = computePackYears(smokingStatus, tobacco, now);
  const minutes = activityMinutesPerWeek(
    activity?.moderateDaysPerWeek ?? null,
    activity?.moderateMinutesPerDay ?? null,
  );

  return {
    sections,
    extraAiSections: { SHIFT_SCHEDULE: included.has("SHIFT_SCHEDULE") },
    derived: {
      packYears,
      activityMinutesPerWeek: {
        ...minutes,
        measuredStepsAvailable: steps !== null,
      },
      freeWeekdays: freeDays
        ? { days: [...freeDays.days].sort((a, b) => a - b), source: "fact" }
        : { days: [...DEFAULT_FREE_WEEKDAYS], source: "default_weekend" },
      screeningHints: screeningHints({
        ageYears: ageInYears(
          user?.dateOfBirth,
          user?.timezone ?? DEFAULT_TIMEZONE,
          now,
        ),
        sex,
        smokingStatus,
        detail: tobacco,
        packYears,
        locale,
        now,
      }),
    },
    auditC: {
      latest: latestAuditC,
      history: auditRows.map((row) => ({
        id: row.id,
        takenAt: row.takenAt.toISOString(),
        totalScore: row.totalScore,
      })),
      offerDue:
        newestReadableAt === null ||
        now.getTime() - newestReadableAt.getTime() >=
          AUDIT_C_OFFER_AFTER_DAYS * MS_PER_DAY,
      instrument: auditCInstrument(locale),
    },
    takeOver: [
      {
        field: "conditions",
        freeTextPresent: profile?.conditionsEncrypted != null,
        structuredCount: illnessCount,
        available: illnessOn,
      },
      {
        field: "allergies",
        freeTextPresent: profile?.allergiesEncrypted != null,
        structuredCount: allergyCount,
        available: true,
      },
    ],
  };
}

// ── AI switches ──────────────────────────────────────────────────────────────

export type LifeAiSectionsOutcome =
  | { conflict: true }
  | {
      conflict: false;
      aiSections: Record<LifeAiSection, boolean>;
      updatedAt: string;
    };

function lifeSwitches(
  stored: Set<StoredHealthProfileAiSection>,
): Record<LifeAiSection, boolean> {
  return Object.fromEntries(
    LIFE_AI_SECTIONS.map((section) => [section, stored.has(section)]),
  ) as Record<LifeAiSection, boolean>;
}

/**
 * Serialise every read-modify-write of a profile's AI switches. Two routes
 * write the one array: this module's switch route and the about-me PUT, which
 * replaces its eight sections and carries the life switches over as stored.
 * Without a lock, a PUT that read the array before a concurrent switch-off
 * committed wrote the old value back and turned the section on again. A
 * transaction-scoped advisory lock covers the first write too, when there is
 * no row yet to lock.
 */
export async function lockAiSections(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 AS locked
    FROM pg_advisory_xact_lock(hashtextextended(${`ai-sections:${userId}`}, 0))
  `;
}

/**
 * Switch life-circumstance sections in or out of the AI inclusion list. Only
 * the named sections change; the other stored values, the five about-me
 * sections among them, stay as they are. `base` is the about-me token
 * (`UserHealthProfile.updatedAt`): a stale one is a conflict, as on about-me.
 * Any change clears the cached briefing in the same transaction, because it
 * may quote a section that just left.
 */
export async function updateLifeAiSections(
  userId: string,
  changes: Partial<Record<LifeAiSection, boolean>>,
  base?: Date,
): Promise<LifeAiSectionsOutcome> {
  return prisma.$transaction(async (tx) => {
    await lockAiSections(tx, userId);
    const row = await tx.userHealthProfile.findUnique({
      where: { userId },
      select: { aiIncludedSections: true, updatedAt: true },
    });
    if (row && base && row.updatedAt.getTime() !== base.getTime()) {
      return { conflict: true as const };
    }
    const next = storedSections(row?.aiIncludedSections);
    for (const [section, on] of Object.entries(changes)) {
      if (on) next.add(section as StoredHealthProfileAiSection);
      else next.delete(section as StoredHealthProfileAiSection);
    }
    const aiIncludedSections = [...next];
    const saved = row
      ? await tx.userHealthProfile.update({
          where: { userId },
          data: { aiIncludedSections },
          select: { updatedAt: true },
        })
      : await tx.userHealthProfile.create({
          data: { userId, aiIncludedSections },
          select: { updatedAt: true },
        });
    await invalidateHealthProfileFactConsumers(userId, tx);
    return {
      conflict: false as const,
      aiSections: lifeSwitches(next),
      updatedAt: saved.updatedAt.toISOString(),
    };
  });
}

/** Store "still true" for one section: the instant only, never a revision. */
export async function confirmLifeSection(
  userId: string,
  section: LifeSectionKey,
  now: Date = new Date(),
): Promise<string> {
  const stamp = now.toISOString();
  await prisma.$transaction(async (tx) => {
    const row = await tx.userHealthProfile.findUnique({
      where: { userId },
      select: { lifeConfirmedJson: true },
    });
    const confirmedAt: Record<string, string> = {};
    for (const [key, at] of confirmations(row?.lifeConfirmedJson)) {
      if ((LIFE_SECTION_KEYS as readonly string[]).includes(key)) {
        confirmedAt[key] = at.toISOString();
      }
    }
    confirmedAt[section] = stamp;
    await tx.userHealthProfile.upsert({
      where: { userId },
      create: { userId, lifeConfirmedJson: confirmedAt },
      update: { lifeConfirmedJson: confirmedAt },
    });
  });
  return stamp;
}

// ── AUDIT-C entries ──────────────────────────────────────────────────────────

/**
 * The client's `externalId` is stored with this prefix. The screeners share
 * the table and a per-user unique index on `external_id`, so a sync client
 * that happened to reuse an id across the two surfaces would otherwise get
 * the wrong record back as its "existing" entry.
 */
const AUDIT_C_EXTERNAL_ID_PREFIX = "audit-c:";

export interface AuditCCreateInput {
  items: [number, number, number];
  takenAt?: Date;
  tz?: string;
  locale: string;
  source: "WEB" | "IOS";
  externalId?: string;
}

const AUDIT_C_SELECT = {
  id: true,
  takenAt: true,
  totalScore: true,
  locale: true,
  responsesEncrypted: true,
} as const;

/**
 * Store and score one entry. A repeat `externalId` returns the stored entry
 * (`replayed: true`) and writes nothing.
 */
export async function createAuditC(
  userId: string,
  input: AuditCCreateInput,
  now: Date = new Date(),
): Promise<{ result: AuditCResult; replayed: boolean }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { gender: true, locale: true },
  });
  const sex = user?.gender ?? null;
  const labelLocale = user?.locale ?? "en";
  const externalId = input.externalId
    ? `${AUDIT_C_EXTERNAL_ID_PREFIX}${input.externalId}`
    : null;

  const replay = async () => {
    if (!externalId) return null;
    const existing = await prisma.mentalHealthAssessment.findFirst({
      where: { userId, instrument: "AUDIT_C", externalId },
      select: AUDIT_C_SELECT,
    });
    if (!existing) return null;
    const opened = openAuditCResponses(existing.responsesEncrypted);
    return {
      result: toAuditCResult(
        existing,
        opened?.items ?? input.items,
        sex,
        labelLocale,
      ),
      replayed: true,
    };
  };

  const prior = await replay();
  if (prior) return prior;

  const locale = normaliseAuditCLocale(input.locale);
  const responses: AuditCResponses = { schema: 1, items: input.items };
  try {
    const row = await prisma.mentalHealthAssessment.create({
      data: {
        userId,
        instrument: "AUDIT_C",
        locale,
        responsesEncrypted: encryptToBytes(JSON.stringify(responses)),
        totalScore: auditCTotal(input.items),
        // Not banded: the cut-off depends on the profile's sex at read time,
        // so nothing derived from it is frozen into the row.
        severityBand: "unbanded",
        takenAt: input.takenAt ?? now,
        tz: input.tz ?? null,
        source: input.source,
        externalId,
      },
      select: AUDIT_C_SELECT,
    });
    await invalidateHealthProfileFactConsumers(userId, prisma);
    return {
      result: toAuditCResult(row, input.items, sex, labelLocale),
      replayed: false,
    };
  } catch (error) {
    // A concurrent replay of the same externalId lost the unique race.
    if (
      externalId &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const winner = await replay();
      if (winner) return winner;
    }
    throw error;
  }
}

// ── Clinical summary (doctor report, FHIR) ───────────────────────────────────

export async function loadLifeClinicalSummary(
  userId: string,
  now: Date = new Date(),
): Promise<LifeClinicalSummary> {
  const [user, rows, audit] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { gender: true, locale: true },
    }),
    prisma.healthProfileFactRevision.findMany({
      where: {
        userId,
        kind: {
          in: [
            "SMOKING_STATUS",
            "TOBACCO_DETAIL",
            "ACTIVITY_HABIT",
            "WORK_CONTEXT",
          ],
        },
        validUntil: null,
        supersededByRevisionId: null,
      },
      select: { kind: true, valueEncrypted: true },
    }),
    loadNewestReadableAuditC(userId),
  ]);
  const value = <T>(kind: string): T | null => {
    const row = rows.find((candidate) => candidate.kind === kind);
    if (!row) return null;
    const opened =
      kind === "SMOKING_STATUS"
        ? decryptHealthProfileFactValue("SMOKING_STATUS", row.valueEncrypted)
        : decryptLifeFactValue(kind as LifeFactKind, row.valueEncrypted);
    return (opened.value as T | null) ?? null;
  };
  const packYears = computePackYears(
    value<string>("SMOKING_STATUS"),
    value<TobaccoDetailValue>("TOBACCO_DETAIL"),
    now,
  );
  const activity = value<ActivityHabitValue>("ACTIVITY_HABIT");
  const work = value<WorkContextValue>("WORK_CONTEXT");
  const cutoff = audit
    ? auditCCutoff(audit.locale, user?.gender ?? null, user?.locale ?? "en")
    : null;
  return {
    packYears: packYears.value,
    auditC: audit
      ? {
          id: audit.id,
          takenAt: audit.takenAt.toISOString(),
          totalScore: audit.totalScore,
          aboveCutoff: cutoff ? audit.totalScore >= cutoff.value : null,
          cutoffValue: cutoff?.value ?? null,
          cutoffSourceLabel: cutoff?.sourceLabel ?? null,
        }
      : null,
    activityMinutesPerWeek: activityMinutesPerWeek(
      activity?.moderateDaysPerWeek ?? null,
      activity?.moderateMinutesPerDay ?? null,
    ).value,
    sittingHoursWorkday: activity?.sittingHoursWorkday ?? null,
    work: work
      ? {
          situation: work.situation,
          physicalNature: work.physicalNature,
          nightWork: work.nightWork,
          exposures: work.exposures,
        }
      : null,
  };
}
