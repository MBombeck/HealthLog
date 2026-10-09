"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { openDay } from "@/components/day/day-layer-controller";
import { useTodayKey } from "@/components/day/use-today-key";
import {
  openCapturePicker,
  openShortcutsHelp,
} from "@/components/layout/global-shortcuts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useModuleToggle } from "@/hooks/use-module-toggle";
import {
  EMPTY_STATE_ACTIONS,
  type PaletteEntry,
  type PaletteGroup,
} from "@/lib/command-palette/build-index";
import { rankEntries } from "@/lib/command-palette/rank";
import { pushRecent, readRecent } from "@/lib/command-palette/recent";
import { scrollToAnchorWhenReady } from "@/lib/dom/scroll-to-anchor";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import { setCommandPaletteOpen, useCommandPaletteOpen } from "./palette-store";
import { usePaletteIndex } from "./use-palette-index";

/**
 * The command palette: one field, and below it the places, settings, module
 * switches and actions that match, grouped. Arrow keys move, Enter opens,
 * Escape closes. A module's entry is a switch: Enter flips it and the palette
 * stays open.
 *
 * Accessibility follows the combobox pattern: the field is the
 * `role="combobox"` that keeps focus, the results are a `listbox` of grouped
 * `option`s, and `aria-activedescendant` names the highlighted one.
 *
 * A centred dialog from 768 px; on a phone a full-height sheet with the field
 * at the top. That one is a raw `Sheet` rather than `ResponsiveSheet` on
 * purpose: the responsive primitive's phone branch is a 90 % bottom sheet
 * that keeps the keyboard down on open, and a search wants the opposite, the
 * whole height and the keyboard up at once.
 *
 * Loaded on first use (`command-palette.lazy.tsx`), so no page pays for it.
 */

/** At most this many hits per group, so one group cannot bury the others. */
const PER_GROUP = 7;

interface Section {
  group: PaletteGroup;
  entries: PaletteEntry[];
}

function hashOf(href: string): { pathname: string; hash: string } {
  const at = href.indexOf("#");
  return at === -1
    ? { pathname: href, hash: "" }
    : { pathname: href.slice(0, at), hash: href.slice(at + 1) };
}

export function arrangeResults(
  query: string,
  index: ReadonlyArray<PaletteEntry>,
  recentIds: ReadonlyArray<string>,
): Section[] {
  if (query.trim() === "") {
    const byId = new Map(index.map((entry) => [entry.id, entry]));
    const recent = recentIds
      .map((id) => byId.get(id))
      .filter((entry): entry is PaletteEntry => entry !== undefined);
    const actions = EMPTY_STATE_ACTIONS.map((id) => byId.get(id)).filter(
      (entry): entry is PaletteEntry =>
        entry !== undefined && !recentIds.includes(entry.id),
    );
    return [
      { group: "recent" as const, entries: recent },
      { group: "actions" as const, entries: actions },
    ].filter((section) => section.entries.length > 0);
  }
  const ranked = rankEntries(query, index);
  // Groups appear in the order of their best hit, so the best match is
  // always the first option.
  const order: PaletteGroup[] = [];
  const grouped = new Map<PaletteGroup, PaletteEntry[]>();
  for (const entry of ranked) {
    const list = grouped.get(entry.group);
    if (!list) {
      order.push(entry.group);
      grouped.set(entry.group, [entry]);
    } else if (list.length < PER_GROUP) {
      list.push(entry);
    }
  }
  return order.map((group) => ({ group, entries: grouped.get(group) ?? [] }));
}

export default function CommandPalette() {
  const open = useCommandPaletteOpen();
  const isMobile = useIsMobile();
  const { t } = useTranslations();
  const title = t("palette.title");
  const description = t("palette.description");

  const body = open ? (
    <PaletteBody isMobile={isMobile} key="palette-body" />
  ) : null;

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setCommandPaletteOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          data-slot="command-palette"
          data-variant="sheet"
          className="h-dvh max-h-dvh gap-0 rounded-none p-0 pt-[env(safe-area-inset-top,0px)]"
        >
          <SheetTitle className="sr-only">{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setCommandPaletteOpen}>
      <DialogContent
        showCloseButton={false}
        data-slot="command-palette"
        data-variant="dialog"
        className="top-[12vh] flex translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}

export function PaletteBody({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslations();
  const router = useRouter();
  const { user } = useAuth();
  const today = useTodayKey();
  const coachLaunch = useCoachLaunch();
  const index = usePaletteIndex();
  const toggle = useModuleToggle();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recentIds] = useState(() => readRecent(user?.id));
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const sections = useMemo(
    () => arrangeResults(query, index, recentIds),
    [query, index, recentIds],
  );
  const flat = useMemo(
    () => sections.flatMap((section) => section.entries),
    [sections],
  );
  const activeIndex =
    flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const optionId = (i: number) => `${listId}-option-${i}`;

  // Keep the highlighted option in view as the arrows move through a list
  // taller than the panel.
  useEffect(() => {
    if (activeIndex < 0) return;
    document
      .getElementById(optionId(activeIndex))
      ?.scrollIntoView({ block: "nearest" });
    // `optionId` is derived from `listId`, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  function run(entry: PaletteEntry) {
    const target = entry.run;
    if (target.kind === "module") {
      // A switch: flip it where it is, and stay.
      toggle.mutate({ key: target.module, enabled: !target.enabled });
      return;
    }
    setCommandPaletteOpen(false);
    if (target.kind === "href") {
      pushRecent(user?.id, entry.id);
      router.push(target.href);
      const { pathname, hash } = hashOf(target.href);
      if (hash) scrollToAnchorWhenReady(hash, { pathname });
      return;
    }
    switch (target.action) {
      case "capture":
        openCapturePicker();
        return;
      case "coach":
        if (coachLaunch) coachLaunch.askCoach();
        else router.push("/coach");
        return;
      case "backup": {
        router.push("/settings/export#full-backup");
        scrollToAnchorWhenReady("full-backup", {
          pathname: "/settings/export",
        });
        return;
      }
      case "today":
        openDay(today);
        return;
      case "shortcuts":
        openShortcutsHelp();
        return;
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + flat.length) % flat.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = flat[activeIndex];
      if (entry) run(entry);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      setCommandPaletteOpen(false);
    }
  }

  // Each section's first position in the flat option list.
  const starts = sections.reduce<number[]>(
    (acc, section, i) => [
      ...acc,
      i === 0 ? 0 : acc[i - 1] + sections[i - 1].entries.length,
    ],
    [],
  );

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        isMobile ? "h-full" : "max-h-[min(70dvh,34rem)]",
      )}
    >
      <div className="border-border flex shrink-0 items-center gap-2 border-b px-4">
        <Search
          className="text-muted-foreground size-4 shrink-0"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          autoFocus
          type="text"
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            activeIndex >= 0 ? optionId(activeIndex) : undefined
          }
          aria-label={t("palette.title")}
          data-slot="command-palette-input"
          placeholder={t("palette.placeholder")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          className="placeholder:text-muted-foreground h-14 min-w-0 flex-1 bg-transparent text-base outline-none md:text-sm"
        />
        {isMobile ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11 shrink-0"
            onClick={() => setCommandPaletteOpen(false)}
          >
            {t("common.cancel")}
          </Button>
        ) : null}
      </div>

      <div
        id={listId}
        role="listbox"
        aria-label={t("palette.results")}
        data-slot="command-palette-results"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
      >
        {sections.length === 0 ? (
          <p
            data-slot="command-palette-empty"
            className="text-muted-foreground px-3 py-8 text-center text-sm"
          >
            {t("palette.noResults", { query: query.trim() })}
          </p>
        ) : (
          sections.map((section, sectionIndex) => {
            const headingId = `${listId}-group-${section.group}`;
            return (
              <div
                key={section.group}
                role="group"
                aria-labelledby={headingId}
                data-group={section.group}
                className="pb-1"
              >
                <div
                  id={headingId}
                  className="text-muted-foreground px-3 pt-3 pb-1 text-xs font-medium tracking-wide uppercase"
                >
                  {t(`palette.groups.${section.group}`)}
                </div>
                {section.entries.map((entry, entryIndex) => {
                  const i = starts[sectionIndex] + entryIndex;
                  const selected = i === activeIndex;
                  const Icon = entry.icon;
                  const isModule = entry.run.kind === "module";
                  const on = entry.run.kind === "module" && entry.run.enabled;
                  return (
                    <div
                      key={entry.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={selected}
                      aria-checked={isModule ? on : undefined}
                      data-entry={entry.id}
                      onMouseMove={() => {
                        if (!selected) setActive(i);
                      }}
                      onMouseDown={(event) => {
                        // Keep focus in the field; the click runs the entry.
                        event.preventDefault();
                      }}
                      onClick={() => run(entry)}
                      className={cn(
                        "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm",
                        selected && "bg-accent text-accent-foreground",
                      )}
                    >
                      <Icon
                        className="text-muted-foreground size-4 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {entry.title}
                      </span>
                      {entry.hint ? (
                        <span className="text-muted-foreground max-w-[40%] shrink-0 truncate text-xs">
                          {entry.hint}
                        </span>
                      ) : null}
                      {isModule ? (
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="text-muted-foreground text-xs">
                            {on
                              ? t("palette.moduleOn")
                              : t("palette.moduleOff")}
                          </span>
                          <span
                            aria-hidden="true"
                            data-state={on ? "checked" : "unchecked"}
                            className="data-[state=checked]:bg-primary data-[state=unchecked]:bg-switch-off inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full p-px"
                          >
                            {/* The Switch primitive's thumb, drawn: an
                                option holds no control of its own. */}
                            <span
                              className={cn(
                                "bg-background block size-4 rounded-full transition-transform motion-reduce:transition-none",
                                on
                                  ? "dark:bg-primary-foreground translate-x-[calc(100%-2px)]"
                                  : "dark:bg-foreground",
                              )}
                            />
                          </span>
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      {isMobile ? null : (
        <div
          aria-hidden="true"
          className="border-border text-muted-foreground flex shrink-0 items-center gap-4 border-t px-4 py-2 text-xs"
        >
          <span className="flex items-center gap-1.5">
            <kbd className="border-border bg-muted text-foreground rounded border px-1.5 font-mono">
              ↑↓
            </kbd>
            {t("palette.hintMove")}
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="border-border bg-muted text-foreground rounded border px-1.5 font-mono">
              ↵
            </kbd>
            {t("palette.hintOpen")}
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="border-border bg-muted text-foreground rounded border px-1.5 font-mono">
              Esc
            </kbd>
            {t("palette.hintClose")}
          </span>
        </div>
      )}
    </div>
  );
}
