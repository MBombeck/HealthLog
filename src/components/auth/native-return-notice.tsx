"use client";

import { useEffect } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Logo } from "@/components/ui/logo";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The text of `/auth/native-return` in a browser without the app. It never
 * reads the query; on mount it replaces the address with the bare path, so
 * the one-time code does not linger in the address bar or the tab's history
 * entry.
 */
export function NativeReturnNotice() {
  const { t } = useTranslations();

  useEffect(() => {
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  return (
    <div className="w-full max-w-md py-8">
      <Card data-testid="native-return">
        <CardContent className="flex flex-col items-center gap-3 text-center">
          <div className="bg-primary/10 flex size-12 items-center justify-center rounded-lg">
            <Logo className="text-primary" size={28} />
          </div>
          <h1 className="text-xl font-bold tracking-tight">
            {t("auth.native.returnTitle")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("auth.native.returnBody")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
