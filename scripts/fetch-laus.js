// scripts/fetch-laus.js
// LAUS statewide unemployment rate (seasonally adjusted) for lower-48 + DC.
// Single POST to BLS with latest:true to minimize quota usage.
// Gracefully preserves existing data if quota is hit instead of crashing.

import fs from "fs";
import path from "path";
import axios from "axios";

const OUT_FILE = path.join("data", "latest.json");
const DOCS_OUT = path.join("docs", "data", "latest.json");

// Lower-48 + DC FIPS (skip AK=02, HI=15)
const STATES = {
  AL:"01", AZ:"04", AR:"05", CA:"06", CO:"08", CT:"09", DE:"10", FL:"12",
  GA:"13", ID:"16", IL:"17", IN:"18", IA:"19", KS:"20", KY:"21", LA:"22",
  ME:"23", MD:"24", MA:"25", MI:"26", MN:"27", MS:"28", MO:"29", MT:"30",
  NE:"31", NV:"32", NH:"33", NJ:"34", NM:"35", NY:"36", NC:"37", ND:"38",
  OH:"39", OK:"40", OR:"41", PA:"42", RI:"44", SC:"45", SD:"46", TN:"47",
  TX:"48", UT:"49", VT:"50", VA:"51", WA:"53", WV:"54", WI:"55", WY:"56", DC:"11"
};

// Build statewide SA unemployment rate ID: LASST{FIPS2}00000000000003
function buildSeriesId(fips2) {
  const area = `ST${fips2}${"0".repeat(11)}`; // ST + FIPS2 + 11 zeros
  return `LA${"S"}${area}03`;                 // LASST..03
}

async function fetchLatest(seriesIds, key) {
  const payload = { seriesid: seriesIds, latest: true };
  if (key) payload.registrationkey = key;

  const resp = await axios.post(
    "https://api.bls.gov/publicAPI/v2/timeseries/data/",
    payload,
    { headers: { "Content-Type": "application/json" }, timeout: 30000 }
  );

  if (resp?.data?.status !== "REQUEST_SUCCEEDED") {
    const msg = JSON.stringify(resp?.data || {}, null, 2);
    // If quota, don't blow up the whole run — caller will handle.
    throw new Error(`BLS API failure: ${msg}`);
  }
  return resp.data.Results.series || [];
}

async function main() {
  const key = process.env.BLS_API_KEY || process.env.bls_api_key;
  const allSeriesIds = Object.values(STATES).map(buildSeriesId);

  let mergedSeries;
  try {
    // Single request (49 series) with latest:true keeps requests minimal
    mergedSeries = await fetchLatest(allSeriesIds, key);
  } catch (e) {
    const m = String(e.message || e);
    if (m.includes("daily threshold") || m.includes("REQUEST_NOT_PROCESSED")) {
      console.warn("LAUS quota hit; preserving existing unemployment_rate and continuing.");
      // Don’t write anything new, just ensure docs mirror stays in sync with existing file.
      const out = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, "utf-8")) : {};
      fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
      fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
      if (fs.existsSync("docs")) {
        fs.mkdirSync(path.dirname(DOCS_OUT), { recursive: true });
        fs.copyFileSync(OUT_FILE, DOCS_OUT);
      }
      return;
    }
    throw e; // real error
  }

  // Merge into existing JSON (don’t clobber other fields like swdev_wage)
  const out = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, "utf-8")) : {};
  let filled = 0;

  for (const s of mergedSeries) {
    const id = s.seriesID;            // e.g., LASST060000000000003
    const fips2 = id.substring(5, 7); // L A S S T {FIPS2} ...
    const abbr = Object.keys(STATES).find(k => STATES[k] === fips2);
    if (!abbr) continue;

    const row = (s.data || [])[0];    // latest:true returns one row
    if (!row || row.value === "") {
      if (!out[abbr]) out[abbr] = {};
      if (!("unemployment_rate" in out[abbr])) out[abbr].unemployment_rate = null;
      continue;
    }

    const v = parseFloat(row.value);
    if (!out[abbr]) out[abbr] = {};
    out[abbr].unemployment_rate = Number.isFinite(v) ? v : null;
    filled++;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_FILE} — updated unemployment_rate for ${filled}/${Object.keys(STATES).length} states`);

  if (fs.existsSync("docs")) {
    fs.mkdirSync(path.dirname(DOCS_OUT), { recursive: true });
    fs.copyFileSync(OUT_FILE, DOCS_OUT);
    console.log(`Mirrored ${DOCS_OUT}`);
  }
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
