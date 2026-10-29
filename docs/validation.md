# Validation record

Validated on 2026-10-29 with Node 26.12.1, Wrangler 4.155.0 and its matching Miniflare 5.20261023.2-beta / workerd runtime. Compatibility date is pinned to 2026-07-01. No account credentials or real cloud resources are needed for acceptance.

## Completed locally

- Public upstream: 79 tests, including the Node SQLite/WAL recovery suite; Docker non-root/read-only/persistent-volume smoke with health 200 and uninitialized catalog/policy 503. [Upstream CI at the fixed SHA](https://github.com/covel-ai/covel-catalog/actions/runs/40859414386) passed.
- Installed kit: 78 shared tests, run in the installed package cwd; all 52 installed and vendor files match the complete upstream SHA-256 lock.
- CF adapter: 9 integration scenarios with real workerd, D1 and R2, two independent Worker services sharing bindings, and deterministic GitHub transport fixtures.
- Shared UI: strict TypeScript check on a separate copy using the existing Worlds toolchain. Content repository working trees were not changed.
- Wrangler production bundle dry-run succeeds; no Node SQLite, HTTP server or filesystem packager is in the Worker entry.
- Full npm dependency audit: zero known vulnerabilities at validation time.

The CF scenarios cover uninitialized/expired-policy fail-closed behavior; atomic staged publication; stale/incomplete shards; short Chinese indexed search; 24-row pages; stable old-snapshot cursors and policy invalidation; durable single-flight jobs and cross-Worker claims; lease takeover/retry/shared budgets; R2 checksum rejection; real canonical single-package ZIP output; idempotent ticket triggers; Range/HEAD; repository becoming private; repo/owner/path/commit/content/archive revocation; old-version-only revocation; restore; unchanged-row reuse; release conflicts/path moves/re-entry; resumed collection and lost shard acknowledgements; and a Wrangler SQL export plus R2 checksum-verified restore into a new environment, including old ticket redemption and preserved counters.

The synthetic 100/1,000/10,000-row fixture keeps its response near 30 KB and exactly 24 entries. Query plans use the sort index; aggregates are cached by publication/policy/artifact epoch. Local warm wall time in the latest run was 5–6 ms. This is an offline regression measurement, **not** Cloudflare CPU usage or a production latency/free-tier guarantee.

## Remote and deployment boundaries

The standalone repository's CI runs the same vendor, installed-contract, bundle, workerd/D1/R2 recovery and dependency checks. Its resulting run is recorded after pushing the acceptance branch and before advancing main.

Cloudflare CLI preflight currently reports **not authenticated**. The committed D1 ID remains a deployment guard placeholder. No Worker, D1 database, R2 bucket, subscription, DNS/custom domain, production secret, policy or live catalog was deployed by local testing. No real GitHub collection was claimed from fixture runs. Both consumer sites still need the coordinated kit/UI/workflow rollout described in [consumers](consumers.md).
