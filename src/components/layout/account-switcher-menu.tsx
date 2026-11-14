"use client";

import { useId, useState } from "react";
import { Check, ChevronDown, Loader2, Users } from "lucide-react";

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useAccountSwitch } from "@/hooks/use-account-switch";
import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslations } from "@/lib/i18n/context";
import { resolveRecordPresentation } from "@/lib/navigation/record-presentation";
import { sharedRecordLandingHref } from "@/lib/navigation/shared-record";
import {
  accountLabel,
  type AccountAccess,
} from "@/lib/sharing/account-access-view";
import { cn } from "@/lib/utils";

/**
 * v1.36.0 — the switcher, as a slice of the user menu.
 *
 * One component mounted in both user menus (the desktop sidebar's avatar
 * dropdown and the mobile top bar's) rather than the same block written twice.
 * The two menus have drifted before — that is the whole argument behind
 * `nav-model.ts` — and a switcher that exists on one surface and not the other
 * is a person who can enter a record on their laptop and cannot leave it on
 * their phone.
 *
 * Renders NOTHING unless the server says there is somewhere to go: `canSwitch`
 * arrives resolved on `accountAccess` and is bound directly. The list is
 * `accounts`, also resolved — the client never looks at grant rows and has none
 * to look at. An account that has never been shared with sees a user menu
 * identical to the one it saw before this feature existed.
 *
 * "Your own record" is a first-class entry rather than only a banner action:
 * the way out has to be reachable from the same menu as the way in, because
 * that is where somebody will look for it.
 *
 * Below the `sm` breakpoint the records open inside the account menu rather
 * than in a sub-menu beside it. The phone's account menu sits against the
 * right edge and takes most of the width; a 240 px sub-menu has room on
 * neither side, and Radix only shifts a side menu along its own axis, so it
 * ran off the screen and cut the names off. The trigger keeps its slot and the
 * list keeps `account-switcher-menu`, so a journey that taps the trigger and
 * then an entry reads the same at either width.
 */
export function AccountSwitcherMenuItems() {
  const { user } = useAuth();
  const { t } = useTranslations();
  const switchAccount = useAccountSwitch();
  const inline = useIsMobile("sm");
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  const access = user?.accountAccess;
  if (!access?.canSwitch) return null;

  const activeId = access.active?.accountId ?? null;
  const label = t("recordSharing.switcher.label");
  const icon = switchAccount.isPending ? (
    <Loader2
      className="size-4 animate-spin motion-reduce:animate-none"
      aria-hidden="true"
    />
  ) : (
    <Users className="size-4" aria-hidden="true" />
  );
  const rows = (
    <RecordRows
      access={access}
      activeId={activeId}
      inset={inline}
      switchAccount={switchAccount}
    />
  );

  if (inline) {
    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-slot="account-switcher-trigger"
          data-presentation="inline"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          className="cursor-pointer"
          // Keep the account menu open: the trigger unfolds the list in place.
          onSelect={(event) => {
            event.preventDefault();
            setExpanded((open) => !open);
          }}
        >
          {icon}
          <span className="ml-2">{label}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "ml-auto size-4 transition-transform motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
          />
        </DropdownMenuItem>
        {expanded && (
          <DropdownMenuGroup
            id={listId}
            data-slot="account-switcher-menu"
            aria-label={label}
          >
            {rows}
          </DropdownMenuGroup>
        )}
      </>
    );
  }

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          data-slot="account-switcher-trigger"
          className="min-h-11 py-2 sm:min-h-9"
        >
          {icon}
          <span className="ml-2">{label}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          data-slot="account-switcher-menu"
          className="max-h-(--radix-dropdown-menu-content-available-height) w-60 overflow-x-hidden overflow-y-auto"
        >
          {rows}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

function recordKindLabel(
  recordKind: ReturnType<typeof resolveRecordPresentation>["recordKind"],
  t: ReturnType<typeof useTranslations>["t"],
): string {
  return recordKind === "managed"
    ? t("recordSharing.lookingAfter.kindManaged")
    : t("recordSharing.lookingAfter.kindShared");
}

/**
 * The rows themselves: your own record first, then every record the server
 * published. The same rows in the side sub-menu and in the inline list; the
 * inline list indents them under the trigger (`inset`).
 */
function RecordRows({
  access,
  activeId,
  inset,
  switchAccount,
}: {
  access: AccountAccess;
  activeId: string | null;
  inset: boolean;
  switchAccount: ReturnType<typeof useAccountSwitch>;
}) {
  const { t } = useTranslations();

  return (
    <>
      <DropdownMenuItem
        data-slot="account-switcher-own"
        inset={inset}
        className="cursor-pointer"
        disabled={switchAccount.isPending}
        onClick={() => switchAccount.mutate(null)}
      >
        <span className="truncate">
          {t("recordSharing.switcher.ownRecord")}
        </span>
        {activeId === null && (
          <span className="text-primary ml-auto text-xs">&#10003;</span>
        )}
      </DropdownMenuItem>
      {access.accounts.map((account) => {
        const presentation = resolveRecordPresentation(account);

        return (
          <DropdownMenuItem
            key={account.accountId}
            data-slot="account-switcher-entry"
            data-account-id={account.accountId}
            data-account-username={account.username}
            data-access-level={presentation.access}
            data-record-kind={presentation.recordKind}
            inset={inset}
            className="cursor-pointer"
            disabled={switchAccount.isPending}
            onClick={() =>
              switchAccount.switchTo(
                account.accountId,
                sharedRecordLandingHref(account.sections),
              )
            }
          >
            {/* Two lines, not three. The access level had a line of its
                own here and it never fit — a 240 px menu truncated
                "Kann verwalten" as often as it showed it, and the entry
                still said which kind of record this is on the line below.
                The level is what the banner states once you are inside,
                where it governs what the page lets you do. It stays on
                the row as `data-access-level` for the browser journeys. */}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{accountLabel(account)}</span>
              <span className="text-muted-foreground truncate text-xs">
                {recordKindLabel(presentation.recordKind, t)}
              </span>
            </div>
            {activeId === account.accountId && (
              <Check className="text-primary ml-2 size-4 shrink-0" />
            )}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
