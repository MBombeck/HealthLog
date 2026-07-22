import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  createSeededFormDismissalController,
  createSeededFormHistoryTraversalGuard,
  safeInternalNavigationTarget,
} from "../use-seeded-form-dismissal";

describe("seeded form dismissal", () => {
  const measurementSeed = {
    value: "72.4",
    measuredAt: "2026-07-21T08:30",
    notes: "before breakfast",
  };

  it("closes a pristine edit immediately", () => {
    const close = vi.fn();
    const controller = createSeededFormDismissalController({
      seed: measurementSeed,
      value: measurementSeed,
    });

    controller.requestClose(close);

    expect(close).toHaveBeenCalledOnce();
    expect(controller.getState()).toEqual({
      isDirty: false,
      discardDialogOpen: false,
    });
  });

  it("asks before closing an edit changed from its seeded values", () => {
    const close = vi.fn();
    const controller = createSeededFormDismissalController({
      seed: measurementSeed,
      value: { ...measurementSeed, value: "73.1" },
    });

    controller.requestClose(close);

    expect(close).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({
      isDirty: true,
      discardDialogOpen: true,
    });
  });

  it("keeps the changed draft when discard is cancelled", () => {
    const close = vi.fn();
    const changed = { ...measurementSeed, notes: "after breakfast" };
    const controller = createSeededFormDismissalController({
      seed: measurementSeed,
      value: changed,
    });

    controller.requestClose(close);
    controller.cancelDiscard();

    expect(close).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({
      isDirty: true,
      discardDialogOpen: false,
    });
  });

  it("closes and discards only after explicit confirmation", () => {
    const close = vi.fn();
    const controller = createSeededFormDismissalController({
      seed: measurementSeed,
      value: { ...measurementSeed, measuredAt: "2026-07-21T09:15" },
    });

    controller.requestClose(close);
    controller.confirmDiscard();

    expect(close).toHaveBeenCalledOnce();
    expect(controller.getState().discardDialogOpen).toBe(false);
  });

  it("treats a successfully saved profile value as the new clean seed", () => {
    const close = vi.fn();
    const profileSeed = {
      email: "person@example.test",
      heightCm: "175",
      timezone: "Europe/Berlin",
    };
    const savedProfile = { ...profileSeed, timezone: "Europe/London" };
    const controller = createSeededFormDismissalController({
      seed: profileSeed,
      value: savedProfile,
    });

    expect(controller.getState().isDirty).toBe(true);
    controller.sync({ seed: savedProfile, value: savedProfile });
    controller.requestClose(close);

    expect(controller.getState().isDirty).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not dismiss while a write is pending", () => {
    const close = vi.fn();
    const controller = createSeededFormDismissalController({
      seed: measurementSeed,
      value: { ...measurementSeed, value: "73.1" },
      blocked: true,
    });

    controller.requestClose(close);
    controller.confirmDiscard();

    expect(close).not.toHaveBeenCalled();
    expect(controller.getState().discardDialogOpen).toBe(false);
  });
});

describe("seeded form Back navigation", () => {
  function createHistoryHarness() {
    let index = 1;
    let entries: unknown[] = [{}, {}];
    let onPopState:
      ((event: { stopImmediatePropagation(): void }) => void) | null = null;
    const events: Array<{ stopImmediatePropagation(): void }> = [];
    const history = {
      get state() {
        return entries[index];
      },
      go(delta: number) {
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= entries.length) return;
        index = nextIndex;
        const event = { stopImmediatePropagation: vi.fn() };
        events.push(event);
        onPopState?.(event);
      },
      pushState(state: unknown, unused?: string, url?: string) {
        void unused;
        void url;
        entries = entries.slice(0, index + 1);
        entries.push(state);
        index += 1;
      },
      replaceState(state: unknown, unused?: string, url?: string) {
        void unused;
        void url;
        entries[index] = state;
      },
    };

    return {
      history,
      events,
      get index() {
        return index;
      },
      getCurrentIndex: () => index,
      listen(listener: typeof onPopState) {
        onPopState = listener;
      },
      back() {
        history.go(-1);
      },
      forward() {
        history.go(1);
      },
    };
  }

  function createDirtyBackNavigation() {
    const seed = { value: "72.4" };
    const draft = { value: "73.1" };
    const dismissal = createSeededFormDismissalController({
      seed,
      value: draft,
    });
    const historyHarness = createHistoryHarness();
    const requestClose = vi.fn((close: () => void) => {
      dismissal.requestClose(close);
      return dismissal.getState().discardDialogOpen;
    });
    const historyGuard = createSeededFormHistoryTraversalGuard({
      history: historyHarness.history,
      getCurrentIndex: historyHarness.getCurrentIndex,
      shouldBlock: () => dismissal.getState().isDirty,
      requestClose,
    });
    historyHarness.listen((event) => historyGuard.handlePopState(event));

    return {
      dismissal,
      draft,
      historyGuard,
      historyHarness,
      requestClose,
    };
  }

  it("restores the form route and dirty draft when Back is cancelled", () => {
    const { dismissal, draft, historyGuard, historyHarness, requestClose } =
      createDirtyBackNavigation();

    historyHarness.back();

    expect(historyHarness.index).toBe(1);
    expect(dismissal.getState().discardDialogOpen).toBe(true);
    expect(requestClose).toHaveBeenCalledOnce();

    historyGuard.cancelPendingTraversal();
    dismissal.cancelDiscard();

    expect(historyHarness.index).toBe(1);
    expect(draft).toEqual({ value: "73.1" });
    expect(dismissal.getState()).toEqual({
      isDirty: true,
      discardDialogOpen: false,
    });

    historyHarness.back();

    expect(historyHarness.index).toBe(1);
    expect(requestClose).toHaveBeenCalledTimes(2);
  });

  it("does not prompt twice while the same Back dismissal is pending", () => {
    const { dismissal, historyHarness, requestClose } =
      createDirtyBackNavigation();

    historyHarness.back();
    historyHarness.back();

    expect(historyHarness.index).toBe(1);
    expect(historyHarness.events).toHaveLength(4);
    expect(requestClose).toHaveBeenCalledOnce();
    expect(dismissal.getState().discardDialogOpen).toBe(true);
  });

  it("allows the original Back traversal after discard is confirmed", () => {
    const { dismissal, historyHarness } = createDirtyBackNavigation();

    historyHarness.back();
    dismissal.confirmDiscard();

    expect(historyHarness.index).toBe(0);
    expect(dismissal.getState().discardDialogOpen).toBe(false);
    expect(
      historyHarness.events.at(-1)?.stopImmediatePropagation,
    ).not.toHaveBeenCalled();
  });

  it("restores the form route when Forward follows a Back return and edit without the Navigation API", () => {
    let dirty = false;
    const historyHarness = createHistoryHarness();
    const requestClose = vi.fn(() => true);
    const historyGuard = createSeededFormHistoryTraversalGuard({
      history: historyHarness.history,
      shouldBlock: () => dirty,
      requestClose,
    });
    historyHarness.listen((event) => historyGuard.handlePopState(event));

    historyHarness.history.replaceState(
      { section: "profile" },
      "",
      "/settings?section=profile",
    );
    historyHarness.history.pushState({}, "", "/next");
    historyHarness.back();
    dirty = true;
    historyHarness.forward();

    expect(historyHarness.index).toBe(1);
    expect(requestClose).toHaveBeenCalledOnce();
  });

  it("leaves clean-form Back traversal untouched", () => {
    const historyHarness = createHistoryHarness();
    const requestClose = vi.fn(() => true);
    const historyGuard = createSeededFormHistoryTraversalGuard({
      history: historyHarness.history,
      getCurrentIndex: historyHarness.getCurrentIndex,
      shouldBlock: () => false,
      requestClose,
    });
    historyHarness.listen((event) => historyGuard.handlePopState(event));

    historyHarness.back();

    expect(historyHarness.index).toBe(0);
    expect(requestClose).not.toHaveBeenCalled();
    expect(
      historyHarness.events[0]?.stopImmediatePropagation,
    ).not.toHaveBeenCalled();
  });
});

describe("safeInternalNavigationTarget", () => {
  it("keeps only same-origin path, query, and hash state", () => {
    expect(
      safeInternalNavigationTarget(
        "https://healthlog.test/settings/security?from=account#passkeys",
        "https://healthlog.test/settings/account",
      ),
    ).toBe("/settings/security?from=account#passkeys");
  });

  it("rejects external and credential-bearing navigation targets", () => {
    expect(
      safeInternalNavigationTarget(
        "https://example.test/settings/security",
        "https://healthlog.test/settings/account",
      ),
    ).toBeNull();
    expect(
      safeInternalNavigationTarget(
        "https://user:secret@healthlog.test/settings/security",
        "https://healthlog.test/settings/account",
      ),
    ).toBeNull();
  });
});

describe("seeded dismissal migrations", () => {
  it.each([
    "measurements/measurement-list.tsx",
    "mood/mood-list.tsx",
    "labs/lab-history-list.tsx",
  ])(
    "routes every %s edit exit through the shared contract",
    (relativePath) => {
      const source = readFileSync(
        new URL(`../../${relativePath}`, import.meta.url),
        "utf8",
      );

      expect(source).toContain("useSeededFormDismissal({");
      expect(source).toContain("editDismissal.requestClose(dismissEdit)");
      expect(source).toContain("<SeededFormDiscardDialog");
    },
  );

  it("guards profile navigation and refreshes its seed after a successful save", () => {
    const source = readFileSync(
      new URL("../../settings/account-section/index.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("guardNavigation: true");
    expect(source).toContain("setProfileSeed(savedProfile)");
    expect(source).toContain("<SeededFormDiscardDialog");
  });
});
