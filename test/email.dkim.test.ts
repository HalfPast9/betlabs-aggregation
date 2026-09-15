import { describe, expect, it } from "vitest";
import { verifyDkim } from "../src/email/dkim.js";
import { createDkimFixture, buildRawEmail } from "./helpers/dkimFixture.js";

describe("verifyDkim", () => {
  it("passes for a validly signed message with To/From/Subject/Date all covered", async () => {
    const fixture = createDkimFixture("casino-esp.example", "sel1");
    const raw = buildRawEmail({
      from: "no-reply@casino-esp.example",
      to: "participant@example.com",
      subject: "Welcome to AcmeCasino",
      date: "Tue, 15 Sep 2026 12:00:00 +0000",
    });
    const signed = await fixture.sign(raw);

    const result = await verifyDkim(Buffer.from(signed), fixture.resolver);

    expect(result.result).toBe("pass");
    expect(result.selector).toBe("sel1");
    expect(result.dDomain).toBe("casino-esp.example");
    expect(result.hTagCoversTo).toBe(true);
    expect(result.lTagPresent).toBe(false);
    expect(result.publicKeyUsed).toContain("BEGIN");
  });

  it("reports no_signature for an unsigned message", async () => {
    const raw = buildRawEmail({
      from: "no-reply@casino-esp.example",
      to: "participant@example.com",
      subject: "Welcome",
      date: "Tue, 15 Sep 2026 12:00:00 +0000",
    });

    const result = await verifyDkim(Buffer.from(raw));
    expect(result.result).toBe("no_signature");
  });

  it("fails when the signature doesn't match the resolved key", async () => {
    const fixture = createDkimFixture("casino-esp.example", "sel1");
    const otherFixture = createDkimFixture("casino-esp.example", "sel1");
    const raw = buildRawEmail({
      from: "no-reply@casino-esp.example",
      to: "participant@example.com",
      subject: "Welcome",
      date: "Tue, 15 Sep 2026 12:00:00 +0000",
    });
    const signed = await fixture.sign(raw);

    // Verify against the WRONG fixture's resolver (different key served for the same selector/domain).
    const result = await verifyDkim(Buffer.from(signed), otherFixture.resolver);
    expect(result.result).toBe("fail");
  });

  it("detects an l= tag (partial body signature)", async () => {
    const fixture = createDkimFixture("casino-esp.example", "sel1");
    const raw = buildRawEmail({
      from: "no-reply@casino-esp.example",
      to: "participant@example.com",
      subject: "Welcome",
      date: "Tue, 15 Sep 2026 12:00:00 +0000",
      body: "This body is long enough that limiting it to a prefix still leaves room to append content after.",
    });
    const signed = await fixture.sign(raw, { maxBodyLength: 20 });

    const result = await verifyDkim(Buffer.from(signed), fixture.resolver);
    expect(result.result).toBe("pass");
    expect(result.lTagPresent).toBe(true);
  });
});
