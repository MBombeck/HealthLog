import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";

import { toast } from "sonner";
import {
  intakeToastOptions,
  runLogIntake,
  runRecordIntake,
  runUndoIntake,
} from "@/components/medications/use-medication-intake";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.12.2 — the shared intake orchestration consumed by both the generic
 * `<MedicationCard>` and the `<Glp1MedicationCard>`. The two cards used to
 * inline their own `recordIntake`, and the GLP-1 copy never gained the
 * v1.11.3 failure-toast (C1) or the Undo action (C2): a failed POST was
 * swallowed silently and the success toast had no Undo.
 *
 * Because both cards now call the same `runRecordIntake`, these tests
 * proving C1 + C2 fire on the shared path are the proof that the GLP-1 card
 * behaves identically to the generic one — there is no second copy left to
 * diverge.
 *
 * The repo has no `@testing-library/react` / `renderHook`, so the pure
 * `run*` helpers take their dependencies (translator, query client) injected
 * and `fetch` / `toast` are module-mocked.
 */

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const t = (key: string, params?: Record<string, string | number>) =>
  params?.name ? `${key}:${params.name}` : key;

function fakeQueryClient(): QueryClient {
  return {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  } as unknown as QueryClient;
}

const medication = { id: "med-1", name: "Mounjaro" };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runRecordIntake — shared C1 failure toast + C2 Undo", () => {
  it("surfaces the failure toast and never the success toast on a non-ok POST", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: vi.fn() }),
    );
    const setIntakeLoading = vi.fn();
    const queryClient = fakeQueryClient();
    const onRecorded = vi.fn();

    await runRecordIntake({
      medication,
      skipped: false,
      t,
      queryClient,
      setIntakeLoading,
      undoIntake: vi.fn(),
      onRecorded,
    });

    // C1 — the failed POST surfaces the failure toast (with the med name),
    // and the success path never fires.
    expect(toast.error).toHaveBeenCalledWith(
      "medications.intakeToastFailed:Mounjaro",
    );
    expect(toast.success).not.toHaveBeenCalled();
    // No follow-up (no injection-site prompt) on a failed record.
    expect(onRecorded).not.toHaveBeenCalled();
    // The spinner is always cleared.
    expect(setIntakeLoading).toHaveBeenLastCalledWith(null);
  });

  it("surfaces the failure toast when the POST throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const setIntakeLoading = vi.fn();

    await runRecordIntake({
      medication,
      skipped: true,
      t,
      queryClient: fakeQueryClient(),
      setIntakeLoading,
      undoIntake: vi.fn(),
    });

    expect(toast.error).toHaveBeenCalledWith(
      "medications.intakeToastFailed:Mounjaro",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(setIntakeLoading).toHaveBeenLastCalledWith(null);
  });

  it("shows a success toast carrying an Undo action whose onClick reverses the dose", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ data: { id: "evt-99" } }),
        // The apiFetch wrapper reads the envelope via `text()`.
        text: vi
          .fn()
          .mockResolvedValue(JSON.stringify({ data: { id: "evt-99" } })),
      }),
    );
    const undoIntake = vi.fn();
    const onRecorded = vi.fn();

    await runRecordIntake({
      medication,
      skipped: false,
      t,
      queryClient: fakeQueryClient(),
      setIntakeLoading: vi.fn(),
      undoIntake,
      onRecorded,
    });

    // C2 — the success toast carries an Undo action.
    expect(toast.success).toHaveBeenCalledTimes(1);
    const [message, opts] = vi.mocked(toast.success).mock.calls[0];
    expect(message).toBe("medications.intakeToastTaken:Mounjaro");
    const action = opts?.action as
      { label: string; onClick: (e: never) => void } | undefined;
    expect(action?.label).toBe("medications.intakeUndo");

    // Firing the action calls undoIntake with the just-created event id.
    action?.onClick({} as never);
    expect(undoIntake).toHaveBeenCalledWith("evt-99");

    // The post-success follow-up receives the event id + skipped flag.
    expect(onRecorded).toHaveBeenCalledWith("evt-99", false);
  });

  it("forces the inactive dashboard snapshot to refetch so the due prompt clears without a reload", async () => {
    // The dashboard snapshot is unmounted while the user is on the medication
    // card/detail, so a default ("active") invalidation marks it stale but
    // never refetches it; on navigating back, refetchOnMount:false serves the
    // pre-write cache and the "due" prompt lingers until a hard reload.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ data: { id: "evt-1" } }),
        text: vi
          .fn()
          .mockResolvedValue(JSON.stringify({ data: { id: "evt-1" } })),
      }),
    );
    const queryClient = fakeQueryClient();

    await runRecordIntake({
      medication,
      skipped: false,
      t,
      queryClient,
      setIntakeLoading: vi.fn(),
      undoIntake: vi.fn(),
    });

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.dashboardSnapshot(),
      refetchType: "inactive",
    });
  });

  it("forces the inactive Today digest to refetch so the dose-window item clears without a reload (v1.29.1)", async () => {
    // The Today hero's digest reads meds from the same server snapshot the
    // intake route hard-evicts, but it lives on the dashboard — unmounted while
    // the user is on the medication card. Without an explicit inactive refetch
    // the digest's "dose due" rail item lingered until a hard reload.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ data: { id: "evt-1" } }),
        text: vi
          .fn()
          .mockResolvedValue(JSON.stringify({ data: { id: "evt-1" } })),
      }),
    );
    const queryClient = fakeQueryClient();

    await runRecordIntake({
      medication,
      skipped: false,
      t,
      queryClient,
      setIntakeLoading: vi.fn(),
      undoIntake: vi.fn(),
    });

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.dailyDigest(),
      refetchType: "inactive",
    });
  });

  it("sends the displayed dose's scheduledFor on the POST so the server marks THAT slot (v1.12.3)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({ data: { id: "evt-am" } }),
      text: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ data: { id: "evt-am" } })),
    });
    vi.stubGlobal("fetch", fetchMock);

    // The morning (07:00) slot the card is showing — Berlin 07:00 = 05:00 UTC.
    const morningSlot = new Date("2026-06-05T05:00:00.000Z");

    await runRecordIntake({
      medication,
      skipped: false,
      scheduledFor: morningSlot,
      t,
      queryClient: fakeQueryClient(),
      setIntakeLoading: vi.fn(),
      undoIntake: vi.fn(),
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      skipped: false,
      scheduledFor: "2026-06-05T05:00:00.000Z",
    });
  });

  it("targets the morning vs evening slot purely from the supplied scheduledFor, not the wall-clock", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({ data: { id: "evt" } }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: "evt" } })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const morningSlot = new Date("2026-06-05T05:00:00.000Z"); // 07:00 Berlin
    const eveningSlot = new Date("2026-06-05T17:00:00.000Z"); // 19:00 Berlin

    await runRecordIntake({
      medication,
      skipped: false,
      scheduledFor: morningSlot,
      t,
      queryClient: fakeQueryClient(),
      setIntakeLoading: vi.fn(),
      undoIntake: vi.fn(),
    });
    await runRecordIntake({
      medication,
      skipped: false,
      scheduledFor: eveningSlot,
      t,
      queryClient: fakeQueryClient(),
      setIntakeLoading: vi.fn(),
      undoIntake: vi.fn(),
    });

    const firstBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    );
    // Each call carries its OWN slot — marking one dose never targets the
    // other.
    expect(firstBody.scheduledFor).toBe("2026-06-05T05:00:00.000Z");
    expect(secondBody.scheduledFor).toBe("2026-06-05T17:00:00.000Z");
  });

  it("omits scheduledFor entirely on a PRN / unscheduled dose (null), preserving the server now-snap path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({ data: { id: "evt-prn" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await runRecordIntake({
      medication,
      skipped: false,
      scheduledFor: null,
      t,
      queryClient: fakeQueryClient(),
      setIntakeLoading: vi.fn(),
      undoIntake: vi.fn(),
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({ skipped: false });
    expect(body).not.toHaveProperty("scheduledFor");
  });

  it("omits the Undo action when the POST body carries no event id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ data: {} }),
        text: vi.fn().mockResolvedValue(JSON.stringify({ data: {} })),
      }),
    );

    await runRecordIntake({
      medication,
      skipped: false,
      t,
      queryClient: fakeQueryClient(),
      setIntakeLoading: vi.fn(),
      undoIntake: vi.fn(),
    });

    const [, opts] = vi.mocked(toast.success).mock.calls[0];
    expect(opts).toBeUndefined();
  });
});

describe("runLogIntake — manual backdated intake from the Add choice", () => {
  it("posts a backdated takenAt against the medication's intake route and returns true", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: vi.fn(),
      text: vi.fn().mockResolvedValue(""),
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = fakeQueryClient();

    const ok = await runLogIntake({
      medication,
      skipped: false,
      takenAt: "2026-06-01T08:30:00.000Z",
      t,
      queryClient,
    });

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/medications/med-1/intake");
    const body = JSON.parse((init as RequestInit).body as string);
    // Backdated instant is carried verbatim; no slot → no scheduledFor.
    expect(body).toEqual({
      skipped: false,
      takenAt: "2026-06-01T08:30:00.000Z",
    });
    expect(body).not.toHaveProperty("scheduledFor");
    // Started, not awaited (the case below).
    await vi.waitFor(() =>
      expect(queryClient.invalidateQueries).toHaveBeenCalled(),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "medications.intakeToastTaken:Mounjaro",
    );
  });

  it("answers once the dose is stored, without waiting for the refetches", async () => {
    // The dialog closes on this answer; on a slow connection the reads it
    // refreshes can take seconds.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: vi.fn(),
        text: vi.fn().mockResolvedValue(""),
      }),
    );
    const queryClient = {
      invalidateQueries: vi.fn(() => new Promise(() => {})),
      getQueryCache: () => ({ findAll: () => [] }),
    } as unknown as QueryClient;

    await expect(
      runLogIntake({
        medication,
        skipped: false,
        takenAt: "2026-06-01T08:30:00.000Z",
        t,
        queryClient,
      }),
    ).resolves.toBe(true);
    expect(toast.success).toHaveBeenCalledWith(
      "medications.intakeToastTaken:Mounjaro",
    );
  });

  it("threads scheduledFor (the chosen slot) so the write routes through the canonical slot upsert", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: vi.fn(),
      text: vi.fn().mockResolvedValue(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    await runLogIntake({
      medication,
      skipped: false,
      takenAt: "2026-06-01T05:10:00.000Z",
      scheduledFor: "2026-06-01T05:00:00.000Z",
      t,
      queryClient: fakeQueryClient(),
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({
      skipped: false,
      takenAt: "2026-06-01T05:10:00.000Z",
      scheduledFor: "2026-06-01T05:00:00.000Z",
    });
  });

  it("omits takenAt on a skipped log and shows the skipped toast", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: vi.fn(),
      text: vi.fn().mockResolvedValue(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    await runLogIntake({
      medication,
      skipped: true,
      takenAt: "2026-06-01T08:30:00.000Z",
      t,
      queryClient: fakeQueryClient(),
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({ skipped: true });
    expect(body).not.toHaveProperty("takenAt");
    expect(toast.success).toHaveBeenCalledWith(
      "medications.intakeToastSkipped:Mounjaro",
    );
  });

  it("surfaces the failure toast and returns false on a non-ok POST", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: vi.fn() }),
    );
    const queryClient = fakeQueryClient();

    const ok = await runLogIntake({
      medication,
      skipped: false,
      takenAt: "2026-06-01T08:30:00.000Z",
      t,
      queryClient,
    });

    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(
      "medications.intakeToastFailed:Mounjaro",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });
});

describe("runUndoIntake — shared soft-delete", () => {
  it("reverts via DELETE and confirms on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      text: vi.fn().mockResolvedValue(""),
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = fakeQueryClient();

    await runUndoIntake({ medication, eventId: "evt-1", t, queryClient });

    // Method + path are the contract; the shared fetch wrapper may attach
    // transport details (e.g. an abort signal) the undo path doesn't own.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/medications/med-1/intake/evt-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(toast.success).toHaveBeenCalledWith("medications.intakeUndone");
    expect(queryClient.invalidateQueries).toHaveBeenCalled();
  });

  it("surfaces the undo-failure toast on a non-ok DELETE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    await runUndoIntake({
      medication,
      eventId: "evt-1",
      t,
      queryClient: fakeQueryClient(),
    });

    expect(toast.error).toHaveBeenCalledWith("medications.intakeUndoFailed");
    expect(toast.success).not.toHaveBeenCalled();
  });
});

/**
 * v1.36.x — the one decision every intake surface shares.
 *
 * Three surfaces record a dose and all three showed the same success toast:
 * the cards, the log-intake dialog, and the dose-history ledger. Two of them
 * learned to name the record and drop Undo inside somebody else's; the ledger
 * built its own copy of the ternary and learned neither, so a delegate met a
 * dead Undo on every dose they marked. This is the copy that is left.
 *
 * Whole objects rather than field probes: when one person's record is being
 * separated from another's, a failure should print what would have been shown
 * rather than `false !== true`.
 *
 * Mutation check, run: making `intakeToastOptions` ignore `recordName` → the
 * two shared-record legs go red, printing the Undo action they returned.
 */
describe("intakeToastOptions — the shared toast decision", () => {
  const onUndo = vi.fn();

  it("carries an Undo in the caller's own record", () => {
    expect(
      intakeToastOptions({ recordName: null, eventId: "evt-1", t, onUndo }),
    ).toEqual({
      action: {
        label: "medications.intakeUndo",
        onClick: expect.any(Function),
      },
    });
  });

  it("names the record and offers no Undo inside somebody else's", () => {
    expect(
      intakeToastOptions({
        recordName: "Margarethe",
        eventId: "evt-1",
        t,
        onUndo,
      }),
    ).toEqual({ description: "recordSharing.toast.savedTo:Margarethe" });
  });

  it("still names the record when the write returned no event id", () => {
    // The two arms are not alternatives: the receipt is owed either way, and
    // an absent event id must not fall through to a bare "Saved".
    expect(
      intakeToastOptions({
        recordName: "Margarethe",
        eventId: undefined,
        t,
        onUndo,
      }),
    ).toEqual({ description: "recordSharing.toast.savedTo:Margarethe" });
  });

  it("carries nothing when there is neither a record to name nor an undo", () => {
    expect(
      intakeToastOptions({ recordName: null, eventId: undefined, t, onUndo }),
    ).toBeUndefined();
    expect(
      intakeToastOptions({ recordName: null, eventId: "evt-1", t }),
    ).toBeUndefined();
  });
});
