/* ---- METRICS & LABELS ---- */
const METRIC_LABELS = {
  unemployment_rate: "Unemployment Rate (LAUS, %)",
  swdev_wage: "Software Dev Annual Mean Wage (OEWS)"
};
function formatValue(key, v) {
  if (v == null || Number.isNaN(v)) return "—";
  if (key === "swdev_wage") return "$" + Math.round(v).toLocaleString();
  if (key === "unemployment_rate") return (+v).toFixed(1) + "%";
  return String(v);
}
function formatAsOf(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
}

/* us-atlas state names -> USPS abbr */
const NAME_TO_ABBR = {
  "Alabama":"AL","Alaska":"AK","Arizona":"AZ","Arkansas":"AR","California":"CA","Colorado":"CO",
  "Connecticut":"CT","Delaware":"DE","Florida":"FL","Georgia":"GA","Hawaii":"HI","Idaho":"ID",
  "Illinois":"IL","Indiana":"IN","Iowa":"IA","Kansas":"KS","Kentucky":"KY","Louisiana":"LA",
  "Maine":"ME","Maryland":"MD","Massachusetts":"MA","Michigan":"MI","Minnesota":"MN",
  "Mississippi":"MS","Missouri":"MO","Montana":"MT","Nebraska":"NE","Nevada":"NV",
  "New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC",
  "North Dakota":"ND","Ohio":"OH","Oklahoma":"OK","Oregon":"OR","Pennsylvania":"PA",
  "Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD","Tennessee":"TN","Texas":"TX",
  "Utah":"UT","Vermont":"VT","Virginia":"VA","Washington":"WA","West Virginia":"WV",
  "Wisconsin":"WI","Wyoming":"WY","District of Columbia":"DC","Puerto Rico":"PR"
};
const LOWER48_ABBRS = new Set([
  "AL","AZ","AR","CA","CO","CT","DE","FL","GA","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA",
  "RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"
]);

/* ---- STATE ---- */
let map, geoLayer;
let currentMetric = "unemployment_rate";
let selectionHistory = []; // [most recent, ...] capped at 3
const isMobile = window.matchMedia("(max-width: 980px)").matches;

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  // Map options: desktop locked; mobile can pan
  map = L.map("map", {
    attributionControl: false,
    zoomControl: false,
    dragging: isMobile,          // enable pan on phones
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    tap: isMobile,               // allow touch panning
    zoomSnap: isMobile ? 0.5 : 1 // smoother zoom if we ever enable it
  });

  // Load metrics (prefer /data, fallback /docs/data for GH Pages)
  let metricsByAbbr = {};
  let lastUpdatedText = null;

  try {
    const m = await fetch("data/latest.json", { cache: "no-cache" });
    if (m.ok) {
      metricsByAbbr = await m.json();
      lastUpdatedText = m.headers.get("last-modified");
    } else {
      const m2 = await fetch("docs/data/latest.json", { cache: "no-cache" });
      if (m2.ok) {
        metricsByAbbr = await m2.json();
        lastUpdatedText = m2.headers.get("last-modified");
      }
    }
  } catch {
    try {
      const m2 = await fetch("docs/data/latest.json", { cache: "no-cache" });
      if (m2.ok) {
        metricsByAbbr = await m2.json();
        lastUpdatedText = m2.headers.get("last-modified");
      }
    } catch {}
  }

  // Show "Updated:" in the info box
  const embedded = metricsByAbbr?.__meta?.as_of || metricsByAbbr?.as_of || null;
  const infoEl = document.getElementById("infoUpdated");
  if (infoEl) infoEl.textContent = embedded ? `Updated: ${formatAsOf(embedded)}`
                                            : (lastUpdatedText ? `Updated: ${formatAsOf(lastUpdatedText)}` : "Updated: —");

  // Load states and attach metrics
  const topoResp = await fetch("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json", { cache: "no-cache" });
  const topoJson = await topoResp.json();
  const allStates = topojson.feature(topoJson, topoJson.objects.states);

  allStates.features.forEach(f => {
    const name = f.properties.name;
    const abbr = NAME_TO_ABBR[name] || null;
    f.properties.abbr = abbr;
    f.properties.metrics = metricsByAbbr[abbr] || {};
  });

  const statesGeo = {
    type: "FeatureCollection",
    features: allStates.features.filter(f => LOWER48_ABBRS.has(f.properties.abbr))
  };

  // View/zoom behavior: desktop locked at z=5; mobile fits all states
  if (isMobile) {
    const tmp = L.geoJSON(statesGeo);
    const bounds = tmp.getBounds();
    tmp.remove();
    map.fitBounds(bounds, { padding: [12, 12] });
    map.setMinZoom(map.getZoom() - 0.5);
    map.setMaxZoom(map.getZoom() + 2);
  } else {
    map.setView([38, -96], 5);
    map.setMinZoom(5);
    map.setMaxZoom(5);
  }

  drawStates(statesGeo, currentMetric);
  updateSidebar(statesGeo, currentMetric);
  setupControls(statesGeo);

  // Recompute size after paint and on rotation/resizes
  setTimeout(() => map.invalidateSize(), 0);
  window.addEventListener("resize", () => map.invalidateSize());
}

function drawStates(geojson, metricKey) {
  if (geoLayer) geoLayer.remove();

  geoLayer = L.geoJSON(geojson, {
    style: () => ({ color: "#ffffff", weight: 1.6, fillOpacity: 0 }),
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      const v = p.metrics?.[metricKey];
      const txt = formatValue(metricKey, v);
      layer.bindPopup(
        `<div style="min-width:200px">
           <div style="font-weight:700;margin-bottom:4px">${p.name} (${p.abbr||"–"})</div>
           <div>${METRIC_LABELS[metricKey]}: <strong>${txt}</strong></div>
         </div>`
      );
      layer.on("mouseover", () => layer.setStyle({ weight: 2.2, color: "#00e5ff" }));
      layer.on("mouseout",  () => layer.setStyle({ weight: 1.6, color: "#ffffff" }));
      layer.on("click", () => {
        if (!p.abbr) return;
        selectionHistory = [p.abbr, ...selectionHistory.filter(a => a !== p.abbr)].slice(0, 3);
        layer.openPopup();
        updateSidebar(geojson, currentMetric);
      });
    }
  }).addTo(map);
}

function updateSidebar(geojson, metricKey) {
  const allRows = geojson.features
    .map(f => ({ abbr: f.properties.abbr, value: f.properties.metrics?.[metricKey] }))
    .filter(r => typeof r.value === "number" && !Number.isNaN(r.value));

  const statMetric = document.getElementById("statMetric");
  const statAvg = document.getElementById("statAvg");
  const statMax = document.getElementById("statMax");
  const statMin = document.getElementById("statMin");
  statMetric.textContent = METRIC_LABELS[metricKey];

  if (allRows.length === 0) {
    statAvg.textContent = statMax.textContent = statMin.textContent = "—";
    renderChart([], 0, metricKey);
    return;
  }

  const avg = allRows.reduce((a,b)=>a+b.value,0)/allRows.length;
  const max = allRows.reduce((m,r)=> r.value>m.value?r:m, allRows[0]);
  const min = allRows.reduce((m,r)=> r.value<m.value?r:m, allRows[0]);

  statAvg.textContent = formatValue(metricKey, avg);
  statMax.textContent = `${formatValue(metricKey, max.value)} (${max.abbr})`;
  statMin.textContent = `${formatValue(metricKey, min.value)} (${min.abbr})`;

  let chartRows = [];
  if (selectionHistory.length > 0) {
    const lookup = Object.fromEntries(allRows.map(r => [r.abbr, r.value]));
    chartRows = selectionHistory
      .map(abbr => ({ abbr, value: lookup[abbr] }))
      .filter(r => typeof r.value === "number" && !Number.isNaN(r.value));
  }
  if (chartRows.length === 0) {
    chartRows = allRows.slice().sort((a,b)=>b.value-a.value).slice(0,8).reverse();
  }

  renderChart(chartRows, avg, metricKey);
}

function renderChart(rows, avg, metricKey) {
  const ctx = document.getElementById("rankChart");
  if (window.__chart__) window.__chart__.destroy();
  window.__chart__ = new Chart(ctx, {
    type: "bar",
    data: {
      labels: rows.map(r => r.abbr),
      datasets: [
        { label: METRIC_LABELS[metricKey], data: rows.map(r => r.value), borderWidth: 1 },
        { type: "line", label: "U.S. Avg", data: new Array(rows.length).fill(avg), borderWidth: 2, pointRadius: 0, borderDash: [6,4] }
      ]
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color: "#e9ecff", boxWidth: 18 } },
        tooltip: {
          backgroundColor: "#0f1530", titleColor: "#e9ecff", bodyColor: "#e9ecff",
          callbacks: { label: c => `${c.dataset.label}: ${formatValue(metricKey, c.raw)}` }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#cdd2ff" } },
        y: {
          grid: { color: "rgba(255,255,255,0.08)" },
          ticks: { color: "#cdd2ff", callback: v => formatValue(metricKey, v) }
        }
      }
    }
  });
}

function setupControls(geojson) {
  const select = document.getElementById("metricSelect");
  select.value = currentMetric;
  select.addEventListener("change", () => {
    currentMetric = select.value;
    drawStates(geojson, currentMetric);
    updateSidebar(geojson, currentMetric);
  });
}
