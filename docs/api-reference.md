# API reference

Base URL is wherever the service is hosted; there's no path prefix (`/participants`, not
`/api/v1/participants`).

## Auth

Every route except `GET /health`, `GET/POST /webhooks/dropbox`, `POST /inbound/email`, and
`GET /console` requires:

```
Authorization: Bearer <token>
```

The token is looked up against `StaffUser.tokenHash` (`lib/auth.ts`). There are two roles:

- **`ops`** — everything except staff/retention/DKIM-allowlist administration.
- **`admin`** — everything, including `POST /staff-users`, `GET/PUT /retention-settings`,
  `POST /retention/run`, `GET /dropbox-quota`, `POST /dkim-allowlist`.

The first admin is seeded from the `STAFF_API_TOKEN` env var on server startup
(`ensureBootstrapAdmin`). Every token after that is minted by `POST /staff-users` and returned
**once**, in the response body — it's stored only as a hash, so if it's lost the only recovery is
deleting and recreating that staff user.

`GET /me` returns the caller's own `{id, name, role}` — useful for a client to discover what it's
allowed to do.

## Participants & enrollments

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/participants` | `{contact?, email?}` | |
| `GET` | `/participants` | — query: `email?`, `contact?` | |
| `GET` | `/participants/:id` | | Includes enrollments → submissions → mediaAsset/integrityFlags |
| `POST` | `/participants/:id/enrollments` | `{casino}` | |
| `POST` | `/enrollments/:id/file-requests` | | Creates a Dropbox File Request scoped to this enrollment; returns `{url, destinationPath, dropboxRequestId}` — the URL is handed to the participant by hand (PRD D8) |

## Ingest

| Method | Path | Notes |
|---|---|---|
| `GET` | `/webhooks/dropbox?challenge=` | Dropbox's webhook verification handshake — echoes `challenge` back |
| `POST` | `/webhooks/dropbox` | Dropbox change notification. Verifies `X-Dropbox-Signature` when `DROPBOX_APP_SECRET` is set, then runs a full sync (and any auto-triggered extraction) *before* replying — see [`deployment.md`](deployment.md#webhook-timing) for why |
| `POST` | `/inbound/email?token=` | Raw MIME body (any content type not otherwise claimed), or `multipart/form-data` with the raw MIME in a field named `email` (the shape SendGrid Inbound Parse uses). `token` is checked against `INBOUND_EMAIL_TOKEN` when that's configured |
| `POST` | `/submissions/manual` | `multipart/form-data`: `enrollmentId`, `file`, optional `kind` (defaults `wager_recording`). Out-of-band fallback; flagged `MANUAL_INTAKE`. `kind=signup_email` runs the same real DKIM verification as the automated inbound-email path — a runner relaying a participant's `.eml` gets the same tier a self-forwarded one would (see `architecture.md`) |

## Lifecycle

State machine: `invited → email_submitted → email_verified → funded → wager_submitted →
wager_verified → closed`, with `rejected`/`abandoned` reachable from any non-terminal state.
`email_submitted → email_verified` and `funded → wager_submitted` happen automatically on
ingest; `email_verified → funded` and `wager_submitted → wager_verified` are the two PRD-defined
human decisions.

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/enrollments/:id` | | Full detail: participant, grant, submissions, decisions |
| `GET` | `/enrollments/:id/decisions` | | The hash-chained log for this enrollment |
| `GET` | `/enrollments/funding-queue` | | Enrollments at `email_verified`, each with computed `preFundingChecks` |
| `POST` | `/enrollments/:id/fund` | `{note?, grant?: {amount, sentAt, method?}}` | Human decision. `409` if the enrollment isn't at `email_verified` |
| `POST` | `/enrollments/:id/grant` | `{amount, sentAt, method?}` | Record/update grant details independent of the fund action |
| `GET` | `/enrollments/wager-queue` | | Enrollments at `wager_submitted`, with their submissions + extraction runs |
| `POST` | `/enrollments/:id/verify-wager` | `{note?}` | Human decision |
| `POST` | `/enrollments/:id/close` | `{note?}` | `wager_verified → closed` |
| `POST` | `/enrollments/:id/rejected` | `{note?}` | From any non-terminal state |
| `POST` | `/enrollments/:id/abandoned` | `{note?}` | From any non-terminal state |
| `GET` | `/dkim-allowlist` | | |
| `POST` | `/dkim-allowlist` | `{casino, domain}` | **Admin only** |

Every `POST` above uses `X-Staff-Actor`... no — it uses the *authenticated* staff user's name as
the decision's `actor` (not a header); there's nothing to pass beyond the auth token.

## Evidence & extraction

| Method | Path | Notes |
|---|---|---|
| `GET` | `/submissions?participantId=&enrollmentId=&casino=&state=&flag=&from=&to=` | `state`/`casino` filter on the enrollment; `flag` matches an integrity-flag code; `from`/`to` are ISO datetimes on `receivedAt` |
| `GET` | `/submissions/:id` | Full detail: mediaAsset, enrollment+participant+grant, integrityFlags, emailEvidence, extractionRuns→rows/reconciliation |
| `GET` | `/submissions/:id/media` | Streams raw bytes. Writes an `AuditEvent` on every call. `404` if unknown, `410` if the retention job has purged it |
| `POST` | `/submissions/:id/extract` | Manual (re-)trigger — always makes a new `ExtractionRun`, never overwrites an old one |
| `GET` | `/submissions/:id/extraction-runs` | All runs for this submission, newest first, with rows + reconciliation |
| `GET` | `/submissions/:id/extraction-runs/:runId/panorama` | The stitched list image (PNG) that run read from. Audit-logged like raw media (`view_panorama`); 404 if the run has none, 410 if it was purged under retention |

## Admin

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/staff-users` | | **Admin only** |
| `POST` | `/staff-users` | `{name, role: "ops"\|"admin"}` | **Admin only**. Response includes `token` — shown once |
| `DELETE` | `/staff-users/:id` | | **Admin only**. Immediately revokes that token |
| `GET` | `/retention-settings` | | **Admin only** |
| `PUT` | `/retention-settings` | `{rawMediaRetentionDays?, fundedEmailEvidenceRetentionDays?}` | **Admin only** |
| `POST` | `/retention/run` | | **Admin only**. Runs the retention job synchronously and returns `{deleted, skipped}` |
| `GET` | `/dropbox-quota` | | **Admin only**. `{usedBytes, allocatedBytes, warned}` |

## Exports

| Method | Path | Notes |
|---|---|---|
| `GET` | `/exports/submissions.csv?...` | Same filters as `GET /submissions` |
| `GET` | `/exports/decisions.csv?enrollmentId=` | |

## Console

`GET /console` — the review console (static HTML/JS, no auth at the route level; it authenticates
its own API calls client-side once you paste a token in). `GET /` redirects there.
