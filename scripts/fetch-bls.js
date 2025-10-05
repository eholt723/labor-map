// scripts/fetch-bls.js
// Orchestrator: run OEWS first, then LAUS (both quota-friendly).

import { spawnSync } from "child_process";

function run(stepName, file) {
  console.log(`\n=== ${stepName} ===`);
  const res = spawnSync(process.execPath, [file], { stdio: "inherit", env: process.env });
  if (res.status !== 0) {
    throw new Error(`${stepName} failed with exit code ${res.status}`);
  }
}

async function main() {
  run("OEWS (swdev_wage)", "scripts/fetch-oews.js");
  run("LAUS (unemployment_rate)", "scripts/fetch-laus.js");
  console.log("\nAll done ✅  latest.json updated and mirrored to docs/ if present.");
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
