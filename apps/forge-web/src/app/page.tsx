"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ago, formatUnits18, short } from "@/components/api";
import { PhaseBadge } from "@/components/shell";
import { ArrowRight, ArrowUpRight, Eye, ForgeButton, ForgeHeading, ForgeLinkButton, ForgeSafety, GitHubMark, Grid2X2, List, Plus, Search, Wallet } from "@/components/forge-ui";

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
  const [view, setView] = useState<"list" | "grid">("list");
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

  const repoLine = (t: TokenRow) => (
    <>
      {t.full_name ?? `repo #${t.repo_id ?? "unknown"}`}
      {t.ineligible_reason ? (
        <span style={{ color: "var(--warn)" }}> · eligibility revoked ({t.ineligible_reason})</span>
      ) : t.last_verified_at ? (
        ` · verified ${ago(t.last_verified_at)}`
      ) : (
        " · no service evidence"
      )}
    </>
  );

  return (
    <>
      <ForgeSafety />
      <section className="forge-hero" data-testid="forge-hero">
        <div className="forge-eyebrow">FINCO FORGE · EVIDENCE-FIRST LAUNCHPAD</div>
        <h1>
          Build in public.
          <br />
          <em>Prove the source.</em>
        </h1>
        <p>
          A GitHub-native launchpad: repository identity and eligibility are made legible before any launch workflow — without pretending a repository proves code quality or safety.
        </p>
        <div className="forge-actions">
          <ForgeLinkButton href="/launch" primary>
            Launch a project <ArrowRight size={15} />
          </ForgeLinkButton>
          <ForgeButton onClick={() => document.getElementById("forge-explore-list")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            Browse launches <ArrowUpRight size={14} />
          </ForgeButton>
        </div>
        <div className="forge-kicker" style={{ marginTop: 20 }}>
          {indexer ? `INDEXED TO BLOCK ${indexer.last_block} · ${ago(indexer.updated_at).toUpperCase()}` : "CONNECTING TO THE FORGE INDEXER…"}
        </div>
      </section>

      <div style={{ marginTop: 22 }}>
        <ForgeHeading eyebrow="DISCOVERY · CONFIRMED CHAIN EVENTS ONLY" title="Explore verified builder launches">
          Every token here was launched through the Forge-owned factory with an on-chain eligibility attestation for a GitHub repository. Data is indexed from confirmed chain events only — no synthetic projects, prices or metrics are shown.
        </ForgeHeading>
      </div>

      <div className="forge-toolbar" role="search">
        <label className="forge-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search name, symbol or repository</span>
          <input className="forge-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, symbol or repository…" aria-label="Search" />
        </label>
        <label>
          <span className="sr-only">Lifecycle phase</span>
          <select className="forge-select" value={phase} onChange={(e) => setPhase(e.target.value)} aria-label="Lifecycle phase">
            {PHASES.map((p) => (
              <option key={p} value={p}>
                {p ? p.replaceAll("_", " ") : "All phases"}
              </option>
            ))}
          </select>
        </label>
        <div className="forge-toggle" role="group" aria-label="Choose layout">
          <button type="button" aria-label="List view" aria-pressed={view === "list"} data-testid="button-explore-list" onClick={() => setView("list")}>
            <List size={16} />
          </button>
          <button type="button" aria-label="Grid view" aria-pressed={view === "grid"} data-testid="button-explore-grid" onClick={() => setView("grid")}>
            <Grid2X2 size={16} />
          </button>
        </div>
      </div>

      {error && (
        <div className="alert error" role="alert" data-testid="explore-error">
          {error}
        </div>
      )}
      {tokens === null ? (
        <p className="empty" data-testid="explore-loading">
          Loading launches from the Forge indexer…
        </p>
      ) : tokens.length === 0 ? (
        <div className="panel empty">
          No confirmed Forge launches yet. <Link href="/launch">Launch the first one →</Link>
        </div>
      ) : (
        <div id="forge-explore-list" className={view === "grid" ? "forge-view-grid" : undefined}>
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
                        <span>{repoLine(t)}</span>
                      </td>
                      <td>
                        <code>{short(t.creator)}</code>
                      </td>
                      <td>{ago(t.launched_at)}</td>
                      <td>
                        <PhaseBadge phase={t.phase} error={t.reconcile_error} />
                      </td>
                      <td style={{ minWidth: 120 }}>
                        {t.phase === "graduated" ? (
                          <span className="hint">V4 pool{t.liquidity_locked ? " · liquidity locked" : ""}</span>
                        ) : progress !== null ? (
                          <>
                            <div className="progress">
                              <div style={{ width: `${Math.min(100, progress)}%` }} />
                            </div>
                            <span className="hint">{progress.toFixed(1)}% of threshold</span>
                          </>
                        ) : (
                          <span className="hint">not observed</span>
                        )}
                      </td>
                      <td>
                        {formatUnits18(t.quote_volume)} ETH
                        <div className="hint">
                          {t.buy_count} buys · {t.sell_count} sells (curve)
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="token-cards" data-testid="explore-cards">
              {tokens.map((t) => {
                const progress = t.curve_quote_reserve !== null && t.phase !== "graduated" ? Number((BigInt(t.curve_quote_reserve) * 10000n) / BigInt(t.graduation_threshold)) / 100 : null;
                return (
                  <Link key={t.token} href={`/projects/${t.token}`} className="forge-launch-card" style={{ color: "inherit" }}>
                    <div className="forge-card-head">
                      <span className="forge-avatar">{(t.symbol ?? t.name ?? "F").slice(0, 2).toUpperCase()}</span>
                      <PhaseBadge phase={t.phase} error={t.reconcile_error} />
                    </div>
                    <div>
                      <h2>
                        {t.name ?? short(t.token)} <span className="forge-symbol">${t.symbol ?? "?"}</span>
                      </h2>
                    </div>
                    <p className="forge-summary">{repoLine(t)}</p>
                    <div className="forge-progress" aria-hidden="true">
                      <span style={{ width: t.phase === "graduated" ? "100%" : `${Math.min(100, progress ?? 0)}%` }} />
                    </div>
                    <div className="forge-card-foot">
                      <span>
                        {formatUnits18(t.quote_volume)} ETH · {t.buy_count} buys
                      </span>
                      <span>{ago(t.launched_at).toUpperCase()}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              Volume counts bonding-curve trades from on-chain events only. Post-graduation V4 pool volume and prices are not indexed in W03 and are not shown.
            </p>
          </div>
        </div>
      )}

      <div className="forge-grid">
        <section className="forge-panel forge-col-8">
          <div className="forge-eyebrow" style={{ marginBottom: 9 }}>WHAT “VERIFIED” MEANS HERE</div>
          <h2>Evidence is a boundary, not a badge</h2>
          <p style={{ marginBottom: 12 }}>
            The creator proved GitHub administration of one repository and control of a wallet — checked server-side against the canonical numeric repository identity at a specific time. That evidence is inspectable here.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="forge-callout">
              <strong>What repository verification establishes</strong>
              <br />
              Authenticated admin authority, GitHub App installation and coverage, canonical repository identity, and freshness of that evidence.
            </div>
            <div className="forge-callout">
              <strong>What it cannot establish</strong>
              <br />
              Code quality, audit status, token legitimacy, investment safety, or future project outcomes.
            </div>
          </div>
        </section>
        <section className="forge-panel forge-col-4">
          <div className="forge-eyebrow" style={{ marginBottom: 9 }}>GET STARTED</div>
          <h2>Two identities, one binding</h2>
          <ul className="forge-checklist" style={{ margin: "10px 0 14px" }}>
            <li>
              <GitHubMark size={14} /> Connect GitHub — the server verifies admin authority; discovery alone is not proof.
            </li>
            <li>
              <Wallet size={14} /> Bind a wallet — a server-issued SIWE challenge proves wallet consent only.
            </li>
            <li>
              <Plus size={14} /> Launch — five reviewed steps with economics read from the factory; production remains gated.
            </li>
          </ul>
          <div className="forge-actions" style={{ marginTop: 0 }}>
            <ForgeLinkButton href="/launch">Start the launch wizard <ArrowRight size={14} /></ForgeLinkButton>
          </div>
          <div className="forge-disabled-note" style={{ display: "flex", gap: 7, alignItems: "flex-start", marginTop: 12 }}>
            <Eye size={13} style={{ flex: "none", marginTop: 2 }} />
            <span>Selecting any launch opens its real Proof-of-Build record — the cryptographic linkage of repository, verification evidence, binding and launch transaction.</span>
          </div>
        </section>
      </div>
    </>
  );
}
