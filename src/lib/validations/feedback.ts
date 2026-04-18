import { z } from "zod/v4";

export const feedbackCategoryEnum = z.enum([
  "BUG",
  "FEATURE_REQUEST",
  "QUESTION",
  "OTHER",
]);

export const feedbackStatusEnum = z.enum([
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
  "ARCHIVED",
]);

// Strictly PNG / JPEG / WEBP / GIF data URLs. SVG intentionally excluded —
// it can carry inline JS that would execute when the admin inbox renders the
// preview.
const SCREENSHOT_DATA_URL =
  /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export const createFeedbackSchema = z.object({
  category: feedbackCategoryEnum.default("BUG"),
  subject: z.string().min(3).max(200),
  description: z.string().min(10).max(5000),
  screenshot: z
    .string()
    .max(7_000_000, "Screenshot too large (max 5 MB)")
    .regex(SCREENSHOT_DATA_URL, "Screenshot must be a base64-encoded PNG/JPEG/WEBP/GIF data URL")
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateFeedbackSchema = z.object({
  status: feedbackStatusEnum.optional(),
  adminNote: z.string().max(5000).nullable().optional(),
});

export type CreateFeedbackPayload = z.infer<typeof createFeedbackSchema>;
export type UpdateFeedbackPayload = z.infer<typeof updateFeedbackSchema>;
