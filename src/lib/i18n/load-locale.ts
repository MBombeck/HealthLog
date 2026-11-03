/**
 * Client-side message-bundle loading.
 *
 * NO catalog ships statically in the client chunk — not even English.
 * The static EN import that used to live here was the single largest
 * every-route client cost (334 KB raw / ~106 KB gz on every page load,
 * for every user, in every language). The t() chain (active locale →
 * EN → raw key) now resolves its bundles through three paths:
 *
 *   1. SSR pass: this module seeds its cache with the lazy server-side
 *      catalog map (`server-catalogs`) inside a `typeof window ===
 *      "undefined"` branch. Turbopack compiles the branch away for the
 *      browser bundle (verified — zero catalog bytes reach any client
 *      chunk), while the server render of every client component
 *      resolves the active locale synchronously — SSR text stays
 *      correct with nothing serialized into the flight payload (the
 *      previous RSC-prop handoff inlined the whole active catalog into
 *      EVERY document: 392 KB of a 505 KB dashboard HTML).
 *   2. First client paint: the root layout registers a versioned,
 *      immutable-cacheable `<script src="/i18n/<locale>?v=…">` through
 *      `next/script` at `beforeInteractive`, so Next's own bootstrap
 *      awaits it before requiring any app module. It assigns
 *      `self.__HL_I18N`, which `adoptBootBundle()` below folds into the
 *      cache on first read — the first client render holds the same
 *      bundle the server rendered with (no raw-key flash, no hydration
 *      mismatch), and repeat visits serve the catalog from HTTP/SW cache
 *      instead of re-downloading it inside each document.
 *   3. Locale switch / EN fallback: `loadMessages()` dynamic-imports
 *      the target bundle on demand; each locale becomes its own async
 *      chunk that only the users who need it ever download.
 *
 * The module-level cache makes repeat switches instant and lets tests
 * seed bundles directly (`primeMessages`).
 */
import { type Locale } from "./config";
import type { lazyServerCatalogs } from "./server-catalogs";

/** The SSR branch's view of `./server-catalogs` (types only; see below). */
type ServerCatalogsModule = { lazyServerCatalogs: typeof lazyServerCatalogs };

export type MessageBundle = Record<string, unknown>;

/** Shape of the boot global the /i18n/<locale> script assigns. */
interface I18nBootGlobal {
  locale?: string;
  messages?: MessageBundle;
}

const loaders: Record<Locale, () => Promise<{ default: MessageBundle }>> = {
  de: () => import("../../../messages/de.json"),
  en: () => import("../../../messages/en.json"),
  fr: () => import("../../../messages/fr.json"),
  es: () => import("../../../messages/es.json"),
  it: () => import("../../../messages/it.json"),
  pl: () => import("../../../messages/pl.json"),
  ko: () => import("../../../messages/ko.json"),
  nl: () => import("../../../messages/nl.json"),
  "pt-BR": () => import("../../../messages/pt-BR.json"),
  ru: () => import("../../../messages/ru.json"),
};

function initialCache(): Partial<Record<Locale, MessageBundle>> {
  if (typeof window === "undefined") {
    // Server pass (SSR of client components): seed every locale from the
    // server-side catalog map. The branch is dead code in the browser
    // bundle — Turbopack eliminates it together with the require, so none
    // of the six catalogs reaches a client chunk. The try/catch covers
    // non-bundled node runtimes (vitest transforms this module to ESM,
    // where a bare require of a TS module throws) — there the cache starts
    // empty and `vitest.setup.ts` primes every bundle up front.
    try {
      const { lazyServerCatalogs } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("./server-catalogs") as ServerCatalogsModule;
      // Entries load on first read, so the render loads the locales it
      // renders in, not all of them.
      return lazyServerCatalogs();
    } catch {
      return {};
    }
  }
  return {};
}

const cache: Partial<Record<Locale, MessageBundle>> = initialCache();

/**
 * Whether the boot global has already been folded into the cache. The
 * adoption is idempotent and one-way: once a bundle is in, a later call
 * must not re-copy it over a locale switch or a `primeMessages` seed.
 */
let bootAdopted = typeof window === "undefined";

/**
 * Fold `self.__HL_I18N` (assigned by the layout's boot script) into the
 * cache, at most once.
 *
 * Deliberately LAZY rather than a module-evaluation snapshot. The snapshot
 * form made correctness depend on this module being evaluated after the boot
 * script had run — an ordering that lives outside this file and, before the
 * layout moved the tag to `beforeInteractive`, did not actually hold. Reading
 * the global on demand means a boot script that lands a moment late still
 * counts, and the invariant reduces to something local and testable: whatever
 * the boot script assigns is visible to the first `t()` that asks.
 */
function adoptBootBundle(): void {
  if (bootAdopted) return;
  const boot = (self as { __HL_I18N?: I18nBootGlobal }).__HL_I18N;
  if (
    boot &&
    typeof boot.locale === "string" &&
    boot.messages &&
    typeof boot.messages === "object"
  ) {
    bootAdopted = true;
    cache[boot.locale as Locale] ??= boot.messages;
  }
}

export function getCachedMessages(locale: Locale): MessageBundle | undefined {
  adoptBootBundle();
  return cache[locale];
}

/**
 * The EN fallback floor of the t() chain, when it is already in hand —
 * always on the server, on the client once EN is the active/boot locale or
 * `loadMessages("en")` has resolved. `undefined` means "not loaded yet";
 * callers kick off the async load and re-render when it lands.
 */
export function getFallbackMessages(): MessageBundle | undefined {
  adoptBootBundle();
  return cache.en;
}

/** Seed the cache with a bundle that arrived out of band (tests, boot). */
export function primeMessages(locale: Locale, messages: MessageBundle): void {
  cache[locale] = messages;
}

export async function loadMessages(locale: Locale): Promise<MessageBundle> {
  adoptBootBundle();
  const cached = cache[locale];
  if (cached) return cached;
  const mod = await loaders[locale]();
  cache[locale] = mod.default;
  return mod.default;
}
