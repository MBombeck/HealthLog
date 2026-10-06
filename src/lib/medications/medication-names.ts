/**
 * The names on a person's medication schedule, for the outbound dose screen.
 *
 * The screen's dose-change class needs a medication noun next to a skip, stop
 * or extra imperative. A brand name ("Eliquis") is no dosage-form word and has
 * no generic stem, so without the person's own names "skip the Eliquis"
 * passed. Inactive entries are included on purpose: an instruction to take or
 * skip a medication the person used to be on is still a dose instruction.
 *
 * Server-only; a cheap indexed read. `Medication.name` is plaintext.
 */
import { prisma } from "@/lib/db";

/** The de-duped medication names of one person, at most 64. */
export async function getMedicationNames(userId: string): Promise<string[]> {
  const rows = await prisma.medication.findMany({
    where: { userId },
    select: { name: true },
    take: 64,
  });
  return [...new Set(rows.map((row) => row.name.trim()).filter(Boolean))];
}
