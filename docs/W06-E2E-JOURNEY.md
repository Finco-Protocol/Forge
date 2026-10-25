# W06 — Full user-journey browser acceptance

`apps/forge-web/test/e2e/w06-journey.spec.ts` drives a real Chromium against the production build (`next start`), the real route handlers, a real database and the embedded worker/indexer (`global-setup.ts`). Observed results: `docs/evidence/w06/e2e-journey-observed.json`; screenshots: `docs/evidence/w06/screens/` (JPEG, 22 files).

## What is simulated (never production evidence)
| Boundary | Stand-in |
|---|---|
| GitHub | in-process `FakeGithub` (OAuth, App installation, permissions, transfers). `SANDBOX_NOT_EVIDENCE`; B01 stays open. State changes the browser cannot make (transfer a repo, drop admin) use the fake's `/__control/*` endpoints, and the app is then notified with a correctly signed webhook, as GitHub would. |
| Chain | local Anvil with the W02 sandbox contracts **and the sandbox (mock) V4 pool** |
| Wallet | EIP-1193 provider forwarding to Anvil's unlocked dev accounts (variants: wrong chain, bad EIP-712 signature, failing `eth_sendTransaction`) |
| Trading | the application has **no trading screen** by design (W06 adds no trading feature). Buys, the graduation call and fee sweeps are plain transactions; the browser verifies what the application then shows. |

**Step 11 (graduation) is verified on the sandbox pool.** Graduation against the genuine Uniswap V4 PoolManager/PositionManager/Permit2 is evidenced by the `test/v4` suite (`A06`, `A07b`), not by this browser run. This is not claimed otherwise.

## Journey coverage
| # | Step | Result |
|---|---|---|
| 1–2 | connect wallet; GitHub sign-in | PASS (`account-status` @carol-admin) |
| 3–6 | select repository, prove administration, bind creator wallet, validate eligibility | PASS ("administration confirmed by your GitHub token and by the App installation") |
| 7–8 | configure launch; creator and protocol economics shown before signing | PASS |
| 9 | authorize → EIP-712 sign → simulate → launch tx → indexed | PASS (exactly one token) |
| 10 | bonding-curve trade | PASS; a buy that is **pending (unmined)** is not indexed; indexed ~1 s after mining |
| 11 | graduation | PASS on the **sandbox pool** |
| 12–13 | Explore discovery; token detail with Proof of Build | PASS |
| 14–15 | creator earnings; treasury/reserve allocation (burn disabled, reconciled) | PASS |
| 16–17 | prepare claim, send from wallet, canonical indexed claim event | PASS (`CONFIRMED_INDEXED`; claimable → 0) |
| 18–19 | revoke authority (repository transfer) → on-chain binding revoked → new draft refused | PASS (`registry.isActive` false; HTTP 403 `NOT_VERIFIED`) |
| 20 | interrupted operations | failed tx, page replacement and reconnect recovered without a duplicate token (below) |

| Negative case | Observed (asserted by the spec — the specific codes below are checked, not just "some error") |
|---|---|
| Wrong network | "wrong network" chip; switch refused by wallet → `WALLET_REQUEST_DECLINED — … Nothing was signed or sent.` |
| Wrong wallet | "The connected account differs from your bound wallet …"; signing blocked |
| Invalid signature | server refuses with `BAD_SIGNATURE` (asserted); launch step never offered |
| Failed transaction | error shown, no token created |
| Double submission | double click → the injected wallet counted **exactly one** `eth_sendTransaction` (asserted against the wallet-side counter, not inferred from tokens) and exactly one token |
| Stale repository proof | the fake-GitHub permission change and the signed `member.edited` webhook are asserted to succeed first; authorization then refuses with `NOT_ADMIN` (asserted) |
| Indexer lag | pending tx not reflected; reflected after mining + indexing |
| Incomplete claim | prepared but unsent claim → claimable unchanged after refresh |
| Refresh/reconnect | session and wallet binding survive a new page |
| Mobile (390 px), keyboard | no horizontal overflow on 5 routes; the sign-in action is reachable with Tab and operated with Enter |

Not exercised in the browser, covered elsewhere: **expired** signatures/consent and **TTL-expired** repository proofs need clock control the production build does not expose (integration `negative-identity`, `negative-chain`, `w05-s09-adversarial-launch`); a stale proof here means administration changed after verification.

## Usability defects found and fixed (reproduced first)
1. Declining a wallet request displayed `4001 — User rejected the request. Details: … Version: viem@2.57.5`; a reverted transaction displayed `Request Arguments: chain: undefined …`. The wizard now shows the cause (`WALLET_REQUEST_DECLINED`) and drops library plumbing (`src/app/launch/page.tsx`, `describeError`). Verified in `w06-journey.spec.ts` (N01).
No other defect was reproduced; the visual architecture is unchanged.
