/**
 * @fileoverview ESLint rule — `queryKey` / `mutationKey` literal-array
 * factory enforcement across the complete client tree.
 *
 * Every TanStack key must come from `src/lib/query-keys/`. The rule flags
 * object-property `queryKey: [ … ]` and `mutationKey: [ … ]` values in
 * components, hooks, client query modules, and any source module declaring
 * top-level `"use client"`.
 *
 * Accepted call-site shapes include direct factory calls, identifiers already
 * built from the factory, and conditionals selecting factory calls. Tests and
 * the factory definition directory are exempt because they intentionally
 * construct literal fixtures and tuples.
 *
 * @see src/lib/query-keys/
 * @see src/lib/__tests__/query-keys.test.ts
 */

"use strict";

const FACTORY_HOME_DIRECTORY = "src/lib/query-keys";

// Components and hooks are client-facing by convention. Query modules are
// client-transitive even if a future refactor moves the directive to a barrel.
const CLIENT_ROOTS = ["src/components/", "src/hooks/", "src/lib/queries/"];

function toPosix(filename) {
  return filename.replace(/\\/g, "/");
}

function isTestFile(posix) {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(posix) ||
    posix.includes("/__tests__/") ||
    posix.includes("/__mocks__/")
  );
}

function isGuarded(filename, sourceCode) {
  const posix = toPosix(filename);
  if (!posix.startsWith("src/") && !posix.includes("/src/")) return false;
  if (
    posix.startsWith(`${FACTORY_HOME_DIRECTORY}/`) ||
    posix.includes(`/${FACTORY_HOME_DIRECTORY}/`)
  ) {
    return false;
  }
  if (isTestFile(posix)) return false;
  if (CLIENT_ROOTS.some((root) => posix.includes(root))) return true;
  return sourceCode.ast.body.some(
    (statement) =>
      statement.type === "ExpressionStatement" &&
      statement.directive === "use client",
  );
}

/** @type {import('eslint').Rule.RuleModule} */
const queryKeyFactoryRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow literal-array `queryKey` / `mutationKey` declarations in client modules. Use `queryKeys.<entry>()` from `src/lib/query-keys/` instead.",
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
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    if (!filename || !isGuarded(filename, sourceCode)) {
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
