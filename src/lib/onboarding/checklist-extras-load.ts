/**
 * 1.49 — the presence behind the checklist's "More" group, for one record
 * (see `./checklist-extras.ts`). Counts and existence only: nothing about
 * what a card says, who a link was shared with, or what was imported.
 */
import { prisma } from "@/lib/db";
import { parseReportSchedule } from "@/lib/doctor-report/schedule-shape";

import {
  CHECKLIST_EXTRA_IDS,
  checklistExtraApplies,
  type ChecklistExtraId,
  type ChecklistExtrasDto,
} from "./checklist-extras";

export async function loadChecklistExtras(args: {
  recordId: string;
  recordKind: "self" | "managed";
}): Promise<ChecklistExtrasDto> {
  const { recordId, recordKind } = args;
  const self = recordKind === "self";
  const [
    emergencyLinks,
    careFeeds,
    grants,
    shareLinks,
    importJobs,
    fhirResources,
    remoteSource,
    record,
    iosDevices,
  ] = await Promise.all([
    prisma.emergencyCardLink.count({
      where: { userId: recordId, revokedAt: null },
    }),
    prisma.careCalendarFeed.count({
      where: { userId: recordId, revokedAt: null },
    }),
    self ? prisma.accountGrant.count({ where: { grantorId: recordId } }) : 0,
    self
      ? prisma.clinicianShareLink.count({
          where: {
            userId: recordId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        })
      : 0,
    self
      ? prisma.importJob.count({ where: { userId: recordId, status: "done" } })
      : 0,
    self
      ? prisma.fhirImportedResource.count({ where: { userId: recordId } })
      : 0,
    self
      ? prisma.healthConnectRemoteSource.findUnique({
          where: { userId: recordId },
          select: { id: true },
        })
      : null,
    prisma.user.findUnique({
      where: { id: recordId },
      select: { reportScheduleJson: true },
    }),
    self
      ? prisma.device.count({ where: { userId: recordId, platform: "ios" } })
      : 0,
  ]);

  const done: Record<ChecklistExtraId, boolean> = {
    emergencyCard: emergencyLinks > 0,
    careFeed: careFeeds > 0,
    sharing: grants > 0 || shareLinks > 0,
    imports: importJobs > 0 || fhirResources > 0 || remoteSource !== null,
    reportSchedule: parseReportSchedule(record?.reportScheduleJson) !== null,
    iosApp: iosDevices > 0,
  };
  return Object.fromEntries(
    CHECKLIST_EXTRA_IDS.map((id) => [
      id,
      { applies: checklistExtraApplies(id, recordKind), done: done[id] },
    ]),
  ) as ChecklistExtrasDto;
}
