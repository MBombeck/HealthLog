/**
 * @fileoverview ESLint rule — `queryKey` / `mutationKey` literal-array
 * factory enforcement.
 *
 * v1.4.41 W-PROCESS-DOCS — promoted from the test-guard substitute
 * (`src/lib/__tests__/query-keys.test.ts`, factory-bypass guard added
 * in v1.4.40 W-RSC) to a real ESLint rule. The test-guard substitute
 * stays in place as a belt-and-braces safety net for repo-walk
 * coverage of files the ESLint config might miss; this rule fires at
 * authoring time inside the IDE and at lint CI time.
 *
 * The rule flags any object-property `queryKey: [ … ]` or
 * `mutationKey: [ … ]` whose value is a bare ArrayExpression — i.e.
 * the bypass shape that drove audit-H1 in `.planning/round-v1439-
 * arch-qa-frontend.md`. Acceptable shapes:
 *
 *   - `queryKey: queryKeys.something(arg)`                — factory call
 *   - `queryKey: someLocal`                               — indirect identifier
 *   - `queryKey: cond ? queryKeys.a() : queryKeys.b()`    — conditional via factory
 *
 * Files outside `WHITELISTED_FILES` are exempt entirely — the
 * test-guard substitute holds the "guarded surface" line until a
 * future wave extends both the guard and this whitelist together.
 *
 * @see src/lib/query-keys.ts        — factory home (do not lint as offender)
 * @see src/lib/__tests__/query-keys.test.ts — test-guard substitute
 * @see .planning/phase-W-PROCESS-DOCS-v1441-report.md
 */

"use strict";

// Files that are ALLOWED to declare a literal-array queryKey. Mirrors
// the test-guard substitute's `guardedRoots` allowlist inverted: every
// file under those roots MUST use the factory, every file outside is
// exempt for now. Path matches use `String#includes` semantics against
// the absolute filename — keep entries as posix-style suffix paths.
const FACTORY_HOME_FILES = [
  // The factory definition file is allowed to declare literal keys —
  // that's the whole point of the factory.
  "src/lib/query-keys.ts",
  // The factory's own unit-test file constructs literal keys to assert
  // the factory output shape.
  "src/lib/__tests__/query-keys.test.ts",
];

// Directories under which any `queryKey: [ … ]` literal is an error.
// Extend in lockstep with the test-guard substitute's `guardedRoots`.
const GUARDED_DIRECTORIES = [
  "src/components/charts",
  "src/components/comparison",
  // v1.4.41 W-FRONTEND-FACTORY — auth + notifications migrated to the
  // factory. Mirror the test-guard's guardedRoots so IDE/lint CI fail
  // at the same boundary the unit-test walker does.
  "src/app/auth",
  "src/app/notifications",
  // v1.4.42 W3-QUERYKEY-LONGTAIL — the settings / medications /
  // admin / hooks surface is now factory-only. Every long-tail
  // bare-literal flagged by audit-H1 routes through `queryKeys.<entry>()`.
  "src/components/settings",
  "src/components/medications",
  "src/components/admin",
  "src/hooks",
];

// Individual guarded files outside the directories above.
const GUARDED_FILES = [
  "src/app/page.tsx",
  "src/hooks/use-auth.ts",
  // v1.4.41 W-FRONTEND-FACTORY — about-section migrated.
  "src/components/settings/about-section.tsx",
  // v1.4.42 W3-QUERYKEY-LONGTAIL — medications + targets pages now
  // route every read through the factory.
  "src/app/medications/page.tsx",
  "src/app/medications/[id]/history/page.tsx",
  "src/app/targets/page.tsx",
];

function isGuarded(filename) {
  // Factory home is never an offender even if it shows up under a
  // guarded directory by accident.
  for (const home of FACTORY_HOME_FILES) {
    if (filename.endsWith(home)) return false;
  }
  for (const dir of GUARDED_DIRECTORIES) {
    if (filename.includes(`/${dir}/`)) return true;
  }
  for (const file of GUARDED_FILES) {
    if (filename.endsWith(file)) return true;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const queryKeyFactoryRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow literal-array `queryKey` / `mutationKey` declarations in guarded files. Use `queryKeys.<entry>()` from `src/lib/query-keys.ts` instead.",
      recommended: false,
    },
    messages: {
      bareArray:
        "Bare-array `{{prop}}: [ … ]` bypasses the queryKeys factory. Import from `@/lib/query-keys` and call `queryKeys.<entry>()` so cache-invalidation bundles stay in lockstep.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!filename || !isGuarded(filename)) {
      return {};
    }

    function check(node) {
      // `node` is a Property like `queryKey: [ … ]`. Only flag the
      // bare ArrayExpression form — identifiers, call expressions,
      // conditional expressions, etc. are all acceptable indirection
      // through the factory.
      if (!node.value || node.value.type !== "ArrayExpression") return;

      const keyName =
        node.key.type === "Identifier"
          ? node.key.name
          : node.key.type === "Literal"
          ? node.key.value
          : null;
      if (keyName !== "queryKey" && keyName !== "mutationKey") return;

      context.report({
        node,
        messageId: "bareArray",
        data: { prop: keyName },
      });
    }

    return {
      Property: check,
    };
  },
};

module.exports = {
  rules: {
    "queryKey-factory": queryKeyFactoryRule,
  },
};
