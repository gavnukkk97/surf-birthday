/* Surf Birthday Route — планировщик маршрута по кофейням Surf Coffee в день рождения. */
'use strict';

const MOSCOW_CENTER = [55.7519, 37.6177];
const SPOTS = (window.SURF_SPOTS || []).map((s, i) => ({ ...s, i }));

/* OSRM endpoints: FOSSGIS (foot) + официальный demo-сервер (car). */
const ROUTERS = {
  foot: 'https://routing.openstreetmap.de/routed-foot/',
  car: 'https://router.project-osrm.org/',
};
const MAX_TABLE_COORDS = 90; // с запасом под лимит demo-сервера (100)

/* ------------------------------------------------------------------ state */
const state = {
  start: null,          // {lat, lon, label}
  route: null,
  pickingOnMap: false,
  spotMarkers: [],
  routeLayer: null,
};

/* ------------------------------------------------------------------ utils */
const $ = (id) => document.getElementById(id);
const rad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  const R = 6371;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fmtHM(min) {
  const h = Math.floor(min / 60) % 24, m = Math.round(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function parseHM(s) {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + (m || 0);
}
function fmtDur(min) {
  min = Math.round(min);
  if (min < 60) return `${min} мин`;
  return `${Math.floor(min / 60)} ч ${String(min % 60).padStart(2, '0')} мин`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
async function fetchJSON(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ map */
const map = L.map('map', { zoomControl: true }).setView(MOSCOW_CENTER, 11);

/* Подложки с защитой от сбоев провайдера:
   1) на старте проверяем провайдеров пробными тайлами и сразу включаем рабочий;
   2) отдельные битые тайлы перезагружаем;
   3) «сторож» каждые 4 секунды смотрит на реально битые тайлы в DOM
      и при массовых ошибках сам переключает подложку. */
const BASEMAPS = [
  {
    name: 'OSM', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    nativeZoom: 19, attribution: '© OpenStreetMap contributors',
    probes: ['https://tile.openstreetmap.org/11/1052/628.png'],
  },
  {
    name: 'CARTO', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    subdomains: 'abcd', nativeZoom: 20, attribution: '© OpenStreetMap · © CARTO',
    probes: ['https://a.basemaps.cartocdn.com/light_all/11/1052/628.png',
             'https://d.basemaps.cartocdn.com/light_all/11/1052/628.png'],
  },
  {
    name: 'Esri', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    nativeZoom: 16, attribution: '© Esri · © OpenStreetMap',
    probes: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/11/628/1052'],
  },
];
const basemapState = { idx: 0, layer: null, lastSwitch: 0, warnedAll: false };

function applyBasemap(idx) {
  if (basemapState.layer) map.removeLayer(basemapState.layer);
  basemapState.idx = ((idx % BASEMAPS.length) + BASEMAPS.length) % BASEMAPS.length;
  const bm = BASEMAPS[basemapState.idx];
  basemapState.lastSwitch = Date.now();
  basemapState.layer = L.tileLayer(bm.url, {
    attribution: bm.attribution,
    subdomains: bm.subdomains || 'abc',
    maxNativeZoom: bm.nativeZoom,
    maxZoom: 19,
    keepBuffer: 4,
  }).on('tileerror', retryTile).addTo(map);
}

/* одиночный битый тайл перезагружаем один раз через 1.5 с */
function retryTile(e) {
  const tile = e.tile;
  if (tile && !tile.dataset.retried) {
    tile.dataset.retried = '1';
    setTimeout(() => {
      try { tile.src = tile.src + (tile.src.includes('?') ? '&' : '?') + 'r=' + Date.now(); } catch {}
    }, 1500);
  }
}

function countBrokenTiles() {
  let total = 0, broken = 0;
  document.querySelectorAll('img.leaflet-tile').forEach((t) => {
    total++;
    if (t.complete && t.naturalWidth === 0) broken++;
  });
  return { total, broken };
}

function probeImage(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const im = new Image();
    const done = (ok) => resolve(ok);
    im.onload = () => done(true);
    im.onerror = () => done(false);
    setTimeout(() => done(false), timeoutMs);
    im.src = url + '?probe=' + Date.now();
  });
}

/* стартовая проверка: сразу включаем первого живого провайдера */
(async function pickInitialBasemap() {
  const health = await Promise.all(BASEMAPS.map(async (bm) => {
    const results = await Promise.all(bm.probes.map((u) => probeImage(u)));
    return results.every(Boolean);
  }));
  const firstOk = health.indexOf(true);
  if (firstOk !== -1 && firstOk !== basemapState.idx) {
    applyBasemap(firstOk);
  }
  if (firstOk === -1 && !basemapState.warnedAll) {
    basemapState.warnedAll = true;
    toast('Ни один провайдер карты не отвечает — проверь интернет. Точки и маршрут работают и так');
  }
})();

/* сторож: следит за реально битыми тайлами и меняет подложку сам */
setInterval(() => {
  const { total, broken } = countBrokenTiles();
  if (broken < 3 || total === 0 || broken / total < 0.25) return;
  if (Date.now() - basemapState.lastSwitch < 15000) return; // не дёргаемся чаще раза в 15 с
  if (basemapState.idx < BASEMAPS.length - 1) {
    const next = basemapState.idx + 1;
    toast(`Тайлы «${BASEMAPS[basemapState.idx].name}» не грузятся — переключаюсь на «${BASEMAPS[next].name}»`);
    applyBasemap(next);
  } else if (!basemapState.warnedAll) {
    basemapState.warnedAll = true;
    toast('Тайлы карты не грузятся — проверь интернет. Точки и маршрут работают и без подложки');
  }
}, 4000);

/* отладочный доступ (для тестов): состояние подложки */
window.__basemapDebug = () => ({ idx: basemapState.idx, name: BASEMAPS[basemapState.idx].name, ...countBrokenTiles() });

const BasemapSwitch = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const div = L.DomUtil.create('div', 'leaflet-bar basemap-btn');
    div.textContent = '🗺';
    div.title = 'Сменить подложку карты (если не грузится)';
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.on(div, 'click', () => applyBasemap(basemapState.idx + 1));
    return div;
  },
});
map.addControl(new BasemapSwitch());
applyBasemap(0);

let mapHint = null;
function setMapHint(text) {
  if (!text) { if (mapHint) { mapHint.remove(); mapHint = null; } return; }
  if (!mapHint) mapHint = L.domUtil.create('div', 'map-hint', map.getContainer());
  mapHint.textContent = text;
}

const startMarker = L.marker(MOSCOW_CENTER, {
  draggable: true,
  icon: L.divIcon({ className: 'leaflet-div-icon', html: '<div class="cake-marker">🎂</div>', iconSize: [30, 30], iconAnchor: [15, 15] }),
  zIndexOffset: 1000,
}).addTo(map).bindPopup('🎂 Старт — перетащи, если нужно');

function drawSpots() {
  SPOTS.forEach((s) => {
    const m = L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: 'leaflet-div-icon', html: '<div class="spot-dot"></div>', iconSize: [13, 13], iconAnchor: [6.5, 6.5] }),
      zIndexOffset: 200,
    }).addTo(map);
    m.bindPopup(
      `<div class="pop-name">☕ ${escapeHtml(s.name)}</div>` +
      `<div class="pop-addr">${escapeHtml(s.addr)}</div>` +
      `<button class="pop-link">Сделать стартом</button>`,
    );
    m.on('popupopen', (e) => {
      e.popup.getElement().querySelector('.pop-link').addEventListener('click', () => {
        setStart(s.lat, s.lon, `${s.name} (${s.addr})`);
        map.closePopup();
      });
    });
    state.spotMarkers.push({ spot: s, marker: m });
  });
}

/* ------------------------------------------------------------------ start */
function setStart(lat, lon, label) {
  state.start = { lat, lon, label: label || `точка на карте (${lat.toFixed(4)}, ${lon.toFixed(4)})` };
  startMarker.setLatLng([lat, lon]);
  const info = $('startInfo');
  info.classList.remove('empty');
  info.classList.add('set');
  info.innerHTML = `<b>Старт:</b> ${escapeHtml(state.start.label)}`;
  $('buildBtn').disabled = false;
  stopPicking();
  writeURL();
}
function stopPicking() {
  state.pickingOnMap = false;
  $('pickBtn').classList.remove('active-pick');
  setMapHint(null);
  map.getContainer().style.cursor = '';
}
startMarker.on('dragend', () => {
  const p = startMarker.getLatLng();
  setStart(p.lat, p.lng);
});
map.on('click', (e) => {
  if (state.pickingOnMap) setStart(e.latlng.lat, e.latlng.lng);
});
$('pickBtn').addEventListener('click', () => {
  state.pickingOnMap = !state.pickingOnMap;
  if (state.pickingOnMap) {
    $('pickBtn').classList.add('active-pick');
    setMapHint('Клик по карте — поставить старт 🎂');
    map.getContainer().style.cursor = 'crosshair';
  } else stopPicking();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') stopPicking(); });

$('geolocBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Геолокация не поддерживается браузером');
  toast('Определяю местоположение…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setStart(pos.coords.latitude, pos.coords.longitude, 'моё местоположение');
      map.setView([pos.coords.latitude, pos.coords.longitude], 13);
      toast('Старт установлен 🎂');
    },
    () => toast('Не удалось определить местоположение — кликни по карте'),
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

/* ------------------------------------------------------------------ search (Nominatim) */
let searchTimer = null;
async function runSearch(q) {
  const box = $('searchResults');
  if (!q || q.trim().length < 3) { box.hidden = true; return; }
  try {
    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      format: 'jsonv2', limit: 6, 'accept-language': 'ru', countrycodes: 'ru', q,
      viewbox: '36.2,54.9,38.95,56.4', bounded: '1',
    });
    const res = await fetchJSON(url, 15000);
    box.innerHTML = '';
    if (!res.length) {
      box.insertAdjacentHTML('beforeend', '<div class="none">Ничего не нашлось — попробуй точнее или кликни по карте</div>');
    }
    res.forEach((r) => {
      const b = document.createElement('button');
      b.textContent = r.display_name;
      b.addEventListener('click', () => {
        setStart(+r.lat, +r.lon, r.display_name.split(',').slice(0, 2).join(','));
        box.hidden = true; $('addrInput').value = '';
        map.setView([+r.lat, +r.lon], 14);
      });
      box.appendChild(b);
    });
    box.hidden = false;
  } catch {
    box.hidden = true;
  }
}
$('addrInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value.trim()), 450);
});
$('addrInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(e.target.value.trim()); }
});
$('searchBtn').addEventListener('click', () => { clearTimeout(searchTimer); runSearch($('addrInput').value.trim()); });
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-row')) $('searchResults').hidden = true;
});

/* ------------------------------------------------------------------ travel matrix */
function fallbackMatrix(coords, mode) {
  // по прямой с поправкой на городскую застройку; пешком 4.8 км/ч, машина ~26 км/ч
  const n = coords.length;
  const dur = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const km = haversineKm(coords[i], coords[j]) * 1.32;
      dur[i][j] = (km / (mode === 'foot' ? 4.8 : 26)) * 3600;
    }
  }
  return dur;
}

async function getMatrix(coords, mode) {
  const pts = coords.map((c) => `${c.lon.toFixed(6)},${c.lat.toFixed(6)}`).join(';');
  try {
    const data = await fetchJSON(`${ROUTERS[mode]}table/v1/driving/${pts}?annotations=duration`, 30000);
    if (!data.durations || data.durations.length !== coords.length) throw new Error('bad matrix');
    // OSRM иногда отдаёт null в матрице (непроезжаемая пара) — чиним прямой оценкой
    const fb = fallbackMatrix(coords, mode);
    const dur = data.durations.map((row, i) => row.map((v, j) => (v == null ? fb[i][j] : v)));
    return { dur, approx: false };
  } catch {
    return { dur: fallbackMatrix(coords, mode), approx: true };
  }
}

/* ------------------------------------------------------------------ optimizer */
/**
 * Orienteering problem с временными окнами: максимизируем число посещённых
 * кофеен, при равенстве — минимизируем время финиша.
 * dur: матрица времени в пути в секундах, индекс 0 — старт.
 * opts: { dayStart, dayEnd, service, open, close } — минуты от полуночи.
 * Возвращает { seq, sim } | null. sim: { finish, travel, wait, events[] }.
 */
function optimize(n, dur, opts) {
  const D = dur.map((row) => row.map((sec) => sec / 60)); // минуты
  const { dayStart, dayEnd, service, open, close } = opts;

  function simulate(seq) {
    let t = dayStart, travel = 0, wait = 0, prev = 0;
    const events = [];
    for (const v of seq) {
      const leg = D[prev][v];
      const arr = t + leg;
      if (arr > close) return null;                    // приехали после закрытия
      const st = Math.max(arr, open);
      wait += st - arr; travel += leg;
      const leave = st + service;
      if (leave > dayEnd + 1e-9) return null;         // не влезаем в день
      events.push({ v, arr, st, leave, leg });
      t = leave; prev = v;
    }
    return { finish: t, travel, wait, events };
  }

  /* жадное построение: на каждом шаге берём точку с самым ранним временем,
     куда ещё можно успеть (со случайностью для мультистарта) */
  function greedy(randomized) {
    const seq = [];
    for (;;) {
      const cand = [];
      for (let v = 1; v < n; v++) {
        if (seq.includes(v)) continue;
        const sim = simulate([...seq, v]);
        if (sim) cand.push({ v, st: sim.events[sim.events.length - 1].st });
      }
      if (!cand.length) return seq;
      cand.sort((a, b) => a.st - b.st);
      const top = randomized ? Math.min(3, cand.length) : 1;
      seq.push(cand[Math.floor(Math.random() * top)].v);
    }
  }

  /* дожимаем: пробуем всунуть ещё непосещённые точки в любую позицию */
  function tryInsertMore(seq) {
    let cur = simulate(seq);
    for (;;) {
      let best = null;
      for (let v = 1; v < n; v++) {
        if (seq.includes(v)) continue;
        for (let p = 0; p <= seq.length; p++) {
          const cand = seq.slice(0, p).concat(v, seq.slice(p));
          const s2 = simulate(cand);
          if (s2 && (!best || s2.finish < best.sim.finish)) best = { seq: cand, sim: s2 };
        }
      }
      if (!best) return seq;
      seq = best.seq; cur = best.sim;
    }
  }

  /* локальные улучшения: 2-opt + or-opt (перестановка одной точки) */
  function improve(seq) {
    let sim = simulate(seq);
    if (!sim) return null;
    let improved = true, guard = 0;
    while (improved && guard++ < 40) {
      improved = false;
      for (let i = 0; i < seq.length - 1; i++) {
        for (let j = i + 1; j < seq.length; j++) {
          const cand = seq.slice(0, i).concat(seq.slice(i, j + 1).reverse(), seq.slice(j + 1));
          const s2 = simulate(cand);
          if (s2 && s2.finish < sim.finish - 1e-6) { seq = cand; sim = s2; improved = true; }
        }
      }
      for (let i = 0; i < seq.length; i++) {
        for (let j = 0; j < seq.length; j++) {
          if (i === j) continue;
          const rest = seq.slice(); const [x] = rest.splice(i, 1);
          rest.splice(j, 0, x);
          const s2 = simulate(rest);
          if (s2 && s2.finish < sim.finish - 1e-6) { seq = rest; sim = s2; improved = true; }
        }
      }
    }
    return sim;
  }

  let best = null;
  for (let r = 0; r < 10; r++) {
    let seq = greedy(r > 0);
    seq = tryInsertMore(seq);
    const sim = improve(seq);
    if (!sim) continue;
    const cnt = sim.events.length;
    if (!best || cnt > best.sim.events.length ||
        (cnt === best.sim.events.length && sim.finish < best.sim.finish)) {
      best = { seq, sim };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ build */
let building = false;
async function build() {
  if (!state.start || building) return;
  building = true;
  const btn = $('buildBtn');
  btn.disabled = true; btn.textContent = '⏳ Считаю маршрут…';
  await new Promise((r) => setTimeout(r, 30)); // дать браузеру перерисовать кнопку

  try {
    const mode = $('mode').value;
    const opts = {
      dayStart: parseHM($('dayStart').value),
      dayEnd: parseHM($('dayEnd').value),
      service: Math.max(5, +$('svcTime').value || 20),
      open: parseHM($('openFrom').value),
      close: parseHM($('openTo').value),
    };

    /* берём ближайшие к старту точки (у OSRM лимит координат в матрице) */
    const subset = SPOTS.slice()
      .sort((a, b) => haversineKm(state.start, a) - haversineKm(state.start, b))
      .slice(0, MAX_TABLE_COORDS - 1);
    const coords = [state.start, ...subset.map((s) => ({ lat: s.lat, lon: s.lon }))];

    const { dur, approx } = await getMatrix(coords, mode);
    const best = optimize(coords.length, dur, opts);

    if (!best || !best.sim.events.length) {
      showEmpty();
      return;
    }

    /* геометрия маршрута по реальным дорогам */
    const seqIdx = [0, ...best.seq];
    const { geometry, distanceKm, approxGeom } = await getGeometry(seqIdx, coords, mode);

    render(best, subset, opts, geometry, distanceKm, approx || approxGeom, mode);
  } catch (err) {
    console.error(err);
    toast('Не удалось построить маршрут — попробуй ещё раз');
  } finally {
    building = false;
    btn.disabled = false; btn.textContent = '🎉 Построить маршрут';
  }
}

async function getGeometry(seqIdx, coords, mode) {
  const pts = seqIdx.map((i) => `${coords[i].lon.toFixed(6)},${coords[i].lat.toFixed(6)}`).join(';');
  try {
    const data = await fetchJSON(`${ROUTERS[mode]}route/v1/driving/${pts}?overview=full&geometries=geojson`, 30000);
    const route = data.routes && data.routes[0];
    if (!route) throw new Error('no route');
    return {
      geometry: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
      distanceKm: route.distance / 1000,
      approxGeom: false,
    };
  } catch {
    const latlngs = seqIdx.map((i) => [coords[i].lat, coords[i].lon]);
    let km = 0;
    for (let i = 1; i < latlngs.length; i++) {
      km += haversineKm({ lat: latlngs[i - 1][0], lon: latlngs[i - 1][1] }, { lat: latlngs[i][0], lon: latlngs[i][1] });
    }
    return { geometry: latlngs, distanceKm: km, approxGeom: true };
  }
}

function showEmpty() {
  $('resultCard').hidden = false;
  $('stats').innerHTML = '';
  $('timeline').innerHTML =
    '<li style="cursor:default"><div class="t-body">' +
    '<div class="t-name">🙃 Ни одной кофейни не влезает в окно</div>' +
    '<div class="t-addr">Расширь время дня, уменьши минуты на напиток или выбери другой старт</div></div></li>';
  $('yandexLink').style.display = 'none';
  $('qrBlock').hidden = true;
}

/* QR-код со ссылкой на маршрут в Яндекс.Картах — чтобы открыть на телефоне */
function renderQR(url) {
  const block = $('qrBlock');
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('qrCode').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
    /* фиксируем компактный размер: svg масштабируем через viewBox */
    const svg = $('qrCode').querySelector('svg');
    if (svg) {
      const w = parseFloat(svg.getAttribute('width')) || 436;
      const h = parseFloat(svg.getAttribute('height')) || w;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('width', '140');
      svg.setAttribute('height', '140');
    }
    block.hidden = false;
  } catch (err) {
    console.warn('QR не сгенерировался:', err);
    block.hidden = true;
  }
}

/* ------------------------------------------------------------------ render */
function render(best, subset, opts, geometry, distanceKm, approx, mode) {
  const { sim } = best;
  const stops = sim.events.map((e, k) => ({ ...subset[e.v - 1], ord: k + 1, ...e }));

  if (state.routeLayer) { map.removeLayer(state.routeLayer); state.routeLayer = null; }
  state.spotMarkers.forEach(({ marker }) => {
    const el = marker.getElement() && marker.getElement().querySelector('.spot-dot');
    if (el) el.classList.remove('visited');
  });

  const layer = L.layerGroup().addTo(map);
  state.routeLayer = layer;
  L.polyline(geometry, { color: '#fff', weight: 9, opacity: 0.9 }).addTo(layer);
  L.polyline(geometry, { color: mode === 'foot' ? '#2563eb' : '#7c3aed', weight: 4.5, opacity: 0.95 }).addTo(layer);

  const bounds = L.latLngBounds(geometry);
  const numMarkers = [];
  stops.forEach((s) => {
    const mk = L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: 'leaflet-div-icon', html: `<div class="num-marker">${s.ord}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      zIndexOffset: 900,
    }).addTo(layer).bindPopup(
      `<div class="pop-name">${s.ord}. ☕ ${escapeHtml(s.name)}</div>` +
      `<div class="pop-addr">${escapeHtml(s.addr)}</div>` +
      `<div class="pop-addr" style="margin-top:4px">🕘 приход <b>${fmtHM(s.arr)}</b> · уход <b>${fmtHM(s.leave)}</b></div>`,
    );
    numMarkers.push(mk);
    const sm = state.spotMarkers.find((x) => x.spot.i === s.i);
    if (sm) {
      const el = sm.marker.getElement() && sm.marker.getElement().querySelector('.spot-dot');
      if (el) el.classList.add('visited');
    }
  });
  map.fitBounds(bounds.pad(0.15));

  /* --- статистика --- */
  const chips = [
    { v: `${stops.length} <em>напитков</em>`, k: mode === 'foot' ? '🚶 пешком' : '🚗 на машине' },
    { v: fmtHM(sim.finish), k: '🏁 финиш' },
    { v: fmtDur(sim.travel), k: '⏱ время в пути' },
    { v: `${Math.round(sim.wait)} мин`, k: '⏳ ожидания открытия' },
  ];
  $('stats').innerHTML = chips.map((c) => `<div class="stat"><div class="v">${c.v}</div><div class="k">${c.k}</div></div>`).join('');
  $('approxNote').hidden = !approx;

  /* --- таймлайн --- */
  const tl = $('timeline');
  tl.innerHTML = '';
  stops.forEach((s) => {
    const li = document.createElement('li');
    const waitTxt = s.st - s.arr >= 1 ? ` <span class="wait">(ждём открытие ${Math.round(s.st - s.arr)} мин)</span>` : '';
    li.innerHTML =
      `<div class="t-badge">${s.ord}</div>` +
      `<div class="t-body">` +
      `<div class="t-name">☕ ${escapeHtml(s.name)}</div>` +
      `<div class="t-addr">${escapeHtml(s.addr)}</div>` +
      `<div class="t-time"><span class="leg">⏱ ${fmtDur(s.leg)} в пути · </span><span class="arr">приход ${fmtHM(s.arr)}</span>${waitTxt} · уход ${fmtHM(s.leave)}</div>` +
      `</div>`;
    li.addEventListener('click', () => {
      map.flyTo([s.lat, s.lon], 15);
      const mk = numMarkers[s.ord - 1];
      if (mk) setTimeout(() => mk.openPopup(), 450);
    });
    tl.appendChild(li);
  });

  /* --- внешние ссылки --- */
  const rtext = [state.start, ...stops].map((p) => `${p.lat},${p.lon}`).join('~');
  const ya = $('yandexLink');
  ya.href = `https://yandex.ru/maps/?rtext=${rtext}&rtt=${mode === 'foot' ? 'pd' : 'auto'}&z=12`;
  ya.style.display = '';

  /* --- QR: открой маршрут на телефоне --- */
  renderQR(ya.href);

  state.route = { stops, sim, opts, approx, mode, distanceKm };
  $('resultCard').hidden = false;
  $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  writeURL();
}

$('buildBtn').addEventListener('click', build);

$('shareBtn').addEventListener('click', async () => {
  writeURL();
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Ссылка скопирована 🔗');
  } catch {
    toast('Скопируй адрес из строки браузера');
  }
});

/* ------------------------------------------------------------------ url state */
function writeURL() {
  if (!history.replaceState) return;
  const p = new URLSearchParams();
  if (state.start) p.set('start', `${state.start.lat.toFixed(5)},${state.start.lon.toFixed(5)}`);
  ['dayStart', 'dayEnd', 'svcTime', 'mode', 'openFrom', 'openTo'].forEach((k) => p.set(k, $(k).value));
  history.replaceState(null, '', `?${p}`);
}
function restoreFromURL() {
  const p = new URLSearchParams(location.search);
  ['dayStart', 'dayEnd', 'svcTime', 'mode', 'openFrom', 'openTo'].forEach((k) => {
    const v = p.get(k);
    if (v !== null && $(k).querySelector(`option[value="${CSS.escape(v)}"], input`)) $(k).value = v;
  });
  const svc = p.get('svcTime');
  if (svc !== null && /^\d+$/.test(svc)) $('svcTime').value = svc;
  const s = p.get('start');
  if (s) {
    const [lat, lon] = s.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      setStart(lat, lon);
      map.setView([lat, lon], 12);
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ init */
drawSpots();
const restored = restoreFromURL();
if (restored) build();
