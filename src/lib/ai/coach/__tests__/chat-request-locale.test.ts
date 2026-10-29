/**
 * The chat request bodies take every language the app ships.
 *
 * The Coach chat, the document chat and the fenced chat declared `locale` as
 * the pair de/en, so a body naming any other app language (French, Korean,
 * Brazilian Portuguese, …) was refused with 422 before the reply language was
 * ever resolved, although `resolveServerLocale` and the prompts downstream
 * carry every locale.
 */
import { describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";
import { coachChatRequestSchema } from "@/lib/ai/coach/types";
import {
  documentChatRequestSchema,
  fencedChatRequestSchema,
} from "@/lib/validations/inbound-documents";

const SCHEMAS = {
  coach: (locale: string) =>
    coachChatRequestSchema.safeParse({ message: "Hello", locale }),
  document: (locale: string) =>
    documentChatRequestSchema.safeParse({ message: "Hello", locale }),
  fenced: (locale: string) =>
    fencedChatRequestSchema.safeParse({ message: "Hello", locale }),
};

describe.each(Object.entries(SCHEMAS))("%s chat request", (_name, parse) => {
  it.each([...locales])("accepts %s", (locale) => {
    const parsed = parse(locale);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.locale).toBe(locale);
  });

  it("refuses a language the app does not ship", () => {
    expect(parse("xx").success).toBe(false);
  });
});
