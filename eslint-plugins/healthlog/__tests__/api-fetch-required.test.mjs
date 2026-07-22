import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../api-fetch-required.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("api-fetch-required", rule, {
  valid: [
    {
      code: "apiGet(endpoint); apiFetchRaw(externalUrl);",
      filename: "/repo/src/components/example.tsx",
    },
    {
      code: 'fetch("/api/server-prefetch");',
      filename: "/repo/src/app/server-page.tsx",
    },
    {
      code: 'fetch("https://example.test/data");',
      filename: "/repo/src/lib/server-only.ts",
    },
    {
      code: "fetch(path, init);",
      filename: "/repo/src/lib/api/api-fetch.ts",
    },
    {
      code: 'fetch("/api/mock");',
      filename: "/repo/src/components/__tests__/example.test.tsx",
    },
  ],
  invalid: [
    {
      code: "fetch(endpoint);",
      filename: "/repo/src/components/example.tsx",
      errors: [{ messageId: "rawApiFetch" }],
    },
    {
      code: "window.fetch(`/api/${id}`);",
      filename: "/repo/src/components/example.tsx",
      errors: [{ messageId: "rawApiFetch" }],
    },
    {
      code: 'globalThis.fetch("https://example.test/data");',
      filename: "/repo/src/hooks/use-example.ts",
      errors: [{ messageId: "rawApiFetch" }],
    },
    {
      code: '"use client"; self.fetch(url);',
      filename: "/repo/src/app/client-page.tsx",
      errors: [{ messageId: "rawApiFetch" }],
    },
    {
      code: '"use client"; fetch(endpoint);',
      filename: "/repo/src/lib/i18n/context.tsx",
      errors: [{ messageId: "rawApiFetch" }],
    },
    {
      code: 'window["fetch"](endpoint);',
      filename: "/repo/src/components/example.tsx",
      errors: [{ messageId: "rawApiFetch" }],
    },
  ],
});
