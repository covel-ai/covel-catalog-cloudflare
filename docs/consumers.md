# Canonical kit and consumer rollout

This deployment pins **kit 0.3.0**, public commit **`ab1d7e4a78683849e7368e085b73c28437eadcad`**, repository `https://github.com/covel-ai/covel-catalog`, path `packages/catalog-kit`. `catalog-kit.lock.json` contains every source file's SHA-256. The original 0.2.0 baseline was `dc8904eceabfe8017d440acf98c0ae5ab5e5cf5f` with 44 files; added public modules/tests/type declarations are included in the new complete manifest, not untracked vendor extras.

The upstream commit extracts policy matching, revision identity/conflict projection, release validation, timestamps, query normalization and update selection from the synchronous Node store into `core`. The Node store calls that same core and remains synchronous. HTTP request/range schemas are shared. The change adds the canonical collector orchestration, pending-download polling with cancellation and a declaration file, plus staged publication negotiation. It does not ship a fake D1 adapter or change the wire schema version.

The shared UI keeps all existing components/styles. Its client accepts either the Node 200 ticket or a CF 202 persistent job; it retries with the same idempotency key, cancels polling on close/version change, and rejects foreign download origins. Both Worlds and Plugins must upgrade to the same pin before CF first-download jobs are exposed to their users. This deployment does not fork or restyle the 12 UI files.

The shared publisher recognizes `X-Catalog-Ingest: staged-v1` on the policy preflight. It then uses bounded manifests/records/finish with the same per-kind token. Without that header, the existing Node direct ingestion remains unchanged. The CF service deliberately does not proxy large GitHub bodies through a Worker: collection and heavy packaging belong to this repository's trusted runner and use the persistent shared budget gate.

## Impact on the existing consumers

Both consumer sites now pin kit **0.3.1**, commit `5fca414b7e1b505174a21cf329b0dbf6c27b260c`, with identical complete 56-file manifests and the same generated default-dark head block. This Worker still pins 0.3.0: 0.3.1 only adds theme preference handling and does not change the API contract.

- Worlds rollout: `fb20999c518c9113b00d0853cfe8b4b4c991c31a` (includes theme commit `0c9c6225ff84ba53045d9ac0da5b372d7ec0f20f`).
- Plugins rollout: `38c667cda5a8135f0760b2a87a6ce195518e62d9` (includes theme commit `e1c4593`).

Each consumer uses `.github/workflows/site.yml` (**Publish site with Cloudflare catalog**) and the public repository variable `DIRECTORY_API_URL=https://api.covel.cc`. It verifies the current policy and bounded catalog response, then builds the pinned UI with `VITE_CATALOG_API` and publishes static Pages assets. Local fixture exports are omitted. Neither site has a catalog write secret or Cloudflare token.

The old `.github/workflows/pages.yml` combined Node proxy/collector workflow is disabled in GitHub Actions, with `CATALOG_API_URL` unset. It remains checked against the pinned shared Node template, but must not be enabled against this deployment. Only this repository's trusted runner performs production collection and ingestion; its D1 leases and GitHub budget coordinate all instances. `https://covel-ai.github.io` is also an allowed browser origin for the two GitHub Pages project URLs while custom domain verification is pending.

`catalog/plugins.json` and `catalog/worlds.json` are deployment data: reviewed Topics, official-name lists, migration seeds, limits, and the Plugins frozen migration metadata read from those consumer checkouts. They are not a copied parser or collector implementation. Changes to collection inputs are reviewed here and trigger a new six-hour collection round. Official status always comes from the current configured repository name; seeds cannot override policy/public visibility or current manifest declarations.

A kit upgrade is only rolled out once both consumers have adopted it. Cloudflare code/CI readiness does not assert that the two sites, their unpublished local migration commits, DNS, or the new backend are already deployed.
