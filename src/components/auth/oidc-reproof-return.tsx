"use client";

import { useEffect } from "react";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { useTranslations } from "@/lib/i18n/context";
import { dropParams, writeUrlState } from "@/lib/url-state";

/**
 * The outcome a confirmation at the identity provider came back with
 * (`?reproof=done|failed`, set by the OIDC callback). Pure, so the parsing is
 * testable without a browser.
 */
export function readReproofReturn(search: string): "done" | "failed" | null {
  const raw = new URLSearchParams(search).get("reproof");
  return raw === "done" || raw === "failed" ? raw : null;
}

/**
 * Says once how the confirmation at the identity provider went, then takes the
 * marker off the address so a reload does not say it again. The browser lands
 * on the page it left, which is where the person repeats what they were
 * about to do.
 */
export function OidcReproofReturnBridge() {
  const { t } = useTranslations();
  useEffect(() => {
    const outcome = readReproofReturn(window.location.search);
    if (!outcome) return;
    writeUrlState(dropParams("reproof"), { mode: "replace", state: "keep" });
    toastWrittenOutcome(
      outcome === "done" ? "success" : "failed",
      outcome === "done"
        ? t("settings.reproof.oidcDone")
        : t("settings.reproof.oidcFailed"),
    );
    // A later run (a locale switch) finds no marker and does nothing.
  }, [t]);
  return null;
}
