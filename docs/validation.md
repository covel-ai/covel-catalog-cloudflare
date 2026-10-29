# Validation record

Validated on 2026-10-29 with Node 26.12.1, Wrangler 4.155.0 and its matching Miniflare 5.20261023.2-beta / workerd runtime. Compatibility date is pinned to 2026-07-01. No account credentials or real cloud resources are needed for acceptance.

## Completed locally

- Public upstream: 79 tests, including the Node SQLite/WAL recovery suite; Docker non-root/read-only/persistent-volume smoke with health 200 and uninitialized catalog/policy 503. [Upstream CI at the fixed SHA](https://github.com/covel-ai/covel-catalog/actions/runs/40859414386) passed.
- Installed kit: 78 shared tests, run in the installed package cwd; all 52 installed and vendor files match the complete upstream SHA-256 lock.
- CF adapter: 10 integration scenarios with real workerd, D1 and R2, two independent Worker services sharing bindings, and deterministic GitHub transport fixtures, including the anonymous GitHub sublimit and quota-pause attempt preservation.
- Shared UI: strict TypeScript check on a separate copy using the existing Worlds toolchain. Content repository working trees were not changed.
- Wrangler production bundle dry-run succeeds; no Node SQLite, HTTP server or filesystem packager is in the Worker entry.
- Full npm dependency audit: zero known vulnerabilities at validation time.

The CF scenarios cover uninitialized/expired-policy fail-closed behavior; atomic staged publication; stale/incomplete shards; short Chinese indexed search; 24-row pages; stable old-snapshot cursors and policy invalidation; durable single-flight jobs and cross-Worker claims; lease takeover/retry/shared budgets; R2 checksum rejection; real canonical single-package ZIP output; idempotent ticket triggers; Range/HEAD; repository becoming private; repo/owner/path/commit/content/archive revocation; old-version-only revocation; restore; unchanged-row reuse; release conflicts/path moves/re-entry; resumed collection and lost shard acknowledgements; and a Wrangler SQL export plus R2 checksum-verified restore into a new environment, including old ticket redemption and preserved counters.

The synthetic 100/1,000/10,000-row fixture keeps its response near 30 KB and exactly 24 entries. Query plans use the sort index; aggregates are cached by publication/policy/artifact epoch. Local warm wall time in the latest run was 5–6 ms. This is an offline regression measurement, **not** Cloudflare CPU usage or a production latency/free-tier guarantee.

## Remote and deployment boundaries

The standalone repository's [acceptance CI](https://github.com/covel-ai/covel-catalog-cloudflare/actions/runs/40860320414) passed for implementation commit `6d064f94ebe96e963adb96487190cf5f01b72d75` on the acceptance branch before advancing main. It runs vendor/installed integrity, shared contracts, bundle, workerd/D1/R2 recovery and full dependency audit. Later documentation or workflow commits run the same CI again.

Production configuration commit `2f2ea6a329ea10f8ec54947e3b97388575ad2ef8` passed [acceptance CI](https://github.com/covel-ai/covel-catalog-cloudflare/actions/runs/40877894971). The authorized account already had R2 enabled. The dedicated `catalog` D1 database and `covel-catalog-private` R2 bucket were created, both migrations applied, and `covel-catalog` deployed to `https://api.covel.cc`. Health returned 200; missing policy and missing complete catalogs each correctly returned 503. Both R2 public access mechanisms are disabled; Workers development and preview URLs are disabled. No account plan was purchased or upgraded.

The [GitHub production deployment](https://github.com/covel-ai/covel-catalog-cloudflare/actions/runs/40878516517) and [independent policy publication](https://github.com/covel-ai/covel-catalog-cloudflare/actions/runs/40878251398) workflows succeeded using main-only GitHub Environment Secrets. Credential values are absent from tracked files. Policy sequence 1 is initially empty and expires on 2026-11-05 at 00:00 UTC; see [policy operations](policy.md).

The initial trusted collection completed with 9 plugin entries and 2 world entries. Both Pages sites are now pushed and built against the API: [Worlds deployment](https://github.com/covel-ai/covel-worlds/actions/runs/40892397527) and [Plugins deployment](https://github.com/covel-ai/covel-plugins/actions/runs/40892400077) succeeded, as did their separate offline/browser CI. The public project URLs serve the shared default-dark bootstrap. The custom domains still require GitHub Pages ownership verification and Cloudflare DNS access; a successful build is not evidence that those hostnames are live.

Live ZIP preparation completed for `story-note` and `clockwork-market`. A real `story-note` download returned 5,967 bytes matching SHA256 `84207c2d0b47c60fa1e69d8be1685782c286ac289a620c362662200598e8bd19`. Rapid consecutive ticket/file requests exposed a 429 caused by the mandatory one-second global GitHub gap. The adapter now waits at most 2.2 seconds for that gate; it still acquires a D1 lease and enforces the same hourly/anonymous quotas. The workerd regression performs immediate retry, Range on a second Worker instance and HEAD without resetting the gate. Production confirmation of this fix is recorded after deployment.

Policy expiry remains 2026-11-05 00:00 UTC. ZIP capabilities are still enabled; the proposed installation-guidance replacement has not been implemented. No production backup/restore is claimed from local recovery tests.
