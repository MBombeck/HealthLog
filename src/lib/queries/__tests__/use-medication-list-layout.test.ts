/**
 * v1.16.10 — toggle / reorder persistence wiring for the medications
 * list presentation. Pins the PUT payload shape (field-scoped, version
 * 1), the optimistic cache flip + rollback-on-failure for the view
 * toggle, and the cache update on a saved order — without a React
 * render, via the dependency-injected `run*` orchestration functions
 * (the `use-medication-intake` testing convention).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

// A minimal ApiError stand-in so `@/lib/api/optimistic-token` (which imports
// ApiError from this module and uses it in `isConflict`) resolves a real
// constructor under the mock. Declared via `vi.hoisted` so it exists before
// the hoisted `vi.mock` factory runs.
const { ApiError } = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));
vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  ApiError,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { apiPut } from "@/lib/api/api-fetch";
import { toast } from "sonner";
import {
  runSetMedicationListView,
  runSetMedicationListGroupBy,
  runSetMedicationListGroupsOpen,
  runSaveMedicationListCategoryOrder,
  runSaveMedicationListOrder,
} from "@/lib/queries/use-medication-list-layout";
import { queryKeys } from "@/lib/query-keys";
import type {
  MedicationListLayout,
  MedicationListLayoutWithToken,
} from "@/lib/medication-list-layout";

const t = (key: string) => key;

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSetMedicationListView", () => {
  it("PUTs the field-scoped body and lands the server echo in the cache", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayout>(
      queryKeys.medicationListLayout(),
      { version: 1, view: "cards", order: ["med-a"] },
    );
    const saved: MedicationListLayout = {
      version: 1,
      view: "table",
      order: ["med-a"],
    };
    vi.mocked(apiPut).mockResolvedValue(saved as never);

    await runSetMedicationListView({ view: "table", queryClient, t });

    // Field-scoped: only `view` rides the body — the server preserves
    // the stored order (preserve-when-absent), so the client must not
    // resend (and thereby race) it.
    expect(apiPut).toHaveBeenCalledWith("/api/medications/layout", {
      version: 1,
      view: "table",
    });
    expect(queryClient.getQueryData(queryKeys.medicationListLayout())).toEqual(
      saved,
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("flips the cache optimistically before the PUT resolves", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayout>(
      queryKeys.medicationListLayout(),
      { version: 1, view: "cards", order: [] },
    );
    let observedDuringFlight: MedicationListLayout | undefined;
    vi.mocked(apiPut).mockImplementation((async () => {
      observedDuringFlight = queryClient.getQueryData(
        queryKeys.medicationListLayout(),
      );
      return { version: 1, view: "table", order: [] };
    }) as never);

    await runSetMedicationListView({ view: "table", queryClient, t });

    expect(observedDuringFlight?.view).toBe("table");
  });

  it("rolls the cache back and surfaces a toast when the PUT fails", async () => {
    const queryClient = makeClient();
    const previous: MedicationListLayout = {
      version: 1,
      view: "cards",
      order: ["med-a"],
    };
    queryClient.setQueryData(queryKeys.medicationListLayout(), previous);
    vi.mocked(apiPut).mockRejectedValue(new Error("boom"));

    await runSetMedicationListView({ view: "table", queryClient, t });

    expect(queryClient.getQueryData(queryKeys.medicationListLayout())).toEqual(
      previous,
    );
    expect(toast.error).toHaveBeenCalledWith("medications.viewSaveFailed");
  });
});

describe("runSetMedicationListGroupBy", () => {
  it("PUTs the groupBy-only body and land the server echo in cache", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayout>(
      queryKeys.medicationListLayout(),
      { version: 1, view: "cards", order: [], groupBy: "none" },
    );
    const saved: MedicationListLayout = {
      version: 1,
      view: "cards",
      order: [],
      groupBy: "category",
    };
    vi.mocked(apiPut).mockResolvedValue(saved as never);

    await runSetMedicationListGroupBy({ groupBy: "category", queryClient, t });

    expect(apiPut).toHaveBeenCalledWith("/api/medications/layout", {
      version: 1,
      groupBy: "category",
    });
    expect(queryClient.getQueryData(queryKeys.medicationListLayout())).toEqual(
      saved,
    );
  });

  it("flips the cache optimistically and rolls back on failure", async () => {
    const queryClient = makeClient();
    const previous: MedicationListLayout = {
      version: 1,
      view: "cards",
      order: [],
      groupBy: "none",
    };
    queryClient.setQueryData(queryKeys.medicationListLayout(), previous);
    vi.mocked(apiPut).mockRejectedValue(new Error("boom"));

    await runSetMedicationListGroupBy({ groupBy: "category", queryClient, t });

    expect(queryClient.getQueryData(queryKeys.medicationListLayout())).toEqual(
      previous,
    );
    expect(toast.error).toHaveBeenCalledWith("settings.savingError");
  });
});

describe("runSetMedicationListGroupsOpen", () => {
  it("PUTs the groupsOpen-only body and land the server echo in cache", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayout>(
      queryKeys.medicationListLayout(),
      { version: 1, view: "cards", order: [], groupsOpen: "expanded" },
    );
    const saved: MedicationListLayout = {
      version: 1,
      view: "cards",
      order: [],
      groupsOpen: "collapsed",
    };
    vi.mocked(apiPut).mockResolvedValue(saved as never);

    await runSetMedicationListGroupsOpen({
      groupsOpen: "collapsed",
      queryClient,
      t,
    });

    expect(apiPut).toHaveBeenCalledWith("/api/medications/layout", {
      version: 1,
      groupsOpen: "collapsed",
    });
    expect(queryClient.getQueryData(queryKeys.medicationListLayout())).toEqual(
      saved,
    );
  });

  it("flips the cache optimistically and rolls back on failure", async () => {
    const queryClient = makeClient();
    const previous: MedicationListLayout = {
      version: 1,
      view: "cards",
      order: [],
      groupsOpen: "expanded",
    };
    queryClient.setQueryData(queryKeys.medicationListLayout(), previous);
    vi.mocked(apiPut).mockRejectedValue(new Error("boom"));

    await runSetMedicationListGroupsOpen({
      groupsOpen: "collapsed",
      queryClient,
      t,
    });

    expect(queryClient.getQueryData(queryKeys.medicationListLayout())).toEqual(
      previous,
    );
    expect(toast.error).toHaveBeenCalledWith("settings.savingError");
  });
});

describe("runSaveMedicationListCategoryOrder", () => {
  it("PUTs the categoryOrder-only body, protects order on partial writes, and reports success", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayout>(
      queryKeys.medicationListLayout(),
      { version: 1, view: "cards", order: ["med-1"], categoryOrder: [] },
    );
    const saved: MedicationListLayout = {
      version: 1,
      view: "cards",
      order: ["med-1"],
      categoryOrder: ["PAIN", "HEART"],
    };
    vi.mocked(apiPut).mockResolvedValue(saved as never);

    const ok = await runSaveMedicationListCategoryOrder({
      categoryOrder: ["PAIN", "HEART"],
      queryClient,
      t,
    });

    expect(ok).toBe(true);
    expect(apiPut).toHaveBeenCalledWith("/api/medications/layout", {
      version: 1,
      categoryOrder: ["PAIN", "HEART"],
    });
    expect(queryClient.getQueryData(queryKeys.medicationListLayout())).toEqual(
      saved,
    );
    expect(toast.success).toHaveBeenCalledWith("medications.reorderSaved");
  });

  it("protects existing medication order if server returns a partial payload", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayoutWithToken>(
      queryKeys.medicationListLayout(),
      {
        version: 1,
        view: "cards",
        order: ["med-existing"],
        categoryOrder: ["OLD"],
      },
    );
    // Partial response missing `order` field
    const partialSaved = {
      version: 1,
      categoryOrder: ["NEW_CAT"],
    };
    vi.mocked(apiPut).mockResolvedValue(partialSaved as never);

    const ok = await runSaveMedicationListCategoryOrder({
      categoryOrder: ["NEW_CAT"],
      queryClient,
      t,
    });

    expect(ok).toBe(true);
    const updated = queryClient.getQueryData<MedicationListLayoutWithToken>(
      queryKeys.medicationListLayout(),
    );
    expect(updated?.order).toEqual(["med-existing"]);
    expect(updated?.categoryOrder).toEqual(["NEW_CAT"]);
  });

  it("returns false and surfaces a toast when the PUT fails", async () => {
    const queryClient = makeClient();
    vi.mocked(apiPut).mockRejectedValue(new Error("boom"));

    const ok = await runSaveMedicationListCategoryOrder({
      categoryOrder: ["PAIN"],
      queryClient,
      t,
    });

    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("medications.reorderSaveFailed");
  });
});

describe("runSaveMedicationListOrder", () => {
  it("PUTs the order-only body, caches the echo, and reports success", async () => {
    const queryClient = makeClient();
    const saved: MedicationListLayout = {
      version: 1,
      view: "table",
      order: ["med-b", "med-a"],
    };
    vi.mocked(apiPut).mockResolvedValue(saved as never);

    const ok = await runSaveMedicationListOrder({
      order: ["med-b", "med-a"],
      queryClient,
      t,
    });

    expect(ok).toBe(true);
    expect(apiPut).toHaveBeenCalledWith("/api/medications/layout", {
      version: 1,
      order: ["med-b", "med-a"],
    });
    expect(queryClient.getQueryData(queryKeys.medicationListLayout())).toEqual(
      saved,
    );
    expect(toast.success).toHaveBeenCalledWith("medications.reorderSaved");
  });

  it("returns false and surfaces a toast when the PUT fails", async () => {
    const queryClient = makeClient();
    vi.mocked(apiPut).mockRejectedValue(new Error("boom"));

    const ok = await runSaveMedicationListOrder({
      order: ["med-a"],
      queryClient,
      t,
    });

    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("medications.reorderSaveFailed");
  });
});

/**
 * v1.32.21 — optimistic-concurrency token echo + 409 handling.
 */
describe("medications layout — optimistic concurrency (client)", () => {
  it("echoes the cached base token as baseUpdatedAt on the view PUT", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayoutWithToken>(
      queryKeys.medicationListLayout(),
      {
        version: 1,
        view: "cards",
        order: ["med-a"],
        updatedAt: "2026-07-24T10:00:00.000Z",
      },
    );
    vi.mocked(apiPut).mockResolvedValue({
      version: 1,
      view: "table",
      order: ["med-a"],
      updatedAt: "2026-07-24T10:05:00.000Z",
    } as never);

    await runSetMedicationListView({ view: "table", queryClient, t });

    expect(apiPut).toHaveBeenCalledWith("/api/medications/layout", {
      version: 1,
      view: "table",
      baseUpdatedAt: "2026-07-24T10:00:00.000Z",
    });
  });

  it("echoes the cached base token on the order Save", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayoutWithToken>(
      queryKeys.medicationListLayout(),
      {
        version: 1,
        view: "table",
        order: [],
        updatedAt: "2026-07-24T10:00:00.000Z",
      },
    );
    vi.mocked(apiPut).mockResolvedValue({
      version: 1,
      view: "table",
      order: ["med-b"],
      updatedAt: "2026-07-24T10:05:00.000Z",
    } as never);

    await runSaveMedicationListOrder({ order: ["med-b"], queryClient, t });

    expect(apiPut).toHaveBeenCalledWith("/api/medications/layout", {
      version: 1,
      order: ["med-b"],
      baseUpdatedAt: "2026-07-24T10:00:00.000Z",
    });
  });

  it("view toggle: a 409 rolls back, invalidates, and nudges (not a hard error)", async () => {
    const queryClient = makeClient();
    const previous: MedicationListLayoutWithToken = {
      version: 1,
      view: "cards",
      order: ["med-a"],
      updatedAt: "2026-07-24T09:00:00.000Z",
    };
    queryClient.setQueryData(queryKeys.medicationListLayout(), previous);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    vi.mocked(apiPut).mockRejectedValue(new ApiError("conflict", 409));

    await runSetMedicationListView({ view: "table", queryClient, t });

    // Optimistic view rolled back to the pre-toggle state.
    expect(queryClient.getQueryData(queryKeys.medicationListLayout())).toEqual(
      previous,
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.medicationListLayout(),
    });
    expect(toast.message).toHaveBeenCalledWith("common.conflictReloaded");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("order Save: a 409 keeps the dialog open (returns false), invalidates, nudges", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayoutWithToken>(
      queryKeys.medicationListLayout(),
      {
        version: 1,
        view: "table",
        order: [],
        updatedAt: "2026-07-24T09:00:00.000Z",
      },
    );
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    vi.mocked(apiPut).mockRejectedValue(new ApiError("conflict", 409));

    const ok = await runSaveMedicationListOrder({
      order: ["med-b"],
      queryClient,
      t,
    });

    expect(ok).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.medicationListLayout(),
    });
    expect(toast.message).toHaveBeenCalledWith("common.conflictReloaded");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("category order Save: echoes the cached base token", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayoutWithToken>(
      queryKeys.medicationListLayout(),
      {
        version: 1,
        view: "cards",
        order: ["med-1"],
        categoryOrder: ["PAIN"],
        updatedAt: "2026-07-24T10:00:00.000Z",
      },
    );
    vi.mocked(apiPut).mockResolvedValue({
      version: 1,
      view: "cards",
      order: ["med-1"],
      categoryOrder: ["HEART", "PAIN"],
      updatedAt: "2026-07-24T10:05:00.000Z",
    } as never);

    await runSaveMedicationListCategoryOrder({
      categoryOrder: ["HEART", "PAIN"],
      queryClient,
      t,
    });

    expect(apiPut).toHaveBeenCalledWith("/api/medications/layout", {
      version: 1,
      categoryOrder: ["HEART", "PAIN"],
      baseUpdatedAt: "2026-07-24T10:00:00.000Z",
    });
  });

  it("category order Save: buffers multiple local moves without PUT, persists single merged order on explicit save", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayoutWithToken>(
      queryKeys.medicationListLayout(),
      {
        version: 1,
        view: "cards",
        order: ["med-1"],
        categoryOrder: ["CAT_1", "CAT_2", "CAT_3"],
        updatedAt: "2026-07-24T10:00:00.000Z",
      },
    );
    vi.mocked(apiPut).mockResolvedValue({
      version: 1,
      view: "cards",
      order: ["med-1"],
      categoryOrder: ["CAT_3", "CAT_1", "CAT_2"],
      updatedAt: "2026-07-24T10:05:00.000Z",
    } as never);

    // Simulate multiple local moves in editor before clicking Save:
    // Move 1: ["CAT_2", "CAT_1", "CAT_3"]
    // Move 2: ["CAT_3", "CAT_2", "CAT_1"]
    // Final move before save: ["CAT_3", "CAT_1", "CAT_2"]
    const finalOrder = ["CAT_3", "CAT_1", "CAT_2"];

    // No PUTs happen during local moves (only when Save is called)
    expect(apiPut).not.toHaveBeenCalled();

    const ok = await runSaveMedicationListCategoryOrder({
      categoryOrder: finalOrder,
      queryClient,
      t,
    });

    expect(ok).toBe(true);
    // Exactly one PUT with final order and cached baseUpdatedAt
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(apiPut).toHaveBeenCalledWith("/api/medications/layout", {
      version: 1,
      categoryOrder: ["CAT_3", "CAT_1", "CAT_2"],
      baseUpdatedAt: "2026-07-24T10:00:00.000Z",
    });
    expect(toast.success).toHaveBeenCalledWith("medications.reorderSaved");
  });

  it("category order Save: a 409 keeps draft open (returns false), invalidates, nudges, and succeeds on retry", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayoutWithToken>(
      queryKeys.medicationListLayout(),
      {
        version: 1,
        view: "cards",
        order: ["med-1"],
        categoryOrder: ["PAIN"],
        updatedAt: "2026-07-24T09:00:00.000Z",
      },
    );
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    vi.mocked(apiPut).mockRejectedValueOnce(new ApiError("conflict", 409));

    // 1. Initial attempt fails with 409
    const okFirst = await runSaveMedicationListCategoryOrder({
      categoryOrder: ["HEART", "PAIN"],
      queryClient,
      t,
    });

    expect(okFirst).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.medicationListLayout(),
    });
    expect(toast.message).toHaveBeenCalledWith("common.conflictReloaded");
    expect(toast.error).not.toHaveBeenCalled();

    // 2. Query refetch refreshes base token
    queryClient.setQueryData<MedicationListLayoutWithToken>(
      queryKeys.medicationListLayout(),
      {
        version: 1,
        view: "cards",
        order: ["med-1"],
        categoryOrder: ["PAIN"],
        updatedAt: "2026-07-24T09:05:00.000Z",
      },
    );

    // 3. User retries save with preserved draft; succeeds
    const savedLayout: MedicationListLayoutWithToken = {
      version: 1,
      view: "cards",
      order: ["med-1"],
      categoryOrder: ["HEART", "PAIN"],
      updatedAt: "2026-07-24T09:06:00.000Z",
    };
    vi.mocked(apiPut).mockResolvedValueOnce(savedLayout as never);

    const okRetry = await runSaveMedicationListCategoryOrder({
      categoryOrder: ["HEART", "PAIN"],
      queryClient,
      t,
    });

    expect(okRetry).toBe(true);
    expect(apiPut).toHaveBeenLastCalledWith("/api/medications/layout", {
      version: 1,
      categoryOrder: ["HEART", "PAIN"],
      baseUpdatedAt: "2026-07-24T09:05:00.000Z",
    });
    expect(queryClient.getQueryData(queryKeys.medicationListLayout())).toEqual(
      savedLayout,
    );
    expect(toast.success).toHaveBeenCalledWith("medications.reorderSaved");
  });
});
