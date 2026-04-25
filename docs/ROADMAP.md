# VENOM Network — v1.1 Roadmap

**Target Release:** Q3 2026

---

## 1. Real Payload Fetching (Core Feature)

### Goal
Replace the hardcoded `GOOD_PAYLOAD` with decentralized, immutable campaign content.

### Design

**On-chain Campaign Metadata**
- `PilotEscrow.fundCampaign()` will accept an additional `bytes32 contentHash` parameter (IPFS CID or Arweave TX ID).
- The hash is stored immutably with the campaign.

**Worker Flow (v1.1)**
1. `producer.js` detects new `CampaignFunded` event → includes `contentHash`.
2. `worker.js` receives job with `campaignUid` + `contentHash`.
3. Worker fetches content via:
   - Primary: IPFS gateway (with timeout + fallback)
   - Secondary: Arweave (if IPFS fails)
   - Tertiary: On-chain fallback (small payloads only)
4. Content is verified against `contentHash` before scoring.
5. If fetch fails or hash mismatch → node skips campaign (no penalty).

**Benefits**
- Nodes can no longer be gamed with static test data.
- Campaign creators can attach rich context (markdown, JSON, images).
- Full audit trail via content-addressable storage.

**Implementation Notes**
- Use `ipfs-http-client` + `@helia/ipfs` for native IPFS support.
- Add circuit breakers and exponential backoff for gateway resilience.
- Cache fetched content for 24h (Redis) to reduce redundant downloads.

---

## 2. Fair & Unpredictable Leader Election

### Goal
Replace the deterministic `campaignUid % 5 == 0` with a cryptographically secure, unpredictable mechanism that prevents leader capture and griefing.

### Proposed Design: Signature-Based Commit-Reveal + VRF

**Phase 1 (Commit-Reveal)**
- Every oracle that signs a campaign also commits to a random `leaderSeed` (blinded).
- Once 5+ signatures are collected, the leader is derived from:
  ```solidity
  leaderIndex = uint256(keccak256(abi.encodePacked(campaignUid, allSignatures))) % activeOracles.length
  ```
- This is unpredictable until the final signature is published.

**Phase 2 (VRF Upgrade)**
- Integrate Chainlink VRF v2.5 (or native Base VRF if available).
- Oracles request a VRF proof during evaluation.
- The VRF output + campaignUid determines the leader deterministically but unpredictably.

**Benefits**
- No single node can predict or monopolize leadership.
- Resistant to targeted griefing or front-running.
- Gas-efficient (computed off-chain or via lightweight on-chain sort).

**Implementation Notes**
- Add `leaderSeed` and `vrfProof` fields to the gossip message.
- Update `p2p.js` to include VRF request logic (optional dependency).
- Smart contract change: `closeCampaign` accepts an optional `leaderProof` for verification.

---

## 3. Additional v1.1 Deliverables

| Feature                        | Priority | Description |
|--------------------------------|----------|-----------|
| **Payload Size Limits**        | High     | Enforce max 50KB payload to prevent DoS |
| **Score Diversity**            | Medium   | Allow oracles to submit multiple scores (different models) |
| **Dispute Window**             | Medium   | 12-block challenge period before slashing is finalized |
| **Operator Dashboard v2**      | Medium   | Real-time metrics (Prometheus + Grafana) |
| **Stake Withdrawal**           | Low      | `unstake()` function with 7-day timelock |
| **Multi-Model Support**        | Low      | Allow oracles to run different ML models (BGE, Llama, etc.) |

---

## Timeline (Proposed)

- **May 2026** — Real payload fetching (IPFS) + testnet stress test
- **June 2026** — Fair leader election (commit-reveal) + VRF integration
- **July 2026** — v1.1 mainnet launch + operator incentive program

---

**Genesis v1.0.1 is complete.**  
v1.1 will transform VENOM from a controlled testnet into a fully decentralized, production-grade ML oracle network.

