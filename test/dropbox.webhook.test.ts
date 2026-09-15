import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyDropboxSignature } from "../src/dropbox/webhook.js";

describe("verifyDropboxSignature", () => {
  const appSecret = "shh-app-secret";
  const body = Buffer.from(JSON.stringify({ list_folder: { accounts: ["dbid:abc123"] } }));

  it("accepts a correctly computed signature", () => {
    const signature = createHmac("sha256", appSecret).update(body).digest("hex");
    expect(verifyDropboxSignature(body, signature, appSecret)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const signature = createHmac("sha256", "wrong-secret").update(body).digest("hex");
    expect(verifyDropboxSignature(body, signature, appSecret)).toBe(false);
  });

  it("rejects a signature for a different body", () => {
    const otherBody = Buffer.from(JSON.stringify({ list_folder: { accounts: ["dbid:xyz"] } }));
    const signature = createHmac("sha256", appSecret).update(otherBody).digest("hex");
    expect(verifyDropboxSignature(body, signature, appSecret)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyDropboxSignature(body, undefined, appSecret)).toBe(false);
  });
});
