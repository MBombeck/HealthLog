/**
 * The list's bulk delete and its Undo answer once the server has done it.
 *
 * Both used to wait for every read a measurement touches (charts, insights,
 * the dashboard) before the selection bar cleared or the toast showed, so on
 * a slow connection a delete looked like it had not happened.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: {
    // A refetch that never answers, as on a slow connection.
    invalidateQueries: vi.fn(() => new Promise(() => {})),
    getQueryCache: () => ({ findAll: () => [] }),
  },
  toastSuccess: vi.fn(),
  apiPost: vi.fn(async () => ({ deleted: 2 })),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(fn: T) => fn,
  useEffect: () => {},
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  // The hook's options are what is under test; return them as they are.
  useMutation: (options: unknown) => options,
  useQueryClient: () => h.client,
}));

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: vi.fn(),
  apiDelete: vi.fn(),
  apiPost: h.apiPost,
}));

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({ toast: { success: h.toastSuccess } }));

import type { MeasurementListFilters } from "../use-measurement-list-filters";
import { useMeasurementListData } from "../use-measurement-list-data";

function useBulkDelete(clearSelection = vi.fn()) {
  const filters = {
    typeFilter: "ALL",
    selectedIds: new Set<string>(),
    setSelectedIds: vi.fn(),
    clearSelection,
  } as unknown as MeasurementListFilters;
  const data = useMeasurementListData({
    filters,
    enabled: true,
    lockedType: undefined,
  });
  return data.bulkDeleteMutation as unknown as {
    onSuccess: (deleted: number, ids: string[]) => unknown;
  };
}

describe("measurement list deletes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears the selection and says so without waiting for the refetch", () => {
    const clearSelection = vi.fn();
    const bulk = useBulkDelete(clearSelection);

    expect(bulk.onSuccess(2, ["a", "b"])).toBeUndefined();
    expect(clearSelection).toHaveBeenCalled();
    expect(h.toastSuccess).toHaveBeenCalledWith(
      "measurements.bulkDeleteSuccess",
      expect.anything(),
    );
  });

  it("confirms the Undo once the rows are back, before the refetch", async () => {
    useBulkDelete().onSuccess(2, ["a", "b"]);
    const undo = h.toastSuccess.mock.calls[0]![1] as {
      action: { onClick: () => void };
    };

    undo.action.onClick();
    await vi.waitFor(() =>
      expect(h.toastSuccess).toHaveBeenLastCalledWith(
        "measurements.restoredToast",
      ),
    );
    expect(h.apiPost).toHaveBeenLastCalledWith("/api/measurements/restore", {
      ids: ["a", "b"],
    });
  });
});
