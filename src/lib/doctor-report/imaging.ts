/**
 * The imaging exams on the doctor report (#1672). Reference data, read whole
 * and oldest first when the `IMAGING_EXAMS` leaf and the `imaging` module
 * admit it. The four text fields are opened fail-soft; the filed documents
 * are not part of the report.
 */
import { prisma } from "@/lib/db";
import type { DoctorReportData } from "@/lib/doctor-report-types";
import { openImagingText } from "@/lib/imaging/server";

export async function loadImagingExams(
  userId: string,
): Promise<DoctorReportData["imagingExams"]> {
  const rows = await prisma.imagingExam.findMany({
    where: { userId },
    orderBy: [{ performedAt: "asc" }, { id: "asc" }],
    select: {
      performedAt: true,
      modality: true,
      side: true,
      bodyPartEncrypted: true,
      facilityEncrypted: true,
      requestingDoctorEncrypted: true,
      conclusionEncrypted: true,
    },
  });
  if (rows.length === 0) return null;
  return rows.map((row) => ({
    performedAt: row.performedAt.toISOString(),
    modality: row.modality,
    side: row.side,
    bodyPart: openImagingText(row.bodyPartEncrypted, "bodyPart"),
    facility: openImagingText(row.facilityEncrypted, "facility"),
    requestingDoctor: openImagingText(
      row.requestingDoctorEncrypted,
      "requestingDoctor",
    ),
    conclusion: openImagingText(row.conclusionEncrypted, "conclusion"),
  }));
}
