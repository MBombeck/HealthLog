/**
 * Logging several symptoms at once, in a real browser.
 *
 *   - Picking two symptoms gives each its own intensity slider, named after
 *     it; Save writes one occurrence per symptom through the ordinary create
 *     route, with the same time and note on both.
 *   - When the second create is refused, the first stays saved and only the
 *     unsaved symptom stays picked, so Save again writes it alone and never
 *     writes the first twice.
 *   - Nothing picked: Save asks for a symptom and writes nothing.
 *   - Thirty symptoms on a 390 px phone: the row wraps without a sideways
 *     scroll, and the filter narrows it by name while a picked symptom stays.
 *
 * Mutation checks (each run, each seen red):
 *   - post only the first picked symptom → "writes one occurrence per picked
 *     symptom" goes red;
 *   - keep every pick after a partial failure → "keeps only the unsaved
 *     symptom" goes red (the retry posts Headache again);
 *   - render every chip instead of the filtered ones → "narrows thirty
 *     symptoms by name" goes red.
 *
 * All data invented.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  stubFetch,
  type FetchStub,
} from "../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../tests/browser/render";
import { SymptomEntryForm } from "../symptom-entry-form";

function definition(id: string, label: string, icon: string) {
  return {
    id,
    label,
    icon,
    sortOrder: 0,
    isActive: true,
    code: null,
    recent: { count30d: 0, maxIntensity30d: null, lastOccurredAt: null },
  };
}

let api: FetchStub;

beforeEach(() => {
  api = stubFetch()
    .on("GET", "/api/symptoms/definitions", {
      data: {
        limit: 30,
        definitions: [
          definition("sd-headache", "Headache", "Brain"),
          definition("sd-nausea", "Nausea", "Frown"),
          definition("sd-dizzy", "Dizziness", "Zap"),
        ],
      },
    })
    .on("GET", /^\/api\/illness\/episodes/, { data: [] });
});

async function pickAndRate(
  screen: Awaited<ReturnType<typeof renderWithApp>>["screen"],
) {
  await screen.getByRole("checkbox", { name: "Headache" }).click();
  await screen.getByRole("checkbox", { name: "Nausea" }).click();

  const headache = screen.getByRole("slider", {
    name: "Intensity: Headache",
  });
  const nausea = screen.getByRole("slider", { name: "Intensity: Nausea" });
  await expect.element(headache).toBeVisible();
  await expect.element(nausea).toBeVisible();

  // From the parked low end: three steps up, then five.
  await headache.click();
  for (let i = 0; i < 3; i += 1) await userEvent.keyboard("{ArrowRight}");
  await nausea.click();
  for (let i = 0; i < 5; i += 1) await userEvent.keyboard("{ArrowRight}");
  await screen.getByLabelText(/Note/).fill("Came on together");
}

describe("<SymptomEntryForm> with several symptoms", () => {
  it("writes one occurrence per picked symptom, sharing time and note", async () => {
    api.on("POST", "/api/symptoms/events", (request) => ({
      status: 201,
      data: {
        id: `ev-${(request.body as { definitionId: string }).definitionId}`,
      },
    }));
    const { screen } = await renderWithApp(<SymptomEntryForm />);

    await pickAndRate(screen);
    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .poll(() => api.calls("POST", "/api/symptoms/events").length)
      .toBe(2);
    const bodies = api.calls("POST", "/api/symptoms/events").map(
      (r) =>
        r.body as {
          definitionId: string;
          intensity: number;
          occurredAt: string;
          note?: string;
        },
    );
    expect(bodies.map((b) => [b.definitionId, b.intensity])).toEqual([
      ["sd-headache", 3],
      ["sd-nausea", 5],
    ]);
    expect(bodies[0].occurredAt).toBe(bodies[1].occurredAt);
    expect(bodies.every((b) => b.note === "Came on together")).toBe(true);
    // Each create under its own key, so neither replays the other.
    const keys = api
      .calls("POST", "/api/symptoms/events")
      .map((r) => r.headers.get("Idempotency-Key"));
    expect(new Set(keys).size).toBe(2);
  });

  it("keeps only the unsaved symptom when the second create is refused", async () => {
    let attempt = 0;
    api.on("POST", "/api/symptoms/events", (request) => {
      const { definitionId } = request.body as { definitionId: string };
      attempt += 1;
      if (definitionId === "sd-nausea" && attempt === 2) {
        return { status: 422, error: "Validation failed" };
      }
      return { status: 201, data: { id: `ev-${definitionId}-${attempt}` } };
    });
    const { screen } = await renderWithApp(<SymptomEntryForm />);

    await pickAndRate(screen);
    await screen.getByRole("button", { name: "Save" }).click();

    await expect.element(screen.getByText(/1 of 2 saved/)).toBeVisible();
    await expect
      .element(screen.getByRole("checkbox", { name: "Headache" }))
      .toHaveAttribute("aria-checked", "false");
    await expect
      .element(screen.getByRole("checkbox", { name: "Nausea" }))
      .toHaveAttribute("aria-checked", "true");

    await screen.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(() => api.calls("POST", "/api/symptoms/events").length)
      .toBe(3);
    const retried = api.calls("POST", "/api/symptoms/events")[2].body as {
      definitionId: string;
      intensity: number;
    };
    expect(retried).toMatchObject({ definitionId: "sd-nausea", intensity: 5 });
  });

  it("asks for a symptom and writes nothing when none is picked", async () => {
    const { screen } = await renderWithApp(<SymptomEntryForm />);
    await expect
      .element(screen.getByRole("checkbox", { name: "Headache" }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Save" }).click();
    await expect.element(screen.getByText("Choose a symptom.")).toBeVisible();
    expect(api.calls("POST", "/api/symptoms/events")).toHaveLength(0);
  });

  describe("with thirty symptoms on a phone", () => {
    beforeEach(async () => {
      await page.viewport(390, 844);
      api.on("GET", "/api/symptoms/definitions", {
        data: {
          limit: 30,
          definitions: Array.from({ length: 30 }, (_, i) =>
            definition(
              `sd-${i}`,
              i === 7 ? "Brain fog" : `Symptom number ${i}`,
              "Tag",
            ),
          ),
        },
      });
    });
    afterEach(async () => {
      await page.viewport(1280, 900);
    });

    it("narrows thirty symptoms by name, keeping a picked one", async () => {
      const { screen } = await renderWithApp(<SymptomEntryForm />);
      await expect
        .element(screen.getByRole("checkbox", { name: "Symptom number 29" }))
        .toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      // At the cap: nothing to add, and the hint says why.
      expect(
        document.querySelector('[data-testid="symptom-add-chip"]'),
      ).toBeNull();

      await screen.getByRole("checkbox", { name: "Symptom number 3" }).click();
      await screen
        .getByRole("searchbox", { name: "Find a symptom" })
        .fill("fog");
      await expect
        .element(screen.getByRole("checkbox", { name: "Brain fog" }))
        .toBeVisible();
      await expect
        .poll(
          () =>
            document.querySelectorAll('[data-testid="symptom-chip"]').length,
        )
        .toBe(2);
      await expect
        .element(screen.getByRole("checkbox", { name: "Symptom number 3" }))
        .toHaveAttribute("aria-checked", "true");
    });
  });
});
