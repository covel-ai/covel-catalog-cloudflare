# Canonical kit and consumer rollout

This deployment pins **kit 0.3.0**, public commit **`ab1d7e4a78683849e7368e085b73c28437eadcad`**, repository `https://github.com/covel-ai/covel-catalog`, path `packages/catalog-kit`. `catalog-kit.lock.json` contains every source file's SHA-256. The original 0.2.0 baseline was `dc8904eceabfe8017d440acf98c0ae5ab5e5cf5f` with 44 files; added public modules/tests/type declarations are included in the new complete manifest, not untracked vendor extras.

The upstream commit extracts policy matching, revision identity/conflict projection, release validation, timestamps, query normalization and update selection from the synchronous Node store into `core`. The Node store calls that same core and remains synchronous. HTTP request/range schemas are shared. The change adds the canonical collector orchestration, pending-download polling with cancellation and a declaration file, plus staged publication negotiation. It does not ship a fake D1 adapter or change the wire schema version.

The shared UI keeps all existing components/styles. Its client accepts either the Node 200 ticket or a CF 202 persistent job; it retries with the same idempotency key, cancels polling on close/version change, and rejects foreign download origins. Both Worlds and Plugins must upgrade to the same pin before CF first-download jobs are exposed to their users. This deployment does not fork or restyle the 12 UI files.

The shared publisher recognizes `X-Catalog-Ingest: staged-v1` on the policy preflight. It then uses bounded manifests/records/finish with the same per-kind token. Without that header, the existing Node direct ingestion remains unchanged. The CF service deliberately does not proxy large GitHub bodies through a Worker: collection and heavy packaging belong to this repository's trusted runner and use the persistent shared budget gate.

## Impact on the existing consumers

The following repositories were read for integration context and have **not** been edited or pushed by this implementation:

- `/root/covel-worlds`, local consumer commit `97bf0cf`, currently pinned to 0.2.0.
- `/root/covel-plugins`, local consumer commit `107d481099889b9d01d9d7c83a69e7403c35f321`, currently pinned to 0.2.0.

Coordinate a normal kit sync/lock refresh in both, clean-install from the consumer root, run shared/consumer/browser acceptance and build the same UI with `VITE_CATALOG_API=https://api.covel.cc`. Their existing Node-service collection proxy workflows must not be pointed unchanged at CF. For this deployment, turn off duplicate production collection/ingestion in the content repositories and let this runner own it; retain their fixture/manifest validation and static Pages build. Alternatively, a deliberately separate direct-GitHub collector can publish with the upgraded shared staged publisher, but it must join the same deployment budget/lease design before being called globally coordinated.

`catalog/plugins.json` and `catalog/worlds.json` are deployment data: reviewed Topics, official-name lists, migration seeds, limits, and the Plugins frozen migration metadata read from those consumer checkouts. They are not a copied parser or collector implementation. Changes to collection inputs are reviewed here and trigger a new six-hour collection round. Official status always comes from the current configured repository name; seeds cannot override policy/public visibility or current manifest declarations.

A kit upgrade is only rolled out once both consumers have adopted it. Cloudflare code/CI readiness does not assert that the two sites, their unpublished local migration commits, DNS, or the new backend are already deployed.
