/**
 * Setup for the `browser` project (`*.browser.test.tsx`, headless Chromium).
 *
 * - The app stylesheet, compiled by Vite through the project's PostCSS
 *   config, so components lay out and hide as they do in the app, under the
 *   theme class the boot script sets for a first visit (`dark`, see
 *   `src/lib/pwa/theme-color.ts`); without one no colour token resolves.
 * - The EN catalog, the fallback floor of every `t()` chain, loaded through
 *   the production loader. `renderWithApp` loads any other locale it is
 *   asked for.
 * - After every test: the real `fetch`, the real clock, the page's starting
 *   address and an empty `localStorage` come back, so a stub, a pinned date,
 *   a URL write or a remembered preference never reaches the next test. Rendered
 *   trees are unmounted by `vitest-browser-react` itself.
 */
import "@/app/globals.css";

import { afterEach, beforeAll, beforeEach, vi } from "vitest";

import { loadMessages } from "@/lib/i18n/load-locale";

import { restoreFetch } from "./fetch-stub";
import { rememberAddress, restoreAddress } from "./url";

document.documentElement.classList.add("dark");

beforeAll(async () => {
  await loadMessages("en");
});

beforeEach(() => {
  rememberAddress();
});

afterEach(() => {
  restoreFetch();
  vi.useRealTimers();
  restoreAddress();
  window.localStorage.clear();
});
