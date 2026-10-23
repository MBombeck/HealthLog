import { prisma } from "@/lib/db";
import { apiHandler, requireAuth, requireRecentProof } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  toCSV,
  formatMedicationsForExport,
  formatIntakeEventsForExport,
  formatMoodEntriesForExport,
  type ExportableRecord,
} from "@/lib/export";
import { shapeMoodNote } from "@/lib/crypto/note-cipher";
import {
  formatMeasurementPageChunks,
  iterateMeasurementPages,
} from "@/lib/export/paged-measurements";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { NextRequest, NextResponse } from "next/server";
import { MEDICATION_SCHEDULE_ORDER } from "@/lib/medications/read-order";

/**
 * Export user data.
 * Query params:
 *   format: "csv" | "json" (default: json)
 *   type: "measurements" | "medications" | "intake" | "mood" | "all"
 *         (default: all)
 *
 * `type=all` (the default) is the whole record in one file, so it takes the
 * same fresh-proof gate as every other whole-record export
 * (`requireRecentProof`): a browser session must have signed in or re-proved
 * within five minutes, a token must present a step-up elevation. No shipped
 * client calls this route with a token. The single-type exports stay on the
 * session alone, like their dedicated routes under `/api/export/*`.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const wholeRecord =
    (new URL(request.url).searchParams.get("type") ?? "all") === "all";
  const auth = wholeRecord
    ? await requireRecentProof({ bearer: "elevation" })
    : { ...(await requireAuth()), commitElevation: async () => {} };
  const { user } = auth;

  const rl = await checkRateLimit(`export:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  annotate({ action: { name: "export.download" } });

  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") ?? "json";
  const type = searchParams.get("type") ?? "all";

  if (!["csv", "json"].includes(format)) {
    return apiError("Format must be csv or json", 422);
  }
  if (
    !["measurements", "medications", "intake", "mood", "all"].includes(type)
  ) {
    return apiError(
      "Type must be measurements, medications, intake, mood, or all",
      422,
    );
  }

  // Spend a Bearer elevation only once the request is about to act.
  await auth.commitElevation();

  const userId = user.id;
  await auditLog("export.download", {
    userId,
    ipAddress: getClientIp(request),
    details: { format, type, outcome: "attempted" },
  });
  annotate({
    meta: {
      export_format: format,
      export_type: type,
      export_outcome: "attempted",
    },
  });
  const [userTz, sourcePriorityJson] = await Promise.all([
    resolveUserTimezone(userId),
    loadUserSourcePriority(userId),
  ]);
  const data: Record<string, unknown> = {};
  let measurementChunks: AsyncIterable<ExportableRecord[]> | null = null;

  if (type === "measurements" || type === "all") {
    const pageIterator = iterateMeasurementPages(
      prisma,
      { userId, deletedAt: null },
      {
        id: true,
        type: true,
        value: true,
        unit: true,
        measuredAt: true,
        source: true,
        notes: true,
        notesEncrypted: true,
        glucoseContext: true,
        sleepStage: true,
        deviceType: true,
      },
    )[Symbol.asyncIterator]();
    const firstPage = await pageIterator.next();
    measurementChunks = formatMeasurementPageChunks(
      prefetchedPages(pageIterator, firstPage),
      userTz,
      {
        granularity: "night",
        sourcePriorityJson,
        // Preserve the legacy endpoint's canonical storage-unit contract.
        glucoseUnit: "mg/dL",
      },
    );
  }

  if (type === "medications" || type === "all") {
    const medications = await prisma.medication.findMany({
      where: { userId },
      include: { schedules: { orderBy: MEDICATION_SCHEDULE_ORDER } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    data.medications =
      format === "csv"
        ? toCSV(formatMedicationsForExport(medications))
        : formatMedicationsForExport(medications);
  }

  if (type === "intake" || type === "all") {
    const events = await prisma.medicationIntakeEvent.findMany({
      where: { userId, deletedAt: null },
      include: { medication: { select: { name: true } } },
      orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
    });
    data.intakeEvents =
      format === "csv"
        ? toCSV(formatIntakeEventsForExport(events, userTz))
        : formatIntakeEventsForExport(events, userTz);
  }

  if (type === "mood" || type === "all") {
    const moodEntries = await prisma.moodEntry.findMany({
      where: { userId, deletedAt: null },
      orderBy: { moodLoggedAt: "desc" },
    });
    const decryptedMood = moodEntries.map(shapeMoodNote);
    data.moodEntries =
      format === "csv"
        ? toCSV(formatMoodEntriesForExport(decryptedMood, userTz))
        : formatMoodEntriesForExport(decryptedMood, userTz);
  }

  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: file name stamp, not a day shown or compared
  const filename = `healthlog-export-${new Date().toISOString().slice(0, 10)}`;

  if (measurementChunks && format === "csv") {
    return new NextResponse(
      streamText(legacyCsvChunks(measurementChunks, data)),
      {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}.csv"`,
        },
      },
    );
  }

  if (measurementChunks) {
    return new NextResponse(
      streamText(legacyJsonChunks(measurementChunks, data)),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${filename}.json"`,
        },
      },
    );
  }

  if (format === "csv") {
    const csvParts: string[] = [];
    if (typeof data.medications === "string" && data.medications.length > 0) {
      csvParts.push("# Medications\n" + data.medications);
    }
    if (typeof data.intakeEvents === "string" && data.intakeEvents.length > 0) {
      csvParts.push("# Intake Events\n" + data.intakeEvents);
    }
    if (typeof data.moodEntries === "string" && data.moodEntries.length > 0) {
      csvParts.push("# Mood Entries\n" + data.moodEntries);
    }
    return new NextResponse(csvParts.join("\n\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}.csv"`,
      },
    });
  }

  return NextResponse.json(
    { data },
    {
      status: 200,
      headers: {
        "Content-Disposition": `attachment; filename="${filename}.json"`,
      },
    },
  );
});

async function* prefetchedPages<T>(
  iterator: AsyncIterator<T[]>,
  first: IteratorResult<T[]>,
): AsyncGenerator<readonly T[], void, void> {
  try {
    let next = first;
    while (!next.done) {
      yield next.value;
      next = await iterator.next();
    }
  } finally {
    await iterator.return?.();
  }
}

async function* legacyCsvChunks(
  measurementChunks: AsyncIterable<ExportableRecord[]>,
  data: Record<string, unknown>,
): AsyncGenerator<string, void, void> {
  let wroteSection = false;
  let wroteMeasurementHeader = false;
  for await (const records of measurementChunks) {
    const csv = toCSV(records);
    if (csv.length === 0) continue;
    if (!wroteMeasurementHeader) {
      wroteMeasurementHeader = true;
      wroteSection = true;
      yield `# Measurements\n${csv}`;
      continue;
    }
    const headerEnd = csv.indexOf("\n");
    if (headerEnd >= 0 && headerEnd + 1 < csv.length) {
      yield `\n${csv.slice(headerEnd + 1)}`;
    }
  }

  const staticSections: Array<[string, unknown]> = [
    ["Medications", data.medications],
    ["Intake Events", data.intakeEvents],
    ["Mood Entries", data.moodEntries],
  ];
  for (const [heading, value] of staticSections) {
    if (typeof value !== "string" || value.length === 0) continue;
    yield `${wroteSection ? "\n\n" : ""}# ${heading}\n${value}`;
    wroteSection = true;
  }
}

async function* legacyJsonChunks(
  measurementChunks: AsyncIterable<ExportableRecord[]>,
  data: Record<string, unknown>,
): AsyncGenerator<string, void, void> {
  yield '{"data":{"measurements":[';
  let wroteMeasurement = false;
  for await (const records of measurementChunks) {
    if (records.length === 0) continue;
    const json = records.map((record) => JSON.stringify(record)).join(",");
    yield `${wroteMeasurement ? "," : ""}${json}`;
    wroteMeasurement = true;
  }
  yield "]";

  const staticKeys = ["medications", "intakeEvents", "moodEntries"] as const;
  for (const key of staticKeys) {
    if (!(key in data)) continue;
    yield `,${JSON.stringify(key)}:${JSON.stringify(data[key])}`;
  }
  yield "}}";
}

function streamText(chunks: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
