# Demo script — client walkthrough (~4 minutes)

Audience: Betlab. The story is **"evidence arrives, the system reads it and checks itself, a
reviewer decides in seconds, and the result lands in a spreadsheet you already work in."**
Extraction is pre-run, so there's no dead air; the queue is still shown so the async design is
honest rather than hidden.

## Before you hit record

| | |
|---|---|
| Server | `npm run dev` (or `npx tsx src/server.ts`) — wait for it to be listening |
| Browser | One window, `http://localhost:3000/console`, already signed in, zoom ~110%, close other tabs |
| Second tab | The Google Sheet, **closed** — the demo opens it live from the button |
| Dropbox | Token is short-lived. If you want the upload beat, regenerate it (`docs/demo-readiness.md`) and set `DROPBOX_ACCESS_TOKEN`, then restart |
| Sound | Nothing auto-plays; the recording in the review view is muted until you press play |

Staged participants (from `scripts/stageDemo.ts`):

| Person | Casino | State | What it demonstrates |
|---|---|---|---|
| `whatsapp:+14165550114` | OLG | email_verified | The funding queue and pre-funding checks |
| `whatsapp:+14165550198` | BetMGM Ontario | wager_submitted | **The hero.** 86 rows, granted 100 / wagered 174.20, one genuine chain break |
| three others | BetRivers ×2, OLG-style | wager_submitted | A wager queue with real variety |

Key links to have memorised:

- Hero submission: `#/submission/3d9c1a29-ad57-436c-8e45-caa2ec4b522b`
- Hero participant: `#/participant/` (reachable from the submission header)
- Funding queue: `#/funding-queue` · Wager queue: `#/wager-queue`

---

## Beat 1 — the problem, in one sentence (0:00–0:20)

Open on **Search**, the list of submissions.

> "Betlab pays people to sign up at a casino and wager a set amount. The proof is a screen
> recording of their transaction history and a signup email. Today someone reads those by eye.
> This archives them, reads them automatically, and checks its own work."

Point at the flag badges in the list — don't explain them yet.

## Beat 2 — evidence arrives (0:20–0:50)

Go to the **funding queue** (`#/funding-queue`).

> "Here's someone who's submitted their signup email but hasn't been funded yet."

Point at the pre-funding checks — ticks and the one cross.

> "Before anyone sends money, the system checks: is this email really from the casino — that's a
> real DKIM signature check against the casino's own DNS keys, not a screenshot — has this person
> already been funded, does the email actually belong to them. The red one here says the email
> arrived seven seconds after enrollment, which is worth a human look."

Don't click Fund. Say "an operator funds from here, and that decision is recorded."

## Beat 3 — the recording and what was read (0:50–2:10) — **the core**

Go to the hero submission (Search → the BetMGM row, or paste the hash).

Left side, **Stitched list** tab is already showing:

> "This is the participant's screen recording — except it isn't a video any more. The system
> reconstructed the whole scrolled list into one continuous image, the way you'd stitch a
> panorama. That's what it reads from, and it's kept as evidence."

Scroll it a little. Then the right side:

> "Every transaction it found: 86 of them. Time, type, game, amount, and the balance before and
> after."

**Click a row.** The stitched image jumps and highlights that exact row.

> "Each row points back at the pixels it came from — one click, and you're looking at the source.
> There's a thumbnail of it in the table too, so you usually don't even need to."

Now the headline, pointing at the summary line:

> "Wagered 174.20 against 100 granted — they did what they were paid to do. And the balance chain
> is complete *except here*."

**Click the break link.** It jumps to the two rows either side.

> "The system doesn't just read — it verifies. Every row's starting balance has to equal the
> previous row's ending balance. If one were missed or misread, the chain breaks. Here it does,
> once — and when you look, the app's own list skips a dollar: a credit its filter hides. So this
> is the casino's gap, not ours. Either way it's flagged for a human rather than silently
> averaged away."

Point at the ✓ column:

> "And every row is read twice by two different models. Where they disagree, it says so."

Then the quality box:

> "It also judges the recording itself. This one was re-encoded before it reached us, so 29% of
> frames were unusable — it still read everything, but it says so. If someone scrolls too fast or
> records the wrong screen, that comes back in seconds, not after review."

## Beat 4 — the spreadsheet (2:10–3:10)

> "Reviewers don't live in our console. They live in spreadsheets."

**Click "Open in Sheets."** (~5 seconds — fill it: "one workbook per participant, a tab per
recording.") The sheet opens on the recording's own tab.

> "Every row, with the second-read column."

Switch to **Summary**:

> "And the summary a reviewer actually acts on: what was granted, what was wagered, whether the
> chain held, what's flagged and why, and a link straight back to the evidence. Press the button
> again later and this same sheet updates — the link you've shared stays good."

## Beat 5 — the decision, and what's kept (3:10–4:00)

Back to the console, **wager queue**.

> "When a reviewer is satisfied, they verify here."

(Optionally click Verify on one of the *other* enrollments — keep the hero intact for re-takes.)

> "Every state change is written to an append-only, hash-chained log with a frozen snapshot of
> the evidence as it stood at that moment. Nobody can quietly rewrite history — and if there's a
> dispute later, you can export the whole thing as a PDF."

Close on:

> "Recordings get deleted on a retention schedule. The structured data and the decisions are what
> you keep — the video is the liability, the ledger is the product."

---

## If you have another 60 seconds (technical tail)

- **Re-run extraction** on a submission to show the queue: the run goes `pending`, the page polls
  itself, the button stays usable. Say it takes a minute or two of real work.
- **`npm run eval`** — four real recordings from four different casino UIs, 100% precision and
  recall on all four, and it fails the build if a change regresses. "That's the number we hold
  ourselves to, and a new casino becomes a new test."

## Things not to do on camera

- Don't open `#/staff` (tokens) or the `.env`.
- Don't click **Fund** or **Verify** on the hero enrollment — it moves state and you'd have to
  re-stage for a second take.
- Don't re-run extraction on the hero right before recording; if you must, re-run
  `npx tsx scripts/runExtraction.ts 3d9c1a29-ad57-436c-8e45-caa2ec4b522b` and wait for it to finish.
- Avoid the Dropbox beat unless the token is fresh — a 401 in the logs isn't visible on screen,
  but a file that never arrives is.

## Re-staging between takes

Nothing in beats 1–4 changes state, so you can re-shoot freely. If you do click Fund or Verify:

```
npx tsx scripts/stageDemo.ts            # dry run, shows what it would move
npx tsx scripts/stageDemo.ts --apply
```

It only ever moves enrollments *forward* through the real state machine, so a verified
enrollment stays verified — for a clean re-take of beat 5, use a different participant.
