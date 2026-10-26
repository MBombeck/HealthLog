/**
 * The measurement form offers only types whose module is on.
 *
 * The add menu's "Measurement" entry (and every other mount of the form)
 * listed sleep and glucose with those modules switched off, so a person could
 * file a reading into a domain whose pages, charts and reads are all hidden,
 * or be refused by the route. The form now filters its types through the
 * surface map's type ownership (`summary:<type>`), which the test below holds
 * equal to the measurement-scope ownership the server gates on. That the
 * mounted form neither opens on nor offers such a type is driven in
 * `measurement-form.browser.test.tsx`.
 */
import { describe, expect, it } from "vitest";

import type { MeasurementType } from "@/generated/prisma/client";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";
import { surfaceModule } from "@/lib/modules/surface";

import {
  MEASUREMENT_FORM_TYPE_VALUES,
  measurementFormTypes,
} from "../measurement-form";

describe("measurementFormTypes", () => {
  it("drops sleep and glucose while their modules are off", () => {
    const values = measurementFormTypes({ sleep: false, glucose: false }).map(
      (t) => t.value,
    );
    expect(values).not.toContain("SLEEP_DURATION");
    expect(values).not.toContain("BLOOD_GLUCOSE");
    expect(values).toContain("WEIGHT");
  });

  it("offers every type while the module map is unknown or all on", () => {
    expect(measurementFormTypes(undefined)).toHaveLength(
      MEASUREMENT_FORM_TYPE_VALUES.length,
    );
    expect(measurementFormTypes({ sleep: true, glucose: true })).toHaveLength(
      MEASUREMENT_FORM_TYPE_VALUES.length,
    );
  });

  it("reads the same ownership the server gates measurement types on", () => {
    let owned = 0;
    for (const type of MEASUREMENT_FORM_TYPE_VALUES) {
      const owner = moduleForMeasurementType(type as MeasurementType);
      if (owner) owned += 1;
      expect(surfaceModule(`summary:${type}`), type).toBe(owner ?? undefined);
    }
    expect(owned).toBeGreaterThan(0);
  });
});
