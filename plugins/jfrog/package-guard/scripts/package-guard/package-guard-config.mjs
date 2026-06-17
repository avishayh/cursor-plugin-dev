// Org-wide repo overrides from the JFrog Platform (optional).
//
//   GET {platform}/artifactory/api/package-guard/config
//   → { "repositories": { "npm": "corp-npm", "pypi": "corp-pypi", ... } }
//
// Disabled by default until the platform API is supported in production.
// Dogfood with JFROG_PACKAGE_GUARD_ORG_CONFIG=1.

import process from "node:process";

import { createLogger } from "../../../scripts/core/logger.mjs";

const log = createLogger("package-guard-config");

export const ORG_CONFIG_API_PATH = "/artifactory/api/package-guard/config";

export function isOrgAdminConfigFetchEnabled() {
  return process.env.JFROG_PACKAGE_GUARD_ORG_CONFIG === "1";
}

function normalizeRepositories(raw) {
  if (!raw || typeof raw !== "object") return null;
  const repos = raw.repositories ?? raw;
  if (!repos || typeof repos !== "object") return null;
  const out = {};
  for (const [type, key] of Object.entries(repos)) {
    if (typeof key === "string" && key.trim()) out[type] = key.trim();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Fetch org-wide package-guard config. Returns `{ repositories }` or null.
 * No HTTP unless {@link isOrgAdminConfigFetchEnabled} is true.
 * @param {{ url: string, token: string }} identity
 */
export async function fetchPackageGuardConfig(identity) {
  if (!isOrgAdminConfigFetchEnabled()) {
    log.debug("org admin config fetch skipped", { reason: "unsupported" });
    return null;
  }
  if (!identity?.url || !identity?.token) return null;

  const url = `${identity.url}${ORG_CONFIG_API_PATH}`;
  log.debug("fetching org admin config", { url });
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${identity.token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      log.debug("org admin config fetch miss", { status: res.status, url });
      return null;
    }
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      log.warn("org admin config not valid JSON", {
        error: err?.message ?? String(err),
        snippet: text.slice(0, 120),
      });
      return null;
    }
    const repositories = normalizeRepositories(parsed);
    if (!repositories) {
      log.warn("org admin config missing repositories map");
      return null;
    }
    log.debug("org admin config loaded", { types: Object.keys(repositories).join(",") });
    return { repositories };
  } catch (err) {
    log.warn("org admin config fetch threw", { error: err?.message ?? String(err) });
    return null;
  }
}
