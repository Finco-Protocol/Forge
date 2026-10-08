# FORK_PROVENANCE

Provenance record for FINCO Forge's fork of the PONS launchpad contracts.
Written by Workflow 01 (2026-10-08). All facts below were re-verified against
live GitHub immediately before this file was committed.

## Fork relationship

| Fact | Value | Verified via |
| --- | --- | --- |
| Forge repository | `Finco-Protocol/Forge` | `gh api repos/Finco-Protocol/Forge` |
| GitHub-native fork | `true` | REST API `fork` field |
| Parent (upstream) | `ponsdotdev/pons-labs` | REST API `parent` / `source` fields |
| Parent default branch | `main` | REST API |
| Forge `main` SHA | `18da08d944ee4bed41d43dada3f4c29f5f524e57` | `commits/main` |
| Upstream `main` SHA | `18da08d944ee4bed41d43dada3f4c29f5f524e57` (identical) | `commits/main` |
| Ahead / behind | 0 / 0 at fork time | `git rev-list --left-right --count main...upstream/main` |
| Open PRs at intake | none | `gh pr list` |
| Branches at intake | `main` only | REST API |

The upstream commit at `main` is "Update pons-beta.md". Full upstream history
is preserved; this fork adds a single feature branch and never force-pushes
or rewrites upstream history.

## Upstream remote

```
origin    https://github.com/Finco-Protocol/Forge.git
upstream  https://github.com/ponsdotdev/pons-labs.git
```

## What this fork adds (Workflow 01)

Everything added lives outside the production contract trees. No file under
`contractsV1/` or `contractsV2/` has been modified.

```
foundry.toml                      reproducible build harness (3 profiles)
lib+contractsV2/lib/forge-std     test dependency, pinned v1.17.0 (submodule)
test/                             87-test suite + 2 invariants + mocks
.github/workflows/ci.yml          CI: build canary, tests, integrity, analysis
FORK_PROVENANCE.md                this file
docs/                             reports required by the workflow
```

## Known source-integrity findings at intake

The upstream tree as published **does not compile as a whole**. Two defects
are documented with exact compiler output in `docs/BUILD.md`:

1. `PonsV2LaunchFactory.sol` calls `PonsV2BondingCurve.exemptFromSnipeTax`,
   which does not exist in the vendored curve source.
2. `PonsV2LaunchFactory.sol` constructs `LaunchDeployment` with a `salt`
   field that the deployer's struct does not declare; the deployer also
   deploys with plain `new` rather than CREATE2, contradicting the
   deterministic-address behavior of the deployed system.

Both correspond to previously reported upstream issue #10 ("V2 factory
doesn't compile; missing anti-snipe interface in the bonding curve"). A
completed third-party audit (Hackerbane HB-AR-2026.2, draft v0.5) reviewed
the live deployed tree via a Blockscout snapshot precisely because git HEAD
does not build to the live factory. These findings are recorded in
`docs/SECURITY-REVIEW.md` as F-01 (blocking) and F-02.
