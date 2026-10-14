import path from "node:path";
import { deploySandbox, writeDeployment } from "./sandbox-lib";

const rpc = process.env.FORGE_RPC_URL ?? "http://127.0.0.1:8545";
const out = process.env.FORGE_DEPLOYMENT_FILE ?? path.resolve(process.cwd(), ".sandbox", "deployment.json");
const d = await deploySandbox(rpc);
writeDeployment(d, out);
console.log(`W02 Forge stack deployed to ${rpc} (chain ${d.chainId}); factory ${d.factory}; wrote ${out}`);
