// Fixtures for semgrep/forge-rules.yml (run: semgrep --test semgrep/). `ruleid:` lines MUST be flagged, `ok:` must not.
declare const db: { query: (...a: unknown[]) => unknown };
declare const signer: { signDigest: (d: string) => unknown };
declare const el: { innerHTML: string };
declare const userInput: string;
declare const privateKey: string;
declare const signature: string;
declare const expected: string;

// ruleid: forge-sql-string-interpolation
db.query(`SELECT * FROM t WHERE id = ${userInput}`);
// ruleid: forge-sql-string-interpolation
db.query("SELECT * FROM t WHERE id = " + userInput);
// ok: forge-sql-string-interpolation
db.query("SELECT * FROM t WHERE id = $1", [userInput]);

// ruleid: forge-signdigest-outside-custody
signer.signDigest("0x00");

// ruleid: forge-secret-in-log
console.log("key", privateKey);
// ok: forge-secret-in-log
console.log("address", userInput);

// ruleid: forge-safety-flag-enabled
export const FINCO_BURN_ENABLED = true;
// ok: forge-safety-flag-enabled
export const DEPLOY_WRITE_ENABLED = false;

// ruleid: forge-production-blocked-cleared
export const PRODUCTION_BLOCKED = false;
// ok: forge-production-blocked-cleared
export const PRODUCTION_BLOCKED_OTHER = false;

// ruleid: forge-unsafe-html
el.innerHTML = userInput;

// ruleid: forge-dynamic-code-execution
eval(userInput);

// ruleid: forge-secret-compare-not-constant-time
if (signature === expected) console.info("same");
// ok: forge-secret-compare-not-constant-time
if (signature === undefined) console.info("none");
