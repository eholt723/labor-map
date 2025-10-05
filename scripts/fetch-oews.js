// scripts/fetch-oews.js
// OEWS Annual Mean Wage for Software Developers (SOC 15-1252) by state.
// Uses the BLS Public Data API (no file downloads).
//
// Correct OEWS series layout (25 chars total):
//   OE + seasonal(1) + areatype(1) + area(7) + industry(6) + occupation(6) + datatype(2)
// We want: seasonal=U (unadjusted), areatype=S (state),
//          area = <FIPS2> + '00000'  (e.g., CA -> '0600000'),
//          industry=000000 (cross-industry),
//          occupation=151252 (Software Developers),
//          datatype=04 (Annual mean wage).
//
// Example (CA): OEUS060000000000015125204   <-- 25 chars

import fs from "fs";
import path from "path";
import axios from "axios";

const OUT_FILE = path.join("data", "latest.json");
const DOCS_OUT = path.join("docs", "data", "latest.json");

// Fixed codes for this query
const SEASONAL = "U";           // unadjusted
const AREATYPE = "S";           // state
const INDUSTRY = "000000";      // cross-industry (6 digits)
const SOC = "151252";           // Software Developers
const PRIMARY_DATATYPE = "04";  // Annual mean wage (preferred)
// Optional fallback (hourly mean wage -> annual via *2080)
const FALLBACK_DATATYPES = ["03"];

// Lower-48 + DC FIPS (skip AK=02, HI=15)
const STATES = {
  AL:"01", AZ:"04", AR:"05", CA:"06", CO:"08", CT:"09", DE:"10", FL:"12",
  GA:"13", ID:"16", IL:"17", IN:"18", IA:"19", KS:"20", KY:"21", LA:"22",
  ME:"23", MD:"24", MA:"25", MI:"26", MN:"27", MS:"28", MO:"29", MT:"30",
  NE:"31", NV:"32", NH:"33", NJ:"34", NM:"35", NY:"36", NC:"37", ND:"38",
  OH:"39", OK:"40", OR:"41", PA:"42", RI:"44", SC:"45", SD:"46", TN:"47",
  TX:"48", UT:"49", VT:"50", VA:"51", WA:"53", WV:"54", WI:"55", WY:"56", DC:"11"
};

// Build 7-digit OEWS area for statewide series: <FIPS2> + '00000'
const areaFromFips = (fips2) => `${fips2}00000`;

// Compose the 25-char series ID (NO ownership block)
const makeSeriesId = (fips2, datatype) =>
  `OE${SEASONAL}${AREATYPE}${areaFromFips(fips2)}${INDUSTRY}${SOC}${datatype}`;

async function fetchLatest(seriesIds, key) {
  const payload = { seriesid: seriesIds, latest: true, ...(key ? { registrationkey: key } : {}) };
  const resp = await axios.post(
    "https://api.bls.gov/publicAPI/v2/timeseries/data/",
    payload,
    { headers: { "Content-Type": "application/json" }, timeout: 60000 }
  );
  if (resp?.data?.status !== "REQUEST_SUCCEEDED") {
    throw new Error("BLS API failure: " + JSON.stringify(resp?.data || {}, null, 2));
  }
  const out = {};
  for (const s of resp.data.Results?.series || []) {
    const row = (s.data || [])[0];
    if (row && row.value !== "") out[s.seriesID] = Number(row.value);
  }
  return out;
}

async function main() {
  const key = process.env.BLS_API_KEY || process.env.bls_api_key;
  console.log("BLS key detected:", key ? key.slice(0, 6) + "…" : "(none)");

  const states = Object.entries(STATES); // [ [abbr, fips2], ... ]

  // Build all primary series IDs
  const primaryIds = states.map(([_, fips]) => makeSeriesId(fips, PRIMARY_DATATYPE));

  // Show a couple examples — should match your working one-off test format
  console.log(
    "Sample series IDs:",
    makeSeriesId("06", PRIMARY_DATATYPE), // CA
    makeSeriesId("48", PRIMARY_DATATYPE)  // TX
  );

  // Try one POST with all 49 series
  let valuesPrimary = {};
  try {
    valuesPrimary = await fetchLatest(primaryIds, key);
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes("daily threshold") || msg.includes("REQUEST_NOT_PROCESSED")) {
      console.warn("OEWS quota hit; preserving existing swdev_wage and continuing.");
      return mirrorExistingOnly();
    }
    throw e;
  }

  // If nothing came back (unlikely now), retry in mini-batches of 10
  if (Object.keys(valuesPrimary).length === 0) {
    console.warn("OEWS: 0/49 values on the single POST — retrying in mini-batches of 10.");
    valuesPrimary = {};
    const queue = primaryIds.slice();
    while (queue.length) {
      const chunk = queue.splice(0, 10);
      try {
        const res = await fetchLatest(chunk, key);
        Object.assign(valuesPrimary, res);
        console.log(`Mini-batch got ${Object.keys(res).length}/${chunk.length} values`);
      } catch (e) {
        const msg = String(e.message || e);
        if (msg.includes("daily threshold") || msg.includes("REQUEST_NOT_PROCESSED")) {
          console.warn("OEWS fallback quota hit during mini-batch; preserving current results.");
          break;
        } else {
          console.warn("OEWS mini-batch error (continuing):", msg);
        }
      }
    }
  }

  // Optional fallback: hourly mean wage (03) -> convert to annual (x2080)
  let valuesFallback = {};
  const missing = states.filter(([_, fips]) => !(makeSeriesId(fips, PRIMARY_DATATYPE) in valuesPrimary));
  if (missing.length && FALLBACK_DATATYPES.length) {
    for (const dt of FALLBACK_DATATYPES) {
      const ids = missing.map(([_, fips]) => makeSeriesId(fips, dt));
      const queue = ids.slice();
      while (queue.length) {
        const chunk = queue.splice(0, 10);
        try {
          const res = await fetchLatest(chunk, key);
          Object.assign(valuesFallback, res);
        } catch (e) {
          const msg = String(e.message || e);
          if (msg.includes("daily threshold") || msg.includes("REQUEST_NOT_PROCESSED")) {
            console.warn("OEWS fallback quota hit; stopping fallback attempts.");
            break;
          }
        }
      }
      // remove filled
      for (let i = missing.length - 1; i >= 0; i--) {
        const [_, fips] = missing[i];
        if (makeSeriesId(fips, dt) in valuesFallback) missing.splice(i, 1);
      }
      if (!missing.length) break;
    }
  }

  // Merge into latest.json
  const out = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, "utf-8")) : {};
  let swCount = 0;

  for (const [abbr, fips] of states) {
    let val = valuesPrimary[makeSeriesId(fips, PRIMARY_DATATYPE)];
    if (val == null) {
      const hourly = valuesFallback[makeSeriesId(fips, "03")];
      if (Number.isFinite(hourly)) val = Math.round(hourly * 2080);
    }
    if (!out[abbr]) out[abbr] = { unemployment_rate: null, swdev_wage: null };
    if (Number.isFinite(val)) {
      out[abbr].swdev_wage = val;
      swCount++;
    } else if (!("swdev_wage" in out[abbr])) {
      out[abbr].swdev_wage = null;
    }
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_FILE} — swdev_wage filled for ${swCount}/${states.length} states`);

  if (fs.existsSync("docs")) {
    fs.mkdirSync(path.dirname(DOCS_OUT), { recursive: true });
    fs.copyFileSync(OUT_FILE, DOCS_OUT);
    console.log(`Mirrored ${DOCS_OUT}`);
  }
}

function mirrorExistingOnly() {
  const out = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, "utf-8")) : {};
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  if (fs.existsSync("docs")) {
    fs.mkdirSync(path.dirname(DOCS_OUT), { recursive: true });
    fs.copyFileSync(OUT_FILE, DOCS_OUT);
  }
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
