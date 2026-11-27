"use client";

import { useId, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FileInput } from "@/components/ui/file-picker";
import { Label } from "@/components/ui/label";
import { ListGroup, ListItem } from "@/components/ui/list-row";
import { Textarea } from "@/components/ui/textarea";
import { useTranslations } from "@/lib/i18n/context";

import { MAX_PASTE_CHARS } from "./constants";

/**
 * The step of a source that takes text: a file row whose file is read into
 * the field, the field itself for pasting, one row that opens the example
 * and the columns, and below it what the last preview or import said. The
 * sheet's footer carries the pair (Preview / Import). Shared by the
 * measurement CSV, the JSON import and the dose history.
 */
export function ImportPasteBody({
  slug,
  fileMeta,
  accept,
  fileInputLabel,
  placeholder,
  text,
  onTextChange,
  onReadFailed,
  guideTitle,
  guideMeta,
  guide,
  status,
}: {
  /** `import-<slug>-…` test ids, as the cards had them. */
  slug: string;
  /** The file row's meta: format and limit. */
  fileMeta: string;
  accept: string;
  fileInputLabel: string;
  placeholder: string;
  text: string;
  onTextChange: (text: string) => void;
  onReadFailed: () => void;
  guideTitle: string;
  guideMeta?: string;
  /** What the guide row opens: the example, the columns, the docs link. */
  guide: React.ReactNode;
  /** The preview or result, and an error, announced as they change. */
  status: React.ReactNode;
}) {
  const { t } = useTranslations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaId = useId();
  const guideId = useId();
  const [guideOpen, setGuideOpen] = useState(false);

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      onTextChange(await file.text());
    } catch {
      onReadFailed();
    }
  }

  return (
    <>
      <ListGroup>
        <ListItem
          title={t("settings.sections.export.import.pickerFile")}
          meta={fileMeta}
          trailing={
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                data-testid={`import-${slug}-choose-file`}
              >
                {t("settings.sections.export.import.pickerChoose")}
              </Button>
              <FileInput
                ref={fileInputRef}
                accept={accept}
                className="sr-only"
                aria-label={fileInputLabel}
                tabIndex={-1}
                onChange={(e) => void onFileChange(e)}
              />
            </>
          }
        />
      </ListGroup>

      <div className="space-y-1.5">
        <Label htmlFor={textareaId}>
          {t("settings.sections.export.import.pasteOr")}
        </Label>
        <Textarea
          id={textareaId}
          data-testid={`import-${slug}-textarea`}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          rows={5}
          maxLength={MAX_PASTE_CHARS}
          spellCheck={false}
          placeholder={placeholder}
          className="font-mono sm:pointer-fine:text-xs"
        />
        <p className="text-muted-foreground text-right text-xs tabular-nums">
          {t("settings.sections.export.import.charCount", {
            used: text.length,
            max: MAX_PASTE_CHARS,
          })}
        </p>
      </div>

      <ListGroup>
        <ListItem
          data-testid={`import-${slug}-guide`}
          title={guideTitle}
          meta={guideMeta}
          expanded={guideOpen}
          controls={guideId}
          onSelect={() => setGuideOpen((open) => !open)}
        >
          {guideOpen ? (
            <div
              id={guideId}
              className="text-muted-foreground space-y-2 px-4 pb-3 text-xs"
            >
              {guide}
            </div>
          ) : null}
        </ListItem>
      </ListGroup>

      <div aria-live="polite" className="space-y-2">
        {status}
      </div>
    </>
  );
}

/** An import's refusal, in the step's live region. */
export function ImportErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-destructive flex items-start gap-2 text-sm">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
