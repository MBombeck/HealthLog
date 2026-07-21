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
    // v1.31.4 — ignore local tool worktrees so a worktree on another
    // commit cannot poison `pnpm lint` locally.
    // CI never sees these paths; the rules protect the dev environment.
    ".claude/**",
    ".worktrees/**",
    // The project-local ESLint rule plugin is CommonJS (require/module
    // .exports) by ESLint convention; it is not application source and
    // is not linted by the app's TypeScript ruleset.
    "eslint-plugins/**",
  ]),
  // v1.4.41 — custom rule that flags any bare-array
  // `queryKey: [ … ]` / `mutationKey: [ … ]` declaration inside the
  // files the queryKeys factory currently guards. Promotes the earlier
  // v1.4.40 test-guard substitute to a real ESLint rule so IDE + CI
  // both fail fast on a factory bypass. See
  // `eslint-plugins/healthlog/queryKey-factory.js` for the
  // whitelist + rationale.
  {
    plugins: { healthlog: healthlogPlugin },
    rules: {
      "healthlog/queryKey-factory": "error",
      // v1.5.6 — every outbound fetch under src/lib + src/app must route
      // through the safeFetch wrapper (manual-redirect + timeout, and the
      // requirePublicHost connect-time pin). The wrapper internals and
      // test files are exempt; see the rule file for the allowlist.
      "healthlog/safe-fetch-required": "error",
      // v1.16.4 — same-origin `/api/...` calls in the client surface
      // (src/components + src/app) must route through the typed apiFetch
      // wrapper (`src/lib/api/api-fetch.ts`): one `.ok` check, one
      // envelope unwrap, one ApiError shape. Wrapper internals and test
      // files are exempt; see the rule file for the allowlist.
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
      "src/components/charts/medication-compliance-chart.tsx",
      "src/components/charts/mood-chart.tsx",
      "src/components/charts/nutrient-daily-bar-chart.tsx",
      "src/components/charts/scatter-correlation-chart.tsx",
      "src/components/custom-metrics/custom-metric-chart.tsx",
      "src/components/cycle/bbt-chart.tsx",
      "src/components/insights/derived/delta-sparkline.tsx",
      "src/components/insights/intraday-pulse-chart.tsx",
      "src/components/insights/mood/mood-distribution-chart.tsx",
      "src/components/insights/mood/mood-time-of-day-chart.tsx",
      "src/components/insights/mood/mood-weekday-chart.tsx",
      "src/components/insights/sleep-stage-stacked-bar.tsx",
      "src/components/labs/lab-biomarker-chart.tsx",
      "src/components/medications/detail/efficacy/efficacy-chart.tsx",
      "src/components/medications/dose-strength-curve.tsx",
      "src/components/medications/drug-level-chart.tsx",
      "src/components/mental-health/assessment-history-chart.tsx",
      "src/components/charts/workout-hr-chart.tsx",
      "src/components/charts/workout-elevation-chart.tsx",
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
