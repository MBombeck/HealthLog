"use client";

import {
  Home,
  Lightbulb,
  MoreHorizontal,
  Pill,
  Plus,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { medicationsPrefetchIntentProps } from "@/lib/queries/prefetch-medications";
import {
  isNavDestinationActive,
  isDestinationInSharedRecord,
  mobileMoreHubDestinations,
} from "@/components/layout/nav-model";
import type { ModuleKey } from "@/lib/modules/registry";
import { useCallback, useMemo, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  CAPTURE_KIND_ORDER,
  CapturePicker,
  visibleCaptureKinds,
} from "@/components/layout/capture-picker";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

interface NavLink {
  href: string;
  tKey: string;
  icon: LucideIcon;
}

// v1.12.x — iOS-parity bottom bar (additive middle-path).
//
// The mobile bar is a 5-slot shape: Home · Meds · Log(center) ·
// Insights · More — mirroring the native client. The center slot is a
// capture ACTION (not a destination): it opens a picker that routes to
// the existing measurement / medication / mood quick-entry surfaces
// (see `<CapturePicker>`).
//
// v1.17.1 (F-1) — the two always-visible flanking anchors and the "More"
// hub are now BOTH derived from the one shared destination model
// (`nav-model.ts`), the same ordered list the desktop sidebar renders.
// The bar keeps its ergonomic 5-slot shape, but the hub is computed by the
// model's `mobileMoreHubDestinations()` (feature list minus the primary
// slots, plus the shared utility tail) — so the two surfaces tell one story
// instead of two hand-curated ones that drift, and the headline invariant
// is a tested model function rather than inline bar logic.
// The Meds slot is module-gated exactly like the Insights slot below:
// `/medications` renders nothing when the medications module is off, so a
// pinned tab would be a visible control over a blank page.
const PRIMARY_LEFT: ReadonlyArray<NavLink & { requiresModule?: ModuleKey }> = [
  { href: "/", tKey: "nav.dashboard", icon: Home },
  {
    href: "/medications",
    tKey: "nav.medications",
    icon: Pill,
    requiresModule: "medications",
  },
];

// v1.18.0 — the Insights primary slot is module-gated. Insights is now a
// toggleable module (`requiresModule: "insights"` in the shared nav model),
// so the fixed slot must respect the same per-user map the More hub already
// honours rather than pinning a destination the account turned off. When
// insights is disabled the slot is dropped (it is excluded from the More hub
// by `BOTTOM_NAV_PRIMARY_SLOT_HREFS`, so a disabled module is hidden
// everywhere, not relocated). Fail-open: a missing key / unloaded map keeps
// the slot, mirroring the gate's default-on contract.
const PRIMARY_RIGHT: ReadonlyArray<NavLink & { requiresModule?: ModuleKey }> = [
  {
    href: "/insights",
    tKey: "nav.insights",
    icon: Lightbulb,
    requiresModule: "insights",
  },
];

export function BottomNav() {
  const pathname = usePathname();
  const { t } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  // v1.16.7 — touch intent on the medications tab starts the list
  // request before the navigation commits (see sidebar-nav).
  const medsIntent = medicationsPrefetchIntentProps(queryClient);
  const [moreOpen, setMoreOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);

  // The module map rides the client-only `/api/auth/me` query, so it is not
  // settled on SSR or the first client paint. Gating the module filter behind
  // `useMounted()` keeps SSR and first paint identical and stops a disabled
  // module from flickering into the hub / primary slot before the query
  // resolves (the #418-class divergence); once mounted the real map applies.
  const mounted = useMounted();
  // v1.36.0 — acting on somebody else's record. Same gate as the sidebar, from
  // the same resolved payload, so the two bars cannot disagree about what a
  // delegate is offered.
  const capabilities = useRecordCapabilities();
  const { inSharedRecord: sharedRecord, sections } = capabilities;
  // The capture button opens the picker, so it shows exactly when the picker
  // would offer at least one kind — the same per-section rule, asked once.
  const canCapture =
    visibleCaptureKinds(capabilities, CAPTURE_KIND_ORDER).length > 0;

  // v1.17.1 (F-1) — the More hub is the model-computed hub: every visible
  // feature destination that isn't a primary slot, plus the shared utility
  // tail. Cycle is gated by the same flag the sidebar uses, so the two
  // surfaces gate identically and cannot drift.
  const moreHub = useMemo<ReadonlyArray<NavLink>>(
    () =>
      mobileMoreHubDestinations({
        modules: user?.modules,
        mounted,
        sharedRecord,
        sections,
      }),
    [user?.modules, mounted, sharedRecord, sections],
  );

  // v1.18.0 — drop a module-gated primary slot (Insights) when the account
  // has that module disabled. Fail-closed until mounted (so a disabled
  // Insights never flickers in), then the real map applies: a missing key /
  // unloaded map keeps the slot, mirroring the gate + More-hub default-on
  // contract.
  const primarySlotVisible = useCallback(
    (item: NavLink & { requiresModule?: ModuleKey }) => {
      // An ungated slot (Home) is pinned unconditionally — the bar always
      // has an anchor, whatever the module map or a record switch says.
      if (!item.requiresModule) return true;
      return (
        // v1.36.0 — the fixed slot asks the shared destination model
        // whether sharing covers it, rather than carrying its own answer:
        // Insights is an AI surface and drops out under a switch.
        (!sharedRecord || isDestinationInSharedRecord(item.href, sections)) &&
        mounted &&
        user?.modules?.[item.requiresModule] !== false
      );
    },
    [user?.modules, mounted, sharedRecord, sections],
  );

  // Both fixed flanks run through the ONE slot filter, so a module-gated
  // tab (Meds left, Insights right) is dropped — not relocated — when the
  // account turned its module off, matching the More hub's exclusion.
  const primaryLeft = useMemo(
    () => PRIMARY_LEFT.filter(primarySlotVisible),
    [primarySlotVisible],
  );
  const primaryRight = useMemo(
    () => PRIMARY_RIGHT.filter(primarySlotVisible),
    [primarySlotVisible],
  );

  function isActiveLink(href: string) {
    return isNavDestinationActive(href, pathname);
  }

  // The "More" entry is treated as active when any of its children
  // is the current page — gives the user a clue that they've drilled
  // into a sub-route via the hub.
  const moreActive = moreHub.some((item) => isActiveLink(item.href));

  function renderPrimary(item: NavLink) {
    const isActive = isActiveLink(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-label={t(item.tKey)}
        aria-current={isActive ? "page" : undefined}
        {...(item.href === "/medications" ? medsIntent : {})}
        // Touch target sized to WCAG 2.5.5 (44×44 CSS px). The
        // outer min-h-11 min-w-11 is the actual hit area; the icon
        // stays visually centered at 20px so the design doesn't shift.
        className={cn(
          "focus-visible:ring-ring/50 relative flex min-h-11 min-w-11 flex-1 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
          isActive
            ? "text-primary"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <item.icon className="h-5 w-5" />
        {isActive && (
          <span className="bg-primary absolute bottom-1.5 h-1 w-1 rounded-full" />
        )}
      </Link>
    );
  }

  return (
    <>
      {/* v1.4.33 F14 — bar height and safe-area defence so the bar can
          never overlap the last viewport line of scrollable page content.
          `min-h-16` floors the bar at 64px; `pb-[env(safe-area-inset-bottom)]`
          reserves the home-indicator inset on iOS / iPadOS PWA installs;
          `bg-card` + `border-t` give the bar a clean visual edge so page
          content that scrolls under the bar is occluded, not bleeding
          through. */}
      <nav
        aria-label={t("nav.mobileNavigation")}
        className="bg-card border-border fixed bottom-0 left-0 z-50 min-h-16 w-full border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
      >
        <div className="mx-auto flex h-16 max-w-lg items-stretch justify-around px-1">
          {primaryLeft.map(renderPrimary)}

          {/* Center capture action — a labeled button (NOT a link) that
              opens the capture picker. Elevated as a Floating-Action-
              Button: it sits larger than the flanking tabs (h-14 = 56px,
              well above the 44px tap-target floor), lifts above the bar
              with a negative top margin, and carries a filled-primary
              collar (a `bg-card` ring that punches it out of the bar) plus
              a stronger shadow so it reads as the bar's primary CTA rather
              than a fifth flush tab. */}
          {/* v1.36.x — a read-only delegate has nothing to capture: every
              surface behind the picker is refused for them, so the bar's
              primary CTA goes rather than opening onto an empty sheet. At
              WRITE the picker itself drops the kinds the grant excludes. */}
          <div className="flex flex-1 items-center justify-center">
            {canCapture && (
              <button
                type="button"
                aria-label={t("nav.capture.title")}
                aria-haspopup="dialog"
                aria-expanded={captureOpen}
                onClick={() => setCaptureOpen(true)}
                data-testid="bottom-nav-capture"
                className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/70 ring-card -mt-5 flex h-14 w-14 items-center justify-center rounded-full shadow-lg ring-4 transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                <Plus className="h-7 w-7" />
              </button>
            )}
          </div>

          {primaryRight.map(renderPrimary)}

          <button
            type="button"
            aria-label={t("nav.more")}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-current={moreActive ? "page" : undefined}
            onClick={() => setMoreOpen(true)}
            className={cn(
              "focus-visible:ring-ring/50 relative flex min-h-11 min-w-11 flex-1 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
              moreActive
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            data-testid="bottom-nav-more"
          >
            <MoreHorizontal className="h-5 w-5" />
            {moreActive && (
              <span className="bg-primary absolute bottom-1.5 h-1 w-1 rounded-full" />
            )}
          </button>
        </div>
      </nav>

      <CapturePicker open={captureOpen} onOpenChange={setCaptureOpen} />

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          // The sheet auto-sizes to its content; padding-bottom respects
          // the iOS safe area so the inner buttons stay reachable above
          // the home-indicator on iPhone-X-class devices.
          className="mx-auto max-w-md rounded-t-xl pb-[calc(env(safe-area-inset-bottom)+1rem)] md:hidden"
          data-testid="bottom-nav-more-sheet"
        >
          <SheetHeader>
            <SheetTitle>{t("nav.moreSheetTitle")}</SheetTitle>
            <SheetDescription>{t("nav.moreSheetDescription")}</SheetDescription>
          </SheetHeader>
          {/* v1.22.1 — tighten the grid gutters (`px-3`) so each tile claims a
              little more width on a 320 px phone; the long single-word labels
              (de "Benachrichtigungen") then have room to break onto a clean
              second line instead of clipping the last character at the tile
              edge. */}
          <div className="grid grid-cols-2 gap-2 px-3 pb-4">
            {moreHub.map((item) => {
              const isActive = isActiveLink(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  aria-current={isActive ? "page" : undefined}
                  // v1.12 — `min-h-14` matches the capture-picker tiles so
                  // the equivalent tappable rows share one height at this
                  // tier (and the larger row is a more comfortable target).
                  // v1.22.1 — trim the inner padding/gap (`px-3`, `gap-2.5`)
                  // to hand the label more horizontal room without changing
                  // the shared tile height.
                  className={cn(
                    "border-border flex min-h-14 items-center gap-2.5 rounded-lg border px-3 py-3 transition-colors",
                    isActive
                      ? "text-primary bg-primary/5"
                      : "text-foreground hover:bg-accent/40",
                  )}
                >
                  <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  {/* v1.18.10 (W10) — show the FULL label, never an ellipsis
                      that hides meaning. The W7 `truncate` clipped long words
                      ("Benachrichtigungen" → "Benachrichtigun…"); the goal is a
                      readable label, not a balanced tile. Shrink the type to
                      `text-xs` so long single-word locales (de/es/fr/it) fit on
                      one line where they can, and allow a 2-line `line-clamp-2`
                      fallback (with `[overflow-wrap:anywhere]` so a long word
                      breaks rather than overflowing) for the rare label that
                      still cannot fit one line. `min-w-0` lets the flex child
                      shrink below its content width. v1.22.1 — with the wider
                      text area above, "Benachrichtigungen" wraps fully inside
                      two lines down to a 320 px viewport. */}
                  <span
                    className="line-clamp-2 min-w-0 text-xs leading-tight font-medium [overflow-wrap:anywhere]"
                    title={t(item.tKey)}
                  >
                    {t(item.tKey)}
                  </span>
                </Link>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
