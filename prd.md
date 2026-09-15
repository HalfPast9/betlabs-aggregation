# PRD — Submission Intake & Verification Archive

**Client:** Betlab
**Vendor:** Shrikar Vempati (contract)
**Status:** Draft v0.1 — open decisions flagged in §10
**Date:** 2026-09-04

---

## 1. Problem

Betlab currently receives verification evidence from participants over Telegram/WhatsApp as
loose screenshots and screen recordings. A participant receives funds, wagers them, and sends
back a screen recording of their in-app transaction history as proof. Signup confirmation
emails arrive the same way.

This evidence is unstructured, unsearchable, and reviewed by hand. There is no record linking
a submission to the participant, the amount granted, or whether the wagering condition was met.
There is no way to detect the same recording being submitted twice.

## 2. What this system is

A **searchable, auditable archive** of submitted evidence, with structured data extracted from
it and integrity signals attached to each record.

## 3. Goals

- G1 — Automatically ingest submissions from messaging channels without manual file handling
- G2 — Extract transaction rows from screen recordings into structured, queryable records
- G3 — Reconcile extracted wagering activity against the amount granted
- G4 — Attach integrity signals (duplicate, tamper, inconsistency) to each submission
- G5 — Give Betlab staff a console to search, filter, and audit any past submission
- G6 — Preserve raw evidence immutably so any record can be re-derived later

## 4. Non-goals — explicit

These are **out of scope for v1 and must not be assumed**:

- **The system does not approve, reject, or determine payout.** Betlab funds a participant only
  after confirming their signup email, so the system models that gate as an explicit state
  transition (§6.5) and surfaces a review queue — but the transition is performed by a person.
  The system records *who decided, when, and on what evidence*. It does not decide, and it does
  not initiate, schedule, or integrate with any money movement.
- Integrity signals are **annotations, not verdicts**. A flag means "a human should look at
  this," never "this is fraud."
- No participant recruitment, referral tracking, affiliate attribution, or payment processing.
- No integration with any casino operator, API, or account.
- No identity verification / KYC of participants.
- No automated messaging back to participants beyond receipt acknowledgement.

Rationale: the system is an evidence archive. Every capability that turns it into a
decisioning system materially increases both liability and scope.

## 5. Users

| User | Need |
|---|---|
| Betlab ops staff | Search submissions, view evidence, audit a specific participant or campaign |
| Betlab admin | Configure retention, manage staff access, export records |
| Participant | Submit evidence via bot, receive confirmation that it was received |

## 6. Architecture

```
Telegram bot  ──►  ingest service  ──►  object store (raw, immutable)
(self-hosted            │                      │
 Bot API server)        │                      ▼
                        └──────────────►  job queue
                                               │
                                               ▼
                                     extraction workers
                              (frame sample → VLM read → row stitch)
                                               │
                                               ▼
                              normalized records + integrity flags
                                               │
                                        ┌──────┴──────┐
                                        ▼             ▼
                                   Postgres      search index
                                        │
                                        ▼
                                 review console (web)
```

### 6.1 Ingest

**Files do not travel through the messaging channel.** Runners continue to communicate with
participants on WhatsApp. Intake is via **Dropbox File Request** into a Betlab-owned Dropbox
account. The system creates one file request per participant via `/2/file_requests/create`,
mapping request ID → participant → grant, so uploads self-attribute.

The participant opens the link, adds files, enters name and email, and uploads. No Dropbox
account, no app install. Uploaders cannot see the destination folder, its contents, or other
participants' submissions, and the folder stays private to Betlab by default.

**Dropbox is transport, not storage.** On ingest the system copies the file to its own
immutable object store, records the content hash, and purges the Dropbox copy. Nothing in the
archive depends on a file that remains in Dropbox.

**Why not participant-shared Dropbox links:**

- A shared link points at a live file that the person being verified still controls. They can
  replace or delete it after submission. Evidence must not sit in mutable storage owned by the
  submitting party.
- "Anyone with the link" URLs to a participant's financial transaction history circulate
  freely once pasted into a chat. File requests have no such exposure.
- §9 retention cannot be enforced on files in a participant's personal account.

**Why not receive media over WhatsApp:**

- WhatsApp re-encodes every video sent through the media path — downscaled to 720p or below at
  roughly 700 kbps–1.5 Mbps. Screen recordings of transaction lists are small dense text,
  which is the worst case for this compression.
- More importantly, re-encoding **destroys the source metadata that §7 integrity signals
  depend on**. `ENCODER_MISMATCH` and `FRAME_DISCONTINUITY` become inert if every submission
  arrives bearing WhatsApp's encoder signature. The requested tamper detection is not
  achievable through this path.
- Cloud API caps video at 16 MB and incoming media URLs expire ~5 minutes after receipt.

Dropbox does not re-encode. Files arrive bit-exact, which is what makes §7 viable at all.

**Change detection:** Dropbox webhook on the destination folder, then `list_folder/continue`
against a stored cursor. Polling fallback on a short interval in case a webhook is missed.

**Fallback:** a manual upload form in the console lets staff attach files that arrive out of
band, marked with a `MANUAL_INTAKE` provenance flag so their integrity signals are correctly
discounted.

### 6.2 Storage

Raw media is written once, never mutated, keyed by content hash. Extraction is always
re-runnable against the original. When the extractor improves, history is reprocessed rather
than re-collected.

### 6.3 Extraction

Screen recordings show a **scrolling** transaction list, so the same row appears across many
frames at different offsets. The pipeline is:

1. **Frame sampling** — sample at a fixed interval; drop near-identical frames via perceptual
   hash to avoid paying to read a static screen 40 times.
2. **Row reading** — a vision model reads each sampled frame and returns transaction rows as
   structured JSON (timestamp, type, amount, balance after).
3. **Stitching** — rows are deduplicated across frames using a stable row key
   (`hash(timestamp | type | amount | balance_after)`) and reassembled into one ordered list.
4. **Validation** — deterministic checks catch model error (see §7).

**Why a vision model rather than per-casino OCR templates:** the number of casino apps in
scope is open-ended. Hand-built parsers cost a fixed engineering effort *per casino* plus
regression fixtures, and break whenever an app updates its UI. A vision model generalizes
across layouts at the cost of per-submission inference spend and non-determinism. Given
unknown casino count and (currently) modest volume, that trade favours the model. The
non-determinism is contained by §7 validators, which are deterministic.

**Cost instrumentation is a v1 requirement**, not a nice-to-have: every extraction run records
its token/compute cost so unit economics are known before volume scales.

### 6.4 Review console

Thin web UI. The core view is **side-by-side**: extracted rows on one side, the raw recording
on the other, where clicking a row seeks the player to the frame it was read from. That
pairing is what makes the archive auditable rather than merely searchable.

Other views: submission list with filters (participant, casino, date, flag, status), a
participant detail view aggregating their submission history, and export to CSV.

## 7. Integrity signals

Deterministic checks, run after extraction. Each produces a flag with a severity, never a
decision.

| Code | Check |
|---|---|
| `DUPLICATE_MEDIA` | Content hash or perceptual hash matches a prior submission |
| `SHARED_ROWS` | Transaction rows identical to those in another participant's submission |
| `ARITHMETIC_MISMATCH` | Row amounts do not reconcile against displayed running balance |
| `WAGER_SHORTFALL` | Total wagered < amount granted |
| `TIMESTAMP_ANOMALY` | Rows out of order, dated in the future, or with implausible gaps |
| `ENCODER_MISMATCH` | Container/encoder metadata inconsistent with a native screen recorder |
| `FRAME_DISCONTINUITY` | Scroll-offset jumps or keyframe patterns consistent with splicing |
| `LOW_CONFIDENCE` | Model returned low-confidence reads on a material field |
| `SUBMISSION_GAP` | Recording timestamp far removed from the grant date |
| `MANUAL_INTAKE` | File arrived out of band; provenance unverified |
| `EMAIL_DKIM_PASS` | Original signature verified against sender's published key |
| `EMAIL_DKIM_FAIL` | Signature present but does not validate |
| `EMAIL_UNSIGNED` | No original signature present (inline forward or screenshot) |
| `EMAIL_SIGNER_UNRECOGNIZED` | `d=` domain not on the allowlist for this casino |
| `EMAIL_RECIPIENT_UNSIGNED` | `To:` not covered by the `h=` tag — recipient binding unproven |
| `EMAIL_PARTIAL_SIGNATURE` | `l=` tag present; body signed only in part |
| `DUPLICATE_ENROLLMENT_EMAIL` | Email address already used on another enrollment |
| `ALREADY_FUNDED` | Participant previously funded for this casino |
| `RECIPIENT_MISMATCH` | Signed `To:` differs from participant's registered address |
| `OUT_OF_SEQUENCE` | Evidence arrived for a state that should not have produced it |
| `EVIDENCE_CHANGED_AFTER_DECISION` | Artifact superseded after a decision relied on it |

**Provenance dependency:** `ENCODER_MISMATCH` and `FRAME_DISCONTINUITY` require the original
recording. Any file that has passed through a messaging app's transcoder carries that app's
encoder signature instead of the device's, and these two checks must be suppressed rather than
evaluated — a re-encoded file is not evidence of tampering. This is the primary technical
justification for §6.1.

### 7.1 On "AI-generated image" detection

The client requested detection of AI-generated images. **This is not recommended as a v1
capability.** General-purpose AI-image detectors are unreliable, and screenshots are the worst
case for them — a screenshot is already a flat synthetic-looking render, so false positives on
legitimate submissions are high and genuine manipulation is easily missed.

The checks above target the actual attack surface (reuse, splicing, fabricated numbers,
arithmetic that doesn't close) with far better signal and no false confidence. If Betlab still
wants a generative-content score, it should ship as an advisory field with a documented
accuracy caveat, and never as a gating flag.

### 7.2 Signup email verification

Signup confirmation emails are currently submitted as screenshots, which carry **no evidential
value** — the rendered HTML is editable in any browser before capture. This is the single
cheapest integrity upgrade available in the project.

**Required submission format: the original message forwarded as an attachment** to a dedicated
Betlab intake address. An inbound-parse service delivers raw MIME to a webhook; the system
extracts the attached `message/rfc822` byte-for-byte and verifies it.

The forwarding participant's own sending address arrives with the message, self-attributing the
submission without manual matching. Screen recordings continue to arrive via Dropbox file
request (§6.1) — the intake mailbox handles email evidence only.

**The inbound handler must require raw MIME**, not a parsed or normalized representation.
Any provider that reformats the message before delivery destroys the attached original.

**Why not an inline forward:** hitting Forward composes a new message from the participant's
own account. The original headers become body text and the original `DKIM-Signature` is not
broken but absent. It verifies only that the participant's mail provider sent some text, and
the apparent sender line is editable body content. Forwarding to the intake address does not
change this — the *attachment* is what preserves the evidence, not the destination.

**Auto-reply on missing original.** If no `message/rfc822` attachment is present, the system
replies with per-client instructions for forwarding as an attachment and leaves the enrollment
in `email_submitted`. This is the enforcement mechanism; it should not depend on runners
explaining the step correctly.

**Verification procedure at ingest:**

1. Parse the `.eml`, extract `DKIM-Signature`.
2. Fetch the public key from DNS at `<selector>._domainkey.<d-domain>`.
3. Recompute the body hash (`bh=`) and the signed-header hash under the canonicalization named
   in `c=`; compare.
4. **Persist the verdict, selector, `d=` domain, and the public key used.** Senders rotate
   DKIM keys and retire selectors; a message verifiable today may be unverifiable later
   through no fault of the submitter. Verification is point-in-time and must be recorded as
   such, not recomputed on read.
5. Confirm `h=` covers `To:`, `From:`, `Subject:`, `Date:`. Headers outside `h=` are unsigned
   and freely editable — `To:` in particular is what binds the message to this participant
   rather than to a confirmation email obtained from anyone else.
6. Flag presence of `l=`; a body-length tag means content can be appended below the signed
   portion without invalidating the signature.
7. Check `d=` against a per-casino allowlist. Operators commonly send via ESPs, so a valid
   signature may attest to the ESP rather than the casino — which proves nothing about which
   of that ESP's customers sent the message.

**Evidence tiering**, surfaced in the console:

| Tier | Form | Weight |
|---|---|---|
| A | Attached original, DKIM valid, allowlisted signer, `To:` signed | Cryptographic |
| B | Attached original, signature broken or signer unrecognized | Weak — human review |
| C | Inline forward (headers as body text) | Weak — human review |
| D | Screenshot | None — treat as unverified |

**Client-support caveat:** forward-as-attachment is well supported on desktop webmail and
patchy on mobile clients. Test against the devices participants actually use before making
Tier A the required standard; until then it is the requested format, with Tier C/D accepted,
flagged, and answered by the auto-reply above.

### 6.5 Enrollment lifecycle

Funding is gated on email confirmation, so the unit of work is not a submission but an
**enrollment**: one participant, one casino, tracked from first contact to close.

```
invited → email_submitted → email_verified → funded
        → wager_submitted → wager_verified → closed
                    ↘ rejected / abandoned (from any state)
```

The grant is a *transition*, not a precondition. Email evidence attaches to the enrollment
before any grant exists — this is the reason `submission` cannot hang off `grant` (§8).

**Two transitions are human decisions:** `email_verified → funded`, and
`wager_submitted → wager_verified`. The console presents a queue for each. The first is the
consequential one; it is the only point in the flow where verification prevents a loss rather
than documenting one, since after funding the money has already moved regardless of what the
recording shows.

**Decisions are recorded, not made.** Every transition writes an immutable `decision` row
capturing actor, from/to state, timestamp, free-text note, and an **evidence snapshot**: the
DKIM verdict, the set of flags present, and the content hashes of every artifact, as they stood
at the moment of the decision.

The snapshot is not redundant with the evidence itself. DKIM selectors get retired, flags get
recomputed when the extractor is upgraded, and evidence can be superseded. Because money moved
on the strength of a specific reviewer seeing a specific set of facts, that set of facts must
survive independently of anything that happens to the underlying records afterward.

**Pre-funding checks** run before an enrollment enters the funding queue and carry more weight
than anything post-funding:

- Email address already used on another enrollment
- This participant already funded for this casino
- `To:` address does not match the participant's registered address
- Enrollment created and email submitted within an implausibly short window

**Sequence violations** are flagged, not blocked: a wager recording arriving for an enrollment
that was never funded, or evidence uploaded after the decision that consumed it.

## 8. Data model (sketch)

- `participant` — id, contact, registered email address
- `enrollment` — id, participant, casino, state, created_at
- `grant` — enrollment, amount, sent_at, method (recorded after the fact; system does not
  initiate)
- `submission` — id, **enrollment**, kind (`signup_email` | `wager_recording`), channel,
  received_at, media_ref, content_hash, superseded_by
- `decision` — enrollment, actor, from_state, to_state, at, note, evidence_snapshot
  (append-only; hash-chained)
- `media_asset` — blob key, mime, bytes, duration, content_hash, source metadata
- `extraction_run` — submission, extractor version, model, timings, cost, status
- `transaction_row` — extraction_run, row_key, timestamp, type, amount, balance_after,
  source_frame_ts, confidence
- `reconciliation` — submission, wagered_total, granted_amount, delta, arithmetic_ok
- `integrity_flag` — submission, code, severity, detail, generated_by
- `email_evidence` — submission, tier, dkim_result, selector, d_domain, public_key_used,
  verified_at, h_tag_covers_to, l_tag_present, from_addr, to_addr, subject, sent_at
- `audit_event` — actor, action, target, at (every console view of raw media is logged)

## 9. Data handling

Submissions contain third parties' financial transaction history and are **sensitive personal
information under PIPEDA**. The following are requirements, not recommendations:

- **Betlab is the data controller. The vendor is a processor.** This must be stated in the
  contract, not assumed.
- **The system runs on infrastructure owned and paid for by Betlab.** Vendor-owned hosting
  makes the vendor custodian of the data indefinitely, at no benefit.
- Raw media retained **90 days**, then deleted. Extracted structured records retained
  indefinitely — the structured data is the product; the raw video is the liability.
- **Exception: signup email evidence for funded enrollments.** Money moved on the strength of
  this artifact, so it should be retained for Betlab's dispute window rather than 90 days.
  Betlab must specify that period (D9). Decision records and evidence snapshots are retained
  indefinitely regardless.
- **Dropbox holds no evidence at rest.** Files are copied to the archive and purged from the
  intake folder. Retention is enforceable only where Betlab controls the storage, which is why
  participant-owned shared links are excluded in §6.1.
- Encryption at rest and in transit. Object store not publicly addressable.
- Role-based access; every access to raw media written to `audit_event`.
- Participants receive a plain-language notice at bot signup describing what is collected,
  why, how long it is kept, and how to request deletion.
- On project handoff, vendor destroys all local copies and confirms in writing.

## 10. Open decisions

| # | Decision | Recommendation |
|---|---|---|
| D1 | Casino apps in v1 | Unbounded scope is not acceptable. Either name a fixed list for v1, or accept the model-based extractor in §6.3 and treat per-casino tuning as a change order. |
| D2 | Hosting | Betlab-owned cloud account. Vendor gets deploy access, not ownership. |
| D3 | Expected volume | Unknown. Blocks cost forecasting — instrument from day one and revisit at M1. |
| D4 | Console user count | Determines auth complexity. Assume <10 staff unless told otherwise. |
| D5 | Retention period | 90 days raw / indefinite structured, pending Betlab sign-off. |
| D6 | WhatsApp API integration | Not required. Runners keep WhatsApp for conversation; files move via Dropbox File Request (§6.1). |
| D7 | Dropbox account & plan | Betlab-owned, business plan. Confirm quota headroom — a full account silently stops accepting uploads. |
| D8 | Link distribution | Manual paste by runner in v1. Automated send is a phase-2 convenience, not a dependency. |
| D9 | Email evidence retention for funded enrollments | Betlab to specify, based on their dispute window. Not 90 days. |
| D10 | Two-person approval on funding? | Recommended if grant amounts are material. Cheap to add at M1, expensive to retrofit. |
| D11 | What happens to an enrollment funded on evidence later found bad? | Betlab's recovery process is out of scope, but the state machine needs a terminal state for it. |
| D12 | Inbound-parse provider for the intake mailbox | Must deliver raw MIME. Confirm before building — a provider that normalizes the message destroys the attached original. |

## 11. Milestones

**M0 — Archive (ships first, immediately useful)**
Dropbox File Request creation per participant, webhook ingest, copy-to-immutable-store with
hashing, Dropbox purge, submission records, basic search by participant/date. No extraction.
Runners paste links by hand. Betlab stops losing files on day one, and every file arrives
unmodified.

**M1 — Enrollment lifecycle & email verification**
Enrollment state machine, decision log with evidence snapshots, intake mailbox with
inbound-parse webhook, attachment extraction, auto-reply on missing original, DKIM verification
per §7.2, pre-funding duplicate checks, funding review queue in a minimal console.

This ships before extraction deliberately: it guards the only transition where money moves.

**M2 — Wager extraction**
Frame sampling, model-based row reading, stitching, reconciliation against grant amount.
Cost instrumentation.

**M3 — Remaining integrity signals**
Video-side flags per §7, duplicate detection across the corpus.

**M4 — Console & hardening**
Side-by-side review UI, exports, RBAC, audit log, retention job.

**Phase 2 (separate SOW)** — WhatsApp channel, per-casino tuning, generative-content advisory
score.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Casino scope grows unbounded | D1; per-casino work priced as change orders, not included |
| Extraction cost scales badly with volume | Frame dedup before inference; cost tracked per run from M1 |
| Model misreads amounts | Deterministic validators in §7; low-confidence flagging; raw media always retained for human check |
| Casino app UI changes | Model-based extraction degrades gracefully where templates would break outright |
| Participants don't complete browser upload | Measure drop-off from M0; file request is link-and-drop with no account needed |
| Dropbox quota fills, uploads silently rejected | Quota monitor with alert threshold; ingest purges Dropbox copies after archiving |
| Media arrives re-encoded despite §6.1 | `MANUAL_INTAKE` provenance flag; affected checks suppressed, not failed |
| Dropbox webhook missed | Cursor-based `list_folder/continue` polling fallback |
| Client expects fraud *decisions* | §4 non-goals; signals are advisory by design and documented as such |

## 13. Commercial notes (not part of the technical spec)

- Payment milestones should front-load against M0/M1 rather than concentrate on delivery.
- Per-casino adapter work, WhatsApp support, and any decisioning capability are explicitly
  outside this SOW.
- Confirm the data-processing terms in §9 are executed before any participant data is
  received.