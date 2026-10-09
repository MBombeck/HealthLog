"use client";

/**
 * The readiness sheet, loaded when it first opens (v1.42, #613). Settings
 * mounts this, so the Modules page carries none of the timeline's code until
 * the switch is flipped on. Client-only: the sheet is closed on the server.
 */
import dynamic from "next/dynamic";

export const TimelineReadinessSheet = dynamic(
  () =>
    import("./readiness-sheet").then((m) => ({
      default: m.TimelineReadinessSheet,
    })),
  { ssr: false },
);
