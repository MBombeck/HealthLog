"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Password input with a built-in show/hide toggle. Lives in the shared UI
 * layer so every surface that needs a masked secret (Withings, moodLog,
 * ntfy, Telegram, AI provider keys, account password, auth login /
 * register) can share the same UX without duplicating the
 * visibility-toggle plumbing.
 *
 * v1.4.27 R3d MB2 — the icon-only toggle wraps in an `inline-flex h-11
 * w-11` hit area so the 44 px WCAG 2.5.5 floor is honoured on touch.
 * The icon stays at 16 px; the surrounding padding does the work. The
 * input itself gets `pr-12` so user input never collides with the
 * toggle glyph.
 */
export function PasswordInput({
  className,
  ...props
}: React.ComponentProps<typeof Input>) {
  const [visible, setVisible] = useState(false);
  const { t } = useTranslations();
  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        className={cn("pr-12", className)}
      />
      <button
        type="button"
        tabIndex={-1}
        // WCAG 2.1.2 button-name — the icon-only toggle has no visible text
        // and screen readers fall back to the icon's filename otherwise.
        aria-label={
          visible ? t("common.hidePassword") : t("common.showPassword")
        }
        onClick={() => setVisible((v) => !v)}
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
