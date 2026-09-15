import type { Config } from "../config.js";
import { FakeEmailSender, SmtpEmailSender, type EmailSender } from "./sender.js";

export function createEmailSender(config: Config): EmailSender {
  if (config.EMAIL_MODE === "smtp") {
    return new SmtpEmailSender({
      host: config.SMTP_HOST!,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
      from: config.SMTP_FROM,
    });
  }
  return new FakeEmailSender();
}
