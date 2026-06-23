// Feature-flag check — decides the operating `mode` for the session-policy
// hook (instruction injection).
//
// Resolution order (first match wins):
//
//   1. JFROG_PACKAGE_GUARD_ENABLED≠1       → mode="off" (opt-in gate; default
//      when unset so first-time installs stay silent until an admin configures
//      the flag).
//   2. jf config (via jf-identity)           → mode="active" when identity is
//      usable; otherwise mode="enforce" with a `cause` (jf-not-installed /
//      jf-not-configured) so the session hook can inject a targeted,
//      remediation-focused advisory notice.
//
// Modes:
//   "off"     — do nothing (no injection).
//   "active"  — inject resolved Artifactory URLs + routing policy.
//   "enforce" — jf missing/unconfigured: inject the advisory "routing not
//               ready" notice (no resolved URLs). This is advisory steering,
//               not a hard block — real enforcement is durable PM config
//               (jf setup) + server-side Curation. The L2 shell guard that
//               previously denied direct installs has been removed.
//
// Repo keys come from package-guard config + static defaults (resolver.mjs).
// There is no separate org on/off API.

import process from "node:process";

import { createLogger } from "../../scripts/core/logger.mjs";
import { getPlatformIdentity, identityLabel } from "../../scripts/core/jf-identity.mjs";

const log = createLogger("feature-flag");

const ENABLED = process.env.JFROG_PACKAGE_GUARD_ENABLED === "1";

export async function isPackageGuardEnabled() {
  if (!ENABLED) {
    log.debug("off", { reason: "NOT_ENABLED" });
    return { mode: "off", reason: "NOT_ENABLED", identity: "none", cause: "ok" };
  }

  const { identity, cause } = getPlatformIdentity();
  if (!identity) {
    // jf missing/unconfigured: inject the advisory "routing not ready" notice
    // rather than the normal URL policy. NOT_ENABLED (handled above)
    // suppresses injection entirely.
    log.debug("enforce", { reason: "missing-identity", cause });
    return { mode: "enforce", reason: "missing-identity", identity: "none", cause };
  }

  log.debug("active", { reason: "jf-config", identity: identityLabel(identity) });
  return {
    mode: "active",
    reason: "jf-config",
    identity: identityLabel(identity),
    cause: "ok",
  };
}
