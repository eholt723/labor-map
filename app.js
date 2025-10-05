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
let currentMetric = "unemployment_rate"; // default dropdown
let selectionHistory = [];               // [current, prev1, prev2]
let colorScale = null;                   // chroma scale shared by map + legend

// Pleasant, perceptually-uniform-ish ramp
const COLOR_RAMP = ["#440154","#3b528b","#21918c","#5ec962","#fde725"];

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  // Fixed, non-interactive map
  map = L.map("map", {
    attributionControl: false,
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    tap: false
  });
  map.setView([38, -96], 5);
  map.setMinZoom(5);
  map.setMaxZoom(5);

  // Load metrics (fallback to docs/ for GitHub Pages)
  let metricsByAbbr = {};
  try {
    const m = await fetch("data/latest.json", { cache: "no-cache" });
    if (m.ok) metricsByAbbr = await m.json();
    else {
      const m2 = await fetch("docs/data/latest.json", { cache: "no-cache" });
      if (m2.ok) metricsByAbbr = await m2.json();
    }
  } catch (_) {
    try {
      const m2 = await fetch("docs/data/latest.json", { cache: "no-cache" });
      if (m2.ok) metricsByAbbr = await m2.json();
    } catch (_) {}
  }

  // TopoJSON -> GeoJSON, then attach metrics to features
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

  // First render
  // (updateSidebar will compute scale + draw legend before map draws)
  updateSidebar(statesGeo, currentMetric);
  drawStates(statesGeo, currentMetric);
  setupControls(statesGeo);
}

function computeScale(rows) {
  // rows: [{abbr, value}] after filtering to numbers
  if (!rows.length) return null;
  const min = rows.reduce((m,r)=>r.value<m?r.value:m, rows[0].value);
  const max = rows.reduce((m,r)=>r.value>m?r.value:m, rows[0].value);
  if (min === max) {
    // Avoid divide-by-zero look; make a tiny domain
    return chroma.scale(COLOR_RAMP).domain([min - 1e-6, max + 1e-6]);
  }
  return chroma.scale(COLOR_RAMP).domain([min, max]);
}

function drawStates(geojson, metricKey) {
  if (geoLayer) geoLayer.remove();

  geoLayer = L.geoJSON(geojson, {
    style: (feature) => {
      const v = feature.properties.metrics?.[metricKey];
      const hasVal = typeof v === "number" && !Number.isNaN(v);
      const fill = hasVal && colorScale ? colorScale(v).hex() : "#0f1736"; // subtle base
      return { color: "#ffffff", weight: 1.6, fillColor: fill, fillOpacity: hasVal ? 0.85 : 0.25 };
    },
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
        updateSidebar(geojson, currentMetric); // re-render chart + legend labels
      });
    }
  }).addTo(map);
}

function drawLegendCanvas() {
  const canvas = document.getElementById("legendCanvas");
  if (!canvas || !colorScale) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;

  // horizontal gradient
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  const stops = 10;
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    grad.addColorStop(t, colorScale.mode ? colorScale(t).hex() : colorScale(t).hex());
  }
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

function updateSidebar(geojson, metricKey) {
  // All numeric rows across lower-48 + DC
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
    document.getElementById("legendMin").textContent = "Low";
    document.getElementById("legendMax").textContent = "High";
    colorScale = null;
    drawLegendCanvas();
    return;
  }

  const avg = allRows.reduce((a,b)=>a+b.value,0)/allRows.length;
  const max = allRows.reduce((m,r)=> r.value>m.value?r:m, allRows[0]);
  const min = allRows.reduce((m,r)=> r.value<m.value?r:m, allRows[0]);

  // Compute color scale for map + legend, then draw legend
  colorScale = computeScale(allRows);
  drawLegendCanvas();

  statAvg.textContent = formatValue(metricKey, avg);
  statMax.textContent = `${formatValue(metricKey, max.value)} (${max.abbr})`;
  statMin.textContent = `${formatValue(metricKey, min.value)} (${min.abbr})`;

  // Chart rows: selection mode (current + 2 previous) OR fallback top 8
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

  // Legend labels reflect actual min/max values
  document.getElementById("legendMin").textContent = formatValue(metricKey, min.value);
  document.getElementById("legendMax").textContent = formatValue(metricKey, max.value);
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
        y: { grid: { color: "rgba(255,255,255,0.08)" }, ticks: { color: "#cdd2ff",
             callback: v => formatValue(metricKey, v) } }
      }
    }
  });
}

function setupControls(geojson) {
  const select = document.getElementById("metricSelect");
  select.value = currentMetric;
  select.addEventListener("change", () => {
    currentMetric = select.value;
    // Recompute scale/legend + redraw map and sidebar
    updateSidebar(geojson, currentMetric);
    drawStates(geojson, currentMetric);
  });
}
