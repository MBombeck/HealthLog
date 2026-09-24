/**
 * Turn a producer of text or bytes into a response body, with backpressure
 * and cancellation.
 *
 * The export routes used to build their whole file as one string and hand it
 * to the response. For an account of 1.25 million measurements that string
 * and the object graph behind it did not fit a 1 GB container: one export
 * took the app down for every user of the instance (#1031). The file is now
 * written into the response as it is produced.
 *
 * Backpressure: the producer's `write` waits while the client is slower than
 * the database, so nothing piles up in between. Cancellation: when the client
 * goes away, the next `write` throws `ResponseStreamClosedError`, which stops
 * the producer instead of leaving it to finish a file nobody reads.
 */
import { PassThrough, Readable } from "node:stream";

/** The client closed the response before the producer finished. */
export class ResponseStreamClosedError extends Error {
  constructor() {
    super("The response was closed before the file was complete");
    this.name = "ResponseStreamClosedError";
  }
}

export type ResponseProducer = (
  write: (chunk: string | Buffer) => Promise<void>,
) => Promise<unknown>;

export interface ResponseStreamHooks {
  /** Runs once the producer has written everything. */
  onComplete?: () => unknown;
  /**
   * Runs when the producer failed or the client left. The response has
   * already started, so the client receives a truncated file; a truncated
   * JSON file does not parse, and a truncated archive fails its tag.
   */
  onError?: (err: unknown) => unknown;
}

/** Start `producer` and return the web stream its output flows into. */
export function streamToResponseBody(
  producer: ResponseProducer,
  hooks: ResponseStreamHooks = {},
): ReadableStream<Uint8Array> {
  const out = new PassThrough();

  const write = async (chunk: string | Buffer): Promise<void> => {
    if (out.destroyed || out.writableEnded)
      throw new ResponseStreamClosedError();
    if (out.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        out.off("close", onClose);
        resolve();
      };
      const onClose = () => {
        out.off("drain", onDrain);
        reject(new ResponseStreamClosedError());
      };
      out.once("drain", onDrain);
      out.once("close", onClose);
    });
  };

  void (async () => {
    try {
      await producer(write);
      out.end();
      await hooks.onComplete?.();
    } catch (err) {
      out.destroy(err instanceof Error ? err : new Error(String(err)));
      try {
        await hooks.onError?.(err);
      } catch {
        // Reporting a failure must not raise another one.
      }
    }
  })();

  return Readable.toWeb(out) as ReadableStream<Uint8Array>;
}
