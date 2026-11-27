"use client";

import { MoreHorizontal, Plus, type LucideIcon } from "lucide-react";
import { RAIL_ICONS as ICON } from "@/components/layout/destination-icons/rail";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { medicationsPrefetchIntentProps } from "@/lib/queries/prefetch-medications";
import {
  isNavDestinationActive,
  mobileMoreHubDestinations,
  type MobileMoreHubEntry,
} from "@/components/layout/nav-model";
import { isSurfaceVisible } from "@/lib/modules/surface";
import { useCallback, useMemo, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useNavModules } from "@/hooks/use-nav-modules";
import { useMounted } from "@/hooks/use-mounted";
import { isSharedRecordPathOpen } from "@/lib/navigation/shared-record";
import { MoreHubGroups } from "@/components/layout/more-hub-groups";
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
// v1.17.1 — the two always-visible flanking anchors and the "More"
// hub are now BOTH derived from the one shared destination model
// (`nav-model.ts`), the same ordered list the desktop sidebar renders.
// The bar keeps its ergonomic 5-slot shape, but the hub is computed by the
// model's `mobileMoreHubDestinations()` (feature list minus the primary
// slots; Settings and Notifications live in the top-bar menu) — so the two
// surfaces tell one story instead of two hand-curated ones that drift,
// and the headline invariant is a tested model function rather than
// inline bar logic.
// The Meds slot follows the medications module through the surface map
// (`nav:/medications`): a pinned tab over a module that is off would be a
// visible control over a notice.
const PRIMARY_LEFT: ReadonlyArray<NavLink> = [
  { href: "/", tKey: "nav.dashboard", icon: ICON.dashboard },
  { href: "/medications", tKey: "nav.medications", icon: ICON.medications },
];

// The Insights slot belongs to no module (the `insights` key is AI analysis,
// not the area), so it stays whatever the module map says; it still drops
// inside a shared record, like any destination sharing does not cover.
const PRIMARY_RIGHT: ReadonlyArray<NavLink> = [
  { href: "/insights", tKey: "nav.insights", icon: ICON.insights },
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
    visibleCaptureKinds(capabilities, CAPTURE_KIND_ORDER, user?.modules)
      .length > 0;

  // v1.17.1 — the More hub is the model-computed hub: every visible feature
  // destination that isn't a primary slot. Cycle is gated by the same flag
  // the sidebar uses, so the two surfaces gate identically.
  // The Coach entry follows the `coach` AI capability (a Coach that cannot
  // answer is not offered); the sidebar reads the same map.
  const navModules = useNavModules();
  const moreHub = useMemo<ReadonlyArray<MobileMoreHubEntry>>(
    () =>
      mobileMoreHubDestinations({
        modules: navModules,
        mounted,
        sharedRecord,
        sections,
        record: capabilities,
      }),
    [navModules, mounted, sharedRecord, sections, capabilities],
  );

  // Every slot but Home asks two things: does sharing cover it, and does its
  // module (if the surface map names one) stay on. Fail-closed until mounted,
  // so SSR and the first paint agree, then the real map applies: a missing
  // key / unloaded map keeps the slot, the gate's default-on contract.
  const primarySlotVisible = useCallback(
    (item: NavLink) => {
      // Home is pinned unconditionally — the bar always has an anchor,
      // whatever the module map or a record switch says.
      if (item.href === "/") return true;
      return (
        // v1.36.0 — the fixed slot asks the shared destination model
        // whether sharing covers it, rather than carrying its own answer:
        // Insights drops out under a switch.
        (!sharedRecord || isSharedRecordPathOpen(item.href, capabilities)) &&
        mounted &&
        isSurfaceVisible(`nav:${item.href}`, navModules)
      );
    },
    [navModules, mounted, sharedRecord, capabilities],
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
      {/* The bar's height is `--bottom-bar-height` and the home indicator
          under it `--safe-area-bottom` (globals.css), the two that make up
          `--chrome-bottom`, which `<main>`, the Coach button and the toasts
          clear. `bg-card` + `border-t` give the bar a clean edge over page
          content that scrolls under it. Below the bar the document's root
          paints the same `--card` (`--chrome-bottom-surface`), so a strip an
          installed iOS app leaves out of its layout reads as part of the
          bar. Side insets: clear of the notch held sideways. Keyboard open:
          the bar steps aside, not over the field. */}
      <nav
        aria-label={t("nav.mobileNavigation")}
        data-slot="bottom-nav"
        data-keyboard-hide=""
        className="bg-card border-border shell-desktop:hidden fixed bottom-0 left-0 z-50 w-full border-t pr-(--safe-area-right) pb-(--safe-area-bottom) pl-(--safe-area-left)"
      >
        <div className="mx-auto flex h-(--bottom-bar-height) max-w-lg items-stretch justify-around px-1">
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
                // The tour's "add" stop on a phone: the header has no add
                // button there (`dashboard-header.tsx`).
                data-tour-id="dashboard-quick-add"
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
          // `gap-0`: the grip sits flush above the header, and the grid
          // takes the header's old 16 px gap as its own top padding.
          className="shell-desktop:hidden mx-auto max-w-md gap-0 rounded-t-xl pb-[calc(var(--safe-area-bottom)+1rem)]"
          data-testid="bottom-nav-more-sheet"
        >
          <SheetHeader>
            <SheetTitle>{t("nav.moreSheetTitle")}</SheetTitle>
            <SheetDescription>{t("nav.moreSheetDescription")}</SheetDescription>
          </SheetHeader>
          <MoreHubGroups
            entries={moreHub}
            isActive={isActiveLink}
            onNavigate={() => setMoreOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
