# Demo readiness

The near-term goal: run this locally and walk Betlab through the full pipeline live, with real
external integrations swapped in wherever that makes the demo genuinely convincing — no public
hosting, no domain, no deployment (see [`deployment.md`](deployment.md) for that separate,
later concern).

## Status

| Piece | Status | Notes |
|---|---|---|
| Core pipeline (ingest → lifecycle → extraction → flags → console) | ✅ Done | Runs entirely locally against Docker Postgres |
| Wager extraction (vision model) | ✅ **Real**, 100% on four real recordings / four UIs | `VISION_MODE=claude`, `claude-sonnet-5`. Rebuilt around scroll reconstruction (`architecture.md` → "Scroll reconstruction"): the recording is stitched into one image of the whole list, cut on row boundaries, read once, and verified with the balance chain. BetMGM (per-row balances), BetRivers Game History (session cards), BetRivers Statements (deltas only, heavily compressed re-encode), OLG-style paginated cards: 100% precision and recall on all four, wagered totals exact (`extraction-benchmark.md`). The previous per-frame design scored 4.7% recall on the first. $0.02–0.19 per recording; cost tracks row count, not length |
| Review console | ✅ Verified in-browser | Login, search, side-by-side review (stitched list or recording beside the rows; clicking a row highlights its exact band in the stitched image and seeks the recording to the frame that showed it), balance-chain status, funding/wager queues, staff admin, retention settings |
| Test/dev database isolation | ✅ Fixed | `npm test` used to silently overwrite the dev login (see `local-development.md` → Tests) — now uses a separate `betlab_test` database |
| Dropbox ingest | ✅ **Real** | `DROPBOX_MODE=real`, App-folder-scoped app, polling only (no tunnel). Verified live: real file-request link, real upload, real polling pickup, real dedup/purge, correct state-machine behavior on a second submission |
| Email / DKIM verification | ✅ **Real** verification, two intake paths | Auto-reply send is still fake mode (fine — low-stakes). DKIM itself is real against live DNS, and now works identically whether the participant forwards it themselves (`/inbound/email`, sender-matched) or a runner relays it on their behalf (`/submissions/manual` with `kind=signup_email`, explicitly tied to an enrollment) — added specifically for participants who can't navigate a phone forward-as-attachment flow |
| Integrity flags on re-extraction | ✅ Fixed | Re-running extraction used to leave stale flags from earlier runs mixed in with fresh ones — found while re-testing the real video. Flags computed during extraction now get replaced on each run instead of accumulating; ingest-time flags (`MANUAL_INTAKE`, `OUT_OF_SEQUENCE`) are untouched |

## What's left, in priority order

1. **Write a demo script** — the actual sequence to click through live, so the meeting doesn't
   turn into ad-libbed console navigation.
2. Test against more real recordings/casinos as they come in — four UIs are at 100% now, and each
   new one becomes a ground-truth fixture that gates further changes (`extraction-benchmark.md`).

## Real Dropbox setup notes (for redoing this later, e.g. a fresh token before the actual meeting)

- App Console → your app → **Permissions** tab needs all six scopes checked *and Submit clicked*:
  `files.metadata.read/write`, `files.content.read/write`, `file_requests.read/write`. A token
  generated before you save new scopes won't have them — regenerate the token *after* saving.
- Settings tab → OAuth 2 → **Generate access token**. It's short-lived (a few hours) — regenerate
  right before the meeting, not now.
- Only `DROPBOX_ACCESS_TOKEN` is read by our code; app key/secret aren't needed (secret is only
  for webhook signature verification, which the polling-only demo setup doesn't use).
- `DROPBOX_POLL_INTERVAL_MS` is set to `5000` in `.env` for demo responsiveness (default is
  `60000`). Restart the server after changing it.
- Browser automation can't reliably drive Dropbox's upload widget (native file-drop events) — a
  real human clicking through the file-request link works fine; this only affected my own testing.

## Known caveats worth having an answer ready for

- **Extracted timestamps can land on the wrong year** if the source video only shows time-of-day
  with no date at all (JS's date parser guesses, and guesses wrong) — didn't come up on the real
  BetMGM recording, which shows a full date per row, but could on a UI that doesn't. Not a
  reading error either way; the model reads exactly what's displayed.
- **A balance-chain break isn't necessarily an extraction error.** On the real BetMGM recording
  the app's own list goes 99→98 then 99→101 at 1:38 PM — a $1 credit that its "CASINO" filter
  hides. The pipeline reports exactly that break, at that position. Say so if asked: the flag is
  "something is missing between these two rows", and the reviewer decides what.
- **Four real UIs have been validated**, and three of them broke the pipeline on first contact
  before it was fixed (`extraction-benchmark.md` → "What the second, third and fourth recordings
  taught the pipeline"). Expect a fifth UI to find something too; that's what the eval harness
  is for.
- **A list with no balances can't be chain-verified.** BetRivers' "Statements" view shows only
  deltas; the pipeline reads every row correctly but reports the chain as *not checkable*
  rather than pretending. Completeness there rests on the reconstruction alone.
- **Reconstruction takes 30–80s of local CPU per recording** (10fps decoding, full-resolution
  alignment with skip edges, median compositing). Fine for a demo; parallelizing the tile reads
  and downsampling the alignment search are the obvious speedups if it matters.
- **Minute-precision timestamps with no seconds are normal**, not a red flag — the real BetMGM UI
  shows several distinct transactions under the identical displayed minute ("1:23 PM"), and the
  system treats that as expected rather than flagging every tie as suspicious.
- **Outbound email (auto-reply) and object storage are still in fake mode.** Dropbox and DKIM
  verification are real now (see table above). Say so plainly if asked "is this live" — the
  honest answer per-piece is "this one's real" or "this one's a working interface pointed at a
  local fake, swap one env var for the real thing."
- **Nothing is deployed** — this is a local walkthrough (screen share or in-person), not a URL you
  can hand someone.
