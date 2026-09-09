"use client";

/**
 * Document detail on `ResponsiveSheet` (bottom sheet on phones, dialog on
 * desktop). Inline-class documents (PDF / browser-native images) preview
 * inline against the owner-scoped decrypt-and-serve route — skeleton first,
 * content on load, internal scroll only (`overscroll-contain`). Attachment-
 * class documents get NO fake preview: type glyph, filename, size, and a
 * prominent Download button.
 *
 * Metadata edits save on commit (title on Enter/blur, kind and filing date
 * on change, condition links on toggle — replace-set PATCH). Mutation
 * errors surface inline (`role="alert"`), never as a QueryErrorCard.
 * Delete soft-deletes with an Undo toast (restore endpoint); a restore
 * refusal maps `meta.reason` (`purged`, `duplicateExists`) to translated
 * copy. A Share action in the footer opens the clinician share-link create
 * flow (shared `ShareLinkCreateForm`) with this document pre-attached.
 */
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  Download,
  FlaskConical,
  Pencil,
  Plus,
  Share2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useIllnessEpisodes } from "@/components/illness/use-illness";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  apiDelete,
  ApiError,
  apiGet,
  apiPatch,
  apiPost,
} from "@/lib/api/api-fetch";
import { encounterKindText } from "@/components/encounters/encounter-labels";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { EncounterKind } from "@/generated/prisma/client";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import {
  createFencedBlobLoader,
  useFencedObjectUrl,
} from "@/hooks/use-fenced-object-url";
import { cn } from "@/lib/utils";
import {
  INBOUND_DOCUMENT_KINDS,
  type DocumentSuggestionDto,
  type DocumentSummaryMode,
  type InboundDocumentDetailDto,
  type InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";
import { DocumentAiSection } from "./document-ai-section";
import { DocumentEncounterSuggestion } from "./document-encounter-suggestion";
import { DocumentFactsSection } from "./document-facts-review";
import { VaccinationDocumentSuggestion } from "@/components/vaccinations/vaccination-document-suggestion";
import { DocumentSummaryBlock } from "./document-summary-block";
import type { DocumentAiTarget } from "./document-ai-transport";
import { DocumentShareSheet } from "./document-share-sheet";
import { DOCUMENT_KIND_ICONS } from "./document-kind-meta";
import { useIndexDocument } from "./use-content-index";
import {
  useDocumentAiCapability,
  useDocumentAiErrorText,
  useDocumentsAutoAiRead,
  useDocumentSummary,
  useSuggestDetails,
} from "./use-document-assist";
import { formatBytes } from "./vault-utils";

type PatchInput = {
  title?: string | null;
  kind?: InboundDocumentKindValue;
  documentDate?: string | null;
  episodeIds?: string[];
  encounterIds?: string[];
};

/**
 * Download the stored original.
 *
 * v1.37.0 — a real button, not an anchor wearing `aria-disabled`.
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
function DocumentDownloadButton({
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

/** Inline preview for Class A documents; skeleton until the blob paints. */
function InlinePreview({
  src,
  failed,
  mimeType,
  title,
}: {
  /**
   * v1.37.0 — the object URL, fetched ONCE by the sheet and handed down.
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

export function DocumentDetailSheet({
  documentId,
  open,
  onOpenChange,
  assistAvailable,
  contentIndexEnabled,
}: {
  documentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Whether the AI "Suggest details" / summary actions can run (from
   * `usage.assistAvailable`). When false the AI area shows a calm pointer to
   * the AI settings instead of an error — the manual form stays fully usable.
   */
  assistAvailable?: boolean;
  /** Whether content indexing is available (from `usage.contentIndex.enabled`). */
  contentIndexEnabled?: boolean;
}) {
  const { t, tCount, locale } = useTranslations();
  const format = useFormatters();
  const queryClient = useQueryClient();
  // v1.28.52 (Documents R3) — the vault "Ask the Coach" action opens the REAL
  // fenced coach conversation in the shared side drawer (scoped to this
  // document) instead of a full-page nav; `askCoach(..., doc.id)` carries the
  // document scope through the launch context.
  const launch = useCoachLaunch();

  const detail = useQuery({
    queryKey: queryKeys.inboundDocument(documentId ?? "none"),
    enabled: open && documentId !== null,
    queryFn: () =>
      apiGet<InboundDocumentDetailDto>(`/api/documents/inbound/${documentId}`),
  });
  const doc = detail.data;

  // 2026-07-17 UX/IA audit M5 / F5-5 — the document → lab-values direction
  // had no UI link at all: an auto-staged (PENDING) or OCR-confirmed
  // (APPROVED, see `linkOcrLabsToVaultDocument`) OBSERVATION fact already
  // ties this document to specific lab rows, but nothing on the sheet said
  // so. There is no per-value route yet (`/labs` has no `?analyte=`
  // deep-link — see the labs page's own "no per-value relation" comment),
  // so this links to the labs list rather than a single biomarker; still a
  // real jump where there was none before.
  //
  // APPROVED only: the link claims values that exist in Labs, and a PENDING
  // fact is not there yet — it belongs to the review block above, which is
  // the control that turns it into one.
  const labFactCount =
    doc?.facts.filter(
      (fact) => fact.factType === "OBSERVATION" && fact.status === "APPROVED",
    ).length ?? 0;
  const { user } = useAuth();
  const { canManageDomain } = useRecordCapabilities();
  const canManageDocuments = canManageDomain("documents");
  const labsModuleEnabled = user?.modules?.labs !== false;

  const episodes = useIllnessEpisodes(true);

  // AI layer — capability drives the vision/text transport; the mutations run
  // the review-first assist, the session-only summary, and content indexing.
  // The affordance itself is gated on `assistAvailable` (from usage); the
  // probe only resolves the transport mode + the actionable unavailable reason.
  //
  // v1.36.x — and neither probe fires inside somebody else's record. The
  // document reads behind this sheet are delegable; the AI verbs above them are
  // not, and both of these routes stay on the caller's own authentication. A
  // delegate would fire two queries that must 403 in order to compute an
  // affordance every branch below already withholds on `canManageDocuments`.
  const capability = useDocumentAiCapability(
    canManageDocuments && open && documentId !== null,
  );
  // When auto-read is ON, reading happens automatically on upload — the manual
  // per-document AI action row is redundant and collapses away.
  const autoRead = useDocumentsAutoAiRead(
    canManageDocuments && open && documentId !== null,
  );
  const suggest = useSuggestDetails();
  const summary = useDocumentSummary();
  // Resolves an AI error to final copy — a 429 names the actual wait, derived
  // from the reset instant the route mirrors into the error meta.
  const aiErrorText = useDocumentAiErrorText();
  // Stored generation has an independent mutation state so transient
  // Summarise/Show text requests cannot change this block's spinner or result.
  const storedSummary = useDocumentSummary();
  const indexDoc = useIndexDocument();

  const [mutationError, setMutationError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  /**
   * The visit this SESSION filed the document against, if any.
   *
   * Kept beside the server state rather than derived from it, because the two
   * answer different questions: `doc.encounterLinks` says what is filed, this
   * says what the person just did here — which is what an undo can take back
   * without touching a filing they made somewhere else.
   */
  const [pickedEncounterId, setPickedEncounterId] = useState<string | null>(
    null,
  );
  const [titleDraft, setTitleDraft] = useState("");
  const [suggestion, setSuggestion] = useState<DocumentSuggestionDto | null>(
    null,
  );
  const [appliedFields, setAppliedFields] = useState({
    title: false,
    kind: false,
    date: false,
  });
  const [summaryOutput, setSummaryOutput] =
    useState<DocumentSummaryMode | null>(null);

  // Reset transient edit + AI state whenever another document opens —
  // render-phase derived-state adjustment, not an effect.
  const [lastDocumentId, setLastDocumentId] = useState(documentId);
  if (lastDocumentId !== documentId) {
    setLastDocumentId(documentId);
    setEditingTitle(false);
    setShareOpen(false);
    setMutationError(null);
    setSuggestion(null);
    setAppliedFields({ title: false, kind: false, date: false });
    setSummaryOutput(null);
  }

  // Clear stale mutation state (a prior document's assist error / summary)
  // when the sheet switches documents or closes — the mutation stores live
  // outside render, so they reset in an effect rather than during render.
  useEffect(() => {
    suggest.reset();
    summary.reset();
    storedSummary.reset();
    indexDoc.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  const patch = useMutation({
    mutationFn: (input: PatchInput) =>
      apiPatch<InboundDocumentDetailDto>(
        `/api/documents/inbound/${documentId}`,
        input,
      ),
    onSuccess: () => {
      setMutationError(null);
      void invalidateKeys(queryClient, [queryKeys.documents()]);
    },
    onError: () => setMutationError(t("documents.detail.saveError")),
  });

  const restore = useMutation({
    mutationFn: (id: string) =>
      apiPost(`/api/documents/inbound/${id}/restore`, {}),
    onSuccess: () => {
      void invalidateKeys(queryClient, [queryKeys.documents()]);
    },
    onError: (error) => {
      const reason =
        error instanceof ApiError && typeof error.meta?.reason === "string"
          ? error.meta.reason
          : "";
      if (reason === "purged") {
        toast.error(t("documents.error.purged"));
      } else if (reason === "duplicateExists") {
        toast.error(t("documents.error.duplicateExists"));
      } else {
        toast.error(t("documents.toast.restoreFailed"));
      }
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/documents/inbound/${id}`),
    onSuccess: (_data, id) => {
      onOpenChange(false);
      void invalidateKeys(queryClient, [queryKeys.documents()]);
      toast.success(t("documents.toast.deleted"), {
        action: {
          label: t("common.undo"),
          onClick: () => restore.mutate(id),
        },
      });
    },
    onError: () => setMutationError(t("documents.detail.deleteError")),
  });

  const commitTitle = () => {
    if (!doc) return;
    setEditingTitle(false);
    const next = titleDraft.trim();
    const current = doc.title ?? "";
    if (next === current) return;
    patch.mutate({ title: next === "" ? null : next });
  };

  const toggleEpisode = (episodeId: string) => {
    if (!doc) return;
    const current = doc.conditionLinks.map((l) => l.episodeId);
    const next = current.includes(episodeId)
      ? current.filter((id) => id !== episodeId)
      : [...current, episodeId];
    patch.mutate({ episodeIds: next });
  };

  /**
   * File this document against a visit, or clear that filing again.
   *
   * A replace-set PATCH like the condition links, so the undo is the same
   * write with the id removed rather than a second endpoint. Nothing here can
   * fail the document: an unknown id is refused by the route before anything
   * is written, and the sheet keeps showing what the server last confirmed.
   */
  const setSuggestedEncounter = (encounterId: string | null) => {
    if (!doc) return;
    const current = doc.encounterLinks.map((l) => l.encounterId);
    const next =
      encounterId === null
        ? current.filter((id) => id !== pickedEncounterId)
        : [...new Set([...current, encounterId])];
    setPickedEncounterId(encounterId);
    patch.mutate({ encounterIds: next });
  };

  // The affordance gate falls back to the capability probe when the sheet is
  // rendered without the usage-derived props (deep link before usage loads).
  const aiEnabled = assistAvailable ?? capability.data?.available ?? false;
  const indexEnabled =
    contentIndexEnabled ?? capability.data?.available ?? false;
  const autoReadEnabled = autoRead.data?.documentsAutoAiRead ?? false;
  const aiMode = capability.data?.mode === "text" ? "text" : "vision";
  const aiTarget: DocumentAiTarget | null = doc
    ? {
        documentId: doc.id,
        mimeType: doc.mimeType,
        filename: doc.filename,
        servingClass: doc.servingClass,
      }
    : null;

  const runSuggest = () => {
    if (!aiTarget) return;
    setAppliedFields({ title: false, kind: false, date: false });
    suggest.mutate(
      { mode: aiMode, target: aiTarget },
      { onSuccess: (result) => setSuggestion(result) },
    );
  };

  const runSummary = (output: DocumentSummaryMode) => {
    if (!aiTarget) return;
    summary.reset();
    setSummaryOutput(output);
    summary.mutate({ mode: aiMode, target: aiTarget, output });
  };

  // Generate or regenerate the STORED summary from the detail block. Only the
  // stored-summary branch requests replacement; the empty-state action keeps
  // first-write-wins if another worker or tab finishes while AI is running.
  const generateStoredSummary = () => {
    if (!aiTarget || !documentId) return;
    storedSummary.reset();
    storedSummary.mutate(
      {
        mode: aiMode,
        target: aiTarget,
        output: "summary",
        persist: true,
        replace: doc?.summary != null,
      },
      {
        onSuccess: (result) => {
          if ("summary" in result) {
            if (result.persistence === "withheld") {
              toast.error(result.summary);
            } else if (result.persistence === "failed") {
              toast.error(t("documents.detail.saveError"));
            }
          }
          void queryClient.invalidateQueries({
            queryKey: queryKeys.inboundDocument(documentId),
          });
        },
        onError: (error) => toast.error(aiErrorText(error)),
      },
    );
  };

  const runIndex = () => {
    if (!aiTarget) return;
    indexDoc.mutate(
      { mode: aiMode, target: aiTarget },
      {
        // A read that continued into lab staging says so — the staged values
        // are waiting in the review block, not silently in a queue. Staged
        // facts stay PENDING; confirmation remains the only write into Labs.
        onSuccess: (result) =>
          toast.success(
            result.labFactsStaged > 0
              ? tCount("documents.ai.readStaged", result.labFactsStaged)
              : t("documents.ai.readDone"),
          ),
        onError: (error) => toast.error(aiErrorText(error)),
      },
    );
  };

  // Review-first apply: the title lands in the EDITABLE field (the user still
  // saves it via blur/Enter — the existing commit path); type and date each
  // commit that single field on an explicit tap. Never automatic.
  const applyTitle = () => {
    if (!suggestion?.title) return;
    setTitleDraft(suggestion.title);
    setEditingTitle(true);
    setAppliedFields((prev) => ({ ...prev, title: true }));
  };
  const applyKind = () => {
    if (!suggestion?.kind) return;
    patch.mutate({ kind: suggestion.kind });
    setAppliedFields((prev) => ({ ...prev, kind: true }));
  };
  const applyDate = () => {
    if (!suggestion?.documentDate) return;
    patch.mutate({ documentDate: suggestion.documentDate });
    setAppliedFields((prev) => ({ ...prev, date: true }));
  };

  const suggestionKindLabel = suggestion?.kind
    ? t(`documents.kind.${suggestion.kind}`)
    : null;
  const suggestionDateLabel = suggestion?.documentDate
    ? format.date(`${suggestion.documentDate}T12:00:00.000Z`)
    : null;

  const title = doc?.title ?? doc?.filename ?? t("documents.card.untitled");
  const Icon = doc ? DOCUMENT_KIND_ICONS[doc.kind] : null;
  // v1.37.0 — the ONE eager fetch of the original, and only for a document
  // that is going to render it.
  //
  // A `<iframe src="/api/…">` carries no record-session assertion, so the
  // fence refuses it once the session has been inside a shared record; the
  // bytes therefore come through the app transport as an object URL. The
  // narrow path is the point: a non-inline document (a large scan, a
  // download-only format) fetched nothing until somebody clicked, and it must
  // stay that way — this used to fetch for every document on open, twice.
  const { url: inlineSrc, failed: inlineFailed } = useFencedObjectUrl(
    doc && doc.servingClass === "inline"
      ? `/api/documents/inbound/${doc.id}/original`
      : null,
  );

  return (
    <>
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={t("documents.detail.title")}
        contentWidth="3xl"
        showCloseButton={false}
        headerAction={
          // Enlarged close control rendered in the header's trailing slot —
          // the sheet's own X glyph is `size-4` via the primitive; we hide it
          // (`showCloseButton={false}`) and render this larger `size-5` X with
          // a comfortable min tap target instead. Scoped to this sheet only,
          // so the global primitive default is unchanged for other callers.
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-slot="document-detail-close"
            aria-label={t("common.close")}
            onClick={() => onOpenChange(false)}
            className="text-muted-foreground hover:text-foreground min-h-11 min-w-11 sm:size-9"
          >
            <X className="size-5" aria-hidden="true" />
          </Button>
        }
        footer={
          doc ? (
            // Delete sits bottom-LEFT, quieted to a text button: the
            // bottom-right slot reads as the primary/confirm action, and a
            // destructive control there is a footgun. Share + Download — the
            // safe, expected actions — keep the trailing edge. On phones their
            // labels collapse to icon-only (aria-labelled) so three controls
            // never overflow the sheet at 360 px; the labels return at `sm+`.
            <div className="flex w-full items-center justify-between gap-2">
              {/* v1.36.x — deleting, sharing and re-filing a document are the
                  owner's alone. Inside somebody else's record the sheet reads
                  the document and offers the download, and the leading slot
                  simply has nothing in it. */}
              {canManageDocuments ? (
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => remove.mutate(doc.id)}
                  disabled={remove.isPending}
                >
                  <Trash2 className="size-4" aria-hidden />
                  {t("documents.detail.delete")}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                {/* v1.36.x — `launch` is the one entry point that rendered
                    without asking whether a drawer exists to open. It is null
                    inside somebody else's record (the shell mounts no drawer
                    there), and `/documents` is a shared-record destination, so
                    this is the Coach button a delegate actually meets. */}
                {aiEnabled && launch ? (
                  // v1.28.52 (Documents R3) — "Ask the Coach" opens the REAL
                  // coach conversation scoped to this document in the SIDE
                  // DRAWER (the maximize control there expands it to the full
                  // `/coach` page). Every doc turn still runs on the hardened
                  // fenced document endpoint (never the coach tool route) — only
                  // WHERE the conversation renders changed, not the send path.
                  // Close the detail sheet so the drawer owns the surface.
                  <Button
                    variant="outline"
                    onClick={() => {
                      onOpenChange(false);
                      launch.askCoach(null, undefined, false, doc.id);
                    }}
                    data-slot="document-chat-open"
                    aria-label={t("documents.chat.openAria")}
                  >
                    <Sparkles className="size-4" aria-hidden />
                    <span className="hidden sm:inline">
                      {t("documents.chat.openButton")}
                    </span>
                  </Button>
                ) : null}
                {canManageDocuments && (
                  <Button
                    variant="outline"
                    onClick={() => setShareOpen(true)}
                    data-slot="document-share"
                    aria-label={t("documents.detail.share")}
                  >
                    <Share2 className="size-4" aria-hidden />
                    <span className="hidden sm:inline">
                      {t("documents.detail.share")}
                    </span>
                  </Button>
                )}
                <DocumentDownloadButton
                  documentId={doc.id}
                  filename={doc.filename}
                  readyUrl={inlineSrc}
                  unavailable={inlineFailed}
                  variant="outline"
                  slot="document-download"
                />
              </div>
            </div>
          ) : undefined
        }
      >
        {detail.isPending && open ? (
          <div className="space-y-3" data-slot="document-detail-loading">
            <Skeleton className="h-48 w-full rounded-lg" />
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-9 w-1/2" />
          </div>
        ) : null}

        {detail.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {t("documents.detail.loadError")}
          </p>
        ) : null}

        {doc ? (
          <div className="space-y-6">
            {doc.servingClass === "inline" ? (
              <InlinePreview
                src={inlineSrc}
                failed={inlineFailed}
                mimeType={doc.mimeType}
                title={title}
              />
            ) : (
              <div className="border-border flex flex-col items-center gap-2 rounded-lg border px-4 py-8 text-center">
                {Icon ? (
                  <Icon className="text-muted-foreground size-8" aria-hidden />
                ) : null}
                <p className="max-w-full truncate text-sm font-medium">
                  {doc.filename ?? title}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("documents.detail.previewUnavailable")} ·{" "}
                  {formatBytes(doc.byteSize, locale)}
                </p>
                <DocumentDownloadButton
                  documentId={doc.id}
                  filename={doc.filename}
                  readyUrl={null}
                  unavailable={false}
                  size="sm"
                  className="mt-1"
                  slot="document-download-inline"
                />
              </div>
            )}

            <DocumentSummaryBlock
              summary={doc.summary}
              // The stored summary is read; generating one writes to the
              // owner's record, so a delegate reads what is there and has no
              // generate control.
              canGenerate={canManageDocuments}
              summaryState={doc.summaryState}
              generatedAtLabel={
                doc.summaryGeneratedAt
                  ? format.date(doc.summaryGeneratedAt)
                  : null
              }
              aiEnabled={aiEnabled}
              isGenerating={storedSummary.isPending}
              actionsDisabled={capability.isPending}
              onGenerate={generateStoredSummary}
            />

            {canManageDocuments && (
              <DocumentAiSection
                aiEnabled={aiEnabled}
                autoReadEnabled={autoReadEnabled}
                indexEnabled={indexEnabled}
                unavailableReason={capability.data?.reason ?? null}
                actionsDisabled={capability.isPending}
                onSuggest={runSuggest}
                suggestPending={suggest.isPending}
                suggestErrorKey={
                  suggest.isError ? aiErrorText(suggest.error) : null
                }
                onSummarise={runSummary}
                summaryPending={summary.isPending}
                suggestion={suggestion}
                suggestionKindLabel={suggestionKindLabel}
                suggestionDateLabel={suggestionDateLabel}
                appliedFields={appliedFields}
                onUseTitle={applyTitle}
                onUseKind={applyKind}
                onUseDate={applyDate}
                onDismissSuggestion={() => setSuggestion(null)}
                summaryOutput={summaryOutput}
                summaryResult={summary.data ?? null}
                summaryErrorKey={
                  summary.isError ? aiErrorText(summary.error) : null
                }
                onCloseSummary={() => {
                  setSummaryOutput(null);
                  summary.reset();
                }}
                hasContentIndex={doc.hasContentIndex}
                contentIndexSource={doc.contentIndexSource}
                lastIndexOutcome={doc.lastIndexOutcome}
                indexPending={indexDoc.isPending}
                onIndex={runIndex}
              />
            )}

            {mutationError ? (
              <p role="alert" className="text-destructive text-sm">
                {mutationError}
              </p>
            ) : null}

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="document-title-input">
                  {t("documents.detail.titleLabel")}
                </Label>
                {editingTitle ? (
                  <Input
                    id="document-title-input"
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={commitTitle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitTitle();
                      if (e.key === "Escape") setEditingTitle(false);
                    }}
                    maxLength={200}
                    placeholder={t("documents.detail.titlePlaceholder")}
                  />
                ) : !canManageDocuments ? (
                  <p
                    id="document-title-input"
                    className={cn(
                      "min-h-10 px-3 py-2 text-sm",
                      doc.title === null && "text-muted-foreground",
                    )}
                  >
                    {doc.title ?? t("documents.detail.titlePlaceholder")}
                  </p>
                ) : (
                  <button
                    type="button"
                    id="document-title-input"
                    onClick={() => {
                      setTitleDraft(doc.title ?? "");
                      setEditingTitle(true);
                    }}
                    className="border-input hover:bg-muted/50 focus-visible:ring-ring/50 flex min-h-10 w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm focus-visible:ring-[3px] focus-visible:outline-none"
                  >
                    <span
                      className={cn(
                        "truncate",
                        doc.title === null && "text-muted-foreground",
                      )}
                    >
                      {doc.title ?? t("documents.detail.titlePlaceholder")}
                    </span>
                    <Pencil
                      className="text-muted-foreground size-3.5 shrink-0"
                      aria-hidden
                    />
                  </button>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="document-kind-select">
                    {t("documents.detail.kindLabel")}
                  </Label>
                  {/* Read-only rather than absent: the value IS the content
                      a delegate came to read, and a form field that shows it
                      without accepting a change is the honest rendering. */}
                  <Select
                    value={doc.kind}
                    disabled={!canManageDocuments}
                    onValueChange={(value) =>
                      patch.mutate({ kind: value as InboundDocumentKindValue })
                    }
                  >
                    <SelectTrigger id="document-kind-select" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INBOUND_DOCUMENT_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {t(`documents.kind.${kind}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="document-date-field">
                    {t("documents.detail.dateLabel")}
                  </Label>
                  <DateField
                    id="document-date-field"
                    disabled={!canManageDocuments}
                    value={doc.documentDate ?? ""}
                    onChange={(value) =>
                      patch.mutate({
                        documentDate: value === "" ? null : value,
                      })
                    }
                    aria-label={t("documents.detail.dateLabel")}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-sm leading-none font-medium">
                  {t("documents.detail.conditionsLabel")}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {doc.conditionLinks.map((link) => (
                    <Link
                      key={link.episodeId}
                      href={`/illness/${link.episodeId}`}
                      className="bg-muted text-foreground hover:bg-muted/70 focus-visible:ring-ring/50 inline-flex max-w-48 items-center rounded-full px-2.5 py-1 text-xs focus-visible:ring-[3px] focus-visible:outline-none"
                    >
                      <span className="truncate">{link.name}</span>
                    </Link>
                  ))}
                  {doc.conditionLinks.length === 0 ? (
                    <span className="text-muted-foreground text-xs">
                      {t("documents.detail.noConditions")}
                    </span>
                  ) : null}
                  {canManageDocuments && (episodes.data?.length ?? 0) > 0 ? (
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 rounded-full px-2.5 text-xs"
                        >
                          <Plus className="size-3" aria-hidden />
                          {t("documents.detail.linkCondition")}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-64 p-2">
                        <ul className="max-h-56 space-y-0.5 overflow-y-auto overscroll-contain">
                          {episodes.data?.map((episode) => {
                            const linked = doc.conditionLinks.some(
                              (l) => l.episodeId === episode.id,
                            );
                            return (
                              <li key={episode.id}>
                                <button
                                  type="button"
                                  onClick={() => toggleEpisode(episode.id)}
                                  className="hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:ring-[3px] focus-visible:outline-none"
                                  aria-pressed={linked}
                                >
                                  <Check
                                    className={cn(
                                      "size-4 shrink-0",
                                      linked ? "opacity-100" : "opacity-0",
                                    )}
                                    aria-hidden
                                  />
                                  <span className="truncate">
                                    {episode.label}
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </PopoverContent>
                    </Popover>
                  ) : null}
                </div>
              </div>

              <DocumentEncounterSuggestion
                anchor={doc.reportDate ?? doc.documentDate}
                alreadyLinked={
                  doc.encounterLinks.length > 0 && pickedEncounterId === null
                }
                disabled={!canManageDocuments}
                value={pickedEncounterId}
                onChange={setSuggestedEncounter}
              />

              {/* A vaccination scan offers to file against the dose it records,
                  through the same ±7-day rule the visit suggestion uses. */}
              {doc.kind === "VACCINATION" ? (
                <VaccinationDocumentSuggestion
                  anchor={doc.reportDate ?? doc.documentDate}
                  documentId={doc.id}
                  disabled={!canManageDocuments}
                />
              ) : null}

              {/* "Belongs to visit" — read-only here on purpose. The filing
                  happens at the moment the document arrives, or from the
                  visit's own sheet; a second editor for the same link would
                  be a second place the set can be changed. Each row deep-links
                  to the vault filtered to that visit. */}
              {doc.encounterLinks.length > 0 ? (
                <div className="space-y-1.5" data-slot="document-visit-links">
                  <p className="text-sm leading-none font-medium">
                    {t("documents.detail.visitsLabel")}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {doc.encounterLinks.map((link) => (
                      <Link
                        key={link.encounterId}
                        href={`/documents?encounter=${encodeURIComponent(link.encounterId)}`}
                        className="bg-muted text-foreground hover:bg-muted/70 focus-visible:ring-ring/50 inline-flex max-w-64 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs focus-visible:ring-[3px] focus-visible:outline-none"
                      >
                        <span className="truncate">
                          {encounterKindText(t, link.kind as EncounterKind)}
                        </span>
                        {link.occurredAt ? (
                          <span className="text-muted-foreground shrink-0">
                            {format.date(link.occurredAt)}
                          </span>
                        ) : null}
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Staged-facts review + the stored-text extract recovery. The
                  existing extract/confirm chain finally gets its control on
                  the document itself: pending facts open the review, a read
                  lab document with nothing staged offers "Extract lab
                  values" over its stored text — never a re-upload. */}
              <DocumentFactsSection
                doc={doc}
                canManage={canManageDocuments}
                aiEnabled={aiEnabled}
                labsModuleEnabled={labsModuleEnabled}
              />

              {labsModuleEnabled && labFactCount > 0 ? (
                <Link
                  href="/labs"
                  data-slot="document-detail-lab-values-link"
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1.5 self-start rounded-md text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
                >
                  <FlaskConical className="size-4" aria-hidden="true" />
                  {t("documents.detail.labValuesLink", { count: labFactCount })}
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
              ) : null}

              <p className="text-muted-foreground text-xs">
                {t("documents.detail.uploadedMeta", {
                  date: format.date(doc.createdAt),
                  size: formatBytes(doc.byteSize, locale),
                })}
                {doc.filename ? ` · ${doc.filename}` : ""}
              </p>
            </div>
          </div>
        ) : null}
      </ResponsiveSheet>

      {doc ? (
        <DocumentShareSheet
          open={shareOpen}
          onOpenChange={setShareOpen}
          documents={[{ id: doc.id, title }]}
        />
      ) : null}
    </>
  );
}
