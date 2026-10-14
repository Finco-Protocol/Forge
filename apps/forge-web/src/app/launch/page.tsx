"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAccount, useConnect, useSignMessage, useSignTypedData, useSwitchChain, useWriteContract } from "wagmi";
import { getAddress, isAddress } from "viem";
import { ponsV2LaunchFactoryAbi } from "@/shared/abis.generated";
import { reviveLaunchArgs, reviveTypedData, type LaunchTxJson } from "@/shared/launch-tx";
import { api, ApiError, bps, formatUnits18, short } from "@/components/api";
import { useForge } from "@/components/providers";
import { TxLink, VerificationDisclosure } from "@/components/shell";

/* eslint-disable @typescript-eslint/no-explicit-any */
const STEPS = ["Connect", "Configure", "Economics", "Authorize", "Launch"];

function ErrorBox({ e }: { e: unknown }) {
  if (!e) return null;
  const err = e as ApiError;
  const reasons = err.detail && typeof err.detail === "object" ? (err.detail as any).reasons : null;
  return (
    <div className="alert error" role="alert" data-testid="error">
      <b>{err.code ?? "Error"}</b> — {err.message}
      {reasons && <div>Reasons: {reasons.join(", ")}</div>}
    </div>
  );
}

function Wizard() {
  const { config, me, refreshMe } = useForge();
  const router = useRouter();
  const search = useSearchParams();
  const draftId = search.get("draft");
  const [step, setStep] = useState(0);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const { address, isConnected, chainId } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();

  const [repos, setRepos] = useState<any | null>(null);
  const [selected, setSelected] = useState<any | null>(null);
  const [verification, setVerification] = useState<any | null>(null);
  const [form, setForm] = useState({
    name: "",
    symbol: "",
    description: "",
    logo: "",
    website: "",
    twitter: "",
    telegram: "",
    discord: "",
    farcaster: "",
    pairToken: "0x0000000000000000000000000000000000000000",
    creatorFeeRecipient: "",
    creatorTaxBps: 0,
    buybackEnabled: false,
    launchConfigId: 0,
    exemptions: "",
  });
  const [draft, setDraft] = useState<any | null>(null);
  const [authz, setAuthz] = useState<any | null>(null);
  const [signed, setSigned] = useState<any | null>(null);
  const [intent, setIntent] = useState<any | null>(null);

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  }, []);

  const walletMismatch = Boolean(isConnected && me?.wallet && address && getAddress(address) !== getAddress(me.wallet.address));
  const wrongChain = isConnected && chainId !== config.chainId;

  useEffect(() => {
    if (me?.github && repos === null) api("/api/github/repositories").then(setRepos, setErr);
  }, [me?.github, repos]);

  // Resume an existing draft (?draft=…), e.g. from the dashboard or after a failure.
  useEffect(() => {
    if (!draftId || !me?.github) return;
    api(`/api/launch/drafts/${draftId}`).then((d) => {
      setDraft(d);
      setSelected({ repoId: d.params.repoId, installationId: d.params.installationId });
      const live = d.intents.find((i: any) => ["submitted", "included", "confirmed"].includes(i.status));
      if (live) {
        setIntent({ intentId: live.id, status: live.status, txHash: live.tx_hash, token: live.token_address });
        setStep(4);
      } else setStep((s) => (s < 2 ? 2 : s));
    }, setErr);
  }, [draftId, me?.github]);

  // Poll the launch intent until it settles.
  useEffect(() => {
    if (!intent?.intentId || ["confirmed", "failed", "expired", "superseded"].includes(intent.status)) return;
    const t = setInterval(() => api(`/api/launch/intents/${intent.intentId}`).then(setIntent, () => undefined), 2000);
    return () => clearInterval(t);
  }, [intent?.intentId, intent?.status]);

  const connectWallet = () =>
    run("connect", async () => {
      const c = connectors[0];
      if (!c) throw new Error("No EIP-1193 wallet detected in this browser.");
      await connectAsync({ connector: c });
    });

  const bindWallet = () =>
    run("bind", async () => {
      if (!address) throw new Error("Connect a wallet first.");
      if (wrongChain) await switchChainAsync({ chainId: config.chainId });
      const ch = await api("/api/wallet/challenge", { method: "POST", body: { address, chainId: config.chainId } });
      const signature = await signMessageAsync({ message: ch.message });
      await api("/api/wallet/verify", { method: "POST", body: { message: ch.message, signature } });
      await refreshMe();
    });

  const verify = (repo: any) =>
    run("verify", async () => {
      setSelected(repo);
      setVerification(null);
      const r = await api("/api/github/verify", { method: "POST", body: { repoId: repo.repoId, installationId: repo.installationId } });
      setVerification(r.verification);
    });

  const preview = () =>
    run("preview", async () => {
      const exemptions = form.exemptions
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const a of exemptions) if (!isAddress(a)) throw new Error(`Invalid exemption address: ${a}`);
      const body: Record<string, unknown> = {
        repoId: selected.repoId,
        installationId: selected.installationId,
        name: form.name,
        symbol: form.symbol,
        description: form.description,
        logo: form.logo,
        socials: { website: form.website, twitter: form.twitter, telegram: form.telegram, discord: form.discord, farcaster: form.farcaster },
        launchConfigId: Number(form.launchConfigId),
        pairToken: form.pairToken,
        creatorTaxBps: Number(form.creatorTaxBps),
        buybackEnabled: form.buybackEnabled,
        snipeTaxExemptions: exemptions,
      };
      if (form.creatorFeeRecipient) body.creatorFeeRecipient = form.creatorFeeRecipient;
      const d = await api("/api/launch/drafts", { method: "POST", body });
      setDraft({ ...d, currentEconomics: d.economics, economicsStale: false });
      setAuthz(null);
      setSigned(null);
      router.replace(`/launch?draft=${d.id}`);
      setStep(2);
    });

  const acceptEconomics = () =>
    run("refresh", async () => {
      setDraft(await api(`/api/launch/drafts/${draft.id}/refresh`, { method: "POST" }));
      setAuthz(null);
      setSigned(null);
    });

  const authorize = () =>
    run("authorize", async () => {
      setSigned(null);
      try {
        const a = await api(`/api/launch/drafts/${draft.id}/authorize`, { method: "POST" });
        // Never sign what we did not expect: domain, factory and creator are re-checked client-side.
        const td = reviveTypedData(a.typedData);
        if (td.domain.chainId !== config.chainId || getAddress(td.domain.verifyingContract) !== getAddress(config.addresses.authorizer!)) throw new Error("Unexpected signing domain; refusing.");
        if (getAddress(td.message.factory) !== getAddress(config.addresses.factory!)) throw new Error("Unexpected factory; refusing.");
        setAuthz(a);
        setStep(3);
      } catch (e) {
        if (e instanceof ApiError && e.code === "STALE_ECONOMICS") setDraft(await api(`/api/launch/drafts/${draft.id}`));
        throw e;
      }
    });

  const sign = () =>
    run("sign", async () => {
      if (walletMismatch) throw new Error("The connected wallet is not your bound creator wallet. Switch accounts.");
      if (wrongChain) await switchChainAsync({ chainId: config.chainId });
      const td = reviveTypedData(authz.typedData);
      if (address && getAddress(td.message.creator) !== getAddress(address)) throw new Error("Connected wallet does not match the intent's creator.");
      const signature = await signTypedDataAsync(td);
      setSigned(await api(`/api/launch/intents/${authz.intentId}/signature`, { method: "POST", body: { signature } }));
    });

  const launch = () =>
    run("launch", async () => {
      if (wrongChain) await switchChainAsync({ chainId: config.chainId });
      const tx = signed.tx as LaunchTxJson;
      const a = reviveLaunchArgs(tx);
      const hash = await writeContractAsync({
        address: tx.address,
        abi: ponsV2LaunchFactoryAbi,
        functionName: "launchToken",
        args: [a.params, a.launchConfigId, a.pairToken, a.exemptions],
        value: a.value,
        chainId: config.chainId,
      });
      setIntent({ intentId: authz.intentId, status: "submitted", txHash: hash });
      setStep(4);
      setIntent(await api(`/api/launch/intents/${authz.intentId}/submitted`, { method: "POST", body: { txHash: hash } }));
    });

  const econ = draft?.currentEconomics ?? draft?.economics;
  const stepDone = useMemo(
    () => [Boolean(me?.github && me?.wallet && verification), Boolean(draft), Boolean(authz), Boolean(signed), intent?.status === "confirmed"],
    [me, verification, draft, authz, signed, intent],
  );

  return (
    <>
      <h1>Launch a verified builder token</h1>
      <VerificationDisclosure />
      <p className="sub">Your GitHub administration and your wallet are proven separately; both are required. Nothing is signed or sent without your explicit action.</p>
      <div className="stepper" data-testid="stepper">
        {STEPS.map((s, i) => (
          <button
            type="button"
            key={s}
            className={`step ${i === step ? "active" : ""} ${stepDone[i] ? "done" : ""}`}
            onClick={() => (i <= step || stepDone[i - 1] ? setStep(i) : undefined)}
            style={{ textAlign: "left" }}
          >
            <span className="hint">Step {i + 1}</span>
            <b>{s}</b>
          </button>
        ))}
      </div>
      <ErrorBox e={err} />

      {step === 0 && (
        <div className="grid cols-2">
          <section className="panel">
            <h2>1 · GitHub</h2>
            {me?.github ? (
              <p>
                Signed in as <b>@{me.github.login}</b>.
              </p>
            ) : (
              <a className="btn" href="/api/auth/github/start" data-testid="connect-github">
                Connect GitHub
              </a>
            )}
            <h2 style={{ marginTop: 18 }}>2 · Wallet</h2>
            {!isConnected ? (
              <button onClick={connectWallet} disabled={!!busy} data-testid="connect-wallet">
                Connect wallet
              </button>
            ) : (
              <>
                <p>
                  Connected <code>{address}</code> {wrongChain && <span className="chip bad">wrong network</span>}
                </p>
                {wrongChain && (
                  <button className="secondary" onClick={() => run("switch", async () => void (await switchChainAsync({ chainId: config.chainId })))}>
                    Switch to chain {config.chainId}
                  </button>
                )}
              </>
            )}
            {me?.github && isConnected && (!me.wallet || walletMismatch) && (
              <div className="actions">
                <button onClick={bindWallet} disabled={!!busy} data-testid="bind-wallet">
                  {busy === "bind" ? "Waiting for signature…" : me.wallet ? "Re-bind to this wallet" : "Bind wallet to GitHub (sign-in message)"}
                </button>
              </div>
            )}
            {me?.wallet && !walletMismatch && (
              <div className="alert ok" data-testid="wallet-bound">
                Bound creator wallet <code>{me.wallet.address}</code>
              </div>
            )}
            {walletMismatch && <div className="alert warn">The connected account differs from your bound wallet {short(me?.wallet?.address)}. Switch accounts or re-bind.</div>}
          </section>
          <section className="panel">
            <h2>3 · Repository</h2>
            {!me?.github ? (
              <p className="hint">Connect GitHub to list repositories.</p>
            ) : repos === null ? (
              <p className="hint">Loading repositories…</p>
            ) : (
              <>
                {repos.repositories.length === 0 && <p className="hint">No repositories reachable through the Forge GitHub App.</p>}
                <div className="repo-cards">
                  {repos.repositories.map((r: any) => (
                    <button
                      type="button"
                      key={r.repoId}
                      className={`repo-card ${selected?.repoId === r.repoId ? "selected" : ""}`}
                      onClick={() => verify(r)}
                      disabled={!!busy}
                      data-testid={`repo-${r.repoId}`}
                    >
                      <b>{r.fullName}</b>
                      <div className="hint">
                        {r.admin ? "admin" : "not admin"} · {r.private ? "private" : "public"}
                        {r.policyBlockers.length ? ` · ${r.policyBlockers.join(", ")}` : ""}
                      </div>
                    </button>
                  ))}
                </div>
                <p className="hint" style={{ marginTop: 10 }}>
                  Missing a repository? <a href={repos.installUrl}>Install the Forge GitHub App</a> on its owner account.
                </p>
              </>
            )}
            {busy === "verify" && <div className="alert info">Verifying administration with GitHub…</div>}
            {verification && (
              <div className="alert ok" data-testid="eligibility-result">
                <b>Eligible.</b> {verification.fullName} — administration confirmed by your GitHub token and by the App installation.
                <div className="hint">
                  Commit <code>{verification.commitSha.slice(0, 12)}</code> · verified {new Date(verification.verifiedAt).toLocaleTimeString()} · evidence expires{" "}
                  {new Date(verification.expiresAt).toLocaleTimeString()}
                </div>
              </div>
            )}
            <div className="actions">
              <button onClick={() => setStep(1)} disabled={!stepDone[0]} data-testid="to-configure">
                Continue
              </button>
            </div>
          </section>
        </div>
      )}

      {step === 1 && (
        <section className="panel">
          <h2>Configure token</h2>
          <p className="hint">Only parameters the W02 factory supports. Supply, curve and fees come from the factory launch configuration.</p>
          <div className="grid cols-2">
            <div>
              <label className="field">
                <span>Token name *</span>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="f-name" maxLength={64} />
              </label>
              <label className="field">
                <span>Symbol *</span>
                <input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} data-testid="f-symbol" maxLength={16} />
              </label>
              <label className="field">
                <span>Description</span>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={1000} />
              </label>
              <label className="field">
                <span>Logo URL (https:// or ipfs://)</span>
                <input value={form.logo} onChange={(e) => setForm({ ...form, logo: e.target.value })} />
              </label>
              <label className="field">
                <span>Website</span>
                <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
              </label>
              <div className="grid cols-2">
                <label className="field">
                  <span>X / Twitter URL</span>
                  <input value={form.twitter} onChange={(e) => setForm({ ...form, twitter: e.target.value })} />
                </label>
                <label className="field">
                  <span>Telegram URL</span>
                  <input value={form.telegram} onChange={(e) => setForm({ ...form, telegram: e.target.value })} />
                </label>
                <label className="field">
                  <span>Discord URL</span>
                  <input value={form.discord} onChange={(e) => setForm({ ...form, discord: e.target.value })} />
                </label>
                <label className="field">
                  <span>Farcaster URL</span>
                  <input value={form.farcaster} onChange={(e) => setForm({ ...form, farcaster: e.target.value })} />
                </label>
              </div>
            </div>
            <div>
              <label className="field">
                <span>Quote asset</span>
                <input value={form.pairToken} onChange={(e) => setForm({ ...form, pairToken: e.target.value })} />
                <span className="hint">0x000…000 = native ETH. ERC-20 quote assets must be approved on the factory (checked live).</span>
              </label>
              <label className="field">
                <span>Launch configuration #</span>
                <input type="number" min={0} value={form.launchConfigId} onChange={(e) => setForm({ ...form, launchConfigId: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>Creator fee recipient</span>
                <input placeholder={me?.wallet?.address ?? "defaults to your bound wallet"} value={form.creatorFeeRecipient} onChange={(e) => setForm({ ...form, creatorFeeRecipient: e.target.value })} />
              </label>
              <label className="field">
                <span>
                  Creator tax: {bps(form.creatorTaxBps)} ({form.creatorTaxBps} bps)
                </span>
                <input type="range" min={0} max={1000} step={10} value={form.creatorTaxBps} onChange={(e) => setForm({ ...form, creatorTaxBps: Number(e.target.value) })} data-testid="f-tax" />
                <span className="hint">Paid to the creator on every curve trade, on top of the curve fee. Capped by the factory&apos;s maxCreatorTaxBps.</span>
              </label>
              <label className="field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={form.buybackEnabled} onChange={(e) => setForm({ ...form, buybackEnabled: e.target.checked })} />
                <span style={{ margin: 0 }}>Enable buyback-and-lock at launch</span>
              </label>
              <label className="field">
                <span>Anti-snipe exemptions (addresses, max 32)</span>
                <textarea value={form.exemptions} onChange={(e) => setForm({ ...form, exemptions: e.target.value })} placeholder="0x… one per line" />
                <span className="hint">These wallets skip the launch-window snipe tax. The exact set is bound into your signature.</span>
              </label>
            </div>
          </div>
          <div className="actions">
            <button className="secondary" onClick={() => setStep(0)}>
              Back
            </button>
            <button onClick={preview} disabled={!!busy || !form.name || !form.symbol || !selected} data-testid="preview">
              {busy === "preview" ? "Reading factory…" : "Preview economics"}
            </button>
          </div>
        </section>
      )}

      {step === 2 && draft && econ && (
        <section className="panel" data-testid="economics">
          <h2>Economics preview — read from the factory</h2>
          {draft.economicsStale && (
            <div className="alert warn" data-testid="stale-economics">
              The factory&apos;s terms changed since this preview (digest {short(draft.economics.digest, 10)} → {short(draft.currentEconomics.digest, 10)}). Review the new terms below; any earlier
              signature is void.
              <div className="actions">
                <button onClick={acceptEconomics} disabled={!!busy}>
                  Accept new terms
                </button>
              </div>
            </div>
          )}
          <div className="grid cols-2">
            <dl className="kv">
              <dt>Token supply</dt>
              <dd>{formatUnits18(econ.supply, 0)} (all on the curve; nothing pre-minted)</dd>
              <dt>Phantom quote reserve</dt>
              <dd>{formatUnits18(econ.phantomQuote)} ETH</dd>
              <dt>Graduation threshold</dt>
              <dd>{formatUnits18(econ.graduationThreshold)} ETH real reserve</dd>
              <dt>Curve trade fee</dt>
              <dd>{bps(econ.curveFeeBps)}</dd>
              <dt>Your creator tax</dt>
              <dd>
                {bps(draft.params.creatorTaxBps)} (max {bps(econ.maxCreatorTaxBps)})
              </dd>
              <dt>Combined curve fee</dt>
              <dd>{bps(Number(econ.curveFeeBps) + draft.params.creatorTaxBps)}</dd>
              <dt>Graduated pool</dt>
              <dd>
                Uniswap V4 · fee {econ.poolFee} · tick spacing {econ.tickSpacing} · hook fee {bps(econ.hookFeeBps)}
              </dd>
            </dl>
            <dl className="kv">
              <dt>Protocol share of fees</dt>
              <dd>{bps(econ.protocolFeeShareBps)}</dd>
              <dt>Buyback/burn share</dt>
              <dd>{bps(econ.buybackBurnBps)}</dd>
              <dt>Max internal price impact</dt>
              <dd>{bps(econ.maxInternalPriceImpactBps)}</dd>
              <dt>Anti-snipe tax</dt>
              <dd>
                {bps(econ.snipeTaxStartBps)} decaying over {econ.snipeTaxSeconds}s
              </dd>
              <dt>Launch fee</dt>
              <dd>{formatUnits18(econ.launchFeeWei)} ETH + gas</dd>
              <dt>Quote asset</dt>
              <dd>{econ.pairToken === "0x0000000000000000000000000000000000000000" ? "ETH (native)" : econ.pairToken}</dd>
              <dt>Economics digest</dt>
              <dd>
                <code>{econ.digest}</code>
                <div className="hint">read at block {econ.readAtBlock}</div>
              </dd>
            </dl>
          </div>
          <h3 style={{ marginTop: 16 }}>CREATE2 address preview</h3>
          <dl className="kv">
            <dt>Token</dt>
            <dd>
              <code data-testid="predicted-token">{draft.predicted.token}</code>
            </dd>
            <dt>Bonding curve</dt>
            <dd>
              <code>{draft.predicted.curve}</code>
            </dd>
          </dl>
          <div className="alert warn">
            <b>Risks and privileged powers.</b> Factory owner <code>{short(econ.factoryOwner)}</code> and hook owner <code>{short(econ.hookOwner)}</code> can change fee policy and launch
            configuration for future launches, redirect a launch&apos;s creator-fee recipient after a 3-day timelock (F-03) and use reserve/fee rescue hatches (F-04). The fee-policy authority is not yet
            proven governance (FORGE_FEE_POLICY_AUTHORITY_UNPROVEN). Bonding-curve tokens are highly volatile; this is not investment advice.
          </div>
          <div className="actions">
            <button className="secondary" onClick={() => setStep(1)}>
              Back
            </button>
            <button onClick={authorize} disabled={!!busy || draft.economicsStale} data-testid="authorize">
              {busy === "authorize" ? "Re-verifying GitHub, binding repository on chain, issuing attestation…" : "Request launch authorization"}
            </button>
          </div>
        </section>
      )}

      {step === 3 && authz && (
        <section className="panel" data-testid="authorization">
          <h2>Authorization</h2>
          <div className="grid cols-2">
            <dl className="kv">
              <dt>Registry binding</dt>
              <dd>
                epoch {authz.eligibility.bindingEpoch}{" "}
                {authz.eligibility.bindingTx ? (
                  <>
                    · tx <TxLink hash={authz.eligibility.bindingTx} />
                  </>
                ) : (
                  "(already active)"
                )}
              </dd>
              <dt>Attestation window</dt>
              <dd>
                {new Date(Number(authz.eligibility.attestationIssuedAt) * 1000).toLocaleTimeString()} → {new Date(Number(authz.eligibility.attestationExpiresAt) * 1000).toLocaleTimeString()}
              </dd>
              <dt>Commit snapshot</dt>
              <dd>
                <code>{authz.eligibility.commitSha}</code>
              </dd>
            </dl>
            <dl className="kv">
              <dt>Consent nonce</dt>
              <dd>{authz.nonce}</dd>
              <dt>Consent expires</dt>
              <dd>{new Date(Number(authz.expiresAt) * 1000).toLocaleTimeString()}</dd>
              <dt>EIP-712 digest</dt>
              <dd>
                <code data-testid="consent-digest">{authz.consentDigest}</code>
                <div className="hint">verified equal to the authorizer&apos;s consentDigest()</div>
              </dd>
            </dl>
          </div>
          {!signed ? (
            <div className="actions">
              <button onClick={sign} disabled={!!busy || walletMismatch} data-testid="sign">
                {busy === "sign" ? "Waiting for wallet signature…" : "Sign launch intent"}
              </button>
              <button className="secondary" onClick={authorize} disabled={!!busy}>
                Re-authorize
              </button>
            </div>
          ) : (
            <>
              <div className="alert ok" data-testid="simulation">
                <b>Simulation passed.</b> The factory would deploy token <code>{signed.simulation.token}</code> and curve <code>{short(signed.simulation.curve)}</code>.
                <div className="hint">
                  Gas ≈ {signed.simulation.gas} · max cost ≈ {formatUnits18(signed.simulation.maxGasCostWei, 6)} ETH · launch fee {formatUnits18(signed.simulation.launchFeeWei)} ETH
                </div>
              </div>
              <div className="actions">
                <button onClick={launch} disabled={!!busy} data-testid="launch">
                  {busy === "launch" ? "Confirm in wallet…" : "Launch token"}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {step === 4 && intent && (
        <section className="panel" data-testid="launch-status">
          <h2>
            Launch status: <span data-testid="launch-state">{intent.status}</span>
          </h2>
          <dl className="kv">
            <dt>Transaction</dt>
            <dd>
              <TxLink hash={intent.txHash} />
            </dd>
            <dt>Token</dt>
            <dd>{intent.token ? <code>{intent.token}</code> : "pending"}</dd>
          </dl>
          {["submitted", "included"].includes(intent.status) && (
            <div className="alert info">{intent.status === "submitted" ? "Waiting for the transaction to be mined…" : "Mined — waiting for the indexer to confirm the canonical TokenLaunched event."}</div>
          )}
          {intent.status === "confirmed" && (
            <div className="alert ok">
              Launched and indexed.{" "}
              <Link href={`/projects/${intent.token}`} data-testid="project-link">
                Open the project page →
              </Link>
            </div>
          )}
          {intent.recovery && (
            <div className="alert warn">
              {intent.failureReason && (
                <div>
                  <b>{intent.failureReason}</b>
                </div>
              )}
              {intent.recovery}
              <div className="actions">
                <button
                  onClick={() => {
                    setSigned(null);
                    setAuthz(null);
                    setStep(2);
                  }}
                >
                  Re-authorize this draft
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </>
  );
}

export default function LaunchPage() {
  return (
    <Suspense fallback={<p className="empty">Loading…</p>}>
      <Wizard />
    </Suspense>
  );
}
