import { simpleParser } from "mailparser";

export interface ParsedInboundEmail {
  fromAddr: string | null;
  toAddr: string | null;
  subject: string | null;
  date: Date | null;
  /** Raw bytes of an attached `message/rfc822` original, if present (PRD §7.2). */
  attachedOriginal: Buffer | null;
  /** True if there's an image attachment and no rfc822 original — likely a screenshot (Tier D). */
  hasImageAttachment: boolean;
}

const IMAGE_CONTENT_TYPE_PREFIX = "image/";
const RFC822_CONTENT_TYPE = "message/rfc822";

export async function parseInboundEmail(raw: Buffer): Promise<ParsedInboundEmail> {
  const parsed = await simpleParser(raw);

  const fromAddr = parsed.from?.value[0]?.address ?? null;
  const toField = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
  const toAddr = toField?.value[0]?.address ?? null;

  const rfc822Attachment = parsed.attachments.find((a) => a.contentType === RFC822_CONTENT_TYPE);
  const hasImageAttachment = parsed.attachments.some((a) =>
    a.contentType.startsWith(IMAGE_CONTENT_TYPE_PREFIX),
  );

  return {
    fromAddr: fromAddr?.toLowerCase() ?? null,
    toAddr: toAddr?.toLowerCase() ?? null,
    subject: parsed.subject ?? null,
    date: parsed.date ?? null,
    attachedOriginal: rfc822Attachment?.content ?? null,
    hasImageAttachment,
  };
}

export interface ParsedOriginalEmail {
  fromAddr: string | null;
  toAddr: string | null;
  subject: string | null;
  date: Date | null;
}

/** Parses just the headers of the attached original — used for the email_evidence record. */
export async function parseOriginalHeaders(raw: Buffer): Promise<ParsedOriginalEmail> {
  const parsed = await simpleParser(raw);
  const toField = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
  return {
    fromAddr: parsed.from?.value[0]?.address?.toLowerCase() ?? null,
    toAddr: toField?.value[0]?.address?.toLowerCase() ?? null,
    subject: parsed.subject ?? null,
    date: parsed.date ?? null,
  };
}
