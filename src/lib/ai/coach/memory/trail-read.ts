/**
 * v1.41 — the person's facts in a stored trail, read while the medications
 * module is off.
 *
 * A trail keeps the fact texts its turn recalled and the fact a proposal
 * offered, so they survive a reload. The block only recalls a `medication`
 * fact while the module is on, but the module can be switched off after the
 * turn; the trail route then withholds those, the way `…/results` withholds a
 * table whose module is off. The proposal names its category. A recalled
 * text does not, so it is matched against the person's stored facts (live or
 * deleted, since a forgotten fact keeps its category) and read by the
 * lexicon as well; either one naming a medication withholds it. Over-matching
 * is the safe direction.
 *
 * Server-only. Fact text never reaches a log.
 */
import { prisma } from "@/lib/db";

import { decryptFromBytes } from "../bytes-codec";
import type { CoachTrail } from "../types";
import { healthTermKind } from "./lexicon";

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function withholdMedicationFacts(
  userId: string,
  trail: CoachTrail,
): Promise<{
  recalled: string[] | undefined;
  proposal: CoachTrail["proposal"];
  withheld: number;
}> {
  let withheld = 0;
  const proposal =
    trail.proposal &&
    (trail.proposal.category === "medication" ||
      healthTermKind(trail.proposal.fact) === "medication")
      ? undefined
      : trail.proposal;
  if (trail.proposal && !proposal) withheld += 1;

  const recalledIn = trail.recalled ?? [];
  if (recalledIn.length === 0) {
    return { recalled: trail.recalled, proposal, withheld };
  }
  const medicationTexts = new Set<string>();
  const rows = await prisma.coachFact.findMany({
    where: { userId, category: "medication" },
    select: { factEncrypted: true },
  });
  for (const row of rows) {
    try {
      medicationTexts.add(flat(decryptFromBytes(row.factEncrypted)));
    } catch {
      // An unreadable row names nothing.
    }
  }
  const recalled = recalledIn.filter((text) => {
    const medication =
      medicationTexts.has(flat(text)) || healthTermKind(text) === "medication";
    if (medication) withheld += 1;
    return !medication;
  });
  return { recalled, proposal, withheld };
}
