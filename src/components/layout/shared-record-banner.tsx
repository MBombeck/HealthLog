"use client";

import { Eye, Loader2, LogOut } from "lucide-react";

import { useAccountSwitch } from "@/hooks/use-account-switch";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { resolveRecordPresentation } from "@/lib/navigation/record-presentation";
import { accountLabel } from "@/lib/sharing/account-access-view";

/**
 * v1.36.0 — the strip that says whose record is open.
 *
 * This is the feature, not decoration around it. A caregiver who forgets they
 * are switched will log their own blood pressure into somebody else's record,
 * and there is no undo for a reading that was never theirs. So the banner
 * states three things in one line — that this is not your record, whose it is,
 * and what sharing level applies — and carries the way out beside them.
 *
 * ## Why it looks like this
 *
 * Loud on purpose, within the token system. `bg-warning/15` + `border-warning/40`
 * puts it in the one visual register the app reserves for "something about this
 * screen is not normal", above the offline strip and the demo strip in the
 * shell so it is the first line of chrome under any circumstance. Not
 * `destructive` — nothing is broken and nothing is at risk of being lost;
 * warning is the honest register for a context the user has to hold in mind.
 * Not a tint on the page background either: a subtle wash is exactly what
 * somebody stops seeing after the third switch, and the failure mode here is
 * a person who has stopped noticing.
 *
 * The name and qualifier both use `text-foreground`: the warning wash is too
 * dark for the muted token at this text size, while the foreground token keeps
 * the context legible at the same contrast floor as the name.
 *
 * The row is the inline-action shape from ui-standards.md §11 rather than a
 * centred wrapping stack: sentence `min-w-0 flex-1`, action `shrink-0`, so the
 * way out stays beside the sentence instead of dropping onto its own line once
 * the name is long. `<MaintainershipBanner>` is the sibling that already had an
 * action and already had this shape; the two now read the same. The tap target
 * carries the standard's floor (`min-h-11 sm:min-h-9`) — a person leaving
 * somebody else's record on a phone is the one interaction in the stack, and it
 * was a 32px target.
 *
 * Mounted for every authenticated route inside `<AuthShell>` (the
 * `<DemoBanner>` pattern) so no page can forget it, and rendered from
 * `accountAccess.active`, which the server resolves: the banner appears exactly
 * when the server says the session is inside a record, never on a client guess.
 *
 * `role="status"` rather than `alert`: assistive tech announces the context
 * once when it appears, without the interrupt an alert implies. `aria-live` is
 * left to the role's implicit `polite`.
 */
export function SharedRecordBanner() {
  const { user } = useAuth();
  const { t } = useTranslations();
  const switchAccount = useAccountSwitch();

  const active = user?.accountAccess?.active ?? null;
  if (!active) return null;

  const name = accountLabel(active);
  const presentation = resolveRecordPresentation(active);

  return (
    <div
      role="status"
      data-slot="shared-record-banner"
      data-account-id={active.accountId}
      data-access-level={presentation.access}
      data-record-kind={presentation.recordKind}
      className="bg-warning/15 border-warning/40 flex items-start gap-3 border-b px-3 py-2 text-xs sm:items-center"
    >
      <Eye
        className="text-foreground mt-0.5 size-3.5 shrink-0 sm:mt-0"
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 leading-snug">
        <span className="text-foreground font-medium">
          {t("recordSharing.banner.viewing", { name })}
        </span>{" "}
        <span
          data-slot="shared-record-banner-context"
          className="text-foreground"
        >
          {recordKindLabel(presentation.recordKind, t)}.{" "}
          {accessLabel(presentation.access, t)}
        </span>
      </p>
      <button
        type="button"
        data-slot="shared-record-banner-exit"
        onClick={() => switchAccount.mutate(null)}
        disabled={switchAccount.isPending}
        className="text-foreground hover:bg-warning/25 focus-visible:ring-ring inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-medium underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50 sm:min-h-9"
      >
        {switchAccount.isPending ? (
          <Loader2
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <LogOut className="size-3.5" aria-hidden="true" />
        )}
        {t("recordSharing.banner.leave")}
      </button>
    </div>
  );
}

function accessLabel(
  access: ReturnType<typeof resolveRecordPresentation>["access"],
  t: ReturnType<typeof useTranslations>["t"],
): string {
  if (access === "manage") return t("recordSharing.banner.canManage");
  return access === "view-and-add"
    ? t("recordSharing.banner.canAdd")
    : t("recordSharing.banner.readOnly");
}

/**
 * Which kind of record this is, in the banner's own words.
 *
 * Exported and pure because the ternary is the whole claim and nothing could
 * fail it: the browser journey asserted `data-record-kind="managed"`, which is
 * the attribute this function does not read, so inverting the two arms left
 * every test in the suite green while telling a Guardian they were inside an
 * ordinary shared record. Two sentences that mean different things are worth
 * one test.
 */
export function recordKindLabel(
  recordKind: ReturnType<typeof resolveRecordPresentation>["recordKind"],
  t: ReturnType<typeof useTranslations>["t"],
): string {
  return recordKind === "managed"
    ? t("recordSharing.lookingAfter.kindManaged")
    : t("recordSharing.lookingAfter.kindShared");
}
