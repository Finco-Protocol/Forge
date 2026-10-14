"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ago, short } from "@/components/api";
import { useForge } from "@/components/providers";
import { PhaseBadge, TxLink } from "@/components/shell";
import { CreatorEarnings } from "@/components/earnings";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function DashboardPage() {
  const { me, refreshMe } = useForge();
  const [d, setD] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api("/api/dashboard").then(setD, (e: Error) => setError(e.message));
  useEffect(() => {
    if (me?.github) void load();
  }, [me?.github]);

  if (!me?.github) {
    return (
      <div className="panel empty">
        <p>Connect GitHub to see your creator dashboard.</p>
        <a className="btn" href="/api/auth/github/start">
          Connect GitHub
        </a>
      </div>
    );
  }
  if (error) return <div className="alert error">{error}</div>;
  if (!d) return <p className="empty">Loading…</p>;

  const unbind = async () => {
    if (!confirm("Revoke your wallet binding? Active on-chain repository bindings for this wallet will be revoked and unsigned launches stop.")) return;
    await api("/api/wallet/binding", { method: "DELETE" });
    await refreshMe();
    await load();
  };
  const logoutAll = async () => {
    await api("/api/auth/logout", { method: "POST", body: { all: true } });
    window.location.href = "/";
  };

  return (
    <>
      <h1>Creator dashboard</h1>
      <p className="sub">
        @{d.github.login} · {d.wallet ? <>bound wallet <code>{d.wallet.address}</code></> : "no wallet bound"}
      </p>
      <div className="actions" style={{ marginTop: 0, marginBottom: 18 }}>
        <Link className="btn" href="/launch">
          New launch
        </Link>
        {d.wallet && (
          <button className="danger" onClick={unbind}>
            Revoke wallet binding
          </button>
        )}
        <button className="secondary" onClick={logoutAll}>
          Sign out everywhere
        </button>
      </div>

      <div className="grid cols-2">
        <section className="panel">
          <h2>Launched tokens</h2>
          {d.tokens.length === 0 ? (
            <p className="hint">None yet.</p>
          ) : (
            <table className="list">
              <tbody>
                {d.tokens.map((t: any) => (
                  <tr key={t.token}>
                    <td>
                      <Link href={`/projects/${t.token}`}>
                        {t.name} <span className="hint">${t.symbol}</span>
                      </Link>
                    </td>
                    <td>
                      <PhaseBadge phase={t.phase} />
                    </td>
                    <td className="hint">{ago(t.launched_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>Launch drafts</h2>
          {d.drafts.length === 0 ? (
            <p className="hint">No drafts.</p>
          ) : (
            <table className="list">
              <tbody>
                {d.drafts.map((x: any) => (
                  <tr key={x.id}>
                    <td>
                      <Link href={`/launch?draft=${x.id}`}>
                        {x.name} <span className="hint">${x.symbol}</span>
                      </Link>
                    </td>
                    <td>{x.latest_intent ? <span className="badge">{x.latest_intent.status}</span> : <span className="hint">not authorized</span>}</td>
                    <td className="hint">{x.latest_intent?.failure_reason ?? ago(x.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>GitHub verifications</h2>
          <table className="list">
            <tbody>
              {d.verifications.map((v: any) => {
                const fresh = !v.revoked_at && new Date(v.expires_at).getTime() > Date.now();
                return (
                  <tr key={v.id}>
                    <td>{v.full_name}</td>
                    <td>
                      <code>{v.commit_sha.slice(0, 10)}</code>
                    </td>
                    <td>
                      {v.revoked_at ? <span className="chip bad">revoked: {v.revoke_reason}</span> : fresh ? <span className="chip ok">fresh</span> : <span className="chip warn">expired</span>}
                    </td>
                    <td className="hint">{ago(v.verified_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2>On-chain registry operations</h2>
          {d.registryOps.length === 0 ? (
            <p className="hint">None.</p>
          ) : (
            <table className="list">
              <tbody>
                {d.registryOps.map((o: any) => (
                  <tr key={o.op_digest}>
                    <td>repo {o.repo_id}</td>
                    <td>{o.revoke ? "revoke" : `bind (epoch ${o.binding_epoch ?? "?"})`}</td>
                    <td>
                      <span className="badge">{o.status}</span>
                    </td>
                    <td>
                      <TxLink hash={o.tx_hash} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="hint">Wallet {short(d.wallet?.address)} · bindings are revoked automatically when eligibility is lost.</p>
        </section>
      </div>
      {d.wallet ? <CreatorEarnings /> : <div className="alert">Bind a wallet to see earnings: fees belong to the wallet that is the escrow recipient.</div>}
    </>
  );
}
