// scripts/fetch-laus.js
// LAUS statewide unemployment rate (seasonally adjusted) for lower-48 + DC.
// Correct ID: LA + S + ST{FIPS2} + 11 zeros + 03  -> e.g., LASST060000000000003

import fs from "fs";
import path from "path";
import axios from "axios";

const OUT_FILE = path.join("data", "latest.json");

// Lower-48 + DC FIPS (skip AK=02, HI=15)
const STATES = {
  AL: "01", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10", FL: "12",
  GA: "13", ID: "16", IL: "17", IN: "18", IA: "19", KS: "20", KY: "21", LA: "22",
  ME: "23", MD: "24", MA: "25", MI: "26", MN: "27", MS: "28", MO: "29", MT: "30",
  NE: "31", NV: "32", NH: "33", NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38",
  OH: "39", OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46", TN: "47",
  TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55", WY: "56", DC: "11"
};

// Build correct statewide SA unemployment rate ID: LASST{FIPS2}00000000000003
function buildSeriesId(fips2) {
  const area = `ST${fips2}${"0".repeat(11)}`; // 15-char area code: ST + FIPS2 + 11 zeros
  return `LA${"S"}${area}03`;                 // "LA" + "S" + area + "03" => LASST..03  ✅
}

// Chunk helper
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchBatch(seriesIds, startyear, endyear, key) {
  const payload = { seriesid: seriesIds, startyear, endyear };
  if (key) payload.registrationkey = key;
  const resp = await axios.post(
    "https://api.bls.gov/publicAPI/v2/timeseries/data/",
    payload,
    { headers: { "Content-Type": "application/json" }, timeout: 30000 }
  );
  if (!resp?.data || resp.data.status !== "REQUEST_SUCCEEDED") {
    throw new Error("BLS API failure: " + JSON.stringify(resp?.data || {}, null, 2));
  }
  return resp.data.Results.series || [];
}

async function main() {
  const now = new Date();
  const startyear = String(now.getFullYear() - 2);
  const endyear = String(now.getFullYear());
  const key = process.env.BLS_API_KEY || process.env.bls_api_key;

  const allSeriesIds = Object.values(STATES).map(buildSeriesId);
  const batches = chunk(allSeriesIds, 25); // avoid payload truncation

  console.log(`Requesting ${allSeriesIds.length} LAUS series in ${batches.length} batch(es) from ${startyear}-${endyear}…`);

  const mergedSeries = [];
  for (let i = 0; i < batches.length; i++) {
    console.log(`Batch ${i + 1}/${batches.length}: ${batches[i].length} series`);
    const seriesList = await fetchBatch(batches[i], startyear, endyear, key);
    mergedSeries.push(...seriesList);
  }

  const out = {};
  let filled = 0;

  for (const s of mergedSeries) {
    const id = s.seriesID;              // e.g., LASST060000000000003
    const fips2 = id.substring(5, 7);   // L A S S T {FIPS2} ...
    const abbr = Object.keys(STATES).find(k => STATES[k] === fips2);
    if (!abbr) continue;

    // Debug peek (optional: comment out later)
    //console.log(abbr, (s.data || []).slice(0, 3));

    // Prefer latest monthly (M01–M12); else allow M13 (annual avg)
    let row = (s.data || []).find(d => d && d.value !== "" && /^M(0[1-9]|1[0-2])$/.test(d.period));
    if (!row) row = (s.data || []).find(d => d && d.value !== "" && d.period === "M13");

    if (!row) {
      console.warn(`No values for ${abbr} (${id})`);
      out[abbr] = { openings_rate: null, swdev_wage: null };
      continue;
    }

    const v = parseFloat(row.value);
    out[abbr] = {
      openings_rate: Number.isFinite(v) ? v : null, // LAUS unemployment rate (%)
      swdev_wage: null
    };
    filled++;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_FILE} — filled ${filled}/${Object.keys(STATES).length} states`);

  const docsOut = path.join("docs", "data", "latest.json");
  if (fs.existsSync("docs")) {
    fs.mkdirSync(path.dirname(docsOut), { recursive: true });
    fs.copyFileSync(OUT_FILE, docsOut);
    console.log(`Mirrored ${docsOut}`);
  }
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
