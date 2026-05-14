---
file: 19-i18n-system.md
purpose: How the 6-locale translator works, key naming conventions, maintainership policy, and the runtime parity probe — so iOS can mirror the same locale shape and contribute keys without breaking the gate.
when_to_read: Before adding any user-facing string to web or iOS, before adding a new key, when porting a screen that needs localisation.
prerequisites: 02-server-architecture.md, 00-philosophy.md (Rule 4 — six locales)
estimated_tokens: 3100
version_anchor: v1.4.25 / sha 49f71c92
---

# i18n System — 6 Locales, Flat-File JSON, Parity Probe

## TL;DR

Six locales: `de`, `en`, `fr`, `es`, `it`, `pl`. Flat-file JSON bundles at `messages/<locale>.json`, imported on both client (`I18nProvider`) and server (`getServerTranslator`). DE + EN are hand-curated; FR / ES / IT / PL are AI-initial translations marked by a maintainership banner. Runtime parity probe (Fix-G) catches missing keys before deploy. Adding a key: edit DE + EN, draft the four others, run the probe.

---

## 1. Locale Inventory

```ts
// from src/lib/i18n/config.ts:1-15
export const locales = ["de", "en", "fr", "es", "it", "pl"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export const localeLabels: Record<Locale, string> = {
  de: "Deutsch",
  en: "English",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  pl: "Polski",
};

// W9e — locales actively maintained by Marc.
export const MAINTAINED_LOCALES: ReadonlySet<Locale> = new Set(["de", "en"]);
```

| Locale | Status | Source |
|--------|--------|--------|
| `de`   | Hand-curated (Marc's native language) | Translator authoritative |
| `en`   | Hand-curated | Translator authoritative |
| `fr`   | AI-initial, drafted from EN | Banner surfaced |
| `es`   | AI-initial, drafted from EN | Banner surfaced |
| `it`   | AI-initial, drafted from EN | Banner surfaced |
| `pl`   | AI-initial, drafted from EN | Banner surfaced |

> Promoting a locale to "maintained": add it to `MAINTAINED_LOCALES`. The banner self-hides for any locale in that set.

---

## 2. File Layout

```
messages/
├── de.json
├── en.json
├── fr.json
├── es.json
├── it.json
└── pl.json
```

Flat-file, one JSON per locale, **nested namespaces** within each file:

```json
{
  "common": { "save": "Save", "cancel": "Cancel", "add": "Add" },
  "dashboard": { "title": "Dashboard", "weightShort": "Weight" },
  "insights": { "title": "Insights", "loadError": "Failed to load insights" },
  "medications": { "back": "Back", "newIntake": "New intake" },
  …
}
```

### Deviation from spec

> Since v1.4.25 W14b: the original spec called for **per-locale subdirectories** (`messages/de/common.json`, `messages/de/dashboard.json`, …). Marc kept the flat-file shape because Webpack tree-shaking already handles per-namespace bundling at the import level, and per-file edits across 6 locales create 6× more PR noise. Document this — iOS-Claude should not "fix" it.

### Namespaces (top-level keys in each file)

```
common  doctorReport  errorBoundary  nav  auth  dashboard
measurements  mood  medications  charts  chart  comparison
insights  thresholds  onboarding  gettingStarted  trendHints
settings  admin  achievements  bugreport  notifications
i18n  targets  passwordStrength  telegram  medicationReminders
```

27 namespaces. Total keys per locale: **2 453** (parity-enforced — every locale has identical key set).

---

## 3. Key Naming Convention

```
<namespace>.<surface>.<role>[.<state>]
```

Examples:

| Key | Meaning |
|-----|---------|
| `common.save` | A "Save" button label, anywhere |
| `dashboard.weightShort` | Weight tile label on the dashboard tile strip |
| `dashboard.welcomeBackWithName` | Greeting with `{name}` parameter |
| `insights.loadError` | Error toast when comprehensive endpoint fails |
| `medications.intakeHistoryTitle` | Page title for `/medications/[id]/history` |
| `charts.colorGreen` | Hint legend label for green band |
| `trendHints.firstTrend` | "First trend after 5 readings" hint under charts |

### Rules

1. **lowerCamelCase** for keys; never `snake_case` or `kebab-case`.
2. **Shortest unambiguous form.** `dashboard.weightShort` because the dashboard tile is too narrow for "Weight in kilograms".
3. **Parameters in `{curlies}`** — `t("dashboard.welcomeBackWithName", { name: "Marc" })`.
4. **Re-use `common.*`** for verbs/nouns shared across surfaces (`common.save`, `common.cancel`, `common.add`).
5. **One key per visual phrase.** Don't compose sentences from sub-keys at runtime; translators need full context.

---

## 4. Client Translator

```tsx
// from src/lib/i18n/context.tsx (selected)
const I18nContext = createContext<I18nContextValue | null>(null);

function detectSystemLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  const browserLang = navigator.language.split("-")[0];
  return (locales as readonly string[]).includes(browserLang)
    ? (browserLang as Locale)
    : defaultLocale;
}

// useTranslations() returns { t, locale, setLocale }
```

Usage:

```tsx
const { t, locale } = useTranslations();
<h1>{t("dashboard.title")}</h1>
<p>{t("dashboard.welcomeBackWithName", { greeting: "Good morning", name: "Marc" })}</p>
```

Lookup order:

1. Cookie `healthlog-locale` (SSR-friendly so first paint matches)
2. localStorage `healthlog-locale` (client-side fallback)
3. `navigator.language` (system locale)
4. `defaultLocale` = `"en"`

Cookie wins to avoid a hydration flash.

---

## 5. Server Translator

```ts
// from src/lib/i18n/server-translator.ts:1-50
export function getServerTranslator(locale: Locale): ServerTranslator {
  return {
    locale,
    t(key, params) {
      let value = resolveKey(allMessages[locale], key);
      if (value === undefined && locale !== defaultLocale) {
        value = resolveKey(allMessages[defaultLocale], key);  // EN fallback
      }
      if (value === undefined) return key;                    // raw key fallback
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }
      return value;
    },
  };
}
```

Used by:

- API routes (refusal copy, validation error messages)
- Background jobs (notification dispatch, doctor-report PDF)
- Email templates

Locale resolution on the server uses `resolveServerLocale()` from `src/lib/i18n/server-locale.ts` — reads the cookie via Next.js `cookies()` API, falls back to the request `Accept-Language` header, then to `defaultLocale`.

---

## 6. Fallback Chain

```
        ┌──────────────────────────────┐
        │ Requested key                │
        └─────────────┬────────────────┘
                      │
                      ▼
        ┌──────────────────────────────┐
   yes  │ Exists in user's locale?     │
  ◄─────┤ (de/fr/es/it/pl)             │
        └─────────────┬────────────────┘
                      │ no
                      ▼
        ┌──────────────────────────────┐
   yes  │ Exists in `en`?              │
  ◄─────┤                              │
        └─────────────┬────────────────┘
                      │ no
                      ▼
        ┌──────────────────────────────┐
        │ Return the raw key           │
        │ (developer noticed a typo)   │
        └──────────────────────────────┘
```

Returning the raw key on a miss is **deliberate** — production renders the unstyled string `dashboard.weightShort` which is immediately visible as a bug. Silent fallback to a related key would hide the typo.

---

## 7. Maintainership Banner

```
┌─────────────────────────────────────────────────────────────────┐
│ ⚠ This locale (Français) is AI-translated. Help us improve it: │
│   open an issue at github.com/.../healthlog/issues.            │
└─────────────────────────────────────────────────────────────────┘
```

Source: `<MaintainershipBanner>` component, mounted in the auth shell, self-gates on `isMaintainedLocale(locale) === false`.

iOS port: the same banner above the tab bar (or as a one-time banner on first switch into the locale) with a tap-target opening the GitHub issues URL via `SFSafariViewController`.

---

## 8. Runtime Parity Probe (Fix-G)

Since v1.4.25 Fix-G the project has a **runtime probe** that fails CI when locales drift apart on key set:

```ts
// Conceptual contract — actual code in test suite
test("locale parity", () => {
  const enKeys = flatten(en);
  for (const locale of ["de", "fr", "es", "it", "pl"]) {
    const localeKeys = flatten(require(`messages/${locale}.json`));
    const missing = enKeys.filter((k) => !localeKeys.includes(k));
    const extra = localeKeys.filter((k) => !enKeys.includes(k));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  }
});
```

The probe fails CI if any locale is missing a key OR has an extra one. Fix-G hardened this so the probe runs as part of the unit test suite, not just the lint step — drift can't slip past a `--no-verify` push.

The W15 cleanup deleted **380 dead keys** from all 6 locales; the deferred W15 second pass (~148 keys) lands in v1.4.26.

---

## 9. Adding a Key — Recipe

> Full recipe in `18-pattern-cookbook.md`. Summary:

1. Open `messages/en.json` and `messages/de.json` side-by-side. Add the key in **both**.
2. For FR/ES/IT/PL, draft the translation from EN (DeepL → review by a native speaker if available). For Polish, prefer formal `Pan/Pani` register.
3. Run `pnpm test -- i18n-parity` (Fix-G probe) to confirm key sets match.
4. Reference the key in the component via `t("namespace.key")` — never inline `t("namespace.k" + variable)`; the probe can't trace dynamic keys.
5. Commit. The Marc-Voice CHANGELOG entry mentions only the user-visible behaviour, not "added 6 locale keys".

### Anti-patterns

| Anti-pattern | Why it breaks |
|--------------|---------------|
| `t(\`dashboard.${slug}\`)` | Probe can't statically verify the key exists |
| `t("foo.bar") + " " + t("foo.baz")` | Translators get fragments without context — German word order alone makes this wrong |
| Plural via concatenation | Use ICU MessageFormat plural rules (when needed) — currently only English-style "1 reading / N readings" via separate keys `dashboard.readingCountOne` / `dashboard.readingCountMany` |
| Hard-coded English next to `t()` calls | Either everything is i18n or nothing is — half-translated screens read worst |

---

## 10. Umlaute & Encoding

Marc's rule (memory: `feedback_umlaute_required`): "Nrnberg" is a bug. UTF-8 end-to-end through every encoding step:

| Hop | Check |
|-----|-------|
| `messages/*.json` | Saved as UTF-8 without BOM |
| Bundler | Webpack inherits the source encoding |
| HTTP response | `Content-Type: application/json; charset=utf-8` |
| Database | Postgres `client_encoding = 'UTF8'` |
| Logs | Pino encodes JSON natively |
| Emails | `Content-Type: text/html; charset=utf-8` in headers |

iOS: `JSONDecoder` and `URLSession` are UTF-8 by default. Don't override `String.Encoding.isoLatin1` anywhere. If you see "Mnchen" instead of "München", you have a `Data → String` step using a wrong encoding.

---

## 11. iOS-Side Translator

```swift
// Concept
struct Translator {
    let locale: Locale
    private let bundle: [String: Any]   // loaded from messages/<locale>.json shipped with app

    func t(_ key: String, _ params: [String: CustomStringConvertible] = [:]) -> String {
        var value = resolve(key, in: bundle) ?? resolve(key, in: enBundle) ?? key
        for (k, v) in params {
            value = value.replacingOccurrences(of: "{\(k)}", with: v.description)
        }
        return value
    }

    private func resolve(_ key: String, in bundle: [String: Any]) -> String? {
        let parts = key.split(separator: ".")
        var current: Any = bundle
        for part in parts {
            guard let dict = current as? [String: Any], let next = dict[String(part)] else {
                return nil
            }
            current = next
        }
        return current as? String
    }
}
```

Ship the same six JSON bundles inside the app's main bundle. On launch, resolve locale via `Locale.current.languageCode` and pick the matching bundle. Re-use the EN fallback rule for missing keys.

> STOP HERE if you consider Apple's `Localizable.strings`. The contract is to share the **same JSON bundles** the server reads so a key the server emits (e.g. a refusal message returned from the Coach API) renders identically to a key the iOS UI looks up locally. `Localizable.strings` would fork the source of truth.

---

## 12. Self-Test

- [ ] iOS locale switcher offers exactly the six locales above.
- [ ] EN fallback works (delete a key from `de.json` — UI falls back to EN).
- [ ] Raw-key fallback works (typo a key — UI shows the typo'd key, not crash).
- [ ] Maintainership banner visible in FR, hidden in DE/EN.
- [ ] Adding a new key without running the parity probe fails CI.
- [ ] All 2 453 keys are present in every locale (run `python3 -c "import json; …count…"` per `13-state-management.md`).
- [ ] German umlauts render correctly on every screen.
