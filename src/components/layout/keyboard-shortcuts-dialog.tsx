"use client";

import { Fragment } from "react";

import { NAV_DESTINATIONS } from "@/components/layout/nav-model";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";
import {
  GO_TO_SHORTCUTS,
  isApplePlatform,
  resolveGoTo,
  type ShortcutOffer,
} from "@/lib/keyboard/global-shortcuts";

/**
 * The list of keyboard shortcuts, opened with `?` or from the account menu.
 *
 * It lists what works for this session: a destination whose module is off,
 * or a Coach without an AI provider, is not offered by `g` and is not listed
 * either. Key names are literal keys, not translated words.
 */
export interface KeyboardShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offer: ShortcutOffer;
  /** Whether `n` has anything to open (a read-only record has not). */
  canCapture: boolean;
}

interface Row {
  id: string;
  label: string;
  /** Keys pressed one after the other, or held together with `chord`. */
  sequence: ReadonlyArray<string>;
  chord?: boolean;
}

function Kbd({ children }: { children: string }) {
  // Foreground, not muted: a key name has to be readable at a glance, and
  // the muted token sits under the contrast floor on the muted wash.
  return (
    <kbd className="border-border bg-muted text-foreground inline-flex min-w-6 items-center justify-center rounded border px-1.5 py-0.5 font-mono text-xs">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
  offer,
  canCapture,
}: KeyboardShortcutsDialogProps) {
  const { t } = useTranslations();

  const navigation: Row[] = GO_TO_SHORTCUTS.flatMap((shortcut) => {
    if (resolveGoTo(shortcut.key, offer) === null) return [];
    const tKey =
      shortcut.destination === "settings"
        ? "nav.settings"
        : NAV_DESTINATIONS.find((d) => d.href === shortcut.destination)?.tKey;
    if (!tKey) return [];
    return [
      {
        id: `go-${shortcut.key}`,
        label: t(tKey),
        sequence: ["g", shortcut.key],
      },
    ];
  });

  // Rendered only while open, so the platform is the browser's.
  const mod = isApplePlatform() ? "⌘" : "Ctrl";
  const actions: Row[] = [
    {
      id: "palette",
      label: t("shortcuts.search"),
      sequence: [mod, "K"],
      chord: true,
    },
    ...(canCapture
      ? [
          {
            id: "capture",
            label: t("nav.capture.title"),
            sequence: ["n"],
          },
        ]
      : []),
    { id: "help", label: t("shortcuts.help"), sequence: ["?"] },
    { id: "close", label: t("shortcuts.close"), sequence: ["Esc"] },
  ];

  const day: Row[] = [
    { id: "day-toggle", label: t("shortcuts.toggleDay"), sequence: ["g", "p"] },
    { id: "day-previous", label: t("shortcuts.previousDay"), sequence: ["["] },
    { id: "day-next", label: t("shortcuts.nextDay"), sequence: ["]"] },
  ];

  const groups = [
    {
      id: "navigation",
      title: t("shortcuts.groups.navigation"),
      rows: navigation,
    },
    { id: "actions", title: t("shortcuts.groups.actions"), rows: actions },
    {
      id: "day",
      title: t("shortcuts.groups.day"),
      hint: t("shortcuts.dayHint"),
      rows: day,
    },
  ].filter((group) => group.rows.length > 0);

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("shortcuts.title")}
      description={t("shortcuts.description")}
    >
      <div data-slot="keyboard-shortcuts" className="flex flex-col gap-6">
        {groups.map((group) => (
          <section
            key={group.id}
            data-group={group.id}
            aria-labelledby={`shortcuts-group-${group.id}`}
            className="flex flex-col gap-2"
          >
            <div className="flex flex-col gap-1">
              <h3
                id={`shortcuts-group-${group.id}`}
                className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
              >
                {group.title}
              </h3>
              {"hint" in group && group.hint ? (
                <p className="text-muted-foreground text-xs">{group.hint}</p>
              ) : null}
            </div>
            <dl className="flex flex-col gap-2">
              {group.rows.map((row) => (
                <div
                  key={row.id}
                  data-shortcut={row.id}
                  className="flex items-center justify-between gap-3"
                >
                  <dt className="min-w-0 flex-1 text-sm">{row.label}</dt>
                  <dd className="flex shrink-0 items-center gap-1.5">
                    {row.sequence.map((key, index) => (
                      <Fragment key={`${row.id}-${index}`}>
                        {index > 0 ? (
                          <span className="text-muted-foreground text-xs">
                            {row.chord ? "+" : t("shortcuts.then")}
                          </span>
                        ) : null}
                        <Kbd>{key}</Kbd>
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </ResponsiveSheet>
  );
}
