// scripts/fetch-oews.js
// OEWS Annual Mean Wage for Software Developers (SOC 15-1252) by state.
// FIX: Use 7-digit *area_code* (FIPS2 + '00000') in the series ID.
// Series ID layout (from BLS oe.txt):
//   OE + seasonal(1) + areatype(1) + area_code(7) + industry(6) + occupation(6) + datatype(2)
// We want: seasonal=U, areatype=S (state), area_code=SS00000, industry=000000 (cross-industry),
// occupation=151252 (Software Developers), datatype=04 (Annual mean wage).
//
// Ref: BLS OEWS series structure in oe.txt (Section 4/5). 

import fs from "fs";
import path from "path";
import axios from "axios";

const OUT_FILE = path.join("data", "latest.json");
const DOCS_OUT = path.join("docs", "data", "latest.json");

const SEASONAL = "U";
const AREATYPE = "S";
const INDUSTRY = "000000";
const SOC = "151252";
const PRIMARY_DATATYPE = "04";     // Annual mean wage
const FALLBACK_DATATYPES = ["03"]; // Hourly mean wage -> will convert to annual if used

// Lower-48 + DC FIPS (skip AK=02, HI=15)
const STATES = {
  AL:"01", AZ:"04", AR:"05", CA:"06", CO:"08", CT:"09", DE:"10", FL:"12",
  GA:"13", ID:"16", IL:"17", IN:"18", IA:"19", KS:"20", KY:"21", LA:"22",
  ME:"23", MD:"24", MA:"25", MI:"26", MN:"27", MS:"28", MO:"29", MT:"30",
  NE:"31", NV:"32", NH:"33", NJ:"34", NM:"35", NY:"36", NC:"37", ND:"38",
  OH:"39", OK:"40", OR:"41", PA:"42", RI:"44", SC:"45", SD:"46", TN:"47",
  TX:"48", UT:"49", VT:"50", VA:"51", WA:"53", WV:"54", WI:"55", WY:"56", DC:"11"
};

// Build 7-digit area_code for state: FIPS2 + '00000'
function areaCodeFromFips(fips2) {
  return `${fips2}00000`; // e.g., '06' -> '0600000'
}

function makeSeriesIdFromArea(area_code, datatype) {
  return `OE${SEASONAL}${AREATYPE}${area_code}${INDUSTRY}${SOC}${datatype}`;
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

  // Build series IDs for all states with datatype 04 (annual mean wage)
  const states = Object.entries(STATES); // [ [abbr, fips2], ... ]
  const primaryIds = states.map(([_, fips]) =>
    makeSeriesIdFromArea(areaCodeFromFips(fips), PRIMARY_DATATYPE)
  );

  // Query in chunks of 25
  const chunks = [];
  for (let i = 0; i < primaryIds.length; i += 25) chunks.push(primaryIds.slice(i, i + 25));

  const valuesPrimary = {};
  for (const chunk of chunks) {
    const res = await fetchLatest(chunk, key);
    Object.assign(valuesPrimary, res);
  }

  // Any states with no primary value?
  const missing = [];
  for (const [abbr, fips] of states) {
    const sid = makeSeriesIdFromArea(areaCodeFromFips(fips), PRIMARY_DATATYPE);
    if (!(sid in valuesPrimary)) missing.push([abbr, fips]);
  }

  // Optional fallback: hourly mean wage (03) -> convert to annual (x2080)
  const valuesFallback = {};
  if (missing.length && FALLBACK_DATATYPES.length) {
    for (const dt of FALLBACK_DATATYPES) {
      const ids = missing.map(([_, fips]) => makeSeriesIdFromArea(areaCodeFromFips(fips), dt));
      for (let i = 0; i < ids.length; i += 25) {
        const res = await fetchLatest(ids.slice(i, i + 25), key);
        Object.assign(valuesFallback, res);
      }
      // Remove those we just filled
      for (let i = missing.length - 1; i >= 0; i--) {
        const [abbr, fips] = missing[i];
        if (valuesFallback[makeSeriesIdFromArea(areaCodeFromFips(fips), dt)] != null) {
          missing.splice(i, 1);
        }
      }
      if (!missing.length) break;
    }
  }

  // Merge into latest.json
  const out = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, "utf-8")) : {};
  for (const [abbr, fips] of states) {
    const sidAnnual = makeSeriesIdFromArea(areaCodeFromFips(fips), PRIMARY_DATATYPE);
    let val = valuesPrimary[sidAnnual];

    if (val == null) {
      // fallback hourly -> annual approx
      const sidHourly = makeSeriesIdFromArea(areaCodeFromFips(fips), "03");
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
