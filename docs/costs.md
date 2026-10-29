# Free-tier target and limits

Verified against official documentation on **2026-10-29**. The design targets zero fixed compute cost for a small directory; it does not promise that usage, storage, domain registration, backup or operations are always free.

| Service | Included/free boundary relevant here | What this implementation does |
| --- | --- | --- |
| Workers Free | 100,000 requests/day; 10 ms CPU/request; 128 MB memory; 50 D1 queries per invocation | Bounded metadata requests, indexed pages, private byte streams; no GitHub collection or ZIP compression in Worker |
| D1 Free | 5 million rows read/day, 100,000 rows written/day, 5 GB account storage; **500 MB per database**; **2 MB per row** | Per-entry records, changed-row reuse, transactional publication, immutable ledger; quotas can stop service until reset |
| R2 Standard | 10 GB-month, 1 million Class A and 10 million Class B operations/month | Private objects; 8,388,608,000-byte accepted artifact reservation ceiling leaves some room for checkpoints/overhead |
| GitHub Actions | Standard GitHub-hosted runners for public repositories are free; other visibility/runners have separate limits | Trusted fixed code, five-minute task drain, six-hour collection, maximum 45-minute runner job |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

R2 requires an account subscription/checkout even if usage fits its allowance. Standard storage above the allowance is $0.015/GB-month, Class A $4.50/million and Class B $0.36/million operations; internet egress is free. R2 rounds billable units. It is not the same as a paid Workers plan. No code here enables a paid plan. [R2 subscription requirement](https://developers.cloudflare.com/r2/get-started/).

Budgets belong to the account, not just this application. Other Workers, D1 databases or R2 buckets may consume the same allowance. The artifact cap is not an account-wide billing cap and does not include manual/S3 uploads, backup copies or orphan objects. Set account notifications and monitor usage before enabling public traffic. The two-minute lease, five-attempt retry ceiling, 50 pending-job cap, single GitHub gate and dispatch cooldown bound normal work; they are not a guarantee against all abusive traffic or external account use.

D1 index maintenance also counts as writes. A new 10,000-entry catalog can exceed one day's free write allocation, especially with FTS. Six-hour triggers therefore do not guarantee a full large crawl or initial load in one run. Records/checkpoints are resumable; a complete old publication remains live until the new chain is accepted. Archive old operational cache/staging only after a verified backup; the append-only ledger is not a disposable CI cache.

First-time aggregate queries can read matching D1 index rows; warm pages reuse aggregates scoped to snapshot, policy and artifact epoch. The test fixture keeps the first-page payload around 30 KB for 24 summaries at all tested directory sizes. Local measured wall time is not production CPU time. Before claiming Free compatibility in production, inspect actual Worker CPU/error metrics under representative metadata and policy loads. If a path exceeds 10 ms, reduce its bounded work or redesign/offload it; upgrading to a paid plan requires an explicit decision.

GitHub scheduled jobs are delayed when GitHub is busy and may be disabled on inactive public repositories. Pending download is durable and truthful, but no first-ZIP latency SLA is promised. Optional dispatch acceleration can reduce waiting while retaining the scheduled retry path. Configure public-read GitHub tokens and a shared conservative hourly ceiling; primary, search and secondary GitHub limits still govern actual progress. [GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
