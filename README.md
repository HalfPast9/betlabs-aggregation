# Betlab Submission Archive

Evidence archive and verification workflow for Betlab. See `prd.md` for the full spec. All five
milestones (M0–M4) are implemented:

- **M0 — Archive**: Dropbox File Request ingest → immutable, content-addressed, searchable store.
- **M1 — Enrollment lifecycle & email verification**: full state machine with hash-chained decision
  log, inbound-email intake with real DKIM verification, pre-funding checks, funding/wager queues.
- **M2 — Wager extraction**: scroll reconstruction (the recording is stitched into one image of
  the whole list, cut on row boundaries), a vision-model row reader, balance-chain verification
  that makes completeness measurable, reconciliation against the grant, cost instrumentation.
  Measured at 100% row recall/precision on a real recording (`docs/extraction-benchmark.md`).
- **M3 — Remaining integrity signals**: encoder/keyframe checks, cross-submission duplicate-media
  and shared-row detection, submission-gap and manual-intake flags.
- **M4 — Console & hardening**: a review console (stitched list or recording beside the extracted
  rows, click a row to highlight it in place), CSV exports, per-staff RBAC (ops/admin), audit log,
  a real retention job.

## Status of external dependencies

Every third-party integration this project needs is behind an interface with a **fake**
implementation (used by default, and by the whole test suite — no credentials required to run or
test this repo) and a **real** implementation ready to switch on via env var once Betlab has the
account/credentials. Nothing here is mocked-and-forgotten: the fake and real implementations share
the same interface, so swapping is a config change, not a code change.

| Integration | Status | Switch |
|---|---|---|
| Dropbox (PRD D7) | No Betlab app/account yet | `DROPBOX_MODE=fake\|real` |
| Object storage (PRD D2) | No hosting vendor chosen | `OBJECT_STORE_DRIVER=LOCAL\|S3` (S3 mode works against AWS S3, R2, MinIO, Spaces) |
| Inbound email provider (PRD D12) | No provider chosen | accepts raw MIME directly (what our tests use) or `multipart/form-data` shaped like SendGrid Inbound Parse — see `src/routes/inboundEmail.ts` |
| Outbound email (auto-reply) | No provider chosen | `EMAIL_MODE=fake\|smtp` (SMTP is vendor-neutral — SES, Postmark, a relay, etc.) |
| DKIM verification | **Real**, not faked | Runs real RSA/DNS verification (via `mailauth`) against whatever `dkimResolver` is configured; production uses live DNS. Tested against a real generated keypair + signed message, not mocks. |
| Wager-extraction vision model | No API key provisioned | `VISION_MODE=fake\|claude` (`claude` calls the Anthropic API with `ANTHROPIC_API_KEY`) |

Frame sampling, perceptual hashing, and encoder/keyframe probing are **not** faked — they run real
`ffmpeg`/`ffprobe` and are tested against real generated videos.

## Setup

```bash
cp .env.example .env
docker compose up -d          # local Postgres
npm install
npx prisma migrate dev        # applies prisma/schema.prisma
npm run dev                   # http://localhost:3000/console
```

Everything defaults to fake mode (`DROPBOX_MODE=fake`, `EMAIL_MODE=fake`, `VISION_MODE=fake`), so
the full pipeline — participant → enrollment → file request → ingest → state transitions →
extraction → integrity flags → review console — runs end to end with zero external credentials.

Run tests (spins up against the same local Postgres, resets tables between test files):

```bash
npm test
```

## The console

`GET /console` is a single-page, no-build-step review console. Sign in by pasting a staff API
token (the bootstrap admin token is whatever `STAFF_API_TOKEN` is in `.env`). From there:

- **Search** — filter submissions by participant, casino, enrollment state, or integrity flag; export to CSV.
- A submission's detail view is the **side-by-side review** PRD §6.4 asks for: the raw recording
  on one side, extracted rows on the other — click a row and the player seeks to the frame it was
  read from.
- **Funding queue** / **Wager queue** — the two human-decision points in the lifecycle, with
  pre-funding checks surfaced inline.
- **Participants** — create participants/enrollments, generate a Dropbox file-request link.
- **Staff** / **Retention** — admin-only: manage staff accounts and tokens, configure the
  retention window, trigger a retention run.

## API surface

All routes except `GET /health`, `/webhooks/dropbox`, `/inbound/email`, and `GET /console` require
`Authorization: Bearer <token>`, checked against `StaffUser` (PRD §9 role-based access — `ops` or
`admin`). The bootstrap admin is seeded from `STAFF_API_TOKEN` on first run; every token after
that is minted via `POST /staff-users` (admin-only) and shown exactly once.

**Participants & enrollments**
- `POST /participants`, `GET /participants`, `GET /participants/:id` (aggregated submission history)
- `POST /participants/:id/enrollments`
- `POST /enrollments/:id/file-requests` — Dropbox File Request scoped to the enrollment (PRD D8: link is pasted to the participant by hand)

**Ingest**
- `GET/POST /webhooks/dropbox` — Dropbox change notification → sync
- `POST /inbound/email` (optional `?token=` shared secret) — raw MIME signup-email evidence (PRD §7.2)
- `POST /submissions/manual` (multipart) — out-of-band fallback

**Lifecycle** (PRD §6.5 state machine: `invited → email_submitted → email_verified → funded →
wager_submitted → wager_verified → closed`, with `rejected`/`abandoned` reachable from any
non-terminal state)
- `GET /enrollments/:id`, `GET /enrollments/:id/decisions` (hash-chained audit trail)
- `GET /enrollments/funding-queue`, `POST /enrollments/:id/fund` (human decision; optional grant)
- `GET /enrollments/wager-queue`, `POST /enrollments/:id/verify-wager` (human decision)
- `POST /enrollments/:id/close`, `POST /enrollments/:id/rejected`, `POST /enrollments/:id/abandoned`
- `GET/POST /dkim-allowlist` (admin-only writes) — per-casino allowed DKIM signing domains

**Evidence & extraction**
- `GET /submissions?participantId=&enrollmentId=&casino=&state=&flag=&from=&to=`
- `GET /submissions/:id` — full detail (media, extraction runs, rows, reconciliation, flags)
- `GET /submissions/:id/media` — streams raw bytes; every call writes an `AuditEvent` (PRD §9); `410` once retention has purged it
- `POST /submissions/:id/extract` — manual (re-)trigger; auto-runs after ingest when `AUTO_EXTRACT_ON_INGEST=true` (default)
- `GET /submissions/:id/extraction-runs`

**Admin**
- `GET/POST/DELETE /staff-users`, `GET /me`
- `GET/PUT /retention-settings`, `POST /retention/run`
- `GET /dropbox-quota` — PRD §12 risk ("Dropbox quota fills, uploads silently rejected"); a
  background check also writes an `AuditEvent` once usage crosses `DROPBOX_QUOTA_WARNING_THRESHOLD`

**Exports**
- `GET /exports/submissions.csv`, `GET /exports/decisions.csv`

## Design notes worth knowing before extending this

- **Every enrollment state transition — system or human — writes a hash-chained `decision` row**
  (`src/enrollment/decisions.ts`), each with a frozen evidence snapshot (artifact hashes, DKIM
  verdicts, flags at that moment). This is what makes "who decided, when, on what evidence"
  (PRD §4) actually answerable later, independent of anything that happens to the underlying
  records afterward (§6.5).
- **Inbound email matching is sender-based, not plus-addressed.** Per PRD §7.2's "self-attributing"
  language, a forwarded email is matched to an enrollment by the outer message's `From:` against
  the participant's registered email, among their enrollments still awaiting one. If that's
  ambiguous (zero or multiple candidates), it's logged as an unmatched `AuditEvent` rather than
  guessed at — a known v1 limitation, not a silent failure. This only covers the case where the
  *participant* does the forwarding themselves; if a runner relays the email on the participant's
  behalf instead (the same "manual paste by runner" pattern D8 already assumes for Dropbox links),
  the sender won't match. That path exists too: `POST /submissions/manual` with
  `kind=signup_email` runs the identical real DKIM verification and tiering
  (`email/verifyEmailEvidence.ts`, shared by both paths) — a runner-relayed `.eml` gets exactly
  the same evidential weight as a self-forwarded one, just explicitly tied to an enrollment
  instead of inferred from the sender.
- **The retention job never deletes a row** — only the raw bytes in the object store
  (`mediaAsset.deletedAt` marks it). Submissions, extracted rows, integrity flags, and the decision
  log are permanent, matching §9's "the structured data is the product; the raw video is the
  liability."
- **Integrity flags are annotations, never verdicts** (§4 non-goal) — nothing in this codebase
  blocks a transition or auto-rejects on a flag; funding and wager-verification are always a human
  action (`POST /enrollments/:id/fund` / `/verify-wager`).
- The console uses native `prompt()`/`confirm()`/`alert()` for a few write actions (funding a
  grant, revoking staff). That's a deliberate v1 shortcut for a "thin" console (§6.4) — functional,
  not polished. Swap for inline forms/modals before this is a daily tool for more than a couple of
  admins.

## Known open items (mirrors the PRD's own D1–D12)

- Casino-scope, hosting vendor, Dropbox account, and inbound-email provider are all still open
  per the PRD (D1, D2, D7, D12) — this repo is built to swap in whichever answer lands.
- SUBMISSION_TIMING / SUBMISSION_GAP thresholds are conservative defaults (60s, 14 days), not
  Betlab-specified.
- `EVIDENCE_CHANGED_AFTER_DECISION` (PRD §7 flag table) isn't implemented — there's no "supersede a
  submission" workflow yet for staff to correct a bad upload.
- Two-person approval on funding (PRD D10) isn't built; `fund` is a single admin/ops action.
- "Participants don't complete browser upload" (PRD §12 risk) has no drop-off measurement — that's
  product analytics on top of the Dropbox file-request flow, not built here.
