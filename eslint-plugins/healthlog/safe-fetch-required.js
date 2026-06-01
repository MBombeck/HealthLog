/**
 * @fileoverview ESLint rule — outbound `fetch` must route through the
 * `safeFetch` wrapper.
 *
 * v1.5.6 — `src/lib/safe-fetch.ts` is the documented egress entry point:
 * it pins `redirect: "manual"` + an `AbortSignal.timeout` by default and
 * gates the connect-time IP pin behind `requirePublicHost`. A raw
 * `fetch(...)` call under `src/lib/` or `src/app/` bypasses every one of
 * those defences, so this rule flags it at authoring time and in CI.
 *
 * Allowed:
 *   - `safeFetch(...)`                       — the wrapper itself.
 *   - calls inside `src/lib/safe-fetch.ts`   — the wrapper's own `fetch`.
 *   - calls inside `src/lib/safe-fetch-dispatcher.ts` — the pinned dispatcher.
 *   - test files (`*.test.ts(x)`, `__tests__/`, `__mocks__/`) — they
 *     mock or assert against `fetch` directly.
 *
 * The check is a syntactic `CallExpression` match against a bare
 * `fetch(` callee (Identifier `fetch`) and `globalThis.fetch(` /
 * `window.fetch(` member forms. `safeFetch` is a distinct identifier and
 * never matches.
 *
 * Same-origin client fetches are exempt: a first argument that is a
 * string literal (or template head) starting with `/` is a relative,
 * same-origin request (`fetch("/api/…")`) that never leaves the origin
 * and has no SSRF / redirect-leak / DNS-rebinding surface. The wrapper
 * is for OUTBOUND egress to external hosts — absolute URLs or
 * variable-sourced targets — which is exactly what stays flagged.
 *
 * @see src/lib/safe-fetch.ts
 * @see src/lib/safe-fetch-dispatcher.ts
 */

"use strict";

// Files exempt from the rule — the wrapper internals and the test
// surface. Posix-style suffix matches against the absolute filename via
// `String#includes`, mirroring the queryKey-factory rule's convention.
const EXEMPT_FILES = [
  "src/lib/safe-fetch.ts",
  "src/lib/safe-fetch-dispatcher.ts",
];

// Only enforce inside the application source roots. Scripts, config, and
// generated code are out of scope.
const ENFORCED_ROOTS = ["src/lib/", "src/app/"];

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

function isEnforced(filename) {
  const posix = toPosix(filename);
  if (!ENFORCED_ROOTS.some((root) => posix.includes(root))) return false;
  if (EXEMPT_FILES.some((f) => posix.includes(f))) return false;
  if (isTestFile(posix)) return false;
  return true;
}

/** @type {import("eslint").Rule.RuleModule} */
const safeFetchRequiredRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Outbound fetch must route through the safeFetch wrapper (src/lib/safe-fetch.ts).",
    },
    schema: [],
    messages: {
      rawFetch:
        "Raw fetch() bypasses the safeFetch wrapper's manual-redirect + timeout (and requirePublicHost) defences. Import { safeFetch } from \"@/lib/safe-fetch\" and call it instead.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!filename || !isEnforced(filename)) {
      return {};
    }

    function isFetchCallee(callee) {
      // Bare `fetch(...)`.
      if (callee.type === "Identifier" && callee.name === "fetch") return true;
      // `globalThis.fetch(...)` / `window.fetch(...)` / `self.fetch(...)`.
      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier" &&
        callee.property.name === "fetch" &&
        callee.object.type === "Identifier" &&
        (callee.object.name === "globalThis" ||
          callee.object.name === "window" ||
          callee.object.name === "self")
      ) {
        return true;
      }
      return false;
    }

    function isSameOriginRelative(arg) {
      if (!arg) return false;
      // A single leading `/` not followed by `/` or `\`. `//evil.com` is a
      // protocol-relative absolute URL and `/\evil.com` normalises to the
      // same under WHATWG parsing — both resolve off-origin, so neither is
      // a same-origin path and the wrapper must still cover them.
      const isRelativeHead = (head) => /^\/(?![/\\])/.test(head);
      // `fetch("/api/…")`
      if (arg.type === "Literal" && typeof arg.value === "string") {
        return isRelativeHead(arg.value);
      }
      // `fetch(`/api/${id}`)` — inspect the template's first cooked chunk.
      if (arg.type === "TemplateLiteral" && arg.quasis.length > 0) {
        return isRelativeHead(arg.quasis[0].value.cooked ?? "");
      }
      return false;
    }

    return {
      CallExpression(node) {
        if (!isFetchCallee(node.callee)) return;
        // Exempt same-origin relative-path requests — they never leave
        // the origin, so the wrapper's outbound defences do not apply.
        if (isSameOriginRelative(node.arguments[0])) return;
        context.report({ node, messageId: "rawFetch" });
      },
    };
  },
};

module.exports = safeFetchRequiredRule;
