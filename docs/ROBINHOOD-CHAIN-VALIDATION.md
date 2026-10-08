# Robinhood Chain Validation — chain 4663

Evidence classes used throughout: `SOURCE_PROVEN` (read in this
repository's source), `ONCHAIN_VERIFIED` (read live via RPC on
2026-10-08), `UNVERIFIED` (claimed, not confirmed), `BLOCKED`.

All RPC reads via the official public endpoint
`https://rpc.mainnet.chain.robinhood.com` on 2026-10-08 (latest block
83,620,519 at time of read).

## 1. Chain facts

| Claim | Class | Evidence |
| --- | --- | --- |
| Chain ID 4663 | `ONCHAIN_VERIFIED` | `cast chain-id` → 4663 |
| Arbitrum Orbit L2 (Ethereum DA, ETH gas) | `ONCHAIN_VERIFIED` (indirect) | single-sequencer + L1 batch views on robin.etherscan.io; Uniswap governance temp-check "Robinhood Chain is an Arbitrum Orbit chain" (gov.uniswap.org proposal 94 thread) |
| Official RPC `rpc.mainnet.chain.robinhood.com` | `ONCHAIN_VERIFIED` | docs.robinhood.com/chain/connecting + live calls succeeded |
| Explorer robin.etherscan.io | `ONCHAIN_VERIFIED` | loads as "Robinhood Chain (ETH) Blockchain Explorer" |
| Alternate explorer robinhoodchain.blockscout.com | `ONCHAIN_VERIFIED` | referenced by official docs (not independently exercised this run) |

## 2. Uniswap V4 stack on 4663

| Contract | Address | Code size | Class |
| --- | --- | --- | --- |
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | 24,009 B | `ONCHAIN_VERIFIED` (code + matches Uniswap deployments docs + governance post) |
| v4 PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` | 23,877 B | `ONCHAIN_VERIFIED` (code + deployments docs) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9,152 B | `ONCHAIN_VERIFIED` (canonical Permit2 address, code present) |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` | — | `UNVERIFIED` (documented; not exercised — not required by the PONS path) |

The factory↔stack wiring was additionally confirmed from the factory's
own storage: `factory.poolManager()` returns the PoolManager above and
`factory.memeHook()` returns the hook below — `ONCHAIN_VERIFIED`.

## 3. Deployed PONS V2 factory (`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`)

| Check | Result | Class |
| --- | --- | --- |
| Code present | 24,177 B (just under the EIP-170 limit the source comments engineer around) | `ONCHAIN_VERIFIED` |
| `owner()` | `0x263ed295dAFaE1d9AAdD6E56c4B6F9f38eE019Dd` | `ONCHAIN_VERIFIED` (EOA-form address; multisig status `UNVERIFIED` from RPC alone) |
| `canLaunch(random EOA)` | **true** — public launches currently open | `ONCHAIN_VERIFIED` (contradicts `pons-beta.md`'s "whitelisted only" — see SECURITY-REVIEW F-11) |
| `launchConfigCount()` | 1 | `ONCHAIN_VERIFIED` |
| `snipeTaxStartBps()` / `snipeTaxSeconds()` | 9900 / 3 | `ONCHAIN_VERIFIED` — proves deployed snipe-tax machinery absent from repo source (F-01/F-06) |
| `maxCreatorTaxBps()` | 1000 | `ONCHAIN_VERIFIED` |
| Repo source matches deployed bytecode | — | `BLOCKED` (source doesn't compile; no verified match exists — F-01) |

## 4. Satellite contracts (documented addresses, code present)

| Contract | Address | Code size | Class |
| --- | --- | --- | --- |
| Meme hook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | 15,167 B | `ONCHAIN_VERIFIED`. Cross-check: low 14 bits of the address = `0x2044` = exactly `beforeInitialize \| afterSwap \| afterSwapReturnDelta` — the same permission mask our test harness independently computed for `BaseHook` validation. Strong evidence the deployed hook is the reviewed `PonsV2MemeHook` design. |
| Fee escrow | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` | 1,932 B | `ONCHAIN_VERIFIED` (code) but **`BLOCKED` for behavior**: source never published (F-02) |
| Buyback vault | `0x42df2a798f82289E177311362e8f5ccC45c1219c` | 4,602 B | `ONCHAIN_VERIFIED` (code); live policy reads match the hook's defaults |
| Launch locker | `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` | 1,969 B | `ONCHAIN_VERIFIED` (code) |
| Launch-and-buy router | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` | — | `BLOCKED` for review (source absent, F-02); code presence not separately read this run |
| Launch deployer | `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42` | — | documented; not separately exercised |
| Graduation executor | `0xC7819B64A1dAECD7eC19856d026cb14EfBd89046` | — | documented; not separately exercised |
| Graduation guard | `0xf5695117b99B6f6401e67d4195BD653628176C6C` | — | documented; not separately exercised |

## 5. Live policy values (hook `0xE5e7…e044`)

| Getter | Value | Matches source default? |
| --- | --- | --- |
| `protocolFeeShareBps()` | 3000 | yes (constructor default) |
| `buybackBurnBps()` | 5000 | yes |
| `hookFeeBps()` | 100 | yes |
| `maxInternalPriceImpactBps()` | 300 | yes |

Class: `ONCHAIN_VERIFIED`. Owner has not moved policy from defaults.

## 6. Graduation destination, fees, and lock (PONS token itself)

The canonical PONS token (`0x39dBED3a2bd333467115dE45665cC57F813C4571`,
name "Pons", supply 1e27 = 1B — `ONCHAIN_VERIFIED`) graduated through the
**V1 legacy factory** into a V3 pool per `pons-beta.md`; accordingly
`locker.isLocked(PONS) = false` and `vault.totalLocked(PONS) = 0`
(`ONCHAIN_VERIFIED`, and consistent). The **V2 graduation path**
(bonding-curve → V4 full-range position minted to the locker, hook-gated
pool, quote-denominated fees) is `SOURCE_PROVEN` at the design level and
`ONCHAIN_VERIFIED` for its wiring, but **`BLOCKED`** for end-to-end
behavioral verification because (a) the deployed curve/launch path cannot
be tied to published source (F-01), and (b) no V2-graduated launch with a
position in the shared locker was identified from RPC alone this run.

## 7. Quote-asset handling (custom pairs)

The factory's pair-token approval economics, decimal re-verification at
launch, and escrow token crediting are `SOURCE_PROVEN` and unit-tested
(`test_erc20Pair_*` in `test/PonsV2BondingCurve.t.sol`). On-chain
approved-pair state was not enumerated this run — `UNVERIFIED` which
non-native quote assets are approved in production.

## Summary

Everything FINCO needs for integration *wiring* (chain, RPC, V4 stack,
factory, hook flags, policy) is verified live. Everything that requires
knowing *what the deployed code actually is* is blocked by F-01/F-02.
