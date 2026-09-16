# Data model

Source of truth is [`prisma/schema.prisma`](../prisma/schema.prisma); this is a guided tour, not
a copy. Migrations live in `prisma/migrations/` (`init` = M0, `enrollment_lifecycle` +
`extraction_and_integrity` = M1–M3, `rbac_and_retention` = M4, then incremental ones for the
extraction rework: `row_before_balance_and_description`, `flag_scoped_to_extraction_run`,
`row_bounding_box`, `panorama_extraction`, `tile_reads`).

## Core evidence chain

```
Participant ─┬─< Enrollment ─┬─< FileRequest
             │                ├─< Submission ─┬─ MediaAsset (1:1)
             │                │                ├─< IntegrityFlag
             │                │                ├─ EmailEvidence (1:1, signup_email only)
             │                │                └─< ExtractionRun ─┬─< TransactionRow
             │                │                                    └─ Reconciliation (1:1)
             │                ├─< Decision (hash-chained)
             │                └─ Grant (1:1)
```

- **`Participant`** — `contact` (e.g. `whatsapp:+1...`) and an optional `email`. The registered
  email is what inbound-email matching (`email/inboundEmail.ts`) keys off.
- **`Enrollment`** — one participant × one casino. `state` is a plain string
  (`enrollment/states.ts` is the source of truth for valid values and transitions; nothing in the
  DB schema enforces it). Owns `submissions`, not `Participant` — see
  [`architecture.md`](architecture.md#why-enrollment-not-participant-owns-submissions) for why.
- **`FileRequest`** — one Dropbox File Request per enrollment. `destinationPath` (e.g.
  `/betlab-intake/<enrollmentId>`) is how an incoming file gets routed back to an enrollment —
  `dropbox/sync.ts` parses the enrollment id straight out of the path.
- **`MediaAsset`** — the raw bytes, content-addressed (`blobKey` = `contentHash` = sha256 of the
  file). Never mutated. `deletedAt` is set by the retention job when the raw bytes are purged from
  the object store; the row itself is kept forever.
- **`Submission`** — `kind` (`signup_email` | `wager_recording`), `channel` (`dropbox` | `email` |
  `manual_upload`). `contentHash` is denormalized from its `MediaAsset` for convenient querying.
  `supersededBy` exists in the schema for a future "replace a bad upload" workflow that isn't
  built yet (see the README's known-gaps list).

## Extraction (M2)

- **`ExtractionRun`** — one per extraction attempt. A submission can have many over time — nothing
  overwrites an old run; re-extraction (e.g. after upgrading the extractor) just creates a new one.
  Carries cost instrumentation (`inputTokens`, `outputTokens`, `costUsd`), the `model` that read
  the tiles, `status` (`running` → `succeeded` | `failed`, with `error` set on failure), and the
  scroll-reconstruction bookkeeping: `frameCount`, `tileCount`, `panoramaBlobKey` (the stitched
  list in the object store, purged with the raw media under retention) and `tileReads` (the
  model's raw per-tile output, so assembly can be replayed offline — see
  `extraction-benchmark.md`).
- **`TransactionRow`** — one row per `(extractionRunId, sequence)`, `sequence` being display order
  (top of the list first). Row identity is *position in the reconstructed list*: two distinct
  transactions can legitimately have identical content (same minute, same game, same amount, same
  balances), so `rowKey` — a hash of `timestamp|type|amount|balanceBefore|balanceAfter` — is not
  unique and is only used for cross-participant `SHARED_ROWS` matching. `type` is a constrained
  vocabulary (`bet`|`win`|`deposit`|`withdrawal`|`bonus`|`refund`|`other`), not free text —
  whatever a specific UI's wording doesn't map cleanly onto that goes in `description` instead,
  so reconciliation (which sums exactly `type = 'bet'`) never depends on how a given casino
  phrases things. `balanceBefore` is null on UIs that show only one running balance.
  `segmentIndex`/`panoramaTop`/`panoramaBottom` are the row's exact band in the stitched image
  (from whitespace detection, not the model); `sourceFrameTs` and `boxX/Y/W/H` (0-1 normalized)
  are derived from that geometry — the frame that showed the row most centrally and where in it.
  `partial` marks a row no tile had in full (the recording started or ended mid-row).
- **`Reconciliation`** — one per extraction run: total wagered vs. the enrollment's `Grant` amount,
  whether per-row arithmetic passed, and the balance-chain verdict (`chainComplete`,
  `chainBreaks` with positions and reasons, `chainStart`/`chainEnd`, `newestFirst`). The chain is
  the completeness check: intact from the first balance to the last means every row was read.

## Integrity (M3)

- **`IntegrityFlag`** — submission-scoped. `code` is one of the PRD §7 flag codes
  (`ARITHMETIC_MISMATCH`, `WAGER_SHORTFALL`, `OUT_OF_SEQUENCE`, `DUPLICATE_MEDIA`, `SHARED_ROWS`,
  `ENCODER_MISMATCH`, `FRAME_DISCONTINUITY`, `MANUAL_INTAKE`, `SUBMISSION_GAP`, `LOW_CONFIDENCE`,
  …) plus the extraction-quality signals `EXTRACTION_INCOMPLETE` (balance chain broken — a row
  missing, misread, or absent from the app's own filtered list), `SCROLL_GAP` (consecutive frames
  couldn't be aligned; content between may be unrecorded) and `READ_CONFLICT` (two overlapping
  tiles read the same row differently). `severity` is `info` | `warning` | `high`. `generatedBy` names which check wrote it (e.g.
  `dropbox-sync`, `extractor@v1`) — useful for tracing a flag back to code.
  **These are annotations, never verdicts** — nothing reads this table to block a transition.
  `extractionRunId` (nullable) distinguishes the two flag lifecycles: flags computed during
  extraction (arithmetic, timestamps, shortfall, confidence, encoder/keyframe, duplicate/shared
  rows) are tied to the run that produced them, and `runExtraction.ts` clears a submission's old
  extraction-derived flags before writing new ones — re-running extraction *replaces* the current
  analysis rather than piling stale flags on top of fresh ones. Ingest-time flags
  (`MANUAL_INTAKE`, `OUT_OF_SEQUENCE`) have `extractionRunId = null` and are never touched by
  this. A decision's `evidenceSnapshot` still freezes whatever flags existed at that moment
  independent of this table, so replacing current flags doesn't lose the historical record.

## Email verification (M1 / §7.2)

- **`EmailEvidence`** — one per verified `signup_email` submission. `tier` is A/B/C/D per the PRD's
  evidence-tiering table; `dkimResult`, `selector`, `dDomain`, `publicKeyUsed`, `hTagCoversTo`,
  `lTagPresent` are the actual verification output, persisted rather than recomputed later (DKIM
  selectors get retired).
- **`DkimAllowedSigner`** — per-casino allowlist of trusted `d=` signing domains. A valid signature
  only earns Tier A if the signer is on this list *and* the casino matches — an ESP's valid
  signature proves the ESP sent it, not which of the ESP's customers.

## Lifecycle & audit

- **`Decision`** — append-only, hash-chained (`hash` covers the transition + a fresh evidence
  snapshot + `prevHash`). See [`architecture.md`](architecture.md#the-decision-log). `actor` is
  `"system"` for automatic transitions or a staff name for human ones.
- **`Grant`** — recorded *after* funds move; the system never initiates a transfer (PRD §4
  non-goal). One per enrollment.
- **`AuditEvent`** — free-form `(actor, action, target)` log. Used for raw-media view access (PRD
  §9: "every access to raw media written to audit_event"), unmatched inbound emails, and Dropbox
  quota warnings.

## Operational / admin (M4)

- **`StaffUser`** — `tokenHash` (sha256 of the bearer token — plaintext is never stored, shown
  once at creation), `role` (`ops` | `admin`). Bootstrapped from `STAFF_API_TOKEN` on first run.
- **`RetentionSettings`** — singleton row (`id = "default"`), admin-editable at runtime:
  `rawMediaRetentionDays` (default 90), `fundedEmailEvidenceRetentionDays` (default 180, PRD D9's
  open "Betlab's dispute window").
- **`DropboxCursor`** — singleton row holding the `list_folder` cursor for incremental sync.

## Conventions worth knowing

- IDs are UUIDs (`@default(uuid())`), generated app-side by Postgres via Prisma's default.
- Money fields are `Decimal` (never `Float`) — `amount`, `balanceAfter`, `wageredTotal`,
  `grantedAmount`, `delta`, `costUsd`. Prisma returns these as `Decimal` objects; routes that
  serialize them to JSON/CSV call `Number(...)` explicitly.
- Every table maps to a `snake_case` name (`@@map(...)`) while the Prisma/TS layer stays
  `camelCase` — that's just Postgres convention, not a semantic distinction.
