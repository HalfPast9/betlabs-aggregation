# Extraction hardening: design

Where the extraction layer stood before this pass: 100% row precision/recall on four real
recordings across four casino UIs with Sonnet 5 (`extraction-benchmark.md`), but three of the
four broke the pipeline on first contact, reads are single-shot, and the only thing that
catches a wrong read is the balance chain — which is blind to timestamps and descriptions and
absent on delta-only UIs. Haiku 4.5 on the same four: 2 pass, 2 fail — both failures being
instruction-following on edge-case rules, with every number read correctly.

This pass attacks the remaining risk in this order: residual misreads, bad input, reviewer
trust, then throughput. Each item below says what it is, why, how it's built, and how it's
verified. Nothing here changes what a "row" is or how the chain works.

**Status: all eleven items are built.** `npm run eval` passes 4/4 with Sonnet 5 and 4/4 with
Haiku 4.5 as the primary reader (`extraction-benchmark.md`). Where the build diverged from the
design below, the section says so.

## 1. Post-read normalization (model-agnostic rules) — `extraction/normalize.ts`

**Why.** Two of the prompt's rules (session cards → bet + win rows, omitting a $0 win; a signed
"My Balance +$30" is a change, not a balance) are exactly what a smaller model ignores. Rules
that can be applied deterministically after the read should be, so that the prompt is guidance
and the code is the guarantee.

**How.** After assembly, before the chain check:
- A row with `amount === 0` and a balance, immediately following a row with the same timestamp
  and description and no balance → the balance moves to the previous row, the zero row is
  dropped. (Haiku's "Wins $0" row.) A zero-amount row typed `other` is treated the same.
- If, across a segment, every row that has `balanceAfter` has `balanceAfter === amount`
  (signed), the "balances" are the deltas copied — null them. A list where balance equals the
  change on every row is not a ledger.
- Timestamp placeholders the model invents for cut-off digits ("6:1x PM") → null, so the
  full read from the neighbouring tile wins on merge.

**Verify.** Unit tests on each rule; Haiku re-run on the four fixtures must go from 2/4 to 4/4.
*Built as designed, plus one thing the design missed:* normalization has to run **before**
segments are folded (`assembleRows` → `normalizeRows` → `foldSegments`), or a segment read
with an extra "$0 win" row can't line up with one read without it.

## 2. Retry before flagging — in `runExtraction`

**Why.** A chain break is far more often a single misread than a missing transaction; today it
goes straight to a reviewer.

**How.** After the first chain check, for each break, identify the tiles whose bands cover the
rows on either side of the break. Re-read those tiles once (same model, fresh call; the tile
image is re-cut with one extra band of context above and below so the model sees the row in a
different framing). Re-assemble with the retried reads substituted, re-verify; keep the result
with fewer breaks. Bounded: at most one retry round, at most `RETRY_MAX_TILES` (4) tiles. Retry
cost is logged on the run (`retryTiles`, and tokens/cost include it).

**Verify.** Unit test with a scripted extractor whose first read of one tile is wrong and second
read is right → chain complete, `retryTiles = 1`. On the corpus, no regression.

## 3. Double-read for the unprotected fields — `extraction/crossCheck.ts`

**Why.** The chain protects amounts and balances. Timestamps and descriptions are protected by
nothing; a wrong timestamp is invisible.

**How.** A second, independent read of every tile with a second extractor (default: Haiku 4.5,
configurable via `CROSSCHECK_VISION_MODEL`; `off` disables). The second read is matched to
the primary rows by band (same geometry) and compared field by field. Per row, `crossChecked`
(bool) and `disagreements` (string[]: which fields differed) are stored. A run-level
`READ_DISAGREEMENT` flag (warning) lists the count and the rows. Amount/balance disagreements
are also reported but never override the primary read — the chain already adjudicates those.
Cost: roughly +20–30% at Haiku prices; the run's cost instrumentation includes it.

**Verify.** Unit test with two scripted extractors disagreeing on one timestamp → that row has
`disagreements = ["timestamp"]`, the flag is present, all other rows `crossChecked = true`.
*Divergence:* matching the second read to the primary purely by band index produced false
disagreements on every field whenever the second reader dropped or added a row in a tile. The
counterpart is now the nearby second-read row that agrees on the chain-protected fields
(amount, balances), with nearest-by-position as the fallback.

## 4. Recording quality at ingest — `extraction/quality.ts`

**Why.** A recording that scrolled too fast, showed no list, or shows a UI with no balances
should be bounced to the runner in seconds, not discovered in review after a model run.

**How.** Reconstruction already produces everything needed before any model call: gap count and
timestamps, segment count, row bands per segment, region height. `assessRecording(plan, bands)`
returns `{ verdict: "ok" | "warn" | "reject", reasons: string[] }`:
- reject: no segment with ≥ 2 row bands (not a list); or gaps cover more than half the recording.
- warn: any gap ("scrolled past a screen at 7.5s"); more than 3 segments; recording shorter
  than 3s; more than 25% of frames untrusted (compression/tearing).
- After the read: chain not checkable (delta-only UI) → warn "completeness can't be verified".
The assessment is persisted on the run (`quality Json`) and raised as a `RECORDING_QUALITY`
flag (high for reject, warning for warn). On reject the model is not called (rows empty, run
succeeds with the assessment) unless `force=true` is passed to the extract endpoint; the
manual-upload response and the console show the verdict and reasons so the runner can
re-record immediately.

**Verify.** Unit tests on `assessRecording`; the synthetic flick video must reject/warn; the
four real fixtures must all be `ok` or `warn` with the expected reasons. *In practice:* BetMGM
`ok`; Game History `warn` (one jump at 14.8s — the end-of-recording glitch); Statements `warn`
(45% degraded frames — the re-encode); OLG `warn` (two page changes). All read correctly; the
warnings are true.

## 5. Throughput — parallel reads, background extraction

**Why.** Seven sequential model calls plus 30–80s of reconstruction blocks the upload request
for two minutes.

**How.** (a) `ClaudeVisionExtractor.extractRows` reads tiles with a concurrency of 4
(`Promise` pool); order of results is preserved. (b) `runExtraction` is enqueued, not awaited:
`POST /submissions/:id/extract` and auto-extract on ingest create the `ExtractionRun` row in
status `pending` and return it immediately; an in-process queue (`jobs/extractionQueue.ts`,
one worker, FIFO, survives nothing — a restart re-queues `pending` runs at boot) runs them. The
console's run header shows `pending`/`running` and polls until it settles.

**Verify.** Existing route tests updated to await the queue's drain hook; a test that a
`pending` run is picked up after "restart" (re-scan on boot).

## 6. Per-recording calibration of alignment thresholds — in `panorama.ts`

**Why.** `GOOD_SCORE`, `MAX_PAIR_SCORE` and friends are absolute ink-diff values tuned on four
videos. Compression level and text size move the whole score distribution.

**How.** Measure the recording's noise floor: the median score of its static consecutive pairs
(shift 0 — every recording has some). Scale the thresholds by
`max(1, floor / REFERENCE_FLOOR)` where the reference floor (≈3) is what the clean recordings
show. A recording whose static frames already differ by 12 gets proportionally looser bars.
The floor and the effective thresholds are recorded on the run for inspection.

**Verify.** The four fixtures must produce identical rows. *In practice* none of the four has a
noise floor above the reference (0.6–0.8: their *static* frames are clean even when their
motion frames are not), so the scaling is a no-op on the corpus; it's recorded on every run
(`quality.metrics.noiseFloor`) so the first recording that needs it will show it. *Divergence:*
the first cut measured the lower quantile of *all* consecutive-pair scores, which on a clip
scrolled continuously (BetMGM) came out at 9.4 and would have tripled every threshold; the
floor now comes only from pairs whose best shift is zero, falling back to the cleanest pairs
overall when there are fewer than five.

## 7. Eval gate — `npm run eval`

**Why.** Four fixtures exist; nothing runs them.

**How.** Fixtures gain `submissionId`. `scripts/evalAll.ts` runs extraction for every fixture
(optionally `--model`), scores each, prints a table, exits non-zero if any fails. Documented as
the gate for any change under `src/extraction/`.

## 8. Reviewer trust — row crops, break-centric review

**Why.** A reviewer shouldn't need to scroll a 8000px image to check one row.

**How.** `GET /submissions/:id/extraction-runs/:runId/rows/:sequence/crop.png` crops the row's
band (plus a little margin) from the stored panorama. The console's rows table gets a
thumbnail column (lazy-loaded). Chain breaks in the flags panel become links: clicking one
scrolls the table to the rows on either side of the break and highlights them.

## 9. Multi-clip enrollments — `extraction/ledger.ts`

**Why.** Participants send several clips. Each is verified alone today.

**How.** `GET /enrollments/:id/ledger` takes the latest successful run of every
`wager_recording` submission, orders clips by their chain endpoints (a clip whose start balance
equals another's end balance follows it; otherwise by receivedAt), folds overlapping rows with
the same ordered-content match used across segments, and reports the combined chain with
gaps *between clips* called out separately from gaps within one. The enrollment page shows it.

## 10. Evidence export

**How.** `GET /submissions/:id/extraction-runs/:runId/evidence.pdf`: the panorama (scaled to
page width, split across pages) followed by the rows table, chain verdict and flags. Built with
`pdfkit` (pure JS). Audit-logged like raw media.

## 11. Recording guidance — `docs/recording-guide.md`

One page for runners to hand to participants: portrait, slow single-direction scroll, don't
switch pages mid-recording, start above the first transaction, end below the last, don't
re-encode (send the original file). Plus what the runner will see if it's rejected and why.
