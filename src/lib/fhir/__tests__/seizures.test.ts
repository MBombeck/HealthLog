import { describe, expect, it } from "vitest";

import type { DoctorReportData } from "@/lib/doctor-report-data";
import { seizureResourcesFromReportData } from "@/lib/fhir/resources/seizures";
import type { SeizureReportSection } from "@/lib/seizures/report-types";

function event(
  overrides: Partial<SeizureReportSection["events"][number]> = {},
): SeizureReportSection["events"][number] {
  return {
    id: "e1",
    onsetAt: "2026-03-01T08:00:00.000Z",
    onsetUnknown: false,
    typeId: "t1",
    ilaeType: "FOCAL_TO_BILATERAL_TC",
    count: 1,
    suspected: false,
    durationSec: 360,
    estimated: false,
    sleepState: "ASLEEP",
    rescue: true,
    injury: true,
    note: null,
    observableManifestations: "YES",
    incontinence: false,
    responsiveness: "IMPAIRED",
    recall: null,
    postictal: ["WEAKNESS_TODD"],
    injuries: ["TONGUE_BITE"],
    triggers: ["FEVER", "NONE_IDENTIFIED"],
    emergency: "ED_VISIT",
    witnessed: true,
    witnessRole: "PARENT",
    loggedByDelegate: true,
    rescueDoses: [
      {
        medicationId: "m1",
        medicationName: "Midazolam",
        doseAmount: 10,
        doseUnit: "mg",
        route: "BUCCAL",
        givenAt: "2026-03-01T08:06:00.000Z",
        givenBy: "PARENT",
        effect: "STOPPED",
      },
    ],
    ...overrides,
  };
}

function data(events: SeizureReportSection["events"]): DoctorReportData {
  return {
    period: {
      days: 90,
      since: "2026-01-01T00:00:00.000Z",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-03-31T23:59:59.000Z",
    },
    seizureDiary: {
      rule: { count: 2, windowHours: 24 },
      niceRule: { count: 3, windowHours: 24 },
      types: [],
      summary: {
        seizures: 1,
        suspected: 0,
        seizureDays: 1,
        seizureFreeDays: 89,
        per28Days: 0.3,
        longestFreeDays: 59,
        daysSinceLast: 30,
        convulsive: 1,
        fromSleep: 1,
        clusterEpisodes: 1,
        niceClusterEpisodes: 0,
        rescueDoses: 1,
        emsCalled: 0,
        edVisits: 1,
        admissions: 0,
      },
      months: [],
      monthly: [],
      monthlyTotal: { typeId: null, counts: [], days: [], total: 0 },
      markers: [],
      durations: [],
      rescue: [],
      triggers: [],
      overlays: { missedDose: null, cycle: null, sleep: null, illness: null },
      events,
      clusters: [
        {
          startAt: "2026-03-01T08:00:00.000Z",
          endAt: "2026-03-01T20:00:00.000Z",
          seizureCount: 2,
          eventIds: ["e1", "e2"],
        },
      ],
      trailingYearPerDay: [1, 1],
    },
  } as unknown as DoctorReportData;
}

describe("seizureResourcesFromReportData", () => {
  it("emits nothing without a diary section", () => {
    const empty = seizureResourcesFromReportData({
      period: { start: "", end: "" },
    } as unknown as DoctorReportData);
    expect(empty.observations).toEqual([]);
    expect(empty.administrations).toEqual([]);
  });

  it("maps a seizure to an Observation coded 313307000 with the SNOMED type as value", () => {
    const { observations } = seizureResourcesFromReportData(
      data([event(), event({ id: "e2", onsetAt: "2026-03-01T20:00:00.000Z" })]),
    );
    const obs = observations.find((o) => o.id === "seizure-1")!;
    expect(obs.status).toBe("final");
    expect(obs.code.coding?.[0]).toEqual(
      expect.objectContaining({ code: "313307000" }),
    );
    expect(obs.valueCodeableConcept?.coding?.[0].code).toBe("246544003");
    expect(obs.effectivePeriod).toEqual({
      start: "2026-03-01T08:00:00.000Z",
      end: "2026-03-01T08:06:00.000Z",
    });
    // Recorded by a carer: no Patient performer is claimed.
    expect(obs.performer).toBeUndefined();
    // Post-ictal Todd's paresis is coded; "none identified" is not a trigger.
    const codes = (obs.component ?? []).flatMap((c) => [
      ...(c.code.coding ?? []).map((x) => x.code),
      ...(c.valueCodeableConcept?.coding ?? []).map((x) => x.code),
    ]);
    expect(codes).toContain("31758001");
    expect(codes).toContain("66264000");
    const triggers = (obs.component ?? []).filter((c) =>
      c.code.text?.startsWith("Suspected trigger"),
    );
    expect(triggers).toHaveLength(1);
    // A duration over t1 is a note, never a status epilepticus code.
    expect(JSON.stringify(obs)).not.toContain("230456007");
    expect(obs.note?.some((n) => n.text.includes("t1"))).toBe(true);
  });

  it("marks a suspected seizure preliminary and codes it as a seizure finding", () => {
    const { observations } = seizureResourcesFromReportData(
      data([event({ suspected: true, ilaeType: null, durationSec: null })]),
    );
    const obs = observations.find((o) => o.id === "seizure-1")!;
    expect(obs.status).toBe("preliminary");
    expect(obs.code.coding?.[0].code).toBe("91175000");
    expect(obs.effectiveDateTime).toBe("2026-03-01T08:00:00.000Z");
    expect(obs.valueCodeableConcept).toBeUndefined();
  });

  it("carries a tally's count in the extension", () => {
    const { observations } = seizureResourcesFromReportData(
      data([event({ count: 6 })]),
    );
    expect(observations[0].extension?.[0].valueInteger).toBe(6);
  });

  it("emits the rescue dose as a MedicationAdministration for the seizure", () => {
    const { administrations } = seizureResourcesFromReportData(data([event()]));
    expect(administrations).toHaveLength(1);
    expect(administrations[0]).toEqual(
      expect.objectContaining({
        status: "completed",
        effectiveDateTime: "2026-03-01T08:06:00.000Z",
        reasonReference: [{ reference: "Observation/seizure-1" }],
      }),
    );
    expect(administrations[0].dosage?.route?.coding?.[0].code).toBe("54471007");
    expect(administrations[0].dosage?.dose?.value).toBe(10);
  });

  it("links an emergency department visit as an Encounter", () => {
    const { encounters, observations } = seizureResourcesFromReportData(
      data([event()]),
    );
    expect(encounters[0].class.code).toBe("EMER");
    expect(observations[0].encounter?.reference).toBe(
      `Encounter/${encounters[0].id}`,
    );
  });

  it("emits the cluster with its members and the three LOINC summaries", () => {
    const { observations } = seizureResourcesFromReportData(
      data([event(), event({ id: "e2", onsetAt: "2026-03-01T20:00:00.000Z" })]),
    );
    const cluster = observations.find((o) => o.id === "seizure-cluster-1")!;
    expect(cluster.code.text).toContain("2 or more in 24 h");
    expect(cluster.hasMember).toHaveLength(2);
    const loinc = observations
      .flatMap((o) => o.code.coding ?? [])
      .filter((c) => c.system === "http://loinc.org")
      .map((c) => c.code);
    expect(loinc).toEqual(
      expect.arrayContaining(["99312-1", "99313-9", "99311-3"]),
    );
    const types = observations.find((o) => o.id === "seizure-types")!;
    expect(types.component?.[0].valueCodeableConcept?.coding?.[0].code).toBe(
      "LA32843-7",
    );
    const since = observations.find((o) => o.id === "seizure-time-since-last")!;
    expect(since.valueCodeableConcept?.coding?.[0].code).toBe("LA32862-7");
  });
});
