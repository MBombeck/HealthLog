/**
 * Where the pregnancy state is kept: one AES-256-GCM envelope on
 * `CycleProfile.pregnancyEncrypted`, sealed and opened only here.
 *
 * The state and its three calendar days are the most disclosure-sensitive
 * item of the cycle data, and no query reads them: every reader resolves
 * them in the application on a given day (`pregnancy.ts`). So nothing of
 * them is plaintext at rest. `postpartumWeeks` is a plain setting beside it.
 *
 * Writing fails closed (no key, no write), like every encrypted column. An
 * envelope that does not open (a key the host no longer has) reads as no
 * state, so a cycle page or an emergency card never shows a guess; the read
 * is annotated so the operator can find it.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { decrypt, encrypt } from "@/lib/crypto";
import { annotate } from "@/lib/logging/context";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";

import {
  POSTPARTUM_WEEKS_DEFAULT,
  type PregnancyProfileFields,
} from "./pregnancy";
import type { CycleReproductiveState } from "./types";

/** The `CycleProfile` columns the state lives in, for a Prisma `select`. */
export const PREGNANCY_PROFILE_SELECT = {
  pregnancyEncrypted: true,
  postpartumWeeks: true,
} as const;

/**
 * The columns of a record with no pregnancy state and the default setting,
 * for a purge that removes the cycle data ("delete all cycle data"): the
 * state is the most disclosure-sensitive part of it and must not outlive it.
 */
export const PREGNANCY_CLEARED = {
  pregnancyEncrypted: null,
  postpartumWeeks: POSTPARTUM_WEEKS_DEFAULT,
} as const;

/** The state as it was opened: the setting beside it is always there. */
export type OpenedPregnancy = PregnancyProfileFields & {
  postpartumWeeks: number;
  /**
   * The owner set or cleared the state at least once. An Apple Health import
   * then never sets it behind them, however long ago that was (it is kept
   * here rather than read off the audit log, whose rows expire).
   */
  ownerDecided: boolean;
};

/** A row that carries the stored state. */
export interface StoredPregnancyRow {
  pregnancyEncrypted: string | null;
  postpartumWeeks: number;
}

interface SealedPregnancy {
  state: CycleReproductiveState | null;
  startDate: string | null;
  dueDate: string | null;
  deliveryDate: string | null;
  ownerDecided?: boolean;
}

const STATES: ReadonlySet<string> = new Set(["PREGNANT", "POSTPARTUM"]);
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function dayOrNull(value: unknown): string | null {
  return typeof value === "string" && DAY_KEY.test(value) ? value : null;
}

/** The state's fields off a stored row. */
export function pregnancyFieldsOf(row: StoredPregnancyRow): OpenedPregnancy {
  const empty: OpenedPregnancy = {
    reproductiveState: null,
    pregnancyStartDate: null,
    pregnancyDueDate: null,
    deliveryDate: null,
    postpartumWeeks: row.postpartumWeeks,
    ownerDecided: false,
  };
  if (!row.pregnancyEncrypted) return empty;
  let sealed: Partial<SealedPregnancy>;
  try {
    sealed = JSON.parse(
      decrypt(row.pregnancyEncrypted),
    ) as Partial<SealedPregnancy>;
  } catch {
    annotate({ meta: { cycle_pregnancy_undecryptable: true } });
    return empty;
  }
  return {
    reproductiveState:
      typeof sealed.state === "string" && STATES.has(sealed.state)
        ? (sealed.state as CycleReproductiveState)
        : null,
    pregnancyStartDate: dayOrNull(sealed.startDate),
    pregnancyDueDate: dayOrNull(sealed.dueDate),
    deliveryDate: dayOrNull(sealed.deliveryDate),
    postpartumWeeks: row.postpartumWeeks,
    ownerDecided: sealed.ownerDecided === true,
  };
}

/**
 * The columns that store `fields`. No state, no day and no decision of the
 * owner's seals to NULL, so an account that never touched a pregnancy holds
 * no ciphertext at all.
 */
export function pregnancyWriteData(
  fields: PregnancyProfileFields & { ownerDecided?: boolean },
): StoredPregnancyRow {
  const sealed: SealedPregnancy = {
    state: fields.reproductiveState ?? null,
    startDate: fields.pregnancyStartDate ?? null,
    dueDate: fields.pregnancyDueDate ?? null,
    deliveryDate: fields.deliveryDate ?? null,
    ...(fields.ownerDecided ? { ownerDecided: true } : {}),
  };
  const empty =
    sealed.state === null &&
    sealed.startDate === null &&
    sealed.dueDate === null &&
    sealed.deliveryDate === null &&
    sealed.ownerDecided !== true;
  return {
    pregnancyEncrypted: empty ? null : encrypt(JSON.stringify(sealed)),
    postpartumWeeks: fields.postpartumWeeks ?? 12,
  };
}

/**
 * The stored state of a record, for the readers outside the cycle pages
 * (emergency card, report, timeline, Health Score, personal records, the
 * lasting-change notice, the AI context). Null when the record has no
 * state, or when the cycle module is off for it, by the owner's switch or the
 * operator's (`isCycleAvailableForUser`, the gate every server-side cycle
 * reader goes through): a state the cycle pages do not show is not shown
 * anywhere else either.
 */
export async function loadPregnancyFields(
  db: Pick<PrismaClient, "cycleProfile">,
  userId: string,
): Promise<OpenedPregnancy | null> {
  if (typeof db.cycleProfile?.findUnique !== "function") return null;
  const profile = await db.cycleProfile.findUnique({
    where: { userId },
    select: PREGNANCY_PROFILE_SELECT,
  });
  if (!profile?.pregnancyEncrypted) return null;
  if (!(await isCycleAvailableForUser(userId))) return null;
  return pregnancyFieldsOf(profile);
}
