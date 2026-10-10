# W02 Source-Recovery Evidence Directory

Raw evidence for docs/W02-SOURCE-RECOVERY.md. The COMMITTED subset is the
per-contract verification record (`*-src/byte-comparison.json`,
`compilation.json`, `metadata.json`, `std-json-input.json`) plus the
verifier scripts. The bulk artifacts (full API dumps, recompiled/onchain
bytecode dumps, extracted source trees) are local-only and regenerable via
the scripts (Sourcify v2 API + solc 0.8.35).

CI (w02.yml) verifies `contractsV2-deployed/` stays byte-identical to the
`PonsV2LaunchFactory-src` extraction subset committed here.
