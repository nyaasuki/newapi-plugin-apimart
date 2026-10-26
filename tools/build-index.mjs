// Generates index.json (New API Plugin Marketplace Index v1) from the plugin
// sources under plugins/tasks/<key>/<version>/plugin.js.
//
//   node tools/build-index.mjs          write index.json
//   node tools/build-index.mjs --check  fail if index.json is stale
//
// Display fields come from each plugin's compiled `meta`, and every version
// carries the sha256 of its plugin.js, which New API verifies at install time.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const INDEX_NAME = "APIMart Plugins for New API";

globalThis.utils = globalThis.utils || {};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function compareSemver(a, b) {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

const normalizeProtocol = (p) => (typeof p === "string" ? { name: p } : p);

async function buildIndex() {
  const plugins = [];
  const tasksDir = path.join(root, "plugins", "tasks");
  for (const key of readdirSync(tasksDir).sort()) {
    const keyDir = path.join(tasksDir, key);
    const versions = readdirSync(keyDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(compareSemver);
    const entries = [];
    let latestMeta = null;
    for (const version of versions) {
      const rel = `plugins/tasks/${key}/${version}/plugin.js`;
      const file = path.join(root, rel);
      const bytes = readFileSync(file);
      const { meta } = await import(pathToFileURL(file).href + "?v=" + sha256(bytes));
      if (meta.key !== key) throw new Error(`${rel}: meta.key ${meta.key} does not match directory ${key}`);
      if (meta.version !== version) throw new Error(`${rel}: meta.version ${meta.version} does not match directory ${version}`);
      if (!existsSync(path.join(path.dirname(file), "CHANGELOG.md"))) throw new Error(`${rel}: missing CHANGELOG.md`);
      const entry = { version, path: rel, sha256: sha256(bytes), minApiVersion: meta.apiVersion, kind: "task" };
      if (meta.allowedHosts && meta.allowedHosts.length) entry.allowedHosts = meta.allowedHosts;
      if (meta.baseUrl) entry.baseUrl = meta.baseUrl;
      if (meta.auth) entry.auth = typeof meta.auth === "string" ? meta.auth : meta.auth.type;
      entries.push(entry);
      latestMeta = meta;
    }
    if (!latestMeta) continue;
    const plugin = { key, name: latestMeta.name };
    if (latestMeta.icon) plugin.icon = latestMeta.icon;
    for (const ext of ["svg", "png"]) {
      const icon = `plugins/tasks/${key}/icon.${ext}`;
      if (existsSync(path.join(root, icon))) {
        plugin.iconFile = { path: icon, sha256: sha256(readFileSync(path.join(root, icon))) };
        break;
      }
    }
    if (latestMeta.website) plugin.website = latestMeta.website;
    if (latestMeta.sortPriority) plugin.sortPriority = latestMeta.sortPriority;
    if (latestMeta.description) plugin.description = typeof latestMeta.description === "string" ? { en: latestMeta.description } : latestMeta.description;
    plugin.routes = latestMeta.routes || null;
    plugin.protocols = (latestMeta.protocols || []).map(normalizeProtocol);
    plugin.usageSchema = latestMeta.usageSchema || null;
    plugin.usageExamples = latestMeta.usageExamples || null;
    plugin.usageProfiles = latestMeta.usageProfiles || null;
    if (latestMeta.channelTypes) plugin.channelTypes = latestMeta.channelTypes;
    plugin.models = latestMeta.models;
    plugin.latest = latestMeta.version;
    plugin.versions = entries;
    plugins.push(plugin);
  }
  return JSON.stringify({ indexVersion: 1, name: INDEX_NAME, plugins }, null, 2) + "\n";
}

const index = await buildIndex();
const target = path.join(root, "index.json");
if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== index) {
    console.error("index.json is stale; run: node tools/build-index.mjs");
    process.exit(1);
  }
  console.log("index.json is up to date");
} else {
  writeFileSync(target, index);
  console.log("wrote index.json");
}
