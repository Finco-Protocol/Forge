/**
 * Token projection, rebuilt deterministically from canonical chain events
 * only. Replaying the same events always yields the same row; deleting
 * orphaned events and rebuilding is the whole reorg story.
 */
import { getAddress } from "viem";
import type { ForgeAddresses } from "../config";
import type { Queryable } from "../db";

export type LifecyclePhase =
  | "launched"
  | "bonding_curve_active"
  | "graduation_initiated"
  | "liquidity_seeded"
  | "graduated"
  | "blocked"
  | "unknown";

/** GraduationPhase enum (ILaunchpadV2): 0 NotGraduated, 1 Swept, 2 PoolCreated, 3 Rescued. */
export function projectionPhaseMatchesOnchain(phase: string, onchain: number): boolean {
  switch (onchain) {
    case 0:
      return phase === "launched" || phase === "bonding_curve_active";
    case 1:
      return phase === "graduation_initiated";
    case 2:
      return phase === "liquidity_seeded" || phase === "graduated";
    case 3:
      return phase === "blocked";
    default:
      return false;
  }
}

interface EventRow {
  block_number: string;
  block_hash: string;
  tx_hash: string;
  log_index: number;
  address: string;
  event_name: string;
  args: Record<string, string>;
  block_timestamp: string;
}

export async function rebuildTokenProjection(q: Queryable, chainId: number, a: ForgeAddresses, tokenAddr: string): Promise<void> {
  const token = getAddress(tokenAddr);
  const launch = (
    await q.query<EventRow>(
      "SELECT * FROM chain_events WHERE chain_id = $1 AND address = $2 AND event_name = 'TokenLaunched' AND args->>'token' = $3 ORDER BY block_number, log_index LIMIT 1",
      [chainId, a.factory, token],
    )
  ).rows[0];
  if (!launch) {
    await q.query("DELETE FROM tokens WHERE token = $1", [token]);
    return;
  }
  const curve = getAddress(launch.args.curve!);
  // The repo id is proven by the authorizer's LaunchAuthorized event in the SAME transaction.
  const auth = (
    await q.query<EventRow>(
      "SELECT * FROM chain_events WHERE chain_id = $1 AND address = $2 AND event_name = 'LaunchAuthorized' AND tx_hash = $3 AND block_hash = $4 ORDER BY log_index LIMIT 1",
      [chainId, a.authorizer, launch.tx_hash, launch.block_hash],
    )
  ).rows[0];
  const events = (
    await q.query<EventRow>(
      `SELECT * FROM chain_events
        WHERE chain_id = $1 AND (address = $2 OR ((address = $3 OR address = $4) AND args->>'token' = $5))
        ORDER BY block_number, log_index`,
      [chainId, curve, a.factory, a.locker, token],
    )
  ).rows;
  let buys = 0;
  let sells = 0;
  let volume = 0n;
  let swept = false;
  let pool = false;
  let locked = false;
  let rescued = false;
  let positionId: string | null = null;
  for (const e of events) {
    switch (e.event_name) {
      case "CurveBuy":
        buys++;
        volume += BigInt(e.args.quoteIn ?? "0");
        break;
      case "CurveSell":
        sells++;
        volume += BigInt(e.args.quoteOut ?? "0");
        break;
      case "LaunchSwept":
      case "LaunchForceSwept":
      case "CurveCompleted":
        swept = true;
        break;
      case "PoolGraduated":
        pool = true;
        positionId = e.args.positionId ?? positionId;
        break;
      case "PositionLocked":
        locked = true;
        positionId = e.args.tokenId ?? positionId;
        break;
      case "LaunchGraduationRescued":
        rescued = true;
        break;
    }
  }
  const phase = rescued
    ? "blocked"
    : pool
      ? locked
        ? "graduated"
        : "liquidity_seeded"
      : swept
        ? "graduation_initiated"
        : buys + sells > 0
          ? "bonding_curve_active"
          : "launched";
  await q.query(
    `INSERT INTO tokens(token, chain_id, factory, curve, creator, pair_token, launch_config_id, graduation_threshold, github_repo_id,
       launch_tx, launch_block, launched_at, phase, buy_count, sell_count, quote_volume, position_id, liquidity_locked)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (token) DO UPDATE SET curve = EXCLUDED.curve, creator = EXCLUDED.creator, github_repo_id = EXCLUDED.github_repo_id,
       launch_tx = EXCLUDED.launch_tx, launch_block = EXCLUDED.launch_block, launched_at = EXCLUDED.launched_at, phase = EXCLUDED.phase,
       buy_count = EXCLUDED.buy_count, sell_count = EXCLUDED.sell_count, quote_volume = EXCLUDED.quote_volume,
       position_id = EXCLUDED.position_id, liquidity_locked = EXCLUDED.liquidity_locked, updated_at = now()`,
    [
      token,
      chainId,
      a.factory,
      curve,
      getAddress(launch.args.deployer!),
      getAddress(launch.args.pairToken!),
      launch.args.launchConfigId,
      launch.args.graduationThreshold,
      auth?.args.githubRepoId ?? null,
      launch.tx_hash,
      launch.block_number,
      launch.block_timestamp,
      phase,
      buys,
      sells,
      volume.toString(),
      positionId,
      locked,
    ],
  );
}
