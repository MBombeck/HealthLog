/**
 * The browser-chrome colour of each theme: the Android address bar, the
 * installed app's title bar, and the status bar of an installed iOS app.
 *
 * Each value is the resolved `--background` of its theme in
 * `app/globals.css`, so the bar never seams against the page on a cold paint.
 * The root layout declares both as `<meta name="theme-color" media=…>` keyed on
 * the operating system's scheme, which is all a server render can know.
 *
 * The app's own theme need not be the operating system's, though: it follows
 * the system unless a person picked light or dark by hand. A phone in light
 * mode running HealthLog in a chosen dark theme then showed a light bar over a
 * dark page. `applyThemeColor` rewrites both tags to the theme the page
 * actually painted, whichever scheme the media query would pick.
 */
export const THEME_COLOR = {
  light: "#f3f2f5",
  dark: "#282a36",
} as const;

export type ThemeChoice = "dark" | "light" | "system";
export type ResolvedTheme = keyof typeof THEME_COLOR;

/** The localStorage entry every theme reader shares (app, boot script, offline page). */
export const THEME_STORAGE_KEY = "healthlog-theme";

/**
 * The stored choice, read leniently: anything other than an explicit "light"
 * or "dark" (nothing stored, "system", a value from an older build) means
 * "follow the system". Nobody is put into one theme they did not pick.
 */
export function parseThemeChoice(stored: string | null): ThemeChoice {
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** The theme a page paints for a stored choice and the device's scheme. */
export function resolveTheme(
  stored: string | null,
  systemDark: boolean,
): ResolvedTheme {
  const choice = parseThemeChoice(stored);
  if (choice !== "system") return choice;
  return systemDark ? "dark" : "light";
}

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

/**
 * The inline boot script the root layout runs before first paint. It stamps
 * the theme class (no flash of the wrong theme) and rewrites the theme-color
 * tags to that theme, which until now waited for hydration: a phone in light
 * mode running the app in dark mode showed a light status bar until React
 * caught up. The tags may stream in after the script, so it repeats the
 * rewrite once the document is parsed.
 *
 * One string literal, with the two colours written into it rather than
 * interpolated from `THEME_COLOR`: the layout's one `dangerouslySetInnerHTML`
 * then carries file-literal content and nothing is built from a value at
 * runtime. `theme-color.test.ts` runs the script and compares what it paints
 * against `THEME_COLOR` and `resolveTheme` for every stored value and device
 * scheme, so the copies cannot drift apart unnoticed.
 *
 * The storage read and the media query are guarded separately: a browser that
 * refuses storage still follows its own scheme rather than one fixed theme.
 */
export const THEME_BOOT_SCRIPT =
  '(function(){var t=null,c="dark";try{t=localStorage.getItem("healthlog-theme")}catch(e){}if(t==="light"||t==="dark"){c=t}else{try{c=window.matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light"}catch(e){}}document.documentElement.classList.add(c);var k=c==="light"?"#f3f2f5":"#282a36";function m(){var a=document.querySelectorAll(\'meta[name="theme-color"]\');for(var i=0;i<a.length;i++)a[i].setAttribute("content",k)}m();document.addEventListener("DOMContentLoaded",m)})()';
