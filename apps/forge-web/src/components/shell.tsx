"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import type { ReactNode } from "react";
import { useForge } from "./providers";
import { short } from "./api";

export function Shell({ children }: { children: ReactNode }) {
  const { config, me } = useForge();
  const { address, isConnected, chainId } = useAccount();
  const path = usePathname();
  const mismatch = isConnected && me?.wallet && address && address.toLowerCase() !== me.wallet.address.toLowerCase();
  const wrongChain = isConnected && chainId !== config.chainId;
  const nav = [
    ["/", "Explore"],
    ["/launch", "Launch"],
    ["/dashboard", "Dashboard"],
    ["/treasury", "Treasury"],
  ] as const;
  return (
    <>
      <div className="banner">
        {config.network === "sandbox" ? "LOCAL SANDBOX — no real value. " : ""}
        PRODUCTION_BLOCKED · FORGE_FEE_POLICY_AUTHORITY_UNPROVEN · FINCO burn disabled. GitHub verification is not a code audit, KYC or proof of financial legitimacy.
      </div>
      <header className="top">
        <div className="container row">
          <Link href="/" className="brand">
            FINCO <span>Forge</span>
          </Link>
          <nav className="main">
            {nav.map(([href, label]) => (
              <Link key={href} href={href} className={path === href ? "active" : ""}>
                {label}
              </Link>
            ))}
          </nav>
          <div className="status-chips" data-testid="account-status">
            <span className={`chip ${me?.github ? "ok" : ""}`}>
              <span className="dot" /> {me?.github ? `@${me.github.login}` : "GitHub not connected"}
            </span>
            <span className={`chip ${mismatch || wrongChain ? "bad" : isConnected ? "ok" : ""}`}>
              <span className="dot" />
              {!isConnected ? "Wallet not connected" : wrongChain ? `Wrong network (${chainId})` : mismatch ? "Wallet ≠ bound wallet" : short(address)}
            </span>
            <span className={`chip ${me?.wallet ? "ok" : "warn"}`}>
              <span className="dot" /> {me?.wallet ? `Bound ${short(me.wallet.address)}` : "No wallet binding"}
            </span>
          </div>
        </div>
      </header>
      <main className="container">{children}</main>
      <footer>
        <div className="container">
          Chain {config.chainId} · Factory <code>{config.addresses.factory}</code> · Authorizer <code>{config.addresses.authorizer}</code> · Registry{" "}
          <code>{config.addresses.registry}</code>
        </div>
      </footer>
    </>
  );
}

export function TxLink({ hash, kind = "tx" }: { hash?: string | null; kind?: "tx" | "address" }) {
  const { config } = useForge();
  if (!hash) return <span>—</span>;
  if (!config.explorerUrl) return <code title="Local sandbox — no block explorer">{hash}</code>;
  return (
    <a href={`${config.explorerUrl}/${kind}/${hash}`} target="_blank" rel="noreferrer">
      <code>{hash}</code>
    </a>
  );
}

export function PhaseBadge({ phase, error }: { phase: string; error?: string | null }) {
  const label: Record<string, string> = {
    launched: "Launched",
    bonding_curve_active: "Bonding curve active",
    graduation_initiated: "Graduation initiated",
    liquidity_seeded: "Liquidity seeded",
    graduated: "Graduated · V4",
    blocked: "Blocked / rescued",
  };
  if (error) return <span className="badge phase-error" title={error}>Inconsistent — reconciling</span>;
  return <span className={`badge phase-${phase}`}>{label[phase] ?? "Unknown"}</span>;
}
