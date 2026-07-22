"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { CoachScopeSource, CoachScopeWindow } from "@/lib/ai/coach/types";

/**
 * v1.4.27 R3d MB4 — Coach launch context.
 *
 * Until v1.4.27 the Coach drawer was mounted inline on
 * `/insights/page.tsx` body, which meant navigating to a routed
 * sub-page (`/insights/blood-pressure`, etc.) unmounted the drawer and
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
   *
   * v1.4.28 R3c (BK-MED-2 / BK-F-M4) — narrowed from `string` to the
   * `CoachScopeSource` union so call sites cannot drift to a free-form
   * label that the sources rail then silently ignores. Adding a new
   * Apple-Health source to the rail (the union already covers the
   * v1.4.23 additions) automatically widens the allowed values here.
   *
   * v1.21.0 (C4 H1/H4) — now LIVE: the scope threads through the drawer
   * into the chat request so a conversation opened from a metric surface
   * or an insight card is pre-narrowed to the relevant source(s). The
   * `void scope` discard is gone.
   */
  metric?: CoachScopeSource;
  /**
   * Optional extra sources to include alongside `metric` — a correlation
   * card spanning two metrics (e.g. weight × pulse) seeds both so the
   * snapshot the Coach reads covers the relationship the card describes.
   */
  also?: CoachScopeSource[];
  /**
   * Optional day-window the conversation should anchor on. Defaults to
   * the chat route's own `last30days` when omitted.
   */
  window?: CoachScopeWindow;
}

export type CoachCloseIntent = "dismiss" | "navigate";

interface CoachLaunchValue {
  /** Whether the Coach drawer is currently open. */
  open: boolean;
  /** Why the most recent drawer close happened, or null while it is open. */
  closeIntent: CoachCloseIntent | null;
  /** Current prefill string (or null when the next open should start blank). */
  prefill: string | null;
  /**
   * When true, the opened conversation auto-sends the prefill as its first
   * turn (exactly once), so a card's "ask about this" hand-off lands the
   * answer directly instead of only seeding the composer. Cleared on close.
   */
  autoSend: boolean;
  /**
   * Scope the next/open conversation is narrowed to (or null for the
   * default all-source snapshot). Set by `askCoach(prefill, scope)`, or
   * inherited from the page's ambient scope when the FAB opens without an
   * explicit one. `<LayoutCoachMount>` forwards it to the drawer.
   */
  scope: CoachLaunchScope | null;
  /**
   * v1.28.52 (Documents R3) — the stored document a fresh drawer chat is
   * scoped to, or null for a health chat. Set by `askCoach(..., documentId)`
   * from the vault detail sheet's "Ask the Coach" action so the conversation
   * opens in the SIDE DRAWER (not a full-page nav) pre-scoped to the document.
   * `<LayoutCoachMount>` forwards it to the drawer as `initialDocumentId`, and
   * every doc turn still routes through the hardened fenced endpoint inside
   * `<CoachConversation>`. Cleared on close alongside `prefill` / `scope`.
   */
  documentId: string | null;
  /**
   * v1.31.0 — the workout a fresh conversation is scoped to, or null. Set by
   * `askCoach(..., workoutId)` from the workout-detail "Ask why" action so the
   * first turn carries ONE bounded, numbers-only evidence section about that
   * session. Unlike `documentId` this does NOT route through the hardened
   * fenced endpoint: a workout row is the user's own structured sensor record,
   * and the server projection admits no free text (see `workout-evidence.ts`).
   * Cleared on close alongside `prefill` / `scope` / `documentId`.
   */
  workoutId: string | null;
  /**
   * Open the drawer with an optional prefill + scope hint. When `autoSend`
   * is true the prefill is dispatched as the conversation's first turn
   * automatically (used by the assessment hand-off). `documentId` scopes the
   * opened conversation to a stored document (vault "Ask the Coach");
   * `workoutId` scopes it to one workout (workout-detail "Ask why").
   */
  askCoach: (
    prefill?: string | null,
    scope?: CoachLaunchScope,
    autoSend?: boolean,
    documentId?: string | null,
    workoutId?: string | null,
  ) => void;
  /**
   * v1.21.0 (C4 H1) — register the metric surface the user is currently
   * looking at so the global FAB (which calls `askCoach()` with no args)
   * still opens the Coach pre-scoped to that page. The optional
   * `seedPrefill` is the composer opener the FAB seeds when it inherits
   * this ambient scope. Returns a cleanup that clears the ambient scope; a
   * metric page calls it from an effect so the scope lifts when the user
   * navigates away. This keeps the FAB the single app-wide entry point
   * (CCH-04) while making it contextual.
   */
  registerScope: (
    scope: CoachLaunchScope,
    seedPrefill?: string | null,
  ) => () => void;
  /**
   * Direct setter for the drawer's controlled open state. Navigation actions
   * identify themselves so the originating surface can preserve its return
   * entry; Sheet dismissals use the default `dismiss` intent.
   */
  setOpen: (next: boolean, closeIntent?: CoachCloseIntent) => void;
}

/**
 * Pure derivation of the open-state a single `askCoach(...)` call produces,
 * factored out of the provider so the precedence rules (explicit arg vs.
 * ambient scope, auto-send gating, document scoping) are unit-testable without
 * simulating React state. The provider applies the result field-by-field.
 */
export interface ResolvedLaunchState {
  prefill: string | null;
  scope: CoachLaunchScope | null;
  documentId: string | null;
  workoutId: string | null;
  autoSend: boolean;
}

export function resolveLaunchState(input: {
  nextPrefill?: string | null;
  nextScope?: CoachLaunchScope;
  nextAutoSend?: boolean;
  nextDocumentId?: string | null;
  nextWorkoutId?: string | null;
  ambientScope: CoachLaunchScope | null;
  ambientPrefill: string | null;
}): ResolvedLaunchState {
  // An explicit scope (insight card, metric-card affordance) wins; otherwise
  // inherit the metric page's ambient scope. The composer seed follows the
  // same precedence: explicit prefill, else the ambient page opener.
  const usingAmbientScope = input.nextScope === undefined;
  return {
    scope: input.nextScope ?? input.ambientScope ?? null,
    prefill:
      input.nextPrefill ??
      (usingAmbientScope ? input.ambientPrefill : null) ??
      null,
    // Auto-send only applies when an explicit prefill is given (a card
    // hand-off), never for an ambient/blank open.
    autoSend: Boolean(input.nextAutoSend) && Boolean(input.nextPrefill),
    // A document scope is always explicit (the vault "Ask the Coach" action);
    // it is never inherited from ambient page state.
    documentId: input.nextDocumentId ?? null,
    // Same rule for the workout scope — explicit only, never ambient. A metric
    // page's ambient scope must not silently pin an unrelated workout.
    workoutId: input.nextWorkoutId ?? null,
  };
}

const CoachLaunchContext = createContext<CoachLaunchValue | null>(null);

export interface CoachLaunchProviderProps {
  children: ReactNode;
}

export function CoachLaunchProvider({ children }: CoachLaunchProviderProps) {
  const [open, setOpen] = useState<boolean>(false);
  const [closeIntent, setCloseIntent] = useState<CoachCloseIntent | null>(null);
  const [prefill, setPrefill] = useState<string | null>(null);
  // Whether the next open auto-sends its prefill as the first turn.
  const [autoSend, setAutoSend] = useState<boolean>(false);
  // Scope the open conversation is narrowed to. `null` → default snapshot.
  const [scope, setScope] = useState<CoachLaunchScope | null>(null);
  // Stored-document scope of the open conversation. `null` → health chat.
  const [documentId, setDocumentId] = useState<string | null>(null);
  // Workout scope of the open conversation. `null` → no workout section.
  const [workoutId, setWorkoutId] = useState<string | null>(null);
  // Ambient scope + seed opener of the metric surface currently on screen.
  // The FAB's `askCoach()` (no args) falls back to these so opening the
  // Coach from a metric page still lands a pre-scoped, pre-seeded
  // conversation without re-adding a per-metric header icon (CCH-04). Refs,
  // not state — registering must not re-render the provider's subtree.
  const ambientScopeRef = useRef<CoachLaunchScope | null>(null);
  const ambientPrefillRef = useRef<string | null>(null);

  const askCoach = useCallback(
    (
      nextPrefill?: string | null,
      nextScope?: CoachLaunchScope,
      nextAutoSend?: boolean,
      nextDocumentId?: string | null,
      nextWorkoutId?: string | null,
    ) => {
      // v1.21.0 (C4 H1/H4) — scope is live; v1.28.52 — document scope threads
      // through so the vault "Ask the Coach" action opens the drawer scoped to
      // the document instead of a full-page nav. Precedence lives in the pure
      // `resolveLaunchState` helper so the rules stay unit-testable.
      const resolved = resolveLaunchState({
        nextPrefill,
        nextScope,
        nextAutoSend,
        nextDocumentId,
        nextWorkoutId,
        ambientScope: ambientScopeRef.current,
        ambientPrefill: ambientPrefillRef.current,
      });
      setScope(resolved.scope);
      setPrefill(resolved.prefill);
      setAutoSend(resolved.autoSend);
      setDocumentId(resolved.documentId);
      setWorkoutId(resolved.workoutId);
      setCloseIntent(null);
      setOpen(true);
    },
    [],
  );

  const registerScope = useCallback(
    (next: CoachLaunchScope, seedPrefill?: string | null) => {
      ambientScopeRef.current = next;
      ambientPrefillRef.current = seedPrefill ?? null;
      return () => {
        // Only clear if this registration is still the active one — guards
        // against a fast route change where the next page registers before
        // the previous page's cleanup runs.
        if (ambientScopeRef.current === next) {
          ambientScopeRef.current = null;
          ambientPrefillRef.current = null;
        }
      };
    },
    [],
  );

  const handleSetOpen = useCallback(
    (next: boolean, nextCloseIntent: CoachCloseIntent = "dismiss") => {
      setOpen(next);
      setCloseIntent(next ? null : nextCloseIntent);
      if (!next) {
        // Drop the prefill + scope + document + workout + auto-send on close so
        // the next open starts clean.
        setPrefill(null);
        setScope(null);
        setAutoSend(false);
        setDocumentId(null);
        setWorkoutId(null);
      }
    },
    [],
  );

  const value = useMemo<CoachLaunchValue>(
    () => ({
      open,
      closeIntent,
      prefill,
      autoSend,
      scope,
      documentId,
      workoutId,
      askCoach,
      registerScope,
      setOpen: handleSetOpen,
    }),
    [
      closeIntent,
      open,
      prefill,
      autoSend,
      scope,
      documentId,
      workoutId,
      askCoach,
      registerScope,
      handleSetOpen,
    ],
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
