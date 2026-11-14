/**
 * Real-browser integration tests for the illness episode save lifecycle.
 *
 * Exercises `<NewEpisodeSheet>` in a real Chromium browser with TanStack Query
 * and the application providers, stubbing network traffic at the fetch boundary:
 *   1. Edit hydration across timezones (Asia/Tokyo and America/Los_Angeles onset dates).
 *   2. Rapid duplicate submission gating while creation is in-flight.
 *   3. Stale in-flight save rejection/resolution across sheet close & reopening the same edit episode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { useState } from "react";

import { storeDateFormat } from "@/lib/date-format";
import { storeTimezone } from "@/lib/timezone-mirror";
import {
  stubFetch,
  type FetchStub,
  type Responder,
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
});

function assertAllowedRequests(allowed: string[]) {
  const actual = api.requests.map((r) => `${r.method} ${r.path.split("?")[0]}`);
  for (const entry of actual) {
    expect(allowed).toContain(entry);
  }
}

function queuedPatch(labels: string[]): {
  respond: Responder;
  release: (index: number) => void;
} {
  const releases: Array<() => void> = [];
  return {
    respond: async (request) => {
      const index = labels.length;
      const label = (request.body as { label: string }).label;
      labels.push(label);
      await new Promise<void>((resolve) => {
        releases[index] = resolve;
      });
      return { data: null };
    },
    release: (index) => releases[index]?.(),
  };
}

function SheetHarness({
  editEpisode,
  today = "2026-11-10",
}: {
  editEpisode?: IllnessEpisodeDTO;
  today?: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen Sheet
      </button>
      <NewEpisodeSheet
        open={open}
        onOpenChange={setOpen}
        today={today}
        editEpisode={editEpisode}
      />
    </div>
  );
}

describe("<NewEpisodeSheet> save lifecycle in browser", () => {
  it.each([
    {
      timezone: "Asia/Tokyo",
      dateFormat: "MDY" as const,
      onsetAt: "2026-11-09T20:00:00.000Z",
      expectedMirrorDate: "2026-11-10",
      expectedVisibleDate: "11/10/2026",
    },
    {
      timezone: "America/Los_Angeles",
      dateFormat: "YMD" as const,
      onsetAt: "2026-11-10T03:00:00.000Z",
      expectedMirrorDate: "2026-11-09",
      expectedVisibleDate: "2026-11-09",
    },
  ])(
    "hydrates onset date to the user's calendar day in $timezone ($expectedMirrorDate)",
    async ({
      timezone,
      dateFormat,
      onsetAt,
      expectedMirrorDate,
      expectedVisibleDate,
    }) => {
      storeTimezone(timezone);
      storeDateFormat(dateFormat);

      // Asia/Tokyo (+09:00): 2026-11-09T20:00:00.000Z is 05:00 next day in Tokyo; Nov 9 in UTC.
      // America/Los_Angeles (-08:00): 2026-11-10T03:00:00.000Z is 19:00 previous day in LA; Nov 10 in UTC.
      const editEpisode: IllnessEpisodeDTO = {
        id: `ep-${timezone}`,
        label: "Headache",
        type: "OTHER",
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
      const dateInputElement =
        document.querySelector<HTMLInputElement>(selector);
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

      assertAllowedRequests([
        "GET /api/illness/episodes",
        "GET /api/body-sites",
      ]);
    },
  );

  it("preserves unchanged stored onset instant when profile timezone changes between opening and save", async () => {
    storeTimezone("Asia/Tokyo");
    storeDateFormat("YMD");

    // Asia/Tokyo (+09:00): 2026-11-09T20:00:00.000Z is 05:00 on 2026-11-10 in Tokyo; Nov 9 in UTC and LA.
    const editEpisode: IllnessEpisodeDTO = {
      id: "ep-tz-switch-1",
      label: "Migraine",
      type: "OTHER",
      lifecycle: "ACUTE",
      onsetAt: "2026-11-09T20:00:00.000Z",
      resolvedAt: null,
      parentConditionId: null,
      note: null,
      bodySite: null,
      laterality: null,
      createdAt: "2026-11-09T20:00:00.000Z",
      updatedAt: "2026-11-09T20:00:00.000Z",
    };

    api.on("PATCH", `/api/illness/episodes/${editEpisode.id}`, {
      data: editEpisode,
    });

    const { screen } = await renderWithApp(
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={editEpisode}
      />,
      { user: { timezone: "Asia/Tokyo", dateFormat: "YMD" } },
    );

    const dialog = screen.getByRole("dialog");
    await expect.element(dialog).toBeVisible();

    await expect
      .poll(
        () =>
          document.querySelector<HTMLInputElement>("input#illness-onset")
            ?.value,
      )
      .toBe("2026-11-10");

    // Live profile timezone changes to America/Los_Angeles while the sheet remains open
    storeTimezone("America/Los_Angeles");

    // Save with unchanged onset date
    const saveButton = screen.getByRole("button", { name: "Save" });
    await saveButton.click();

    await expect
      .poll(
        () =>
          api.calls("PATCH", `/api/illness/episodes/${editEpisode.id}`).length,
      )
      .toBe(1);

    const [patchCall] = api.calls(
      "PATCH",
      `/api/illness/episodes/${editEpisode.id}`,
    );
    expect(patchCall.body).toMatchObject({
      onsetAt: "2026-11-09T20:00:00.000Z",
    });

    assertAllowedRequests([
      "GET /api/illness/episodes",
      "GET /api/body-sites",
      `PATCH /api/illness/episodes/${editEpisode.id}`,
    ]);
  });

  it("prevents duplicate submission under rapid double activation while POST is deferred", async () => {
    const post = api.deferred("POST", "/api/illness/episodes");
    const onOpenChange = vi.fn();

    const { screen } = await renderWithApp(
      <NewEpisodeSheet
        open={true}
        onOpenChange={onOpenChange}
        today="2026-11-10"
      />,
    );

    const nameInput = screen.getByLabelText("Name");
    await nameInput.fill("Migraine");

    const saveButton = screen.getByRole("button", { name: "Save" });
    await expect.element(saveButton).toBeEnabled();

    // Rapid double activation on the real Save button while POST is deferred
    const saveEl = saveButton.element() as HTMLButtonElement;
    saveEl.click();
    saveEl.click();

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
        onsetAt: "2026-11-10T12:00:00.000Z",
        resolvedAt: null,
        parentConditionId: null,
        note: null,
        bodySite: null,
        laterality: null,
        createdAt: "2026-11-10T12:00:00.000Z",
        updatedAt: "2026-11-10T12:00:00.000Z",
      },
    });

    // Sheet requests closure after successful save
    await expect.poll(() => onOpenChange.mock.calls.length).toBe(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // Request count remains strictly 1 and matches the payload
    expect(api.calls("POST", "/api/illness/episodes")).toHaveLength(1);
    const [call] = api.calls("POST", "/api/illness/episodes");
    expect(call.body).toMatchObject({
      label: "Migraine",
      type: "INFECTION",
      lifecycle: "ACUTE",
      parentConditionId: null,
    });
    assertAllowedRequests([
      "GET /api/illness/episodes",
      "GET /api/body-sites",
      "POST /api/illness/episodes",
    ]);
  });

  it("stale in-flight save: closes, reopens same edit episode, settles old request via resolve", async () => {
    const editEpisode: IllnessEpisodeDTO = {
      id: "ep-edit-resolve-1",
      label: "Chronic Asthma",
      type: "CHRONIC",
      lifecycle: "CHRONIC_ONGOING",
      onsetAt: "2026-11-01T12:00:00.000Z",
      resolvedAt: null,
      parentConditionId: null,
      note: null,
      bodySite: null,
      laterality: null,
      createdAt: "2026-11-01T12:00:00.000Z",
      updatedAt: "2026-11-01T12:00:00.000Z",
    };

    const patch = api.deferred(
      "PATCH",
      `/api/illness/episodes/${editEpisode.id}`,
    );

    const { screen } = await renderWithApp(
      <SheetHarness editEpisode={editEpisode} />,
    );

    const dialog = screen.getByRole("dialog");
    await expect.element(dialog).toBeVisible();

    // Start an edit save
    const saveButton = screen.getByRole("button", { name: "Save" });
    await saveButton.click();
    await expect
      .poll(
        () =>
          api.calls("PATCH", `/api/illness/episodes/${editEpisode.id}`).length,
      )
      .toBe(1);

    // Close the sheet while save is in-flight
    await screen.getByRole("button", { name: "Cancel" }).click();
    await expect.element(dialog).not.toBeInTheDocument();

    // Reopen the same edit episode
    await screen.getByRole("button", { name: "Reopen Sheet" }).click();
    const reopenedDialog = screen.getByRole("dialog");
    await expect.element(reopenedDialog).toBeVisible();

    const nameInput = screen.getByLabelText("Name");
    await nameInput.fill("Fresh session draft");

    // Reopening cannot bypass the previous mutation's pending state.
    const saveButtonReopened = screen.getByRole("button", { name: "Save" });
    await expect.element(saveButtonReopened).toBeDisabled();

    // Settle the old request via resolve
    patch.release({
      status: 200,
      data: {
        ...editEpisode,
        label: "Chronic Asthma Updated",
      },
    });

    // Assert that Name still has that exact value, Save is enabled, the dialog remains visible, and there is no alert
    await expect.element(nameInput).toHaveValue("Fresh session draft");
    await expect.element(reopenedDialog).toBeVisible();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(saveButtonReopened).toBeEnabled();

    expect(
      api.calls("PATCH", `/api/illness/episodes/${editEpisode.id}`),
    ).toHaveLength(1);
    assertAllowedRequests([
      "GET /api/illness/episodes",
      "GET /api/body-sites",
      `PATCH /api/illness/episodes/${editEpisode.id}`,
    ]);
  });

  it("stale in-flight save: closes, reopens same edit episode, settles old request via reject", async () => {
    const editEpisode: IllnessEpisodeDTO = {
      id: "ep-edit-reject-1",
      label: "Seasonal Allergy",
      type: "ALLERGY",
      lifecycle: "RECURRING",
      onsetAt: "2026-11-02T12:00:00.000Z",
      resolvedAt: null,
      parentConditionId: null,
      note: null,
      bodySite: null,
      laterality: null,
      createdAt: "2026-11-02T12:00:00.000Z",
      updatedAt: "2026-11-02T12:00:00.000Z",
    };

    const patch = api.deferred(
      "PATCH",
      `/api/illness/episodes/${editEpisode.id}`,
    );

    const { screen } = await renderWithApp(
      <SheetHarness editEpisode={editEpisode} />,
    );

    const dialog = screen.getByRole("dialog");
    await expect.element(dialog).toBeVisible();

    // Start an edit save
    const saveButton = screen.getByRole("button", { name: "Save" });
    await saveButton.click();
    await expect
      .poll(
        () =>
          api.calls("PATCH", `/api/illness/episodes/${editEpisode.id}`).length,
      )
      .toBe(1);

    // Close the sheet while save is in-flight
    await screen.getByRole("button", { name: "Cancel" }).click();
    await expect.element(dialog).not.toBeInTheDocument();

    // Reopen the same edit episode
    await screen.getByRole("button", { name: "Reopen Sheet" }).click();
    const reopenedDialog = screen.getByRole("dialog");
    await expect.element(reopenedDialog).toBeVisible();

    const nameInput = screen.getByLabelText("Name");
    await nameInput.fill("Fresh session draft");

    // Reopening cannot bypass the previous mutation's pending state.
    const saveButtonReopened = screen.getByRole("button", { name: "Save" });
    await expect.element(saveButtonReopened).toBeDisabled();

    // Settle the old request via reject (server error)
    patch.release({
      status: 500,
      error: "Internal database write error",
    });

    // Assert that Name still has that exact value, Save is enabled, the dialog remains visible, and there is no alert
    await expect.element(nameInput).toHaveValue("Fresh session draft");
    await expect.element(reopenedDialog).toBeVisible();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(saveButtonReopened).toBeEnabled();

    expect(
      api.calls("PATCH", `/api/illness/episodes/${editEpisode.id}`),
    ).toHaveLength(1);
    assertAllowedRequests([
      "GET /api/illness/episodes",
      "GET /api/body-sites",
      `PATCH /api/illness/episodes/${editEpisode.id}`,
    ]);
  });

  it("serializes updates across separate sheet instances even when the later response settles first", async () => {
    const episode: IllnessEpisodeDTO = {
      id: "ep-edit-scoped-queue",
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
    const savedLabels: string[] = [];
    const patches = queuedPatch(savedLabels);
    api.on("PATCH", `/api/illness/episodes/${episode.id}`, patches.respond);
    const first = await renderWithApp(
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episode}
      />,
    );
    await first.screen.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(
        () => api.calls("PATCH", `/api/illness/episodes/${episode.id}`).length,
      )
      .toBe(1);

    // Unmount the mutation observer while its request is still in flight.
    await first.screen.unmount();
    const second = await renderWithApp(
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={{ ...episode, label: "Newer label" }}
      />,
      { queryClient: first.queryClient },
    );
    await second.screen.getByRole("button", { name: "Save" }).click();
    await expect
      .element(second.screen.getByRole("button", { name: "Save" }))
      .toBeDisabled();
    expect(
      api.calls("PATCH", `/api/illness/episodes/${episode.id}`),
    ).toHaveLength(1);

    // The second response cannot make its PATCH overtake the first request.
    patches.release(1);
    await expect
      .poll(
        () => api.calls("PATCH", `/api/illness/episodes/${episode.id}`).length,
      )
      .toBe(1);
    patches.release(0);
    await expect.poll(() => savedLabels.at(-1)).toBe("Newer label");
    expect(
      api.calls("PATCH", `/api/illness/episodes/${episode.id}`),
    ).toHaveLength(2);
  });

  it("serializes updates saved before and after reopening the same episode", async () => {
    const savedLabels: string[] = [];
    const patches = queuedPatch(savedLabels);
    api.on(
      "PATCH",
      "/api/illness/episodes/ep-edit-concurrent-1",
      patches.respond,
    );
    const editEpisode: IllnessEpisodeDTO = {
      id: "ep-edit-concurrent-1",
      label: "Persistent Cough",
      type: "INFECTION",
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

    const { screen } = await renderWithApp(
      <SheetHarness editEpisode={editEpisode} />,
    );

    const dialog = screen.getByRole("dialog");
    await expect.element(dialog).toBeVisible();

    // Start initial save that hangs
    await screen.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(
        () =>
          api.calls("PATCH", `/api/illness/episodes/${editEpisode.id}`).length,
      )
      .toBe(1);

    // Close the sheet while PATCH 1 is in-flight
    await screen.getByRole("button", { name: "Cancel" }).click();
    await expect.element(dialog).not.toBeInTheDocument();

    // Reopen the same edit episode
    await screen.getByRole("button", { name: "Reopen Sheet" }).click();
    const reopenedDialog = screen.getByRole("dialog");
    await expect.element(reopenedDialog).toBeVisible();

    const nameInput = screen.getByLabelText("Name");
    await nameInput.fill("Updated Cough Draft");

    // Reopening cannot unlock an overlapping update, even before its query
    // mutation has rehydrated the local pending state.
    const saveButton = screen.getByRole("button", { name: "Save" });
    await expect.element(saveButton).toBeDisabled();
    (saveButton.element() as HTMLButtonElement).click();
    expect(
      api.calls("PATCH", `/api/illness/episodes/${editEpisode.id}`),
    ).toHaveLength(1);

    patches.release(0);

    // The old response cannot close the reopened sheet or remove its draft.
    await expect.element(reopenedDialog).toBeVisible();
    await expect.element(nameInput).toHaveValue("Updated Cough Draft");
    await expect.element(saveButton).toBeEnabled();
    await saveButton.click();
    patches.release(1);
    await expect.element(reopenedDialog).not.toBeInTheDocument();
    await expect.poll(() => savedLabels.at(-1)).toBe("Updated Cough Draft");

    const patchCalls = api.calls(
      "PATCH",
      `/api/illness/episodes/${editEpisode.id}`,
    );
    expect(patchCalls).toHaveLength(2);
    assertAllowedRequests([
      "GET /api/illness/episodes",
      "GET /api/body-sites",
      `PATCH /api/illness/episodes/${editEpisode.id}`,
    ]);
  });
});
