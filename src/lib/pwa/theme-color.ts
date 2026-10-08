/**
 * The browser-chrome colour of each theme: the Android address bar, the
 * installed app's title bar, and the status bar of an installed iOS app.
 *
 * Each value is the resolved `--background` of its theme in
 * `app/globals.css`, so the bar never seams against the page on a cold paint.
 * The root layout declares both as `<meta name="theme-color" media=…>` keyed on
 * the operating system's scheme, which is all a server render can know.
 *
 * The app's own theme is not the operating system's, though: with nothing
 * stored it defaults to dark, and a person can pick light or dark by hand. A
 * phone in light mode running HealthLog in dark mode then showed a light bar
 * over a dark page. `applyThemeColor` rewrites both tags to the theme the page
 * actually painted, whichever scheme the media query would pick.
 */
export const THEME_COLOR = {
  light: "#f3f2f5",
  dark: "#282a36",
} as const;

export function applyThemeColor(
  doc: Pick<Document, "querySelectorAll">,
  resolved: keyof typeof THEME_COLOR,
): void {
  for (const meta of doc.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]',
  )) {
    meta.setAttribute("content", THEME_COLOR[resolved]);
  }
}
