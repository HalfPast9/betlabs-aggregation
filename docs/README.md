# Documentation index

This is the Betlab submission-archive service — see [`../prd.md`](../prd.md) for the client-facing
spec this was built against. These docs cover the codebase itself.

- [`architecture.md`](architecture.md) — how the pieces fit together, milestone by milestone, and
  the fake/real pattern used for every external dependency.
- [`data-model.md`](data-model.md) — every table, what it's for, and how they relate.
- [`api-reference.md`](api-reference.md) — every route, its auth requirement, and request/response shape.
- [`extraction-benchmark.md`](extraction-benchmark.md) — measured extraction accuracy on real
  recordings, the ground-truth harness, and the plan for evaluating a cheaper/optimized model
  before it goes near production.
- [`extraction-hardening.md`](extraction-hardening.md) — the design behind the reliability work on
  the extraction layer: normalization, retry-before-flag, cross-check reads, recording quality,
  the background queue, calibration, the eval gate, reviewer tooling, multi-clip ledgers.
- [`recording-guide.md`](recording-guide.md) — one page for participants and runners: how to record
  a transaction history so it reads cleanly, and what a bounce message means.
- [`google-sheets-setup.md`](google-sheets-setup.md) — exporting an enrollment to a Google Sheet:
  what the button does, and the five-minute service-account setup.
- [`local-development.md`](local-development.md) — running it, testing it, environment variables.
- [`demo-script.md`](demo-script.md) — the client walkthrough to record: beats, what to say, what
  not to click, and how to re-stage between takes.
- [`demo-readiness.md`](demo-readiness.md) — the near-term checklist: what's real vs. fake right
  now, ahead of walking Betlab through this live.
- [`deployment.md`](deployment.md) — the *later* concern: what's needed to run this on real,
  publicly reachable infrastructure instead of a local demo.

## Orientation in one paragraph

A Fastify + TypeScript + Postgres (Prisma) service. Evidence arrives two ways — a Dropbox File
Request per enrollment (screen recordings) and a dedicated intake mailbox (signup-confirmation
emails, verified via DKIM) — gets archived content-addressed in an object store, and drives an
enrollment through a hash-chained state machine. Wager recordings are run through an extraction
pipeline (scroll reconstruction → vision model → balance-chain verification) that produces
structured transaction rows and integrity flags. A thin console at `/console` gives staff
search, a side-by-side review view, funding/wager decision queues, and admin functions (staff
accounts, retention policy). Every external system it talks to — Dropbox, object storage, email
in and out, the vision model — is behind an interface with a fake implementation the tests and
local dev run against by default, and a real implementation that's a config change away.
