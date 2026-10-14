"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useSendTransaction } from "wagmi";
import { api, amt, ago, bps, short } from "@/components/api";
import { TxLink } from "@/components/shell";
import { Economics, Reconciliation } from "@/components/earnings";
import { useForge } from "@/components/providers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TABS = ["overview", "launches", "accounting", "governance"] as const;
type Tab = (typeof TABS)[number];

export default function TreasuryPage() {
  const { me } = useForge();
  const [tab, setTab] = useState<Tab>("overview");
  const [t, setT] = useState<any | null>(null);
  const [g, setG] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { address, isConnected } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { sendTransactionAsync } = useSendTransaction();
  const load = () =>
    Promise.all([api("/api/finance/treasury"), api("/api/finance/governance")]).then(([a, b]) => {
      setT(a);
      setG(b);
    }, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    const i = setInterval(load, 6000);
    return () => clearInterval(i);
  }, []);
  if (error) return <div className="alert error">{error}</div>;
  if (!t || !g) return <p className="empty">Loading treasury…</p>;

  const isTreasury = me?.wallet && g.roles.splitter && me.wallet.address.toLowerCase() === String(g.roles.splitter.treasuryRecipient).toLowerCase();
  const claimTreasury = async (asset: string) => {
    setMsg(null);
    try {
      if (!isConnected) await connectAsync({ connector: connectors[0]! });
      const p = await api("/api/finance/claims/prepare", { method: "POST", body: { asset, kind: "treasury" } });
      if (address && address.toLowerCase() !== p.from.toLowerCase()) throw new Error(`Connect the treasury recipient wallet ${short(p.from)}.`);
      const hash = await sendTransactionAsync({ to: p.to, data: p.data, value: 0n });
      await api("/api/finance/claims/submitted", { method: "POST", body: { txHash: hash, asset, kind: "treasury" } });
      setMsg(`Treasury claim sent (${short(hash)}).`);
      await load();
    } catch (e) {
      setMsg((e as Error).message.split("\n")[0]!);
    }
  };

  return (
    <>
      <h1>Treasury &amp; revenue</h1>
      <p className="sub">
        Forge protocol revenue under policy v{t.policy.version}: the protocol leg of eligible base fees ({bps(t.policy.protocolShareOfBaseFeeBps)}) is split{" "}
        {t.policy.treasuryParts}:{t.policy.reserveParts} between the Forge treasury and the FINCO reserve ({t.policy.rounding}).
      </p>
      <div className="alert warn" data-testid="treasury-flags">
        PRODUCTION_BLOCKED · FINCO_BURN_ENABLED={String(t.flags.FINCO_BURN_ENABLED)} · FORGE_FEE_POLICY_AUTHORITY_UNPROVEN. Sandbox accounting only; no real funds. The FINCO reserve is a liability with no exit:{" "}
        <b data-testid="reserve-status">{t.reserve.readiness}</b>
      </div>
      <div className="actions" style={{ marginBottom: 14 }}>
        {TABS.map((x) => (
          <button key={x} className={tab === x ? "" : "secondary"} onClick={() => setTab(x)} data-testid={`tab-${x}`}>
            {x[0]!.toUpperCase() + x.slice(1)}
          </button>
        ))}
      </div>
      {msg && <div className="alert">{msg}</div>}

      {tab === "overview" && (
        <div className="grid cols-2" data-testid="treasury-overview">
          {t.accounting.map((a: any) => (
            <section className="panel" key={a.asset.asset}>
              <h2>
                {a.asset.symbol} <Reconciliation status={a.reconciliation} />
              </h2>
              <dl className="kv">
                <dt>Eligible gross base fees</dt>
                <dd>{amt(a.overview.eligibleGrossBaseFees, a.asset)}</dd>
                <dt>Creator entitlement (credited)</dt>
                <dd>{amt(a.overview.creatorEntitlementCredited, a.asset)}</dd>
                <dt>Forge protocol entitlement (credited)</dt>
                <dd>{amt(a.overview.protocolEntitlementCredited, a.asset)}</dd>
                <dt>Treasury allocated</dt>
                <dd data-testid={`treasury-allocated-${a.asset.symbol}`}>{amt(a.overview.treasuryAllocated, a.asset)}</dd>
                <dt>FINCO reserve allocated</dt>
                <dd data-testid={`reserve-allocated-${a.asset.symbol}`}>{amt(a.overview.reserveAllocated, a.asset)}</dd>
                <dt>Treasury paid</dt>
                <dd>{amt(a.overview.treasuryPaid, a.asset)}</dd>
                <dt>Outstanding liabilities</dt>
                <dd>
                  treasury {amt(a.overview.treasuryOutstanding, a.asset)} · reserve {amt(a.overview.reserveOutstanding, a.asset)}
                </dd>
                <dt>Credited, not yet pulled</dt>
                <dd>{amt(a.statements.escrowCreditedNotPulled.indexed, a.asset)}</dd>
                <dt>Non-revenue held</dt>
                <dd>{amt(a.statements.nonRevenueHeld, a.asset)}</dd>
              </dl>
              {isTreasury && a.overview.treasuryOutstanding !== "0" && (
                <div className="actions">
                  <button onClick={() => claimTreasury(a.asset.asset)} data-testid={`claim-treasury-${a.asset.symbol}`}>
                    Claim treasury {a.asset.symbol}
                  </button>
                </div>
              )}
            </section>
          ))}
          <section className="panel">
            <h2>Evidence freshness</h2>
            <dl className="kv">
              <dt>Last indexed block</dt>
              <dd data-testid="last-indexed">{t.indexer.lastIndexedBlock ?? "—"}</dd>
              <dt>Chain head</dt>
              <dd>{t.indexer.headBlock ?? "—"}</dd>
              <dt>Lag</dt>
              <dd>{t.indexer.lagBlocks ?? "—"} blocks</dd>
              <dt>Confirmations</dt>
              <dd>{t.indexer.confirmations}</dd>
              <dt>Splitter</dt>
              <dd>
                <code>{t.splitter ?? "not configured"}</code>
              </dd>
            </dl>
          </section>
        </div>
      )}

      {tab === "launches" && (
        <section className="panel" data-testid="treasury-launches">
          <table className="list">
            <thead>
              <tr>
                <th>Token</th>
                <th>Snapshot policy</th>
                <th>Curve base fee / snipe / tax</th>
                <th>V4 hook base fee / tax</th>
                <th>Protocol credited (exact)</th>
                <th>Treasury / reserve (derived)</th>
                <th>Creator credited (base / tax)</th>
              </tr>
            </thead>
            <tbody>
              {t.launches.map((l: any) => (
                <tr key={l.token}>
                  <td>
                    <a href={`/projects/${l.token}`}>{short(l.token)}</a>
                    <div className="hint">
                      {l.quoteAsset.symbol} · phase {l.phase}
                    </div>
                  </td>
                  <td>
                    <Economics e={l.economics} />
                  </td>
                  <td>
                    {amt(l.bondingCurve.baseFees, l.quoteAsset)} / {amt(l.bondingCurve.snipeTaxComponent, l.quoteAsset)} / {amt(l.bondingCurve.creatorTax, l.quoteAsset)}
                  </td>
                  <td>
                    {amt(l.v4Hook.baseFeesQuote, l.quoteAsset)} / {amt(l.v4Hook.creatorTaxQuote, l.quoteAsset)}
                    {l.v4Hook.baseFeesMemecoin !== "0" && <div className="hint">+ {l.v4Hook.baseFeesMemecoin} memecoin units pending conversion</div>}
                  </td>
                  <td>{amt(l.credited.protocol, l.quoteAsset)}</td>
                  <td>{l.derivedProtocolSplit ? `${amt(l.derivedProtocolSplit.treasury, l.quoteAsset)} / ${amt(l.derivedProtocolSplit.reserve, l.quoteAsset)}` : <span className="hint">not routed to the splitter</span>}</td>
                  <td>
                    {amt(l.credited.creatorBase, l.quoteAsset)} / {amt(l.credited.creatorTax, l.quoteAsset)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">Per-launch protocol credits are attributed from escrow events by depositor; the treasury/reserve split per launch is derived from the immutable 2:1 rule (the contract rounds cumulatively per asset).</p>
        </section>
      )}

      {tab === "accounting" && (
        <div className="grid" data-testid="treasury-accounting">
          {t.accounting.map((a: any) => (
            <section className="panel" key={a.asset.asset}>
              <h2>
                {a.asset.symbol} statements <Reconciliation status={a.reconciliation} />
              </h2>
              <div className="grid cols-2">
                <dl className="kv">
                  <dt>Realised revenue pulled</dt>
                  <dd>{amt(a.statements.realisedRevenuePulled, a.asset)}</dd>
                  <dt>Escrow-credited, not pulled</dt>
                  <dd>
                    {amt(a.statements.escrowCreditedNotPulled.indexed, a.asset)} <Reconciliation status={a.statements.escrowCreditedNotPulled.reconciliation} />
                  </dd>
                  <dt>Launch fees (non-revenue)</dt>
                  <dd>{amt(a.statements.nonRevenue.launchFees, a.asset)}</dd>
                  <dt>Graduation residual (non-revenue)</dt>
                  <dd>{amt(a.statements.nonRevenue.graduationResidual, a.asset)}</dd>
                  <dt>Unattributed direct transfers</dt>
                  <dd>{amt(a.asset.native ? a.statements.nonRevenue.unattributedNative : a.statements.nonRevenue.unattributedToken, a.asset)}</dd>
                  <dt>Third-party escrow credits to splitter key</dt>
                  <dd data-testid={`third-party-${a.asset.symbol}`}>{amt(a.statements.thirdPartyEscrowCreditsToSplitterKey, a.asset)}</dd>
                  <dt>Vest releases to splitter key</dt>
                  <dd>{a.statements.vestReleasesToSplitterKey} base units (project token, ineligible)</dd>
                </dl>
                <dl className="kv">
                  <dt>On-chain balance</dt>
                  <dd>{amt(a.onchainAtCheckpoint?.balance, a.asset)}</dd>
                  <dt>Accounted holdings</dt>
                  <dd>{amt(a.onchainAtCheckpoint?.accounted, a.asset)}</dd>
                  <dt>Surplus / deficit</dt>
                  <dd>
                    {amt(a.onchainAtCheckpoint?.surplus, a.asset)} / {amt(a.onchainAtCheckpoint?.deficit, a.asset)}
                  </dd>
                  <dt>Approved for pulls</dt>
                  <dd>{String(a.onchainAtCheckpoint?.approved ?? "—")}</dd>
                </dl>
              </div>
            </section>
          ))}
          <section className="panel">
            <h2>Allocation history</h2>
            <table className="list" data-testid="allocation-history">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Asset</th>
                  <th>Received</th>
                  <th>Treasury</th>
                  <th>Reserve</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {t.allocations.map((a: any) => (
                  <tr key={a.allocationId}>
                    <td>{a.allocationId}</td>
                    <td>{short(a.asset)}</td>
                    <td>{a.received}</td>
                    <td>{a.toTreasury}</td>
                    <td>{a.toReserve}</td>
                    <td>
                      <TxLink hash={a.txHash} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3 style={{ marginTop: 14 }}>Treasury claims</h3>
            <table className="list">
              <tbody>
                {t.treasuryClaims.map((c: any) => (
                  <tr key={c.txHash + c.amount}>
                    <td>{short(c.asset)}</td>
                    <td>{c.amount}</td>
                    <td>
                      <TxLink hash={c.txHash} />
                    </td>
                    <td className="hint">{ago(c.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3 style={{ marginTop: 14 }}>Exceptions</h3>
            <ul data-testid="exceptions">
              {t.exceptions.length === 0 && <li className="hint">None.</li>}
              {t.exceptions.map((x: any, i: number) => (
                <li key={i}>
                  <span className="chip warn">{x.kind}</span> {x.detail}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {tab === "governance" && (
        <div className="grid cols-2" data-testid="treasury-governance">
          <section className="panel">
            <h2>Current fee policy (new launches)</h2>
            <dl className="kv">
              <dt>Protocol share</dt>
              <dd>{g.currentPolicy.protocolFeeShareBps === null ? "—" : bps(g.currentPolicy.protocolFeeShareBps)}</dd>
              <dt>Buyback share of creator bucket</dt>
              <dd>{g.currentPolicy.buybackBurnBps === null ? "—" : bps(g.currentPolicy.buybackBurnBps)}</dd>
              <dt>Hook fee</dt>
              <dd>{g.currentPolicy.hookFeeBps === null ? "—" : bps(g.currentPolicy.hookFeeBps)}</dd>
              <dt>Protocol recipient</dt>
              <dd>
                <code>{g.currentPolicy.protocolFeeRecipient}</code>{" "}
                {g.currentPolicy.recipientIsForgeSplitter ? <span className="chip ok">Forge splitter</span> : <span className="chip bad">not the splitter</span>}
              </dd>
              <dt>Launch fee</dt>
              <dd>{g.currentPolicy.launchFeeWei} wei (non-revenue)</dd>
            </dl>
            <p className="hint">{g.currentPolicy.source}</p>
          </section>
          <section className="panel">
            <h2>Roles</h2>
            <dl className="kv">
              <dt>Hook owner (fee policy)</dt>
              <dd>
                <code>{g.roles.hookOwner}</code>
              </dd>
              <dt>Factory owner</dt>
              <dd>
                <code>{g.roles.factoryOwner}</code>
              </dd>
              <dt>Fee sweep operator</dt>
              <dd>
                <code>{g.roles.feeSweepOperator}</code>
              </dd>
              <dt>Splitter owner</dt>
              <dd>
                <code>{g.roles.splitter?.owner ?? "—"}</code>
              </dd>
              <dt>Treasury recipient</dt>
              <dd>
                <code data-testid="treasury-recipient">{g.roles.splitter?.treasuryRecipient ?? "—"}</code>
                {g.roles.splitter?.pendingTreasuryRecipient && <div className="hint">pending → {g.roles.splitter.pendingTreasuryRecipient.newRecipient}</div>}
              </dd>
              <dt>FINCO burn</dt>
              <dd data-testid="burn-enabled">{String(g.roles.splitter?.fincoBurnEnabled)} — {g.roles.splitter?.burnReadiness?.status}</dd>
            </dl>
          </section>
          <section className="panel">
            <h2>Warnings</h2>
            <ul data-testid="governance-warnings">
              {g.warnings.map((w: string) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <p className="hint">
              Owner-power exposure: {g.exposure.creatorFeeOverrideProposals} creator-fee override proposal(s), {g.exposure.rescueEvents} rescue event(s). {g.exposure.note}
            </p>
            <h3>Policy change process</h3>
            <ol className="hint">
              {g.policyChangeProcess.map((p: string) => (
                <li key={p}>{p.replace(/^\d+\.\s*/, "")}</li>
              ))}
            </ol>
          </section>
          <section className="panel">
            <h2>Authorization matrix</h2>
            <table className="list" data-testid="authorization-matrix">
              <thead>
                <tr>
                  <th>Function</th>
                  <th>Role</th>
                  <th>Timelock</th>
                  <th>Risk</th>
                </tr>
              </thead>
              <tbody>
                {g.authorizationMatrix.map((m: any) => (
                  <tr key={m.contract + m.fn}>
                    <td>
                      <b>{m.contract}</b>.{m.fn}
                    </td>
                    <td>{m.role}</td>
                    <td>{m.timelock}</td>
                    <td className="hint">{m.risk}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel" style={{ gridColumn: "1 / -1" }}>
            <h2>Policy &amp; recipient history</h2>
            <table className="list">
              <tbody>
                {g.history.map((h: any) => (
                  <tr key={h.txHash + h.event}>
                    <td>{h.contract}</td>
                    <td>{h.event}</td>
                    <td className="hint">
                      <code>{JSON.stringify(h.args)}</code>
                    </td>
                    <td>
                      <TxLink hash={h.txHash} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </>
  );
}
