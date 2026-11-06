import { afterEach, describe, expect, it, vi } from "vitest";

import {
  groupMarkerRows,
  readStoredOpen,
  writeStoredOpen,
} from "../lab-list-groups";
import type { MarkerRow } from "../lab-list-rows";
import type { LabOverviewCategoryDto } from "../types";

function category(key: string, markerKeys: string[]): LabOverviewCategoryDto {
  return {
    key,
    label: key,
    markerKeys,
    counts: { inRange: markerKeys.length, below: 0, above: 0, unknown: 0 },
    status: "in-range",
  };
}

const row = (key: string) => ({ key }) as MarkerRow;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("groupMarkerRows", () => {
  it("keeps the rows' own order inside a category and the server order across them", () => {
    const groups = groupMarkerRows(
      [row("c"), row("a"), row("b")],
      [category("second", ["a", "b"]), category("first", ["c"])],
    );
    expect(groups.map((g) => g.category.key)).toEqual(["second", "first"]);
    expect(groups[0].rows.map((r) => r.key)).toEqual(["a", "b"]);
  });

  it("drops a category with no row present", () => {
    expect(
      groupMarkerRows([row("a")], [category("x", ["a"]), category("y", ["z"])]),
    ).toHaveLength(1);
  });
});

describe("stored open state", () => {
  function stubStorage(store: Map<string, string>) {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
  }

  it("round-trips the toggles made under one choice and forgets them under another", () => {
    const store = new Map<string, string>();
    stubStorage(store);
    writeStoredOpen("flagged", { lipids: true, "custom:abc": false });
    expect(readStoredOpen("flagged")).toEqual({
      lipids: true,
      "custom:abc": false,
    });
    expect(readStoredOpen("expanded")).toEqual({});
  });

  it("survives a storage that throws or holds garbage", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    });
    expect(readStoredOpen("expanded")).toEqual({});
    expect(() => writeStoredOpen("expanded", { a: true })).not.toThrow();

    const store = new Map([["healthlog:labs-groups-open", "{not json"]]);
    stubStorage(store);
    expect(readStoredOpen("expanded")).toEqual({});
  });
});
