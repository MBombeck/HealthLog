"use client";

/**
 * The clinician share-link CREATE flow, extracted so both surfaces mount the
 * exact same form: Settings → Sharing (the owner section) and the document
 * detail sheet's "Share" action. A share link is a time-boxed, scope-frozen,
 * read-only view of the owner's own record at `/c/<token>`, plus a hand-picked,
 * frozen-at-create document set. It serves a rendered page and those documents
 * and nothing else. A FHIR toggle and a resource-type picker were removed
 * that configured an endpoint no route ever served.
 *
 * The raw `hls_` token, the passphrase, and the `#k=` QR are returned EXACTLY
 * ONCE on create (the server stores only hashes); this component is the single
 * chance to capture them. Reads unwrap `(await res.json()).data`; the query key
 * comes from the centralised factory. No markdown anywhere — every value
 * renders as escaped React text.
 *
 * The caller owns the chrome (a `SettingsCard` in Settings, a `ResponsiveSheet`
 * in the document flow); this component renders only the form, the picker, and
 * the one-time reveal. Pass `initialDocuments` to pre-attach a document (the
 * document-launched flow seeds the document the user was looking at) and
 * `initialLabel` to pre-fill the label.
 */
import { useEffect, useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, FileText, Loader2, ScanLine, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ShareDocumentPicker,
  type PickedDocument,
} from "@/components/settings/share-document-picker";
import { ReportScopePicker } from "@/components/settings/report-selection/report-scope-picker";
import { ScopeSummary } from "@/components/settings/report-selection/scope-summary";
import type { ReportLeafId } from "@/lib/report-selection/catalogue";
import { orderLeaves } from "@/lib/report-selection/catalogue";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiPost } from "@/lib/api/api-fetch";
import {
  recentProofErrorMessage,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";

/** Maximum lifetime, in days — mirrors `SHARE_LINK_MAX_DAYS` on the server. */
export const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

/**
 * Maximum documents per share — mirrors `SHARE_LINK_MAX_DOCUMENTS` on the
 * server. Kept as a local literal (not imported from the validations module)
 * because that module pulls the Prisma client into scope and would drag the DB
 * into the client bundle; the server re-enforces the cap on create regardless.
 */
const MAX_DOCUMENTS = 50;

/** Owner-facing shape returned by `GET /api/share-links` (never the token). */
export interface ShareLinkSummary {
  id: string;
  label: string;
  rangeStart: string;
  rangeEnd: string | null;
  /** v1.18.7 — whether a passphrase second factor guards this link. */
  protected: boolean;
  /** v1.28 — size of the frozen document set (never the ids, never bytes). */
  documentCount: number;
  /**
   * Whether this link's frozen scope predates the selection model. Such links
   * were revoked on upgrade — their scope was "everything except mood and
   * cycle", which nobody chose — and the sharing list says so, so the owner
   * re-mints rather than wondering why a working link stopped.
   */
  needsReselection: boolean;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  lastAccessAt: string | null;
  accessCount: number;
  active: boolean;
}

/**
 * v1.18.7 — the create response. The token, passphrase, and URLs are returned
 * EXACTLY ONCE here; the list query never carries them (the server stores only
 * hashes). `qrUrl` carries the passphrase in the URL fragment (`#k=`).
 */
export interface ShareLinkCreated extends ShareLinkSummary {
  token: string;
  passphrase: string;
  shareUrl: string;
  qrUrl: string;
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** The create body posted to `POST /api/share-links`. */
export interface ShareLinkCreatePayload {
  label: string;
  rangeStart: string;
  rangeEnd: null;
  selection?: { v: 2; leaves: readonly string[] };
  documentIds?: string[];
  documentOnly?: boolean;
  expiresAt: string;
}

/**
 * The one leaf a share link may never carry — mirrored from the server, which
 * refuses it with a 422. The picker hides it rather than rendering a control
 * that cannot be honoured.
 */
const SHARE_HIDDEN_LEAVES: readonly ReportLeafId[] = ["INSURANCE"];

/**
 * Build the create payload from the resolved form state. Extracted as a pure
 * function so the two surfaces' scope contract is unit-testable without a DOM.
 *
 * The `documentOnly` branch is the privacy-load-bearing one: a document-launched
 * share posts NO report scope at all plus `documentOnly: true`,
 * and ALWAYS carries the picked document ids —
 * so the created link serves the document(s) and nothing else. The record share
 * (Settings → Sharing) keeps its full scope and only attaches documents when
 * the owner picked some.
 */
export function buildShareLinkCreatePayload(input: {
  label: string;
  rangeDays: number;
  expiryDays: number;
  leaves: readonly ReportLeafId[];
  documentIds: string[];
  documentOnly: boolean;
}): ShareLinkCreatePayload {
  const base = {
    label: input.label.trim(),
    rangeStart: isoDaysFromNow(-input.rangeDays),
    rangeEnd: null as null,
    expiresAt: isoDaysFromNow(input.expiryDays),
  };
  if (input.documentOnly) {
    return {
      ...base,
      documentOnly: true,
      // The launched document(s) always ride along — a documents-only share
      // with no document would be meaningless (the server 422s it).
      documentIds: input.documentIds,
    };
  }
  return {
    ...base,
    selection: { v: 2, leaves: input.leaves },
    // Omit the key entirely when nothing is attached (a documents-less record
    // share stays the default). The server re-validates each id as the caller's
    // own live document before minting the link.
    ...(input.documentIds.length > 0 ? { documentIds: input.documentIds } : {}),
  };
}

export function ShareLinkCreateForm({
  documentOnly = false,
  initialDocuments,
  initialLabel,
  initialRangeDays,
  initialExpiryDays,
  onCreated,
}: {
  /**
   * Documents-only mode (the document-launched flow). Hides the record-scope
   * control — the history-range selector — and posts an empty report scope so
   * the minted link serves ONLY the attached document(s). Keeps the document
   * picker, label, expiry, and one-time passphrase reveal.
   */
  documentOnly?: boolean;
  /** Documents to pre-attach — the document-launched flow seeds the one doc. */
  initialDocuments?: PickedDocument[];
  /** Optional pre-filled label (e.g. the document title). */
  initialLabel?: string;
  /**
   * Optional pre-filled window and lifetime, in days. The sharing list passes
   * these when the owner re-mints a link the selection upgrade closed, so the
   * only decision left in front of them is the one that link never carried:
   * what it should contain.
   */
  initialRangeDays?: number;
  initialExpiryDays?: number;
  /** Fired after a link is minted, so an outer surface can react if needed. */
  onCreated?: (created: ShareLinkCreated) => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [label, setLabel] = useState(initialLabel ?? "");
  const [rangeDays, setRangeDays] = useState(initialRangeDays ?? DEFAULT_DAYS);
  const [expiryDays, setExpiryDays] = useState(
    initialExpiryDays ?? DEFAULT_DAYS,
  );
  const [selectedDocs, setSelectedDocs] = useState<PickedDocument[]>(
    initialDocuments ?? [],
  );
  // A new link starts with an empty scope. The picker's standard-report button
  // fills it in one click, minus the leaf a link may not carry — but a link is
  // handed to another person, so nothing rides on it that was not ticked.
  const [selectedLeaves, setSelectedLeaves] = useState<
    ReadonlySet<ReportLeafId>
  >(() => new Set<ReportLeafId>());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [created, setCreated] = useState<ShareLinkCreated | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "passphrase" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const scopeSummaryId = useId();

  // Render the QR from the `#k=` deep link once a link is created. The fragment
  // carries the passphrase, so the QR alone opens the record — it is shown
  // exactly once alongside the passphrase text. The QR is keyed off `qrUrl` so
  // a re-create swaps it; the effect only WRITES on async completion (never a
  // synchronous reset), so it does not trigger a cascading render.
  const qrUrl = created?.qrUrl ?? null;
  useEffect(() => {
    if (!qrUrl) return;
    let cancelled = false;
    // Dynamic import so `qrcode` code-splits out of the settings chunk — the
    // QR is only ever rendered after a link is created, so the library never
    // needs to ship eagerly.
    import("qrcode")
      .then(({ default: QRCode }) =>
        // Render at a high pixel density (the display size is capped in CSS) so
        // the code stays crisp when scaled up for on-the-spot phone scanning.
        QRCode.toDataURL(qrUrl, { margin: 2, width: 512 }),
      )
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        /* clipboard/QR can fail in some contexts; the link + passphrase text
           are still shown so the owner can share them by hand */
      });
    return () => {
      cancelled = true;
    };
  }, [qrUrl]);

  // A share link opens the record without signing in, so making one asks for
  // a fresh proof unless the session signed in or re-proved within minutes.
  const recentProof = useRecentProof();

  const createMutation = useMutation({
    mutationFn: () => {
      // Surface the same expiry-bound the server enforces before the round
      // trip, so the validation feedback is immediate.
      if (expiryDays < 1 || expiryDays > MAX_DAYS) {
        return Promise.reject(new Error("EXPIRY_RANGE"));
      }
      const payload = buildShareLinkCreatePayload({
        label,
        rangeDays,
        expiryDays,
        leaves: orderLeaves(selectedLeaves),
        documentIds: selectedDocs.map((d) => d.id),
        documentOnly,
      });
      return recentProof.run(() =>
        apiPost<ShareLinkCreated>("/api/share-links", payload),
      );
    },
    onSuccess: (result) => {
      // Clear any stale QR before the effect renders the new one.
      setQrDataUrl(null);
      setCreated(result);
      setCopied(null);
      setLabel("");
      // The document set is frozen onto the link now — reset the picker so the
      // next link starts clean.
      setSelectedDocs([]);
      setFormError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks() });
      onCreated?.(result);
    },
    onError: (err: Error) => {
      setCreated(null);
      setFormError(
        err.message === "EXPIRY_RANGE"
          ? t("settings.sharing.expiryInvalid", { max: MAX_DAYS })
          : recentProofErrorMessage(err, t("common.error")),
      );
    },
  });

  async function copyValue(value: string, which: "link" | "passphrase") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
    } catch {
      // Clipboard can be unavailable (insecure context); the values stay
      // visible in the card so the owner can copy them by hand.
    }
  }

  return (
    <>
      {recentProof.dialog}
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          createMutation.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="share-label">{t("settings.sharing.label")}</Label>
          <Input
            id="share-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("settings.sharing.labelPlaceholder")}
            maxLength={120}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* The history-range window only scopes the report — meaningless for
              a documents-only share, so it is hidden there. */}
          {!documentOnly ? (
            <div className="space-y-1.5">
              <Label htmlFor="share-range">{t("settings.sharing.range")}</Label>
              <Input
                id="share-range"
                type="number"
                min={1}
                max={3650}
                value={rangeDays}
                onChange={(e) =>
                  setRangeDays(Math.max(1, Number(e.target.value) || 1))
                }
              />
              <p className="text-muted-foreground text-xs">
                {t("settings.sharing.rangeHint")}
              </p>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="share-expiry">{t("settings.sharing.expiry")}</Label>
            <Input
              id="share-expiry"
              type="number"
              min={1}
              max={MAX_DAYS}
              value={expiryDays}
              onChange={(e) =>
                setExpiryDays(Math.max(1, Number(e.target.value) || 1))
              }
              aria-invalid={expiryDays < 1 || expiryDays > MAX_DAYS}
            />
            <p className="text-muted-foreground text-xs">
              {t("settings.sharing.expiryHint", { max: MAX_DAYS })}
            </p>
          </div>
        </div>

        {/* ── What the link contains ───────────────────────────────── */}
        {!documentOnly ? (
          <div className="space-y-3">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">
                {t("settings.sharing.scopeTitle")}
              </Label>
              <p className="text-muted-foreground text-xs">
                {t("settings.sharing.scopeInsuranceExcluded")}
              </p>
            </div>
            <ReportScopePicker
              surface="share"
              selected={selectedLeaves}
              onChange={setSelectedLeaves}
              hiddenLeaves={SHARE_HIDDEN_LEAVES}
            />
            <ScopeSummary
              t={t}
              id={scopeSummaryId}
              surface="share"
              selected={selectedLeaves}
            />
          </div>
        ) : null}

        {/* ── Attach documents ─────────────────────────────────────── */}
        <div className="border-border space-y-2 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">
                {t("settings.sharing.attachTitle")}
              </Label>
              <p className="text-muted-foreground text-xs">
                {t("settings.sharing.attachCount", {
                  count: selectedDocs.length,
                  max: MAX_DOCUMENTS,
                })}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 shrink-0 sm:min-h-9"
              onClick={() => setPickerOpen(true)}
              data-testid="share-attach-open"
            >
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              {t("settings.sharing.attachButton")}
            </Button>
          </div>

          {selectedDocs.length > 0 ? (
            <ul
              className="flex flex-wrap gap-1.5"
              data-testid="share-attached-chips"
            >
              {selectedDocs.map((doc) => (
                <li key={doc.id}>
                  <span className="bg-muted inline-flex max-w-full items-center gap-1 rounded-full py-1 pr-1 pl-2.5 text-xs">
                    <span className="max-w-[12rem] truncate">{doc.title}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedDocs((prev) =>
                          prev.filter((d) => d.id !== doc.id),
                        )
                      }
                      className="hover:bg-background/80 focus-visible:ring-ring/50 relative flex size-5 shrink-0 items-center justify-center rounded-full after:absolute after:-inset-x-1 after:-inset-y-3 focus-visible:ring-[3px] focus-visible:outline-none"
                      aria-label={t("settings.sharing.attachRemove", {
                        title: doc.title,
                      })}
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <p className="text-muted-foreground text-xs">
            {t("settings.sharing.attachFrozen")}
          </p>
          {selectedDocs.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              {t("settings.sharing.exifNote")}
            </p>
          ) : null}
        </div>

        {formError && (
          <p role="alert" className="text-destructive text-sm">
            {formError}
          </p>
        )}

        {/* A record link with an empty scope cannot be minted: it would serve
            a page with nothing on it. The scope line above says so and says
            what to do about it, and describes the button so the disabled state
            is not silent for a screen reader. */}
        <SettingsCardActions>
          <Button
            type="submit"
            size="sm"
            disabled={
              createMutation.isPending ||
              !label.trim() ||
              (!documentOnly && selectedLeaves.size === 0)
            }
            aria-describedby={documentOnly ? undefined : scopeSummaryId}
            data-testid="share-create-submit"
            className="min-h-11 sm:min-h-9"
          >
            {createMutation.isPending && (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t("settings.sharing.create")}
          </Button>
        </SettingsCardActions>
      </form>

      <ShareDocumentPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selected={selectedDocs}
        onSelectedChange={setSelectedDocs}
        max={MAX_DOCUMENTS}
      />

      {created && (
        <div
          className="bg-success/10 space-y-3 rounded-lg p-3 text-sm"
          data-testid="share-token-reveal"
        >
          <p className="text-success font-medium">
            {t("settings.sharing.tokenCreated")}
          </p>
          {created.documentCount > 0 && (
            <p
              className="text-foreground text-xs font-medium"
              data-testid="share-created-doc-count"
            >
              {t("settings.sharing.documentCount", {
                count: created.documentCount,
              })}
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            {t("settings.sharing.shownOnce")}
          </p>

          {/* QR — carries the passphrase in the URL fragment, so scanning it
              opens the record (and its shared documents). Promoted as the
              primary mobile affordance: a clinician scans it on the spot to
              open the record on their own device. Shown exactly once. The
              white quiet-zone is the documented QR exemption (ui-standards.md §4)
              so the code stays scannable in the dark theme too. */}
          {qrDataUrl && (
            <div
              className="border-border bg-background flex flex-col items-center gap-2 rounded-lg border p-4 text-center"
              data-testid="share-qr-block"
            >
              <div className="flex items-center gap-1.5">
                <ScanLine className="text-foreground size-4" aria-hidden />
                <p className="text-foreground text-sm font-medium">
                  {t("settings.sharing.qrScanTitle")}
                </p>
              </div>
              {/* The QR is a transient secret render, not stored content. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrDataUrl}
                alt={t("settings.sharing.qrAlt")}
                width={512}
                height={512}
                className="h-auto w-full max-w-[15rem] rounded-md border bg-white p-2 sm:max-w-[13rem]"
              />
              <p className="text-muted-foreground max-w-xs text-xs">
                {t("settings.sharing.qrScanHint")}
              </p>
            </div>
          )}

          {/* The link (no passphrase). On its own it cannot open the record. */}
          <div className="space-y-1">
            <p className="text-foreground text-xs font-medium">
              {t("settings.sharing.linkLabel")}
            </p>
            <div className="flex items-center gap-2">
              <code className="bg-muted block flex-1 rounded p-2 font-mono text-xs break-all">
                {created.shareUrl}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="min-h-11 min-w-11 shrink-0 sm:h-9 sm:w-9"
                onClick={() => copyValue(created.shareUrl, "link")}
                aria-label={t("settings.sharing.copyLink")}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            {copied === "link" && (
              <p className="text-success text-xs">
                {t("settings.sharing.copied")}
              </p>
            )}
          </div>

          {/* The passphrase — the second factor. Shown once; only its hash is
              stored, so it cannot be recovered. */}
          <div className="space-y-1">
            <p className="text-foreground text-xs font-medium">
              {t("settings.sharing.passphraseLabel")}
            </p>
            <div className="flex items-center gap-2">
              <code
                className="bg-muted block flex-1 rounded p-2 font-mono text-xs break-all"
                data-testid="share-passphrase"
              >
                {created.passphrase}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="min-h-11 min-w-11 shrink-0 sm:h-9 sm:w-9"
                onClick={() => copyValue(created.passphrase, "passphrase")}
                aria-label={t("settings.sharing.copyPassphrase")}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            {copied === "passphrase" && (
              <p className="text-success text-xs">
                {t("settings.sharing.copied")}
              </p>
            )}
            <p className="text-muted-foreground text-xs">
              {t("settings.sharing.passphraseHint")}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
