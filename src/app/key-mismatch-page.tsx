import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";

/**
 * What every page renders while the boot key check has found that the
 * configured encryption key cannot open this database (see
 * `src/lib/crypto/canary.ts`). A static server-rendered page with no client
 * code and no data reads: the app behind it would only fail on every value.
 * The API answers 503 with `encryption.key_mismatch` at the same time, and
 * `/api/health` names the reason.
 */
export function KeyMismatchPage({ locale }: { locale: Locale }) {
  const { t } = getServerTranslator(locale);
  return (
    <main className="bg-background text-foreground flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="border-border bg-card w-full max-w-xl space-y-4 rounded-xl border p-4 md:p-6">
        <h1 className="text-xl font-semibold">
          {t("admin.keyMismatch.title")}
        </h1>
        <p className="text-sm">{t("admin.keyMismatch.body")}</p>
        <div className="space-y-2">
          <h2 className="text-base font-semibold">
            {t("admin.keyMismatch.fixTitle")}
          </h2>
          <ol className="list-decimal space-y-2 ps-5 text-sm">
            <li>{t("admin.keyMismatch.fixRestore")}</li>
            <li>{t("admin.keyMismatch.fixDatabase")}</li>
            <li>{t("admin.keyMismatch.fixFresh")}</li>
          </ol>
        </div>
        <p className="text-muted-foreground text-sm">
          {t("admin.keyMismatch.restartNote")}
        </p>
        <p className="text-muted-foreground text-sm">
          {t("admin.keyMismatch.lastResort", {
            setting: "ENCRYPTION_KEY_CHECK=warn",
          })}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("admin.keyMismatch.codes", {
            code: "encryption.key_mismatch",
            reason: "encryption_key_mismatch",
          })}
        </p>
      </div>
    </main>
  );
}
