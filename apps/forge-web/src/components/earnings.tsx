"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useSendTransaction } from "wagmi";
import { api, amt, bps, short, type AssetInfo } from "./api";
import { TxLink } from "./shell";

/* eslint-disable @typescript-eslint/no-explicit-any */

const RECON: Record<string, string> = { RECONCILED: "ok", RECONCILED_WITH_UNRECORDED_SURPLUS: "warn", MISMATCH: "bad", NOT_AVAILABLE: "" };

export function Reconciliation({ status }: { status: string }) {
  return (
    <span className={`chip ${RECON[status] ?? "bad"}`} data-testid="reconciliation">
      <span className="dot" /> {status.replaceAll("_", " ").toLowerCase()}
    </span>
  );
}

export function Economics({ e }: { e: any }) {
  return (
    <div>
      {e.eligible70_20_10 ? (
        <span className="chip ok" data-testid="eligible-70-20-10">
          <span className="dot" /> 70 / 20 / 10 eligible
        </span>
      ) : (
        <span className="chip warn" title={e.reasons.join(" ")} data-testid="not-eligible">
          <span className="dot" /> Not 70/20/10: {e.reasons[0]}
        </span>
      )}
      <div className="hint" style={{ marginTop: 4 }}>
        creator {e.actual.creatorPct}%
        {e.actual.creatorBuybackLockPct > 0 ? ` (cash ${e.actual.creatorCashPct}% + ${e.actual.creatorBuybackLockPct}% buyback-lock)` : ""} · protocol {e.actual.protocolPct}%
        {e.actual.treasuryPct !== null ? ` → treasury ${Number(e.actual.treasuryPct).toFixed(2)}% / reserve ${Number(e.actual.reservePct).toFixed(2)}%` : ""} · creator tax {e.actual.creatorTaxPct}% (separate)
      </div>
    </div>
  );
}

/** Creator earnings & claims workspace (extends the W03 dashboard). */
export function CreatorEarnings() {
  const [d, setD] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const { address, isConnected } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { sendTransactionAsync } = useSendTransaction();
  const load = () => api("/api/finance/creator").then(setD, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  if (error) return <div className="alert warn">Earnings unavailable: {error}</div>;
  if (!d) return <p className="hint">Loading earnings…</p>;

  const prepare = async (asset: string) => {
    setMsg(null);
    try {
      setPreview(await api("/api/finance/claims/prepare", { method: "POST", body: { asset } }));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const send = async () => {
    if (!preview) return;
    if (address && address.toLowerCase() !== preview.from.toLowerCase()) {
      setMsg(`Connected wallet ${short(address)} is not the entitled recipient ${short(preview.from)}. Switch accounts in your wallet.`);
      return;
    }
    setBusy(preview.asset.asset);
    try {
      const hash = await sendTransactionAsync({ to: preview.to, data: preview.data, value: 0n });
      await api("/api/finance/claims/submitted", { method: "POST", body: { txHash: hash, asset: preview.asset.asset } });
      setPreview(null);
      setMsg("Claim sent. Status updates as the transaction confirms and is indexed.");
      await load();
    } catch (e) {
      setMsg(`Claim not sent: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel" style={{ marginTop: 16 }} data-testid="creator-earnings">
      <h2>Earnings &amp; claims</h2>
      <p className="hint">
        Escrow <code>{d.escrow}</code> · indexed to block {d.indexer.lastIndexedBlock ?? "—"} (lag {d.indexer.lagBlocks ?? "?"}). Amounts are shown per asset and never added across assets.
      </p>
      <table className="list" data-testid="earnings-by-asset">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Lifetime credited</th>
            <th>of which creator tax</th>
            <th>Claimed</th>
            <th>Claimable now</th>
            <th>Reconciliation</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {d.perAsset.length === 0 && (
            <tr>
              <td colSpan={7} className="hint">
                No escrow credits yet. Fees reach the escrow when a sweep runs.
              </td>
            </tr>
          )}
          {d.perAsset.map((p: any) => (
            <tr key={p.asset.asset}>
              <td>{p.asset.symbol}</td>
              <td>{amt(p.lifetimeCredited, p.asset)}</td>
              <td>{amt(p.creatorTaxIncluded, p.asset)}</td>
              <td>{amt(p.claimed, p.asset)}</td>
              <td data-testid={`claimable-${p.asset.symbol}`}>{amt(p.claimableNow, p.asset)}</td>
              <td>
                <Reconciliation status={p.reconciliation} />
              </td>
              <td>
                <button className="secondary" disabled={!p.claimableNow || p.claimableNow === "0" || busy !== null} onClick={() => prepare(p.asset.asset)} data-testid={`prepare-claim-${p.asset.symbol}`}>
                  Claim
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {preview && (
        <div className="alert" data-testid="claim-preview">
          <b>Claim preview</b> — {amt(preview.amount, preview.asset as AssetInfo)} from the canonical escrow <code>{short(preview.to)}</code> to <code>{preview.from}</code>.
          <div className="hint">{preview.notice}</div>
          <div className="actions">
            {!isConnected && (
              <button className="secondary" onClick={() => connectAsync({ connector: connectors[0]! }).catch((e: Error) => setMsg(e.message))} data-testid="claim-connect-wallet">
                Connect wallet
              </button>
            )}
            <button onClick={send} disabled={busy !== null || !isConnected} data-testid="send-claim">
              {busy ? "Waiting for wallet…" : "Sign & send from my wallet"}
            </button>
            <button className="secondary" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg && <div className="alert" data-testid="claim-message">{msg}</div>}

      <h3 style={{ marginTop: 18 }}>By launch</h3>
      <table className="list" data-testid="earnings-by-launch">
        <thead>
          <tr>
            <th>Token</th>
            <th>Policy snapshot</th>
            <th>Earned (base / tax)</th>
            <th>Curve / V4 hook</th>
            <th>Accrued, unswept (live)</th>
            <th>Buyback-lock vest</th>
          </tr>
        </thead>
        <tbody>
          {d.launches.map((l: any) => (
            <tr key={l.token}>
              <td>
                <a href={`/projects/${l.token}`}>{short(l.token)}</a>
                <div className="hint">recipient {short(l.creatorFeeRecipient)}{l.isCurrentRecipient ? "" : " (not you anymore)"}</div>
              </td>
              <td>
                <Economics e={l.economics} />
                <div className="hint">
                  frozen: protocol {bps(l.policySnapshot.protocolFeeShareBps)} → {short(l.policySnapshot.protocolFeeRecipient)}
                </div>
              </td>
              <td>
                {amt(l.earnedIndexed.baseFee, l.quoteAsset)} / {amt(l.earnedIndexed.creatorTax, l.quoteAsset)}
                {l.earnedIndexed.unsplit !== "0" && <div className="hint">+ {amt(l.earnedIndexed.unsplit, l.quoteAsset)} unsplit (converted)</div>}
              </td>
              <td>
                {amt(l.earnedIndexed.byOrigin.bondingCurve, l.quoteAsset)} / {amt(l.earnedIndexed.byOrigin.v4Hook, l.quoteAsset)}
              </td>
              <td className="hint">
                {l.accruedUnswept?.baseFee ? (
                  <>
                    est. creator cash {amt(l.accruedUnswept.estCreatorCash, l.quoteAsset)}
                    <br />({l.accruedUnswept.origin}; estimate, not realised)
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className="hint">{l.buybackLock && l.buybackLock.totalLocked !== "0" ? `${l.buybackLock.totalLocked} locked · ${l.buybackLock.releasable} releasable (project token)` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 18 }}>Claim history</h3>
      <table className="list" data-testid="claim-history">
        <tbody>
          {d.claimSubmissions.map((c: any) => (
            <tr key={c.tx_hash}>
              <td>
                <TxLink hash={c.tx_hash} />
              </td>
              <td>
                <span className="badge" data-testid="claim-status">{c.status.state}</span>
              </td>
              <td className="hint">{c.status.recovery ?? ""}</td>
            </tr>
          ))}
          {d.claimHistory.map((c: any) => (
            <tr key={`h-${c.txHash}`}>
              <td>
                <TxLink hash={c.txHash} />
              </td>
              <td>indexed claim</td>
              <td className="hint">
                {c.amount} base units of {short(c.asset)} · block {c.block}
              </td>
            </tr>
          ))}
          {d.claimSubmissions.length + d.claimHistory.length === 0 && (
            <tr>
              <td className="hint">No claims yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      <ul className="hint">
        {d.notes.map((n: string) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </section>
  );
}
