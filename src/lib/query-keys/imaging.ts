/**
 * Query keys — imaging exams (#1672).
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const imagingKeys = {
  /** The root every exam write evicts: the list and every open detail. */
  imaging: () => ["imaging"] as const,
  imagingList: () => ["imaging", "list"] as const,
  imagingExam: (id: string) => ["imaging", "detail", id] as const,
  imagingCreate: () => ["imaging", "create"] as const,
  imagingUpdate: () => ["imaging", "update"] as const,
  imagingDelete: () => ["imaging", "delete"] as const,
  imagingUpload: () => ["imaging", "upload"] as const,
} as const;
