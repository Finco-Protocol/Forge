# WEB-03 — Replit Forge UX → production-gated Next.js frontend: integration evidence

Status: **implemented, locally verified, DRAFT PR open**. `PRODUCTION_READY=false` throughout; no merge, no deploy, no real-chain writes.

## 1. Input validation (untrusted archive handled as data)

| Check | Result |
|---|---|
| ZIP | `FINCO_FORGE_UI_IMPLEMENTATION_HANDOVER_2026-11-04 (copy).zip`, 87,754 bytes |
| SHA-256 | `d617a6fbeb39600d17192639b40cd01814cd18aac8b4ccbc10f4ec758115bb38` — **matches the expected hash exactly** |
| Entries | **26** — matches the expected count; extracted with traversal guards into an isolated temp directory; never executed |
| Manifest | `FILE_MANIFEST.sha256`: **25/25 hashed files match** (the 26th entry is the manifest itself) |
| Secrets scan | pattern scan over all TS/TSX/JSON/MD/CSS/HTML: **no secrets, no private keys, no tokens** |
| Third-party assets | no copied fonts/images/binaries; the only brand asset is the standard GitHub octicon mark (MIT, github/octicons), drawn inline; no lucide-react or other new dependency was added — icons are minimal hand-written inline SVGs in `src/components/forge-ui.tsx` |
| Content classification | Replit Vite **design preview** (`mockup-sandbox`): hash-routed, fixture-driven, no API calls. Treated strictly as a design source; `FincoNonModelExperience` (the FINCO marketing concept shell) was **not** ported |

## 2. Route and surface mapping (Replit hash routes → real Next.js routes)

| Replit preview surface | Forge route | What was done |
|---|---|---|
| `#/forge` overview/hero | `/` | Compact hero block added above the real explorer with production-accurate copy (evidence-first, production gated) and real CTAs (launch wizard, scroll to launches); live indexer block/height line from `GET /api/tokens` |
| `#/forge/explore` | `/` | Explorer re-skinned: Forge toolbar (search, lifecycle-phase filter, NEW grid/list view toggle `button-explore-grid`/`button-explore-list`), real table (list view) and real-data launch cards (grid/mobile view) driven by `GET /api/tokens` with its real loading/error/empty states; zero fixtures |
| `#/forge/project/…` | `/projects/[token]` | Header restyled (canonical-identity eyebrow); all real panels kept: lifecycle (real reserve/progress), contracts & launch, launch parameters, snapshotted fee policy, **Proof of Build** (cryptographic linkage + evidence ledger), indexed events, `VerificationDisclosure` — all original data and testids intact |
| `#/forge/create` | `/launch` | Wizard chrome restyled (Forge heading + panel language); the five-step flow (Connect → Configure → Economics → Authorize → Launch), every handler, validation, server check and testid (`connect-github`, `connect-wallet`, `bind-wallet`, `to-configure`, `authorize`, `sign`, `launch`, …) untouched; NEW `verification-map` panel on step 1 documents the REAL ordered proof flow with the REAL endpoints and the evidence boundary (consent ≠ authority) |
| `#/forge/projects` (My projects) | `/dashboard` | Re-skinned as Forge panels around the real `GET /api/dashboard` data (launched tokens, server-side drafts, GitHub verifications with freshness, on-chain registry ops); signed-out state restyled |
| `#/forge/earnings` | `/dashboard` earnings section | Real `CreatorEarnings` (`GET /api/finance/creator`) untouched — real accrual/claim/conservation figures; no illustrative 70/20/10 block was ported (the real fee-policy surfaces already exist on `/treasury` and token detail) |
| `#/forge/verification` | `/launch` step 1 (+ existing evidence surfaces) | No separate route invented; the ordered proof map + evidence boundary live in the wizard where the real checks happen (`GET /api/auth/github/start`, `GET /api/github/repositories`, `POST /api/github/verify`, `POST /api/wallet/challenge`/`verify`, epoch-scoped binding, eligibility evidence) |
| `#/forge/settings` | `/dashboard` account controls | Real session controls kept (revoke wallet binding with its confirm flow, sign out everywhere); no fake settings invented |
| Treasury | `/treasury` | Header restyled; all real finance/governance surfaces, claim flows and authorization controls untouched |
| FINCO marketing homepage Forge button | **OUT OF SCOPE — recorded boundary** | The FINCO Protocol website homepage is a separate repository/deployment; nothing in this PR changes or claims it |

## 3. Design-language port

- `src/app/forge-ui.css` — the handover's `forge.css` adapted: scoped `forge-*` classes, self-contained variable fallbacks, responsive tiers (900/650/390 px) and `prefers-reduced-motion` handling ported; demo-only constructs (scenario grids, fixture catalogs, hash router, connection-preview mockups) **not** ported.
- `src/app/globals.css` — palette remapped to the Forge design tokens (dark green-black surfaces `#101715/#17201e/#202b28`, border `#35433f`, text `#e6efea`, mint `#a8d8ba`, teal `#57c1b1`, gold `#d1b16d`) with every existing class name and selector preserved, so the shell, banner, chips, tables, alerts and badges adopt the language without structural churn.
- `src/components/forge-ui.tsx` — shared client primitives (ForgeHeading/ForgePanel/ForgeLinkButton/ForgeButton/ForgeStateBanner/ForgeSafety, pills, avatars) + minimal inline SVG icons; presentation only — no data fetching, no state that could shadow server-authoritative status.
- `src/components/shell.tsx` — brand monogram + wordmark and the GitHub mark in the connection chip; all roles/testids (`account-status`, "Primary" navigation, "Skip to main content") preserved.

## 4. Security and financial invariants preserved (verified by diff and by tests)

- GitHub authorization, signed SIWE wallet challenges, binding, repository verification (dual independent admin checks), launch eligibility, EIP-712 consent, economics, ledger/reconciliation, on-chain adapters, CSRF/session handling: **zero changes** — `git diff` touches presentation files only (see §5).
- No demo fixture, synthetic curve, price, volume or market metric was promoted to any authenticated/production route; the explorer renders only `GET /api/tokens` state (its real empty/error/loading states included).
- Verification wording keeps the product's proof classes separate: GitHub ownership ≠ wallet ownership ≠ on-chain binding ≠ launch eligibility; verification is not a code audit, KYC or financial endorsement.
- WalletConnect: the app's connector set is unchanged (`injected()` only); no QR/WalletConnect UI was added, so there is no disabled fake option to maintain — a WalletConnect integration remains an owner-level follow-up (project ID + reviewed SDK), as documented in the WEB-02 handover.
- Freeze flags, release gates, `release/security-findings.json`, workflows, Solidity, lockfile-affecting code: untouched by the UI diff. (One dependency-audit fix rides in this PR — see §6.)

## 5. Changed-file inventory

| File | Change |
|---|---|
| `apps/forge-web/src/app/forge-ui.css` | NEW — ported design language |
| `apps/forge-web/src/components/forge-ui.tsx` | NEW — shared UI primitives + inline icons |
| `apps/forge-web/src/app/globals.css` | palette remap (tokens + banner/alert/badge/link/focus colors) |
| `apps/forge-web/src/app/layout.tsx` | import `forge-ui.css` |
| `apps/forge-web/src/app/page.tsx` | Explore re-skin (hero, toolbar+toggle, real-data cards; all data logic/testids kept) |
| `apps/forge-web/src/app/dashboard/page.tsx` | dashboard re-skin (same data/actions) |
| `apps/forge-web/src/app/launch/page.tsx` | wizard chrome + real verification-map panel (handlers untouched) |
| `apps/forge-web/src/app/projects/[token]/page.tsx` | header/eyebrow restyle (data untouched) |
| `apps/forge-web/src/app/treasury/page.tsx` | header restyle (data untouched) |
| `apps/forge-web/src/components/shell.tsx` | brand + GitHub mark (roles/testids kept) |
| `apps/forge-web/test/e2e/web03-visual.spec.ts` | NEW — visual/responsive regression spec (screenshots) |
| `apps/forge-web/package.json` + `pnpm-lock.yaml` | dependency-audit fix ONLY: `follow-redirects@>=1.16.0 <=1.16.1 → >=1.16.2` override (GHSA-mrwp-f3q8-3g9p) — see §6 |
| `docs/evidence/web03/*` | this evidence + screenshots |

## 6. Baseline repair carried in this PR (documented necessity)

Post-merge main `67aaf910` was red before any WEB-03 work: `pnpm audit --prod --audit-level high` failed on **GHSA-mrwp-f3q8-3g9p** (HIGH, `follow-redirects >=1.16.0 <=1.16.1`, via `wagmi → @wagmi/connectors → @base-org/account → @coinbase/cdp-sdk → axios → follow-redirects`), failing W03's dependency audit and W05's release gate (`CLASS_A_A11`) downstream. Smallest safe fix, same owner-approved house pattern as the two previous advisory fixes: a range-targeted pnpm override to `>=1.16.2` (patch release within axios's own `^1.x` range); `pnpm audit --prod` clean at every severity afterwards; no advisory suppressed, no gate changed.

## 7. Verification performed (local, exact branch HEAD)

- `tsc --noEmit` clean; `eslint .` clean; `next build` (production) green.
- **Full Playwright suite 21/21 PASS** (launch journey, W04 economics, W05 UX/negative, W06 journeys J01–J19/N01–N19/U01–U03 + the new WEB-03 visual spec) — the complete pre-existing regression set passes unmodified on the re-skinned UI.
- Screenshots captured and **visually reviewed** (not just DOM assertions) at 1440×900 and 390×844: `docs/evidence/web03/screenshots/` (home, home grid view, launch wizard incl. the proof map, dashboard, treasury; desktop + mobile). Mobile shows no horizontal overflow (asserted in the spec).
- One real defect found and fixed during the pass: the re-skinned signed-out dashboard heading made the pre-existing `getByText("Creator dashboard")` assertion ambiguous during the signed-out→signed-in hydration flash (strict-mode violation); reworded the signed-out state ("Builder workspace") — the signed-in dashboard keeps the original heading.

## 8. Limitations

- Playwright screenshots are the reviewed visual evidence; no formal WCAG contrast audit was run (as in the source handover).
- The Compose/protocol matrix was not re-run for this UI-only change per the brief; CI on the exact PR HEAD runs the standard workflow set.
- `lucide-react` was intentionally not added; icons are hand-drawn inline SVGs.
- WalletConnect QR remains unavailable pending owner-side project ID/SDK configuration (no UI pretense added).
