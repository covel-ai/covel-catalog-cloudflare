# Deployment, operation and recovery

No cloud account, paid plan, bucket or database is created by tests, builds or CI. `npm run deploy` refuses the placeholder D1 ID. Use Node 26. The same workerd, D1 and R2 implementation used by pinned Wrangler runs in the integration tests; Miniflare is pinned to Wrangler's exact dependency (currently a 5.x beta).

## Local acceptance

```sh
npm ci --ignore-scripts
npm run check:vendor
npm run test:kit
npm run build
npm test
npm audit
```

The kit tests deliberately run **inside the installed copy**. Node 26 can silently skip tests when invoked by their path under `node_modules` from the repository root. Never install dependencies inside `vendor`; the manifest rejects extra files. `npm ci` uses `install-links=true` to install a copy. Synchronize new commits with `node scripts/catalog-kit.mjs sync --commit FULL_SHA`, refresh the lockfile, then clean-install and rerun acceptance.

`npm test` includes real workerd requests, D1 migrations/transactions, private R2 checksum rejection and range streaming, a trusted runner packaging only the selected world directory, 100/1,000/10,000-row fixtures, concurrent claims, policy changes and a Wrangler SQL/R2 backup/restore round trip. GitHub responses in these tests are deterministic transport fixtures; this is not a claim that Cloudflare resources or live GitHub collection were deployed.

For interactive local use copy `.dev.vars.example` to `.dev.vars`, populate distinct secrets privately, and run:

```sh
npm run migrate:local
npm run dev
```

Set local `PUBLIC_URL` to `http://127.0.0.1:8787` in a local Wrangler config when testing browser ticket URLs. A fresh database returns health 200 and catalog 503 until an unexpired policy and a complete snapshot are published. The runner and publisher accept loopback HTTP only for local testing. Production requires an HTTPS origin.

## Provisioning checklist for an authorized account

1. Verify the account ID and existing plan with `wrangler whoami`. Confirm that the account has an R2 subscription; completing R2 checkout is an explicit billing decision. This project does not enroll an account or upgrade Workers.
2. Use an existing D1 database and private Standard R2 bucket, or explicitly create `catalog` and `covel-catalog-private` with Wrangler/dashboard. Keep all R2 public access disabled. Put the real D1 UUID in `wrangler.jsonc`; set `CLOUDFLARE_ACCOUNT_ID` outside source control.
3. Apply `npx wrangler d1 migrations apply catalog --remote`. Review migration changes before every upgrade. This is a schema operation; the manual deployment workflow does not silently migrate a production ledger.
4. Add the Worker secrets below with `wrangler secret put NAME` or a secret manager's private file delivery. Use distinct random values of at least 32 characters. Do not print them in terminal output, chats, frontend builds or Actions logs.
5. Run local/CI acceptance, then `npm run deploy`. Configure `api.covel.cc` as a Worker Custom Domain on the authorized zone, e.g. a reviewed `routes: [{"pattern":"api.covel.cc","custom_domain":true}]` entry in Wrangler. `workers_dev` and preview URLs stay disabled. DNS/custom-domain setup is not performed by this repository's build.
6. Review an initial policy: copy `catalog/policy.example.json` to `catalog/policy.json`, set a strictly increasing sequence and current issuance/expiry, review rules, commit it, then publish using the separate policy workflow or `node scripts/policy.mjs catalog/policy.json`. The example is intentionally expired; it cannot open downloads accidentally. Renew policy before expiry.
7. Configure the runner environment and dispatch the trusted task workflow once. Inspect `/admin/status` with the ops credential, a publication receipt, both `/v1/catalog?kind=…` responses, a pending task, its ready ticket, ZIP hash and a policy revoke/restore exercise before opening the public sites.
8. Coordinate both content repositories' kit upgrade and site build. Set their `VITE_CATALOG_API=https://api.covel.cc`. This session does not modify or push those repositories.

## Credentials and workflow boundaries

| Secret / setting | Consumer | Scope |
| --- | --- | --- |
| `CURSOR_SECRET` | Worker | Cursor HMAC; retain during normal recovery |
| `POLICY_TOKEN` / `CATALOG_POLICY_TOKEN` | Worker / policy workflow | Independently publish rules only |
| `PLUGINS_INGEST_TOKEN`, `WORLDS_INGEST_TOKEN` | Worker / corresponding external publisher | Staged publication of one kind only |
| `RUNNER_TOKEN` / `CATALOG_RUNNER_TOKEN` | Worker / `catalog-runner` environment | Enqueue collection and claim tasks; no policy or direct artifact publication |
| Job lease token | Worker → runner, ephemeral | One task, expiry, kind, uploads/checkpoints/completion |
| `OPS_TOKEN` / `CATALOG_OPS_TOKEN` | Worker / private operations CLI | Status, failed-job retry, maintenance-only object recovery |
| `GITHUB_TOKEN` / `CATALOG_GITHUB_TOKEN` | Worker / runner | Public repository reads; never sent to browsers |
| `ACTIONS_DISPATCH_TOKEN` | Worker, optional | Actions-write on this deployment repository only |
| `CLOUDFLARE_API_TOKEN` | Deployment/backup CLI or `catalog-production` environment | Existing account's Workers/D1/R2 operations; no frontend or task claim exposure |

The runner uses the repository's read-only `github.token` if no separately configured public-read token is provided. Give the Worker its own public-read token and keep the single shared 900/hour ceiling, or lower that ceiling to 50/hour when unauthenticated. GitHub's own resource-specific rate/reset/secondary limits also apply.

Actions schedules the durable queue every five minutes and collection at `17 */6 * * *`. Pushes changing collection inputs also enqueue a round. A manual dispatch collects and drains pending work. GitHub can delay scheduled workflows, and can disable schedules on inactive public repositories; monitor it. Optional Worker dispatch acceleration uses the fixed repository/workflow/ref configuration and a D1 five-minute dispatch gate. It sends no package data as executable workflow input. The schedule remains the durable recovery trigger if dispatch fails. `ACTIONS_REF` must name the protected deployment branch; there is no caller-selected source ref.

All workflow actions use full reviewed commit SHAs. PR CI receives no deployment/runner/policy secrets. The runner executes only trusted default-branch code; content repositories supply manifests and blobs as data, never executable Actions steps. Concurrency in Actions is an additional limit; D1 leases and fencing are the authority across independent runners and Workers.

## Observation and bounded retry

Authenticated `GET /admin/status` reports publication IDs/times, queue counts, shared GitHub budget/cooldown, artifact reservation bytes and policy expiry. Use Workers metrics/logs for CPU/exceeded-CPU errors and request failures, D1 metrics for rows read/written and size, R2 metrics for storage and operations, and Actions for runner duration/last success. D1's database `meta` and dashboard metrics measure actual usage; local page wall time is not Worker CPU time.

Transient GitHub or API failures preserve checkpoints and the prior publication. Tasks use a two-minute lease, heartbeat every 30 seconds, exponential retry and five-attempt ceiling. A failed task remains visible; inspect its runner log and status, then `POST /internal/retry` with the ops credential and `{ "jobId": "..." }`. This does not reset counters or mutate version history. Insufficient D1 quota may prevent even lease/heartbeat writes until reset; the next authorized runner can reclaim expired work. When necessary, retry the failed collection job after quota reset rather than discarding its R2 checkpoints.

Checkpoints are bounded private JSON objects. Replacing one checkpoints its pointer transactionally before deleting its predecessor. An interrupted upload can leave an unreferenced object. No automatic history deletion is installed. Monitor stale staging, unreferenced objects, query aggregate cache and the 500 MB free database limit. Archive verified backups before a reviewed cleanup. Never delete ledger, tag bindings, policy sequences or counters to make a cache smaller.

## Coordinated backup

Quiesce the service briefly so database rows and mutable checkpoint pointers describe the same recovery point:

```sh
npx wrangler d1 execute catalog --remote --command "UPDATE settings SET value='1' WHERE key='maintenance'"
# Stop dispatching runners and wait until their current two-minute leases expire.
node scripts/backup.mjs create /secure/backups/covel-YYYYMMDD --remote
node scripts/backup.mjs verify /secure/backups/covel-YYYYMMDD
npx wrangler d1 execute catalog --remote --command "UPDATE settings SET value='0' WHERE key='maintenance'"
```

The backup command requires maintenance and no live runner lease. It exports canonical D1 tables with Wrangler, downloads every referenced private artifact/checkpoint, checks ledger SHA-256 values, and writes a full file manifest. It does not copy a live SQLite/WAL file. FTS and assertion rows are disposable and excluded. A failed backup leaves maintenance enabled for operator recovery. Store verified encrypted copies outside the same account. R2 object downloads and backup storage count toward their respective service quotas. D1 Free Time Travel is an additional seven-day tool, not a backup of R2 or external secrets.

## Recovery into a new environment

Use only a trusted backup you created and verified. The SQL checksum detects damage, not the trustworthiness of an unknown SQL file.

1. Create/select a **new** private target database/bucket in the authorized account, set their bindings and apply migrations. Deploy this same Worker version to an operator-accessible HTTPS origin with maintenance enabled and the corresponding private secrets. Preserve `CURSOR_SECRET` if existing cursors must remain valid; existing ticket records are in the SQL backup.
2. Set `CATALOG_API_URL` to that target Worker and supply `CATALOG_OPS_TOKEN` privately. Run:

```sh
node scripts/backup.mjs verify /secure/backups/covel-YYYYMMDD
node scripts/restore.mjs /secure/backups/covel-YYYYMMDD --remote
```

3. The restore refuses a nonempty target, verifies all backup files, restores objects through a maintenance-only checksum-verifying Worker endpoint, imports the database without replaying ticket-count triggers, restores the trigger and rebuilds search indexes in bounded pages. Expired runner leases are invalidated. **Maintenance remains enabled.**
4. Compare publication IDs, counters, policy sequence/expiry, representative revision histories and object hashes with the backup. Publish a fresh higher-sequence policy if needed after reopening policy access, before reopening user-facing traffic. Use an ops-only temporary origin for this preflight. Rotate secrets if the incident involved credentials.
5. Disable maintenance, verify both directories and a fresh/old ticket including Range, then switch the production custom domain and resume the runner schedule. Existing transferred bytes cannot be recalled. If validation fails, keep the old production pointer/domain and diagnose the isolated target.

Omit `--remote` for local drills. The acceptance suite runs this export/import/object recovery flow against actual persisted workerd D1/R2 stores and checks a redeemed old ticket and an unchanged counter.
