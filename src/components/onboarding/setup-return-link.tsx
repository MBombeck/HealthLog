"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { InlineAction } from "@/components/ui/inline-action";
import { useTranslations } from "@/lib/i18n/context";
import {
  clearSetupReturn,
  readSetupReturn,
} from "@/lib/onboarding/setup-return";

/**
 * "Back to setup" on a Settings or Admin page the setup sent the person to
 * (see `setup-return.ts`). Renders nothing without the mark.
 */
export function SetupReturnLink() {
  const { t } = useTranslations();
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    // Read after hydration: the mark lives in this tab's storage only.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only read
    setHref(readSetupReturn());
  }, []);

  if (!href) return null;
  return (
    <p className="mb-4" data-slot="setup-return-link">
      <InlineAction asChild size="sm">
        <Link href={href} onClick={() => clearSetupReturn()}>
          <ChevronLeft aria-hidden="true" />
          {t("setup.backToSetup")}
        </Link>
      </InlineAction>
    </p>
  );
}
