/**
 * The timeline's lanes: the record's spans and points, projected from the
 * tables that own them (v1.42, #613).
 *
 * Nothing is stored for the timeline. A medication's line is its start and
 * end date, an illness its onset and recovery, a visit its day; correcting
 * the row corrects the line. Every item says how sure its start is: a
 * medication without a start date starts at its first intake, and says so
 * (`startKnown: false`), so the view can draw that start dashed rather than
 * pretend. Something with no date at all is not drawn on the axis; it is
 * listed once under `standing`.
 *
 * Each lane belongs to one sharing domain and, where a module owns it, to
 * that module; a lane the caller may not see is not read. The `life` lane
 * holds life events (the timeline module's own content) and travel periods
 * (the environment module); both are owner-only in v1.42, so the lane maps
 * to no domain and no delegate sees it at any level. Travel periods are
 * filtered item by item on the environment module. A travel item never
 * carries a place: the label is sealed.
 */
import type { TimelineItem, TimelineLaneKey } from "@/lib/day/contract";
import { openText } from "@/lib/day/records";
import { prisma } from "@/lib/db";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";
import type { ModuleKey } from "@/lib/modules/registry";
import { surfaceModule } from "@/lib/modules/surface";
import type { ShareDomain } from "@/lib/sharing/scope";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { userDayKey } from "@/lib/tz/format";

/**
 * The sharing domain each lane reads, or `null` for a lane only the record's
 * owner sees.
 */
export const TIMELINE_LANE_SHARE_DOMAIN: Readonly<
  Record<TimelineLaneKey, ShareDomain | null>
> = Object.freeze({
  life: null,
  illness: "illness",
  allergies: "profile",
  medications: "medications",
  vaccinations: "profile",
  visits: "profile",
  labs: "labs",
  documents: "documents",
  cycle: "cycle",
});

/** What one request may see of the timeline. */
export interface TimelineAccess {
  modules: Readonly<Record<ModuleKey, boolean>>;
  domainVisible: (domain: ShareDomain) => boolean;
  owner: boolean;
}

export function laneVisible(
  lane: TimelineLaneKey,
  access: TimelineAccess,
): boolean {
  const owner = surfaceModule(`timeline-lane:${lane}`);
  if (owner !== undefined && access.modules[owner] === false) return false;
  const domain = TIMELINE_LANE_SHARE_DOMAIN[lane];
  return domain === null ? access.owner : access.domainVisible(domain);
}

export interface StandingItem {
  lane: TimelineLaneKey;
  id: string;
  label: string;
  since: string | null;
  href: string | null;
}

export interface LaneRead {
  items: TimelineItem[];
  standing: StandingItem[];
}

interface LaneFrame {
  userId: string;
  tz: string;
  access: TimelineAccess;
}

function item(
  rest: Omit<TimelineItem, "precision" | "startKnown" | "sub" | "href"> &
    Partial<Pick<TimelineItem, "precision" | "startKnown" | "sub" | "href">>,
): TimelineItem {
  return {
    precision: "DAY",
    startKnown: true,
    sub: null,
    href: null,
    ...rest,
  };
}

async function lifeLane(frame: LaneFrame): Promise<LaneRead> {
  // `laneVisible` already keeps this lane from every delegate; the owner
  // test is repeated here so a caller that skips it cannot read either half.
  const travelVisible =
    frame.access.owner && frame.access.modules.environment !== false;
  const [events, trips] = await Promise.all([
    !frame.access.owner || frame.access.modules.timeline === false
      ? Promise.resolve([])
      : prisma.lifeEvent.findMany({
          where: { userId: frame.userId, deletedAt: null },
          select: {
            id: true,
            category: true,
            startDate: true,
            endDate: true,
            precision: true,
            titleEncrypted: true,
          },
          orderBy: { startDate: "asc" },
        }),
    travelVisible
      ? prisma.environmentTravelLocation.findMany({
          where: { userId: frame.userId },
          select: { id: true, startDate: true, endDate: true },
          orderBy: { startDate: "asc" },
        })
      : Promise.resolve([]),
  ]);
  return {
    items: [
      ...events.map((e) =>
        item({
          id: e.id,
          kind: "lifeEvent",
          start: e.startDate,
          end: e.endDate,
          open: false,
          precision: e.precision,
          label: openText(e.titleEncrypted, "life event title") ?? "",
          sub: e.category,
        }),
      ),
      ...trips.map((t) =>
        item({
          id: t.id,
          kind: "travel",
          start: t.startDate,
          end: t.endDate,
          open: false,
          label: "travel",
        }),
      ),
    ],
    standing: [],
  };
}

async function illnessLane(frame: LaneFrame): Promise<LaneRead> {
  const rows = await prisma.illnessEpisode.findMany({
    where: { userId: frame.userId, deletedAt: null },
    select: {
      id: true,
      label: true,
      lifecycle: true,
      onsetAt: true,
      resolvedAt: true,
    },
    orderBy: { onsetAt: "asc" },
  });
  return {
    items: rows.map((r) =>
      item({
        id: r.id,
        kind: r.lifecycle === "CHRONIC_ONGOING" ? "chronic" : "episode",
        start: userDayKey(r.onsetAt, frame.tz),
        end: r.resolvedAt ? userDayKey(r.resolvedAt, frame.tz) : null,
        open: r.resolvedAt === null,
        label: r.label,
        href: `/illness/${r.id}`,
      }),
    ),
    standing: [],
  };
}

async function allergiesLane(frame: LaneFrame): Promise<LaneRead> {
  const rows = await prisma.allergy.findMany({
    where: { userId: frame.userId, deletedAt: null },
    select: { id: true, substance: true, onsetAt: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  const out: LaneRead = { items: [], standing: [] };
  for (const r of rows) {
    if (r.onsetAt) {
      out.items.push(
        item({
          id: r.id,
          kind: "allergy",
          start: userDayKey(r.onsetAt, frame.tz),
          end: null,
          open: r.status === "ACTIVE",
          label: r.substance,
          href: "/profile",
        }),
      );
    } else if (r.status === "ACTIVE") {
      out.standing.push({
        lane: "allergies",
        id: r.id,
        label: r.substance,
        since: null,
        href: "/profile",
      });
    }
  }
  return out;
}

async function medicationsLane(frame: LaneFrame): Promise<LaneRead> {
  const [meds, firstIntakes, courses, changes, pauses] = await Promise.all([
    prisma.medication.findMany({
      where: { userId: frame.userId },
      select: {
        id: true,
        name: true,
        dose: true,
        active: true,
        oneShot: true,
        startsOn: true,
        endsOn: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.medicationIntakeEvent.groupBy({
      by: ["medicationId"],
      where: {
        userId: frame.userId,
        deletedAt: null,
        skipped: false,
        takenAt: { not: null },
        ...TRACKED_INTAKE_EVENT_WHERE,
      },
      _min: { takenAt: true },
    }),
    prisma.medicationCourse.findMany({
      where: { userId: frame.userId },
      select: {
        id: true,
        medicationId: true,
        startsOn: true,
        endsOn: true,
        medication: { select: { name: true } },
      },
    }),
    prisma.medicationDoseChange.findMany({
      where: { medication: { userId: frame.userId } },
      select: {
        id: true,
        medicationId: true,
        effectiveFrom: true,
        doseValue: true,
        doseUnit: true,
        medication: { select: { name: true } },
      },
    }),
    prisma.medicationPauseEra.findMany({
      where: { userId: frame.userId },
      select: {
        id: true,
        medicationId: true,
        pausedAt: true,
        resumedAt: true,
        medication: { select: { name: true } },
      },
    }),
  ]);
  const firstIntake = new Map<string, Date>();
  for (const row of firstIntakes) {
    if (row._min.takenAt) firstIntake.set(row.medicationId, row._min.takenAt);
  }
  const out: LaneRead = { items: [], standing: [] };
  for (const med of meds) {
    const href = `/medications/${med.id}`;
    const stated = med.startsOn ? dateOnlyKey(med.startsOn) : null;
    const standIn = firstIntake.get(med.id);
    const start = stated ?? (standIn ? userDayKey(standIn, frame.tz) : null);
    if (start === null) {
      out.standing.push({
        lane: "medications",
        id: med.id,
        label: med.name,
        since: null,
        href,
      });
      continue;
    }
    const end = med.endsOn
      ? dateOnlyKey(med.endsOn)
      : med.active
        ? null
        : userDayKey(med.updatedAt, frame.tz);
    out.items.push(
      item({
        id: med.id,
        kind: "medication",
        start,
        end: med.oneShot ? null : end,
        open: !med.oneShot && end === null,
        startKnown: stated !== null,
        label: med.name,
        sub: med.dose,
        href,
      }),
    );
  }
  for (const c of courses) {
    const end = c.endsOn ? dateOnlyKey(c.endsOn) : null;
    out.items.push(
      item({
        id: c.id,
        kind: "course",
        start: dateOnlyKey(c.startsOn),
        end,
        open: end === null,
        label: c.medication.name,
        href: `/medications/${c.medicationId}`,
      }),
    );
  }
  for (const d of changes) {
    out.items.push(
      item({
        id: d.id,
        kind: "doseChange",
        start: userDayKey(d.effectiveFrom, frame.tz),
        end: null,
        open: false,
        label: d.medication.name,
        sub: `${d.doseValue} ${d.doseUnit}`,
        href: `/medications/${d.medicationId}/history`,
      }),
    );
  }
  for (const p of pauses) {
    const end = p.resumedAt ? userDayKey(p.resumedAt, frame.tz) : null;
    out.items.push(
      item({
        id: p.id,
        kind: "pause",
        start: userDayKey(p.pausedAt, frame.tz),
        end,
        open: end === null,
        label: p.medication.name,
        href: `/medications/${p.medicationId}`,
      }),
    );
  }
  return out;
}

async function vaccinationsLane(frame: LaneFrame): Promise<LaneRead> {
  const rows = await prisma.vaccinationRecord.findMany({
    where: { userId: frame.userId, deletedAt: null },
    select: {
      id: true,
      occurredAt: true,
      vaccineName: true,
      antigenSlug: true,
      customVaccine: { select: { name: true } },
    },
    orderBy: { occurredAt: "asc" },
  });
  return {
    items: rows.map((r) =>
      item({
        id: r.id,
        kind: "vaccination",
        start: userDayKey(r.occurredAt, frame.tz),
        end: null,
        open: false,
        label: r.vaccineName ?? r.customVaccine?.name ?? r.antigenSlug ?? "",
        href: `/vaccinations?dose=${r.id}`,
      }),
    ),
    standing: [],
  };
}

async function visitsLane(frame: LaneFrame): Promise<LaneRead> {
  const rows = await prisma.encounter.findMany({
    where: { userId: frame.userId, deletedAt: null, status: "DONE" },
    select: {
      id: true,
      occurredAt: true,
      kind: true,
      reasonEncrypted: true,
      practitioner: { select: { name: true } },
    },
    orderBy: { occurredAt: "asc" },
  });
  return {
    items: rows.map((r) =>
      item({
        id: r.id,
        kind: r.kind === "PROCEDURE" ? "procedure" : "visit",
        start: userDayKey(r.occurredAt, frame.tz),
        end: null,
        open: false,
        label:
          openText(r.reasonEncrypted, "visit reason") ??
          r.practitioner?.name ??
          "",
        sub: r.kind,
        href: `/checkups?visit=${r.id}`,
      }),
    ),
    standing: [],
  };
}

/** At most this many analytes name a lab day. */
const LAB_DAY_NAMES = 3;

async function labsLane(frame: LaneFrame): Promise<LaneRead> {
  const rows = await prisma.labResult.findMany({
    where: { userId: frame.userId, deletedAt: null },
    select: { analyte: true, takenAt: true },
    orderBy: { takenAt: "asc" },
  });
  const days = new Map<string, string[]>();
  for (const r of rows) {
    const day = userDayKey(r.takenAt, frame.tz);
    const names = days.get(day) ?? [];
    if (!names.includes(r.analyte)) names.push(r.analyte);
    days.set(day, names);
  }
  return {
    items: [...days].map(([day, names]) =>
      item({
        id: `lab-day:${day}`,
        kind: "labDay",
        start: day,
        end: null,
        open: false,
        label: names.slice(0, LAB_DAY_NAMES).join(", "),
        sub: String(names.length),
        href: "/labs",
      }),
    ),
    standing: [],
  };
}

async function documentsLane(frame: LaneFrame): Promise<LaneRead> {
  const rows = await prisma.inboundDocument.findMany({
    where: {
      userId: frame.userId,
      deletedAt: null,
      OR: [{ reportDate: { not: null } }, { documentDate: { not: null } }],
    },
    select: {
      id: true,
      kind: true,
      title: true,
      filename: true,
      reportDate: true,
      documentDate: true,
    },
  });
  return {
    items: rows.flatMap((r) => {
      const date = r.reportDate ?? r.documentDate;
      if (!date) return [];
      return [
        item({
          id: r.id,
          kind: "document",
          start: dateOnlyKey(date),
          end: null,
          open: false,
          label: r.title ?? r.filename ?? "",
          sub: r.kind,
          href: `/documents?doc=${r.id}`,
        }),
      ];
    }),
    standing: [],
  };
}

async function cycleLane(frame: LaneFrame): Promise<LaneRead> {
  const rows = await prisma.menstrualCycle.findMany({
    where: {
      userId: frame.userId,
      deletedAt: null,
      isPredicted: false,
      absorbedIntoId: null,
    },
    select: { id: true, startDate: true, endDate: true },
    orderBy: { startDate: "asc" },
  });
  return {
    items: rows.map((r) =>
      item({
        id: r.id,
        kind: "cycle",
        start: r.startDate,
        end: r.endDate,
        open: r.endDate === null,
        label: "cycle",
        href: "/cycle",
      }),
    ),
    standing: [],
  };
}

export const LANE_READERS: Readonly<
  Record<TimelineLaneKey, (frame: LaneFrame) => Promise<LaneRead>>
> = Object.freeze({
  life: lifeLane,
  illness: illnessLane,
  allergies: allergiesLane,
  medications: medicationsLane,
  vaccinations: vaccinationsLane,
  visits: visitsLane,
  labs: labsLane,
  documents: documentsLane,
  cycle: cycleLane,
});
