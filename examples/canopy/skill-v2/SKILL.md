---
name: canopy-cache-operations
description: This skill should be used when the user asks about "Canopy", "Canopy cache policy", "artifact admission", "cache placement", or operating the synthetic Canopy build cache.
version: 0.2.0
---

# Canopy cache operations

Apply the following source-backed rules when answering questions about Canopy. Preserve the relevant actor, timing, boundary, failure branch, and rationale. Distinguish steps that happen before acknowledgement, after acknowledgement, or during a retention window. Do not infer behavior that is not stated here.

## Governing model

Canopy is a synthetic distributed cache for compiled build artifacts. It is designed for workloads where every artifact can be rebuilt from source but rebuilding is expensive enough that availability and storage efficiency matter. Treat cached data as disposable. Source control and the build system, not Canopy, remain the systems of record.

## Keys and admission

- Derive each key with SHA-256 over source inputs, compiler identity, target platform, and only allowlisted environment variables. Normalize timestamps and absolute workspace paths before hashing.
- Bypass build rules marked `volatile` because their output is not expected to be deterministic. Never cache failed builds.
- Enforce admission in the client before sending any bytes. Reject artifacts larger than 713 MiB; allow exactly 713 MiB.
- Permit at most 64 uploads in progress per tenant. At the limit, continue the build without caching rather than waiting.
- Use these limits to prevent large debug bundles and reconnecting worker fleets from overwhelming the service.

## Placement and writes

- Use the first 12 key bits to select a shard. Within the selected shard, place four replicas across two availability zones, with two replicas in each zone.
- Send a new artifact to the least-loaded replica, called the seed. The seed verifies the artifact key and streams copies to the other zone.
- Acknowledge only after one replica in each zone stores the complete artifact. This lets an acknowledged write survive loss of either zone. Populate the remaining two replicas asynchronously.
- If the seed fails before acknowledgement, retry against another replica. If it fails after acknowledgement, use background repair to restore missing copies.
- Reuse the same artifact key for upload retries. Retries are idempotent: a replica that already holds the key returns success without replacing its bytes.

## Reads and membership

- Contact the lowest-latency replica in the current placement map first. After 40 milliseconds, race all remaining current replicas. The first valid response wins.
- Do not count a checksum failure as a response; immediately start requests to the other replicas.
- When storage nodes join or leave, controllers publish a numbered placement map. Do not move existing artifacts immediately.
- After a miss under the current map, consult owners from only the immediately preceding map, never an older map. Finding an artifact there schedules a background copy to its current owners.
- Allow a node to leave only after it has remained read-only for 24 hours and reports that no artifact exists solely under the previous placement map.

## Storage and retention

- Put new artifacts in the NVMe-backed nursery for 90 minutes.
- Promote an artifact to the orchard object-storage class only when at least three distinct builds request it during that period. Count repeated requests from parallel steps in one build once. Expire nonqualifying artifacts after 90 minutes.
- Base orchard retention on value density rather than recency. Calculate it as `(avoided build seconds * requests in the previous seven days) / compressed artifact size in MiB`.
- Start cleanup when orchard usage exceeds 82 percent. Remove artifacts from lowest to highest value density until usage reaches 68 percent.
- Protect an artifact requested during cleanup for the remainder of that pass. The protection does not persist, and the artifact may be considered again during the next pass.

## Integrity and deletion

- Store a BLAKE3 digest alongside every artifact's SHA-256 key. Scrub two percent of each node's resident bytes per hour.
- Replace an invalid replica from a valid copy. If no valid copy remains, delete the key and let the next client rebuild it.
- Limit repair traffic to eight percent of a node's outbound bandwidth so repair cannot crowd out normal reads.
- Represent user deletion with a tombstone instead of immediately erasing every replica. Retain tombstones for 36 hours and let them override artifacts found through an older placement map, preventing membership fallback from resurrecting deleted data.
- Remove physical bytes asynchronously during the 36-hour tombstone retention window.

## Operations

- Use avoided build minutes per TiB and bypass rate as the two primary signals.
- Avoided build minutes per TiB measures whether the cache retains expensive work. Keep it at or above 450 per TiB each day.
- Bypass rate is the share of otherwise cacheable artifacts skipped because of admission or concurrency limits. Keep it below three percent over a 30-minute window.
- Use hit rate for investigation, not as an objective. A cache containing many cheap artifacts can have a high hit rate while saving little build time.
- When avoided build minutes per TiB falls while hit rate stays stable, first look for large artifacts with short rebuild times.
- When bypass rate rises, distinguish oversize rejection from tenant upload saturation before changing capacity. Raising the 64-upload limit is not the default response because it can turn a reconnect event into a storage traffic spike.