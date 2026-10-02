# Local development

## Prerequisites

- Node.js ≥ 20
- Docker (for local Postgres)
- `ffmpeg` and `ffprobe` on `PATH` — required for extraction in any mode (the tests generate
  synthetic scrolling recordings with it). Frame decoding, perceptual hashing, and
  encoder/keyframe probing all shell out to these. Image work (alignment, compositing, row-band
  detection) uses `sharp`, which ships its own libvips binary via npm — nothing extra to install.

## Setup

```bash
cp .env.example .env
docker compose up -d          # local Postgres on :5432
npm install
npx prisma migrate dev        # applies prisma/schema.prisma to betlab_archive

# One-time: create and migrate the separate test database (see Tests below)
docker compose exec db createdb -U betlab betlab_test
DATABASE_URL=postgresql://betlab:betlab@localhost:5432/betlab_test npx prisma migrate deploy

npm run dev                   # tsx watch — http://localhost:3000/console
```

Everything defaults to fake mode (`DROPBOX_MODE=fake`, `EMAIL_MODE=fake`, `VISION_MODE=fake`,
`OBJECT_STORE_DRIVER=LOCAL`), so the entire pipeline runs with zero external credentials. Sign in
to the console with whatever `STAFF_API_TOKEN` is in your `.env` — it's seeded as the bootstrap
admin on first startup.

## Tests

```bash
npm test        # vitest run — one pass, used in CI
npm run test:watch
```

Tests run against a **separate** database (`betlab_test`, via `.env.test` — `vitest.config.ts`
loads it and injects it as the test process's `DATABASE_URL`, overriding whatever's in `.env`).
This is deliberate, not incidental: `resetDb()` in `test/helpers/testApp.ts` never truncates
`staff_user` (so the bootstrap admin survives across test files within one run), which used to
mean a stray `npm test` against the same DB as `npm run dev` would silently replace your local
console login with a test one — the exact failure mode that motivated splitting the databases.
`vitest.config.ts` also sets `fileParallelism: false` so test files sharing one database don't
race each other.

Tests also use real `ffmpeg` (generating small synthetic test videos on the fly) and real DKIM
verification (a locally generated keypair + a fake DNS resolver) — nothing about the *logic*
being tested is mocked, only the external network calls.

## Environment variables

Grouped by area; see `.env.example` for the full annotated list and `src/config.ts` for the zod
schema (which is the actual source of truth — validation errors there are the most reliable way
to find what's missing).

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `STAFF_API_TOKEN` | — | Bootstrap admin token, first run only |
| `DATABASE_URL` | — | |
| `OBJECT_STORE_DRIVER` | `LOCAL` | `LOCAL` \| `S3` |
| `OBJECT_STORE_LOCAL_PATH` | `./data/objects` | |
| `OBJECT_STORE_S3_*` | — | Bucket, region, endpoint, credentials, path-style flag — only read when driver is `S3` |
| `DROPBOX_MODE` | `fake` | `fake` \| `real` |
| `DROPBOX_APP_KEY` / `_APP_SECRET` / `_ACCESS_TOKEN` | — | Only read in `real` mode |
| `DROPBOX_INTAKE_ROOT` | `/betlab-intake` | |
| `DROPBOX_POLL_INTERVAL_MS` | `60000` | Fallback poll in case a webhook is missed |
| `DROPBOX_QUOTA_WARNING_THRESHOLD` | `0.9` | Fraction of allocated space that triggers an `AuditEvent` |
| `DROPBOX_QUOTA_CHECK_INTERVAL_MS` | `21600000` (6h) | |
| `INBOUND_EMAIL_TOKEN` | — | Optional `?token=` shared secret on `/inbound/email` |
| `EMAIL_MODE` | `fake` | `fake` \| `smtp` |
| `SMTP_*` | — | Only read in `smtp` mode |
| `VISION_MODE` | `fake` | `fake` \| `claude` |
| `ANTHROPIC_API_KEY` | — | Only read in `claude` mode |
| `CLAUDE_VISION_MODEL` | `claude-sonnet-5` | Each row is read once off the stitched panorama, so cost tracks row count (~$0.002/row on Sonnet 5). Don't swap in a cheaper model without measuring it — see `extraction-benchmark.md` |
| `CROSSCHECK_VISION_MODEL` | `claude-haiku-4-5` | Independent second read of every tile, compared field by field — the only check timestamps and descriptions get. `off` disables. ~+25% cost |
| `SHEETS_MODE` | `fake` | `fake` \| `google`. Fake writes CSV tabs to the object store, served from `/sheets/:id` — no credentials needed |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | — | Path to the service-account key file, or the JSON itself. Required in `google` mode ([setup](google-sheets-setup.md)) |
| `SHEETS_SHARE_WITH` | — | Comma-separated emails each workbook is shared with. Required in `google` mode — a workbook the robot owns is invisible otherwise |
| `SHEETS_DRIVE_FOLDER_ID` | — | **Required in practice** for `google` mode: a Shared Drive (or folder in one) the service account is a member of. Service accounts have no Drive storage of their own and can't create files anywhere else |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | How this service is reached; used for links inside exports |
| `EXTRACTOR_VERSION` | `v1` | Tag stored on every `ExtractionRun` |
| `PANORAMA_FPS` | `10` | Decode rate for scroll reconstruction (local CPU only). Denser keeps consecutive frames overlapping through fast flicks |
| `AUTO_EXTRACT_ON_INGEST` | `true` | Run extraction immediately after a wager recording is archived |

`loadConfig()` throws at startup (not lazily) if a mode-specific required var is missing —
e.g. setting `DROPBOX_MODE=real` without `DROPBOX_ACCESS_TOKEN` fails fast rather than at the
first Dropbox call.

## Useful one-offs

Truncate all app tables without dropping them (handy after a messy manual test session):

```bash
docker compose exec -T db psql -U betlab -d betlab_archive -c \
  'TRUNCATE audit_event, decision, "grant", transaction_row, reconciliation, extraction_run, \
   integrity_flag, email_evidence, submission, media_asset, file_request, dkim_allowed_signer, \
   enrollment, participant, dropbox_cursor, retention_settings, staff_user CASCADE;'
rm -rf data/objects
```

(`grant` needs the double quotes — it's a reserved word in Postgres.)

Restart the dev server after truncating `staff_user` — the bootstrap admin is only seeded once,
at process startup, so an old token will 401 against a truncated table until the process restarts.
