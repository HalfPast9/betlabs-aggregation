# Extraction accuracy: measuring it, and evaluating other models

The whole system hinges on the vision model reading every row correctly. "Reliable" has to be a
number, and the number has to be measured against real recordings, because the failure modes
(near-identical rows, minute-precision timestamps, per-row initial/final balances, a filtered
list that omits an adjustment) don't show up on synthetic data.

## What exists today

### Ground truth

`eval/*.json` — one file per real recording, gitignored (they're derived from real participant
data). Each holds the full transaction list in display order with the fields the pipeline
extracts, plus `expectedChainBreaks`: how many balance-chain breaks are *genuinely in the source
list* (see below). To create one:

```
npx tsx scripts/evalExtraction.ts x --export <extraction-run-id> > eval/<name>.json
```

then verify it by hand against the stitched panorama (`GET
/submissions/:id/extraction-runs/:runId/panorama`, or the "Stitched list" tab in the console)
before treating it as truth. The balance chain is the verification tool: if every row's
before-balance matches the previous row's after-balance from the deposit to the final balance
the app itself displays, the balances and amounts are right; timestamps and types are checked
by eye against the panorama.

### Scoring

```
npx tsx scripts/evalExtraction.ts eval/<name>.json <extraction-run-id>
```

Rows are matched as an ordered sequence (longest common subsequence on
timestamp+type+amount+before+after). A missed row costs recall; an invented or duplicated row
costs precision; a misread field costs both. It also compares the wagered total and the number
of chain breaks against `expectedChainBreaks`. PASS means 100% / 100% / expected breaks.

Because `ExtractionRun.tileReads` stores the model's raw per-tile output, assembly and chain
verification can be re-run offline on a past run's reads without paying for the model again —
useful when iterating on `assemble.ts` / `chain.ts`.

### Current results

Four real recordings, four different casino UIs, scored with `npm run eval` — the full pipeline
(reconstruction, normalization, retry-before-flag, Haiku 4.5 cross-check of every row):

| Recording | UI shape | Rows | Recall | Precision | Wagered | Chain |
|---|---|---|---|---|---|---|
| BetMGM Ontario, 31s, 296×640 | Per-row initial/final balance, minute timestamps, near-identical rows | 86/86 | 100% | 100% | 174.20 ✓ | 1 break (expected: genuine, see below) |
| BetRivers "Game History", 15s, 444×960 | Session cards (Bets / Wins / Balance after), recorded bottom→top with a scroll back | 14/14 | 100% | 100% | 57.00 ✓ | complete 80→45 |
| BetRivers "Statements", 5.5s, 444×960 @25fps | Deltas only ("My Balance +$30"), no running balance; re-encoded with heavy compression on motion frames | 12/12 | 100% | 100% | 80.00 ✓ | not checkable (no balances) |
| OLG-style "Transaction History", 20s, 440×960 | Paginated cards (10+10+3) with loading screens between pages, single running balance | 23/23 | 100% | 100% | 285.00 ✓ | complete 0→…→0 |

**By primary model** (same four recordings, cross-check by Haiku 4.5 in both cases):

| Primary model | Pass | Total cost, all four | Notes |
|---|---|---|---|
| Sonnet 5 | 4/4 | $0.62 | |
| Haiku 4.5 | 4/4 | $0.43 | Failed 2/4 before post-read normalization (docs/extraction-hardening.md §1): it emitted a $0 "win" row per session card and copied signed deltas into the balance field. Every number it read was right; the rules are now code, not prompt adherence |
| Haiku 4.5, previous per-frame pipeline | 0/1 | $0.08 | 4.7% recall on BetMGM |

Cost is dominated by row count and the second read; a 20s clip with 23 large cards costs more
than a 31s clip with 86 small rows because it cuts into more tiles.

The BetMGM break is real: the app's own list shows a 1:38 PM row ending at 98 followed by
one starting at 99 — a $1 credit that isn't in the displayed (filtered) list. The pipeline
reports it as `EXTRACTION_INCOMPLETE` with the exact position, which is the correct behaviour:
an annotation for the reviewer, not a verdict.

### What the second, third and fourth recordings taught the pipeline

Each of these was a failure first. They're the reason the corpus matters:

- **Non-integer resampling breaks alignment.** Downscaling 444px frames to 320px put small text
  on a different sub-pixel phase in every frame; the true shift scored 5× worse than an alias.
  Alignment now runs at full resolution (integer divisor above 640px).
- **Heavily compressed motion frames can't be trusted as pixel sources but still align.** The
  25fps re-encode had frames whose alignment scored 3× worse than their neighbours'. Placement
  is now a shortest path over frames with skip edges (an edge spanning *m* frames costs *m*× its
  score), so a bad frame is stepped over when jumping it is cleaner, but a flick where every
  frame is mildly blurry still chains through consecutive frames.
- **Scene changes inside the header break variance-based chrome detection.** A page transition
  made every pixel row "dynamic", so the static header was included in alignment and pinned
  every shift to zero. Chrome is now detected by *motion*: rows that almost never change across
  the frame pairs where something changed.
- **Fixed-position app widgets and the iOS scroll indicator land in the composite.** A floating
  "‹" tab covered two balance digits. The composite is now a per-pixel median over the best few
  frames where the row sat at *different* screen heights, so anything fixed on screen (or present
  in a few frames) is a minority vote.
- **Segments can overlap in content.** A recording glitch at the end re-captured six cards, and
  the two pages of a paginated list can share nothing or everything. Segments are folded by
  ordered content match (two informative pairs minimum), and their order is whichever makes the
  balance chain work.
- **Timestamps come in every format**: "6:50pm", "11:56:51 PM ET", "6:27:16 PM – 6:28:00 PM EST"
  (a session range; the start is the time), "1:23 PM 11/30/25". `safeParseDate` handles all
  of these; the model was reading them correctly all along.
- **Session cards are two transactions.** "Bets $5 / Wins $10 / Balance after $84" is a bet row
  and a win row; the chain verifier checks such a same-timestamp group by its net amount.

## Assumptions the pipeline makes (what a new UI could break)

Each is deliberate and each has a fallback, but a recording from a new casino is the only real
test:

- **The list scrolls vertically inside fixed chrome.** Header/footer detection assumes pixels
  that never change are chrome; a list that fills the entire screen still works (the whole frame
  becomes the scroll region). Horizontal scrolling, tabs, or modals over the list are not handled
  and would surface as `SCROLL_GAP`s plus chain breaks.
- **Rows are separated by more whitespace than the lines within a row.** Row-band detection
  (Otsu on gap heights) needs that contrast. A dense table with no gaps falls back to fixed-height
  tiles with overlap and sequence alignment — less exact positions, same rows.
- **The UI shows enough to chain balances**: either before+after per row, or a running balance
  plus a signed amount. A UI showing amounts only can't be chain-verified, and `chainComplete`
  stays null rather than claiming anything.
- **Motion blur is the main alignment hazard.** Sharp frames are preferred as composite sources
  and the Viterbi smoothing resolves single blurry frames; a recording that is blurry throughout
  (very fast continuous flicking) would fragment into segments.
- **Timestamps are read, not inferred.** A UI showing time-of-day with no date anywhere yields
  a time-only string, which `safeParseDate` may pin to the wrong day; the chain check doesn't
  depend on it.

## What the cross-check finds in practice

On the four recordings the second read agreed with the primary on every row except where it
had dropped or added a row in a tile — which the matcher now handles by finding the counterpart
through the chain-protected fields. Zero real timestamp or description disagreements so far,
which is what "the reads are not the weak link" looks like as a measurement rather than a
belief. The check earns its cost the day a model *does* misread a time.

## Evaluating a different model (the benchmark to build)

Production will likely run a cheaper or fine-tuned model rather than Sonnet 5. Swapping is a
config change (`CLAUDE_VISION_MODEL`, or a new `VisionExtractor` implementation for a non-Claude
model), but it should never happen without a measurement. What a proper benchmark adds to the
pieces above:

1. **A corpus, not one video.** At least a handful of recordings per casino UI Betlab actually
   sees, covering: single-running-balance UIs, per-row initial/final UIs, date-group headers vs
   per-row dates, dark mode, fast flicks, scroll-back-and-forth, a list with a filtered-out
   adjustment, and a recording that starts or ends mid-row. Ground truth for each, verified by
   chain + eye as above.
2. **Per-model runs.** Done: `npm run eval -- --model <id>` re-extracts every fixture under a
   candidate model and prints recall, precision, wagered error, chain breaks vs expected, cost
   and time per recording; `scripts/runExtraction.ts <submission> --model <id>` does one.
   Replaying stored `tileReads` for assembly-only changes is still manual.
3. **Field-level breakdown.** Which field is wrong when a row is wrong — timestamp, type, amount,
   or balance — since those fail differently across models (small models drop the date part of a
   timestamp long before they misread an amount).
4. **A pass bar.** Suggested: 100% recall on balances/amounts across the corpus (a single missed
   wager is a wrong reconciliation), ≥99% on timestamps, zero unexpected chain breaks. Anything
   below that is not a model to put in production regardless of cost.
5. **Prompt/schema drift protection.** The tool schema and prompt in `claudeVisionExtractor.ts`
   are inputs to the benchmark too; a change there re-runs the corpus.

Items 1, 3 and 4 remain. `npm run eval` over the four fixtures in `eval/` is what gates
changes to this pipeline now; every one must PASS on the configured model. The corpus needs
more real recordings — a fifth UI is the most valuable thing Betlab can supply.
