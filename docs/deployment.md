# Deployment

**Status: not deployed, and not currently the plan.** The near-term goal is a live local demo for
Betlab, not public hosting — see [`demo-readiness.md`](demo-readiness.md) for that checklist.
This document is the plan for *later*: standing up a real, publicly reachable instance once
there's a reason to (a longer engagement, Betlab wanting to poke at it themselves between
meetings, or moving toward the real handoff). PRD D2/D7/D12 (hosting, Dropbox account, email
provider) are still open either way.

## What "real" requires, dependency by dependency

The [fake/real pattern](architecture.md#the-fakereal-pattern) means each of these is an
independent switch — you don't need all of them to demo *something*, but "the full thing working"
needs all five.

| # | Dependency | What's needed | Blocks |
|---|---|---|---|
| 1 | **Compute hosting** | A platform that runs a long-lived Node process (background jobs use `setInterval`, not cron-per-invocation) with a public HTTPS URL | Everything else — Dropbox webhooks and inbound email both need a real reachable URL |
| 2 | **Postgres** | A managed instance reachable from the hosting platform | Everything |
| 3 | **Object storage** | An S3-compatible bucket + credentials | Real media persists past a redeploy (local disk doesn't) |
| 4 | **Dropbox app** | A Dropbox account, an app registered in the App Console, an access token, webhook URL registered | M0 ingest |
| 5 | **Inbound email provider** | A domain we control, MX records pointed at a provider (SendGrid/Mailgun-shaped), the provider's webhook pointed at `/inbound/email` | M1 email verification demo |
| 6 | **Outbound email (SMTP)** | Any SMTP-capable provider | Auto-reply on a signup email with no attachment |
| 7 | **Vision model** | An `ANTHROPIC_API_KEY` | Real (not fake, zero-row) extraction |

Rows 4–7 each need an account created by a human — I can't sign up for third-party services or
register a domain. What I *can* do once those exist: write the Dockerfile/deploy config, wire up
every env var, and drive the whole setup process from here except the "click sign up" steps.

## Containerization

The app needs `ffmpeg`/`ffprobe` on `PATH` (frame sampling, perceptual hashing, encoder/keyframe
probing) — most buildpack-based platforms won't have that, so this needs a Dockerfile rather than
"just point a buildpack at the repo." (Not written yet — first thing to do once a hosting platform
is picked, since the base image depends on it.)

## Webhook timing

`POST /webhooks/dropbox` runs the full sync (`syncDropbox`) — including any auto-triggered
extraction — **before** replying, not after. That's a deliberate fix, not an oversight: an earlier
version replied first and synced in the background, which meant nothing guaranteed the sync had
actually finished by the time a client made a follow-up call, and light-my-request in tests would
resolve before the background work completed. Dropbox tolerates several seconds here and retries
on timeout; retries are safe (cursor + content-hash dedup make sync idempotent). If extraction
latency against a real vision model turns out to routinely exceed Dropbox's webhook timeout, the
fix is to split "sync" (fast, must finish before replying) from "extraction" (trigger it
fire-and-forget after replying) rather than reverting to the old ordering — see
`dropbox/sync.ts`'s `autoExtract` option, which is already a separate code path from the ingest
loop itself.

## Checklist

- [ ] Pick a hosting platform
- [ ] Pick object storage (S3 vs R2 vs other) and create the bucket
- [ ] Get a domain (or a subdomain of an existing one) pointed at the hosting platform
- [ ] Write the Dockerfile
- [ ] Write the platform's deploy config
- [ ] Provision Postgres, run `prisma migrate deploy`
- [ ] Create a Dropbox account + app, generate an access token, register the webhook URL
- [ ] Pick an inbound-email provider, point MX records at it, register its webhook
- [ ] Pick an SMTP provider for outbound
- [ ] Get an `ANTHROPIC_API_KEY`
- [ ] Set every env var on the hosting platform (see `local-development.md` for the full list)
- [ ] Deploy, run smoke tests against the live URL, walk the console end to end
- [ ] Write a short demo script (what to show, in what order, for the first Betlab meeting)

Nothing in this list is checked off yet — this file gets updated as each piece lands.
