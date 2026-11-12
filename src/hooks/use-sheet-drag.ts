"use client";

import { useCallback, useEffect, useRef } from "react";

import {
  backdropOpacity,
  contentDrags,
  dragOffset,
  footerLift,
  lockAxis,
  releaseVelocity,
  settleSheet,
  translateYOf,
  type SheetSample,
  type SheetSnap,
} from "@/lib/sheet-gesture";

/**
 * The bottom sheet's drag: the sheet follows a touch with `translateY`, the
 * backdrop fades with it, and on release the sheet closes or settles
 * (`settleSheet`). Moves are written straight to the elements once per
 * animation frame; React renders only when the resting place changes.
 *
 * Only touch and pen drag. A mouse, the keyboard and a screen reader close
 * the sheet through its X, Escape or the backdrop, which Radix owns, as it
 * owns focus and the scroll lock on the page behind.
 */

/** The settle after a release, matched to the sheet's closing animation. */
export const SHEET_SETTLE_MS = 220;
const SETTLE_EASE = "cubic-bezier(0, 0, 0.2, 1)";

/** A touch on one of these is the control's own (typing, a slider). */
const OWN_GESTURE =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"], [data-sheet-no-drag]';

type Mode = "pending" | "drag" | "ignore";

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  /** The nearest vertically scrolling element under the touch, or null on the sheet's chrome (grip, header, footer). */
  scroller: HTMLElement | null;
  mode: Mode;
  base: number;
  height: number;
  previewOffset: number | null;
  footer: HTMLElement | null;
  offset: number;
  samples: SheetSample[];
}

export interface SheetDragEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}

export interface SheetTouchMoveEvent {
  touches: ArrayLike<{ clientX: number; clientY: number }>;
  cancelable: boolean;
  preventDefault: () => void;
}

export interface SheetDragOptions {
  content: () => HTMLElement | null;
  overlay: () => HTMLElement | null;
  /** An element whose height is the preview height; null without a preview. */
  probe: () => HTMLElement | null;
  hasPreview: () => boolean;
  snap: () => SheetSnap;
  onSnap: (snap: SheetSnap) => void;
  onClose: () => void;
  now?: () => number;
  frame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
  later?: (callback: () => void, ms: number) => unknown;
  reducedMotion?: () => boolean;
  computedTransform?: (element: HTMLElement) => string;
  overflowY?: (element: HTMLElement) => string;
}

export interface SheetDragController {
  pointerDown: (event: SheetDragEvent) => void;
  pointerMove: (event: SheetDragEvent) => void;
  pointerUp: (event: SheetDragEvent) => void;
  pointerCancel: (event: SheetDragEvent) => void;
  /** Non-passive `touchmove` on the sheet: stops the page and the content from scrolling under a drag. */
  touchMove: (event: SheetTouchMoveEvent) => void;
  /** True once for the click that ends a drag, which must not press what it ends on. */
  swallowClick: () => boolean;
  dispose: () => void;
}

function translate(y: number): string {
  return `translate3d(0, ${y}px, 0)`;
}

export function createSheetDrag(
  options: SheetDragOptions,
): SheetDragController {
  const now = options.now ?? (() => performance.now());
  const frame =
    options.frame ?? ((callback) => requestAnimationFrame(() => callback()));
  const cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
  const later =
    options.later ?? ((callback, ms) => window.setTimeout(callback, ms));
  const reducedMotion =
    options.reducedMotion ??
    (() =>
      typeof window !== "undefined" &&
      !!window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const computedTransform =
    options.computedTransform ??
    ((element) => getComputedStyle(element).transform);
  const overflowY =
    options.overflowY ?? ((element) => getComputedStyle(element).overflowY);

  let gesture: Gesture | null = null;
  let pendingFrame = 0;
  let swallow = false;
  let settleToken = 0;

  function scrollerUnder(
    target: EventTarget | null,
    content: HTMLElement,
  ): HTMLElement | null {
    let node = target as HTMLElement | null;
    while (node) {
      const overflow = overflowY(node);
      if (
        (overflow === "auto" || overflow === "scroll") &&
        node.scrollHeight > node.clientHeight + 1
      ) {
        return node;
      }
      if (node === content) return null;
      node = node.parentElement;
    }
    return null;
  }

  function previewOffsetOf(height: number): number | null {
    if (!options.hasPreview()) return null;
    const probe = options.probe();
    if (!probe) return null;
    return Math.max(0, height - probe.offsetHeight);
  }

  function paint() {
    pendingFrame = 0;
    const g = gesture;
    const content = options.content();
    if (!g || !content) return;
    content.style.transform = translate(g.offset);
    const overlay = options.overlay();
    const lowest = g.previewOffset ?? 0;
    if (overlay) {
      overlay.style.opacity = String(
        backdropOpacity(g.offset, lowest, g.height),
      );
    }
    if (g.footer && g.previewOffset !== null) {
      g.footer.style.transform = translate(
        -footerLift(g.offset, g.previewOffset),
      );
    }
  }

  function schedule() {
    if (!pendingFrame) pendingFrame = frame(paint);
  }

  function clearInline(content: HTMLElement, footer: HTMLElement | null) {
    content.style.transition = "";
    content.style.transform = "";
    const overlay = options.overlay();
    if (overlay) {
      overlay.style.transition = "";
      overlay.style.opacity = "";
    }
    if (footer) {
      footer.style.transition = "";
      footer.style.transform = "";
    }
  }

  /** Glide to a resting place, then hand the position back to the stylesheet. */
  function settleTo(g: Gesture, snap: SheetSnap) {
    const content = options.content();
    if (!content) return;
    if (pendingFrame) {
      cancelFrame(pendingFrame);
      pendingFrame = 0;
    }
    const target =
      snap === "preview" && g.previewOffset !== null ? g.previewOffset : 0;
    if (snap !== options.snap()) options.onSnap(snap);
    const token = ++settleToken;
    if (reducedMotion()) {
      clearInline(content, g.footer);
      return;
    }
    const transition = `${SHEET_SETTLE_MS}ms ${SETTLE_EASE}`;
    content.style.transition = `transform ${transition}`;
    content.style.transform = translate(target);
    const overlay = options.overlay();
    if (overlay) {
      overlay.style.transition = `opacity ${transition}`;
      overlay.style.opacity = "1";
    }
    if (g.footer && g.previewOffset !== null) {
      g.footer.style.transition = `transform ${transition}`;
      g.footer.style.transform = translate(
        -footerLift(target, g.previewOffset),
      );
    }
    const footer = g.footer;
    later(() => {
      if (token !== settleToken) return;
      clearInline(content, footer);
    }, SHEET_SETTLE_MS + 40);
  }

  function beginDrag(g: Gesture, content: HTMLElement) {
    // The opening slide (a CSS animation) would hide a move written under
    // it; finish it, then start from wherever the sheet is right now, which
    // may be part-way through a settle.
    for (const animation of content.getAnimations?.() ?? []) {
      if ("animationName" in animation) animation.finish();
    }
    settleToken += 1;
    const base = translateYOf(computedTransform(content));
    content.style.transition = "none";
    content.style.transform = translate(base);
    const overlay = options.overlay();
    if (overlay) overlay.style.transition = "none";
    if (g.footer) g.footer.style.transition = "none";
    g.base = base;
    g.offset = base;
    g.mode = "drag";
  }

  function reset() {
    gesture = null;
  }

  return {
    pointerDown(event) {
      swallow = false;
      if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
      if (!event.isPrimary) {
        // A second finger: whatever the first was doing, put the sheet back.
        if (gesture?.mode === "drag") settleTo(gesture, options.snap());
        reset();
        return;
      }
      const content = options.content();
      if (!content) return;
      const target = event.target as Element | null;
      if (
        target &&
        typeof target.closest === "function" &&
        target.closest(OWN_GESTURE)
      ) {
        return;
      }
      const scroller = scrollerUnder(event.target, content);
      if (scroller && scroller.scrollTop > 0) return;
      const height = content.offsetHeight;
      gesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        scroller,
        mode: "pending",
        base: 0,
        height,
        previewOffset: previewOffsetOf(height),
        footer: options.hasPreview()
          ? content.querySelector<HTMLElement>("[data-sheet-footer]")
          : null,
        offset: 0,
        samples: [],
      };
    },

    pointerMove(event) {
      const g = gesture;
      if (!g || event.pointerId !== g.pointerId || g.mode === "ignore") return;
      const content = options.content();
      if (!content) return;
      const dx = event.clientX - g.startX;
      const dy = event.clientY - g.startY;
      if (g.mode === "pending") {
        const axis = lockAxis(dx, dy);
        if (axis === null) return;
        if (axis === "x") {
          g.mode = "ignore";
          return;
        }
        if (
          g.scroller &&
          !contentDrags({
            scrollTop: g.scroller.scrollTop,
            dy,
            snap: options.snap(),
            hasPreview: g.previewOffset !== null,
          })
        ) {
          g.mode = "ignore";
          return;
        }
        beginDrag(g, content);
        try {
          content.setPointerCapture(event.pointerId);
        } catch {
          // A pointer the browser no longer tracks; the moves still arrive.
        }
      }
      g.offset = dragOffset(g.base, dy);
      g.samples.push({ t: now(), y: g.offset });
      if (g.samples.length > 32) g.samples.splice(0, g.samples.length - 32);
      schedule();
    },

    pointerUp(event) {
      const g = gesture;
      if (!g || event.pointerId !== g.pointerId) return;
      if (g.mode !== "drag") {
        reset();
        return;
      }
      const decision = settleSheet({
        offset: g.offset,
        velocity: releaseVelocity(g.samples, now()),
        height: g.height,
        previewOffset: g.previewOffset,
      });
      if (decision.kind === "close") {
        if (pendingFrame) {
          cancelFrame(pendingFrame);
          pendingFrame = 0;
        }
        // The sheet leaves from where the finger let go: the closing
        // animation starts from this inline position and opacity.
        paint();
        reset();
        // Before the swallow is armed: the close is itself a click.
        options.onClose();
        swallow = true;
        // A sheet holding unsaved input asks first and stays open meanwhile;
        // put it back where it rests rather than where it was let go.
        frame(() => {
          if (options.content()?.getAttribute("data-state") === "open") {
            settleTo(g, options.snap());
          }
        });
        return;
      }
      swallow = true;
      reset();
      settleTo(g, decision.snap);
    },

    pointerCancel(event) {
      const g = gesture;
      if (!g || event.pointerId !== g.pointerId) return;
      reset();
      if (g.mode === "drag") settleTo(g, options.snap());
    },

    touchMove(event) {
      const g = gesture;
      if (!g || g.mode === "ignore") return;
      if (g.mode === "drag") {
        if (event.cancelable) event.preventDefault();
        return;
      }
      // Still deciding: the chrome never scrolls or rubber-bands the page,
      // and content at its top must not start a scroll the drag would lose.
      const touch = event.touches[0];
      if (!touch || !event.cancelable) return;
      if (!g.scroller) {
        event.preventDefault();
        return;
      }
      const dx = touch.clientX - g.startX;
      const dy = touch.clientY - g.startY;
      if (
        Math.abs(dy) > Math.abs(dx) &&
        contentDrags({
          scrollTop: g.scroller.scrollTop,
          dy,
          snap: options.snap(),
          hasPreview: g.previewOffset !== null,
        })
      ) {
        event.preventDefault();
      }
    },

    swallowClick() {
      if (!swallow) return false;
      swallow = false;
      return true;
    },

    dispose() {
      if (pendingFrame) cancelFrame(pendingFrame);
      pendingFrame = 0;
      settleToken += 1;
      gesture = null;
    },
  };
}

export interface UseSheetDragArgs {
  enabled: boolean;
  hasPreview: boolean;
  snap: SheetSnap;
  onSnap: (snap: SheetSnap) => void;
  onClose: () => void;
  contentRef: React.RefObject<HTMLElement | null>;
  overlayRef: React.RefObject<HTMLElement | null>;
  probeRef: React.RefObject<HTMLElement | null>;
  /**
   * The mounted sheet element, as state rather than a ref. The sheet is
   * portaled and mounts only while open, often long after the component
   * that owns it (the More sheet's content is rendered, closed, from the
   * first paint); the touch listeners below must be attached when the
   * element appears, which a ref cannot announce.
   */
  node: HTMLElement | null;
}

export interface SheetDragHandlers {
  onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel?: (event: React.PointerEvent<HTMLElement>) => void;
  onClickCapture?: (event: React.MouseEvent<HTMLElement>) => void;
}

export function useSheetDrag({
  enabled,
  hasPreview,
  snap,
  onSnap,
  onClose,
  contentRef,
  overlayRef,
  probeRef,
  node,
}: UseSheetDragArgs): SheetDragHandlers {
  const latest = useRef({ hasPreview, snap, onSnap, onClose });
  useEffect(() => {
    latest.current = { hasPreview, snap, onSnap, onClose };
  });

  // Made on first use, from an event or the effect, never during render.
  const controllerRef = useRef<SheetDragController | null>(null);
  const controller = useCallback((): SheetDragController => {
    controllerRef.current ??= createSheetDrag({
      content: () => contentRef.current,
      overlay: () => overlayRef.current,
      probe: () => probeRef.current,
      hasPreview: () => latest.current.hasPreview,
      snap: () => latest.current.snap,
      onSnap: (next) => latest.current.onSnap(next),
      onClose: () => latest.current.onClose(),
    });
    return controllerRef.current;
  }, [contentRef, overlayRef, probeRef]);

  useEffect(() => {
    if (!enabled || !node) return;
    const content = node;
    const overlay = overlayRef.current;
    const drag = controller();
    const onContentTouch = (event: TouchEvent) => drag.touchMove(event);
    // A touch on the backdrop never scrolls or pulls the page behind it.
    const onOverlayTouch = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    };
    content.addEventListener("touchmove", onContentTouch, { passive: false });
    overlay?.addEventListener("touchmove", onOverlayTouch, { passive: false });
    return () => {
      content.removeEventListener("touchmove", onContentTouch);
      overlay?.removeEventListener("touchmove", onOverlayTouch);
      drag.dispose();
    };
  }, [enabled, node, controller, overlayRef]);

  if (!enabled) return {};
  return {
    onPointerDown: (event) => controller().pointerDown(event),
    onPointerMove: (event) => controller().pointerMove(event),
    onPointerUp: (event) => controller().pointerUp(event),
    onPointerCancel: (event) => controller().pointerCancel(event),
    onClickCapture: (event) => {
      if (controller().swallowClick()) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}
