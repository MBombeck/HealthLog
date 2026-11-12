/**
 * The day view and the timeline read every record table, and the day query
 * stays fresh for five minutes because every record write evicts its root.
 * A write whose invalidation leaves the two roots out keeps an open day and
 * the timeline on their pre-write answer: "Capture for this day" saved a
 * symptom or a workout and the day showed the old list.
 */
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { invalidateSymptomReads } from "@/components/symptoms/use-symptoms";
import {
  allergyDependentKeys,
  invalidateKeys,
  cycleDependentKeys,
  documentDependentKeys,
  encounterDependentKeys,
  illnessDependentKeys,
  labDependentKeys,
  measurementDependentKeys,
  medicationDependentKeys,
  moodDependentKeys,
  queryKeys,
  vaccinationDependentKeys,
  workoutDependentKeys,
} from "@/lib/query-keys";

const RECORD_BUNDLES = {
  allergy: allergyDependentKeys,
  cycle: cycleDependentKeys,
  document: documentDependentKeys,
  encounter: encounterDependentKeys,
  illness: illnessDependentKeys,
  lab: labDependentKeys,
  measurement: measurementDependentKeys,
  medication: medicationDependentKeys,
  mood: moodDependentKeys,
  vaccination: vaccinationDependentKeys,
  workout: workoutDependentKeys,
};

describe("record writes reach the day view and the timeline", () => {
  it.each(Object.entries(RECORD_BUNDLES))(
    "a %s write evicts the day and timeline roots",
    (_name, bundle) => {
      expect(bundle).toContainEqual(queryKeys.dayRoot());
      expect(bundle).toContainEqual(queryKeys.timelineRoot());
    },
  );

  it("a workout write marks the Insights presence read stale", async () => {
    // The Workouts pill appears with the first workout and goes with the
    // last; the presence read otherwise stays fresh for five minutes.
    const client = new QueryClient();
    client.setQueryData(queryKeys.insightsPresence(), { hasWorkouts: false });

    await invalidateKeys(client, workoutDependentKeys);

    expect(
      client.getQueryState(queryKeys.insightsPresence())?.isInvalidated,
    ).toBe(true);
    client.clear();
  });

  it("a symptom write marks an open day and the timeline stale", async () => {
    const client = new QueryClient();
    const day = queryKeys.day("2026-11-10");
    const lanes = queryKeys.timeline("week", null, null, "");
    client.setQueryData(day, { sections: [] });
    client.setQueryData(lanes, { lanes: [] });

    await invalidateSymptomReads(client);

    expect(client.getQueryState(day)?.isInvalidated).toBe(true);
    expect(client.getQueryState(lanes)?.isInvalidated).toBe(true);
    client.clear();
  });
});
