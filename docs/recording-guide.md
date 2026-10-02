# Recording your transaction history — a guide for participants and runners

The system reconstructs your casino app's transaction list from a screen recording of you
scrolling through it, reads every row, and checks that the balances line up. A good recording
takes 20–40 seconds and needs nothing special. A bad one gets bounced back within a minute with
a reason, so it's worth getting right the first time.

## How to record

1. **Open the transaction / game history list** in the casino app. If there's a filter (date,
   type), set it so every transaction since the deposit is included.
2. **Start the phone's screen recording** (iPhone: Control Centre → record; Android: Quick
   Settings → Screen record). Portrait orientation.
3. **Start at the top of the list** (or the bottom — either is fine) with the first transaction
   fully on screen, hold still for a second.
4. **Scroll slowly and steadily in one direction** through the whole list. About one screen
   every two seconds is right. Don't flick fast; don't scroll back and forth.
5. If the list is **paginated** ("Next page"), scroll to the bottom of each page, tap Next, wait
   for it to load, and continue. That's fine — just don't skip pages.
6. **End past the last transaction** (the deposit, usually), hold still for a second, stop the
   recording.
7. **Send the original file.** Don't trim, re-export, or send through a chat app that
   compresses video if you can avoid it (AirDrop, Files, Drive and the Dropbox link are all
   fine; WhatsApp and Telegram re-encode).

## What gets a recording bounced, and what the message means

| Message | What happened | What to do |
|---|---|---|
| *no scrolling list with at least two rows was found* | The recording doesn't show a transaction list scrolling — wrong screen, or the list never moved | Record the actual history list and scroll it |
| *the view jumped N times* | The screen changed completely several times — page switches, a pop-up, flicking past whole screens | Slow down; one direction; no tapping around mid-recording |
| *the view jumped at 7.5s* (warning) | One jump — often a page change on a paginated list, which is fine | Nothing, unless rows are reported missing |
| *N% of frames were too degraded to use* | The file was re-encoded heavily (usually a chat app) | Send the original file |
| *very short recording* | Under 3 seconds | Record the whole list |
| *no running balance … completeness can't be verified* | This app's list shows only the change per transaction, not a balance | Nothing to change — this is about the app, not the recording |

## What a reviewer will see

The stitched list as one image, every transaction read from it, whether the balances chain from
first to last, and whether a second, independent read agreed on each row. A recording that
follows the steps above reads at 100% in testing.
