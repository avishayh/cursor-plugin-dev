// Repo resolver — maps package type → Artifactory repo key (+ URL for the
// session-policy instruction injection and the jf-setup skill).
//
// Session resolution (once per hook process, per jf server id).
// Identity comes from a separate local `jf config export` (always runs; cheap).
// This module only controls Artifactory HTTP:
//   1. Valid local cache ~/.jfrog/skills-cache/package-guard.json → no HTTP
//   2. Else probe static candidate list (GET …/api/repositories/{key})
//   3. Optional org admin config GET (disabled by default; see package-guard-config.mjs)
//   4. Write full snapshot to cache file (7-day TTL)

import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { createLogger } from "../../../scripts/core/logger.mjs";
import { getPlatformIdentity } from "../../../scripts/core/jf-identity.mjs";
import { fetchPackageGuardConfig } from "./package-guard-config.mjs";
import { pickWorkspaceConfigRoot, loadWorkspaceConfig } from "./workspace-config.mjs";

const log = createLogger("resolver");

const CACHE_DIR = path.join(homedir(), ".jfrog", "skills-cache");
const CACHE_FILE = path.join(CACHE_DIR, "package-guard.json");
const LEGACY_CACHE_FILE = path.join(CACHE_DIR, "package-guard-cache.json");
const CACHE_SCHEMA_VERSION = 1;

/** Cache TTL — design doc target; enforced on read. */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const PACKAGE_TYPES = ["npm", "pypi", "maven", "go", "docker", "helm", "nuget"];

// Static candidate repo keys when package-guard config is absent or incomplete.
const STANDARD_REPO_KEYS = {
  npm: ["npm-virtual"],
  pypi: ["pypi-virtual"],
  maven: ["maven-virtual", "libs-release"],
  go: ["go-virtual"],
  docker: ["docker-virtual"],
  helm: ["helm-virtual"],
  nuget: ["nuget-virtual"],
};

const TYPE_PACKAGE_TYPE = {
  npm: "npm",
  pypi: "pypi",
  maven: "maven",
  go: "go",
  docker: "docker",
  helm: "helm",
  nuget: "nuget",
};

/** In-process snapshot after first resolve pass in this hook invocation. */
const SESSION = {
  serverId: null,
  meta: null,
  byType: null,
};

function identityOrNull() {
  return getPlatformIdentity().identity;
}

function effectiveServerId(hint) {
  if (hint) return hint;
  return identityOrNull()?.serverId ?? "default";
}

function packageResolveSource(serverId, { via } = {}) {
  const suffix = via ? ` via=${via}` : "";
  return `package-guard:${CACHE_FILE}#${serverId}${suffix}`;
}

/** Last session-wide resolve metadata (for inject-instructions EVENT log). */
export function getResolveSessionMeta() {
  return SESSION.meta;
}

function urlFor(type, repoKey, base) {
  switch (type) {
    case "npm":
      return `${base}/api/npm/${repoKey}/`;
    case "pypi":
      return `${base}/api/pypi/${repoKey}/simple/`;
    case "maven":
      return `${base}/${repoKey}/`;
    case "go":
      return `${base}/api/go/${repoKey}`;
    case "docker":
      return new URL(base).host + "/" + repoKey;
    case "helm":
      return `${base}/${repoKey}/`;
    case "nuget":
      return `${base}/api/nuget/v3/${repoKey}/index.json`;
    default:
      return `${base}/${repoKey}/`;
  }
}

async function readCacheFile() {
  for (const file of [CACHE_FILE, LEGACY_CACHE_FILE]) {
    try {
      const raw = await readFile(file, "utf8");
      return { data: JSON.parse(raw), file: CACHE_FILE };
    } catch {
      // try next path
    }
  }
  return { data: null, file: CACHE_FILE };
}

async function writeCacheFile(root) {
  const payload = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    servers: root.servers ?? {},
  };
  const creating = !existsSync(CACHE_FILE);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(payload, null, 2));
  if (creating) {
    log.info("created global cache file", { cache: CACHE_FILE });
  }
  if (existsSync(LEGACY_CACHE_FILE)) {
    await unlink(LEGACY_CACHE_FILE).catch(() => {});
  }
}

function normalizeServerEntry(entry) {
  if (!entry?.repositories || typeof entry.repositories !== "object") return null;
  return {
    repositories: { ...entry.repositories },
    cached_at: entry.cached_at,
    source: entry.source,
  };
}

function isEntryFresh(entry) {
  if (!entry?.cached_at) return false;
  const age = Date.now() - new Date(entry.cached_at).getTime();
  return age >= 0 && age < CACHE_TTL_MS;
}

/** Normalize on-disk cache to `{ schemaVersion, servers }` (migrates legacy flat layout). */
function normalizeCacheRoot(data) {
  const servers = {};
  if (!data || typeof data !== "object") {
    return { schemaVersion: CACHE_SCHEMA_VERSION, servers };
  }
  if (data.servers && typeof data.servers === "object") {
    for (const [serverId, entry] of Object.entries(data.servers)) {
      const normalized = normalizeServerEntry(entry);
      if (normalized) servers[serverId] = normalized;
    }
    return {
      schemaVersion:
        typeof data.schemaVersion === "number" ? data.schemaVersion : CACHE_SCHEMA_VERSION,
      servers,
    };
  }
  for (const [key, val] of Object.entries(data)) {
    if (key === "schemaVersion") continue;
    const normalized = normalizeServerEntry(val);
    if (normalized) servers[key] = normalized;
  }
  return { schemaVersion: CACHE_SCHEMA_VERSION, servers };
}

async function fetchRepoConfig(repoKey) {
  const id = identityOrNull();
  if (!id) return null;
  const url = `${id.url}/artifactory/api/repositories/${encodeURIComponent(repoKey)}`;
  log.debug("probing repo", { repoKey, url });
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${id.token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      log.debug("repo probe miss", { repoKey, status: res.status });
      return null;
    }
    return await res.json();
  } catch (err) {
    log.warn("repo probe threw", { repoKey, error: err?.message ?? String(err) });
    return null;
  }
}

function repoMatchesPackageType(config, type) {
  const expected = TYPE_PACKAGE_TYPE[type];
  if (!expected || !config?.packageType) return true;
  return String(config.packageType).toLowerCase() === expected;
}

async function probeStandardRepo(type) {
  const candidates = STANDARD_REPO_KEYS[type];
  if (!candidates?.length) return null;
  for (const repoKey of candidates) {
    const config = await fetchRepoConfig(repoKey);
    if (config && repoMatchesPackageType(config, type)) return repoKey;
  }
  return null;
}

function buildResolveMeta(serverId, entry, { via, cacheFile }) {
  return {
    serverId,
    source: packageResolveSource(serverId, { via }),
    cacheFile,
    resolveSource: entry.source ?? via,
    cached_at: entry.cached_at,
    cacheHit: via === "cache",
  };
}

function entryToByType(entry, base) {
  const byType = {};
  for (const [type, repoKey] of Object.entries(entry.repositories ?? {})) {
    if (!repoKey) continue;
    byType[type] = {
      type,
      repoKey,
      baseUrl: urlFor(type, repoKey, base),
    };
  }
  return byType;
}

async function refreshServerCache(serverId) {
  const id = identityOrNull();
  const base = id ? `${id.url}/artifactory` : "";
  const repositories = {};
  const sourcesUsed = new Set();

  const guardConfig = id ? await fetchPackageGuardConfig(id) : null;
  const configuredRepos = guardConfig?.repositories ?? {};

  for (const type of PACKAGE_TYPES) {
    const configuredKey = configuredRepos[type];
    if (configuredKey) {
      repositories[type] = configuredKey;
      sourcesUsed.add("guard-config");
      log.debug("resolved from package-guard config", { type, repoKey: configuredKey });
      continue;
    }
    const probed = await probeStandardRepo(type);
    if (probed) {
      repositories[type] = probed;
      sourcesUsed.add("probe");
      log.debug("resolved from standard probe", { type, repoKey: probed });
    } else {
      log.warn("unresolved", { type, hint: "ask user via jfrog-setup-package-managers" });
    }
  }

  let source = "probe";
  if (sourcesUsed.has("guard-config") && sourcesUsed.has("probe")) source = "mixed";
  else if (sourcesUsed.has("guard-config")) source = "guard-config";

  const entry = {
    repositories,
    cached_at: new Date().toISOString(),
    source,
  };

  const { data: cacheRoot } = await readCacheFile();
  const root = normalizeCacheRoot(cacheRoot);
  root.servers[serverId] = entry;
  await writeCacheFile(root);

  const via = guardConfig
    ? sourcesUsed.has("probe")
      ? "refresh-mixed"
      : "refresh-guard-config"
    : "refresh-probe";
  SESSION.serverId = serverId;
  SESSION.byType = entryToByType(entry, base);
  SESSION.meta = buildResolveMeta(serverId, entry, { via, cacheFile: CACHE_FILE });
  log.debug("cache refreshed", {
    serverId,
    source,
    resolved: Object.keys(repositories).join(","),
    cache: CACHE_FILE,
  });
}

async function loadFreshCacheEntry(serverId) {
  const { data, file } = await readCacheFile();
  const entry = normalizeServerEntry(normalizeCacheRoot(data).servers[serverId]);
  if (!entry || !isEntryFresh(entry)) return null;

  const id = identityOrNull();
  const base = id ? `${id.url}/artifactory` : "";
  SESSION.serverId = serverId;
  SESSION.byType = entryToByType(entry, base);
  SESSION.meta = buildResolveMeta(serverId, entry, { via: "cache", cacheFile: file });
  log.debug("cache hit", {
    serverId,
    source: entry.source,
    ageMs: Date.now() - new Date(entry.cached_at).getTime(),
    cache: file,
  });
  return entry;
}

async function ensureSessionResolved(serverIdHint) {
  const serverId = effectiveServerId(serverIdHint);
  if (SESSION.serverId === serverId && SESSION.byType) return;

  const cached = await loadFreshCacheEntry(serverId);
  if (cached) return;

  await refreshServerCache(serverId);
}

function workspaceOverlayMetaApplied(workspaceRoots, pick, overridden) {
  return {
    workspaceRootsCount: workspaceRoots.length,
    workspaceConfigFile: pick.configFile,
    workspaceOverrides: overridden.join(","),
  };
}

async function applyWorkspaceOverlay(workspaceRoots) {
  const roots = workspaceRoots?.length ? workspaceRoots : [];
  const pick = pickWorkspaceConfigRoot(roots);

  if (!pick) return;

  const ws = await loadWorkspaceConfig(pick);
  if (!ws) {
    log.debug("workspace overlay skipped", { reason: "unreadable", root: pick.root });
    return;
  }

  const id = identityOrNull();
  const base = id ? `${id.url}/artifactory` : "";
  const overridden = [];

  for (const [type, repoKey] of Object.entries(ws.repositories)) {
    if (!repoKey || !PACKAGE_TYPES.includes(type)) continue;
    SESSION.byType[type] = {
      type,
      repoKey,
      baseUrl: urlFor(type, repoKey, base),
    };
    overridden.push(`${type}:${repoKey}`);
  }

  if (!overridden.length) {
    log.debug("workspace overlay skipped", { reason: "no-repositories", root: pick.root });
    return;
  }

  const hadGlobal = SESSION.meta?.resolveSource;
  SESSION.meta = {
    ...SESSION.meta,
    ...workspaceOverlayMetaApplied(roots, pick, overridden),
    resolveSource: hadGlobal ? "mixed-workspace" : "workspace-override",
  };

  log.debug("workspace overlay applied", {
    root: pick.root,
    file: pick.configFile,
    overridden: overridden.join(","),
  });
}

/**
 * Global cache resolve + optional workspace-local overlay (first root with a config file).
 * Call once per sessionStart before resolve(type) loops.
 */
export async function prepareSessionResolve({ serverId, workspaceRoots } = {}) {
  await ensureSessionResolved(serverId);
  await applyWorkspaceOverlay(workspaceRoots);
}

export async function resolve(type, { serverId: serverIdHint } = {}) {
  log.debug("resolve start", { type, serverId: effectiveServerId(serverIdHint) });

  await ensureSessionResolved(serverIdHint);

  const hit = SESSION.byType?.[type];
  if (!hit) {
    log.debug("resolve miss", { type });
    return null;
  }

  const result = {
    ...hit,
    source: SESSION.meta?.source ?? "unknown",
    serverId: SESSION.meta?.serverId,
    cacheFile: SESSION.meta?.cacheFile,
  };
  log.debug("resolved", result);
  return result;
}

/** Force cache refresh (e.g. tests or future --refresh flag). */
export async function invalidateResolveCache(serverIdHint) {
  SESSION.serverId = null;
  SESSION.byType = null;
  SESSION.meta = null;
  const serverId = effectiveServerId(serverIdHint);
  const { data } = await readCacheFile();
  const root = normalizeCacheRoot(data);
  if (root.servers[serverId]) {
    delete root.servers[serverId];
    await writeCacheFile(root);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const type = process.argv[2];
  if (!type) {
    console.error("usage: node lib/resolver.mjs <type>");
    console.error("       types: npm pypi maven go docker helm nuget");
    process.exit(1);
  }
  const result = await resolve(type);
  if (!result) {
    console.error(`No repo resolved for type=${type}.`);
    console.error("Live mode needs a configured `jf` server with an access token (run `jf c add`).");
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
}
