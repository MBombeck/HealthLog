import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import healthlogPlugin from "./eslint-plugins/healthlog/index.js";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Hidden top-level folders hold local worktrees and caches, and no
    // tracked code lives in one (`.github` and `.githooks` hold no JS or
    // TS). Without this `pnpm lint` walks every worktree on another commit
    // in the root, which is both slow and poisons the result.
    ".*/**",
    // The project-local ESLint rule plugin is CommonJS (require/module
    // .exports) by ESLint convention; it is not application source and
    // is not linted by the app's TypeScript ruleset.
    "eslint-plugins/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    // Third-party OCR engine copied from node_modules at prebuild/predev by
    // scripts/stage-tesseract-assets.mjs; gitignored, minified, not ours.
    "public/tesseract/**",
    // The push relay's Wallet reference and vectors, copied byte for byte
    // from healthlog-push (CC0) and pinned by hash in the test beside them.
    "src/lib/emergency-card/wallet-pass/__tests__/relay-spec/**",
  ]),
  // Factory enforcement for every client module: all components/hooks plus
  // `"use client"` app/lib modules. Tests and `src/lib/query-keys/**` own
  // literal fixtures/tuples and are exempt inside the rule.
  {
    plugins: { healthlog: healthlogPlugin },
    rules: {
      // The codebase already marks a deliberately unused binding by prefixing
      // it with an underscore — a required-but-ignored route handler argument,
      // a mock signature that has to match the real one. The rule did not know
      // that convention, so seven such bindings warned and `pnpm lint` could
      // not be read as pass/fail. Teaching it the convention is what makes a
      // real warning visible again.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "healthlog/queryKey-factory": "error",
      // v1.5.6 — every outbound fetch under src/lib + src/app must route
      // through the safeFetch wrapper (manual-redirect + timeout, and the
      // requirePublicHost connect-time pin). The wrapper internals and
      // test files are exempt; see the rule file for the allowlist.
      "healthlog/safe-fetch-required": "error",
      // Every raw fetch in the complete client surface is rejected regardless
      // of whether the endpoint is a literal, template, variable, or map
      // lookup. Envelope JSON uses the verb helpers; deliberate Response-level
      // work and non-API external calls use the explicit `apiFetchRaw` escape
      // hatch. Server-only modules, wrapper internals, and tests are exempt.
      "healthlog/api-fetch-required": "error",
      // v1.26.0 — the design-consistency wave locked the app's colour
      // vocabulary onto semantic tokens. Raw Tailwind palette utilities
      // (`text-amber-500`, `bg-green-500`, `dark:text-red-400`, …) under
      // src/components + src/app are banned so the tokenised palette can't
      // regress. v1.27.x extends the rule with two further error-level
      // checks: colour-shaped JS props carrying a raw `#hex`/`rgb(`/`hsl(`/
      // `oklch(` literal (the Recharts `color`/`stroke`/`fill` blind spot),
      // and Tailwind arbitrary-value colours (`bg-[#…]`).
      // `src/app/global-error.tsx` (renders without the token stylesheet),
      // the `themeColor` viewport metadata, and test files are exempt; see
      // the rule file.
      "healthlog/no-raw-palette-color": [
        "error",
        { checks: ["palette", "color-props", "arbitrary-value"] },
      ],
      // The semantic sweep retired every raw `*-dracula-*` utility site
      // (status meaning → success/warning/info/destructive, purple →
      // primary, pink → the --brand-pink token), so the staged warning is
      // now a hard error. `var(--dracula-*)` references in chart code are
      // token references, not utilities, and stay legal — the light-theme
      // overrides in globals.css keep them AA on both themes.
      "healthlog/no-dracula-utility": ["error", { checks: ["dracula"] }],
      // Spacing-scale discipline. Two error-clean checks: pt-/pb- on
      // CardHeader/CardContent fights the gap-based Card contract (re-opens
      // the sl-001 drift class), and an off-scale `5` step (p-5/py-5/space-y-5/
      // gap-5) on a bg-card+border shell reads denser than every sibling
      // <Card>. The shell check is scoped to the bg-card+border pair so
      // justified list-marker insets (pl-5/pl-7) and form-body rhythm never
      // trip it. Density lives on the Card itself (`gap-2 py-3 md:py-4`) or on
      // a swept `p-4 md:p-6` shell. See the rule header.
      "healthlog/spacing-scale": "error",
      // Every pg-boss queue binding under src/lib/jobs goes through
      // `createAndWork`, whose handler type is `(jobs) => Promise<JobOutcome>`.
      // A bare `boss.work(` accepts a handler that resolves to nothing, which
      // is how a swallowed failure came to read as a completed job. The rule
      // catches the omission only — a handler that returns `{ ok: true }`
      // after swallowing still passes, and its header says so.
      "healthlog/job-handler-outcome": "error",
      // The default zone is named once, in src/lib/tz/format.ts. A copy of the
      // literal anywhere else is where a user outside that zone got someone
      // else's calendar. src/lib/tz/ and test files are exempt; see the rule.
      "healthlog/no-default-zone-literal": "error",
      // A day is cut through src/lib/tz (userDayKey, dateOnlyKey,
      // dateOnlyAtNoonUtc, dayKeyAsUtcMidnight), never by slicing an ISO string or by
      // parsing a key as UTC midnight: each copy put an entry on the
      // neighbouring day for someone off UTC. A site where UTC is meant
      // carries `eslint-disable-next-line ... -- <reason>`; the rule refuses
      // a directive without one. See the rule header.
      "healthlog/no-utc-day-key": "error",
      // A comment does not open with the identifier of the work item that
      // produced it: those point into notes that never ship. A release
      // version and an issue reference may stay. The matcher is shared with
      // scripts/strip-planning-tags.mjs; see eslint-plugins/healthlog/
      // planning-tags.js for the shape and its limits.
      "healthlog/no-planning-tags": "error",
      // A number shown to a person goes through useFormatters() (or
      // makeFormatters / formatDecimal outside React), in src/components,
      // src/app, src/hooks and src/lib: toFixed() prints a full stop in every
      // language and a locale-less toLocaleString() follows the browser
      // instead of the language picked in the app. SVG path data and other
      // machine-read strings carry `eslint-disable-next-line ... -- <reason>`;
      // the rule refuses a directive without one. See the rule header.
      "healthlog/no-unlocalised-decimal": "error",
      // A card surface is a <Card> (or SettingsCard / TrendTile), never a
      // hand-rolled bg-card + border + rounded-xl (UI standards §1). The
      // files below are where a shell is the point; each says why. A new
      // exception is a reviewed change to this list, there is no inline
      // escape. See the rule header.
      "healthlog/no-raw-card-shell": [
        "error",
        {
          allow: [
            // The shell primitives themselves.
            "src/components/settings/settings-card.tsx",
            "src/components/medications/medication-detail-section.tsx",
            // The sanctioned identity surface of the dashboard (§1).
            "src/components/daily/today-hero.tsx",
            // Floating surfaces: a chart tooltip, the tour popovers, the
            // wizard's icon tile.
            "src/components/charts/chart-tooltip.tsx",
            "src/components/onboarding/tour.tsx",
            "src/components/medications/wizard/medication-wizard-dialog.tsx",
            // The chart frame: chart, skeleton and error state paint the
            // same frame so a chart never moves when it loads or fails.
            "src/components/charts/health-chart.tsx",
            "src/components/charts/chart-skeleton.tsx",
            "src/components/charts/chart-error-state.tsx",
            "src/components/charts/medication-compliance-chart.tsx",
            "src/components/insights/derived/score-trend-chart.tsx",
            "src/components/insights/intraday-pulse-chart.tsx",
            // Table frames: a clipped, unpadded border around a table.
            "src/components/medications/medication-table.tsx",
            "src/app/notifications/page.tsx",
            // Surfaces that render outside the app shell: sign-in, register,
            // claim, the key-mismatch gate.
            "src/app/auth/login/page.tsx",
            "src/app/auth/register/page.tsx",
            "src/components/auth/claim-profile.tsx",
            "src/components/auth/first-account-setup.tsx",
            "src/app/key-mismatch-page.tsx",
            // The first-run flow: full-screen steps with their own rhythm.
            "src/components/onboarding/anamnesis-card.tsx",
            "src/components/onboarding/baseline-fields.tsx",
            "src/components/onboarding/confirm-screen.tsx",
            "src/components/onboarding/done-screen.tsx",
            "src/components/onboarding/first-result-screen.tsx",
            "src/components/onboarding/getting-started-checklist.tsx",
          ],
        },
      ],
      // The action row of a card: SettingsCardActions sets its buttons'
      // height and width, so a button inside says size="sm" and carries no
      // sizing class, the row takes no layout class, align="start" holds no
      // primary action, a save button has no disk glyph, and nothing follows
      // the row (UI standards §12). See the rule header.
      "healthlog/card-action-row": "error",
      // A switch with a name is a SwitchRow (UI standards §6); a switch for
      // a whole card stands in the card header's status slot. The files
      // below hold the bare switches that remain, counted, so a new one
      // fails and one that moves over has to take its number down. See the
      // rule header.
      "healthlog/switch-row": [
        "error",
        {
          allow: {
            // Not a row: a cell of a matrix, or a list row that also holds
            // reorder, weight or remove controls.
            "src/app/notifications/page.tsx": 1,
            "src/components/settings/dashboard-layout/widget-lists.tsx": 5,
            "src/components/settings/ai/fallback-chain-card.tsx": 1,
            "src/components/settings/score-pillar-row.tsx": 1,
            "src/components/settings/thresholds-editor-section.tsx": 1,
            // A list row whose switch trades places with a pending spinner.
            "src/components/insights/coach-panel/sources-rail.tsx": 1,
            // The chart's own popover: compact 12 px rows that belong to the
            // chart frame, not to a card.
            "src/components/charts/chart-overlay-controls.tsx": 3,
            // A name that carries a FieldInfo button beside it; a button
            // cannot sit inside the label SwitchRow renders.
            "src/components/cycle/log-day-sheet.tsx": 3,
            // A secondary control in a row named by the dose time; the
            // switch's caption is not the row's name.
            "src/components/medications/scheduling/dose-window-editor.tsx": 1,
            // A compact switch inside a token table cell, under the token's
            // name; the cell is not a row of its own.
            "src/components/settings/apple-health-mirror-token.tsx": 1,
          },
        },
      ],
      // Explanatory text inside a card stands in the sanctioned hint element
      // (InfoPopover or the card's shared hint slot), so it counts against
      // the per-route explainer budget; a muted <p>/<span> with a t() call in
      // a card body is the same text in a shape nothing counts. The files
      // below hold the ones that remain, counted: a new one fails, and one
      // that moves has to take its number down. See the rule header.
      "healthlog/no-free-hint": [
        "error",
        {
          allow: {
            "src/app/insights/catalog/page.tsx": 2,
            "src/components/admin/ai-quality-section.tsx": 1,
            "src/components/admin/ai-usage-section.tsx": 1,
            "src/components/admin/api-token-overview-section.tsx": 2,
            "src/components/admin/backups-section.tsx": 1,
            "src/components/admin/central-codex-section.tsx": 2,
            "src/components/admin/coach-feedback-section.tsx": 1,
            "src/components/admin/encryption-section.tsx": 1,
            "src/components/admin/general-settings-section.tsx": 5,
            "src/components/admin/invite-tokens-section.tsx": 2,
            "src/components/admin/login-overview-section.tsx": 1,
            "src/components/admin/measurement-maintenance-card.tsx": 4,
            "src/components/admin/notification-health-card.tsx": 1,
            "src/components/admin/offhost-backups-section.tsx": 1,
            "src/components/admin/provider-health-section.tsx": 5,
            "src/components/admin/pulse-day-mean-card.tsx": 4,
            "src/components/admin/push-relay-section.tsx": 2,
            "src/components/admin/recent-audit-preview.tsx": 1,
            "src/components/admin/recovery-kit-card.tsx": 1,
            "src/components/admin/reminders-section.tsx": 3,
            "src/components/admin/system-status-section.tsx": 3,
            "src/components/admin/system-status-summary.tsx": 1,
            "src/components/admin/user-management-section.tsx": 3,
            "src/components/auth/claim-profile.tsx": 5,
            "src/components/auth/native-return-notice.tsx": 1,
            "src/components/charts/mood-chart.tsx": 1,
            "src/components/cycle/bbt-chart.tsx": 1,
            "src/components/cycle/cycle-pregnancy-banner.tsx": 1,
            "src/components/cycle/cycle-settings.tsx": 1,
            "src/components/cycle/cycle-symptom-patterns.tsx": 1,
            "src/components/cycle/predictions-panel.tsx": 1,
            "src/components/dashboard/recent-workouts-tile.tsx": 1,
            "src/components/day/since-last-visit.tsx": 1,
            "src/components/emergency-card/emergency-card-page.tsx": 1,
            "src/components/gamification/recent-achievements-card.tsx": 1,
            "src/components/illness/illness-correlation-card.tsx": 1,
            "src/components/illness/illness-episode-detail.tsx": 1,
            "src/components/illness/illness-insights-card.tsx": 3,
            "src/components/insights/breathing-screening-card.tsx": 3,
            "src/components/insights/correlation-card.tsx": 1,
            "src/components/insights/device-score-tile.tsx": 1,
            "src/components/insights/ecg-section.tsx": 1,
            "src/components/insights/glp1-plateau-note.tsx": 1,
            "src/components/insights/glucose/glucose-clinical-panel.tsx": 4,
            "src/components/insights/health-status-card.tsx": 2,
            "src/components/insights/insights-edit-mode.tsx": 2,
            "src/components/insights/medication-efficacy-summary.tsx": 1,
            "src/components/insights/metric-target-summary.tsx": 3,
            "src/components/insights/mood/mood-in-target-tile.tsx": 1,
            "src/components/insights/mood/mood-insights-breakdowns.tsx": 1,
            "src/components/insights/mood/mood-prognosis-card.tsx": 4,
            "src/components/insights/mood/mood-stability-tile.tsx": 1,
            "src/components/insights/nutrients/energy-balance-card.tsx": 3,
            "src/components/insights/nutrients/hydration-card.tsx": 1,
            "src/components/insights/nutrients/micronutrients-card.tsx": 2,
            "src/components/insights/nutrients/single-nutrient-card.tsx": 1,
            "src/components/insights/recovery/device-recovery-block.tsx": 1,
            "src/components/insights/recovery/resilience-tile.tsx": 1,
            "src/components/insights/rhythm-events-card.tsx": 1,
            "src/components/insights/sleep-stage-stacked-bar.tsx": 2,
            "src/components/insights/sleep/average-sleep-card.tsx": 1,
            "src/components/insights/sleep/chronotype-card.tsx": 4,
            "src/components/insights/workout-detail/day-context.tsx": 4,
            "src/components/insights/workout-detail/hr-section.tsx": 2,
            "src/components/insights/workout-detail/route-map.tsx": 1,
            "src/components/insights/workout-detail/stats.tsx": 1,
            "src/components/labs/lab-biomarker-detail.tsx": 1,
            "src/components/labs/lab-list-rows.tsx": 1,
            "src/components/medications/card-parts/medication-card-body.tsx": 1,
            "src/components/medications/detail/efficacy/efficacy-tab.tsx": 1,
            "src/components/medications/intake-history-list-v2.tsx": 3,
            "src/components/mental-health/assessment-result.tsx": 6,
            "src/components/mental-health/crisis-card.tsx": 1,
            "src/components/provenance/source-provenance-view.tsx": 5,
            "src/components/records/profile-summary.tsx": 2,
            "src/components/records/screening-hints-card.tsx": 1,
            "src/components/seizures/quick-log-card.tsx": 1,
            "src/components/seizures/seizure-summary.tsx": 2,
            "src/components/seizures/seizures-view.tsx": 1,
            "src/components/settings/about-section.tsx": 1,
            "src/components/settings/access/grant-invite-card.tsx": 6,
            "src/components/settings/access/record-activity-card.tsx": 1,
            "src/components/settings/account-section/index.tsx": 7,
            "src/components/settings/ai/ai-consent-card.tsx": 1,
            "src/components/settings/ai/ai-usage-card.tsx": 3,
            "src/components/settings/ai/auto-read-card.tsx": 2,
            "src/components/settings/ai/coach-budget-card.tsx": 2,
            "src/components/settings/ai/fallback-chain-card.tsx": 1,
            "src/components/settings/api-endpoints-card.tsx": 2,
            "src/components/settings/care-calendar-feed-card.tsx": 1,
            "src/components/settings/coach-memory-section.tsx": 1,
            "src/components/settings/coach-reminders-section.tsx": 1,
            "src/components/settings/dashboard-layout-section.tsx": 1,
            "src/components/settings/environment-section.tsx": 7,
            "src/components/settings/insights-pill-order-section.tsx": 1,
            "src/components/settings/layout-section.tsx": 1,
            "src/components/settings/mcp-section.tsx": 2,
            "src/components/settings/medicine-registry-card.tsx": 1,
            "src/components/settings/ntfy-card.tsx": 1,
            "src/components/settings/nutrient-intake-card.tsx": 2,
            "src/components/settings/privacy-section.tsx": 1,
            "src/components/settings/report-schedule-card.tsx": 1,
            "src/components/settings/report-selection/selection-panel.tsx": 1,
            "src/components/settings/score-section.tsx": 2,
            "src/components/settings/security-section/security-keys-card.tsx": 1,
            "src/components/settings/security-section/totp-card.tsx": 1,
            "src/components/settings/security-sessions-card.tsx": 1,
            "src/components/settings/sharing-section.tsx": 1,
            "src/components/settings/sources-section.tsx": 5,
            "src/components/settings/trusted-devices-card.tsx": 2,
            "src/components/settings/web-push-card.tsx": 2,
            "src/components/settings/webhook-card.tsx": 1,
            "src/components/settings/who-has-access-card.tsx": 1,
            "src/components/symptoms/symptoms-section.tsx": 1,
            "src/components/timeline/timeline-chronicle.tsx": 1,
            "src/components/workouts/training-load-card.tsx": 3,
          },
        },
      ],
      // Text sizes come from the type scale: no arbitrary text-[<length>],
      // text-2xs is the one step below text-xs. Labels are sentence case;
      // `uppercase` stays on the nav group labels alone, which are the
      // files below (the rail, its phone counterpart the More hub, and the
      // settings and admin navigation). See the rule header.
      "healthlog/type-scale": [
        "error",
        {
          allowUppercaseIn: [
            "src/components/layout/rail-nav-groups.tsx",
            "src/components/layout/more-hub-groups.tsx",
            "src/components/settings/settings-shell.tsx",
            "src/components/settings/settings-mobile-nav.tsx",
            "src/components/admin/admin-shell.tsx",
          ],
        },
      ],
      // Layer direction: src/lib never imports src/components or src/app, and
      // a "use client" file makes no value import of the database client,
      // crypto, the Prisma client entry, the job queue, pg or next/headers.
      // The files below still import upward; each says why it has not moved.
      // A listed file that stops importing upward fails until it is removed,
      // so the map only shrinks. See the rule header.
      "healthlog/import-boundaries": [
        "error",
        {
          allow: {
            "src/lib/insights/metric-catalog.ts":
              "reads SUB_PAGE_TABS, which is declared inside the client tab strip component together with its labels and order",
            "src/lib/insights/target-adjust-context.tsx":
              "a React provider that renders TargetEditSheet; it belongs under components but has importers across 21 insight pages",
            "src/lib/errors/error-toast.tsx":
              "a React toast renderer that renders ErrorIdLine; it belongs under components but is imported by most client surfaces",
            "src/lib/module-list-prefs.ts":
              "a client hook module that raises the shared outcome toast; it moves with the module list settings surface",
          },
        },
      ],
    },
  },
  // v1.28.17 — every recharts-rendering component funnels through the
  // shared `chart-runtime.ts` barrel (see its file header): pointing N
  // `next/dynamic` boundaries at N different modules mints a separate
  // ~312 KB recharts chunk per boundary, a regression the project already
  // paid for once. Direct `from "recharts"` imports outside the barrel's
  // own static import graph previously only tripped the bundle-budget
  // gate at PR-CI; this rule catches the same mistake at local lint,
  // mirroring how `healthlog/safe-fetch-required` scopes its own
  // wrapper-internals exemption by file list.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/components/charts/chart-runtime.ts",
      "src/components/admin/host-metrics-chart.tsx",
      "src/components/charts/health-chart.tsx",
      // HealthChart's plot layers, imported by health-chart.tsx alone, so
      // they sit inside the same chart-runtime graph.
      "src/components/charts/health-chart/chart-layers.tsx",
      "src/components/charts/medication-compliance-chart.tsx",
      // MoodChart's plot, imported by mood-chart.tsx alone.
      "src/components/charts/mood-chart/plot.tsx",
      "src/components/charts/nutrient-daily-bar-chart.tsx",
      "src/components/charts/scatter-correlation-chart.tsx",
      "src/components/custom-metrics/custom-metric-chart.tsx",
      "src/components/cycle/bbt-chart.tsx",
      "src/components/insights/derived/delta-sparkline.tsx",
      "src/components/insights/intraday-pulse-chart.tsx",
      "src/components/insights/mood/mood-dimension-trends.tsx",
      "src/components/insights/mood/mood-distribution-chart.tsx",
      "src/components/insights/mood/mood-time-of-day-chart.tsx",
      "src/components/insights/mood/mood-weekday-chart.tsx",
      "src/components/insights/sleep-stage-stacked-bar.tsx",
      "src/components/insights/sleep/sleep-hypnogram-chart.tsx",
      "src/components/labs/lab-biomarker-chart.tsx",
      "src/components/medications/detail/efficacy/efficacy-chart.tsx",
      "src/components/medications/dose-strength-curve.tsx",
      "src/components/medications/drug-level-chart.tsx",
      "src/components/mental-health/assessment-history-chart.tsx",
      "src/components/charts/workout-hr-chart.tsx",
      "src/components/charts/workout-elevation-chart.tsx",
      "src/components/insights/coach-panel/result-chart.tsx",
      "src/components/insights/derived/score-trend-chart.tsx",
      // Browser tests draw a chart with Recharts itself to pin what it lays
      // out; a test file is never bundled, so it mints no chunk.
      "src/**/*.browser.test.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "recharts",
              message:
                "Import chart components through @/components/charts/chart-runtime (the shared dynamic-import barrel), not recharts directly — a second static import mints a duplicate recharts chunk. Add the component to chart-runtime.ts's export list if it's a new chart.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
