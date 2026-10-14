"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import type { ReactNode } from "react";
import { useForge } from "./providers";
import { short } from "./api";

/** W05: what repository verification does and does NOT establish. Shown wherever a launch or token is presented. */
export function VerificationDisclosure({ compact = false }: { compact?: boolean }) {
  return (
    <aside className="alert info" aria-label="What verification means" data-testid="verification-disclosure">
      <b>What “verified” means here.</b> The creator proved GitHub administration of one repository and control of a wallet, and that proof was checked at the time shown.
      {compact ? null : (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          <li>It is <b>not a code audit</b>: nobody has reviewed the project&apos;s code or the token contracts for this launch.</li>
          <li>It is <b>not KYC</b>: it does not identify the person or organisation behind the repository.</li>
          <li>It is <b>not a financial endorsement</b> and not a guarantee of safety, legitimacy, liquidity or value.</li>
          <li>Tokens can lose all value. Trading fees, creator tax and the protocol share apply as shown in the fee breakdown.</li>
        </ul>
      )}
    </aside>
  );
}

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
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <div className="banner" role="note">
        {config.network === "sandbox" ? "LOCAL SANDBOX — no real value. " : ""}
        PRODUCTION_BLOCKED · FORGE_FEE_POLICY_AUTHORITY_UNPROVEN · FINCO burn disabled. GitHub verification is not a code audit, KYC or proof of financial legitimacy.
      </div>
      <header className="top">
        <div className="container row">
          <Link href="/" className="brand">
            FINCO <span>Forge</span>
          </Link>
          <nav className="main" aria-label="Primary">
            {nav.map(([href, label]) => (
              <Link key={href} href={href} className={path === href ? "active" : ""} aria-current={path === href ? "page" : undefined}>
                {label}
              </Link>
            ))}
          </nav>
          <div className="status-chips" data-testid="account-status" role="status" aria-live="polite" aria-label="Connection status">
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
      <main className="container" id="main" tabIndex={-1}>
        {children}
      </main>
      <footer>
        <div className="container">
          <p style={{ margin: "0 0 8px" }}>
            GitHub repository verification is not a code audit, KYC, a financial endorsement or a guarantee of project safety. Tokens can lose all value. This is a sandbox candidate; production is blocked.
          </p>
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
