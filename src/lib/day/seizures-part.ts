/**
 * The seizures section of a day (`seizures` in `DAY_SECTION_KEYS`), read like
 * the other record sections of `./records.ts`.
 */
import { prisma } from "@/lib/db";
import { decryptSeizureText } from "@/lib/seizures/server";

import type { DayEvent } from "./contract";
import type { DayFrame, SectionPart } from "./records";

/**
 * The seizures recorded that day, each at its onset, so it sits against the
 * day's doses like a symptom (`withDoseOffsets`). A seizure whose time is not
 * known is on the date only. The title is the person's own name for its type;
 * the meta is `<certainty> <count>`.
 */
export async function seizuresPart(frame: DayFrame): Promise<SectionPart> {
  const rows = await prisma.seizureEvent.findMany({
    where: {
      userId: frame.userId,
      onsetAt: { gte: frame.dayStart, lt: frame.dayEnd },
    },
    select: {
      id: true,
      onsetAt: true,
      onsetPrecision: true,
      count: true,
      certainty: true,
      typeProfile: { select: { labelEncrypted: true } },
    },
    orderBy: [{ onsetAt: "asc" }, { id: "asc" }],
  });
  return {
    running: [],
    events: rows.map((row): DayEvent => ({
      docs: [],
      note: null,
      at:
        row.onsetPrecision === "UNKNOWN_TIME"
          ? null
          : row.onsetAt.toISOString(),
      kind: "seizure",
      section: "seizures",
      id: row.id,
      title: row.typeProfile
        ? (decryptSeizureText(row.typeProfile.labelEncrypted, "label") ?? "")
        : "",
      meta: `${row.certainty} ${row.count}`,
      href: "/seizures",
    })),
  };
}
