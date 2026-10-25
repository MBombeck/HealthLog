import { Buffer } from "node:buffer";

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];

/**
 * A GIF with the given logical screen and frames. Each frame carries one
 * byte of image data, which is enough for a header walk and for a decoder.
 */
export function gif(
  screen: { width: number; height: number; colourTable?: boolean },
  frames: Array<{
    width: number;
    height: number;
    left?: number;
    top?: number;
    extension?: boolean;
  }>,
): Buffer {
  const out: number[] = [...Buffer.from("GIF89a", "latin1")];
  out.push(...u16(screen.width), ...u16(screen.height));
  out.push(screen.colourTable ? 0x80 : 0x00, 0, 0);
  if (screen.colourTable) out.push(0, 0, 0, 255, 255, 255);
  for (const frame of frames) {
    if (frame.extension) {
      // A graphic control extension.
      out.push(0x21, 0xf9, 4, 0, 0, 0, 0, 0);
    }
    out.push(0x2c, ...u16(frame.left ?? 0), ...u16(frame.top ?? 0));
    out.push(...u16(frame.width), ...u16(frame.height), 0x80);
    out.push(0, 0, 0, 255, 255, 255); // local colour table, two entries
    out.push(2, 2, 0x44, 0x01, 0); // LZW size, one sub-block, terminator
  }
  out.push(0x3b);
  return Buffer.from(out);
}
