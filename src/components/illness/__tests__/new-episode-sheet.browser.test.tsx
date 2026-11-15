/**
 * Real-browser integration tests for the illness episode save lifecycle.
 *
 * Exercises `<NewEpisodeSheet>` in a real Chromium browser with TanStack Query
 * and the application providers, stubbing network traffic at the fetch boundary:
 *   1. Edit hydration across timezones (Asia/Tokyo onset dates).
 *   2. Disabling save button while POST is in-flight.
 *   3. Updating an episode via PATCH with preserved stored timestamps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { storeDateFormat } from "@/lib/date-format";
import { storeTimezone } from "@/lib/timezone-mirror";
import { pinDate } from "../../../../tests/browser/clock";
import {
  stubFetch,
  type FetchStub,
} from "../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../tests/browser/render";
import { NewEpisodeSheet } from "../new-episode-sheet";
import type { IllnessEpisodeDTO } from "../types";

let api: FetchStub;

beforeEach(() => {
  storeTimezone("");
  storeDateFormat("AUTO");
  api = stubFetch()
    .on("GET", "/api/illness/episodes", { data: [] })
    .on("GET", "/api/body-sites", { data: { sites: [] } });
});

afterEach(() => {
  storeTimezone("");
  storeDateFormat("AUTO");
  vi.useRealTimers();
});

function assertAllowedRequests(allowed: string[]) {
  const actual = api.requests.map((r) => `${r.method} ${r.path.split("?")[0]}`);
  for (const entry of actual) {
    expect(allowed).toContain(entry);
  }
}

describe("<NewEpisodeSheet> save lifecycle in browser", () => {
  it("hydrates edit onset into the mirror's timezone and renders according to date format", async () => {
    const timezone = "Asia/Tokyo";
    const dateFormat = "MDY" as const;
    const onsetAt = "2026-11-09T20:00:00.000Z";
    const expectedMirrorDate = "2026-11-10";
    const expectedVisibleDate = "11/10/2026";

    storeTimezone(timezone);
    storeDateFormat(dateFormat);

    const editEpisode: IllnessEpisodeDTO = {
      id: "ep-tz-1",
      label: "Seasonal Allergy",
      type: "ALLERGY",
      lifecycle: "ACUTE",
      onsetAt,
      resolvedAt: null,
      parentConditionId: null,
      note: null,
      bodySite: null,
      laterality: null,
      createdAt: onsetAt,
      updatedAt: onsetAt,
    };

    const { screen } = await renderWithApp(
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={editEpisode}
      />,
      { user: { timezone, dateFormat } },
    );

    const dialog = screen.getByRole("dialog");
    await expect.element(dialog).toBeVisible();

    const selector =
      'div:has(> label[for="illness-onset"]) [data-slot="date-field"] input[type="text"]';
    await expect
      .poll(() => document.querySelector<HTMLInputElement>(selector))
      .not.toBeNull();
    const dateInputElement = document.querySelector<HTMLInputElement>(selector);
    if (!dateInputElement) {
      throw new Error("Visible onset DateField input not found");
    }
    const visibleOnsetInput = page.elementLocator(dateInputElement);
    await expect.element(visibleOnsetInput).toBeVisible();
    await expect.element(visibleOnsetInput).toHaveValue(expectedVisibleDate);

    await expect
      .poll(
        () =>
          document.querySelector<HTMLInputElement>("input#illness-onset")
            ?.value,
      )
      .toBe(expectedMirrorDate);

    assertAllowedRequests(["GET /api/illness/episodes", "GET /api/body-sites"]);
  });

  it("saves today's episode before noon and disables save button while POST is in-flight", async () => {
    const timezone = "Europe/Berlin";
    const pinnedNow = "2026-11-10T08:30:00.000Z";
    const localNoon = "2026-11-10T11:00:00.000Z";

    storeTimezone(timezone);
    pinDate(pinnedNow);

    const post = api.deferred("POST", "/api/illness/episodes");
    const onOpenChange = vi.fn();

    const { screen } = await renderWithApp(
      <NewEpisodeSheet
        open={true}
        onOpenChange={onOpenChange}
        today="2026-11-10"
      />,
      { user: { timezone } },
    );

    const nameInput = screen.getByLabelText("Name");
    await nameInput.fill("Migraine");

    const saveButton = screen.getByRole("button", { name: "Save" });
    await expect.element(saveButton).toBeEnabled();

    // Clearing onset disables the save button; restoring onset re-enables save
    const onsetSelector =
      'div:has(> label[for="illness-onset"]) [data-slot="date-field"] input[type="text"]';
    await expect
      .poll(() => document.querySelector<HTMLInputElement>(onsetSelector))
      .not.toBeNull();
    const onsetInputElement =
      document.querySelector<HTMLInputElement>(onsetSelector);
    if (!onsetInputElement) {
      throw new Error("Visible onset DateField input not found");
    }
    const visibleOnsetInput = page.elementLocator(onsetInputElement);
    await visibleOnsetInput.fill("");
    onsetInputElement.blur();
    await expect.element(saveButton).toBeDisabled();

    await visibleOnsetInput.fill("2026-11-10");
    onsetInputElement.blur();
    await expect.element(saveButton).toBeEnabled();

    await saveButton.click();

    // While deferred, save button enters pending/disabled state
    await expect.element(saveButton).toBeDisabled();

    // Verify exactly one POST was dispatched
    await expect
      .poll(() => api.calls("POST", "/api/illness/episodes").length)
      .toBe(1);

    // Release the deferred POST
    post.release({
      status: 201,
      data: {
        id: "ep-created-1",
        label: "Migraine",
        type: "INFECTION",
        lifecycle: "ACUTE",
        onsetAt: pinnedNow,
        resolvedAt: null,
        parentConditionId: null,
        note: null,
        bodySite: null,
        laterality: null,
        createdAt: pinnedNow,
        updatedAt: pinnedNow,
      },
    });

    // Sheet requests closure after successful save
    await expect.poll(() => onOpenChange.mock.calls.length).toBe(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // Request count remains strictly 1 and matches the payload
    expect(api.calls("POST", "/api/illness/episodes")).toHaveLength(1);
    const [createCall] = api.calls("POST", "/api/illness/episodes");
    expect(createCall.body).toMatchObject({
      label: "Migraine",
      type: "INFECTION",
      lifecycle: "ACUTE",
      parentConditionId: null,
      note: null,
      bodySite: null,
      laterality: null,
    });
    expect(createCall.body).toMatchObject({ onsetAt: pinnedNow });
    expect(createCall.body).not.toMatchObject({ onsetAt: localNoon });

    assertAllowedRequests([
      "GET /api/illness/episodes",
      "GET /api/body-sites",
      "POST /api/illness/episodes",
    ]);
  });

  it("submits updated episode via PATCH and preserves stored timestamp when onset date is unchanged", async () => {
    const episode: IllnessEpisodeDTO = {
      id: "ep-edit-1",
      label: "Original label",
      type: "OTHER",
      lifecycle: "ACUTE",
      onsetAt: "2026-11-05T12:00:00.000Z",
      resolvedAt: null,
      parentConditionId: null,
      note: null,
      bodySite: null,
      laterality: null,
      createdAt: "2026-11-05T12:00:00.000Z",
      updatedAt: "2026-11-05T12:00:00.000Z",
    };
    const patch = api.deferred("PATCH", `/api/illness/episodes/${episode.id}`);
    const onOpenChange = vi.fn();

    const { screen } = await renderWithApp(
      <NewEpisodeSheet
        open={true}
        onOpenChange={onOpenChange}
        today="2026-11-10"
        editEpisode={episode}
      />,
    );

    const nameInput = screen.getByLabelText("Name");
    await nameInput.fill("Updated label");

    const saveButton = screen.getByRole("button", { name: "Save" });
    await saveButton.click();

    await expect.element(saveButton).toBeDisabled();

    patch.release({
      status: 200,
      data: {
        ...episode,
        label: "Updated label",
      },
    });

    await expect.poll(() => onOpenChange.mock.calls.length).toBe(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    expect(
      api.calls("PATCH", `/api/illness/episodes/${episode.id}`),
    ).toHaveLength(1);
    const [patchCall] = api.calls(
      "PATCH",
      `/api/illness/episodes/${episode.id}`,
    );
    expect(patchCall.body).toMatchObject({
      label: "Updated label",
      onsetAt: episode.onsetAt,
    });

    assertAllowedRequests([
      "GET /api/illness/episodes",
      "GET /api/body-sites",
      `PATCH /api/illness/episodes/${episode.id}`,
    ]);
  });
});
