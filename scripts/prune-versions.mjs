// Every deploy adds an immutable version and the platform retains them all, so
// the daily schedule alone would leave ~365 bundles a year standing. Keep the
// active one plus the two behind it — enough to roll back — and delete the rest.
//
//   node scripts/prune-versions.mjs        (ns from WDL_NS, default `site`)

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NS = process.env.WDL_NS || "site";
const KEEP_BEHIND = 2;

/** Pure, because deletion is irreversible and this is the part worth testing.
 *  Ordering is numeric — `v10` is newer than `v9` — and the active version is
 *  held out rather than assumed newest, since a rollback leaves it behind. */
export function planPrune(versions, activeVersion, keepBehind = KEEP_BEHIND) {
  const behind = versions
    .filter((v) => v !== activeVersion)
    .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  return {
    keep: [activeVersion, ...behind.slice(0, keepBehind)],
    doomed: behind.slice(keepBehind),
  };
}

async function main() {
  // From the wrangler config, so the name cannot drift from what is deployed.
  const config = await readFile(path.join(ROOT, "wrangler.jsonc"), "utf8");
  const name = /"name"\s*:\s*"([^"]+)"/.exec(config)?.[1];
  if (!name) throw new Error("no worker name in wrangler.jsonc");

  const { stdout } = await run("wdl", ["workers", "--ns", NS, "--json"]);
  const worker = (JSON.parse(stdout).workers ?? []).find((w) => w.name === name);
  if (!worker) {
    console.log(`${NS}/${name} is not deployed; nothing to prune`);
    return 0;
  }

  const { keep, doomed } = planPrune(worker.versions, worker.activeVersion);
  const kept = keep.join(", ");
  if (!doomed.length) {
    console.log(`${NS}/${name}: ${worker.versions.length} version(s), keeping ${kept} — nothing to prune`);
    return 0;
  }

  // Counted apart: one is still standing, the other is gone but still costing
  // storage. Either way the step reports failure.
  let failed = 0;
  let leaked = 0;
  for (const version of doomed) {
    try {
      // --yes: the CLI documents these as confirmed by default, and a release
      // that starts prompting would hang or refuse here with no TTY.
      const { stdout: out } = await run(
        "wdl", ["delete", "version", name, version, "--ns", NS, "--yes", "--json"]);
      // The assets are the bulk of the storage, and the control plane answers
      // 200 having merely failed to queue their cleanup — so this is a leak.
      const assets = JSON.parse(out).assets ?? {};
      for (const warning of assets.warnings ?? []) {
        leaked += 1;
        console.warn(`  ${version}: assets cleanup: ${JSON.stringify(warning)}`);
      }
      // Not a failure: the prefix is still referenced by a version being kept,
      // so its assets go with the last version that uses them.
      if (assets.skippedSharedPrefix) console.log(`  ${version}: assets shared with a retained version`);
    } catch (err) {
      failed += 1;
      console.warn(`  ${version}: ${err.stderr?.trim() || err.message}`);
    }
  }
  const leakNote = leaked ? `, ${leaked} with assets left behind` : "";
  console.log(
    `${NS}/${name}: deleted ${doomed.length - failed}/${doomed.length}${leakNote}, keeping ${kept}`);
  return failed || leaked ? 1 : 0;
}

// Importing this module must not delete anything.
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
