import nodemailer, { type Transporter } from "nodemailer";

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(email: OutboundEmail): Promise<void>;
}

/** Records sends in memory. Used in tests and as the default runtime mode until D12 is resolved. */
export class FakeEmailSender implements EmailSender {
  public readonly sent: OutboundEmail[] = [];

  async send(email: OutboundEmail): Promise<void> {
    this.sent.push(email);
  }
}

export interface SmtpEmailSenderOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/** Generic SMTP sender (works with SES, Postmark, a relay, etc.) — vendor-neutral until D12. */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(opts: SmtpEmailSenderOptions) {
    this.from = opts.from;
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: opts.user && opts.pass ? { user: opts.user, pass: opts.pass } : undefined,
    });
  }

  async send(email: OutboundEmail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: email.to, subject: email.subject, text: email.text });
  }
}

export function buildAutoReplyMessage(toAddr: string, casino: string): OutboundEmail {
  return {
    to: toAddr,
    subject: `Action needed: forward your ${casino} signup confirmation as an attachment`,
    text: [
      "Thanks for sending that over — we weren't able to find the original confirmation email attached.",
      "",
      'Please forward the signup confirmation again using your mail app\'s "Forward as attachment"',
      "option (not a regular Forward). This keeps the original message intact so we can verify it.",
      "",
      '- Gmail (web): open the email, click the three-dot menu, choose "Forward as attachment".',
      "- Outlook (desktop): select the email in the list (don't open it), then Home > Forward as Attachment.",
      "- Apple Mail: select the email in the list, then Message > Forward as Attachment.",
      "",
      "If your mail app doesn't support this, reply to this email and we'll help another way.",
    ].join("\n"),
  };
}
