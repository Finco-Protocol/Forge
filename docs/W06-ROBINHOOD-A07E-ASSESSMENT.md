# W06 — Robinhood A07e feasibility assessment

**Conclusion: `A07e_ROBINHOOD_FORK_REVENUE_CLAIMS_LIFECYCLE` stays `NOT_VERIFIED` (gate state `EVIDENCE_INCOMPLETE`).** Steps 7 (revenue attestation + pull), 8 (treasury claim) and 9 (creator claim) **cannot be executed with a genuine, source-proven method** on a local Anvil fork of chain 4663 with the tooling available today. No emulation, test double or code change was introduced, nothing was added to the skip list or removed from it, and no gate was touched. This document records what was measured, why, and the exact remaining acceptance requirement.

Nothing here wrote to chain 4663. All transactions in the experiments below went to a **local Anvil on loopback**; the Robinhood RPC was used only as the read-only fork source (`eth_chainId`, state/block reads).

## 1. Environment facts (this sandbox, 2026-10-15)

| Fact | Value |
|---|---|
| Robinhood RPC reachable from this sandbox? | **Yes**, read-only, through the agent proxy: `eth_chainId` → `0x1237` (4663). (W05 recorded the RPC as blocked from its dev container; that is not true here.) |
| Foundry / Anvil | 1.8.5 (`51a52c59`, built 2026-10-05) |
| Anvil network families (`anvil --help`) | `ethereum, base, optimism, tempo, monad` (+ `--celo`). **No Arbitrum/Orbit family.** |
| Existing fork lifecycle, steps 1–6 + 10 | **Executed here**: `FORGE_FORK_RPC_URL=https://rpc.mainnet.chain.robinhood.com npx vitest run --project v4-fork test/v4-fork/fork-lifecycle.test.ts` → `11 tests: 8 passed, 3 skipped` (steps 7, 8, 9 skipped by `FORK_DEFERRED_STEPS = [7,8,9]`), 12.2 s. This re-confirms A07b in this environment; it does not change A07e. |
| Existing diagnostic | `test/v4-fork/anvil-arbsys-investigation.test.ts` re-run: passes, output `W05_ANVIL_ARBSYS_PROBE` reproduced below. |

## 2. Why steps 7–9 matter and what they need

Step 7: the attestor signs `EligibleRevenue{…, evidenceBlock, evidenceBlockHash}`; `ForgeProtocolRevenueSplitter.authorizeEligibleRevenue` accepts it only if `_evidenceView(evidenceBlock)` returns a non-zero hash equal to the signed one. On Arbitrum Orbit chains `_evidenceView` uses the **ArbSys precompile** at `0x64`:

```solidity
(bool ok, bytes memory ret) = ARB_SYS.staticcall(abi.encodeWithSignature("arbBlockNumber()"));
if (ok && ret.length == 32) {
    head = abi.decode(ret, (uint256));
    if (n < head && head - n <= MAX_EVIDENCE_AGE_BLOCKS) {
        (bool ok2, bytes memory ret2) = ARB_SYS.staticcall(abi.encodeWithSignature("arbBlockHash(uint256)", uint256(n)));
        if (ok2 && ret2.length == 32) h = abi.decode(ret2, (bytes32));   // else h stays 0
    }
} else { head = block.number; h = blockhash(n); }
```
If the hash is `0`, `authorizeEligibleRevenue` reverts `StaleEvidence` (it also requires `evidenceBlockHash != 0`). Step 8 (`claimTreasury`) needs a treasury liability, which exists only after a **pull**, which needs a **ceiling**, which is step 7. Step 9 (creator `escrow.claim()`) does not touch ArbSys.

## 3. Measurements (all on a local Anvil fork of 4663, read-only toward the RPC)

Commands are reproducible: `anvil --port <p> --fork-url https://rpc.mainnet.chain.robinhood.com --silent`, then JSON-RPC against `localhost:<p>`.

| Probe | Result | Meaning |
|---|---|---|
| `eth_chainId` | `0x1237` | fork keeps chain id 4663 |
| `eth_getCode(0x64)` | `0xfe` | ArbSys is an **Anvil-internal precompile emulation** on the fork (also with `--chain-id 31337`) |
| `eth_call 0x64 arbBlockNumber()` (`0xa3b1b31d`) | answers; returns the fork's **L2** head, and after `anvil_mine 5` returns head+5 | the head half of `_evidenceView` works |
| `eth_call 0x64 arbBlockHash(uint256)` (`0x2b407a82`, selector confirmed with `cast sig`) for fork-origin blocks (N-1, N-100) and for locally mined blocks | **`-32003 EVM error PrecompileError`** every time | the hash half is **not implemented** by this Anvil |
| `eth_call 0x64 arbChainID()` / `arbOSVersion()` | `PrecompileError` | emulation is minimal (`arbBlockNumber` only) |
| In-EVM probe — bytecode that `STATICCALL`s `0x64.arbBlockHash(N-1)` and returns `(ok, ret)` | `ok = 0` (first word `0x00…00`) | from inside a contract the call **returns false** (does not halt) — exactly the `ok2 == false → h = 0` branch of `_evidenceView` |
| `anvil_setCode(0x64, <code returning 42>)` then `arbBlockNumber()` | `setCode` returns `null` but the call **still returns the real L2 head**, `eth_getCode` shows the new code | the precompile wins; a code double **cannot replace** it (confirms the W05 observation) |
| EVM `block.number` inside `eth_call` | `0x18fbefa` = parent-chain number ≈ 26.2 M vs RPC `0x5512…` ≈ 89.2 M | confirms finding W05-05: opcode-based evidence cannot match RPC evidence, so the ArbSys path is mandatory |

`W05_ANVIL_ARBSYS_PROBE` (existing diagnostic, abridged): `codeAt0x64 = 0xfe`, `callArbBlockNumber = <rpc head>`, `evmBlockNumberViaCall = 0x018fbefa`, `callAfterSetCode = <rpc head>` (setCode ineffective) for both `fork_remote_chain_id` and `fork_chain_id_31337`.

### Derived result (source + measurement; not executed end-to-end)
On this fork `_evidenceView` returns `h = 0` for every evidence block ⇒ `authorizeEligibleRevenue` can only revert `StaleEvidence` ⇒ no ceiling ⇒ no pull ⇒ no treasury liability ⇒ step 8 impossible. I did **not** run step 7 through the splitter on the fork: the suite's skip list is a single constant I am not permitted to alter, and forcing the call would only reproduce the revert predicted by the measured `ok=0`.

## 4. Options considered

| Option | Genuine? | Safe? | Verdict |
|---|---|---|---|
| Run step 7 as-is on the Anvil fork | — | yes | Fails: `StaleEvidence` (§3) |
| `anvil_setCode` an ArbSys test double at `0x64` | **No** (labelled emulation, not target-chain behaviour) | yes | **Impossible** (precompile wins) and would not count even if possible |
| Fork with `--chain-id 31337` to let setCode work | No | yes | Probe shows the same precompile, same `PrecompileError` |
| Change the splitter (e.g. accept the fallback path, or inject a hash source) | No — contract-logic change, forbidden by the W06 freeze | — | Rejected |
| Make the splitter use the EVM-opcode fallback (`block.number`/`blockhash`) | No | yes | Cannot disable the precompile; and the fallback uses the parent-chain number, which the attestor's RPC evidence never matches (W05-05) |
| Attest from EVM-numbering evidence on the fork | No — tests a different rule than production's | yes | Would verify a code path production does not use |
| Newer Anvil/Foundry with a complete ArbSys emulation | Potentially (must be source-proven) | yes | **Not available**: installed 1.8.5 implements `arbBlockNumber` only. Re-probe on upgrade |
| Real Arbitrum Nitro dev node (e.g. `nitro-testnode`) forked/synced to the 4663 ArbOS version | Closest to genuine | Needs Docker and an ArbOS-4663-compatible image; **no Docker in this sandbox** | External dependency; cannot be done here |
| Step 9 alone (creator `escrow.claim()`) on the fork | Yes — no ArbSys involvement | yes | Executable, but A07e is defined as 7–9 together; executing 9 alone does **not** verify A07e and the skip list/manifest would have to be split by the release-gate owner. Not done here |
| Run steps 7–9 against the live chain | — | **No** (mainnet writes forbidden; B09 is Class B) | Out of scope by design |

## 5. Exact remaining acceptance requirement for A07e

A07e may become `VERIFIED` only when **all** hold:

1. **A faithful ArbSys on the fork**, source-proven: a Foundry/Anvil release (or Nitro dev node) for which, on a 4663-ID fork, the in-EVM probe `STATICCALL 0x64.arbBlockHash(n)` returns `ok = 1` and a hash **equal to the RPC hash of block n** both for fork-origin blocks and for blocks mined locally after the fork (the attestor reads those hashes from the local node's RPC), within the 256-block window, and `arbBlockNumber()` continues to equal the local L2 head. Acceptance probe (copy of §3): `ok == 1` and `ret == eth_getBlockByNumber(n).hash`.
2. The three skipped steps are un-deferred **in the same change** as the evidence: remove `7, 8, 9` from `test/v4/fork-deferred.ts` (the drift test in `unit/w05-release-gate.test.ts` then forces the matching `release/readiness-items.json` update), and `pnpm test:v4:fork` shows `11 passed, 0 skipped` in CI (`FORGE_FORK_RPC_URL` set).
3. The splitter's ArbSys branch is exercised by that run through `authorizeEligibleRevenue` with the **production attestor path** (`finance/attestor.ts`, evidence from the local node's RPC), then `pullRevenue`, `claimTreasury`, creator `claim()`; the run's ledger is `RECONCILED`.
4. No contract, fee-policy or gate change is made to get there.

Until then the honest state is: A07a, A07b (steps 1–6, 10) and A07c verified; **A07e NOT_VERIFIED**; B09 (production write acceptance) NOT PERFORMED.

## 6. Reproduce

```
export PATH=/tmp/fdry:$PATH                       # Foundry 1.8.5
cd apps/forge-web
FORGE_FORK_RPC_URL=https://rpc.mainnet.chain.robinhood.com npx vitest run --project v4-fork test/v4-fork/anvil-arbsys-investigation.test.ts
FORGE_FORK_RPC_URL=https://rpc.mainnet.chain.robinhood.com npx vitest run --project v4-fork test/v4-fork/fork-lifecycle.test.ts   # 8 passed | 3 skipped
# in-EVM arbBlockHash probe on a fork (local Anvil, read-only toward the RPC):
anvil --port 18603 --fork-url https://rpc.mainnet.chain.robinhood.com --silent &
N=$(( $(cast block-number --rpc-url http://127.0.0.1:18603) - 1 ))
CODE="0x7f2b407a8200000000000000000000000000000000000000000000000000000000600052""7f$(printf '%064x' $N)""600452602060406024600060645afa60005260606000f3"
curl -s localhost:18603 -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"data\":\"$CODE\"},\"latest\"]}"
# today: first 32-byte word is 0 (ok=false).  Required: 1, followed by the RPC block hash.
```
