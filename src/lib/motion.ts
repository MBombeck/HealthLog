// v1.4.43 W5-H5 — single source of truth for `behavior` on the four
// programmatic `scrollIntoView` / `scrollTo` call-sites in the app.
// `prefers-reduced-motion: reduce` users were previously animated against
// their OS-level preference, which is a WCAG 2.3.3 violation. The helper
// returns `"auto"` whenever a window is unavailable (SSR) or when the
// reduced-motion media query matches.

export function scrollBehaviorForUser(): ScrollBehavior {
  if (typeof window === "undefined") return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}
