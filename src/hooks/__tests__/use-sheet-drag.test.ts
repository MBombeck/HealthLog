import { describe, expect, it, vi } from "vitest";

import {
  SHEET_SETTLE_MS,
  createSheetDrag,
  type SheetDragEvent,
} from "../use-sheet-drag";
import type { SheetSnap } from "@/lib/sheet-gesture";

/**
 * The drag controller against stand-in elements: what it writes to the
 * sheet, the backdrop and the footer, and when it closes, settles or leaves
 * the touch alone. The browser-level proof (real touches, scrolling, focus)
 * is `e2e/bottom-sheet.spec.ts` on WebKit.
 */

interface FakeEl {
  style: Record<string, string>;
  offsetHeight: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  parentElement: FakeEl | null;
  overflowY: string;
  own?: boolean;
  /** Radix's `data-state` on the sheet content. */
  state?: "open" | "closed";
  getAttribute: (name: string) => string | null;
  closest: (selector: string) => FakeEl | null;
  getAnimations: () => Animation[];
  setPointerCapture: (id: number) => void;
  querySelector: (selector: string) => FakeEl | null;
}

function fake(partial: Partial<FakeEl> = {}): FakeEl {
  const node: FakeEl = {
    style: {},
    offsetHeight: 0,
    scrollHeight: 0,
    clientHeight: 0,
    scrollTop: 0,
    parentElement: null,
    overflowY: "visible",
    closest: () => (node.own ? node : null),
    getAttribute: (name) =>
      name === "data-state" ? (node.state ?? null) : null,
    getAnimations: () => [],
    setPointerCapture: vi.fn(),
    querySelector: () => null,
    ...partial,
  };
  return node;
}

function setup({
  preview = false,
  height = 400,
  previewHeight = 250,
}: { preview?: boolean; height?: number; previewHeight?: number } = {}) {
  let clock = 0;
  let snap: SheetSnap = preview ? "preview" : "full";
  const frames: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const footer = fake();
  const content = fake({
    offsetHeight: height,
    querySelector: () => footer,
  });
  const header = fake({ parentElement: content });
  const body = fake({
    parentElement: content,
    overflowY: "auto",
    scrollHeight: 2000,
    clientHeight: 300,
  });
  const row = fake({ parentElement: body });
  const overlay = fake();
  const probe = fake({ offsetHeight: previewHeight });
  const onClose = vi.fn();
  const onSnap = vi.fn((next: SheetSnap) => {
    snap = next;
  });
  const controller = createSheetDrag({
    content: () => content as unknown as HTMLElement,
    overlay: () => overlay as unknown as HTMLElement,
    probe: () => (preview ? (probe as unknown as HTMLElement) : null),
    hasPreview: () => preview,
    snap: () => snap,
    onSnap,
    onClose,
    now: () => clock,
    frame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {},
    later: (callback) => {
      timers.push(callback);
    },
    reducedMotion: () => false,
    computedTransform: (element) => {
      const inline = (element as unknown as FakeEl).style.transform;
      if (inline) {
        const y = Number(/,\s*(-?[\d.]+)px/.exec(inline)?.[1] ?? 0);
        return `matrix(1, 0, 0, 1, 0, ${y})`;
      }
      return snap === "preview"
        ? `matrix(1, 0, 0, 1, 0, ${height - previewHeight})`
        : "none";
    },
    overflowY: (element) => (element as unknown as FakeEl).overflowY,
  });

  const ev = (
    target: FakeEl,
    x: number,
    y: number,
    extra: Partial<SheetDragEvent> = {},
  ): SheetDragEvent => ({
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    clientX: x,
    clientY: y,
    target: target as unknown as EventTarget,
    ...extra,
  });

  /** A drag of `dy` in `steps` moves, `stepMs` apart, then an optional rest. */
  function drag(
    target: FakeEl,
    dy: number,
    { steps = 10, stepMs = 16, dx = 0, restMs = 0 } = {},
  ) {
    controller.pointerDown(ev(target, 100, 100));
    for (let i = 1; i <= steps; i += 1) {
      clock += stepMs;
      controller.pointerMove(
        ev(target, 100 + (dx * i) / steps, 100 + (dy * i) / steps),
      );
    }
    clock += restMs;
    controller.pointerUp(ev(target, 100 + dx, 100 + dy));
  }

  const flushFrames = () => {
    while (frames.length) frames.shift()!();
  };

  return {
    controller,
    content,
    header,
    body,
    row,
    overlay,
    footer,
    onClose,
    onSnap,
    frames,
    timers,
    flushFrames,
    drag,
    ev,
    getSnap: () => snap,
  };
}

describe("createSheetDrag", () => {
  it("closes after a slow drag past a quarter of the height", () => {
    const s = setup();
    s.drag(s.header, 140, { stepMs: 40, restMs: 200 });
    expect(s.onClose).toHaveBeenCalledTimes(1);
    // It leaves from where the finger let go, with the backdrop already lighter.
    expect(s.content.style.transform).toBe("translate3d(0, 140px, 0)");
    expect(Number(s.overlay.style.opacity)).toBeCloseTo(1 - 140 / 400, 6);
    expect(s.controller.swallowClick()).toBe(true);
    expect(s.controller.swallowClick()).toBe(false);
  });

  it("returns to its rest when a guarded sheet stays open after the swipe", () => {
    const s = setup();
    // The owner asks about unsaved input instead of closing.
    s.content.state = "open";
    s.drag(s.header, 140, { stepMs: 40, restMs: 200 });
    expect(s.onClose).toHaveBeenCalledTimes(1);
    expect(s.content.style.transform).toBe("translate3d(0, 140px, 0)");

    s.flushFrames();
    expect(s.content.style.transform).toBe("translate3d(0, 0px, 0)");
    expect(s.overlay.style.opacity).toBe("1");
    s.timers.forEach((run) => run());
    expect(s.content.style.transform).toBe("");
  });

  it("leaves a closing sheet where it was let go", () => {
    const s = setup();
    s.content.state = "closed";
    s.drag(s.header, 140, { stepMs: 40, restMs: 200 });
    s.flushFrames();
    expect(s.content.style.transform).toBe("translate3d(0, 140px, 0)");
  });

  it("lets its own close through: the swallowed click comes after it", () => {
    const s = setup();
    let swallowedDuringClose: boolean | null = null;
    s.onClose.mockImplementation(() => {
      // The close presses a Radix Close button; a swallow armed already
      // would eat that click and the sheet would never close.
      swallowedDuringClose = s.controller.swallowClick();
    });
    s.drag(s.header, 200, { stepMs: 40, restMs: 200 });
    expect(s.onClose).toHaveBeenCalledTimes(1);
    expect(swallowedDuringClose).toBe(false);
    expect(s.controller.swallowClick()).toBe(true);
  });

  it("springs back after a short slow drag", () => {
    const s = setup();
    s.drag(s.header, 60, { stepMs: 40, restMs: 200 });
    expect(s.onClose).not.toHaveBeenCalled();
    expect(s.content.style.transform).toBe("translate3d(0, 0px, 0)");
    expect(s.content.style.transition).toContain(`${SHEET_SETTLE_MS}ms`);
    expect(s.overlay.style.opacity).toBe("1");
    // Once the glide has run, the stylesheet owns the position again.
    s.timers.forEach((run) => run());
    expect(s.content.style.transform).toBe("");
    expect(s.content.style.transition).toBe("");
    expect(s.overlay.style.opacity).toBe("");
  });

  it("closes on a fast flick even when short", () => {
    const s = setup();
    s.drag(s.header, 60, { steps: 4, stepMs: 10 });
    expect(s.onClose).toHaveBeenCalledTimes(1);
  });

  it("writes moves once per frame, never per event", () => {
    const s = setup();
    s.controller.pointerDown(s.ev(s.header, 100, 100));
    for (let y = 110; y <= 200; y += 10) {
      s.controller.pointerMove(s.ev(s.header, 100, y));
    }
    expect(s.frames).toHaveLength(1);
    s.flushFrames();
    expect(s.content.style.transform).toBe("translate3d(0, 100px, 0)");
  });

  it("drags content down from its very top", () => {
    const s = setup();
    s.drag(s.row, 200, { stepMs: 40, restMs: 200 });
    expect(s.onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves scrolled content to scroll", () => {
    const s = setup();
    s.body.scrollTop = 40;
    s.drag(s.row, 300, { stepMs: 40 });
    expect(s.onClose).not.toHaveBeenCalled();
    expect(s.content.style.transform).toBeUndefined();
    expect(s.frames).toHaveLength(0);
  });

  it("lets an upward swipe on content scroll it", () => {
    const s = setup();
    s.drag(s.row, -200);
    expect(s.frames).toHaveLength(0);
    expect(s.onSnap).not.toHaveBeenCalled();
  });

  it("never counts a sideways gesture", () => {
    const s = setup();
    s.drag(s.row, 30, { dx: 200 });
    s.drag(s.header, 30, { dx: 200 });
    expect(s.frames).toHaveLength(0);
    expect(s.onClose).not.toHaveBeenCalled();
  });

  it("leaves a slider or a field its own gesture", () => {
    const s = setup();
    const slider = fake({ parentElement: s.body, own: true });
    s.drag(slider, 300, { stepMs: 40 });
    expect(s.frames).toHaveLength(0);
  });

  it("ignores the mouse", () => {
    const s = setup();
    s.controller.pointerDown(s.ev(s.header, 0, 0, { pointerType: "mouse" }));
    s.controller.pointerMove(s.ev(s.header, 0, 300, { pointerType: "mouse" }));
    s.controller.pointerUp(s.ev(s.header, 0, 300, { pointerType: "mouse" }));
    expect(s.frames).toHaveLength(0);
    expect(s.onClose).not.toHaveBeenCalled();
  });

  it("resists above the top", () => {
    const s = setup();
    s.controller.pointerDown(s.ev(s.header, 100, 400));
    s.controller.pointerMove(s.ev(s.header, 100, 0));
    s.flushFrames();
    const y = Number(/(-?[\d.]+)px/.exec(s.content.style.transform)?.[1]);
    expect(y).toBeLessThan(0);
    expect(y).toBeGreaterThan(-24);
  });

  it("puts the sheet back when a second finger lands", () => {
    const s = setup();
    s.controller.pointerDown(s.ev(s.header, 100, 100));
    s.controller.pointerMove(s.ev(s.header, 100, 200));
    s.controller.pointerDown(
      s.ev(s.header, 50, 50, { pointerId: 2, isPrimary: false }),
    );
    expect(s.content.style.transform).toBe("translate3d(0, 0px, 0)");
    s.controller.pointerUp(s.ev(s.header, 100, 400));
    expect(s.onClose).not.toHaveBeenCalled();
  });

  describe("touchmove", () => {
    const touch = (y: number, x = 100) => {
      const event = {
        touches: [{ clientX: x, clientY: y }],
        cancelable: true,
        preventDefault: vi.fn(),
      };
      return event;
    };

    it("is cancelled under a drag, and on the chrome from the start", () => {
      const s = setup();
      s.controller.pointerDown(s.ev(s.header, 100, 100));
      const first = touch(102);
      s.controller.touchMove(first);
      expect(first.preventDefault).toHaveBeenCalled();
      s.controller.pointerMove(s.ev(s.header, 100, 150));
      const later = touch(150);
      s.controller.touchMove(later);
      expect(later.preventDefault).toHaveBeenCalled();
    });

    it("is left alone for content that scrolls", () => {
      const s = setup();
      s.body.scrollTop = 10;
      s.controller.pointerDown(s.ev(s.row, 100, 100));
      const event = touch(160);
      s.controller.touchMove(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("is cancelled for a pull down on content at its top", () => {
      const s = setup();
      s.controller.pointerDown(s.ev(s.row, 100, 100));
      const down = touch(106);
      s.controller.touchMove(down);
      expect(down.preventDefault).toHaveBeenCalled();
    });

    it("is left alone for an upward swipe on content", () => {
      const s = setup();
      s.controller.pointerDown(s.ev(s.row, 100, 100));
      const up = touch(80);
      s.controller.touchMove(up);
      expect(up.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("with a preview step", () => {
    it("rises to full height on a pull up from the content", () => {
      const s = setup({ preview: true, height: 800, previewHeight: 450 });
      s.drag(s.row, -300, { stepMs: 40, restMs: 200 });
      expect(s.onSnap).toHaveBeenCalledWith("full");
      expect(s.content.style.transform).toBe("translate3d(0, 0px, 0)");
      expect(s.footer.style.transform).toBe("translate3d(0, 0px, 0)");
    });

    it("keeps the footer on the window edge while the sheet moves up", () => {
      const s = setup({ preview: true, height: 800, previewHeight: 450 });
      s.controller.pointerDown(s.ev(s.header, 100, 500));
      s.controller.pointerMove(s.ev(s.header, 100, 400));
      s.flushFrames();
      // Sheet at 350 - 100 = 250; the footer lifted by the same 250.
      expect(s.content.style.transform).toBe("translate3d(0, 250px, 0)");
      expect(s.footer.style.transform).toBe("translate3d(0, -250px, 0)");
      expect(s.overlay.style.opacity).toBe("1");
    });

    it("goes back to the preview step on a short pull down from full height", () => {
      const s = setup({ preview: true, height: 800, previewHeight: 450 });
      s.drag(s.row, -300, { stepMs: 40, restMs: 200 });
      s.timers.forEach((run) => run());
      expect(s.getSnap()).toBe("full");
      s.drag(s.header, 250, { stepMs: 40, restMs: 200 });
      expect(s.onSnap).toHaveBeenLastCalledWith("preview");
      expect(s.onClose).not.toHaveBeenCalled();
    });

    it("closes from the preview step past a quarter of what it shows", () => {
      const s = setup({ preview: true, height: 800, previewHeight: 450 });
      s.drag(s.header, 130, { stepMs: 40, restMs: 200 });
      expect(s.onClose).toHaveBeenCalledTimes(1);
    });
  });
});
