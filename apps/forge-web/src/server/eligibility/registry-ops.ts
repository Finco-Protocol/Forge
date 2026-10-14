/**
 * Authority-signed ForgeBindingRegistry operations: build against the LIVE
 * head (Correction B op-chain), sign through the policy layer, persist,
 * relay, and wait for confirmed acceptance (OperationApplied with our
 * digest). Conflicting concurrent requests are excluded twice: an in-process
 * per-repo mutex, and the durable unique (repo, opNonce, parent) slot.
 */
import { decodeEventLog, getAddress, type Address, type Hex } from "viem";
import { forgeBindingRegistryAbi } from "@/shared/abis.generated";
import { MAX_OP_VALIDITY_SECONDS, type BindingOp } from "@/shared/forge-typed-data";
import type { AppContext } from "../context";
import { readRegistryState, type RegistryState } from "../chain/forge";
import { ForgeError } from "../errors";
import { isUniqueViolation } from "../db";
import { audit } from "../audit";

const locks = new Map<string, Promise<unknown>>();

/** Serializes registry work per repository inside this process. */
export async function withRepoLock<T>(repoId: bigint, fn: () => Promise<T>): Promise<T> {
  const key = repoId.toString();
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export interface AppliedOp {
  digest: Hex;
  txHash: Hex;
  blockNumber: bigint;
  bindingEpoch: bigint;
  opSequence: bigint;
}

export async function applyRegistryOp(
  ctx: AppContext,
  params: { repoId: bigint; creator: Address; repoFullName: string; revoke: boolean; verificationId?: string; reason: string; requestedBy: string },
  state?: RegistryState,
): Promise<AppliedOp> {
  const { cfg, client, relayer, db } = ctx;
  const s = state ?? (await readRegistryState(client, cfg.addresses, params.repoId));
  // Settle ops whose deadline passed while signed/submitted (crash, dropped tx, RPC
  // timeout): confirmed if the registry consumed the digest, otherwise abandoned —
  // after its deadline it can never execute.
  const stale = await db.query<{ id: string; op_digest: string }>(
    "SELECT id::text, op_digest FROM registry_ops WHERE repo_id = $1 AND status IN ('signed','submitted') AND op_deadline < $2",
    [params.repoId.toString(), s.blockTimestamp.toString()],
  );
  for (const op of stale.rows) {
    const used = await client.readContract({ address: cfg.addresses.registry, abi: forgeBindingRegistryAbi, functionName: "usedOps", args: [op.op_digest as Hex] });
    await db.query("UPDATE registry_ops SET status = $2, updated_at = now() WHERE id = $1", [op.id, used ? "confirmed" : "abandoned"]);
  }
  // A still-pending op for this repo (signed, deadline not passed) blocks a conflicting one.
  const pending = await db.query<{ op_digest: string }>(
    "SELECT op_digest FROM registry_ops WHERE repo_id = $1 AND status IN ('signed','submitted') AND op_deadline >= $2",
    [params.repoId.toString(), s.blockTimestamp.toString()],
  );
  if (pending.rows.length) throw new ForgeError("CONCURRENT_OPERATION", "Another registry operation for this repository is in flight; retry shortly.", 409);

  const op: BindingOp = {
    githubRepoId: params.repoId,
    creator: getAddress(params.creator),
    bindingExpiresAt: params.revoke ? 0n : s.blockTimestamp + BigInt(cfg.policy.bindingHorizonSeconds),
    opDeadline: s.blockTimestamp + BigInt(Math.min(5 * 60, MAX_OP_VALIDITY_SECONDS)),
    opNonce: s.opSequence + 1n,
    parentOpDigest: s.headOpDigest,
    repoFullName: params.repoFullName,
    revoke: params.revoke,
  };
  const { digest, signature } = await ctx.authority.signBindingOp(op, {
    verificationId: params.verificationId,
    reason: params.reason,
    requestedBy: params.requestedBy,
  });
  let opId: string;
  try {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO registry_ops(repo_id, op_nonce, parent_digest, op_digest, creator, revoke, repo_full_name, binding_expires_at, op_deadline,
         verification_id, reason, signature, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'signed')
       ON CONFLICT (op_digest) DO UPDATE SET status = 'signed', error = NULL, tx_hash = NULL, signature = EXCLUDED.signature, updated_at = now()
         WHERE registry_ops.status IN ('failed', 'abandoned')
       RETURNING id::text`,
      [
        op.githubRepoId.toString(),
        op.opNonce.toString(),
        op.parentOpDigest,
        digest,
        op.creator,
        op.revoke,
        op.repoFullName,
        op.bindingExpiresAt.toString(),
        op.opDeadline.toString(),
        params.verificationId ?? null,
        params.reason,
        signature,
      ],
    );
    // An identical op that never landed (failed/abandoned) is revived; a LIVE identical op is a conflict.
    if (!ins.rows[0]) throw new ForgeError("CONCURRENT_OPERATION", "An identical registry operation is already in flight.", 409);
    opId = ins.rows[0].id;
  } catch (e) {
    if (isUniqueViolation(e)) throw new ForgeError("CONCURRENT_OPERATION", "A conflicting registry operation was issued concurrently.", 409);
    throw e;
  }

  let txHash: Hex;
  try {
    const sim = await client.simulateContract({
      account: relayer.account,
      address: cfg.addresses.registry,
      abi: forgeBindingRegistryAbi,
      functionName: "applyBindingOp",
      args: [op, signature],
    });
    txHash = await relayer.writeContract(sim.request);
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    await db.query("UPDATE registry_ops SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [opId, msg]);
    throw new ForgeError("REGISTRY_OP_REJECTED", `Registry rejected the operation: ${msg}`, 409);
  }
  await db.query("UPDATE registry_ops SET status = 'submitted', tx_hash = $2, updated_at = now() WHERE id = $1", [opId, txHash]);
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, confirmations: Math.max(1, cfg.confirmations) });
  if (receipt.status !== "success") {
    await db.query("UPDATE registry_ops SET status = 'failed', error = 'reverted', updated_at = now() WHERE id = $1", [opId]);
    throw new ForgeError("REGISTRY_OP_REVERTED", "Registry operation reverted.", 409);
  }
  let applied: { epoch: bigint; seq: bigint } | null = null;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(cfg.addresses.registry)) continue;
    try {
      const ev = decodeEventLog({ abi: forgeBindingRegistryAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "OperationApplied" && ev.args.opDigest === digest) applied = { epoch: ev.args.bindingEpoch, seq: ev.args.opSequence };
    } catch {
      /* other event */
    }
  }
  if (!applied) {
    await db.query("UPDATE registry_ops SET status = 'failed', error = 'no OperationApplied', updated_at = now() WHERE id = $1", [opId]);
    throw new ForgeError("REGISTRY_OP_UNCONFIRMED", "Registry acceptance event not found.", 502);
  }
  await db.query(
    "UPDATE registry_ops SET status = 'confirmed', block_number = $2, binding_epoch = $3, updated_at = now() WHERE id = $1",
    [opId, receipt.blockNumber.toString(), applied.epoch.toString()],
  );
  await audit(db, params.requestedBy, op.revoke ? "registry_revoke_confirmed" : "registry_bind_confirmed", `repo:${op.githubRepoId}`, {
    digest,
    txHash,
    creator: op.creator,
    epoch: applied.epoch,
    reason: params.reason,
  });
  return { digest, txHash, blockNumber: receipt.blockNumber, bindingEpoch: applied.epoch, opSequence: applied.seq };
}

/** Revoke the active on-chain binding of `repoId` if (and only if) it names `creator` (or any creator when omitted). */
export async function revokeOnChain(ctx: AppContext, repoId: bigint, reason: string, creator?: Address): Promise<AppliedOp | null> {
  return withRepoLock(repoId, async () => {
    const s = await readRegistryState(ctx.client, ctx.cfg.addresses, repoId);
    if (!s.binding.exists || s.binding.revokedAt !== 0n) return null;
    if (creator && getAddress(s.binding.creator) !== getAddress(creator)) return null;
    return applyRegistryOp(
      ctx,
      { repoId, creator: s.binding.creator, repoFullName: s.binding.repoFullName, revoke: true, reason, requestedBy: "forge:revocation" },
      s,
    );
  });
}
