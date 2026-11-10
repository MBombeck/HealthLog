import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
}));
vi.mock("@/components/outcome/outcome-toast", () => ({
  toastWrittenOutcome: vi.fn(),
}));
vi.mock("@/lib/errors/error-toast", () => ({
  showErrorToast: vi.fn(),
}));

import { apiPut } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import {
  applyOrder,
  carryOverLegacyModuleListPrefs,
  legacyModuleListPatch,
  legacyModuleListStorageKey,
  parseModuleListPrefs,
  resetModuleListCarryOverForTests,
  runSetModuleListPrefs,
} from "@/lib/module-list-prefs";
import {
  moduleListDefaults,
  resolveModuleListLayout,
} from "@/lib/settings/module-list-layout";
import { queryKeys } from "@/lib/query-keys";

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

beforeEach(() => {
  vi.resetAllMocks();
  store.clear();
  resetModuleListCarryOverForTests();
  vi.stubGlobal("window", { localStorage: fakeStorage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseModuleListPrefs", () => {
  const defaults = moduleListDefaults("illness");

  it("returns defaults for null / malformed input", () => {
    expect(parseModuleListPrefs(null, defaults)).toEqual(defaults);
    expect(parseModuleListPrefs("{not json", defaults)).toEqual(defaults);
  });

  it("coerces unknown view / sortDir to defaults but keeps a valid order", () => {
    expect(
      parseModuleListPrefs(
        JSON.stringify({ view: "grid", sortDir: "weird", order: ["a", "b"] }),
        defaults,
      ),
    ).toEqual({
      view: "cards",
      sortDir: "recentDesc",
      order: ["a", "b"],
      groupBy: "none",
      groupsOpen: "expanded",
      categoryOrder: [],
    });
  });

  it("applies the labs default (list view, #40) when nothing is stored", () => {
    const labs = moduleListDefaults("labs");
    expect(parseModuleListPrefs(null, labs).view).toBe("list");
    expect(
      parseModuleListPrefs(JSON.stringify({ view: "cards" }), labs).view,
    ).toBe("cards");
  });
});

describe("legacyModuleListPatch", () => {
  it("carries only what differs from the default", () => {
    expect(
      legacyModuleListPatch(
        "labs",
        JSON.stringify({ view: "list", order: [], sortDir: "manual" }),
      ),
    ).toEqual({ sortDir: "manual" });
    expect(
      legacyModuleListPatch(
        "illness",
        JSON.stringify({ view: "list", order: ["e2", "e1"] }),
      ),
    ).toEqual({ view: "list", order: ["e2", "e1"] });
    expect(legacyModuleListPatch("vorsorge", null)).toEqual({});
  });
});

describe("carryOverLegacyModuleListPrefs", () => {
  it("sends a browser-stored order up once and removes the browser copy after the server confirmed it", async () => {
    store.set(
      legacyModuleListStorageKey("illness"),
      JSON.stringify({ view: "cards", order: ["e2", "e1"] }),
    );
    const saved = resolveModuleListLayout({ illness: { order: ["e2", "e1"] } });
    vi.mocked(apiPut).mockResolvedValue(saved);
    const queryClient = new QueryClient();

    await carryOverLegacyModuleListPrefs({
      list: "illness",
      layout: resolveModuleListLayout(null),
      queryClient,
    });

    expect(apiPut).toHaveBeenCalledWith("/api/settings/module-list-layout", {
      version: 1,
      list: "illness",
      order: ["e2", "e1"],
    });
    expect(store.has(legacyModuleListStorageKey("illness"))).toBe(false);
    expect(queryClient.getQueryData(queryKeys.moduleListLayout())).toEqual(
      saved,
    );

    // A second mount in the same page load does not send it again.
    await carryOverLegacyModuleListPrefs({
      list: "illness",
      layout: saved,
      queryClient,
    });
    expect(apiPut).toHaveBeenCalledTimes(1);
  });

  it("keeps the browser copy when the write fails, so the order is never lost", async () => {
    store.set(
      legacyModuleListStorageKey("labs"),
      JSON.stringify({ order: ["m1"], sortDir: "manual" }),
    );
    vi.mocked(apiPut).mockRejectedValue(new Error("offline"));

    await carryOverLegacyModuleListPrefs({
      list: "labs",
      layout: resolveModuleListLayout(null),
      queryClient: new QueryClient(),
    });

    expect(store.has(legacyModuleListStorageKey("labs"))).toBe(true);
  });

  it("leaves a list the server already holds alone and drops the stale browser copy", async () => {
    store.set(
      legacyModuleListStorageKey("vorsorge"),
      JSON.stringify({ order: ["r9"] }),
    );
    await carryOverLegacyModuleListPrefs({
      list: "vorsorge",
      layout: resolveModuleListLayout({ vorsorge: { order: ["r1"] } }),
      queryClient: new QueryClient(),
    });
    expect(apiPut).not.toHaveBeenCalled();
    expect(store.has(legacyModuleListStorageKey("vorsorge"))).toBe(false);
  });
});

describe("runSetModuleListPrefs", () => {
  const t = (key: string) => key;

  it("applies the change at once and confirms a view change with a toast", async () => {
    const queryClient = new QueryClient();
    const saved = resolveModuleListLayout({ labs: { view: "cards" } });
    vi.mocked(apiPut).mockResolvedValue(saved);
    await runSetModuleListPrefs({
      list: "labs",
      patch: { view: "cards" },
      queryClient,
      t,
    });
    expect(toastWrittenOutcome).toHaveBeenCalledWith(
      "success",
      "settings.saved",
    );
    expect(queryClient.getQueryData(queryKeys.moduleListLayout())).toEqual(
      saved,
    );
  });

  it("rolls back and says so when the write fails", async () => {
    const queryClient = new QueryClient();
    const before = resolveModuleListLayout(null);
    queryClient.setQueryData(queryKeys.moduleListLayout(), before);
    vi.mocked(apiPut).mockRejectedValue(new Error("nope"));
    await runSetModuleListPrefs({
      list: "illness",
      patch: { order: ["x"] },
      queryClient,
      t,
    });
    expect(queryClient.getQueryData(queryKeys.moduleListLayout())).toEqual(
      before,
    );
    expect(showErrorToast).toHaveBeenCalled();
  });
});

describe("runSetModuleListPrefs category order", () => {
  const t = (key: string) => key;
  const overview = (keys: string[]) => ({
    markers: [],
    grouped: true,
    categories: keys.map((key) => ({ key, label: key })),
  });

  it("moves the cached overview's categories at once and refetches it", async () => {
    const queryClient = new QueryClient();
    const cell = queryKeys.labResultsOverview("en");
    queryClient.setQueryData(cell, overview(["lipids", "thyroid", "other"]));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    let cachedDuringWrite: unknown;
    vi.mocked(apiPut).mockImplementation(async () => {
      cachedDuringWrite = queryClient.getQueryData(cell);
      return resolveModuleListLayout({
        labs: { categoryOrder: ["thyroid", "other", "lipids"] },
      });
    });

    await runSetModuleListPrefs({
      list: "labs",
      patch: { categoryOrder: ["thyroid", "other", "lipids"] },
      queryClient,
      t,
    });

    expect(apiPut).toHaveBeenCalledWith("/api/settings/module-list-layout", {
      version: 1,
      list: "labs",
      categoryOrder: ["thyroid", "other", "lipids"],
    });
    expect(
      (cachedDuringWrite as ReturnType<typeof overview>).categories.map(
        (c) => c.key,
      ),
    ).toEqual(["thyroid", "other", "lipids"]);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.labResultsOverview(),
    });
    // An order move is its own feedback, like the marker order.
    expect(toastWrittenOutcome).not.toHaveBeenCalled();
  });

  it("refetches the overview after a failed write too, so the server order returns", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      queryKeys.labResultsOverview("en"),
      overview(["lipids", "thyroid"]),
    );
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    vi.mocked(apiPut).mockRejectedValue(new Error("offline"));
    await runSetModuleListPrefs({
      list: "labs",
      patch: { categoryOrder: ["thyroid", "lipids"] },
      queryClient,
      t,
    });
    expect(showErrorToast).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.labResultsOverview(),
    });
  });

  it("leaves the overview alone for any other field", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    vi.mocked(apiPut).mockResolvedValue(resolveModuleListLayout(null));
    await runSetModuleListPrefs({
      list: "labs",
      patch: { order: ["m1"] },
      queryClient,
      t,
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("applyOrder", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const idOf = (i: { id: string }) => i.id;

  it("keeps the input order with no saved order", () => {
    expect(applyOrder(items, [], idOf)).toEqual(items);
  });

  it("puts ordered ids first and the rest after in input order", () => {
    expect(applyOrder(items, ["c", "a"], idOf).map(idOf)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("drops unknown ids", () => {
    expect(applyOrder(items, ["z", "b"], idOf).map(idOf)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });
});
