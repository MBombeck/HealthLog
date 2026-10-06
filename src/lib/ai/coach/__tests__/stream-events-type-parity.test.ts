/**
 * The Zod mirror of the Coach wire (`stream-events.ts`) and the TypeScript
 * contract (`types.ts`) describe the same shapes.
 *
 * The checks are compile-time: `expectTypeOf(...).toEqualTypeOf<...>()`
 * fails `pnpm typecheck` when a field is added, dropped, renamed or retyped
 * on one side only. Equality is exact in both directions, so a field that
 * is optional on one side and required on the other fails as well.
 *
 * Checked by breaking it: removing `resultRef` from `coachStepSchema`, and
 * making `CoachFollowUp.reuse` optional in `types.ts`, each fail the
 * typecheck on the matching line below.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod/v4";

import type {
  CoachActivity,
  CoachActivityMeta,
  CoachAssumption,
  CoachClarification,
  CoachFollowUp,
  CoachMemoryNote,
  CoachMemoryNoteMeta,
  CoachPlanProposal,
  CoachPlanProposalMeta,
  CoachMethod,
  CoachProvenance,
  CoachResultEntry,
  CoachResultMeta,
  CoachResultTable,
  CoachStep,
  CoachStop,
  CoachStreamEvent,
  CoachTrail,
} from "@/lib/ai/coach/types";
import {
  coachActivityMetaSchema,
  coachActivitySchema,
  coachAssumptionSchema,
  coachClarificationSchema,
  coachFollowUpSchema,
  coachMemoryNoteMetaSchema,
  coachMemoryNoteSchema,
  coachPlanProposalMetaSchema,
  coachPlanProposalSchema,
  coachMethodSchema,
  coachProvenanceSchema,
  coachResultEntrySchema,
  coachResultMetaSchema,
  coachResultTableSchema,
  coachStepSchema,
  coachStopSchema,
  coachStreamEventSchema,
  coachTrailSchema,
} from "@/lib/ai/coach/stream-events";

describe("Coach wire: Zod mirror equals the TypeScript contract", () => {
  it("every frame", () => {
    expectTypeOf<
      z.infer<typeof coachStreamEventSchema>
    >().toEqualTypeOf<CoachStreamEvent>();
  });

  it("each component the OpenAPI document names", () => {
    expectTypeOf<z.infer<typeof coachStepSchema>>().toEqualTypeOf<CoachStep>();
    expectTypeOf<
      z.infer<typeof coachResultMetaSchema>
    >().toEqualTypeOf<CoachResultMeta>();
    expectTypeOf<
      z.infer<typeof coachResultTableSchema>
    >().toEqualTypeOf<CoachResultTable>();
    expectTypeOf<
      z.infer<typeof coachResultEntrySchema>
    >().toEqualTypeOf<CoachResultEntry>();
    expectTypeOf<
      z.infer<typeof coachMethodSchema>
    >().toEqualTypeOf<CoachMethod>();
    expectTypeOf<
      z.infer<typeof coachFollowUpSchema>
    >().toEqualTypeOf<CoachFollowUp>();
    expectTypeOf<
      z.infer<typeof coachClarificationSchema>
    >().toEqualTypeOf<CoachClarification>();
    expectTypeOf<
      z.infer<typeof coachProvenanceSchema>
    >().toEqualTypeOf<CoachProvenance>();
  });

  it("the v1.41 trail, memory and plan shapes", () => {
    expectTypeOf<
      z.infer<typeof coachActivitySchema>
    >().toEqualTypeOf<CoachActivity>();
    expectTypeOf<
      z.infer<typeof coachActivityMetaSchema>
    >().toEqualTypeOf<CoachActivityMeta>();
    expectTypeOf<z.infer<typeof coachStopSchema>>().toEqualTypeOf<CoachStop>();
    expectTypeOf<
      z.infer<typeof coachAssumptionSchema>
    >().toEqualTypeOf<CoachAssumption>();
    expectTypeOf<
      z.infer<typeof coachMemoryNoteSchema>
    >().toEqualTypeOf<CoachMemoryNote>();
    expectTypeOf<
      z.infer<typeof coachMemoryNoteMetaSchema>
    >().toEqualTypeOf<CoachMemoryNoteMeta>();
    expectTypeOf<
      z.infer<typeof coachPlanProposalSchema>
    >().toEqualTypeOf<CoachPlanProposal>();
    expectTypeOf<
      z.infer<typeof coachPlanProposalMetaSchema>
    >().toEqualTypeOf<CoachPlanProposalMeta>();
    expectTypeOf<
      z.infer<typeof coachTrailSchema>
    >().toEqualTypeOf<CoachTrail>();
  });
});
