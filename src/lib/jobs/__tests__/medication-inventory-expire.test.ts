/**
 * v1.4.25 W19b — module-shape contract for the
 * medication-inventory-expire job. The actual sweep logic lives in
 * `expireStaleInUseItems` (covered by
 * `src/lib/medications/inventory/__tests__/service.test.ts`); this
 * test pins the queue name + cron schedule so a typo in the worker
 * registration is caught at the unit-test level.
 */
import { describe, expect, it } from "vitest";

import {
  MEDICATION_INVENTORY_EXPIRE_QUEUE,
  MEDICATION_INVENTORY_EXPIRE_CRON,
} from "@/lib/jobs/medication-inventory-expire";

describe("medication-inventory-expire module", () => {
  it("exports the canonical queue name", () => {
    expect(MEDICATION_INVENTORY_EXPIRE_QUEUE).toBe("medication-inventory-expire");
  });

  it("schedules at 03:30 Europe/Berlin", () => {
    expect(MEDICATION_INVENTORY_EXPIRE_CRON).toBe("30 3 * * *");
  });
});
