"use client";

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The body of a settings or import card that rests on one read: a loading
 * line while it runs, the inset read-failure row with Retry when it fails,
 * and the card's own content once it has an answer. The card and its header
 * stay painted in all three (UI standards §6 and §13), so a failed read is
 * never an empty-looking card and a default is never shown as if it were the
 * stored value.
 */
export function CardQueryBody({
  query,
  slot,
  children,
}: {
  query: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  };
  /** `data-slot` prefix of the loading line, for tests. */
  slot: string;
  children: ReactNode;
}) {
  const { t } = useTranslations();
  if (query.isError) {
    return (
      <QueryErrorRow
        inset
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.isPending) {
    return (
      <div
        className="text-muted-foreground flex min-h-11 items-center gap-2 text-sm"
        data-slot={`${slot}-loading`}
        role="status"
      >
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        {t("common.loading")}
      </div>
    );
  }
  return <>{children}</>;
}
