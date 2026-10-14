import { buildConfig } from "../src/server/config";
import { openDb } from "../src/server/db";
import { migrate } from "../src/server/db/migrate";

const cfg = buildConfig(process.env);
const db = await openDb(cfg.db);
console.log("applied:", await migrate(db));
await db.close();
