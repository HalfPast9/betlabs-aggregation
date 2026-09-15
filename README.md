# Betlab Submission Archive

Evidence archive for Betlab verification submissions. See `prd.md` for the full spec. This repo
currently implements **M0 — Archive** only (Dropbox File Request ingest → immutable, searchable
archive). Enrollment lifecycle/email verification (M1), wager extraction (M2), remaining
integrity signals (M3), and the review console (M4) are not built yet.

## Status of external dependencies

- **Dropbox** (PRD D7): no Betlab Dropbox app/business account exists yet. The ingest pipeline
  is built against Dropbox's documented API through a `DropboxClient` interface
  (`src/dropbox/types.ts`). Set `DROPBOX_MODE=fake` (the default) to run the whole service,
  including the webhook → sync → purge flow, against an in-memory fake with no credentials.
  Once Betlab provisions the app and account, set `DROPBOX_MODE=real` and fill in
  `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_ACCESS_TOKEN` — no code changes needed.
- **Object storage** (PRD D2): hosting vendor isn't chosen yet. `OBJECT_STORE_DRIVER=LOCAL`
  (default) writes to local disk. `OBJECT_STORE_DRIVER=S3` works against AWS S3, Cloudflare R2,
  MinIO, or DigitalOcean Spaces — point `OBJECT_STORE_S3_ENDPOINT` at whichever is chosen.

## Setup

```bash
cp .env.example .env
docker compose up -d          # local Postgres
npm install
npx prisma migrate dev        # applies prisma/schema.prisma
npm run dev                   # http://localhost:3000, DROPBOX_MODE=fake by default
```

Run tests (spins up against the same local Postgres, resets tables between runs):

```bash
npm test
```

## API surface (M0)

All routes except `GET /health` and `/webhooks/dropbox` require `Authorization: Bearer
$STAFF_API_TOKEN` — a placeholder single-token gate; real RBAC is M4.

- `POST /participants` `{contact?, email?}`
- `POST /participants/:id/enrollments` `{casino}`
- `POST /enrollments/:id/file-requests` — creates a Dropbox File Request scoped to the
  enrollment; returns the URL for a runner to paste to the participant by hand (PRD D8)
- `GET/POST /webhooks/dropbox` — Dropbox change notification → triggers a sync
- `POST /submissions/manual` (multipart: `enrollmentId`, `file`, optional `kind`) — out-of-band
  intake fallback
- `GET /submissions?participantId=&enrollmentId=&from=&to=` — search
- `GET /submissions/:id/media` — streams the raw evidence; every call writes an `AuditEvent`
  (PRD §9)

A polling fallback (`DROPBOX_POLL_INTERVAL_MS`, default 60s) re-runs the same sync in case a
webhook notification is missed.

## What's deliberately not here yet

- Extraction, integrity flags, reconciliation (M2/M3)
- Enrollment state-transition queues, decision log, DKIM email verification (M1)
- Review console, RBAC, retention job (M4)

`enrollment.state` exists in the schema (default `"invited"`) only because `submission` is
tied to `enrollment` rather than `participant` per PRD §8 — the actual state machine and its
transitions are M1 work.
