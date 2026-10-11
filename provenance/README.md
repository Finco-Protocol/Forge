# Provenance — deploy-time source parity evidence (fail-closed gate)

Committed, reproducible evidence that the `contractsV2-deployed/` tree is
the deployed PONS V2 source (chain 4663). Per contract:

| File | Content |
| --- | --- |
| `evidence.json` | address, chain id, Sourcify matchId + tier, verifiedAt, deploy tx, expected classification |
| `onchain-runtime.hex` | live runtime bytecode fetched from the Robinhood Chain RPC (committed, immutable evidence) |
| `onchain-creation.hex` | live creation bytecode (where Sourcify recorded it) |
| `std-json-input.json` | the Sourcify-verified compilation input (all sources + settings) |
| `metadata.json` / `compilation.json` | solc metadata and settings record |
| `recompiled-runtime.hex` / `verify-result.txt` | CI-generated (not hand-edited) |

Classification tiers:
- `EXACT` — recompiled runtime equals on-chain bytecode including auxdata.
- `IMMUTABLE_PATCHED` — code portion equal after patching the 20-byte
  immutable-address placeholders; auxdata tail differs by toolchain build
  (explicitly tolerated, never silently).

`PonsV2LauncherToken` is classified `SOURCE_PROVEN_ONLY`: it has no fixed
deployment (per-launch CREATE2), so no standalone on-chain instance exists
to compare — it is NOT claimed RUNTIME-PARITY-PROVEN.

Reproduce locally:
    forge build --profile deployed
    bash provenance/verify-parity.sh

Negative fixtures: `scripts/test-parity-gate.sh` (missing/modified
manifest material must FAIL).
