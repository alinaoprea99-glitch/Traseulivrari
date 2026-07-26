// ===================================================================
// Curier — vizualizare traseu pe mobil
// Fără server, fără cont: datele traseului sunt încapsulate integral
// în hash-ul URL-ului (#d=...), generat de aplicația principală
// (butonul "📱 trimite curierului" din tab-ul Trasee).
// Bifele de livrare se salvează DOAR în acest telefon (localStorage) —
// nu se sincronizează automat înapoi la dispecer.
// ===================================================================

function decodeCourierData(encoded){
  const json = LZString.decompressFromEncodedURIComponent(encoded);
  return JSON.parse(json);
}

// Must stay in the exact same order as the array built in app.js's buildCourierPayload().
const STOP_FIELDS = ['id', 'o', 'name', 'phone', 'addr', 'details', 'products', 'productsKg', 'note', 'amount', 'payment', 'lat', 'lng', 'winStart'];

function addMinutesToTime(hhmm, minutesToAdd){
  const [h, m] = hhmm.split(':').map(Number);
  let total = (h * 60 + m + minutesToAdd) % (24 * 60);
  if (total < 0) total += 24 * 60;
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}

/** Turns a compact [id, o, name, ...] array back into the named-field shape the rest of this file expects. */
function stopFromArray(arr){
  const s = {};
  STOP_FIELDS.forEach((key, i) => { s[key] = arr[i]; });
  s.winEnd = s.winStart ? addMinutesToTime(s.winStart, 120) : '';
  return s;
}

function loadPayloadFromHash(){
  const hash = location.hash.slice(1);
  const params = new URLSearchParams(hash);
  const encoded = params.get('d');
  if (!encoded) return null;
  try {
    const payload = decodeCourierData(encoded);
    if (Array.isArray(payload.stops)) payload.stops = payload.stops.map(stopFromArray);
    return payload;
  } catch (e){
    console.error('Nu am putut citi datele traseului din link', e);
    return null;
  }
}

function statusStorageKey(routeId){
  return `curier-status:${routeId}`;
}

function loadStatuses(routeId){
  try {
    const raw = localStorage.getItem(statusStorageKey(routeId));
    return raw ? JSON.parse(raw) : {};
  } catch (e){
    return {};
  }
}

function saveStatuses(routeId, statuses){
  try {
    localStorage.setItem(statusStorageKey(routeId), JSON.stringify(statuses));
  } catch (e){
    console.error('Nu am putut salva statusul pe acest telefon', e);
  }
}

// ---- GPS check-ins: the courier's actual arrival position at a stop, meant to be sent
// back to the dispatcher so it can be reused as a verified address next time. Stored
// separately from delivery statuses since they serve a different purpose (address
// accuracy, not "did I deliver this").
function checkinStorageKey(routeId){
  return `curier-checkin:${routeId}`;
}

function loadCheckins(routeId){
  try {
    const raw = localStorage.getItem(checkinStorageKey(routeId));
    return raw ? JSON.parse(raw) : {};
  } catch (e){
    return {};
  }
}

function saveCheckins(routeId, checkins){
  try {
    localStorage.setItem(checkinStorageKey(routeId), JSON.stringify(checkins));
  } catch (e){
    console.error('Nu am putut salva check-in-ul pe acest telefon', e);
  }
}

function getCurrentPosition(){
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation){
      reject(new Error('Acest telefon/browser nu suportă localizare GPS.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0
    });
  });
}

/** Same da.gd shortener as the dispatcher side (app.js) — duplicated since this page stands alone, no shared module. */
async function shortenLink(longUrl){
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`https://da.gd/shorten?url=${encodeURIComponent(longUrl)}`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text.startsWith('http') ? text : null;
  } catch (e){
    console.error('Scurtarea link-ului a eșuat, folosesc link-ul complet', e);
    return null;
  }
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/** "2x Mere, 4x Cireșe" + productsKg -> "2x Mere, 4x Cireșe · Total: 6 kg" (escaped, ready for innerHTML). Mirrors app.js's formatProductsWithKg. */
function formatProductsWithKg(s){
  if (!s.products) return '';
  if (s.productsKg == null) return escapeHtml(s.products);
  const rounded = Math.round(s.productsKg * 100) / 100;
  const kgText = rounded % 1 === 0 ? rounded : rounded.toFixed(2);
  return `${escapeHtml(s.products)} · Total: ${kgText} kg`;
}

function mapsUrl(lat, lng){
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}
function wazeUrl(lat, lng){
  return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}

// Simple, consistent line-icon set (no emoji) for everything that isn't a real third-party
// service mark. Maps/Waze/Check-in use the actual brand assets in icons/ instead — see iconImg().
const ICONS = {
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5c0-1 1-2 2-2h2l2 5-2 1a11 11 0 0 0 6 6l1-2 5 2v2c0 1-1 2-2 2A15 15 0 0 1 4 5z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
  apple: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8c-2 0-4 1.6-4 5 0 3 2 7 4 7s2-1 4-1 2 1 4 1c1.6 0 3.4-3 3.7-5"/><path d="M12 8c0-1.8 1-3.4 3-4"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.6 8.4A9 9 0 0 1 8 19l-4 1 1.3-3.7A8.3 8.3 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>',
  building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v15"/><path d="M13 21v-9a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v9"/><path d="M9 9h0M9 13h0M9 17h0"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4L3 6.5v13L9 17l6 3 6-2.5v-13L15 7 9 4z"/><path d="M9 4v13M15 7v13"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3L11 13"/><path d="M21 3l-7 18-4-8-8-4 19-6z"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5L22 20H2L12 3.5z"/><path d="M12 10v4.5M12 17.5h0"/></svg>'
};

function iconImg(src, alt){
  return `<img src="${src}" alt="${alt}">`;
}

let payload = null;
let statuses = {};
let checkins = {};
let currentView = 'list';

// ---- Map view: numbered stop markers, the courier's own live position, and a
// tap-to-see "how long from here" ETA — all computed live via OSRM, no route geometry
// is ever embedded in the link itself (keeps it short; see app.js buildCourierPayload).
let courierMap = null;
let markersLayer = null;
let routeLineLayer = null;
let meMarker = null;
let watchId = null;
let lastKnownPos = null;
let routeLineFetchedFor = null; // routeId this run's line was fetched for, to avoid refetching on every toggle

const STATUS_COLORS = { pending: '#5B6B6D', delivered: '#2D6A4F', failed: '#C23B22' };

function initCourierMapIfNeeded(){
  if (courierMap) return;
  courierMap = L.map('courierMap', { zoomControl: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap, © CARTO'
  }).addTo(courierMap);
  markersLayer = L.layerGroup().addTo(courierMap);
  routeLineLayer = L.layerGroup().addTo(courierMap);
  updateMapMarkers();
  fetchAndDrawRouteLine();
}

function numberedIcon(number, color){
  return L.divIcon({
    className: '',
    html: `<div class="map-num-icon" style="background:${color}">${number}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13]
  });
}

function updateMapMarkers(){
  if (!markersLayer || !payload) return;
  markersLayer.clearLayers();
  const bounds = [];
  payload.stops.forEach(s => {
    if (s.lat == null || s.lng == null) return;
    const status = statuses[s.id] || 'pending';
    const marker = L.marker([s.lat, s.lng], { icon: numberedIcon(s.o, STATUS_COLORS[status]) }).addTo(markersLayer);
    marker.bindPopup(`
      <div class="stop-popup">
        <div style="font-weight:700; margin-bottom:2px;">${escapeHtml(s.name || s.addr)}</div>
        <div style="font-size:12px; color:#5B6B6D; margin-bottom:6px;">${escapeHtml(s.addr)}</div>
        ${s.products ? `<div style="font-size:12px; color:#5B6B6D; margin-bottom:6px; display:flex; gap:4px; align-items:flex-start;"><span style="width:12px; flex-shrink:0;">${ICONS.apple}</span>${formatProductsWithKg(s)}</div>` : ''}
        <button class="popup-eta-btn" data-eta-for="${s.id}">${ICONS.clock} Cât mai am până aici?</button>
      </div>
    `);
    marker.on('popupopen', (e) => {
      const btn = e.popup.getElement().querySelector('[data-eta-for]');
      if (btn) btn.addEventListener('click', () => showEtaForStop(s));
    });
    bounds.push([s.lat, s.lng]);
  });
  if (bounds.length) courierMap.fitBounds(bounds, { padding: [30, 30] });
}

async function fetchAndDrawRouteLine(){
  if (!payload || routeLineFetchedFor === payload.routeId) return;
  const pts = payload.stops.filter(s => s.lat != null).map(s => `${s.lng},${s.lat}`);
  if (pts.length < 2) return;
  routeLineFetchedFor = payload.routeId;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${pts.join(';')}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code === 'Ok' && data.routes && data.routes.length){
      const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
      routeLineLayer.clearLayers();
      L.polyline(coords, { color: '#FF5A1F', weight: 4, opacity: 0.75 }).addTo(routeLineLayer);
    }
  } catch (e){
    console.error('Nu am putut desena linia traseului pe hartă', e);
  }
}

// ---- Live "traffic feel" calibration ------------------------------------------------
// No paid traffic API involved: OSRM only knows free-flow road speeds, so its ETA can be
// well off when the courier is actually stuck (or unusually free) in real traffic. Instead,
// a rolling window of the courier's own recent GPS fixes gives an OBSERVED speed, which
// gets compared against the speed OSRM assumed for the same remaining route — if the
// courier is moving at 50% of the assumed speed, the remaining drive time is scaled up
// accordingly. It's a heuristic, not real traffic data, so it only kicks in once there's
// enough recent genuine movement to trust (a parked/delivering courier reads ~0 km/h,
// which must NOT be mistaken for "gridlock").
const RECENT_FIXES_WINDOW_MS = 3 * 60 * 1000;
const MIN_TRUSTED_DISTANCE_KM = 0.15;
const MIN_TRUSTED_ELAPSED_H = 60 / 3600; // 60 seconds
const TRAFFIC_FACTOR_MIN = 0.6;
const TRAFFIC_FACTOR_MAX = 2.5;
let recentFixes = [];

function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Returns the courier's observed speed (km/h) over the recent window, or null if there isn't yet enough trustworthy movement to estimate it from (too little time/distance covered — e.g. still parked at a stop). */
function getObservedSpeedKmh(){
  if (recentFixes.length < 2) return null;
  const oldest = recentFixes[0];
  const newest = recentFixes[recentFixes.length - 1];
  const distKm = haversineKm(oldest.lat, oldest.lng, newest.lat, newest.lng);
  const elapsedH = (newest.t - oldest.t) / 3600000;
  if (distKm < MIN_TRUSTED_DISTANCE_KM || elapsedH < MIN_TRUSTED_ELAPSED_H) return null;
  return distKm / elapsedH;
}

function startLocationWatch(){
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      lastKnownPos = pos.coords;

      const now = Date.now();
      recentFixes.push({ lat: pos.coords.latitude, lng: pos.coords.longitude, t: now });
      recentFixes = recentFixes.filter(f => now - f.t <= RECENT_FIXES_WINDOW_MS);

      if (!courierMap) return;
      const latlng = [pos.coords.latitude, pos.coords.longitude];
      if (!meMarker){
        meMarker = L.marker(latlng, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(courierMap);
      } else {
        meMarker.setLatLng(latlng);
      }
    },
    (err) => console.error('Nu am putut urmări poziția live', err),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function stopLocationWatch(){
  if (watchId != null){
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  recentFixes = [];
}

const STOP_HANDOFF_BUFFER_MIN = 10; // same handoff/buffer assumption as the dispatcher's own route planning (app.js STOP_BUFFER_MIN)

/**
 * Estimates arrival at the tapped stop by routing through every stop still PENDING
 * (not yet delivered/failed) up to and including it, in visiting order — never a
 * straight line from the courier's current position to just that one stop. A courier
 * mid-route (say, just finished stop 3 of 10) still has to actually complete stops
 * 4-9 first if a customer at stop 10 asks "how long until you get here"; a direct
 * route from the courier's live position to stop 10 alone would badly underestimate it.
 */
async function showEtaForStop(stop){
  const banner = document.getElementById('etaBanner');
  const hint = document.getElementById('locateHint');
  if (!lastKnownPos){
    banner.style.display = 'none';
    hint.style.display = 'block';
    hint.textContent = 'Îți aștept poziția GPS — permite accesul la locație și încearcă din nou în câteva secunde.';
    return;
  }

  const stopStatus = statuses[stop.id] || 'pending';
  hint.style.display = 'none';
  banner.style.display = 'block';

  if (stopStatus !== 'pending'){
    const label = stopStatus === 'delivered' ? '✓ deja marcată livrată' : '✕ deja marcată nelivrată';
    banner.innerHTML = `<div class="eta-title">${escapeHtml(stop.name || stop.addr)}</div><div class="eta-detail">${label}</div>`;
    return;
  }

  banner.innerHTML = `<div class="eta-title">${escapeHtml(stop.name || stop.addr)}</div><div class="eta-detail">Se calculează…</div>`;

  const remaining = payload.stops
    .filter(s => s.o <= stop.o && (statuses[s.id] || 'pending') === 'pending' && s.lat != null)
    .sort((a, b) => a.o - b.o);

  if (!remaining.length) return; // shouldn't happen since stop itself is pending and always qualifies

  const waypoints = [`${lastKnownPos.longitude},${lastKnownPos.latitude}`, ...remaining.map(s => `${s.lng},${s.lat}`)];
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${waypoints.join(';')}?overview=false`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code === 'Ok' && data.routes && data.routes.length){
      const driveMin = data.routes[0].duration / 60;
      const distanceKm = data.routes[0].distance / 1000;

      // Calibrate against real, currently-observed traffic: compare the courier's recent
      // actual speed to the speed OSRM assumed for this remaining stretch. No adjustment
      // (and no claim of calibration) is made until there's a trustworthy recent sample.
      let adjustedDriveMin = driveMin;
      let trafficNote = '';
      const assumedSpeedKmh = driveMin > 0 ? distanceKm / (driveMin / 60) : null;
      const observedSpeedKmh = getObservedSpeedKmh();
      if (assumedSpeedKmh && observedSpeedKmh){
        const factor = Math.min(Math.max(assumedSpeedKmh / observedSpeedKmh, TRAFFIC_FACTOR_MIN), TRAFFIC_FACTOR_MAX);
        adjustedDriveMin = driveMin * factor;
        if (factor > 1.15) trafficNote = ' · trafic mai aglomerat decât normal';
        else if (factor < 0.87) trafficNote = ' · trafic mai fluid decât normal';
        else trafficNote = ' · calibrat după viteza ta actuală';
      }

      const stopsBefore = remaining.length - 1; // pending stops the courier still hands off before reaching the target
      const totalMin = Math.round(adjustedDriveMin + stopsBefore * STOP_HANDOFF_BUFFER_MIN);
      const km = distanceKm.toFixed(1);
      const arrival = new Date(Date.now() + totalMin * 60000);
      const arrivalStr = `${arrival.getHours().toString().padStart(2, '0')}:${arrival.getMinutes().toString().padStart(2, '0')}`;
      const viaText = stopsBefore > 0 ? ` · via ${stopsBefore} ${stopsBefore === 1 ? 'oprire rămasă' : 'opriri rămase'}` : '';
      banner.innerHTML = `<div class="eta-title">${escapeHtml(stop.name || stop.addr)}</div><div class="eta-detail">⏱ ~${totalMin} min (sosire ~${arrivalStr}) · ${km} km${viaText}${trafficNote}</div>`;
    } else {
      banner.innerHTML = `<div class="eta-title">${escapeHtml(stop.name || stop.addr)}</div><div class="eta-detail">Nu am putut calcula timpul — încearcă din nou.</div>`;
    }
  } catch (e){
    console.error('Nu am putut calcula ETA', e);
    banner.innerHTML = `<div class="eta-title">${escapeHtml(stop.name || stop.addr)}</div><div class="eta-detail">Nu am putut calcula timpul — verifică conexiunea.</div>`;
  }
}

function switchView(view){
  currentView = view;
  document.body.classList.toggle('view-map', view === 'map');
  if (view === 'map'){
    initCourierMapIfNeeded();
    startLocationWatch();
    setTimeout(() => courierMap && courierMap.invalidateSize(), 50);
  } else {
    stopLocationWatch();
  }
  render();
}

function render(){
  const root = document.getElementById('root');

  if (!payload || !Array.isArray(payload.stops)){
    root.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">${ICONS.warn}</div>
        <div class="es-title">Link invalid sau incomplet</div>
        <div class="es-sub">Acest link nu conține un traseu valid. Cere dispecerului un link nou.</div>
      </div>`;
    return;
  }

  const total = payload.stops.length;
  const pending = payload.stops.filter(s => !statuses[s.id]).sort((a, b) => a.o - b.o);
  const resolved = payload.stops.filter(s => statuses[s.id]).sort((a, b) => a.o - b.o);
  const delivered = resolved.filter(s => statuses[s.id] === 'delivered').length;
  const failed = resolved.length - delivered;
  const pct = total ? Math.round(resolved.length / total * 100) : 0;
  const checkinCount = Object.keys(checkins).length;

  const next = pending[0];
  const rest = pending.slice(1);

  root.innerHTML = `
    <div class="head">
      <div class="head-row">
        <div>
          <div class="head-title">${escapeHtml(payload.courier || 'Curier')}</div>
          <div class="head-sub">${escapeHtml(payload.date || '')} · ${total} ${total === 1 ? 'oprire' : 'opriri'}</div>
        </div>
        <div class="head-stat"><b>${resolved.length}</b><span class="of">/${total}</span><span>finalizate</span></div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="segmented">
        <button class="${currentView === 'list' ? 'active' : ''}" data-view="list">${ICONS.list} Listă</button>
        <button class="${currentView === 'map' ? 'active' : ''}" data-view="map">${ICONS.map} Hartă</button>
      </div>
      ${checkinCount ? `<button class="send-checkins-btn" id="sendCheckinsBtn">${ICONS.send}<span class="btn-label">Trimite ${checkinCount} check-in${checkinCount === 1 ? '' : '-uri'} către dispecer</span></button>` : ''}
    </div>
    <div class="content">
      <div id="stopsRoot"></div>
      <div class="foot-note">Bifele și check-in-urile rămân salvate doar pe acest telefon, până le trimiți tu înapoi.</div>
    </div>
  `;

  root.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  const sendBtn = document.getElementById('sendCheckinsBtn');
  if (sendBtn) sendBtn.addEventListener('click', sendCheckinsBack);

  const stopsRoot = document.getElementById('stopsRoot');
  let html = '';

  if (next) html += `<div class="section-label">Următoarea oprire</div>` + stopCardHtml(next, 'hero-card');
  if (rest.length){
    html += `<div class="section-label">Opriri rămase (${rest.length})</div>`;
    rest.forEach(s => { html += stopCardHtml(s, 'stop-card'); });
  }
  if (resolved.length){
    html += `<div class="section-label">Finalizate (${resolved.length})</div>`;
    resolved.forEach(s => { html += doneCardHtml(s); });
  }
  stopsRoot.innerHTML = html;

  stopsRoot.querySelectorAll('[data-mark]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.mark;
      const value = btn.dataset.value;
      const wasResolved = !!statuses[id];
      if (statuses[id] === value) delete statuses[id];
      else statuses[id] = value;
      saveStatuses(payload.routeId, statuses);
      // a pending stop just getting resolved gets a beat to show the confirmed state
      // before the list reflows it away — an undo (tapping the same value again) or a
      // switch (delivered <-> failed) from the compact "Finalizate" rows re-renders instantly
      if (!wasResolved){
        const card = btn.closest('.hero-card, .stop-card');
        btn.classList.add('active');
        if (card) setTimeout(() => { card.classList.add('leaving'); setTimeout(render, 320); }, 260);
        else render();
      } else {
        render();
      }
    });
  });

  stopsRoot.querySelectorAll('[data-checkin]').forEach(btn => {
    btn.addEventListener('click', () => doCheckin(btn.dataset.checkin, btn));
  });

  updateMapMarkers(); // no-op if the map hasn't been opened yet — keeps marker colors in sync with status once it has
}

/** Full stop card — used both for the emphasized "next stop" hero and the quieter "rest" list, same markup, different class. */
function stopCardHtml(s, cardClass){
  const checkin = checkins[s.id];
  const paymentChip = (s.amount != null || s.payment)
    ? `<span class="chip cash">${ICONS.cash}${s.amount != null ? Number(s.amount).toFixed(2) + ' lei' : ''}${s.amount != null && s.payment ? ' · ' : ''}${escapeHtml(s.payment || '')}</span>`
    : '';
  const windowChip = s.winStart ? `<span class="chip time">${ICONS.clock}${escapeHtml(s.winStart)}–${escapeHtml(s.winEnd)}</span>` : '';
  const productsChip = s.products ? `<span class="chip products">${ICONS.apple}${formatProductsWithKg(s)}</span>` : '';

  return `
    <div class="${cardClass}" data-id="${s.id}">
      <div class="card-top">
        <div class="hero-num">${s.o}</div>
        <div>
          <div class="card-name">${escapeHtml(s.name || s.addr)}</div>
          ${s.name ? `<div class="card-addr">${escapeHtml(s.addr)}</div>` : ''}
          ${s.details ? `<div class="details-line">${ICONS.building}${escapeHtml(s.details)}</div>` : ''}
        </div>
      </div>
      <div class="chip-row">${windowChip}${paymentChip}${productsChip}</div>
      ${s.note ? `<div class="note-line">${ICONS.note}${escapeHtml(s.note)}</div>` : ''}
      <div class="icon-row">
        ${s.phone ? `<a class="icon-btn" href="tel:${escapeHtml(s.phone)}" title="Sună">${ICONS.phone}</a>` : ''}
        ${s.lat != null ? `<a class="icon-btn" href="${mapsUrl(s.lat, s.lng)}" target="_blank" rel="noopener" title="Deschide în Google Maps">${iconImg('icons/maps-icon.png', 'Maps')}</a>` : ''}
        ${s.lat != null ? `<a class="icon-btn" href="${wazeUrl(s.lat, s.lng)}" target="_blank" rel="noopener" title="Deschide în Waze">${iconImg('icons/waze-icon.svg', 'Waze')}</a>` : ''}
        <button class="icon-btn ${checkin ? 'done' : ''}" data-checkin="${s.id}" title="${checkin ? 'Refă check-in' : 'Check-in aici'}">${iconImg('icons/checkin-icon.png', 'Check-in')}</button>
      </div>
      <div class="status-row">
        <button class="status-btn ok" data-mark="${s.id}" data-value="delivered">${ICONS.check} Livrat</button>
        <button class="status-btn bad" data-mark="${s.id}" data-value="failed">${ICONS.x} Nelivrat</button>
      </div>
    </div>`;
}

/** Compact, muted row for an already-resolved stop — still fully functional (can flip status or undo), just out of the way. */
function doneCardHtml(s){
  const status = statuses[s.id];
  return `
    <div class="done-card" data-id="${s.id}">
      <div class="hero-num">${s.o}</div>
      <div class="done-name">${escapeHtml(s.name || s.addr)}<span>${escapeHtml(s.addr)}</span></div>
      <button class="mini-status ok ${status === 'delivered' ? 'active' : ''}" data-mark="${s.id}" data-value="delivered" title="Livrat">${ICONS.check}</button>
      <button class="mini-status bad ${status === 'failed' ? 'active' : ''}" data-mark="${s.id}" data-value="failed" title="Nelivrat">${ICONS.x}</button>
    </div>`;
}

async function doCheckin(stopId, btn){
  btn.classList.add('loading');
  btn.disabled = true;
  try {
    const pos = await getCurrentPosition();
    checkins[stopId] = {
      lat: Math.round(pos.coords.latitude * 1e6) / 1e6,
      lng: Math.round(pos.coords.longitude * 1e6) / 1e6,
      accuracy: pos.coords.accuracy,
      savedAt: new Date().toISOString()
    };
    saveCheckins(payload.routeId, checkins);
    render(); // rebuilds the button in its "done" state — loading class goes away with it
  } catch (e){
    console.error('Check-in eșuat', e);
    let msg = 'Nu am putut lua poziția GPS.';
    if (e.code === 1) msg = 'Acces la locație refuzat — permite accesul la locație pentru acest site din setările telefonului.';
    else if (e.code === 3) msg = 'A durat prea mult să localizăm — încearcă din nou, ideal afară sau lângă geam.';
    alert(msg);
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

async function sendCheckinsBack(){
  const btn = document.getElementById('sendCheckinsBtn');
  const label = btn.querySelector('.btn-label');
  const originalText = label.textContent;
  label.textContent = 'Se generează linkul…';
  btn.disabled = true;

  const entries = Object.entries(checkins).map(([stopId, c]) => {
    const stop = payload.stops.find(s => String(s.id) === String(stopId));
    return stop ? [stop.addr, c.lat, c.lng] : null;
  }).filter(Boolean);

  const returnPayload = { courier: payload.courier, date: payload.date, checkins: entries };
  const encoded = LZString.compressToEncodedURIComponent(JSON.stringify(returnPayload));
  const base = location.href.split('#')[0].replace(/curier\.html?$/i, '').replace(/\/?$/, '/');
  const longLink = `${base}index.html#checkins=${encoded}`;

  const shortLink = await shortenLink(longLink);
  const link = shortLink || longLink;

  label.textContent = originalText;
  btn.disabled = false;

  const text = encodeURIComponent(`Check-in-uri traseu (${payload.courier}, ${payload.date}):\n${link}`);
  window.open(`https://wa.me/?text=${text}`, '_blank');
}

document.addEventListener('DOMContentLoaded', () => {
  payload = loadPayloadFromHash();
  if (payload && payload.routeId){
    statuses = loadStatuses(payload.routeId);
    checkins = loadCheckins(payload.routeId);
  }
  render();
});
