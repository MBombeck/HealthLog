/**
 * #1430 — the saved leaflet link in the wizard: hydrated from the stored
 * value, sent on create only when typed, on edit only when changed (a blank
 * value then clears it), and the last step held while it is not an `https:`
 * address.
 */
import { describe, expect, it } from "vitest";

import {
  buildCreateBody,
  emptyWizardPayload,
  hydrateWizardPayload,
} from "@/components/medications/wizard/wizard-payload";
import { stepBlocker } from "@/components/medications/wizard/wizard-step-gate";

const LINK = "https://cima.aemps.es/cima/pdfs/es/p/12345/P_12345.pdf";

function hydrate(leafletUrl?: string | null) {
  return hydrateWizardPayload({
    id: "m1",
    name: "Ramipril",
    dose: "5 mg",
    category: "BLOOD_PRESSURE",
    treatmentClass: "GENERIC",
    notificationsEnabled: true,
    startsOn: null,
    endsOn: null,
    oneShot: false,
    ...(leafletUrl !== undefined && { leafletUrl }),
    schedules: [
      {
        windowStart: "07:00",
        windowEnd: "08:00",
        timesOfDay: ["07:00"],
        rrule: "FREQ=DAILY",
      },
    ],
  });
}

describe("the leaflet link in the wizard", () => {
  it("starts empty and sends nothing for a blank link on create", () => {
    const payload = emptyWizardPayload();
    expect(payload.leafletUrl).toBe("");
    expect(
      "leafletUrl" in buildCreateBody({ ...payload, leafletUrl: "  " }),
    ).toBe(false);
  });

  it("sends a typed link on create, trimmed", () => {
    const body = buildCreateBody(
      { ...hydrate(), leafletUrl: `  ${LINK} ` },
      "create",
    );
    expect(body.leafletUrl).toBe(LINK);
  });

  it("hydrates the stored link and leaves it alone on an unrelated edit", () => {
    const payload = hydrate(LINK);
    expect(payload.leafletUrl).toBe(LINK);
    expect(
      "leafletUrl" in buildCreateBody({ ...payload, name: "Renamed" }, "edit"),
    ).toBe(false);
    expect("leafletUrl" in buildCreateBody(hydrate(), "edit")).toBe(false);
  });

  it("sends a changed link on edit, and a blank one to clear it", () => {
    const other = "https://example.org/leaflet.pdf";
    expect(
      buildCreateBody({ ...hydrate(LINK), leafletUrl: other }, "edit")
        .leafletUrl,
    ).toBe(other);
    expect(
      buildCreateBody({ ...hydrate(LINK), leafletUrl: "" }, "edit").leafletUrl,
    ).toBe("");
  });

  it("holds the last step on a link that is not https", () => {
    const payload = hydrate();
    expect(stepBlocker({ ...payload, leafletUrl: "" }, 8)).toBeNull();
    expect(stepBlocker({ ...payload, leafletUrl: LINK }, 8)).toBeNull();
    expect(
      stepBlocker({ ...payload, leafletUrl: "javascript:alert(1)" }, 8),
    ).toBe("medications.wizard.blocked.leafletUrl");
    expect(stepBlocker({ ...payload, leafletUrl: "http://x.org" }, 8)).toBe(
      "medications.wizard.blocked.leafletUrl",
    );
  });
});
