// ===================================================================
// Urmărire livrare — pagina clientului.
// O singură pagină, fără taburi (spre deosebire de curier.html) — un
// client are o singură oprire de urmărit, nu un traseu întreg. Citește
// stops/{stopId} (vezi app.js ensureCourierRun / firestore.rules) —
// un document restrâns deliberat, care conține STRICT datele acestui
// client, niciodată alți clienți sau traseul complet. Poziția curierului
// și statusul ajung aici prin functions/index.js (syncCourierRunToStops),
// nu direct de la curier.
// ===================================================================

const db = firebase.firestore();
let currentStopId = null;
let stopData = null;
let loadingStop = true;

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/** Mirrors app.js/curier.js's formatProductsWithKg, reading straight off the stops doc's fields. */
function formatProductsWithKg(data){
  if (!data.products) return '';
  if (data.productsKg == null) return escapeHtml(data.products);
  const rounded = Math.round(data.productsKg * 100) / 100;
  const kgText = rounded % 1 === 0 ? rounded : rounded.toFixed(2);
  return `${escapeHtml(data.products)} · Total: ${kgText} kg`;
}

function timeAgo(iso){
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 20) return 'chiar acum';
  if (diffSec < 60) return `acum ${diffSec}s`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `acum ${min} min`;
  const h = Math.round(min / 60);
  return `acum ${h} ${h === 1 ? 'oră' : 'ore'}`;
}

const ICONS = {
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
  apple: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8c-2 0-4 1.6-4 5 0 3 2 7 4 7s2-1 4-1 2 1 4 1c1.6 0 3.4-3 3.7-5"/><path d="M12 8c0-1.8 1-3.4 3-4"/></svg>',
  building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v15"/><path d="M13 21v-9a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v9"/><path d="M9 9h0M9 13h0M9 17h0"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5L22 20H2L12 3.5z"/><path d="M12 10v4.5M12 17.5h0"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.6 8.4A9 9 0 0 1 8 19l-4 1 1.3-3.7A8.3 8.3 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>'
};

// ---- Map: two markers (client's fixed home pin + the courier's live position) — no route
// line here, since stops/{stopId} deliberately never carries the full route geometry (see
// firestore.rules / app.js ensureCourierRun — the client only ever sees its own stop). ----
let trackMap = null;
let homeMarker = null;
let courierMarker = null;

function initMapIfNeeded(){
  if (trackMap) return;
  trackMap = L.map('trackMap', { zoomControl: true, attributionControl: false });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19
  }).addTo(trackMap);
}

function updateMap(data){
  if (data.lat == null || data.lng == null) return;
  document.getElementById('mapWrap').style.display = 'block';
  const firstInit = !trackMap;
  initMapIfNeeded();
  if (firstInit) setTimeout(() => trackMap.invalidateSize(), 50);

  if (!homeMarker){
    homeMarker = L.marker([data.lat, data.lng], {
      icon: L.divIcon({ className: '', html: '<div class="home-pin"></div>', iconSize: [30, 30], iconAnchor: [15, 28] })
    }).addTo(trackMap);
  }

  const showCourier = data.status === 'pending' && data.courierLat != null && data.courierLng != null;
  let courierJustAppeared = false;
  if (showCourier){
    const latlng = [data.courierLat, data.courierLng];
    if (!courierMarker){
      courierMarker = L.marker(latlng, {
        icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] })
      }).addTo(trackMap);
      courierJustAppeared = true;
    } else {
      courierMarker.setLatLng(latlng);
    }
  } else if (courierMarker){
    trackMap.removeLayer(courierMarker);
    courierMarker = null;
  }

  // Only auto-fit on first load / when the courier marker first shows up — never again after
  // that, so a client who's zoomed/panned to look around isn't yanked back every ~15s as the
  // courier's position keeps updating.
  if (firstInit || courierJustAppeared){
    if (showCourier) trackMap.fitBounds([[data.lat, data.lng], [data.courierLat, data.courierLng]], { padding: [40, 50], maxZoom: 15 });
    else trackMap.setView([data.lat, data.lng], 15);
  }
}

function buildStatusCardInner(data){
  const status = data.status || 'pending';
  let statusClass = 'pending', icon = ICONS.clock, title, sub = '';
  if (status === 'delivered'){
    statusClass = 'done'; icon = ICONS.check;
    title = 'Comanda a fost livrată';
  } else if (status === 'failed'){
    statusClass = 'failed'; icon = ICONS.x;
    title = 'Livrarea nu s-a putut finaliza';
    sub = 'Te vom contacta pentru a stabili o nouă livrare.';
  } else {
    const ahead = data.stopsAhead || 0;
    if (ahead <= 0){
      title = 'Curierul e în drum spre tine!';
      sub = 'Ești următoarea oprire.';
    } else {
      title = 'Coletul tău este pe drum';
      sub = `Mai sunt ${ahead} ${ahead === 1 ? 'oprire' : 'opriri'} până la tine.`;
    }
  }
  const updatedLine = (status === 'pending' && data.courierUpdatedAt)
    ? `<div class="status-updated">Poziție actualizată ${timeAgo(data.courierUpdatedAt)}</div>`
    : '';
  return {
    statusClass,
    html: `
      <div class="status-icon ${statusClass}">${icon}</div>
      <div class="status-title">${escapeHtml(title)}</div>
      ${sub ? `<div class="status-sub">${escapeHtml(sub)}</div>` : ''}
      ${updatedLine}
    `
  };
}

function updateStatusCard(data){
  const card = document.getElementById('statusCard');
  if (!card) return;
  const { statusClass, html } = buildStatusCardInner(data);
  card.className = `status-card ${statusClass}`;
  card.innerHTML = html;
}

/** Writes directly to stops/{stopId} — firestore.rules allows the client to update only clientConfirmed/clientNote here. */
function updateStopField(fields){
  if (!currentStopId) return;
  db.collection('stops').doc(currentStopId).update(fields)
    .catch(e => console.error('Nu am putut trimite răspunsul', e));
}

let noteSaveTimer = null;

function wireActions(){
  const confirmBtn = document.getElementById('confirmBtn');
  if (confirmBtn){
    confirmBtn.addEventListener('click', () => {
      const newVal = stopData.clientConfirmed === true ? null : true;
      stopData.clientConfirmed = newVal;
      confirmBtn.classList.toggle('active', newVal === true);
      confirmBtn.innerHTML = `${ICONS.check} ${newVal === true ? 'Ai confirmat: voi fi acasă' : 'Voi fi acasă'}`;
      updateStopField({ clientConfirmed: newVal });
    });
  }
  const noteInput = document.getElementById('noteInput');
  if (noteInput){
    noteInput.addEventListener('input', () => {
      const val = noteInput.value;
      clearTimeout(noteSaveTimer);
      noteSaveTimer = setTimeout(() => {
        updateStopField({ clientNote: val });
        const saved = document.getElementById('noteSaved');
        if (saved){
          saved.classList.add('show');
          setTimeout(() => saved.classList.remove('show'), 1600);
        }
      }, 800);
    });
  }
}

/**
 * Built ONCE, the first time a stop loads — order details (name/address/products/window) never
 * change after the dispatcher creates the run, and clientConfirmed/clientNote are only ever
 * written by this same client (the Cloud Function that syncs courier position/status back never
 * touches them — see functions/index.js), so rebuilding this on every ~15s position ping would
 * only risk interrupting someone mid-typing in the note box for no reason. Only the status card
 * (built separately, see updateStatusCard) and the map need to react to those frequent updates.
 */
function shellHtml(data){
  const { statusClass, html: statusInner } = buildStatusCardInner(data);
  const windowChip = data.winStart ? `<span class="chip time">${ICONS.clock}${escapeHtml(data.winStart)}</span>` : '';
  const paymentChip = (data.amount != null || data.payment)
    ? `<span class="chip cash">${ICONS.cash}${data.amount != null ? Number(data.amount).toFixed(2) + ' lei' : ''}${data.amount != null && data.payment ? ' · ' : ''}${escapeHtml(data.payment || '')}</span>`
    : '';
  const productsChip = data.products ? `<span class="chip products">${ICONS.apple}${formatProductsWithKg(data)}</span>` : '';
  const confirmed = data.clientConfirmed === true;

  return `
    <div class="content">
      <div class="status-card ${statusClass}" id="statusCard">${statusInner}</div>

      <div class="card">
        <div class="card-title">Comanda ta</div>
        <div class="order-name">${escapeHtml(data.clientName || data.addr || '')}</div>
        ${data.clientName ? `<div class="order-addr">${escapeHtml(data.addr || '')}</div>` : ''}
        ${data.details ? `<div class="details-line">${ICONS.building}${escapeHtml(data.details)}</div>` : ''}
        <div class="chip-row">${windowChip}${paymentChip}${productsChip}</div>
      </div>

      <div class="card" id="actionsCard" style="display:${data.status === 'pending' ? '' : 'none'};">
        <button class="confirm-btn ${confirmed ? 'active' : ''}" id="confirmBtn">${ICONS.check} ${confirmed ? 'Ai confirmat: voi fi acasă' : 'Voi fi acasă'}</button>
        <div class="note-editor">
          <label class="note-label">${ICONS.note}Observație pentru curier (opțional)</label>
          <textarea class="note-input" id="noteInput" rows="2" placeholder="ex: disponibil doar până la ora 15:00">${escapeHtml(data.clientNote || '')}</textarea>
          <div class="note-saved" id="noteSaved">Salvat ✓</div>
        </div>
      </div>

      <div class="foot-note">Crăița Merelor — cu tradiție din Voinești!</div>
    </div>
  `;
}

let contentBuilt = false;

function render(){
  const root = document.getElementById('root');
  const mapWrap = document.getElementById('mapWrap');

  if (!stopData){
    mapWrap.style.display = 'none';
    contentBuilt = false;
    root.innerHTML = loadingStop ? `
      <div class="empty-state">
        <div class="es-icon">${ICONS.clock}</div>
        <div class="es-title">Se încarcă…</div>
      </div>` : `
      <div class="empty-state">
        <div class="es-icon">${ICONS.warn}</div>
        <div class="es-title">Link invalid</div>
        <div class="es-sub">Acest link de urmărire nu mai este valabil. Contactează-ne dacă ai nevoie de ajutor.</div>
      </div>`;
    return;
  }

  updateMap(stopData);

  if (!contentBuilt){
    root.innerHTML = shellHtml(stopData);
    contentBuilt = true;
    wireActions();
  } else {
    updateStatusCard(stopData);
    const actionsCard = document.getElementById('actionsCard');
    if (actionsCard) actionsCard.style.display = stopData.status === 'pending' ? '' : 'none';
  }
}

// Keeps "actualizat acum X min" fresh even between snapshots (courier may be stationary for a while).
setInterval(() => { if (stopData) updateStatusCard(stopData); }, 30000);

function initTracking(){
  currentStopId = new URLSearchParams(location.search).get('s');
  if (!currentStopId){
    loadingStop = false;
    render();
    return;
  }
  firebase.auth().setPersistence(firebase.auth.Auth.Persistence.SESSION)
    .then(() => firebase.auth().signInAnonymously())
    .then(() => {
      db.collection('stops').doc(currentStopId).onSnapshot(
        (doc) => {
          loadingStop = false;
          stopData = doc.exists ? doc.data() : null;
          render();
        },
        (err) => {
          console.error('Nu am putut încărca urmărirea livrării', err);
          loadingStop = false;
          stopData = null;
          render();
        }
      );
    })
    .catch((err) => {
      console.error('Autentificare anonimă eșuată', err);
      loadingStop = false;
      stopData = null;
      render();
    });
}

document.addEventListener('DOMContentLoaded', () => {
  render();
  initTracking();
});
