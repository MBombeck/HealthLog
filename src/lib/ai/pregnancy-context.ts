/**
 * The pregnancy context every model prompt that reasons about weight, the
 * cycle or vitals carries.
 *
 * The Coach had it (its cycle block, `cycle-snapshot.ts`); the status cards,
 * the daily briefing and the period narratives did not, so the weight card
 * could read "+6 kg in 12 weeks" as a trend against the goal while the
 * Health Score beside it paused the goal for the pregnancy. Every surface now
 * builds the block here, from the same stored state (`pregnancy-store.ts`,
 * gated on the cycle module) and the same resolution (`pregnancy.ts`), and
 * the Coach's cycle block is built by `pregnancySnapshotBlock` too.
 *
 * Only model input. The AI capability gate stays where it is, on the model
 * call: this adds no data surface and gates none.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  resolvePregnancyState,
  resolvePregnancyStateDuring,
  type ResolvedPregnancyState,
} from "@/lib/cycle/pregnancy";
import { loadPregnancyFields } from "@/lib/cycle/pregnancy-store";
import { prisma as defaultPrisma } from "@/lib/db";
import { userDayKey } from "@/lib/tz/format";

/** The block a snapshot carries: what holds, and the week it is in. */
export interface PregnancySnapshotBlock {
  state: "PREGNANT" | "POSTPARTUM";
  gestationalWeeks: number | null;
  gestationalDays: number | null;
  dueDate: string | null;
  deliveryDate: string | null;
  postpartumWeek: number | null;
}

/** The block for a resolved state, or null when none holds. */
export function pregnancySnapshotBlock(
  r: ResolvedPregnancyState,
): PregnancySnapshotBlock | null {
  if (!r.state) return null;
  return {
    state: r.state,
    gestationalWeeks: r.gestationalAge?.weeks ?? null,
    gestationalDays: r.gestationalAge?.days ?? null,
    dueDate: r.dueDate,
    deliveryDate: r.deliveryDate,
    postpartumWeek: r.postpartumWeek,
  };
}

/**
 * The block for a record on its day `now`, or over `[from, now]` for a
 * surface that looks back over a period. Null without a state, or with the
 * cycle module off.
 */
export async function loadPregnancySnapshotBlock(
  userId: string,
  timezone: string,
  now: Date,
  options: {
    lookbackDays?: number;
    db?: Pick<PrismaClient, "cycleProfile">;
  } = {},
): Promise<PregnancySnapshotBlock | null> {
  const fields = await loadPregnancyFields(options.db ?? defaultPrisma, userId);
  if (!fields) return null;
  const today = userDayKey(now, timezone);
  const resolved =
    options.lookbackDays && options.lookbackDays > 0
      ? resolvePregnancyStateDuring(
          fields,
          userDayKey(
            new Date(now.getTime() - options.lookbackDays * 86_400_000),
            timezone,
          ),
          today,
        )
      : resolvePregnancyState(fields, today);
  return pregnancySnapshotBlock(resolved);
}

/**
 * The stable part of the block for a snapshot that is fingerprinted: the
 * state and the week, not the day, so a card is written again once a week
 * rather than every day.
 */
export function pregnancySnapshotWeek(block: PregnancySnapshotBlock): {
  state: "PREGNANT" | "POSTPARTUM";
  week: number | null;
} {
  return {
    state: block.state,
    week:
      block.state === "PREGNANT"
        ? block.gestationalWeeks
        : block.postpartumWeek,
  };
}

/**
 * The instruction that goes with the block, in the prompt's body language
 * (de, else en). `withWeek: false` for a surface whose grounding check
 * refuses any number the context does not carry.
 */
export function pregnancyContextPromptBlock(
  block: PregnancySnapshotBlock,
  locale: string,
  options: { withWeek?: boolean } = {},
): string {
  const de = locale === "de";
  const withWeek = options.withWeek !== false;
  const pregnant = block.state === "PREGNANT";
  const week = pregnant ? block.gestationalWeeks : block.postpartumWeek;
  const state = de
    ? pregnant
      ? withWeek && week !== null
        ? `Die Person ist schwanger, in Woche ${week}.`
        : "Die Person ist schwanger."
      : withWeek && week !== null
        ? `Die Person hat vor ${week} Wochen entbunden (Wochenbett).`
        : "Die Person ist im Wochenbett, den Wochen nach einer Geburt."
    : pregnant
      ? withWeek && week !== null
        ? `The person is pregnant, in week ${week}.`
        : "The person is pregnant."
      : withWeek && week !== null
        ? `The person gave birth ${week} weeks ago (postpartum).`
        : "The person is postpartum, in the weeks after a birth.";
  return de
    ? `

SYSTEM CONTEXT — SCHWANGERSCHAFT

${state} Gewicht, Ruhepuls, Blutdruck und Zyklus verändern sich in einer Schwangerschaft und nach einer Geburt erwartbar. ${withWeek ? "Nenne die Woche, wo sie hilft, und " : ""}sage nichts darüber, was sie bedeutet. Miss das Gewicht nie an einem Ziel, nenne eine Zunahme nie einen Rückschritt, rate nie zum Abnehmen und kündige keine Periode an. Keine Diagnose, keine Bewertung.`
    : `

SYSTEM CONTEXT — PREGNANCY

${state} Weight, resting heart rate, blood pressure and the cycle change as expected in a pregnancy and after a birth. ${withWeek ? "Name the week where it helps, and " : ""}say nothing about what it means. Never measure weight against a goal, never call a gain a setback, never suggest losing weight, and do not announce a period. No diagnosis, no rating.`;
}
