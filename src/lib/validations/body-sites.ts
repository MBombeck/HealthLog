/**
 * The body-site view query (v1.39.2).
 *
 * Without `site` the route answers with the sites the record holds, which is
 * both the view's list of choices and the suggestions a body-site field offers
 * while the person types. With `site` it also answers with what is filed at
 * that site. `site` is compared after the decrypt, case and accents folded, to
 * the whole stored site: it names a site the list offered, it is not a word
 * search (the procedures tab keeps that).
 */
import { z } from "zod/v4";

import { lateralityEnum } from "@/lib/validations/encounters";

export const bodySiteQuerySchema = z
  .object({
    site: z.string().trim().min(1).max(200).optional(),
    laterality: lateralityEnum.optional(),
  })
  .strict()
  .refine((v) => v.laterality === undefined || v.site !== undefined, {
    path: ["laterality"],
    message: "laterality narrows a site and needs one",
  });

export type BodySiteQuery = z.infer<typeof bodySiteQuerySchema>;
