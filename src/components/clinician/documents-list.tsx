/**
 * The frozen document set on a share link, as a list of entries.
 *
 * No bytes reach this component: each entry points at the token-scoped serve
 * route, which is the one decrypt path. Class A (inline) renders a preview
 * straight at that route — an `<img>` for raster images, a framed PDF
 * otherwise, fenced by the proxy's share-serve CSP. Class B is download-only.
 *
 * Split out of `clinician-view.tsx` with the selection rework.
 */
import { Download } from "lucide-react";

import { DOCUMENT_KIND_ICONS } from "@/components/documents/document-kind-meta";
import { formatBytes } from "@/lib/format/bytes";
import type { ShareViewDocument } from "@/lib/clinician-share/share-view-data";
import type { InboundDocumentKindValue } from "@/lib/validations/inbound-documents";

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function DocumentEntry({
  t,
  doc,
  token,
  locale,
}: {
  t: Translate;
  doc: ShareViewDocument;
  token: string;
  locale: string;
}) {
  const serveUrl = `/c/${encodeURIComponent(token)}/d/${encodeURIComponent(doc.id)}`;
  const title = doc.title ?? t("clinicianView.documents.untitled");
  const Icon =
    DOCUMENT_KIND_ICONS[doc.kind as InboundDocumentKindValue] ?? undefined;
  const meta = [doc.documentDate, formatBytes(doc.byteSize, locale)].filter(
    Boolean,
  ) as string[];
  const isImage = doc.mimeType.startsWith("image/");
  const isInline = doc.servingClass === "inline";

  return (
    <li className="border-border bg-card rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {Icon ? (
            <Icon className="text-foreground mt-0.5 size-5 shrink-0" />
          ) : null}
          <div className="min-w-0">
            <p className="text-sm font-medium break-words">{title}</p>
            {meta.length > 0 ? (
              <p className="text-muted-foreground mt-0.5 text-xs">
                {meta.join(", ")}
              </p>
            ) : null}
          </div>
        </div>
        {/* Download is always available (inline or attachment) so the recipient
            can keep a copy; the anchor hits the same token-scoped serve route. */}
        <a
          href={serveUrl}
          download
          className="border-border hover:bg-muted focus-visible:ring-ring/50 inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-medium focus-visible:ring-[3px] focus-visible:outline-none"
        >
          <Download className="size-3.5" aria-hidden />
          {t("clinicianView.documents.download")}
        </a>
      </div>

      {isInline ? (
        <div className="mt-3">
          {isImage ? (
            // The served image is the frozen original with EXIF/GPS stripped on
            // egress; it renders inline within the Class A carve-out.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={serveUrl}
              alt={title}
              className="border-border mx-auto max-h-[70vh] w-auto max-w-full rounded-md border"
            />
          ) : (
            <iframe
              src={serveUrl}
              title={title}
              className="border-border h-[70vh] max-h-[80vh] w-full rounded-md border"
            />
          )}
        </div>
      ) : (
        <p className="text-muted-foreground mt-2 text-xs">
          {t("clinicianView.documents.attachmentHint")}
        </p>
      )}
    </li>
  );
}
