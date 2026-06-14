import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySignature } from "./verify";

const SECRET = "test-webhook-secret";
const BODY = Buffer.from('{"action":"opened"}');

function makeSignature(body: Buffer, secret: string): string {
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hmac}`;
}

test("valid signature returns true", () => {
  const sig = makeSignature(BODY, SECRET);
  expect(verifySignature(BODY, sig, SECRET)).toBe(true);
});

test("off-by-one-byte signature returns false", () => {
  const sig = makeSignature(BODY, SECRET);
  // Flip last hex char
  const tampered = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
  expect(verifySignature(BODY, tampered, SECRET)).toBe(false);
});

test("missing header returns false (no throw)", () => {
  expect(verifySignature(BODY, null, SECRET)).toBe(false);
});

test("wrong secret returns false", () => {
  const sig = makeSignature(BODY, "wrong-secret");
  expect(verifySignature(BODY, sig, SECRET)).toBe(false);
});

test("malformed prefix returns false", () => {
  const sig = makeSignature(BODY, SECRET);
  // Replace sha256= prefix with sha1=
  const malformed = "sha1=" + sig.slice("sha256=".length);
  expect(verifySignature(BODY, malformed, SECRET)).toBe(false);
});
