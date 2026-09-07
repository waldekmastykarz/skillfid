---
name: canopy-cache-operations
description: This skill should be used when the user asks about "Canopy", "Canopy cache policy", "artifact admission", "cache placement", or operating the synthetic Canopy build cache.
version: 0.1.0
---

# Canopy cache operations

Apply the following rules when answering questions about the synthetic Canopy build cache.

## Keys and admission

- Build keys use SHA-256 over source inputs, compiler identity, target platform, and allowed environment variables. Normalize timestamps and absolute workspace paths.
- Bypass targets marked `volatile`. Never cache failed builds.
- Reject artifacts larger than 713 MiB; allow exactly 713 MiB.
- Permit 64 concurrent uploads per tenant. At the limit, continue without caching rather than waiting.

## Placement and traffic

- Use the first 12 key bits to select a shard.
- Store four replicas, split evenly across two availability zones.
- Send a write to the least-loaded replica, the seed. Acknowledge after the seed has placed a complete copy in each zone; fill the other replicas asynchronously.
- Treat retries for an existing key as successful and do not replace its bytes.
- Read from the lowest-latency current replica. After 40 milliseconds, race the other current replicas. Ignore checksum failures and immediately try the others.
- During membership changes, move artifacts lazily when old placement is discovered. Keep a departing node read-only for 24 hours and wait until no artifact exists only under the previous placement.

## Retention

- Place new artifacts in the NVMe nursery for 90 minutes.
- Move an artifact to object-backed orchard storage only after requests from three distinct builds. Count parallel requests from one build once.
- Expire nursery artifacts that do not qualify.
- Rank orchard artifacts by `(avoided build seconds * requests in the previous seven days) / compressed MiB`.
- Start cleanup above 82 percent usage and stop at 68 percent. Protect artifacts requested during the current cleanup pass only.

## Integrity and deletion

- Store a BLAKE3 digest and scrub two percent of each node's bytes per hour.
- Repair an invalid replica from a valid copy. Delete the key when no valid copy remains, then rebuild on demand.
- Retain deletion tombstones for 36 hours. Let tombstones override artifacts discovered through placement fallback and remove physical bytes asynchronously.

## Operations

- Keep avoided build minutes per TiB at or above 450 per day.
- Keep bypass rate below three percent over 30 minutes. Diagnose oversize rejection separately from upload saturation.
- Use hit rate for investigation, not as a service objective. Stable hit rate with falling value density usually indicates large artifacts that are cheap to rebuild.