"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslations } from "@/lib/i18n/context";

type CloseRequest = () => void;

type ControllerOptions<T> = {
  seed: T;
  value: T;
  blocked?: boolean;
  equals?: (seed: T, value: T) => boolean;
  onStateChange?: () => void;
};

type ControllerSync<T> = Pick<
  ControllerOptions<T>,
  "seed" | "value" | "blocked"
>;

export type SeededFormDismissalController<T> = {
  sync(options: ControllerSync<T>): void;
  getState(): { isDirty: boolean; discardDialogOpen: boolean };
  requestClose(close: CloseRequest): void;
  confirmDiscard(): void;
  cancelDiscard(): void;
};

function seededValuesEqual<T>(seed: T, value: T): boolean {
  return JSON.stringify(seed) === JSON.stringify(value);
}

export function createSeededFormDismissalController<T>(
  initial: ControllerOptions<T>,
): SeededFormDismissalController<T> {
  let seed = initial.seed;
  let value = initial.value;
  let blocked = initial.blocked ?? false;
  let discardDialogOpen = false;
  let pendingClose: CloseRequest | null = null;
  const equals = initial.equals ?? seededValuesEqual;
  const notify = initial.onStateChange ?? (() => undefined);

  return {
    sync(next) {
      seed = next.seed;
      value = next.value;
      blocked = next.blocked ?? false;
    },
    getState() {
      return {
        isDirty: !equals(seed, value),
        discardDialogOpen,
      };
    },
    requestClose(close) {
      if (blocked) return;
      if (equals(seed, value)) {
        close();
        return;
      }
      pendingClose = close;
      discardDialogOpen = true;
      notify();
    },
    confirmDiscard() {
      if (blocked || !discardDialogOpen) return;
      const close = pendingClose;
      pendingClose = null;
      discardDialogOpen = false;
      notify();
      close?.();
    },
    cancelDiscard() {
      if (!discardDialogOpen) return;
      pendingClose = null;
      discardDialogOpen = false;
      notify();
    },
  };
}

type HistoryTraversal = {
  readonly state?: unknown;
  go(delta: number): void;
  pushState?(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState?(data: unknown, unused: string, url?: string | URL | null): void;
};

type HistoryTraversalGuardOptions = {
  history: HistoryTraversal;
  getCurrentIndex?: () => number | undefined;
  shouldBlock: () => boolean;
  requestClose: (close: CloseRequest) => boolean;
};

type InterceptablePopStateEvent = {
  stopImmediatePropagation(): void;
};

export type SeededFormHistoryTraversalGuard = {
  handlePopState(event: InterceptablePopStateEvent): void;
  cancelPendingTraversal(): void;
  dispose(): void;
};

const SEEDED_FORM_HISTORY_INDEX = "__healthlogSeededFormHistoryIndex";

function createHistoryEntryIndexTracker(history: HistoryTraversal) {
  const getCurrentIndex = () => {
    if (
      history.state === null ||
      typeof history.state !== "object" ||
      Array.isArray(history.state)
    ) {
      return undefined;
    }
    const index = (history.state as Record<string, unknown>)[
      SEEDED_FORM_HISTORY_INDEX
    ];
    return typeof index === "number" ? index : undefined;
  };
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  if (originalPushState === undefined || originalReplaceState === undefined) {
    return { getCurrentIndex, dispose: () => undefined };
  }

  const withIndex = (state: unknown, index: number) => ({
    ...(state !== null && typeof state === "object" && !Array.isArray(state)
      ? state
      : {}),
    [SEEDED_FORM_HISTORY_INDEX]: index,
  });
  if (getCurrentIndex() === undefined) {
    originalReplaceState.call(history, withIndex(history.state, 0), "");
  }

  const trackedPushState: NonNullable<HistoryTraversal["pushState"]> = (
    data,
    unused,
    url,
  ) => {
    const nextIndex = (getCurrentIndex() ?? 0) + 1;
    originalPushState.call(history, withIndex(data, nextIndex), unused, url);
  };
  const trackedReplaceState: NonNullable<HistoryTraversal["replaceState"]> = (
    data,
    unused,
    url,
  ) => {
    originalReplaceState.call(
      history,
      withIndex(data, getCurrentIndex() ?? 0),
      unused,
      url,
    );
  };
  history.pushState = trackedPushState;
  history.replaceState = trackedReplaceState;

  return {
    getCurrentIndex,
    dispose() {
      if (history.pushState === trackedPushState) {
        history.pushState = originalPushState;
      }
      if (history.replaceState === trackedReplaceState) {
        history.replaceState = originalReplaceState;
      }
    },
  };
}

export function createSeededFormHistoryTraversalGuard({
  history,
  getCurrentIndex,
  shouldBlock,
  requestClose,
}: HistoryTraversalGuardOptions): SeededFormHistoryTraversalGuard {
  const nativeIndex = getCurrentIndex?.();
  const indexTracker =
    nativeIndex === undefined
      ? createHistoryEntryIndexTracker(history)
      : undefined;
  const currentIndex =
    indexTracker === undefined
      ? () => getCurrentIndex?.()
      : indexTracker.getCurrentIndex;
  const guardedIndex = currentIndex();
  let allowNextTraversal = false;
  let restoringRoute = false;
  let promptOpen = false;
  let confirmedWhileRestoring = false;
  let confirmedTraversalDelta = -1;

  const continueTraversal = () => {
    promptOpen = false;
    if (restoringRoute) {
      confirmedWhileRestoring = true;
      return;
    }

    allowNextTraversal = true;
    history.go(confirmedTraversalDelta);
  };

  return {
    handlePopState(event) {
      if (allowNextTraversal) {
        allowNextTraversal = false;
        return;
      }

      if (restoringRoute) {
        event.stopImmediatePropagation();
        restoringRoute = false;
        if (confirmedWhileRestoring) {
          confirmedWhileRestoring = false;
          allowNextTraversal = true;
          history.go(confirmedTraversalDelta);
        }
        return;
      }

      if (!shouldBlock()) return;

      event.stopImmediatePropagation();
      const traversedIndex = currentIndex();
      const restorationDelta =
        guardedIndex === undefined ||
        traversedIndex === undefined ||
        guardedIndex === traversedIndex
          ? 1
          : guardedIndex - traversedIndex;
      confirmedTraversalDelta = -restorationDelta;
      restoringRoute = true;
      history.go(restorationDelta);

      if (promptOpen) return;
      promptOpen = true;
      if (!requestClose(continueTraversal)) {
        promptOpen = false;
      }
    },
    cancelPendingTraversal() {
      promptOpen = false;
      confirmedWhileRestoring = false;
    },
    dispose() {
      indexTracker?.dispose();
    },
  };
}

export function safeInternalNavigationTarget(
  href: string,
  currentHref: string,
): string | null {
  try {
    const current = new URL(currentHref);
    const target = new URL(href, current);
    if (
      target.protocol !== current.protocol ||
      target.origin !== current.origin ||
      target.username !== "" ||
      target.password !== ""
    ) {
      return null;
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

type UseSeededFormDismissalOptions<T> = {
  seed: T;
  value: T;
  blocked?: boolean;
  guardNavigation?: boolean;
  navigate?: (target: string) => void;
};

export function useSeededFormDismissal<T>({
  seed,
  value,
  blocked = false,
  guardNavigation = false,
  navigate,
}: UseSeededFormDismissalOptions<T>) {
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const pendingCloseRef = useRef<CloseRequest | null>(null);
  const historyTraversalGuardRef =
    useRef<SeededFormHistoryTraversalGuard | null>(null);
  const isDirty = !seededValuesEqual(seed, value);
  const requestClose = useCallback(
    (close: CloseRequest) => {
      if (blocked) return false;
      if (!isDirty) {
        close();
        return true;
      }
      pendingCloseRef.current = close;
      setDiscardDialogOpen(true);
      return true;
    },
    [blocked, isDirty],
  );
  const confirmDiscard = useCallback(() => {
    if (blocked || !discardDialogOpen) return;
    const close = pendingCloseRef.current;
    pendingCloseRef.current = null;
    setDiscardDialogOpen(false);
    close?.();
  }, [blocked, discardDialogOpen]);
  const cancelDiscard = useCallback(() => {
    historyTraversalGuardRef.current?.cancelPendingTraversal();
    pendingCloseRef.current = null;
    setDiscardDialogOpen(false);
  }, []);

  useEffect(() => {
    if (!guardNavigation) return;

    const navigation = (
      window as Window & {
        navigation?: { currentEntry?: { index: number } };
      }
    ).navigation;
    const historyTraversalGuard = createSeededFormHistoryTraversalGuard({
      history: window.history,
      getCurrentIndex: () => navigation?.currentEntry?.index,
      shouldBlock: () => isDirty,
      requestClose,
    });
    historyTraversalGuardRef.current = historyTraversalGuard;
    const handlePopState = (event: PopStateEvent) => {
      historyTraversalGuard.handlePopState(event);
    };

    window.addEventListener("popstate", handlePopState, true);
    return () => {
      window.removeEventListener("popstate", handlePopState, true);
      historyTraversalGuard.dispose();
      if (historyTraversalGuardRef.current === historyTraversalGuard) {
        historyTraversalGuardRef.current = null;
      }
    };
  }, [guardNavigation, isDirty, requestClose]);

  useEffect(() => {
    if (!guardNavigation || !isDirty) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const handleDocumentClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      ) {
        return;
      }

      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (
        !anchor ||
        anchor.hasAttribute("download") ||
        (anchor.target !== "" && anchor.target !== "_self")
      ) {
        return;
      }

      const target = safeInternalNavigationTarget(
        anchor.href,
        window.location.href,
      );
      if (target === null || navigate === undefined) return;

      const targetUrl = new URL(target, window.location.origin);
      const currentDocument = `${window.location.pathname}${window.location.search}`;
      if (`${targetUrl.pathname}${targetUrl.search}` === currentDocument)
        return;
      event.preventDefault();
      requestClose(() => navigate(target));
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleDocumentClick, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleDocumentClick, true);
    };
  }, [guardNavigation, isDirty, navigate, requestClose]);

  return {
    isDirty,
    discardDialogOpen,
    requestClose,
    confirmDiscard,
    cancelDiscard,
  };
}

export function SeededFormDiscardDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslations();

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("dashboard.quickEntryDiscard.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("dashboard.quickEntryDiscard.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            {t("dashboard.quickEntryDiscard.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t("dashboard.quickEntryDiscard.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
