# ops/iam — AWS KMS custody policy examples (placeholders only)

Examples for the W05 custody design (`docs/W05-SIGNER-CUSTODY.md`). Nothing here has been applied to a real AWS account. `<AWS_ACCOUNT_ID>`, `<AWS_REGION>`, `<FORGE_*_KEY_ID>` and the role names are placeholders, and the files contain no credentials.

| File | Purpose |
| --- | --- |
| `kms-create-key.example.json` | `CreateKey` parameters. Use one key per role: `ECC_SECG_P256K1`, `SIGN_VERIFY`, origin `AWS_KMS` (non-exportable; `AWS_CLOUDHSM` through a custom key store is also acceptable), single region. |
| `iam-policy.key-ceremony-create-key.json` | Policy for the ceremony principal. It may create only non-exportable secp256k1 sign-only keys, with MFA, and may never import key material. |
| `kms-key-policy.<role>.json` | Key policy for each role (`authority`, `evidence`, `revenue-attestor`). Only that role's signer principal may call `kms:Sign`, and only with `MessageType=DIGEST` and `ECDSA_SHA_256`. It may also call `GetPublicKey`/`DescribeKey`. Decrypt/encrypt/data keys, grants, imports, replication and `ScheduleKeyDeletion` are denied to everyone. Administration is break-glass, needs MFA, and cannot sign. |
| `iam-role-policy.<role>-signer.json` | Identity policy for each runtime principal. It may call `kms:Sign` and `kms:GetPublicKey` on its one key ARN only, and every other key and every management action is explicitly denied. |
| `cloudtrail-kms-trail.example.json` | Organisation trail with log-file validation that never excludes `kms.amazonaws.com` events, so every `Sign` call is logged. |
| `eventbridge-kms-alerts.example.json` | Pages on any key-management change to a Forge key and on denied `Sign` attempts. |

Notes:
- Configure the app with the **key ARN** (`FORGE_*_KMS_KEY_ID`), not an alias. IAM resources match key ARNs, and the adapter pins the ARN that KMS returns.
- Deleting a key requires changing the key policy first (break-glass, MFA, logged), and then the 7–30-day pending window applies.
- The relayer stays an in-process gas key in W05. It holds no authority, and the server refuses to start if it equals any governance or treasury address. Moving it to KMS follows the same pattern, signing transaction digests, but the app does not support that yet.
