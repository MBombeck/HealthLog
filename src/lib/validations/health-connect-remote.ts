/**
 * The body of `PUT /api/import/health-connect-remote`. Field by field: the
 * folder, the export's file name inside it, the WebDAV user name, the
 * password (optional on an update, which keeps the stored one), and whether
 * the scheduled fetch runs. The folder's reachability is decided by the
 * origin policy, not here.
 */
import { z } from "zod/v4";

export const healthConnectRemoteSchema = z
  .object({
    folderUrl: z.string().trim().min(8).max(2048),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((v) => !/[/\\]/.test(v) && v !== "." && v !== "..", {
        message: "A file name, not a path",
      })
      .default("Health Connect.zip"),
    username: z.string().trim().min(1).max(200),
    password: z.string().min(1).max(500).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
