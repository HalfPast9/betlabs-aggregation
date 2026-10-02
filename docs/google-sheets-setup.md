# Google Sheets export — setup

Each enrollment exports to **one spreadsheet** with a **Summary** tab and a tab per recording.
The console has a button on the submission page ("Open in Sheets" — opens that recording's tab)
and one per enrollment on the participant page. Re-exporting rewrites the same spreadsheet, so
the link stays valid and a re-run of extraction refreshes it.

With `SHEETS_MODE=fake` (the default) this all works with no Google account at all: the tabs are
written as CSVs into the object store and served from `/sheets/:id`. Everything below is only
needed for real Google Sheets.

## Before you start: service accounts have no Drive storage

Google removed storage quota from service accounts in 2024. The robot can *write to* files, but
it can't **own** one — and creating a spreadsheet means creating a file it would own. On a
personal Gmail that request comes back as a bare `403 The caller does not have permission`.

The fix is a **Shared Drive** (Google Workspace): storage belongs to the drive, not to whoever
created the file, so the service account can create spreadsheets there freely. That's what
`SHEETS_DRIVE_FOLDER_ID` is for, and in `google` mode it is effectively required. Without
Workspace, use an OAuth user credential instead (not built — ask).

## One-time setup (~5 minutes, no password sharing)

The server authenticates as a **service account** — a robot identity with its own key file. It
never logs into your Gmail, and there's no token to re-consent.

1. Go to <https://console.cloud.google.com/> and create a project (any name, e.g. `betlab`).
2. **APIs & Services → Library**: enable **Google Sheets API** and **Google Drive API**.
3. **APIs & Services → Credentials → Create credentials → Service account**. Name it
   (e.g. `betlab-exporter`), skip the optional role/user steps, click Done.
4. Click the service account → **Keys → Add key → Create new key → JSON**. A `.json` file
   downloads. That file is the credential — treat it like a password, keep it out of git.
5. Put it somewhere local (e.g. `~/.betlab/google-service-account.json`) and set:

```
SHEETS_MODE=google
GOOGLE_SERVICE_ACCOUNT_JSON=/home/you/.betlab/google-service-account.json
SHEETS_SHARE_WITH=you@gmail.com,someone@betlab.example
PUBLIC_BASE_URL=http://localhost:3000
```

`SHEETS_SHARE_WITH` matters: a spreadsheet the service account creates is invisible to humans
until it's shared. Every workbook is shared as **writer** with each address listed, without an
email notification. The server refuses to start in `google` mode without it.

Restart the server. The first export creates the spreadsheet; the link appears in the console
and in your Drive under "Shared with me".

### Required: a Shared Drive for the workbooks to live in

6. In Google Drive, **Shared drives → New** (e.g. "Betlab evidence"). A *Shared drive*, not a
   folder in My Drive — that's what owns the storage.
7. Open it → **Manage members** → add the service account's email (the `client_email` in the key
   file, e.g. `betlab-exporter@…iam.gserviceaccount.com`) as **Content manager**.
8. Set `SHEETS_DRIVE_FOLDER_ID` to the id in the URL. For a shared drive the URL looks like
   `https://drive.google.com/drive/folders/0AB…` → the id is the part after `/folders/`. A
   sub-folder inside the shared drive works equally well.

`SHEETS_SHARE_WITH` is still honoured — each workbook is additionally shared with those
addresses — but members of the shared drive can already open everything, and a domain policy
that refuses individual sharing is logged and ignored rather than failing the export.

## What's in a workbook

- **Summary** — participant, casino, grant; totals across every recording; the balance-chain
  verdict and any breaks; a row per recording (rows, chain, recording-quality verdict, a link
  back to the console); every integrity flag; when it was generated.
- **One tab per recording** — the extracted rows: sequence, timestamp, type, description,
  amount, balance before/after, whether the independent second read agreed, and the time in the
  recording the row was read from.

## Troubleshooting

| Error | Cause |
|---|---|
| `Google Sheets API has not been used in project … or it is disabled` | Step 2 — enable both APIs, wait a minute |
| `Request had insufficient authentication scopes` | The key is from a different project than the one with the APIs enabled |
| `File not found` on re-export | The spreadsheet was deleted in Drive. The next export makes a new one automatically |
| Export works but you can't find the file | `SHEETS_SHARE_WITH` was empty or wrong; check Drive → "Shared with me" |
| `service account key is missing client_email` | That's an OAuth *client* JSON, not a service-account key — redo step 4 |
| `403 The caller does not have permission` on create | No `SHEETS_DRIVE_FOLDER_ID`, or the service account isn't a member of that shared drive. Service accounts can't own files (see the top of this page) |
| `File not found` with a folder id set | The id is a My Drive folder, or the robot isn't a member of the shared drive |
