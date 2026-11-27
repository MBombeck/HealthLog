"use client";

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ImageUp, Loader2, Trash2 } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { ApiError, apiFetchRaw, throwApiError } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { CONFIRMS_INLINE } from "@/lib/api/mutation-feedback";
import { statusText, type StatusMessage } from "./account-section-utils";
import { accountName, nameInitials } from "@/lib/account-name";
import { FileInput } from "@/components/ui/file-picker";

// Accepted upload types + byte cap mirror the server contract in
// `src/app/api/user/avatar/route.ts` so the client rejects an obvious
// bad file before the round-trip. The server still re-validates by
// magic-byte sniff — this is a UX shortcut, not the security boundary.
const ACCEPTED_AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];
const AVATAR_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** The profile photo, as the first line of the profile card. */
export function AvatarField() {
  const { t } = useTranslations();
  const { user, refetch } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<StatusMessage | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  const upload = useMutation({
    // Confirms in place: the status line under the photo.
    meta: CONFIRMS_INLINE,
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("file", file);
      const res = await apiFetchRaw("/api/user/avatar", {
        method: "POST",
        body,
      });
      if (!res.ok) await throwApiError(res);
    },
    onSuccess: async () => {
      setMsgType("success");
      setMsg({ key: "settings.avatar.uploaded" });
      await refetch();
    },
    onError: (err) => {
      setMsgType("error");
      setMsg(
        err instanceof ApiError && err.status === 415
          ? { key: "settings.avatar.invalidType" }
          : err instanceof ApiError && err.status === 413
            ? { key: "settings.avatar.tooLarge" }
            : { text: localizedApiError(err, t, "settings.avatar.error") },
      );
    },
  });

  const remove = useMutation({
    // Confirms in place: the status line under the photo.
    meta: CONFIRMS_INLINE,
    mutationFn: async () => {
      const res = await apiFetchRaw("/api/user/avatar", { method: "DELETE" });
      if (!res.ok) await throwApiError(res);
    },
    onSuccess: async () => {
      setMsgType("success");
      setMsg({ key: "settings.avatar.removed" });
      await refetch();
    },
    onError: (err) => {
      setMsgType("error");
      setMsg({ text: localizedApiError(err, t, "settings.avatar.error") });
    },
  });

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so re-selecting the same file still fires `onChange`.
    e.target.value = "";
    if (!file) return;
    setMsg(null);
    setMsgType(null);
    if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) {
      setMsgType("error");
      setMsg({ key: "settings.avatar.invalidType" });
      return;
    }
    if (file.size > AVATAR_MAX_UPLOAD_BYTES) {
      setMsgType("error");
      setMsg({ key: "settings.avatar.tooLarge" });
      return;
    }
    upload.mutate(file);
  }

  if (!user) return null;
  const avatarUrl = user.avatarUrl ?? null;
  const busy = upload.isPending || remove.isPending;

  // The photo is the first line of the profile card, not a card of its
  // own: the picture, the two actions, and the one line of limits. The
  // anchor stays `avatar`, so the search palette's "Profile photo" lands here.
  return (
    <div
      id="avatar"
      className="flex scroll-mt-28 items-center gap-4"
      data-slot="settings-avatar"
    >
      <Avatar className="size-14 shrink-0">
        {avatarUrl && <AvatarImage src={avatarUrl} alt={accountName(user)} />}
        <AvatarFallback className="text-base">
          {nameInitials(accountName(user))}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <FileInput
            ref={fileInputRef}
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleFile}
            aria-label={t("settings.avatar.title")}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {upload.isPending ? (
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <ImageUp className="size-4" />
            )}
            {avatarUrl
              ? t("settings.avatar.replace")
              : t("settings.avatar.upload")}
          </Button>
          {avatarUrl && (
            <ConfirmButton
              slot="settings-avatar-remove"
              destructive
              variant="ghost"
              size="sm"
              className="text-destructive"
              icon={<Trash2 className="size-4" />}
              label={t("settings.avatar.remove")}
              title={t("settings.avatar.removeTitle")}
              body={t("settings.avatar.removeBody")}
              confirmLabel={t("settings.avatar.removeConfirm")}
              disabled={busy && !remove.isPending}
              pending={remove.isPending}
              onConfirm={() => {
                setMsg(null);
                setMsgType(null);
                remove.mutate();
              }}
            />
          )}
        </div>
        {msg ? (
          <p
            role="alert"
            className={`text-xs ${
              msgType === "success" ? "text-success" : "text-destructive"
            }`}
          >
            {statusText(msg, t)}
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            {t("settings.avatar.hint")}
          </p>
        )}
      </div>
    </div>
  );
}
