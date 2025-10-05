// scripts/test-oews-one.js
import axios from "axios";

const SEASONAL = "U";          // unadjusted
const AREATYPE = "S";          // state
const INDUSTRY = "000000";     // cross-industry
const SOC = "151252";          // Software Developers
const DATATYPE = "04";         // Annual mean wage
const FIPS_CA = "06";          // California
const area_code = `${FIPS_CA}00000`; // 7-digit area_code => '0600000'

// Series ID per oe.txt: OE + U + S + area(7) + industry(6) + occupation(6) + datatype(2)
const seriesId = `OE${SEASONAL}${AREATYPE}${area_code}${INDUSTRY}${SOC}${DATATYPE}`;
console.log("Testing series:", seriesId);

const payload = {
  seriesid: [seriesId],
  latest: true,
  ...(process.env.BLS_API_KEY ? { registrationkey: process.env.BLS_API_KEY } : {})
};

try {
  const r = await axios.post("https://api.bls.gov/publicAPI/v2/timeseries/data/", payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 60000
  });
  console.log("Status:", r.data.status);
  console.dir(r.data.Results?.series?.[0] || r.data, { depth: null });
} catch (e) {
  console.error("Request failed", e.response?.status, e.response?.data || e.message);
  process.exit(1);
}
