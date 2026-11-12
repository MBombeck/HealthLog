"use client";

import type { ListCap } from "@/lib/api/list-cap-shape";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * The line under a list the server cut at its ceiling. Renders nothing for a
 * complete list, so a surface passes the cap it read (`apiGetList`) and
 * never decides on its own whether to show it. Meta tier: one muted sentence
 * at the `text-xs` floor. `message` replaces the generic sentence where the
 * surface can say how to reach the rest (a search).
 */
export function ListCapNotice({
  cap,
  className,
  message,
}: {
  cap: ListCap | null | undefined;
  className?: string;
  message?: string;
}) {
  const { t } = useTranslations();
  if (!cap?.truncated) return null;
  return (
    <p
      data-slot="list-cap-notice"
      className={cn("text-muted-foreground text-xs", className)}
    >
      {message ?? t("common.listCapped", { count: String(cap.limit) })}
    </p>
  );
}
