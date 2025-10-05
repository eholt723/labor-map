// scripts/fetch-bls.js
// Orchestrator to fetch BLS-derived data for the map.
// Runs LAUS (unemployment_rate) then OEWS (swdev_wage).

import { spawnSync } from "child_process";

function run(stepName, file) {
  console.log(`\n=== ${stepName} ===`);
  const res = spawnSync(process.execPath, [file], { stdio: "inherit", env: process.env });
  if (res.status !== 0) {
    throw new Error(`${stepName} failed with exit code ${res.status}`);
  }
}

async function main() {
  run("LAUS (unemployment_rate)", "scripts/fetch-laus.js");
  run("OEWS (swdev_wage)", "scripts/fetch-oews.js");
  console.log("\nAll done ✅  latest.json updated and mirrored to docs/ if present.");
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
