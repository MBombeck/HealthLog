import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import healthlogPlugin from "./eslint-plugins/healthlog/queryKey-factory.js";

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
    // v1.4.41 — ignore Claude Code session worktrees so a mid-marathon
    // worktree on an older commit can't poison `pnpm lint` locally.
    // CI never sees this path; the rule is for the dev environment.
    ".claude/**",
  ]),
  // v1.4.41 W-PROCESS-DOCS — custom rule that flags any bare-array
  // `queryKey: [ … ]` / `mutationKey: [ … ]` declaration inside the
  // files the queryKeys factory currently guards. Promotes the
  // test-guard substitute from v1.4.40 W-RSC to a real ESLint rule
  // so IDE + CI both fail fast on a factory bypass. See
  // `eslint-plugins/healthlog/queryKey-factory.js` for the
  // whitelist + rationale.
  {
    plugins: { healthlog: healthlogPlugin },
    rules: { "healthlog/queryKey-factory": "error" },
  },
]);

export default eslintConfig;
