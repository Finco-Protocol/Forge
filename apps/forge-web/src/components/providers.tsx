"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "@wagmi/core";
import { defineChain } from "viem";
import { api } from "./api";

export interface PublicConfig {
  network: "sandbox" | "robinhood";
  chainId: number;
  rpcUrl: string | null;
  explorerUrl: string | null;
  addresses: Record<string, string>;
  flags: Record<string, boolean>;
  policy: { allowPrivateRepos: boolean; allowForkRepos: boolean };
  githubAppSlug: string;
  disclaimer: string;
}

export interface Me {
  github: { id: number; login: string } | null;
  wallet: { id: number; address: `0x${string}` } | null;
  chainId: number;
}

const Ctx = createContext<{ config: PublicConfig; me: Me | null; refreshMe: () => Promise<void> } | null>(null);
export const useForge = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("ForgeProvider missing");
  return c;
};

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshMe = async () => setMe(await api<Me>("/api/me"));
  useEffect(() => {
    api<PublicConfig>("/api/config").then(setConfig, (e: Error) => setError(e.message));
    refreshMe().catch(() => undefined);
  }, []);
  const wagmiConfig = useMemo(() => {
    if (!config) return null;
    const chain = defineChain({
      id: config.chainId,
      name: config.network === "sandbox" ? "Forge Sandbox" : "Robinhood Chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl ?? "https://rpc.mainnet.chain.robinhood.com"] } },
      blockExplorers: config.explorerUrl ? { default: { name: "Explorer", url: config.explorerUrl } } : undefined,
    });
    return createConfig({ chains: [chain], connectors: [injected()], transports: { [chain.id]: http(config.rpcUrl ?? undefined) }, ssr: true });
  }, [config]);
  if (error) return <div className="container"><div className="alert error">Forge is unavailable: {error}</div></div>;
  if (!config || !wagmiConfig) return <div className="container"><p className="sub" style={{ padding: 40 }}>Loading Forge…</p></div>;
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Ctx.Provider value={{ config, me, refreshMe }}>{children}</Ctx.Provider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
