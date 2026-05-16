"use client";

import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { MoodForm } from "@/components/mood/mood-form";
import { MoodList } from "@/components/mood/mood-list";
import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Plus, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTranslations } from "@/lib/i18n/context";

export default function MoodPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  // v1.4.27 R4 RC2 — DOM-ref handle the form portals its action row
  // into. The ref lives on the `<ResponsiveSheet>` footer slot so the
  // Sheet branch can sticky-pin Save / Cancel above the keyboard.
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  const { t } = useTranslations();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("mood.title")}
          </h1>
          {/* v1.4.34 IW-G — subtitle stays visible on mobile so the
              H1 isn't an unframed label. */}
          <p className="text-muted-foreground text-xs sm:text-sm">
            {t("mood.subtitle")}
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t("mood.addEntry")}
        </Button>
      </div>

      <ResponsiveSheet
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t("mood.addEntry")}
        footer={<div ref={setFooterEl} className="flex w-full" />}
      >
        <MoodForm
          onSuccess={() => setDialogOpen(false)}
          onCancel={() => setDialogOpen(false)}
          footerSlot={footerEl}
        />
      </ResponsiveSheet>

      <MoodList onAddFirst={() => setDialogOpen(true)} />
    </div>
  );
}
