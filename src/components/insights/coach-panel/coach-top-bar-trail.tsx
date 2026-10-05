"use client";

import { ChevronRight } from "lucide-react";

import { TopBarContext } from "@/components/layout/top-bar-actions";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Where the reader is, at the leading edge of the top bar on the Coach page
 * (desktop): "Coach", and the open conversation's title after it. The page
 * name is meta (muted); the current item is content (foreground, medium),
 * truncated before it would push into the toggle. On the new-chat hero the
 * trail is the page name alone.
 *
 * Not a heading: the page keeps its own (screen-reader) `<h1>`.
 */
export function CoachTopBarTrail({
  conversationTitle,
}: {
  /** The open conversation's title; null on the new-chat hero. */
  conversationTitle: string | null;
}) {
  const { t } = useTranslations();
  const page = t("nav.coach");
  return (
    <TopBarContext>
      <nav
        aria-label={t("nav.breadcrumb")}
        data-slot="coach-top-bar-trail"
        className="min-w-0"
      >
        <ol className="flex min-w-0 items-center gap-1.5 text-sm">
          {conversationTitle ? (
            <>
              <li className="text-muted-foreground shrink-0">{page}</li>
              <li aria-hidden="true" className="text-muted-foreground shrink-0">
                <ChevronRight className="size-4" />
              </li>
              <li
                aria-current="page"
                title={conversationTitle}
                className="text-foreground min-w-0 truncate font-medium"
              >
                {conversationTitle}
              </li>
            </>
          ) : (
            <li aria-current="page" className="text-foreground font-medium">
              {page}
            </li>
          )}
        </ol>
      </nav>
    </TopBarContext>
  );
}
