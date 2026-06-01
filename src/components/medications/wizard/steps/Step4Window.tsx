"use client";

import { CourseWindowRow } from "@/components/medications/scheduling/CourseWindowRow";

import type { StepProps } from "./Step1Name";

/**
 * Step 4 — Behandlungszeitraum (course window).
 *
 * On the one-shot path (Step 5 set `mode = "oneShot"`) the endsOn
 * stays pinned to the startsOn via `lockEndsToStart`. Before Step 5
 * runs, the mode is still `null` so the unlocked form renders by
 * default — this matches the wizard's "you can change anything later"
 * stance.
 */
export function Step4Window({ payload, applyPartial }: StepProps) {
  const isOneShot = payload.mode === "oneShot";
  return (
    <div data-slot="wizard-step4">
      <CourseWindowRow
        startsOn={payload.startsOn}
        endsOn={payload.endsOn}
        lockEndsToStart={isOneShot}
        onChange={({ startsOn, endsOn }) =>
          applyPartial({ startsOn, endsOn })
        }
      />
    </div>
  );
}
