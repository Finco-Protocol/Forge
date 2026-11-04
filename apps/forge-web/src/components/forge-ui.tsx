"use client";

/*
 * WEB-03: shared Forge UI primitives ported from the WEB-02 Replit design
 * handover (forge/FincoForgeExperience.tsx). Presentation only — no data
 * fetching, no state that could shadow server-authoritative status, no
 * demo fixtures. Icons are minimal inline SVGs so no icon dependency is
 * added; the GitHub mark is the standard octicon path (MIT, github/octicons).
 */
import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

export function GitHubMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="forge-github-mark">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

const icon = (d: string) =>
  function Icon({ size = 15, className, style }: { size?: number; className?: string; style?: CSSProperties }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className} style={style}>
        <path d={d} />
      </svg>
    );
  };

export const ArrowRight = icon("M5 12h14M12 5l7 7-7 7");
export const ArrowLeft = icon("M19 12H5M12 19l-7-7 7-7");
export const ArrowUpRight = icon("M7 17 17 7M7 7h10v10");
export const Check = icon("M20 6 9 17l-5-5");
export const Search = icon("M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM21 21l-4.35-4.35");
export const Wallet = icon("M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a2 2 0 0 0 0 4h4v-4Z");
export const LockKeyhole = icon("M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4M12 15v2");
export const ShieldCheck = icon("M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10ZM9 12l2 2 4-4");
export const AlertTriangle = icon("M12 3 2 20h20L12 3ZM12 9v5M12 17.5v.5");
export const RefreshCw = icon("M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6");
export const Plus = icon("M12 5v14M5 12h14");
export const Code2 = icon("M8 6 2 12l6 6M16 6l6 6-6 6");
export const Grid2X2 = icon("M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z");
export const List = icon("M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01");
export const Eye = icon("M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7ZM12 12m-3 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0");
export const Unplug = icon("M12 22v-5M9 8V2M15 8V2M18 6H6v4a6 6 0 0 0 12 0Z");

export function ForgeLinkButton({
  href,
  children,
  primary = false,
  ...rest
}: { href: string; children: ReactNode; primary?: boolean } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const cls = `forge-button${primary ? " forge-button-primary" : ""}${rest.className ? ` ${rest.className}` : ""}`;
  if (/^(https?:)?\/\//.test(href) || href.startsWith("/api/")) {
    return (
      <a href={href} className={cls} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls} {...rest}>
      {children}
    </Link>
  );
}

export function ForgeButton({ primary = false, ...rest }: { primary?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`forge-button${primary ? " forge-button-primary" : ""}${rest.className ? ` ${rest.className}` : ""}`} {...rest} />;
}

export function ForgeHeading({ eyebrow, title, children, right, id }: { eyebrow: string; title: ReactNode; children?: ReactNode; right?: ReactNode; id?: string }) {
  return (
    <div className="forge-heading">
      <div style={{ minWidth: 0 }}>
        <div className="forge-eyebrow">{eyebrow}</div>
        <h1 id={id}>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {right && <div className="forge-heading-right">{right}</div>}
    </div>
  );
}

export function ForgePanel({ children, className = "", eyebrow, title }: { children: ReactNode; className?: string; eyebrow?: string; title?: ReactNode }) {
  return (
    <section className={`forge-panel ${className}`}>
      {eyebrow && <div className="forge-eyebrow" style={{ marginBottom: 9 }}>{eyebrow}</div>}
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

export function ForgeStateBanner({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <div className="forge-state-banner" role="note" data-testid={testid}>
      <ShieldCheck size={17} />
      <span>{children}</span>
    </div>
  );
}

export function ForgeSafety() {
  return (
    <div className="forge-safety" role="note">
      <AlertTriangle size={14} aria-hidden="true" />
      <span>
        <b>ENG RC1 · CONTROLLED BETA · NOT LIVE · PRODUCTION_READY=false</b> &nbsp;—&nbsp; Production is blocked by release gates. Launch, trading, signing, deployment and claims are unavailable outside the local sandbox.
      </span>
    </div>
  );
}
