"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { api, ago, bps, formatUnits18, short } from "@/components/api";
import { PhaseBadge, TxLink, VerificationDisclosure } from "@/components/shell";
import { useForge } from "@/components/providers";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Detail = any;

const PHASE_ORDER = ["launched", "bonding_curve_active", "graduation_initiated", "liquidity_seeded", "graduated"];

export default function ProjectPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { config } = useForge();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ledger, setLedger] = useState<{ ok: boolean; entries: number; error?: string } | null>(null);
  useEffect(() => {
    const load = () => api(`/api/tokens/${token}`).then(setD, (e: Error) => setError(e.message));
    void load();
    api("/api/proof/ledger").then(setLedger, () => undefined);
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [token]);
  if (error) return <div className="alert error">{error}</div>;
  if (!d) return <p className="empty">Loading…</p>;
  const t = d.token;
  const receipt = d.receipts.filter((r: any) => r.kind === "launch").at(-1)?.receipt;
  const retracted = d.receipts.at(-1)?.kind === "retraction";
  const svc = receipt?.service;
  const progress = t.curve_quote_reserve ? Number((BigInt(t.curve_quote_reserve) * 10000n) / BigInt(t.graduation_threshold)) / 100 : null;
  const phaseIdx = PHASE_ORDER.indexOf(t.phase);
  const repoUrl = d.repository ? `https://github.com/${d.repository.full_name}` : null;
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <h1 data-testid="project-title">
            {t.name} <span className="hint">${t.symbol}</span>
          </h1>
          <p className="sub" style={{ marginBottom: 8 }}>
            {d.repository ? (
              <>
                Built from{" "}
                <a href={repoUrl!} target="_blank" rel="noreferrer">
                  {d.repository.full_name}
                </a>{" "}
                (repo id {t.repo_id})
              </>
            ) : (
              <>Repository id {t.repo_id ?? "unknown"}</>
            )}
          </p>
          <PhaseBadge phase={t.phase} error={t.reconcile_error} />{" "}
          {svc && !retracted ? (
            <span className="chip ok" data-testid="verified-badge">
              <span className="dot" /> Verified admin @{svc.githubLogin} · {new Date(svc.verifiedAt).toLocaleString()}
            </span>
          ) : (
            <span className="chip warn">No service evidence</span>
          )}
          {d.repository?.ineligible_reason && <span className="chip bad">Eligibility since revoked: {d.repository.ineligible_reason}</span>}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <VerificationDisclosure />
      </div>

      {retracted && <div className="alert error">This launch was removed by a chain reorganization; its evidence receipt has been retracted.</div>}

      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <section className="panel">
          <h3>Lifecycle</h3>
          <div className="stepper compact" style={{ marginBottom: 12 }}>
            {PHASE_ORDER.map((p, i) => (
              <div key={p} className={`step ${i < phaseIdx || (i === phaseIdx && p === "graduated") ? "done" : i === phaseIdx ? "active" : ""}`}>
                <b>{p.replaceAll("_", " ")}</b>
              </div>
            ))}
          </div>
          {t.phase !== "graduated" && progress !== null && (
            <>
              <div className="progress"><div style={{ width: `${Math.min(100, progress)}%` }} /></div>
              <p className="hint">
                {formatUnits18(t.curve_quote_reserve)} / {formatUnits18(t.graduation_threshold)} ETH real reserve toward graduation (read on chain at the indexed block)
              </p>
            </>
          )}
          <dl className="kv">
            <dt>On-chain phase</dt>
            <dd>{["NotGraduated", "Swept", "PoolCreated", "Rescued"][t.onchain_phase] ?? "not yet reconciled"} {t.reconciled_at && <span className="hint">(reconciled {ago(t.reconciled_at)})</span>}</dd>
            <dt>Liquidity lock</dt>
            <dd>{t.liquidity_locked ? `V4 position #${t.position_id} held by the launch locker` : "not graduated"}</dd>
            <dt>Curve trades</dt>
            <dd>{t.buy_count} buys · {t.sell_count} sells · {formatUnits18(t.quote_volume)} ETH observed</dd>
          </dl>
        </section>

        <section className="panel">
          <h3>Contracts & launch</h3>
          <dl className="kv">
            <dt>Token</dt>
            <dd><TxLink hash={t.token} kind="address" /></dd>
            <dt>Bonding curve</dt>
            <dd><TxLink hash={t.curve} kind="address" /></dd>
            <dt>Creator wallet</dt>
            <dd><TxLink hash={t.creator} kind="address" /></dd>
            <dt>Factory</dt>
            <dd><TxLink hash={t.factory} kind="address" /></dd>
            <dt>Launch tx</dt>
            <dd><TxLink hash={t.launch_tx} /></dd>
            <dt>Launched</dt>
            <dd>block {t.launch_block} · {new Date(Number(t.launched_at) * 1000).toLocaleString()}</dd>
            <dt>Quote asset</dt>
            <dd>{t.pair_token === "0x0000000000000000000000000000000000000000" ? "ETH (native)" : <code>{t.pair_token}</code>}</dd>
          </dl>
        </section>

        <section className="panel">
          <h3>Launch parameters</h3>
          {d.launchParams ? (
            <dl className="kv">
              <dt>Creator tax</dt>
              <dd>{bps(d.launchParams.params.creatorTaxBps)}</dd>
              <dt>Fee recipient</dt>
              <dd><code>{d.launchParams.params.creatorFeeRecipient}</code></dd>
              <dt>Buyback at launch</dt>
              <dd>{d.launchParams.params.buybackEnabled ? "enabled" : "disabled"}</dd>
              <dt>Snipe-tax exemptions</dt>
              <dd>{d.launchParams.params.snipeTaxExemptions.length ? d.launchParams.params.snipeTaxExemptions.map((a: string) => <div key={a}><code>{a}</code></div>) : "creator only"}</dd>
              <dt>Launch config</dt>
              <dd>#{d.launchParams.params.launchConfigId}</dd>
              <dt>Description</dt>
              <dd>{d.launchParams.params.description || "—"}</dd>
            </dl>
          ) : (
            <p className="hint">Launched outside this app's wizard; parameters are on chain in the launch transaction.</p>
          )}
        </section>

        <section className="panel">
          <h3>Fee policy (snapshotted at launch)</h3>
          {d.feePolicy ? (
            <dl className="kv">
              <dt>Protocol fee share</dt>
              <dd>{bps(d.feePolicy.protocolFeeShareBps)}</dd>
              <dt>Buyback / burn share</dt>
              <dd>{bps(d.feePolicy.buybackBurnBps)}</dd>
              <dt>Hook fee (post-graduation)</dt>
              <dd>{bps(d.feePolicy.hookFeeBps)}</dd>
              <dt>Max internal price impact</dt>
              <dd>{bps(d.feePolicy.maxInternalPriceImpactBps)}</dd>
              <dt>Protocol fee recipient</dt>
              <dd><code>{d.feePolicy.protocolFeeRecipient}</code></dd>
            </dl>
          ) : (
            <p className="hint">Unavailable (RPC read failed).</p>
          )}
          <p className="hint">FORGE_FEE_POLICY_AUTHORITY_UNPROVEN: the fee-policy owner is not yet a proven governance authority. Owner powers F-03/F-04 apply.</p>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 16 }} data-testid="proof-of-build">
        <h2>Proof of Build</h2>
        <p className="hint">
          Linkage: GitHub repository → verified administrator → creator wallet → registry binding → eligibility attestation → creator consent → factory transaction → token.
          {ledger && <> Evidence ledger: {ledger.ok ? `✓ ${ledger.entries} receipts, hash chain and signatures verified` : `✗ ${ledger.error}`}.</>}
        </p>
        {receipt ? (
          <div className="grid cols-2">
            <div>
              <h3><span className="proof-tag proven">CRYPTOGRAPHICALLY PROVEN</span></h3>
              <dl className="kv">
                <dt>Chain / factory</dt>
                <dd>{receipt.chainId} · <code>{short(receipt.factory, 10)}</code></dd>
                <dt>Repo id ↔ creator</dt>
                <dd>LaunchAuthorized(creator, {receipt.githubRepoId}) in tx <code>{short(receipt.onchain.launchAuthorizedLog?.txHash, 10)}</code>, log {receipt.onchain.launchAuthorizedLog?.logIndex}</dd>
                <dt>Registry binding</dt>
                <dd>{receipt.onchain.bindingOp ? <>epoch {receipt.onchain.bindingOp.epoch}, op <code>{short(receipt.onchain.bindingOp.digest, 10)}</code></> : "—"}</dd>
                <dt>Token / curve</dt>
                <dd><code>{short(receipt.token, 10)}</code> / <code>{short(receipt.curve, 10)}</code></dd>
              </dl>
            </div>
            <div>
              <h3><span className="proof-tag attested">ATTESTED BY FORGE GITHUB VERIFICATION</span></h3>
              {svc ? (
                <dl className="kv">
                  <dt>GitHub admin</dt>
                  <dd>@{svc.githubLogin} (id {svc.githubUserId})</dd>
                  <dt>Repository at verification</dt>
                  <dd>{svc.repoFullNameAtVerification} {svc.private ? "(private)" : "(public)"}</dd>
                  <dt>Source commit snapshot</dt>
                  <dd>
                    <code data-testid="commit-sha">{svc.commitSha}</code> on {svc.defaultBranch}
                  </dd>
                  <dt>App installation</dt>
                  <dd>#{svc.installationId}</dd>
                  <dt>Verified at</dt>
                  <dd>{new Date(svc.verifiedAt).toLocaleString()}</dd>
                  <dt>Evidence hash</dt>
                  <dd><code>{short(svc.evidenceHash, 12)}</code></dd>
                  {svc.attestation && (
                    <>
                      <dt>Attestation</dt>
                      <dd><code>{short(svc.attestation.digest, 10)}</code> · epoch {svc.attestation.bindingEpoch}</dd>
                    </>
                  )}
                </dl>
              ) : (
                <p className="hint">No service evidence recorded.</p>
              )}
            </div>
          </div>
        ) : (
          <p className="hint">Receipt pending — issued once the launch is indexed at confirmed depth.</p>
        )}
        {d.repositoryNames.length > 1 && (
          <p className="hint">Repository name history (identity is the numeric id): {d.repositoryNames.map((n: any) => n.full_name).join(" → ")}</p>
        )}
        <div className="alert warn" style={{ marginBottom: 0 }}>{d.disclaimer}</div>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <h3>Indexed events</h3>
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr><th>Block</th><th>Event</th><th>Tx</th></tr>
            </thead>
            <tbody>
              {d.events.map((e: any) => (
                <tr key={`${e.tx_hash}-${e.log_index}`}>
                  <td>{e.block_number}</td>
                  <td>{e.event_name}</td>
                  <td><code>{short(e.tx_hash, 10)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="hint" style={{ marginTop: 12 }}>
        <Link href="/">← Explore</Link> · network {config.network}
      </p>
    </>
  );
}
