/**
 * Decision matching for security/make-baseline.mjs (kept separate so it is unit-tested).
 *
 * Lower severities may be triaged by a descriptive decision (scanner / rule(s) / scope(s) / file).
 * HIGH and CRITICAL findings may only be matched by a decision that ALSO lists the finding's exact
 * fingerprint in `match.fingerprints`: a rule-wide or scope-wide decision can never auto-approve a new
 * high/critical finding when the baseline is deliberately regenerated; it surfaces as UNTRIAGED.
 */

export const isHighOrCritical = (f) => f.severity === "high" || f.severity === "critical";

/** Descriptive part of a decision (scanner / rule / scope / file). */
export function matchesDescriptor(m, f) {
  return (
    (!m.scanner || m.scanner === f.scanner) &&
    (!m.rule || m.rule === f.rule) &&
    (!m.rules || m.rules.includes(f.rule)) &&
    (!m.scope || m.scope === f.scope) &&
    (!m.scopes || m.scopes.includes(f.scope)) &&
    (!m.file || m.file === f.file)
  );
}

export function matchesDecision(decision, f) {
  const m = decision.match ?? {};
  if (!matchesDescriptor(m, f)) return false;
  if (isHighOrCritical(f)) return Array.isArray(m.fingerprints) && m.fingerprints.includes(f.fingerprint);
  return true;
}

export const findDecision = (decisions, f) => decisions.find((d) => matchesDecision(d, f));

/** Structural check of the decision file: fingerprints must be 16-hex, no wildcards. */
export function validateDecisions(dec) {
  if (!dec || !Array.isArray(dec.decisions)) throw new Error("triage-decisions: expected {decisions:[]}");
  for (const d of dec.decisions) {
    for (const fp of d.match?.fingerprints ?? []) if (!/^[0-9a-f]{16}$/.test(fp)) throw new Error(`triage-decisions: bad fingerprint ${JSON.stringify(fp)} (exact 16-hex only)`);
  }
  return dec;
}
