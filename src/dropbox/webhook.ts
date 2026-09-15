import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies the `X-Dropbox-Signature` header: HMAC-SHA256 of the raw request
 * body, keyed by the app secret, hex-encoded. Dropbox webhook docs:
 * https://www.dropbox.com/developers/reference/webhooks#notifications
 */
export function verifyDropboxSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signatureHeader, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
