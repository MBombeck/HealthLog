import { z } from "zod/v4";
import { RECOVERY_EMPTY_REASONS } from "@/lib/insights/recovery-empty";

/** Why the recovery page is empty; shared by both slim-slice schemas. */
export const recoveryEmptySchema = z
  .enum(RECOVERY_EMPTY_REASONS)
  .nullable()
  .describe(
    "Why the recovery page has nothing to chart, resolved on the server; null when any recovery type (ANS_CHARGE, DAY_STRAIN, WORKOUT_STRAIN, CARDIO_LOAD, BODY_BATTERY, STRESS_LEVEL, TRAINING_READINESS, ACUTE_TRAINING_LOAD, AVERAGE_HEART_RATE, MAX_HEART_RATE, ENERGY_EXPENDITURE_KJ, RESILIENCE) has a reading. `oura_permission`: Oura is connected and its grant leaves out the scope the resilience level needs, one reconnect fixes it. `oura_no_resilience`: Oura is connected and no level has arrived yet. `general`: anyone else. Clients render the empty note from this value and never work it out from the connection status.",
  );
