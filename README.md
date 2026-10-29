# Covel Catalog · Cloudflare

Cloudflare deployment for the shared Covel Worlds and Plugins catalog.

面向少量用户，以免费额度起步。此仓负责独立部署；公共协议、校验规则和 UI 由 [covel-ai/covel-catalog](https://github.com/covel-ai/covel-catalog) 统一维护。

## Implementation target

- Workers: catalog queries, policy enforcement and download gateway at `api.covel.cc`.
- D1: revisions, observations, policy, idempotent tickets, counters and durable packaging jobs.
- Private R2: immutable package ZIPs addressed by their SHA256.
- GitHub Actions: resumable GitHub collection and bounded ZIP packaging; never execute third-party package scripts.
- Existing Pages sites: `worlds.covel.cc` and `plugins.covel.cc`, sharing the same UI and API contract.

Initial upstream pin: `dc8904eceabfe8017d440acf98c0ae5ab5e5cf5f`, `packages/catalog-kit`, version `0.2.0`. Vendor updates must use a fixed commit plus a full SHA256 manifest. No independent fork of shared business rules.

## Status

Repository initialized. Cloudflare implementation, local integration tests and deployment configuration are being developed in the dedicated T3 session. No Cloudflare resources have been created or deployed by this initialization.

The existing Node/Docker service remains in the upstream repository. Cloudflare requires runtime and persistence adapters; the current Node service cannot be uploaded unchanged.
