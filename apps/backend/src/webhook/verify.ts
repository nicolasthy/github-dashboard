import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies the X-Hub-Signature-256 header from a GitHub webhook delivery.
 * Returns false (never throws) for: missing header, malformed prefix, length mismatch, signature mismatch.
 */
export function verifySignature(
  rawBody: Buffer,
  headerValue: string | null,
  secret: string,
): boolean {
  if (!headerValue) return false;
  if (!headerValue.startsWith("sha256=")) return false;

  const receivedHex = headerValue.slice("sha256=".length);
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  // Length check before timingSafeEqual (must be same length)
  if (receivedHex.length !== expected.length) return false;

  const receivedBuf = Buffer.from(receivedHex, "hex");
  const expectedBuf = Buffer.from(expected, "hex");

  // Both buffers must be same byte length for timingSafeEqual
  if (receivedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(receivedBuf, expectedBuf);
}
