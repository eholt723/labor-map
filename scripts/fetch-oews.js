// scripts/fetch-oews.js
// Get OEWS Annual Mean Wage for Software Developers (SOC 15-1252) by state,
// without downloading mapping files. We construct series IDs directly and call
// the BLS Public Data API.
//
// Series ID structure used here (length 20):
//   1-2   : "OE"        (OEWS prefix)
//   3     : seasonal    ("U" - not seasonally adjusted)
//   4     : areatype    ("S" - state)
//   5-6   : state_code  (two digits, e.g., "06" for CA)
//   7-12  : industry    ("000000" cross-industry)
//   13-18 : occupation  ("151252" Software Developers)
//   19-20 : datatype    ("04" Annual mean wage)
//
// We try datatype "04" first (annual mean wage). If a state returns no data,
// we optionally fall back to other wage datatypes just in case.
//
// References:
// - BLS Series ID format guide (general): https://www.bls.gov/help/hlpforma.htm
// - OEWS latest annual release date/context: https://www.bls.gov/oes/tables.htm

import fs from "fs";
import path from "path";
import axios from "axios";

const OUT_FILE = path.join("data", "latest.json");
const DOCS_OUT = path.join("docs", "data", "latest.json");

const SEASONAL = "U";      // OEWS is unadjusted
const AREATYPE = "S";      // state
const INDUSTRY = "000000"; // cross-industry
const SOC = "151252";      // Software Developers
// We primarily want Annual mean wage:
const PRIMARY_DATATYPE = "04"; // Annual mean wage (expected)
// Optional fallbacks (comment out if you want ONLY 04)
const FALLBACK_DATATYPES = ["03"]; // 03 = Hourly mean wage (used as a last resort)

/** Lower-48 + DC */
const STATES_48_DC = {
  AL:"01", AZ:"04", AR:"05", CA:"06", CO:"08", CT:"09", DE:"10", FL:"12",
  GA:"13", ID:"16", IL:"17", IN:"18", IA:"19", KS:"20", KY:"21", LA:"22",
  ME:"23", MD:"24", MA:"25", MI:"26", MN:"27", MS:"28", MO:"29", MT:"30",
  NE:"31", NV:"32", NH:"33", NJ:"34", NM:"35", NY:"36", NC:"37", ND:"38",
  OH:"39", OK:"40", OR:"41", PA:"42", RI:"44", SC:"45", SD:"46", TN:"47",
  TX:"48", UT:"49", VT:"50", VA:"51", WA:"53", WV:"54", WI:"55", WY:"56", DC:"11"
};

function makeSeriesId(stateCode, datatype) {
  return `OE${SEASONAL}${AREATYPE}${stateCode}${INDUSTRY}${SOC}${datatype}`;
}

async function fetchLatest(seriesIds, blsKey) {
  const payload = { seriesid: seriesIds, latest: true };
  if (blsKey) payload.registrationkey = blsKey;

  const resp = await axios.post(
    "https://api.bls.gov/publicAPI/v2/timeseries/data/",
    payload,
    { headers: { "Content-Type": "application/json" }, timeout: 60000 }
  );
  if (resp?.data?.status !== "REQUEST_SUCCEEDED") {
    throw new Error("BLS API failure: " + JSON.stringify(resp?.data || {}, null, 2));
  }
  const out = {};
  for (const s of resp.data.Results.series || []) {
    const row = (s.data || [])[0];
    if (row && row.value !== "") out[s.seriesID] = Number(row.value);
  }
  return out;
}

async function main() {
  const key = process.env.BLS_API_KEY || process.env.bls_api_key;

  // Build all "primary" series IDs (datatype 04) for the states
  const states = Object.entries(STATES_48_DC); // [ [abbr, code], ... ]
  const primaryIds = states.map(([_, code]) => makeSeriesId(code, PRIMARY_DATATYPE));

  // Query in chunks of 25 (BLS API limit per request)
  const chunks = [];
  for (let i = 0; i < primaryIds.length; i += 25) chunks.push(primaryIds.slice(i, i + 25));

  const valuesPrimary = {};
  for (const chunk of chunks) {
    const res = await fetchLatest(chunk, key);
    Object.assign(valuesPrimary, res);
  }

  // Determine which states didn't return a primary value (rare, but handle it)
  const missing = [];
  for (const [abbr, code] of states) {
    const sid = makeSeriesId(code, PRIMARY_DATATYPE);
    if (!(sid in valuesPrimary)) missing.push([abbr, code]);
  }

  // Optional: try fallbacks for missing states (e.g., hourly mean wage "03")
  const valuesFallback = {};
  if (missing.length && FALLBACK_DATATYPES.length) {
    for (const dt of FALLBACK_DATATYPES) {
      const ids = missing.map(([_, code]) => makeSeriesId(code, dt));
      for (let i = 0; i < ids.length; i += 25) {
        const res = await fetchLatest(ids.slice(i, i + 25), key);
        Object.assign(valuesFallback, res);
      }
      // Remove states that got filled by this fallback
      for (let i = missing.length - 1; i >= 0; i--) {
        const [abbr, code] = missing[i];
        if (valuesFallback[makeSeriesId(code, dt)] != null) missing.splice(i, 1);
      }
      if (!missing.length) break;
    }
  }

  // Merge into latest.json as swdev_wage (annual mean wage USD).
  // If we only have hourly mean wage (fallback 03), we multiply by 2080 to estimate annual.
  const out = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, "utf-8")) : {};
  const abbrByCode = Object.fromEntries(states.map(([abbr, code]) => [code, abbr]));

  for (const [abbr, code] of states) {
    const sidAnnual = makeSeriesId(code, PRIMARY_DATATYPE);
    let val = valuesPrimary[sidAnnual];

    // Fallback: hourly mean wage -> convert to annual approx (hourly * 2080)
    if (val == null) {
      const sidHourly = makeSeriesId(code, "03");
      const hourly = valuesFallback[sidHourly];
      if (Number.isFinite(hourly)) val = Math.round(hourly * 2080);
    }

    if (!out[abbr]) out[abbr] = { unemployment_rate: null, swdev_wage: null };
    if (Number.isFinite(val)) out[abbr].swdev_wage = val;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_FILE}`);

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
