"use client";

import Link from "next/link";

import { visibleAccountMenuDestinations } from "@/components/layout/nav-model";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The record pages that open from the account menu (the emergency card), as a
 * slice of the user menu.
 *
 * One component mounted in both user menus, the desktop sidebar's avatar
 * dropdown and the phone's top-bar dropdown, for the reason the switcher beside
 * it gives: two menus written twice drift. Which pages show is
 * `visibleAccountMenuDestinations`, read with the record on screen as the
 * server resolved it, so inside a shared record the entry follows the page's
 * own route rule.
 */
export function AccountMenuRecordItems() {
  const { t } = useTranslations();
  const { inSharedRecord, sections, recordKind, level } =
    useRecordCapabilities();
  const items = visibleAccountMenuDestinations({
    sharedRecord: inSharedRecord,
    sections,
    record: { recordKind, level },
  });

  return (
    <>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <DropdownMenuItem key={item.href} asChild>
            <Link
              href={item.href}
              className="cursor-pointer"
              data-slot="account-menu-record-link"
            >
              <Icon className="mr-2 h-4 w-4" />
              {t(item.tKey)}
            </Link>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
