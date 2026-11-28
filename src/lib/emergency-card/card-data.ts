/**
 * The emergency card's content (v1.49): the record's emergency facts, read
 * for the items a card shows and nothing else.
 *
 * One loader for every surface: the owner's own card page, its offline copy
 * and wallet PDF, and the read-only `hlm_` link a first responder scans. The
 * link passes the items the owner ticked at mint; an item that is not ticked
 * is never read, so it cannot leak through a later bug in the view.
 *
 * Sources, all the record's own:
 *   - blood type, implants, contacts, advance directive, organ donor and the
 *     note: the emergency profile (`readEmergencyProfile`, fail-soft per
 *     encrypted field, the same read page one of the doctor report uses);
 *   - allergies: every active allergy, severe ones
 *     first, with the reaction where it decrypts;
 *   - conditions: ongoing chronic conditions plus the anamnesis text;
 *   - medications: active, not paused, not ended;
 *   - pregnancy: the cycle's pregnancy or postpartum state, when it holds;
 *   - name: the record's full name, else its display name (a managed
 *     profile's own, never the guardian's), never the username;
 *   - birth date: the profile's.
 *
 * The owner's own view also says where each line is edited
 * (`loadOwnerEmergencyCard`, `edit-targets.ts`).
 */
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { resolvePregnancyState } from "@/lib/cycle/pregnancy";
import { loadPregnancyFields } from "@/lib/cycle/pregnancy-store";
import { prisma } from "@/lib/db";
import { decryptAllergyReaction } from "@/lib/doctor-report-helpers";
import { getEvent } from "@/lib/logging/context";
import { readEmergencyProfile } from "@/lib/profile/emergency-profile";
import { dateOfBirthKey, dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import type {
  AdvanceDirectiveStatusValue,
  EmergencyBloodTypeValue,
  OrganDonorStatusValue,
} from "@/lib/validations/emergency-profile";

import type { ModuleKey } from "@/lib/modules/registry";

import {
  emergencyCardTargets,
  type EmergencyCardTargets,
} from "./edit-targets";
import {
  EMERGENCY_CARD_FIELDS,
  normaliseFields,
  type EmergencyCardField,
} from "./fields";

/** The most allergies, conditions and medications one card lists. */
const LIST_CAP = 30;

export interface EmergencyCardAllergy {
  substance: string;
  severity: "MILD" | "MODERATE" | "SEVERE" | null;
  reaction: string | null;
}

export interface EmergencyCardMedication {
  name: string;
  dose: string | null;
}

export interface EmergencyCardPregnancy {
  state: "PREGNANT" | "POSTPARTUM";
  gestationalWeeks: number | null;
  gestationalDays: number | null;
  dueDate: string | null;
  deliveryDate: string | null;
  postpartumWeek: number | null;
}

/**
 * The card. Every item is `null` when it was not asked for or holds nothing;
 * `fields` says which were asked for, so a view can tell "not shared" from
 * "nothing recorded".
 */
export interface EmergencyCardView {
  fields: EmergencyCardField[];
  /** The record's name, the card's title line. */
  name: string | null;
  bloodType: EmergencyBloodTypeValue | null;
  allergies: EmergencyCardAllergy[] | null;
  conditions: string[] | null;
  medications: EmergencyCardMedication[] | null;
  pregnancy: EmergencyCardPregnancy | null;
  implants: string | null;
  contacts: string | null;
  advanceDirective: AdvanceDirectiveStatusValue | null;
  organDonor: OrganDonorStatusValue | null;
  note: string | null;
  dateOfBirth: string | null;
  /** The owner's calendar day the card was read on. */
  asOf: string;
}

const SEVERITY_ORDER = { SEVERE: 0, MODERATE: 1, MILD: 2 } as const;

async function readAllergies(userId: string): Promise<EmergencyCardAllergy[]> {
  const rows = await prisma.allergy.findMany({
    where: {
      userId,
      deletedAt: null,
      status: "ACTIVE",
    },
    orderBy: { createdAt: "asc" },
    take: LIST_CAP,
    select: { substance: true, severity: true, reactionEncrypted: true },
  });
  return rows
    .map((r) => ({
      substance: r.substance,
      severity: r.severity,
      reaction: decryptAllergyReaction(r.reactionEncrypted).reaction,
    }))
    .sort(
      (a, b) =>
        (a.severity ? SEVERITY_ORDER[a.severity] : 3) -
        (b.severity ? SEVERITY_ORDER[b.severity] : 3),
    );
}

/** A condition line and the episode it comes from (null: the written note). */
interface ConditionLine {
  label: string;
  episodeId: string | null;
}

async function readConditions(userId: string): Promise<ConditionLine[]> {
  const [episodes, profile] = await Promise.all([
    prisma.illnessEpisode.findMany({
      where: {
        userId,
        deletedAt: null,
        lifecycle: "CHRONIC_ONGOING",
        resolvedAt: null,
      },
      orderBy: { onsetAt: "asc" },
      take: LIST_CAP,
      select: { id: true, label: true },
    }),
    prisma.userHealthProfile.findUnique({
      where: { userId },
      select: { conditionsEncrypted: true },
    }),
  ]);
  const out: ConditionLine[] = episodes.map((e) => ({
    label: e.label,
    episodeId: e.id,
  }));
  if (profile?.conditionsEncrypted && profile.conditionsEncrypted.byteLength) {
    try {
      const text = decryptFromBytes(profile.conditionsEncrypted).trim();
      if (text) out.push({ label: text, episodeId: null });
    } catch {
      getEvent()?.addWarning(
        `emergency card: conditions decrypt failed for ${userId}`,
      );
    }
  }
  return out;
}

async function readMedications(
  userId: string,
  today: string,
): Promise<Array<EmergencyCardMedication & { id: string }>> {
  const day = dayKeyAsUtcMidnight(today);
  const rows = await prisma.medication.findMany({
    where: {
      userId,
      active: true,
      pausedAt: null,
      // Taken today: inside a course that covers today, or, for a drug
      // without courses, inside its own window. A drug between two courses,
      // or one that starts next week, is not on the card, the rule the
      // doctor report's medication list uses for its range.
      OR: [
        {
          courses: {
            some: {
              startsOn: { lte: day },
              OR: [{ endsOn: null }, { endsOn: { gte: day } }],
            },
          },
        },
        {
          courses: { none: {} },
          AND: [
            { OR: [{ startsOn: null }, { startsOn: { lte: day } }] },
            { OR: [{ endsOn: null }, { endsOn: { gte: day } }] },
          ],
        },
      ],
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: LIST_CAP,
    select: { id: true, name: true, dose: true },
  });
  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    dose: m.dose.trim() || null,
  }));
}

async function readPregnancy(
  userId: string,
  today: string,
): Promise<EmergencyCardPregnancy | null> {
  const profile = await loadPregnancyFields(prisma, userId);
  if (!profile) return null;
  const resolved = resolvePregnancyState(profile, today);
  if (!resolved.state) return null;
  return {
    state: resolved.state,
    gestationalWeeks: resolved.gestationalAge?.weeks ?? null,
    gestationalDays: resolved.gestationalAge?.days ?? null,
    dueDate: resolved.dueDate,
    deliveryDate: resolved.deliveryDate,
    postpartumWeek: resolved.postpartumWeek,
  };
}

/** The records behind the card's listed lines, for the owner's own view. */
interface CardSources {
  /** One per condition line: its episode, or null for the written note. */
  conditionEpisodeIds: Array<string | null>;
  /** One per medication line. */
  medicationIds: string[];
}

/**
 * Read the card for `userId` on the owner's calendar day `today`, limited to
 * `fields` (every item when omitted, the owner's own view).
 */
export async function loadEmergencyCard(
  userId: string,
  today: string,
  fields: readonly EmergencyCardField[] = EMERGENCY_CARD_FIELDS,
): Promise<EmergencyCardView> {
  return (await readCard(userId, today, fields)).view;
}

/**
 * The owner's card with where each line is edited (`emergencyCardTargets`).
 * Only the owner's own route reads it: the ids behind the lines never reach
 * the read-only link, its offline copy or the wallet card.
 */
export async function loadOwnerEmergencyCard(
  userId: string,
  today: string,
  modules: Readonly<Partial<Record<ModuleKey, boolean>>>,
): Promise<{ card: EmergencyCardView; targets: EmergencyCardTargets }> {
  const { view, sources } = await readCard(
    userId,
    today,
    EMERGENCY_CARD_FIELDS,
  );
  return {
    card: view,
    targets: emergencyCardTargets({ ...sources, modules }),
  };
}

async function readCard(
  userId: string,
  today: string,
  fields: readonly EmergencyCardField[],
): Promise<{ view: EmergencyCardView; sources: CardSources }> {
  const asked = normaliseFields(fields);
  const has = (f: EmergencyCardField) => asked.includes(f);
  const needsProfile =
    has("BLOOD_TYPE") ||
    has("IMPLANTS") ||
    has("CONTACTS") ||
    has("ADVANCE_DIRECTIVE") ||
    has("ORGAN_DONOR") ||
    has("NOTE");

  const [profile, allergies, conditions, medications, pregnancy, user] =
    await Promise.all([
      needsProfile ? readEmergencyProfile(userId) : null,
      has("ALLERGIES") ? readAllergies(userId) : null,
      has("CONDITIONS") ? readConditions(userId) : null,
      has("MEDICATIONS") ? readMedications(userId, today) : null,
      has("PREGNANCY") ? readPregnancy(userId, today) : null,
      has("DATE_OF_BIRTH") || has("NAME")
        ? prisma.user.findUnique({
            where: { id: userId },
            select: {
              dateOfBirth: true,
              timezone: true,
              fullName: true,
              displayName: true,
            },
          })
        : null,
    ]);

  const text = (value: string | null | undefined) => value ?? null;
  const named = (value: string | null | undefined) => value?.trim() || null;
  const view: EmergencyCardView = {
    fields: asked,
    name: has("NAME")
      ? (named(user?.fullName) ?? named(user?.displayName))
      : null,
    bloodType: has("BLOOD_TYPE") ? (profile?.bloodType ?? null) : null,
    allergies: allergies && allergies.length > 0 ? allergies : null,
    conditions:
      conditions && conditions.length > 0
        ? conditions.map((c) => c.label)
        : null,
    medications:
      medications && medications.length > 0
        ? medications.map((m) => ({ name: m.name, dose: m.dose }))
        : null,
    pregnancy,
    implants: has("IMPLANTS") ? text(profile?.implants) : null,
    contacts: has("CONTACTS") ? text(profile?.contacts) : null,
    advanceDirective: has("ADVANCE_DIRECTIVE")
      ? (profile?.advanceDirective ?? null)
      : null,
    organDonor: has("ORGAN_DONOR") ? (profile?.organDonor ?? null) : null,
    note: has("NOTE") ? text(profile?.note) : null,
    dateOfBirth:
      has("DATE_OF_BIRTH") && user?.dateOfBirth
        ? dateOfBirthKey(user.dateOfBirth, user.timezone)
        : null,
    asOf: today,
  };
  return {
    view,
    sources: {
      conditionEpisodeIds: (conditions ?? []).map((c) => c.episodeId),
      medicationIds: (medications ?? []).map((m) => m.id),
    },
  };
}

/** Does the card hold anything at all? */
export function emergencyCardHasContent(view: EmergencyCardView): boolean {
  return (
    view.name !== null ||
    view.dateOfBirth !== null ||
    emergencyCardHasHealthItems(view)
  );
}

/**
 * Does the card hold something a first responder needs beyond who it is
 * (the name and the date of birth)? The start page offers the card for
 * Wallet only then (`readEmergencyWalletAsk`).
 */
export function emergencyCardHasHealthItems(view: EmergencyCardView): boolean {
  return (
    view.bloodType !== null ||
    view.allergies !== null ||
    view.conditions !== null ||
    view.medications !== null ||
    view.pregnancy !== null ||
    view.implants !== null ||
    view.contacts !== null ||
    view.advanceDirective !== null ||
    view.organDonor !== null ||
    view.note !== null
  );
}
