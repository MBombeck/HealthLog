import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { hasOpenActionToast, showInformationalToast } from "../priority";

beforeEach(() => {
  vi.useFakeTimers();
  // Sonner schedules a dismissal on the next frame; the node test
  // environment has no frames, so run it on a timer instead.
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 0));
});

afterEach(() => {
  toast.dismiss();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("toast priority", () => {
  it("shows an informational toast at once when nothing can be pressed", () => {
    toast("Plain note");
    const show = vi.fn();
    showInformationalToast(show);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("holds informational toasts while an Undo toast is open, then shows them in order", () => {
    const id = toast.success("Saved", {
      action: { label: "Undo", onClick: () => {} },
    });
    expect(hasOpenActionToast()).toBe(true);

    const order: string[] = [];
    showInformationalToast(() => order.push("first achievement"));
    showInformationalToast(() => order.push("second achievement"));
    vi.advanceTimersByTime(2_000);
    expect(order).toEqual([]);

    toast.dismiss(id);
    vi.advanceTimersByTime(1_000);
    expect(order).toEqual(["first achievement", "second achievement"]);
  });

  it("treats an Edit link (cancel slot) as something to press", () => {
    const id = toast.success("Saved", { cancel: "Edit" });
    const show = vi.fn();
    showInformationalToast(show);
    vi.advanceTimersByTime(1_000);
    expect(show).not.toHaveBeenCalled();
    toast.dismiss(id);
    vi.advanceTimersByTime(1_000);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("keeps a queued toast ahead of a later one even once nothing is open", () => {
    const id = toast("Saved", {
      action: { label: "Undo", onClick: () => {} },
    });
    const order: string[] = [];
    showInformationalToast(() => order.push("queued"));
    toast.dismiss(id);
    // Nothing is open any more, but the queue has not flushed yet.
    showInformationalToast(() => order.push("later"));
    vi.advanceTimersByTime(1_000);
    expect(order).toEqual(["queued", "later"]);
  });
});
