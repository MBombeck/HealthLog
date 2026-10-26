"use client";

import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { createFencedBlobLoader } from "@/hooks/use-fenced-object-url";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * Download the stored original.
 *
 * A real button, not an anchor wearing `aria-disabled`.
 *
 * Two things were wrong with the anchor. `aria-disabled` tells a screen reader
 * the control is unavailable and stops nothing: `href="#"` is still activated
 * by a click and by Enter, so a person got a jump to the top of the page
 * instead of a file. And it ignored the failure flag entirely, so a document
 * whose original could not be fetched left a control that looked fine and
 * silently did nothing, for good.
 *
 * It also fetches at CLICK time unless the bytes are already in hand. The
 * sheet loads the original eagerly only for documents it is going to render
 * inline; for everything else — a large scan, a download-only format — nothing
 * is fetched or decrypted until somebody asks for it, which is what the plain
 * `href` used to cost and what the first fix accidentally gave up.
 */
export function DocumentDownloadButton({
  documentId,
  filename,
  readyUrl,
  unavailable,
  slot,
  ...buttonProps
}: {
  documentId: string;
  filename: string | null;
  /** Already-fetched bytes to reuse (the inline preview's), or null. */
  readyUrl: string | null;
  /** A prior fetch of these bytes failed for good. */
  unavailable: boolean;
  slot: string;
} & React.ComponentProps<typeof Button>) {
  const { t } = useTranslations();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const loaderRef = useRef<ReturnType<typeof createFencedBlobLoader> | null>(
    null,
  );

  useEffect(() => () => loaderRef.current?.dispose(), []);

  const save = (url: string) => {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename ?? "document";
    anchor.click();
  };

  const onClick = async () => {
    if (readyUrl) {
      save(readyUrl);
      return;
    }
    setPending(true);
    setFailed(false);
    // One loader for the lifetime of the button: loading again revokes the
    // previous object URL, and unmounting revokes the live one. Without that a
    // decrypted health document stays in the tab's memory until it closes.
    loaderRef.current ??= createFencedBlobLoader();
    const result = await loaderRef.current.load(
      `/api/documents/inbound/${documentId}/original`,
    );
    setPending(false);
    if (result.kind === "loaded") save(result.url);
    else if (result.kind === "failed") setFailed(true);
  };

  const blocked = unavailable || failed;

  return (
    <Button
      {...buttonProps}
      data-slot={slot}
      disabled={blocked || pending}
      aria-label={t("documents.detail.download")}
      title={blocked ? t("documents.detail.loadError") : undefined}
      onClick={() => void onClick()}
    >
      <Download className="size-4" aria-hidden />
      <span className="hidden sm:inline">
        {blocked
          ? t("documents.detail.loadError")
          : t("documents.detail.download")}
      </span>
    </Button>
  );
}

/**
 * Open the stored original in a new browser tab, for the types the browser
 * renders itself (the inline serving class: PDF, JPEG, PNG, WebP, GIF), so a
 * long report gets the browser's own zoom and search.
 *
 * It opens the object URL the sheet already holds rather than the route: a
 * plain navigation carries no record-session assertion, so the fence would
 * refuse it once the session has been inside a shared record. The bytes are
 * already in hand, so the tab opens inside the click and no popup blocker
 * steps in. A type outside the inline class never gets the control.
 */
export function DocumentOpenInTabButton({
  readyUrl,
  unavailable,
}: {
  readyUrl: string | null;
  unavailable: boolean;
}) {
  const { t } = useTranslations();
  return (
    <Button
      variant="outline"
      data-slot="document-open-in-tab"
      disabled={readyUrl === null || unavailable}
      aria-label={t("documents.detail.openInNewTab")}
      onClick={() => {
        if (readyUrl) window.open(readyUrl, "_blank", "noopener");
      }}
    >
      <ExternalLink className="size-4" aria-hidden />
      <span className="hidden sm:inline">
        {t("documents.detail.openInNewTab")}
      </span>
    </Button>
  );
}

/** Inline preview for Class A documents; skeleton until the blob paints. */
export function InlinePreview({
  src,
  failed,
  mimeType,
  title,
}: {
  /**
   * The object URL, fetched ONCE by the sheet and handed down.
   *
   * The bytes come through the app transport because it carries the
   * record-session assertion and a browser-issued `src="/api/…"` cannot. What
   * changed since: this component used to fetch them itself while the sheet
   * fetched the SAME original again for the download link, so opening a
   * document decrypted and held two copies of it — and a large scan is a large
   * copy. One loader now, lifted to the sheet.
   */
  src: string | null;
  failed: boolean;
  mimeType: string;
  title: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const isPdf = mimeType === "application/pdf";
  // Chromium's PDF viewer grabs focus while it initialises — BEFORE the
  // frame's `load` event — stranding keyboard events inside the embedded
  // document, so Escape stops closing the sheet the moment a PDF preview
  // opens. While the guard window is open (armed at mount, extended at
  // load, ended early by a deliberate pointer interaction with the
  // preview), any focus landing on the frame bounces straight back to the
  // dialog container; a user who clicks into the PDF is left alone.
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const stealGuardUntil = useRef(0);
  const reclaimFocus = (frame: HTMLIFrameElement) => {
    if (
      Date.now() < stealGuardUntil.current &&
      document.activeElement === frame
    ) {
      frame.closest<HTMLElement>('[role="dialog"]')?.focus();
    }
  };
  useEffect(() => {
    // Arm at mount, then run a frame-by-frame sweep for the steal variants
    // that never dispatch a focus event on the frame element.
    // Self-terminates with the guard.
    stealGuardUntil.current = Date.now() + 3_000;
    let raf = 0;
    const sweep = () => {
      const frame = frameRef.current;
      if (!frame || Date.now() >= stealGuardUntil.current) return;
      if (document.activeElement === frame) {
        frame.closest<HTMLElement>('[role="dialog"]')?.focus();
      }
      raf = requestAnimationFrame(sweep);
    };
    raf = requestAnimationFrame(sweep);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative max-h-[55vh] overflow-auto overscroll-contain rounded-lg">
      {failed ? (
        // The preview could not be fetched — refused, offline, or still
        // rendering server-side. A permanent skeleton would read as "loading
        // forever"; the sheet's own metadata and the download control below
        // still work.
        <p
          data-slot="document-preview-unavailable"
          className="text-muted-foreground py-8 text-center text-sm"
        >
          {title}
        </p>
      ) : !loaded || src === null ? (
        <Skeleton
          className={cn("w-full rounded-lg", isPdf ? "h-[55vh]" : "h-64")}
        />
      ) : null}
      {src === null || failed ? null : isPdf ? (
        // No `sandbox` attribute by design: Chromium force-downloads PDFs
        // in sandboxed frames instead of rendering them. The serve
        // response itself carries `default-src 'none'` +
        // `frame-ancestors 'self'` + true Content-Type + nosniff, and the
        // upload policy denies every format whose inline render could
        // execute script.
        <iframe
          ref={frameRef}
          src={src}
          title={title}
          onLoad={(event) => {
            setLoaded(true);
            // The viewer may still initialise (and steal focus) after
            // `load` — keep the guard open a little longer.
            stealGuardUntil.current = Math.max(
              stealGuardUntil.current,
              Date.now() + 2_000,
            );
            reclaimFocus(event.currentTarget);
          }}
          onFocus={(event) => reclaimFocus(event.currentTarget)}
          onPointerDown={() => {
            // Deliberate interaction with the preview ends the guard.
            stealGuardUntil.current = 0;
          }}
          className={cn(
            "border-border h-[55vh] w-full rounded-lg border",
            !loaded && "absolute inset-0 opacity-0",
          )}
        />
      ) : (
        // Decrypted same-origin blob stream: next/image cannot optimise it
        // and would only proxy the bytes through a second request.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={title}
          onLoad={() => setLoaded(true)}
          className={cn(
            "mx-auto max-h-[55vh] w-auto max-w-full rounded-lg object-contain",
            !loaded && "absolute inset-0 opacity-0",
          )}
        />
      )}
    </div>
  );
}
