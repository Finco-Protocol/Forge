import { createPublicClient, createWalletClient, defineChain, http, type Chain, type PublicClient, type WalletClient, type Transport, type Account } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ForgeConfig } from "../config";
import robinhood from "../../../config/networks/robinhood-4663.json";
import { ROBINHOOD_CHAIN_ID } from "../config";

export function forgeChain(cfg: Pick<ForgeConfig, "chainId" | "rpcUrl">): Chain {
  if (cfg.chainId === ROBINHOOD_CHAIN_ID) {
    return defineChain({
      id: robinhood.chainId,
      name: robinhood.name,
      nativeCurrency: robinhood.nativeCurrency,
      rpcUrls: { default: { http: [robinhood.rpcUrl] } },
      blockExplorers: { default: { name: "Robinhood Explorer", url: robinhood.explorerUrl } },
    });
  }
  return defineChain({
    id: cfg.chainId,
    name: "Forge Sandbox (Anvil)",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    testnet: true,
  });
}

export type ForgePublicClient = PublicClient<Transport, Chain>;
export type ForgeWalletClient = WalletClient<Transport, Chain, Account>;

const pollingFor = (chainId: number) => (chainId === ROBINHOOD_CHAIN_ID ? 2_000 : 150);

export function makePublicClient(cfg: Pick<ForgeConfig, "chainId" | "rpcUrl">): ForgePublicClient {
  return createPublicClient({ chain: forgeChain(cfg), transport: http(cfg.rpcUrl, { timeout: 20_000 }), pollingInterval: pollingFor(cfg.chainId) }) as ForgePublicClient;
}

/** The relayer only pays gas for already-signed registry operations; it holds no authority. */
export function makeRelayer(cfg: Pick<ForgeConfig, "chainId" | "rpcUrl">, key: `0x${string}`): ForgeWalletClient {
  return createWalletClient({ chain: forgeChain(cfg), transport: http(cfg.rpcUrl), account: privateKeyToAccount(key), pollingInterval: pollingFor(cfg.chainId) });
}
