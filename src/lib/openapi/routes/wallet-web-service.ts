/**
 * OpenAPI route table — Apple Wallet's pass web service (v1.50), the
 * `webServiceURL` inside every emergency-card pass. Apple's protocol: fixed
 * status codes, raw bodies, no envelope. Wallet calls it from the device;
 * nothing here is meant for another client.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The shared
 * logic lives in `src/lib/emergency-card/wallet-pass/web-service.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

const TAG = "wallet-web-service";

const applePassHeader = z.object({
  authorization: z
    .string()
    .describe(
      "`ApplePass <authenticationToken>`: the pass's own 64-hex token, derived from its link and serial number, never stored.",
    ),
});

const deviceId = z
  .string()
  .regex(/^[0-9A-Za-z]{1,128}$/)
  .describe(
    "Apple's `deviceLibraryIdentifier`. Stored as an HMAC only and scrubbed from logs.",
  );
const passTypeId = z
  .string()
  .describe("The Pass Type ID inside the pass (`passTypeIdentifier`).");
const serial = z
  .string()
  .uuid()
  .describe("The pass's `serialNumber`, a UUIDv4.");

const unauthorized = {
  description:
    "Bare 401, the same for an unknown serial, a wrong token, a foreign Pass Type ID and the operator's external-access switch off.",
};
const throttled = {
  description:
    "Bare 429 with `Retry-After`: the per-address limit, before any lookup.",
};

export const walletWebServicePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/wallet/apple/v1/devices/{deviceId}/registrations/{passTypeId}/{serial}":
    {
      post: {
        tags: [TAG],
        summary: "Register a device for a pass's updates",
        description:
          "v1.50. Wallet registers the device's pass push token. At most ten devices per pass; the next one replaces the oldest. A pass of an account asked to be deleted takes no new device. The push token is stored sealed (AES-256-GCM).",
        security: [],
        requestParams: {
          path: z.object({ deviceId, passTypeId, serial }),
          header: applePassHeader,
        },
        requestBody: {
          content: {
            "application/json": {
              schema: z
                .object({
                  pushToken: z
                    .string()
                    .regex(/^[0-9a-fA-F]{64,200}$/)
                    .describe("The device's pass push token, hex."),
                })
                .strict(),
            },
          },
        },
        responses: {
          "200": { description: "The device was registered already." },
          "201": { description: "The device is registered." },
          "400": { description: "The body is not `{ pushToken }`." },
          "401": unauthorized,
          "413": { description: "The body is larger than 4 KiB." },
          "429": throttled,
        },
      },
      delete: {
        tags: [TAG],
        summary: "Unregister a device from a pass",
        description: "v1.50. Wallet stops asking for the pass's updates.",
        security: [],
        requestParams: {
          path: z.object({ deviceId, passTypeId, serial }),
          header: applePassHeader,
        },
        responses: {
          "200": { description: "The device is no longer registered." },
          "401": unauthorized,
          "429": throttled,
        },
      },
    },
  "/api/wallet/apple/v1/devices/{deviceId}/registrations/{passTypeId}": {
    get: {
      tags: [TAG],
      summary: "The serial numbers of a device's changed passes",
      description:
        "v1.50. No `Authorization` (Apple's design): the device library id is the credential, looked up by HMAC. `passesUpdatedSince` is the `lastUpdated` tag this route gave before (Unix milliseconds); anything else reads as never.",
      security: [],
      requestParams: {
        path: z.object({ deviceId, passTypeId }),
        query: z.object({
          passesUpdatedSince: z
            .string()
            .optional()
            .describe("The `lastUpdated` of the previous answer."),
        }),
      },
      responses: {
        "200": {
          description: "Passes changed since the tag.",
          content: {
            "application/json": {
              schema: z
                .object({
                  serialNumbers: z.array(z.string()),
                  lastUpdated: z
                    .string()
                    .describe("Unix milliseconds of the newest change."),
                })
                .meta({ id: "WalletUpdatedSerials" }),
            },
          },
        },
        "204": {
          description:
            "Nothing changed, an unknown device, or a foreign Pass Type ID.",
        },
        "429": throttled,
      },
    },
  },
  "/api/wallet/apple/v1/passes/{passTypeId}/{serial}": {
    get: {
      tags: [TAG],
      summary: "The current version of a pass",
      description:
        "v1.50. Built from the record and signed for this request; a withdrawn pass in its withdrawn version (no QR code, no health data). Shares the owner's 30 downloads per pass and hour.",
      security: [],
      requestParams: {
        path: z.object({ passTypeId, serial }),
        header: applePassHeader.extend({
          "if-modified-since": z
            .string()
            .optional()
            .describe("The `Last-Modified` of the version the device holds."),
        }),
      },
      responses: {
        "200": {
          description: "The signed pass, with `Last-Modified`.",
          content: { "application/vnd.apple.pkpass": { schema: z.string() } },
        },
        "304": {
          description: "The device holds the current version already.",
        },
        "401": unauthorized,
        "429": throttled,
        "503": {
          description:
            "The pass cannot be signed right now; `Retry-After` says when to try again. Wallet keeps the version it has.",
        },
      },
    },
  },
  "/api/wallet/apple/v1/log": {
    post: {
      tags: [TAG],
      summary: "Wallet's error log",
      description:
        "v1.50. Counted on the wide event, never stored or logged. No credential (Apple's design).",
      security: [],
      requestBody: {
        content: {
          "application/json": {
            schema: z.object({ logs: z.array(z.string()) }),
          },
        },
      },
      responses: {
        "200": { description: "Received." },
        "413": { description: "The body is larger than 16 KiB." },
        "429": throttled,
      },
    },
  },
};
