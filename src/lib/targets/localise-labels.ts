/**
 * Word the target labels of an `/api/insights/targets` body in the reader's
 * language.
 *
 * The builders write a catalog key into `label`; the body is cached per
 * record, so the language is applied here, per request, after the cache.
 * `classification.category` and `source` stay canonical: the clients key
 * their own wording and colour off them.
 *
 * Server only: the translator reads the message catalogs from disk.
 */
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { TargetItem } from "./types";

export function localiseTargetLabels<T extends { targets: TargetItem[] }>(
  body: T,
  locale: Locale,
): T {
  const { t } = getServerTranslator(locale);
  return {
    ...body,
    targets: body.targets.map((item) => ({ ...item, label: t(item.label) })),
  };
}
