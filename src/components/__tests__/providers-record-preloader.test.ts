import { describe, expect, it } from "vitest";
import {
  isRecordPreloadReady,
  preloadsMedicationsList,
} from "@/components/providers";
import {
  __resetRecordScopeForTests,
  setRecordScope,
  setRefusedRecordScope,
} from "@/lib/query-keys/record-scope";

describe("isRecordPreloadReady", () => {
  it("waits for the account response before warming record reads", () => {
    __resetRecordScopeForTests();

    expect(
      isRecordPreloadReady({ isLoading: true, accountAccessStatus: "valid" }),
    ).toBe(false);
    expect(
      isRecordPreloadReady({
        isLoading: false,
        accountAccessStatus: undefined,
      }),
    ).toBe(false);
  });

  it("accepts only a resolved own-record response with an own-record scope", () => {
    __resetRecordScopeForTests();
    setRecordScope(null);

    expect(
      isRecordPreloadReady({
        isLoading: false,
        accountAccessStatus: "valid",
        activeAccountId: null,
      }),
    ).toBe(true);

    setRecordScope("shared-record");
    expect(
      isRecordPreloadReady({
        isLoading: false,
        accountAccessStatus: "valid",
        activeAccountId: null,
      }),
    ).toBe(false);
  });

  it("accepts a shared-record response only after its exact scope is mirrored", () => {
    __resetRecordScopeForTests();
    setRecordScope("shared-record");

    expect(
      isRecordPreloadReady({
        isLoading: false,
        accountAccessStatus: "valid",
        activeAccountId: "shared-record",
      }),
    ).toBe(true);

    setRecordScope(null);
    expect(
      isRecordPreloadReady({
        isLoading: false,
        accountAccessStatus: "valid",
        activeAccountId: "shared-record",
      }),
    ).toBe(false);
  });

  it("never opens a preload window for an explicitly refused record", () => {
    __resetRecordScopeForTests();
    setRefusedRecordScope();

    expect(
      isRecordPreloadReady({
        isLoading: false,
        accountAccessStatus: "invalid",
        activeAccountId: null,
      }),
    ).toBe(false);
  });
});

describe("preloadsMedicationsList", () => {
  // The document's own load on /medications already carries the list in its
  // server render; a prefetch then made the page's HydrationBoundary hydrate
  // in an effect, and the first client render no longer matched (React #418).
  it("does not warm the list on the document's own load of /medications", () => {
    expect(preloadsMedicationsList("/medications", "/medications")).toBe(false);
  });

  it("warms it on a navigation to /medications, and nowhere else", () => {
    expect(preloadsMedicationsList("/medications", null)).toBe(true);
    expect(preloadsMedicationsList("/medications", "/")).toBe(true);
    expect(preloadsMedicationsList("/", null)).toBe(false);
  });
});
