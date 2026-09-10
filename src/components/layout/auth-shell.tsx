"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { AchievementUnlockNotifier } from "@/components/gamification/achievement-unlock-notifier";
import { MaintainershipBanner } from "@/components/i18n/maintainership-banner";
import { LayoutCoachFab } from "@/components/insights/layout-coach-fab";
import { LayoutCoachMount } from "@/components/insights/layout-coach-mount";
import { TourLauncher } from "@/components/onboarding/tour-launcher";
import { clearCachesForSessionEnd, useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useRecordSessionTransition } from "@/hooks/use-record-session-transition";
import { useTranslations } from "@/lib/i18n/context";
import { CoachLaunchProvider } from "@/lib/insights/coach-launch-context";
// The leaf module, not the `@/lib/record-settings` barrel. This shell wraps
// every authenticated route, and the barrel also re-exports the managed
// settings-patch schemas — so one destination predicate that reads a slug
// dragged Zod, the module registry and three validation modules into the
// eager client bundle of all of them. `classification` carries a type import
// and nothing else.
import { isManageDelegateSettingsDestination } from "@/lib/record-settings/classification";
import { isDestinationInSharedRecord } from "./nav-model";
import { BottomNav } from "./bottom-nav";
import { DemoBanner } from "./demo-banner";
import { OfflineBanner } from "./offline-banner";
import { SharedRecordBanner } from "./shared-record-banner";
import { SharedRecordUnavailable } from "./shared-record-unavailable";
import { ModulePageGate } from "@/components/layout/module-page-gate";
import { isOnboardingPathname } from "@/lib/onboarding/wizard-steps";
import { RecordScopeHydrationGate } from "./record-scope-hydration-gate";
import { SidebarNav } from "./sidebar-nav";
import { TopBar } from "./top-bar";

// v1.4.27 MB6 — `/about` joins the public-path list so the GeoLite2
// CC BY-SA 4.0 attribution stays reachable for unauthenticated
// visitors. The `/about` route is already registered in `proxy.ts`
// PUBLIC_PATHS; this constant gates the client-side auth shell, and
// both lists must agree or the route round-trips through the
// sign-in redirect.
const PUBLIC_PATHS = [
  "/auth/login",
  "/auth/register",
  "/privacy",
  "/about",
  // v1.11.0 — the public clinician view renders its own standalone chrome
  // (no nav / coach / auth gate). Listed here so the shell hands it through
  // bare; the route is also in `proxy.ts` PUBLIC_PATHS so it never round-trips
  // the sign-in redirect.
  "/c/",
];

export function AuthShell({
  children,
  demoMode = false,
}: {
  children: React.ReactNode;
  /**
   * True when the instance runs with `DEMO_MODE=true` (resolved by the
   * server-side root layout). Renders the persistent demo banner above
   * the app chrome so a visitor knows mutations won't persist.
   */
  demoMode?: boolean;
}) {
  const { user, isAuthenticated, isAuthUnknown, isLoading } = useAuth();
  const { t } = useTranslations();
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const recordSessionTransition = useRecordSessionTransition();

  const isPublicPage = PUBLIC_PATHS.some((p) => pathname.startsWith(p));
  // v1.4.26 — `/privacy` is a long-form legal page that brings its own
  // header + footer. Centering it inside the public-page wrapper would
  // squash a 3000-word policy into a "login card" layout, so we let it
  // render edge-to-edge while still resolving as a public page for the
  // auth gate above.
  // v1.4.27 MB6 — `/about` follows the same shape (own header, own
  // footer, full-width body), so it joins the standalone list.
  // v1.11.0 — the clinician view (`/c/*`) renders edge-to-edge with its own
  // standalone chrome and no app shell, like the legal pages.
  const isStandalonePublicPage =
    pathname.startsWith("/privacy") ||
    pathname.startsWith("/about") ||
    pathname.startsWith("/c/");
  const isAdminPage = pathname.startsWith("/admin");
  // v1.36.0 — is this browser inside somebody else's record. Read from the
  // capability hook rather than off `accountAccess.active` directly: the shell
  // decides what to mount and the surfaces beneath it decide what to offer,
  // and the two disagreeing is the whole class of defect this hook exists to
  // close.
  const {
    inSharedRecord,
    recordKind,
    level,
    sections,
    accessRefused,
    recordSessionPending,
  } = useRecordCapabilities();
  // A shared record has a deliberately small Settings surface of its own, and
  // which routes belong to it depends on the record.
  //
  // A managed profile keeps the whole `/settings` family reaching its
  // record-aware gate: guardian configuration lives there and the gate refuses
  // per destination.
  //
  // v1.37.0 — an ordinary shared record at MANAGE reaches exactly the
  // destinations classified `manage-writable`, which today is Settings →
  // Anamnese and nothing else. That is not a widening of what a delegate may
  // do: `POST /api/allergies` and `POST /api/family-history` already resolve
  // `requireRecordAuth("manage", "profile")` and have done since the level
  // shipped. What was missing was any page from which to call them, and an
  // admitted write with no reachable caller is the half-wired state this
  // repository keeps rediscovering. Every other `/settings` path in an adult
  // share stays in the generic refusal branch, at every level.
  const settingsSlug = pathname.startsWith("/settings")
    ? (pathname.split("/")[2] ?? "")
    : null;
  const isRecordSettingsPath =
    settingsSlug !== null &&
    (recordKind === "managed" ||
      (level === "manage" &&
        isManageDelegateSettingsDestination(settingsSlug)));
  // v1.36.0 — a page reached while acting on somebody else's record that
  // sharing does not cover. The nav already drops these entries, so arriving
  // here means a bookmark or a browser back button; the panel below explains
  // it instead of letting the page paint a row of 403 error cards. Paint only
  // — every route behind these pages refuses on its own.
  const outsideSharedRecord =
    inSharedRecord &&
    !isDestinationInSharedRecord(pathname, sections) &&
    !isRecordSettingsPath;
  // The whole setup flow, not only its front door: every screen lives under
  // `/onboarding/<step>` (v1.39 C2), and an exact match here put the
  // questions inside the full app chrome, sidebar and all.
  const isOnboardingPage = isOnboardingPathname(pathname);
  const showUnlockNotifier = isAuthenticated && !isPublicPage && !!user?.id;

  // v1.9.0 — the document-level scrollbar-gutter (globals.css) is reserved
  // only for the body-scrolled shells (login / register / onboarding /
  // standalone legal pages). The authenticated branch is height-locked and
  // scrolls inside its own `<main>`, which reserves its own gutter; applying
  // the document gutter there too produced a second, never-painted gutter on
  // classic-scrollbar platforms. Flag the body-scrolled branches on `<html>`
  // so the CSS rule scopes to them.
  const isBodyScrolled = isPublicPage || isOnboardingPage;
  useEffect(() => {
    const root = document.documentElement;
    if (isBodyScrolled) {
      root.setAttribute("data-scroll", "body");
    } else {
      root.removeAttribute("data-scroll");
    }
    return () => {
      root.removeAttribute("data-scroll");
    };
  }, [isBodyScrolled]);

  // v1.25.1 — the authenticated shell keeps `<main id="main-content">`
  // mounted across every route change, so its scroll offset survives
  // navigation: scroll down in one section (e.g. Settings → Sources
  // Priority), hop to another, and the new view opens already scrolled.
  // Reset the scroll container to the top on every forward navigation.
  // A back/forward navigation skips the reset so the browser's own scroll
  // restoration stands: `popstate` arms a one-shot skip for the single
  // pathname change it triggers, and a macrotask clears the flag so it can
  // never get stuck on a later forward navigation.
  const skipNextScrollReset = useRef(false);
  useEffect(() => {
    const armSkip = () => {
      skipNextScrollReset.current = true;
      setTimeout(() => {
        skipNextScrollReset.current = false;
      }, 0);
    };
    window.addEventListener("popstate", armSkip);
    return () => window.removeEventListener("popstate", armSkip);
  }, []);

  useEffect(() => {
    if (skipNextScrollReset.current) {
      skipNextScrollReset.current = false;
      return;
    }
    const main = document.getElementById("main-content");
    if (main) {
      main.scrollTop = 0;
    }
    // Fallback for the body-scrolled shells (login / onboarding / standalone
    // legal pages) where the document, not `<main>`, owns the scroll.
    window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !isPublicPage) {
      // Session END (expired / invalidated cookie → `/api/auth/me` 401/403).
      // Wipe the in-memory query cache (the cross-user guard — the
      // QueryClient outlives the navigation on this SPA and the health-data
      // families are not user-scoped) plus the persisted IndexedDB + SW
      // caches, so nothing leaks to the next account on a shared browser.
      // Logout does the same from `useLogout`; this covers the expiry path
      // logout never runs through. Best-effort; the redirect proceeds
      // regardless.
      //
      // `isAuthUnknown` = the auth probe failed WITHOUT a session verdict
      // (offline relaunch, network blip, 5xx) and no prior-session marker
      // exists. Nothing to protect and nothing to render — send the visitor
      // to the login gate, but never run the wipe off a non-verdict: the
      // wipe on a network failure is exactly what used to destroy the
      // offline caches. (With the marker present, `isAuthenticated` holds
      // the last-known state and this branch never runs.)
      if (!isAuthUnknown) {
        clearCachesForSessionEnd(queryClient);
      }
      router.replace("/auth/login");
    }
  }, [
    isLoading,
    isAuthenticated,
    isAuthUnknown,
    isPublicPage,
    router,
    queryClient,
  ]);

  // Redirect non-admins away from /admin
  useEffect(() => {
    if (
      !isLoading &&
      isAuthenticated &&
      isAdminPage &&
      user?.role !== "ADMIN"
    ) {
      router.replace("/");
    }
  }, [isLoading, isAuthenticated, isAdminPage, user?.role, router]);

  // v1.4.22 C4 — onboarding redirect moved to proxy.ts so it lands on
  // the first server response instead of post-hydration. The proxy
  // reads the `hl_onboarding` cookie (mirrored from the DB by the auth
  // routes) and 307s to /onboarding before this shell ever paints. The
  // previous `useEffect`-based redirect caused a brief dashboard flash
  // for users with `onboardingCompletedAt === null`.

  // Public pages (login, register) — render without any nav. Resolved
  // BEFORE the auth-loading gate: a public page never needs the
  // `/api/auth/me` round-trip to paint, so blocking it on `isLoading`
  // only delayed the login form behind a spinner.
  if (isPublicPage) {
    // Long-form legal pages render edge-to-edge with their own chrome.
    if (isStandalonePublicPage) {
      return <>{children}</>;
    }
    return (
      <div className="flex h-dvh flex-col">
        {demoMode ? <DemoBanner /> : null}
        <MaintainershipBanner />
        <main
          id="main-content"
          className="flex flex-1 items-center justify-center px-4"
        >
          {children}
        </main>
      </div>
    );
  }

  // A refused record context comes FIRST, ahead of the hydration gate.
  //
  // Both used to be checked in the other order, and it mattered: the gate is a
  // bare spinner with no controls, which is right for a transition that ends on
  // its own and wrong for a state that does not. A refusal — a malformed access
  // block, or a selector pointed at a record whose grant has lapsed — reports
  // the same thing on every `/api/auth/me`, so behind the gate it renders as a
  // permanent "Loading…" with no way out. Ahead of it, the same state renders
  // the refusal door, which carries the button back to one's own record.
  //
  // Safe against the loading race by construction: every input to
  // `accessRefused` comes from a resolved account payload, so it cannot be true
  // while `isLoading` is.
  // A present but malformed access block is not the older-server case. The
  // server may still be switched, so mounting children here could fetch target
  // data under owner controls. Offer only the actor-scoped way out.
  if (accessRefused) {
    return (
      <div
        data-slot="invalid-record-access-refusal"
        className="flex min-h-dvh flex-col"
      >
        <MaintainershipBanner />
        <main className="mx-auto w-full max-w-screen-xl px-4 py-10 md:px-6">
          <SharedRecordUnavailable />
        </main>
      </div>
    );
  }

  // Every protected route waits for `/api/auth/me`, not only Settings and
  // Admin. The payload resolves the active record as well as identity, so a
  // child mounted before it could issue an actor-scoped read before the shell
  // knows that a switched record must be refused or scoped differently.
  if (
    isLoading ||
    recordSessionTransition.phase !== "ready" ||
    recordSessionPending
  ) {
    return <RecordScopeHydrationGate label={t("nav.loadingScreen")} />;
  }

  // Auth RESOLVED as unauthenticated — hold a spinner while the
  // redirect effect above replaces the route with /auth/login.
  if (!isLoading && !isAuthenticated) {
    return (
      <div className="flex h-dvh items-center justify-center" role="status">
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
        <span className="sr-only">{t("nav.loadingScreen")}</span>
      </div>
    );
  }

  // Onboarding page — minimal shell, no sidebar/nav
  if (isOnboardingPage) {
    return (
      <>
        {showUnlockNotifier && user?.id ? (
          <AchievementUnlockNotifier userId={user.id} />
        ) : null}
        <div className="flex min-h-dvh flex-col">
          <MaintainershipBanner />
          <div className="flex flex-1 items-center justify-center px-4 py-8">
            {children}
          </div>
        </div>
      </>
    );
  }

  // Authenticated — full app shell.
  //
  // v1.4.34 IW-B — the Coach launch provider lives here (not inside
  // `app/insights/layout.tsx` anymore) so every authenticated route can
  // call `askCoach()` from the same context. Pre-hoist the drawer was
  // only reachable from `/insights/**`; the dashboard hero CTA now opens
  // it without a route hop. `<LayoutCoachMount>` consumes the same
  // context to render the drawer once at the shell level.
  //
  // v1.16.8 — `<LayoutCoachFab>` joins the shell too: the floating
  // Coach launcher renders once here for every authenticated route
  // (it hides itself on `/coach` and carries the unread-nudge
  // dot). The routed insights layout no longer mounts it.
  return (
    <CoachLaunchProvider>
      {showUnlockNotifier && user?.id ? (
        <AchievementUnlockNotifier userId={user.id} />
      ) : null}
      {/*
        Keyboard-only skip link. The non-focused state has both
        `pointer-events-none` (so a mouse click in the top-left corner
        passes through to the logo behind it) AND `-translate-y-full`
        (so even an accidental tap with stylus / touch can't activate
        it). Focus restores both — the element jumps back into the
        viewport and becomes clickable.
      */}
      <nav aria-label={t("nav.skipToContent")}>
        <a
          href="#main-content"
          className="bg-primary text-primary-foreground pointer-events-none fixed top-2 left-2 z-[100] -translate-y-full rounded-md px-4 py-2 text-sm font-medium opacity-0 transition-transform focus:pointer-events-auto focus:translate-y-0 focus:opacity-100"
        >
          {t("nav.skipToContent")}
        </a>
      </nav>
      {/*
        The banner stack is PAGE-level, above the sidebar/content row, and that
        placement is the whole point rather than a detail of the markup. A
        banner is a strip about the whole window — the connection is down, this
        is somebody else's record, this instance saves nothing — and none of
        those statements is about the content column.

        Inside the column, which is where they lived until v1.36.x, each one
        pushed the top bar down while the sidebar's logo band stayed at the
        top. Both bands read `SHELL_HEADER_BAND` so they are the same height
        with the same border, and the line they draw together still broke: with
        the French maintainership strip up, the two borders sat 66.5px apart at
        768px and 61px apart at 1280px, and the full three-banner stack put them
        184.5px apart. Above the row, every banner displaces both bands by the
        same amount and the seam cannot come apart however many paint.

        The stack comes OUT of the viewport budget rather than being added on
        top of it: the outer wrapper owns the `h-dvh`, the row below takes what
        the banners leave (`min-h-0 flex-1`), and `<main>` stays the one
        vertical scroller. Measured in `e2e/chrome-header-seam-banners.spec.ts`
        at both breakpoints.
      */}
      <div className="flex h-dvh flex-col">
        {/*
          v1.4.43 QoL (M5) — `<OfflineBanner>` paints only when
          `navigator.onLine === false`. Sits above the maintainership
          banner + top bar so the connection-status hint is always
          the first chrome line a user sees in the offline branch.
        */}
        <OfflineBanner />
        {/* v1.36.0 — whose record is open. Sits directly under the
            connection strip and above everything else: a person who has
            forgotten they are switched is about to write a reading into
            somebody else's record, and no other line of chrome is worth
            seeing first. Renders nothing when the session is in its own
            account, which is every session that has never used sharing. */}
        <SharedRecordBanner />
        {/* Demo instances surface a persistent "changes are not
            saved" strip — the proxy blocks every mutation, and
            without the banner that block only surfaced as a raw API
            error after the user already filled in a form. */}
        {demoMode ? <DemoBanner /> : null}
        <MaintainershipBanner />
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <SidebarNav />
          {/* `min-w-0` lets the content column shrink below its children's
              intrinsic min width (e.g. the measurements table); without it
              the column widens past the viewport next to the sidebar and
              the whole page gains a horizontal scrollbar. Wide children
              scroll inside their own `overflow-x-auto` containers. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <TopBar />
            <main
              id="main-content"
              // `scrollbar-gutter: stable` keeps the scroll viewport's content
              // box a fixed width whether or not the vertical scrollbar is
              // painted. Without it a route / sub-tab whose body overflows
              // (e.g. the admin "Insights Quality" section) shows the bar and
              // narrows the content box, while a shorter one (e.g.
              // "Integrations") hides it and widens the box — the `mx-auto`
              // wrapper then recentres and the whole column, including the
              // admin/settings sidebar, shifts a few px sideways on every
              // toggle. Reserving the gutter holds the layout still.
              //
              // `relative` makes this element the containing block for every
              // absolutely-positioned descendant that has no nearer positioned
              // ancestor. Without it those boxes resolve against the INITIAL
              // containing block, which lives outside the scroll container, so
              // `overflow-y-auto` never clips them: their static position sits
              // wherever the flow put them and extends the DOCUMENT's
              // scrollable overflow instead, painting a second vertical scroll
              // surface beside `<main>` (UI-STANDARDS §9 one-scroll-floor).
              // The class is not hypothetical and not confined to app code. A
              // Radix `<Switch>` outside a `<form>` renders a hidden
              // `position:absolute` bubble input on the first pass and drops it
              // only once the button ref resolves, so every route carrying a
              // switch below the fold (/settings/modules is the long one) grew
              // a full-height document scrollbar for the entire pre-hydration
              // window. Anchoring the scroll container closes the escape route
              // for all of them at once instead of asking each new
              // absolutely-positioned child to remember its own wrapper.
              className="relative flex-1 [scrollbar-gutter:stable] overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom,0px))] md:pb-0"
            >
              {/*
              v1.4.33 IW9 — container normalised on `max-w-screen-xl`
              (1280 px) so dashboard / settings / admin all hit the
              same content frame. Pre-v1.4.33 the dashboard
              shell capped at `max-w-[76.8rem]` (1228 px) while the
              settings/admin shells used `max-w-screen-xl`, producing a
              52 px lateral wobble on every route switch. Same audit
              note in `.planning/round-v1433-audit-polish.md` §4.2.

              v1.16.8 — the bottom padding clears the always-on Coach
              FAB (48 px button + its offset above the bottom-nav band /
              the desktop bottom-6 anchor), so the last line of content
              can always scroll out from under the floating button.
            */}
              <div
                data-slot="main-content-wrapper"
                className="mx-auto max-w-screen-xl px-4 pt-6 pb-20 md:px-6"
              >
                {outsideSharedRecord ? (
                  <SharedRecordUnavailable />
                ) : (
                  <ModulePageGate>{children}</ModulePageGate>
                )}
              </div>
            </main>
          </div>
          <BottomNav />
        </div>
      </div>
      {/*
        The three mounts below hang off the shell rather than off a route, so
        they paint on every page the shell serves — including the unavailable
        panel, which exists to say a page is not part of what was shared. All
        three are owner-only surfaces, and all three are gated on
        `!inSharedRecord` for the same reason: Insights and the Coach were
        deliberately kept out of what sharing covers (`nav-model.ts` — the
        owner's consent for server-managed LLM egress is theirs, not
        transferable), and the tour walks an account through modules a delegate
        does not administer. Every route behind them resolves `requireAuth()`
        and refuses under a switch, so leaving them mounted offered a delegate
        a door onto seven modules that answer 403 — chat, conversation delete
        and rename, attachments, feedback, adopt, suggested actions, and a
        `POST /api/insights/coach/seen` fired by merely opening the drawer.

        Absent, not disabled: a greyed-out launcher would still say "this
        exists and does not work for you", and what is true is that it is not
        part of what this person was given.
      */}
      {!inSharedRecord && <LayoutCoachMount />}
      {/* v1.18.6 — the module-tour launcher lives at the shell level so its
          overlay survives the cross-page `router.push`es the tour makes. It
          self-gates: it only auto-opens on the dashboard for a user who has
          not finished/dismissed the tour, and otherwise renders null. Stays
          out of demo mode (the tour PATCHes `/api/onboarding/tour`, which the
          proxy blocks for demo visitors). */}
      {!demoMode && !inSharedRecord && <TourLauncher />}
      {/* v1.16.13 — the Coach FAB stays hidden in demo mode. Its send hits
          `/api/insights/chat`, which is not in the proxy's
          `DEMO_MUTATION_ALLOWLIST`, so a demo visitor who tapped it and sent
          got a raw 403. Demo is read-only by design; the FAB has no job
          here, so it's mounted only outside demo mode. */}
      {!demoMode && !inSharedRecord && <LayoutCoachFab />}
    </CoachLaunchProvider>
  );
}
