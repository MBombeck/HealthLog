import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import plugin from "../queryKey-factory.js";

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

const rule = plugin.rules["queryKey-factory"];

ruleTester.run("queryKey-factory", rule, {
  valid: [
    {
      code: "useQuery({ queryKey: queryKeys.example(id) });",
      filename: "/repo/src/components/example.tsx",
    },
    {
      code: "const key = queryKeys.example(id); useQuery({ queryKey: key });",
      filename: "/repo/src/hooks/use-example.ts",
    },
    {
      code: 'export const example = () => ["example"];',
      filename: "/repo/src/lib/query-keys/example.ts",
    },
    {
      code: 'useQuery({ queryKey: ["fixture"] });',
      filename: "/repo/src/components/__tests__/example.test.tsx",
    },
    {
      code: 'useQuery({ queryKey: ["server-prefetch"] });',
      filename: "/repo/src/app/server-page.tsx",
    },
  ],
  invalid: [
    {
      code: 'useQuery({ queryKey: ["unguarded-component"] });',
      filename: "/repo/src/components/custom-metrics/example.tsx",
      errors: [{ messageId: "bareArray" }],
    },
    {
      code: 'useMutation({ mutationKey: ["unguarded-hook"] });',
      filename: "/repo/src/hooks/use-example.ts",
      errors: [{ messageId: "bareArray" }],
    },
    {
      code: '"use client"; useQuery({ queryKey: ["client-app"] });',
      filename: "/repo/src/app/previously-unguarded/page.tsx",
      errors: [{ messageId: "bareArray" }],
    },
    {
      code: '"use client"; useQuery({ queryKey: ["client-lib"] });',
      filename: "/repo/src/lib/client-state.tsx",
      errors: [{ messageId: "bareArray" }],
    },
  ],
});
