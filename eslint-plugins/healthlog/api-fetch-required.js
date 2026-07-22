/**
 * @fileoverview ESLint rule — client-side requests must route through the
 * typed API-fetch entry points.
 *
 * A raw `fetch(...)` in a client module can hide a same-origin API request
 * behind a variable, endpoint map, or conditional. Checking only literal
 * `/api/...` arguments therefore leaves the envelope and error contract open
 * to bypass. This rule rejects every bare Fetch API call in the client surface,
 * regardless of argument shape.
 *
 * Use `apiGet` / `apiPost` / `apiPut` / `apiPatch` / `apiDelete` for envelope
 * JSON. Use `apiFetchEnvelope` when success metadata is required, and
 * `apiFetchRaw` for deliberate Response-level work such as external requests,
 * downloads, streams, beacons, or manual status branching.
 *
 * Components and hooks are client-facing by convention. Other `src/` modules
 * are guarded when they declare top-level `"use client"`; `src/lib/queries/`
 * remains an explicit client-transitive root. Server-only modules, tests,
 * mocks, and the wrapper implementation are exempt.
 *
 * @see src/lib/api/api-fetch.ts
 */

"use strict";

// Files exempt from the rule — the wrapper internals and the test
// surface. Posix-style suffix matches against the absolute filename via
// `String#includes`, mirroring the safe-fetch-required convention.
const EXEMPT_FILES = ["src/lib/api/api-fetch.ts"];

// Components and hooks are client-facing by convention. Query modules are
// client-transitive even if a future refactor moves the directive to a barrel.
const CLIENT_ROOTS = ["src/components/", "src/hooks/", "src/lib/queries/"];

function toPosix(filename) {
  return filename.replace(/\\/g, "/");
}

function isTestFile(posix) {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(posix) ||
    /\.spec\.[cm]?[jt]sx?$/.test(posix) ||
    posix.includes("/__tests__/") ||
    posix.includes("/__mocks__/")
  );
}

function isEnforced(filename, sourceCode) {
  const posix = toPosix(filename);
  if (!posix.startsWith("src/") && !posix.includes("/src/")) return false;
  if (EXEMPT_FILES.some((f) => posix.includes(f))) return false;
  if (isTestFile(posix)) return false;
  if (CLIENT_ROOTS.some((root) => posix.includes(root))) return true;
  return sourceCode.ast.body.some(
    (statement) =>
      statement.type === "ExpressionStatement" &&
      statement.directive === "use client",
  );
}

/** @type {import("eslint").Rule.RuleModule} */
const apiFetchRequiredRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Client-side requests must route through the apiFetch wrapper family (src/lib/api/api-fetch.ts).",
    },
    schema: [],
    messages: {
      rawApiFetch:
        "Raw fetch() bypasses the client request contract. Use an apiFetch envelope helper, or apiFetchRaw for deliberate Response-level/external requests.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    if (!filename || !isEnforced(filename, sourceCode)) {
      return {};
    }

    function isFetchCallee(callee) {
      // Bare `fetch(...)`.
      if (callee.type === "Identifier" && callee.name === "fetch") return true;
      // `globalThis.fetch(...)` / `window.fetch(...)` / `self.fetch(...)`,
      // including their static computed forms (`window["fetch"](...)`).
      if (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        (callee.object.name === "globalThis" ||
          callee.object.name === "window" ||
          callee.object.name === "self")
      ) {
        const propertyName =
          !callee.computed && callee.property.type === "Identifier"
            ? callee.property.name
            : callee.computed && callee.property.type === "Literal"
              ? callee.property.value
              : null;
        return propertyName === "fetch";
      }
      return false;
    }

    return {
      CallExpression(node) {
        if (!isFetchCallee(node.callee)) return;
        context.report({ node, messageId: "rawApiFetch" });
      },
    };
  },
};

module.exports = apiFetchRequiredRule;
