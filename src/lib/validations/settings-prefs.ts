/**
 * Request schemas for the per-user Settings preferences that are not part of
 * the account payload: the list presentation of the labs, illness and
 * checkups lists. Shared by the route and the OpenAPI registry so the wire
 * contract has one source.
 */
import { z } from "zod/v4";

import {
  MODULE_GROUPS_OPEN,
  MODULE_GROUP_BYS,
  MODULE_LIST_CATEGORY_ORDER_MAX,
  MODULE_LIST_ID_MAX,
  MODULE_LIST_KEYS,
  MODULE_LIST_ORDER_MAX,
  MODULE_LIST_VIEWS,
  MODULE_SORT_DIRS,
} from "@/lib/settings/module-list-layout";

export const moduleListLayoutPutSchema = z
  .object({
    version: z.literal(1),
    list: z.enum(MODULE_LIST_KEYS),
    view: z.enum(MODULE_LIST_VIEWS).optional(),
    order: z
      .array(z.string().min(1).max(MODULE_LIST_ID_MAX))
      .max(MODULE_LIST_ORDER_MAX)
      .optional(),
    sortDir: z.enum(MODULE_SORT_DIRS).optional(),
    groupBy: z.enum(MODULE_GROUP_BYS).optional(),
    groupsOpen: z.enum(MODULE_GROUPS_OPEN).optional(),
    categoryOrder: z
      .array(z.string().min(1).max(MODULE_LIST_ID_MAX))
      .max(MODULE_LIST_CATEGORY_ORDER_MAX)
      .optional(),
  })
  .strict();
