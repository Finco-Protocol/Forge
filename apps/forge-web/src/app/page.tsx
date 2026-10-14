"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ago, formatUnits18, short } from "@/components/api";
import { PhaseBadge } from "@/components/shell";

interface TokenRow {
  token: string;
  name: string | null;
  symbol: string | null;
  creator: string;
  phase: string;
  reconcile_error: string | null;
  repo_id: string | null;
  full_name: string | null;
  ineligible_reason: string | null;
  launched_at: string;
  buy_count: number;
  sell_count: number;
  quote_volume: string;
  curve_quote_reserve: string | null;
  graduation_threshold: string;
  liquidity_locked: boolean;
  last_verified_at: string | null;
}

const PHASES = ["", "launched", "bonding_curve_active", "graduation_initiated", "liquidity_seeded", "graduated", "blocked"];

export default function ExplorePage() {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [indexer, setIndexer] = useState<{ last_block: string; updated_at: string } | null>(null);
  const [phase, setPhase] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams();
    if (phase) params.set("phase", phase);
    if (q) params.set("q", q);
    const load = () =>
      api<{ tokens: TokenRow[]; indexer: typeof indexer }>(`/api/tokens?${params}`).then(
        (r) => {
          setTokens(r.tokens);
          setIndexer(r.indexer);
          setError(null);
        },
        (e: Error) => setError(e.message),
      );
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [phase, q]);

  return (
    <>
      <h1>Explore verified builder launches</h1>
      <p className="sub">
        Every token here was launched through the Forge-owned factory with an on-chain eligibility attestation for a GitHub repository. Data is indexed from
        confirmed chain events only{indexer ? ` (indexed to block ${indexer.last_block}, ${ago(indexer.updated_at)})` : ""}.
      </p>
      <div className="panel" style={{ marginBottom: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <input placeholder="Search name, symbol or repository" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 2, minWidth: 220 }} aria-label="Search" />
        <select value={phase} onChange={(e) => setPhase(e.target.value)} style={{ flex: 1, minWidth: 180 }} aria-label="Lifecycle phase">
          {PHASES.map((p) => (
            <option key={p} value={p}>
              {p ? p.replaceAll("_", " ") : "All phases"}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="alert error">{error}</div>}
      {tokens === null ? (
        <p className="empty">Loading…</p>
      ) : tokens.length === 0 ? (
        <div className="panel empty">No confirmed Forge launches yet. <Link href="/launch">Launch the first one →</Link></div>
      ) : (
        <div className="panel table-wrap responsive">
          <table className="list" data-testid="explore-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Verified repository</th>
                <th>Creator</th>
                <th>Launched</th>
                <th>Phase</th>
                <th>Curve progress</th>
                <th>Observed volume</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const progress = t.curve_quote_reserve !== null && t.phase !== "graduated" ? Number((BigInt(t.curve_quote_reserve) * 10000n) / BigInt(t.graduation_threshold)) / 100 : null;
                return (
                  <tr key={t.token}>
                    <td>
                      <Link href={`/projects/${t.token}`}>
                        <b>{t.name ?? short(t.token)}</b> <span className="hint">${t.symbol ?? "?"}</span>
                      </Link>
                    </td>
                    <td>
                      {t.full_name ? <span>{t.full_name}</span> : <span className="hint">repo #{t.repo_id}</span>}
                      <div className="hint">
                        {t.ineligible_reason ? <span style={{ color: "var(--warn)" }}>eligibility revoked ({t.ineligible_reason})</span> : t.last_verified_at ? `verified ${ago(t.last_verified_at)}` : "no service evidence"}
                      </div>
                    </td>
                    <td><code>{short(t.creator)}</code></td>
                    <td>{ago(t.launched_at)}</td>
                    <td><PhaseBadge phase={t.phase} error={t.reconcile_error} /></td>
                    <td style={{ minWidth: 120 }}>
                      {t.phase === "graduated" ? (
                        <span className="hint">V4 pool{t.liquidity_locked ? " · liquidity locked" : ""}</span>
                      ) : progress !== null ? (
                        <>
                          <div className="progress"><div style={{ width: `${Math.min(100, progress)}%` }} /></div>
                          <span className="hint">{progress.toFixed(1)}% of threshold</span>
                        </>
                      ) : (
                        <span className="hint">not observed</span>
                      )}
                    </td>
                    <td>
                      {formatUnits18(t.quote_volume)} ETH
                      <div className="hint">{t.buy_count} buys · {t.sell_count} sells (curve)</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="token-cards" data-testid="explore-cards">
            {tokens.map((t) => (
              <Link key={t.token} href={`/projects/${t.token}`} className="token-card" style={{ color: "inherit", textDecoration: "none" }}>
                <div className="row2">
                  <b>
                    {t.name ?? short(t.token)} <span className="hint">${t.symbol ?? "?"}</span>
                  </b>
                  <PhaseBadge phase={t.phase} error={t.reconcile_error} />
                </div>
                <div className="hint">{t.full_name ?? `repo #${t.repo_id}`} · {t.ineligible_reason ? `eligibility revoked (${t.ineligible_reason})` : t.last_verified_at ? `verified ${ago(t.last_verified_at)}` : "no service evidence"}</div>
                <div className="row2 hint">
                  <span>creator <code>{short(t.creator)}</code></span>
                  <span>{formatUnits18(t.quote_volume)} ETH · {ago(t.launched_at)}</span>
                </div>
              </Link>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            Volume counts bonding-curve trades from on-chain events only. Post-graduation V4 pool volume and prices are not indexed in W03 and are not shown.
          </p>
        </div>
      )}
    </>
  );
}
