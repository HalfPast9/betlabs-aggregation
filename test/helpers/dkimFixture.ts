import { generateKeyPairSync } from "node:crypto";
import { dkimSign } from "mailauth/lib/dkim/sign.js";
import type { DKIMSignOptions, DNSResolver } from "mailauth";

// mailauth's shipped .d.ts requires top-level signingDomain/selector/privateKey
// on DKIMSignOptions, but the real (documented, CLI-used) call shape is the
// `signatureData` array form — verified against the installed version's
// actual runtime behavior in email.dkim.test.ts. Cast past the stale type.
type RealDkimSignOptions = Partial<DKIMSignOptions> & {
  signatureData: Array<{
    signingDomain: string;
    selector: string;
    privateKey: string | Buffer;
    canonicalization?: string;
    maxBodyLength?: number;
  }>;
};

export interface DkimFixture {
  domain: string;
  selector: string;
  resolver: DNSResolver;
  sign(rawMessage: string, opts?: { maxBodyLength?: number }): Promise<string>;
}

/** A throwaway keypair + an in-memory DNS resolver serving its TXT record — no real DNS involved. */
export function createDkimFixture(domain: string, selector: string): DkimFixture {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const pubKeyBody = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const txtRecord = `v=DKIM1; k=rsa; p=${pubKeyBody}`;

  const resolver: DNSResolver = async (_name, rrtype) => (rrtype === "TXT" ? [[txtRecord]] : []);

  return {
    domain,
    selector,
    resolver,
    async sign(rawMessage: string, opts?: { maxBodyLength?: number }): Promise<string> {
      const options: RealDkimSignOptions = {
        signatureData: [
          {
            signingDomain: domain,
            selector,
            privateKey,
            canonicalization: "relaxed/relaxed",
            maxBodyLength: opts?.maxBodyLength,
          },
        ],
      };
      const result = await dkimSign(rawMessage, options as DKIMSignOptions);
      return result.signatures + rawMessage;
    },
  };
}

export function buildRawEmail(fields: {
  from: string;
  to: string;
  subject: string;
  date: string;
  body?: string;
}): string {
  return [
    `From: ${fields.from}`,
    `To: ${fields.to}`,
    `Subject: ${fields.subject}`,
    `Date: ${fields.date}`,
    "Content-Type: text/plain",
    "",
    fields.body ?? "Thanks for signing up.",
  ].join("\r\n");
}
