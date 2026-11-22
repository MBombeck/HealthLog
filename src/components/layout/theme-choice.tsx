"use client";

/**
 * The theme choice, in the three places it is offered: the avatar menu on the
 * phone, the avatar menu in the sidebar, and the Display card in Settings >
 * Account. One option list and one source of truth, the `ThemeProvider`
 * (`useTheme`, which resolves "system" against the device through
 * `resolveTheme`), so a choice made in one place shows as chosen in the others.
 */
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { useTheme } from "@/components/theme-provider";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Segmented } from "@/components/ui/segmented";
import { useTranslations } from "@/lib/i18n/context";
import type { ThemeChoice } from "@/lib/pwa/theme-color";

export const THEME_OPTIONS: ReadonlyArray<{
  value: ThemeChoice;
  icon: LucideIcon;
  labelKey: string;
}> = [
  { value: "system", icon: Monitor, labelKey: "nav.themeSystem" },
  { value: "dark", icon: Moon, labelKey: "nav.themeDark" },
  { value: "light", icon: Sun, labelKey: "nav.themeLight" },
];

/** The icon of the current choice, for the menu's sub-trigger. */
export function ThemeChoiceIcon() {
  const { theme } = useTheme();
  const Icon =
    THEME_OPTIONS.find((option) => option.value === theme)?.icon ?? Monitor;
  return <Icon className="h-4 w-4" />;
}

/** The three menu rows, the current one ticked. */
export function ThemeMenuItems() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslations();
  return (
    <>
      {THEME_OPTIONS.map(({ value, icon: Icon, labelKey }) => (
        <DropdownMenuItem key={value} onClick={() => setTheme(value)}>
          <Icon className="mr-2 h-4 w-4" />
          {t(labelKey)}
          {theme === value && (
            <span className="text-primary ml-auto text-xs">&#10003;</span>
          )}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** The same choice as a segmented row, for Settings > Account > Display. */
export function ThemeSegmented() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslations();
  return (
    <Segmented
      mode="toggle"
      slot="theme-choice"
      label={t("nav.theme")}
      value={theme}
      onChange={setTheme}
      options={THEME_OPTIONS.map(({ value, icon, labelKey }) => ({
        value,
        icon,
        label: t(labelKey),
      }))}
    />
  );
}
