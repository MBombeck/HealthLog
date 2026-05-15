"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * v1.4.27 R3d MB4 — Coach launch context.
 *
 * Until v1.4.27 the Coach drawer was mounted inline on
 * `/insights/page.tsx` body, which meant navigating to a routed
 * sub-page (`/insights/blutdruck`, etc.) unmounted the drawer and
 * removed every entry point to the Coach. The MA3 audit + Decision F
 * promoted the drawer up to `/insights/layout.tsx` so every routed
 * Insights surface can launch it.
 *
 * Shape:
 *   - `<CoachLaunchProvider>` owns the drawer's open / prefill state
 *     and renders the children beneath the launch surface.
 *   - `useCoachLaunch()` returns `{ open, askCoach, setOpen, prefill }`
 *     so any descendant can open the drawer with an optional prefill
 *     string (the hero-strip suggested-prompt chips feed prefills;
 *     the sticky `<CoachLaunchButton>` opens without one).
 *
 * The provider is intentionally tiny — the actual drawer mount sits
 * next to it in the layout, reading the same state via the hook.
 */
export interface CoachLaunchScope {
  /**
   * Optional metric the user is looking at when they open the Coach.
   * Reserved for v1.4.28 so the drawer can pre-narrow the source rail
   * to the active metric; ignored in v1.4.27.
   */
  metric?: string;
}

interface CoachLaunchValue {
  /** Whether the Coach drawer is currently open. */
  open: boolean;
  /** Current prefill string (or null when the next open should start blank). */
  prefill: string | null;
  /** Open the drawer with an optional prefill + scope hint. */
  askCoach: (prefill?: string | null, scope?: CoachLaunchScope) => void;
  /** Direct setter for the open state — the drawer consumes this. */
  setOpen: (next: boolean) => void;
}

const CoachLaunchContext = createContext<CoachLaunchValue | null>(null);

export interface CoachLaunchProviderProps {
  children: ReactNode;
}

export function CoachLaunchProvider({ children }: CoachLaunchProviderProps) {
  const [open, setOpen] = useState<boolean>(false);
  const [prefill, setPrefill] = useState<string | null>(null);

  const askCoach = useCallback(
    (nextPrefill?: string | null, scope?: CoachLaunchScope) => {
      // `scope` is currently reserved for v1.4.28 (metric-narrow on the
      // sources rail). Accept the parameter today so the call sites
      // don't need to change shape when the rail starts honouring it.
      void scope;
      setPrefill(nextPrefill ?? null);
      setOpen(true);
    },
    [],
  );

  const handleSetOpen = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      // Drop the prefill on close so the next open starts blank.
      setPrefill(null);
    }
  }, []);

  const value = useMemo<CoachLaunchValue>(
    () => ({ open, prefill, askCoach, setOpen: handleSetOpen }),
    [open, prefill, askCoach, handleSetOpen],
  );

  return (
    <CoachLaunchContext.Provider value={value}>
      {children}
    </CoachLaunchContext.Provider>
  );
}

/**
 * Read the Coach launch context. Returns `null` when called outside a
 * `<CoachLaunchProvider>` so consumer components can degrade gracefully
 * (e.g. the hero strip's "Ask the coach" action stays disabled until
 * the provider mounts).
 */
export function useCoachLaunch(): CoachLaunchValue | null {
  return useContext(CoachLaunchContext);
}
