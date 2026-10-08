import { LinkIcon } from "lucide-react";

import { resolveShareViewLocale } from "@/lib/clinician-share/request-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";

/**
 * What a practice sees when a shared link no longer opens: expired, revoked,
 * mistyped. The page still answers 404 for every failure class alike (the
 * share page's `notFound()`), so a probe learns nothing from it; what changes
 * is the copy. The app's own 404 said "this page does not exist" and offered
 * a dashboard the reader has no account for. This one says what happened in
 * the reader's terms and what to do, and links nowhere.
 */
export default async function ClinicianShareNotFound() {
  const locale = await resolveShareViewLocale();
  const { t } = getServerTranslator(locale);

  return (
    <main
      id="main-content"
      data-slot="clinician-share-unavailable"
      className="bg-background text-foreground flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-12 pt-[calc(env(safe-area-inset-top)+3rem)]"
    >
      <div
        aria-hidden="true"
        className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-xl"
      >
        <LinkIcon className="size-6" />
      </div>
      <div className="max-w-md space-y-2 text-center">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("clinicianView.unavailable.title")}
        </h1>
        <p className="text-foreground text-sm">
          {t("clinicianView.unavailable.description")}
        </p>
      </div>
    </main>
  );
}
