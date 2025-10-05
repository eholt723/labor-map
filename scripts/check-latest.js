import fs from "fs";

const path = "data/latest.json";
if (!fs.existsSync(path)) {
  console.error("Missing data/latest.json");
  process.exit(1);
}
const j = JSON.parse(fs.readFileSync(path, "utf-8"));

let swCount = 0, unempCount = 0;
for (const [state, rec] of Object.entries(j)) {
  if (Number.isFinite(rec?.swdev_wage)) swCount++;
  if (Number.isFinite(rec?.unemployment_rate)) unempCount++;
}
console.log("States with unemployment_rate:", unempCount);
console.log("States with swdev_wage:", swCount);

// Show a few sample states
for (const s of ["CA","TX","FL","NY","IL","WA","DC"]) {
  if (j[s]) console.log(s, j[s]);
}
