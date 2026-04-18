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

export const createFeedbackSchema = z.object({
  category: feedbackCategoryEnum.default("BUG"),
  subject: z.string().min(3).max(200),
  description: z.string().min(10).max(5000),
  screenshot: z
    .string()
    .max(7_000_000, "Screenshot too large (max 5 MB)")
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateFeedbackSchema = z.object({
  status: feedbackStatusEnum.optional(),
  adminNote: z.string().max(5000).nullable().optional(),
});

export type CreateFeedbackPayload = z.infer<typeof createFeedbackSchema>;
export type UpdateFeedbackPayload = z.infer<typeof updateFeedbackSchema>;
