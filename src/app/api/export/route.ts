import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiError, getClientIp } from "@/lib/api-response";
import {
  toCSV,
  formatMeasurementsForExport,
  formatMedicationsForExport,
  formatIntakeEventsForExport,
  formatMoodEntriesForExport,
} from "@/lib/export";
import { NextRequest, NextResponse } from "next/server";

/**
 * Export user data.
 * Query params:
 *   format: "csv" | "json" (default: json)
 *   type: "measurements" | "medications" | "intake" | "all" (default: all)
 *
 * Re-authentication is required via session (user must be logged in).
 */
export async function GET(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") ?? "json";
  const type = searchParams.get("type") ?? "all";

  if (!["csv", "json"].includes(format)) {
    return apiError("Format muss csv oder json sein", 422);
  }
  if (!["measurements", "medications", "intake", "mood", "all"].includes(type)) {
    return apiError("Typ muss measurements, medications, intake, mood oder all sein", 422);
  }

  const userId = sessionData.user.id;

  try {
    const data: Record<string, unknown> = {};

    if (type === "measurements" || type === "all") {
      const measurements = await prisma.measurement.findMany({
        where: { userId },
        orderBy: { measuredAt: "desc" },
      });
      data.measurements =
        format === "csv"
          ? toCSV(formatMeasurementsForExport(measurements))
          : formatMeasurementsForExport(measurements);
    }

    if (type === "medications" || type === "all") {
      const medications = await prisma.medication.findMany({
        where: { userId },
        include: { schedules: true },
        orderBy: { createdAt: "desc" },
      });
      data.medications =
        format === "csv"
          ? toCSV(formatMedicationsForExport(medications))
          : formatMedicationsForExport(medications);
    }

    if (type === "intake" || type === "all") {
      const events = await prisma.medicationIntakeEvent.findMany({
        where: { userId },
        include: { medication: { select: { name: true } } },
        orderBy: { scheduledFor: "desc" },
      });
      data.intakeEvents =
        format === "csv"
          ? toCSV(formatIntakeEventsForExport(events))
          : formatIntakeEventsForExport(events);
    }

    if (type === "mood" || type === "all") {
      const moodEntries = await prisma.moodEntry.findMany({
        where: { userId },
        orderBy: { moodLoggedAt: "desc" },
      });
      data.moodEntries =
        format === "csv"
          ? toCSV(formatMoodEntriesForExport(moodEntries))
          : formatMoodEntriesForExport(moodEntries);
    }

    await auditLog("export.download", {
      userId,
      ipAddress: getClientIp(request),
      details: { format, type },
    });

    if (format === "csv") {
      // For CSV with all types, combine into separate sections
      const csvParts: string[] = [];
      if (data.measurements) {
        csvParts.push("# Measurements\n" + data.measurements);
      }
      if (data.medications) {
        csvParts.push("# Medications\n" + data.medications);
      }
      if (data.intakeEvents) {
        csvParts.push("# Intake Events\n" + data.intakeEvents);
      }
      if (data.moodEntries) {
        csvParts.push("# Mood Entries\n" + data.moodEntries);
      }
      const csvContent = csvParts.join("\n\n");

      return new NextResponse(csvContent, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="healthlog-export-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    return NextResponse.json(
      { data },
      {
        status: 200,
        headers: {
          "Content-Disposition": `attachment; filename="healthlog-export-${new Date().toISOString().slice(0, 10)}.json"`,
        },
      },
    );
  } catch (err) {
    console.error("Export error:", err);
    return apiError("Export fehlgeschlagen", 500);
  }
}
