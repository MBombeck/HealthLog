"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  stepDay,
  toggleDay,
  useOpenDay,
} from "@/components/day/day-layer-controller";
import { useTodayKey } from "@/components/day/use-today-key";
import {
  CAPTURE_KIND_ORDER,
  CapturePicker,
  visibleCaptureKinds,
} from "@/components/layout/capture-picker";
import { openCommandPalette } from "@/components/command-palette/palette-store";
import dynamic from "next/dynamic";
import {
  isSettingsUtilityDestination,
  visibleNavDestinations,
  visibleUtilityDestinations,
} from "@/components/layout/nav-model";
import { useAuth } from "@/hooks/use-auth";
import { useNavModules } from "@/hooks/use-nav-modules";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import {
  createShortcutReader,
  resolveGoTo,
  shortcutScope,
  type ShortcutOffer,
} from "@/lib/keyboard/global-shortcuts";

/**
 * The app-wide keyboard shortcuts, mounted once by the authenticated shell
 * (never on the sign-in pages or in the setup flow, which the shell renders
 * without it).
 *
 * `g` + a key opens a page, `g p` opens or closes the day, `n` the add menu,
 * `[` / `]` step the open day, `?` the list of all of them. Which key does what, and when a key is not
 * ours, is decided in `src/lib/keyboard/global-shortcuts.ts`; this component
 * reads the page's state and carries the action out. A destination comes from
 * the same lists the navigation renders, so `g t` with the timeline module
 * off, or `g c` without an AI provider, does nothing at all.
 *
 * The account menu opens the list too (`openShortcutsHelp`), for anyone who
 * does not know there is a `?` to press.
 */

// The list is loaded the first time it opens; no page pays for it before.
const KeyboardShortcutsDialog = dynamic(
  () =>
    import("@/components/layout/keyboard-shortcuts-dialog").then(
      (m) => m.KeyboardShortcutsDialog,
    ),
  { ssr: false },
);

let helpOpen = false;
const helpListeners = new Set<() => void>();

function setShortcutsHelpOpen(open: boolean): void {
  if (helpOpen === open) return;
  helpOpen = open;
  for (const listener of helpListeners) listener();
}

function subscribeHelp(listener: () => void): () => void {
  helpListeners.add(listener);
  return () => helpListeners.delete(listener);
}

/** Open the shortcut list from anywhere inside the signed-in shell. */
export function openShortcutsHelp(): void {
  setShortcutsHelpOpen(true);
}

let captureOpen = false;
const captureListeners = new Set<() => void>();

function setCaptureOpen(open: boolean): void {
  if (captureOpen === open) return;
  captureOpen = open;
  for (const listener of captureListeners) listener();
}

function subscribeCapture(listener: () => void): () => void {
  captureListeners.add(listener);
  return () => captureListeners.delete(listener);
}

/** Open the add menu (the same picker as the bottom bar's button). */
export function openCapturePicker(): void {
  setCaptureOpen(true);
}

function useShortcutOffer(): ShortcutOffer & { canCapture: boolean } {
  const { user } = useAuth();
  const navModules = useNavModules();
  const capabilities = useRecordCapabilities();
  const { inSharedRecord, sections, recordKind, level } = capabilities;
  const manageableDomains = user?.accountAccess?.active?.manageableDomains;
  const canCapture =
    visibleCaptureKinds(capabilities, CAPTURE_KIND_ORDER, user?.modules)
      .length > 0;
  const navHrefs = useMemo(
    () =>
      visibleNavDestinations(navModules, true, inSharedRecord, sections).map(
        (d) => d.href,
      ),
    [navModules, inSharedRecord, sections],
  );
  const settingsHref = useMemo(
    () =>
      visibleUtilityDestinations({
        record: inSharedRecord
          ? { recordKind, level, manageableDomains: manageableDomains ?? [] }
          : null,
      }).find(isSettingsUtilityDestination)?.href ?? null,
    [inSharedRecord, recordKind, level, manageableDomains],
  );
  return { navHrefs, settingsHref, canCapture };
}

export function GlobalShortcuts() {
  const router = useRouter();
  const open = useSyncExternalStore(
    subscribeHelp,
    () => helpOpen,
    () => false,
  );
  const capture = useSyncExternalStore(
    subscribeCapture,
    () => captureOpen,
    () => false,
  );
  const offer = useShortcutOffer();
  const openDay = useOpenDay();
  const today = useTodayKey();

  // The listener is registered once; it reads the current state from here.
  const latest = useRef({ offer, openDay, today, router });
  useEffect(() => {
    latest.current = { offer, openDay, today, router };
  });

  useEffect(() => {
    const reader = createShortcutReader();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = reader.read(
        {
          key: event.key,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altGraph: event.getModifierState?.("AltGraph") ?? false,
          repeat: event.repeat,
          isComposing: event.isComposing,
          target: event.target,
        },
        shortcutScope(document),
        event.timeStamp,
      );
      if (action === null || action === "pending") return;
      const state = latest.current;
      switch (action.type) {
        case "go": {
          const href = resolveGoTo(action.key, state.offer);
          if (href === null) return;
          event.preventDefault();
          state.router.push(href);
          return;
        }
        case "capture":
          if (!state.offer.canCapture) return;
          event.preventDefault();
          setCaptureOpen(true);
          return;
        case "palette":
          event.preventDefault();
          openCommandPalette();
          return;
        case "help":
          event.preventDefault();
          setShortcutsHelpOpen(true);
          return;
        case "day": {
          const date = state.openDay;
          if (date === null) return;
          event.preventDefault();
          // No day after today: the layer refuses it, so the step does too.
          if (action.delta > 0 && date >= state.today) return;
          stepDay(date, action.delta);
          return;
        }
        case "day-toggle":
          if (toggleDay()) event.preventDefault();
          return;
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Leaving the shell (signing out) leaves the list closed.
      setShortcutsHelpOpen(false);
      setCaptureOpen(false);
    };
  }, []);

  // Mounted from the first open on, so the close animation still plays.
  const [helpWanted, setHelpWanted] = useState(false);
  if (open && !helpWanted) setHelpWanted(true);

  return (
    <>
      {helpWanted ? (
        <KeyboardShortcutsDialog
          open={open}
          onOpenChange={setShortcutsHelpOpen}
          offer={offer}
          canCapture={offer.canCapture}
        />
      ) : null}
      {offer.canCapture ? (
        <CapturePicker open={capture} onOpenChange={setCaptureOpen} />
      ) : null}
    </>
  );
}
