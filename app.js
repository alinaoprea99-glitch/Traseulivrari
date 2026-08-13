// ===================================================================
// Planificator trasee curieri — logică principală
// Geocodare: Nominatim (OpenStreetMap) · Rutare: OSRM (router.project-osrm.org)
// ===================================================================

const COURIER_COLORS = ['#FF5A1F', '#8B5CF6', '#1D7FBF', '#2D6A4F', '#C2347E', '#B8860B'];

const state = {
  couriers: [],      // {id, name, start:{address,lat,lng}, end:{address,lat,lng}, color}
  addresses: [],      // {id, raw, details, clientName, phone, amount, paymentMethod, lat, lng, status:'pending'|'ok'|'error', courierId:null}
  routes: {},         // courierId -> {order:[addressId...], legs:[{distKm,durMin}], totalKm, totalMin}
  routeSelection: new Set(), // address ids currently checked in the Trasee tab, for bulk move
  nextCourierId: 1,
  nextAddrId: 1,
};

const PAYMENT_METHODS = ['Ramburs', 'Revolut', 'OP'];

const ICONS = {
  building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v15"/><path d="M13 21v-9a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v9"/><path d="M9 9h0M9 13h0M9 17h0"/></svg>',
  apple: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8c-2 0-4 1.6-4 5 0 3 2 7 4 7s2-1 4-1 2 1 4 1c1.6 0 3.4-3 3.7-5"/><path d="M12 8c0-1.8 1-3.4 3-4"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.6 8.4A9 9 0 0 1 8 19l-4 1 1.3-3.7A8.3 8.3 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5c0-1 1-2 2-2h2l2 5-2 1a11 11 0 0 0 6 6l1-2 5 2v2c0 1-1 2-2 2A15 15 0 0 1 4 5z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="11" width="15" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l.9-4L16.5 4.4a1.5 1.5 0 0 1 2.1 0l1 1a1.5 1.5 0 0 1 0 2.1L8 19 4 20z"/><path d="M14.5 6.5l3 3"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3L11 13"/><path d="M21 3l-7 18-4-8-8-4 19-6z"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 3H5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 .6 1.4l8 8a2 2 0 0 0 2.8 0l6.5-6.5a2 2 0 0 0 0-2.8l-8-8a2 2 0 0 0-1.4-.6z"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/></svg>',
  emptyPin: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-7.4 7-12.5A7 7 0 0 0 5 9.5C5 14.6 12 22 12 22z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  emptyRoute: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-3-3 8-4 4 4-4 8-3-3-6 6"/><path d="M4 17l-1 4 4-1"/></svg>'
};

let map, markersLayer, routeLinesLayer;

// -------------------------------------------------------------------
// INIT
// -------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initTabs();
  initCourierPanel();
  initAddressPanel();
  initRoutePanel();
  initActionBar();
  setDateStamp();
  initAuthGate();
});

const db = firebase.firestore();
let firestoreSyncStarted = false;

/**
 * True for the duration of a render triggered by adopting a Firestore snapshot (rather than
 * a genuine local edit). render*() functions check this before their end-of-render
 * save*ToStorage() call (see below) — without it, adopting our OWN write's echo would
 * re-save, which re-triggers the same snapshot, forever. A local mutation always renders
 * with this flag false, so it still gets saved exactly as before.
 */
let applyingRemoteSnapshot = false;

/**
 * Gatekeeper before the dispatcher UI is usable: only the authorized dispatcher account
 * (checked again server-side by firestore.rules, not just here) can read/write the shared
 * data. Login state persists across reloads (Firebase Auth's own local persistence), so
 * this only actually prompts once per browser until an explicit "Deconectare".
 */
function initAuthGate(){
  const loginScreen = document.getElementById('loginScreen');
  const appRoot = document.getElementById('appRoot');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const loginSubmitBtn = document.getElementById('loginSubmitBtn');

  firebase.auth().onAuthStateChanged((user) => {
    if (user){
      loginScreen.style.display = 'none';
      appRoot.style.display = '';
      // The map was created (initMap, in DOMContentLoaded) while appRoot was still
      // display:none — Leaflet measured a 0×0 container then, so it needs an explicit
      // nudge now that the real layout is visible, or it stays blank/misrendered.
      setTimeout(() => map && map.invalidateSize(), 0);
      initFirestoreSync();
    } else {
      appRoot.style.display = 'none';
      loginScreen.style.display = 'flex';
    }
  });

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    loginError.style.display = 'none';
    loginSubmitBtn.disabled = true;
    loginSubmitBtn.textContent = 'Se conectează…';
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    firebase.auth().signInWithEmailAndPassword(email, password)
      .catch(() => {
        loginError.textContent = 'Email sau parolă greșite.';
        loginError.style.display = 'block';
      })
      .finally(() => {
        loginSubmitBtn.disabled = false;
        loginSubmitBtn.textContent = 'Intră în cont';
      });
  });

  document.getElementById('logoutBtn').addEventListener('click', () => {
    firebase.auth().signOut();
  });
}

/**
 * Firestore replaces localStorage as the source of truth for couriers/addresses/routes —
 * onSnapshot both loads the initial data AND keeps state live-synced afterward (across tabs,
 * browsers, devices), superseding the old localStorage `storage`-event cross-tab sync.
 * Each collection is still a single document holding the whole array/object (see
 * save*ToStorage below) — matches how this data was already saved wholesale, not
 * incrementally, so this is a direct swap of the storage backend, not a data-model change.
 */
function initFirestoreSync(){
  if (firestoreSyncStarted) return; // onAuthStateChanged can fire more than once (e.g. token refresh)
  firestoreSyncStarted = true;

  let couriersLoadedOnce = false;
  db.collection('dispatcherData').doc('couriers').onSnapshot((doc) => {
    const data = doc.data();
    if (data && Array.isArray(data.couriers) && data.couriers.length){
      state.couriers = data.couriers;
      state.nextCourierId = data.nextCourierId || (Math.max(...data.couriers.map(c => c.id)) + 1);
    } else if (!couriersLoadedOnce){
      addCourier(); // first-ever login for this project: seed one courier by default
      saveCouriersToStorage(); // render() below is guarded (no self-save) — this seed needs an explicit save
    } else {
      state.couriers = [];
    }
    couriersLoadedOnce = true;
    applyingRemoteSnapshot = true;
    renderCouriers();
    applyingRemoteSnapshot = false;
  }, (err) => console.error('Nu am putut sincroniza curierii', err));

  let addressesLoadedOnce = false;
  db.collection('dispatcherData').doc('addresses').onSnapshot((doc) => {
    const data = doc.data();
    state.addresses = (data && Array.isArray(data.addresses)) ? data.addresses : [];
    state.nextAddrId = (data && data.nextAddrId) || (state.addresses.length ? Math.max(...state.addresses.map(a => a.id)) + 1 : 1);
    applyingRemoteSnapshot = true;
    renderAddresses();
    renderCouriers();
    renderRouteSummary();
    applyingRemoteSnapshot = false;
    maybeShowGeocodeButton();
    updateExportButtonsState();
    redrawMap();
    if (!addressesLoadedOnce && state.addresses.length) fitMapToAll(); // frame previous work once, on first load only — not on every later edit
    addressesLoadedOnce = true;
  }, (err) => console.error('Nu am putut sincroniza adresele', err));

  db.collection('dispatcherData').doc('routes').onSnapshot((doc) => {
    state.routes = doc.exists ? routesFromFirestore(doc.data()) : {};
    applyingRemoteSnapshot = true;
    renderRouteSummary();
    applyingRemoteSnapshot = false;
    redrawMap();
    syncCourierRunListeners();
  }, (err) => console.error('Nu am putut sincroniza traseele', err));
}

// Incoming courier check-ins/notes/status now arrive live via syncCourierRunListeners/
// applyCourierRunUpdates (see the SEND TO COURIER section) — no more manual link/WhatsApp
// round trip to receive them (was: checkForIncomingCheckins + showImportCheckinsModal).

function setDateStamp(){
  const d = new Date();
  const fmt = d.toLocaleDateString('ro-RO', { weekday:'long', day:'numeric', month:'long' });
  document.getElementById('dateStamp').textContent = `Manifest de livrare · ${fmt}`;
}

// action: optional { label, onClick } — renders a button inside the toast (e.g. "Anulează"),
// and gives it more time on screen since there's something to read and react to.
function showToast(msg, isError=false, action=null){
  const t = document.getElementById('toast');
  clearTimeout(t._timer);
  if (action){
    t.innerHTML = `<span class="toast-msg"></span><button class="toast-action">${escapeHtml(action.label)}</button>`;
    t.querySelector('.toast-msg').textContent = msg;
    t.querySelector('.toast-action').addEventListener('click', () => {
      clearTimeout(t._timer);
      t.classList.remove('show');
      action.onClick();
    });
  } else {
    t.textContent = msg;
  }
  t.className = 'toast show' + (isError ? ' error' : '');
  t._timer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 3200);
}

// -------------------------------------------------------------------
// MAP
// -------------------------------------------------------------------
function initMap(){
  map = L.map('map', { zoomControl:true }).setView([45.9432, 24.9668], 7); // Romania default
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap, © CARTO'
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  routeLinesLayer = L.layerGroup().addTo(map);
}

function updateMapTopBar(){
  const geocoded = state.addresses.filter(a => a.status === 'ok').length;
  document.getElementById('mapSub').textContent = `${geocoded} adrese · ${state.couriers.length} curieri`;
  const hasRoutes = Object.keys(state.routes).length > 0;
  document.getElementById('mapTitle').textContent = hasRoutes ? 'Trasee active' : 'Niciun traseu activ';
}

// -------------------------------------------------------------------
// TABS
// -------------------------------------------------------------------
function initTabs(){
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.panel).classList.add('active');
    });
  });
}

function switchToTab(panelId){
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.panel === panelId));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === panelId));
}

// -------------------------------------------------------------------
// COURIERS
// -------------------------------------------------------------------
function initCourierPanel(){
  document.getElementById('addCourierBtn').addEventListener('click', () => {
    addCourier();
    renderCouriers();
  });
}

// ---- Persistent work-in-progress (Firestore) -------------------------
// Couriers, addresses AND routes are all saved to Firestore (dispatcherData/*, see
// initFirestoreSync above) across sessions/reloads/devices, so a browser refresh (e.g. to
// pick up an app update) never loses a day's work in progress. Everything only gets cleared
// by the explicit "Resetează ..." actions in the action bar — never by a reload. save*ToStorage()
// piggybacks on the render*() functions that already run after every mutation, so every call
// site that changes addresses/routes stays covered for free. (Function names kept as
// "...Storage" rather than renamed to "...Firestore" — same call sites, same purpose, only the
// backend changed.)
function saveCouriersToStorage(){
  db.collection('dispatcherData').doc('couriers').set({
    couriers: state.couriers,
    nextCourierId: state.nextCourierId
  }).catch(e => console.error('Could not save couriers', e));
}

function saveAddressesToStorage(){
  db.collection('dispatcherData').doc('addresses').set({
    addresses: state.addresses,
    nextAddrId: state.nextAddrId
  }).catch(e => console.error('Could not save addresses', e));
}

/**
 * Firestore rejects arrays-of-arrays outright ("Nested arrays are not supported") — and
 * a route's OSRM geometry is exactly that: GeoJSON coordinates as [[lng,lat], [lng,lat], ...].
 * Round-trips through {lng,lat} objects (an array of maps, which Firestore is fine with)
 * just at the storage boundary; every other part of the app keeps using the plain
 * [lng,lat] tuples GeoJSON/Leaflet expect.
 */
function routesForFirestore(routes){
  const out = {};
  Object.entries(routes).forEach(([courierId, route]) => {
    out[courierId] = { ...route };
    if (route.geometry && Array.isArray(route.geometry.coordinates)){
      out[courierId].geometry = {
        ...route.geometry,
        coordinates: route.geometry.coordinates.map(([lng, lat]) => ({ lng, lat }))
      };
    }
  });
  return out;
}

function routesFromFirestore(data){
  const out = {};
  Object.entries(data || {}).forEach(([courierId, route]) => {
    out[courierId] = { ...route };
    if (route.geometry && Array.isArray(route.geometry.coordinates)){
      out[courierId].geometry = {
        ...route.geometry,
        coordinates: route.geometry.coordinates.map(c => [c.lng, c.lat])
      };
    }
  });
  return out;
}

function saveRoutesToStorage(){
  db.collection('dispatcherData').doc('routes').set(routesForFirestore(state.routes))
    .catch(e => console.error('Could not save routes', e));
}

function addCourier(){
  const id = state.nextCourierId++;
  const color = COURIER_COLORS[(id - 1) % COURIER_COLORS.length];
  state.couriers.push({
    id,
    name: `Curier ${id}`,
    start: { address: '', lat: null, lng: null, status: 'pending' },
    end: { address: '', lat: null, lng: null, status: 'pending' },
    sameAsStart: true,
    departureTime: '10:00', // HH:MM, used to compute delivery time windows
    endTimeLimit: '',       // optional HH:MM, only used for a visual warning if a stop falls after it
    confirmed: false,       // true once the courier's fields have been validated via the confirm button
    color
  });
  saveCouriersToStorage();
  renderCouriers();
}

function removeCourier(id){
  state.couriers = state.couriers.filter(c => c.id !== id);
  state.addresses.forEach(a => { if (a.courierId === id) a.courierId = null; });
  delete state.routes[id];
  saveCouriersToStorage();
  renderCouriers();
  renderAddresses();
  renderRouteSummary();
  redrawMap();
}

/**
 * Validates a single courier's configuration and marks it as confirmed if everything checks
 * out. Reads directly from the DOM first (same approach as ensureAllCourierPointsGeocoded)
 * so it also catches fields the user typed but never blurred out of.
 */
async function confirmCourier(courierId){
  const courier = state.couriers.find(c => c.id === courierId);
  if (!courier) return;

  // sync DOM -> state for this courier's fields, geocoding the start/end if needed
  const card = document.querySelector(`[data-confirm="${courierId}"]`)?.closest('.courier-card');
  if (card){
    const startInput = card.querySelector('.start-input');
    const endInput = card.querySelector('.end-input');
    const departureInput = card.querySelector('.departure-input');
    const endLimitInput = card.querySelector('.endlimit-input');

    if (startInput && startInput.value.trim() !== courier.start.address){
      courier.start.address = startInput.value.trim();
      courier.start.status = 'pending';
      courier.start.lat = null;
      courier.start.lng = null;
    }
    if (endInput && endInput.value.trim() !== courier.end.address){
      courier.end.address = endInput.value.trim();
      courier.end.status = 'pending';
      courier.end.lat = null;
      courier.end.lng = null;
    }
    if (departureInput) courier.departureTime = normalizeTime(departureInput.value);
    if (endLimitInput) courier.endTimeLimit = endLimitInput.value.trim() ? normalizeTime(endLimitInput.value) : '';
  }

  const btn = document.querySelector(`[data-confirm="${courierId}"]`);
  if (btn){ btn.disabled = true; btn.textContent = 'Se validează…'; }

  for (const pointKey of ['start', 'end']){
    const point = courier[pointKey];
    if (point.address && point.status === 'pending'){
      const result = await geocodeOne(point.address);
      if (result && result.outOfArea){
        point.status = 'error';
      } else if (result){
        point.lat = result.lat;
        point.lng = result.lng;
        point.status = 'ok';
      } else {
        point.status = 'error';
      }
    }
  }

  // run validation checks
  const errors = [];
  if (!courier.name.trim()) errors.push('numele curierului');
  if (!courier.start.address) errors.push('punctul de plecare');
  else if (courier.start.status === 'error') errors.push('punctul de plecare nu a putut fi localizat — verifică adresa');
  if (!courier.sameAsStart){
    if (!courier.end.address) errors.push('punctul de finalizare');
    else if (courier.end.status === 'error') errors.push('punctul de finalizare nu a putut fi localizat — verifică adresa');
  }
  if (!courier.departureTime) errors.push('ora de plecare');

  if (errors.length){
    courier.confirmed = false;
    showToast(`Nu pot confirma ${courier.name}: completează ${errors.join(', ')}.`, true);
  } else {
    courier.confirmed = true;
    if (state.routes[courier.id]){
      computeDeliveryWindows(courier, state.routes[courier.id]);
      renderRouteSummary();
    }
    showToast(`${courier.name} a fost confirmat.`);
  }

  renderCouriers();
}

function renderCouriers(){
  const list = document.getElementById('courierList');
  document.getElementById('courierCount').textContent = state.couriers.length;
  list.innerHTML = '';

  state.couriers.forEach(c => {
    const card = document.createElement('div');
    card.className = 'courier-card';

    const assignedCount = state.addresses.filter(a => a.courierId === c.id).length;
    const route = state.routes[c.id];
    const assignedAddrs = state.addresses.filter(a => a.courierId === c.id);
    const totalToCollect = assignedAddrs.reduce((sum, a) => sum + (a.amount || 0), 0);

    card.innerHTML = `
      <div class="courier-head">
        <span class="courier-dot" style="background:${c.color}"></span>
        <input type="text" class="courier-name-input" value="${escapeHtml(c.name)}"
          style="border:none;background:none;font-weight:600;font-size:13.5px;flex:1;font-family:inherit;color:inherit;padding:2px 0;">
        ${c.confirmed ? '<span class="courier-confirmed-badge" title="Curier confirmat">✓ confirmat</span>' : ''}
        <button class="btn-icon" title="Șterge curier" data-remove="${c.id}">×</button>
      </div>
      <div class="courier-body">
        <div class="courier-point-block">
          <div class="field" style="margin-bottom:6px;">
            <label>Punct de plecare</label>
            <input type="text" class="start-input" data-courier="${c.id}" placeholder="ex: Depozit, Str. Industriilor 5, București" value="${escapeHtml(c.start.address)}">
          </div>
          <div class="field" style="margin-bottom:0; max-width:120px;">
            <label>Ora de plecare</label>
            <input type="text" class="departure-input" data-courier="${c.id}" placeholder="10:00" value="${escapeHtml(c.departureTime || '')}">
          </div>
        </div>

        <div class="courier-point-block">
          <div class="field" style="margin-bottom:6px;">
            <label style="display:flex; justify-content:space-between; align-items:center;">
              <span>Punct de finalizare</span>
              <span style="text-transform:none; font-weight:400; display:flex; align-items:center; gap:4px;">
                <input type="checkbox" data-same="${c.id}" ${c.sameAsStart ? 'checked' : ''} style="margin:0;"> identic cu plecarea
              </span>
            </label>
            <input type="text" class="end-input" data-courier="${c.id}" placeholder="ex: acasă, sediu, alt depozit"
              value="${escapeHtml(c.end.address)}" style="${c.sameAsStart ? 'display:none;' : ''}">
          </div>
          <div class="field" style="margin-bottom:0; max-width:140px;">
            <label>Ora limită (opțional)</label>
            <input type="text" class="endlimit-input" data-courier="${c.id}" placeholder="18:00" value="${escapeHtml(c.endTimeLimit || '')}">
          </div>
        </div>

        <button class="btn ${c.confirmed ? 'btn-confirmed' : 'btn-accent'} btn-block btn-sm" data-confirm="${c.id}" style="margin-bottom:10px;">
          ${c.confirmed ? '✓ Curier confirmat' : 'Confirmă curier'}
        </button>

        <div class="stat-row">
          <div class="stat">
            <span class="stat-num" style="color:${c.color}">${assignedCount}</span>
            <span class="stat-label">Adrese</span>
          </div>
          <div class="stat">
            <span class="stat-num">${route ? route.totalKm.toFixed(1) : '—'}</span>
            <span class="stat-label">Km traseu</span>
          </div>
          <div class="stat">
            <span class="stat-num">${route ? formatMinutes(route.totalMin) : '—'}</span>
            <span class="stat-label">Durată</span>
          </div>
        </div>
        ${totalToCollect > 0 ? `
        <div style="margin-top:8px; padding-top:8px; border-top:1px solid var(--line-soft); font-size:11.5px; font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif; font-variant-numeric:tabular-nums; color:var(--ink-soft);">
          de încasat: <strong style="color:var(--ink);">${totalToCollect.toFixed(2)} lei</strong>
        </div>` : ''}
      </div>
    `;
    list.appendChild(card);
  });

  // wire events
  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => removeCourier(parseInt(btn.dataset.remove)));
  });
  list.querySelectorAll('[data-confirm]').forEach(btn => {
    btn.addEventListener('click', () => confirmCourier(parseInt(btn.dataset.confirm)));
  });
  list.querySelectorAll('.courier-name-input').forEach((input, i) => {
    input.addEventListener('change', () => {
      state.couriers[i].name = input.value || `Curier ${state.couriers[i].id}`;
      state.couriers[i].confirmed = false;
      renderCouriers();
      renderRouteSummary();
      redrawMap();
    });
  });
  list.querySelectorAll('.start-input').forEach(input => {
    input.addEventListener('change', () => onCourierAddressChange(input, 'start'));
  });
  list.querySelectorAll('.end-input').forEach(input => {
    input.addEventListener('change', () => onCourierAddressChange(input, 'end'));
  });
  list.querySelectorAll('[data-same]').forEach(cb => {
    cb.addEventListener('change', () => {
      const courier = state.couriers.find(c => c.id === parseInt(cb.dataset.same));
      courier.sameAsStart = cb.checked;
      courier.confirmed = false;
      renderCouriers();
    });
  });
  list.querySelectorAll('.departure-input').forEach(input => {
    input.addEventListener('change', () => {
      const courier = state.couriers.find(c => c.id === parseInt(input.dataset.courier));
      const normalized = normalizeTime(input.value);
      courier.departureTime = normalized;
      courier.confirmed = false;
      input.value = normalized;
      // recalculate delivery windows immediately if a route already exists for this courier
      // — no need to rerun the full route optimization, only the time offsets change
      if (state.routes[courier.id]){
        computeDeliveryWindows(courier, state.routes[courier.id]);
        renderRouteSummary();
        showToast(`Intervale de livrare actualizate pentru ${courier.name}.`);
      }
      renderCouriers();
    });
  });
  list.querySelectorAll('.endlimit-input').forEach(input => {
    input.addEventListener('change', () => {
      const courier = state.couriers.find(c => c.id === parseInt(input.dataset.courier));
      const normalized = input.value.trim() ? normalizeTime(input.value) : '';
      courier.endTimeLimit = normalized;
      courier.confirmed = false;
      input.value = normalized;
      // same: recalculate afterLimit flags without touching the route order
      if (state.routes[courier.id]){
        computeDeliveryWindows(courier, state.routes[courier.id]);
        renderRouteSummary();
      }
      renderCouriers();
      renderRouteSummary(); // re-check warnings against new limit
    });
  });

  // Guarded: a render triggered by adopting our own Firestore echo must not save again,
  // or it loops forever (onSnapshot -> render -> save -> onSnapshot -> ...). A render
  // caused by a genuine local edit always runs with the flag false, so it still saves.
  if (!applyingRemoteSnapshot) saveCouriersToStorage();
}

async function onCourierAddressChange(input, which){
  const courier = state.couriers.find(c => c.id === parseInt(input.dataset.courier));
  const addr = input.value.trim();
  courier[which].address = addr;
  courier[which].lat = null;
  courier[which].lng = null;
  courier[which].status = 'pending';
  courier.confirmed = false;
  if (!addr){ renderCouriers(); return; }

  input.style.opacity = '0.6';
  const result = await geocodeOne(addr);
  input.style.opacity = '1';
  if (result && result.outOfArea){
    courier[which].status = 'error';
    showToast(`"${addr}" se localizează în afara zonei București/Ilfov.`, true);
  } else if (result){
    courier[which].lat = result.lat;
    courier[which].lng = result.lng;
    courier[which].status = 'ok';
  } else {
    courier[which].status = 'error';
    showToast(`Nu am putut localiza: "${addr}"`, true);
  }
  renderCouriers();
}

// -------------------------------------------------------------------
// ADDRESSES — import
// -------------------------------------------------------------------
function initAddressPanel(){
  const dz = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');

  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });

  document.getElementById('addManualBtn').addEventListener('click', () => {
    showManualAddForm();
  });

  document.getElementById('geocodeBtn').addEventListener('click', () => geocodeAllPending());
  document.getElementById('manageVerifiedDbBtn').addEventListener('click', () => showVerifiedDbManager());
  updateVerifiedDbCounter();

  const importExcelExportInput = document.getElementById('importExcelExportInput');
  document.getElementById('importExcelExportBtn').addEventListener('click', () => importExcelExportInput.click());
  importExcelExportInput.addEventListener('change', () => {
    if (importExcelExportInput.files.length) importFromExportedExcel(importExcelExportInput.files[0]);
    importExcelExportInput.value = '';
  });

  document.getElementById('addrSearchInput').addEventListener('input', e => {
    addrSearchQuery = e.target.value;
    renderAddresses();
  });

  document.getElementById('addrFilterChips').addEventListener('click', e => {
    const chip = e.target.closest('.addr-filter-chip');
    if (!chip) return;
    addrFilterMode = chip.dataset.filter;
    document.querySelectorAll('.addr-filter-chip').forEach(c => c.classList.toggle('active', c === chip));
    renderAddresses();
  });
}

function updateVerifiedDbCounter(){
  const el = document.getElementById('verifiedDbCount');
  if (el) el.textContent = countVerifiedAddresses();
}

function showVerifiedDbManager(){
  const db = loadVerifiedAddressDB();
  const entries = Object.entries(db).sort((a, b) => (b[1].savedAt || '').localeCompare(a[1].savedAt || ''));

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:480px;">
      <div class="modal-title">Bază adrese verificate (${entries.length})</div>
      <div class="hint" style="margin-bottom:10px;">Aceste adrese sunt recunoscute automat la viitoare importuri, fără să mai treacă prin geocodare. Șterge o intrare dacă a fost salvată cu o poziție greșită.</div>
      <div id="verifiedDbList" style="max-height:50vh; overflow-y:auto;">
        ${entries.length ? entries.map(([key, entry]) => `
          <div class="verified-db-row" data-key="${escapeHtml(key)}">
            <div class="verified-db-text">
              <div class="verified-db-addr">${escapeHtml(entry.originalText || key)}</div>
              <div class="verified-db-coords">${entry.lat.toFixed(5)}, ${entry.lng.toFixed(5)}</div>
            </div>
            <button class="addr-remove" data-remove-verified="${escapeHtml(key)}" title="Șterge din bază">×</button>
          </div>
        `).join('') : '<div class="hint">Baza este goală — nu există încă adrese salvate.</div>'}
      </div>
      <div style="display:flex; gap:6px; margin-top:14px;">
        <button class="btn btn-ghost btn-sm" id="vdbCloseBtn" style="flex:1;">Închide</button>
        ${entries.length ? '<button class="btn btn-sm" id="vdbClearAllBtn" style="flex:1; border-color:var(--danger); color:var(--danger);">Șterge tot</button>' : ''}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('vdbCloseBtn').addEventListener('click', close);

  overlay.querySelectorAll('[data-remove-verified]').forEach(btn => {
    btn.addEventListener('click', () => {
      const db = loadVerifiedAddressDB();
      delete db[btn.dataset.removeVerified];
      saveVerifiedAddressDB(db);
      btn.closest('.verified-db-row').remove();
      updateVerifiedDbCounter();
    });
  });

  const clearAllBtn = document.getElementById('vdbClearAllBtn');
  if (clearAllBtn){
    clearAllBtn.addEventListener('click', () => {
      if (!confirm('Sigur vrei să ștergi toate adresele din baza verificată? Această acțiune nu poate fi anulată.')) return;
      saveVerifiedAddressDB({});
      updateVerifiedDbCounter();
      close();
    });
  }
}

function showEditAddressForm(addrId){
  const addr = state.addresses.find(a => a.id === addrId);
  if (!addr) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">Editează adresa</div>
      <div class="field" style="margin-bottom:7px;">
        <label>Nume client</label>
        <input type="text" id="eaName" value="${escapeHtml(addr.clientName)}">
      </div>
      <div class="field" style="margin-bottom:7px;">
        <label>Telefon</label>
        <input type="text" id="eaPhone" value="${escapeHtml(addr.phone)}">
      </div>
      <div class="field" style="margin-bottom:7px;">
        <label>Adresă (oraș, stradă, nr)</label>
        <input type="text" id="eaAddress" value="${escapeHtml(addr.raw)}">
        <div class="hint">Dacă schimbi adresa, va trebui re-localizată pe hartă.</div>
      </div>
      <label style="display:flex; align-items:center; gap:6px; margin-bottom:7px; font-size:12px; font-weight:500; cursor:pointer;">
        <input type="checkbox" id="eaAllowOutOfArea" ${addr.allowOutOfArea ? 'checked' : ''} style="margin:0;">
        Permite în afara zonei București/Ilfov (adresă excepțională, confirmată manual)
      </label>
      <div class="field" style="margin-bottom:7px;">
        <label>Detalii (bloc/scară/ap/interfon)</label>
        <input type="text" id="eaDetails" value="${escapeHtml(addr.details)}">
      </div>
      <div class="field-row" style="margin-bottom:7px;">
        <div class="field" style="flex:2;">
          <label>Produse</label>
          <input type="text" id="eaProducts" value="${escapeHtml(addr.products)}" placeholder="ex: 6x Piersici Turtite, 1x Mere de Vara">
        </div>
        <div class="field">
          <label>Total kg</label>
          <input type="text" id="eaProductsKg" value="${addr.productsKg != null ? addr.productsKg : ''}">
        </div>
      </div>
      <div class="field-row" style="margin-bottom:7px;">
        <div class="field">
          <label>Sumă (lei)</label>
          <input type="text" id="eaAmount" value="${addr.amount != null ? addr.amount : ''}">
        </div>
        <div class="field">
          <label>Metodă plată</label>
          <select id="eaPayment">
            ${PAYMENT_METHODS.map(m => `<option value="${m}" ${addr.paymentMethod === m ? 'selected' : ''}>${m}</option>`).join('')}
            ${addr.paymentMethod && !PAYMENT_METHODS.includes(addr.paymentMethod) ? `<option value="${escapeHtml(addr.paymentMethod)}" selected>${escapeHtml(addr.paymentMethod)}</option>` : ''}
          </select>
        </div>
      </div>
      <div class="field" style="margin-bottom:7px;">
        <label>Notă client</label>
        <input type="text" id="eaNote" value="${escapeHtml(addr.customerNote)}">
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Observații</label>
        <textarea id="eaObs" rows="2" placeholder="notițe interne — vizibile și editabile și de curier">${escapeHtml(addr.observatii)}</textarea>
      </div>
      <div style="display:flex; gap:6px; margin-top:14px;">
        <button class="btn btn-ghost btn-sm" id="eaCancelBtn" style="flex:1;">Anulează</button>
        <button class="btn btn-primary btn-sm" id="eaSaveBtn" style="flex:1;">Salvează</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('eaAddress').focus();

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('eaCancelBtn').addEventListener('click', close);

  document.getElementById('eaSaveBtn').addEventListener('click', async () => {
    const newAddressInput = document.getElementById('eaAddress').value.trim();
    if (!newAddressInput){
      showToast('Adresa este obligatorie.', true);
      return;
    }
    const newAddress = /rom[aâ]nia/i.test(newAddressInput) ? newAddressInput : `${newAddressInput}, România`;
    const newAllowOutOfArea = document.getElementById('eaAllowOutOfArea').checked;
    const addressChanged = newAddress !== addr.raw;
    const allowFlagChanged = newAllowOutOfArea !== addr.allowOutOfArea;

    addr.clientName = document.getElementById('eaName').value.trim();
    addr.phone = document.getElementById('eaPhone').value.trim();
    addr.details = document.getElementById('eaDetails').value.trim();
    addr.products = document.getElementById('eaProducts').value.trim();
    const kgInput = document.getElementById('eaProductsKg').value.trim();
    addr.productsKg = kgInput ? parseFloat(kgInput.replace(',', '.')) : null;
    addr.amount = parseAmount(document.getElementById('eaAmount').value);
    addr.paymentMethod = document.getElementById('eaPayment').value;
    addr.customerNote = document.getElementById('eaNote').value.trim();
    addr.observatii = document.getElementById('eaObs').value.trim();
    addr.raw = newAddress;
    addr.allowOutOfArea = newAllowOutOfArea;

    if (addressChanged || (allowFlagChanged && addr.status === 'error')){
      addr.lat = null;
      addr.lng = null;
      addr.status = 'pending';
      addr.confidence = null;
      addr.manuallyAdjusted = false;
      addr.outOfArea = false;
      // this address is no longer valid in any route until re-geocoded
      Object.keys(state.routes).forEach(courierId => {
        const route = state.routes[courierId];
        const i = route.order.indexOf(addr.id);
        if (i !== -1){
          route.order.splice(i, 1);
          if (route.order.length) recalcRouteDistance(parseInt(courierId));
          else delete state.routes[courierId];
        }
      });
    }

    close();
    renderAddresses();
    renderCouriers();
    renderRouteSummary();
    maybeShowGeocodeButton();
    redrawMap();

    // re-geocode immediately so the user sees the result of the new flag right away,
    // instead of waiting for the next bulk "Localizează adresele" / auto-assign pass
    if (addr.status === 'pending'){
      showToast('Se re-localizează adresa…');
      const result = await geocodeOne(addr.raw, addr.allowOutOfArea);
      if (result && result.outOfArea){
        addr.status = 'error';
        addr.confidence = null;
        addr.outOfArea = true;
        showToast('Adresa este în afara zonei București/Ilfov. Bifează "permite în afara zonei" dacă vrei să o accepți.', true);
      } else if (result){
        addr.lat = result.lat;
        addr.lng = result.lng;
        addr.status = 'ok';
        addr.confidence = result.confidence;
        addr.outOfArea = !isWithinServiceArea(result.lat, result.lng);
        if (result.confidence === 'high' && !addr.outOfArea){
          saveVerifiedAddress(addr.raw, result.lat, result.lng);
        }
        showToast(addr.outOfArea ? 'Adresă localizată în afara zonei (permis manual).' : 'Adresă re-localizată cu succes.');
      } else {
        addr.status = 'error';
        addr.confidence = null;
        showToast('Nu am putut localiza adresa.', true);
      }
      renderAddresses();
      renderCouriers();
      maybeShowGeocodeButton();
      redrawMap();
    }
  });
}

function showManualAddForm(){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">Adaugă adresă manual</div>
      <div class="field" style="margin-bottom:7px;">
        <label>Nume client</label>
        <input type="text" id="maName" placeholder="ex: Ana Popescu">
      </div>
      <div class="field" style="margin-bottom:7px;">
        <label>Telefon</label>
        <input type="text" id="maPhone" placeholder="ex: 07xx xxx xxx">
      </div>
      <div class="field" style="margin-bottom:7px;">
        <label>Adresă (oraș, stradă, nr)</label>
        <input type="text" id="maAddress" placeholder="ex: Cluj-Napoca, Str. Mihai Eminescu, 10">
      </div>
      <div class="field" style="margin-bottom:7px;">
        <label>Detalii (bloc/scară/ap/interfon)</label>
        <input type="text" id="maDetails" placeholder="ex: Bloc A2, et 3, ap 12, interfon 12">
      </div>
      <div class="field-row" style="margin-bottom:7px;">
        <div class="field" style="flex:2;">
          <label>Produse</label>
          <input type="text" id="maProducts" placeholder="ex: 6x Piersici Turtite, 1x Mere de Vara">
        </div>
        <div class="field">
          <label>Total kg</label>
          <input type="text" id="maProductsKg">
        </div>
      </div>
      <div class="field-row" style="margin-bottom:7px;">
        <div class="field">
          <label>Sumă (lei)</label>
          <input type="text" id="maAmount" placeholder="ex: 150">
        </div>
        <div class="field">
          <label>Metodă plată</label>
          <select id="maPayment">
            ${PAYMENT_METHODS.map(m => `<option value="${m}">${m}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="display:flex; gap:6px; margin-top:14px;">
        <button class="btn btn-ghost btn-sm" id="maCancelBtn" style="flex:1;">Anulează</button>
        <button class="btn btn-primary btn-sm" id="maConfirmBtn" style="flex:1;">Adaugă</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('maAddress').focus();

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('maCancelBtn').addEventListener('click', close);
  document.getElementById('maConfirmBtn').addEventListener('click', () => {
    const addressInput = document.getElementById('maAddress').value.trim();
    if (!addressInput){
      showToast('Adresa este obligatorie.', true);
      return;
    }
    const address = /rom[aâ]nia/i.test(addressInput) ? addressInput : `${addressInput}, România`;
    addAddress({
      raw: address,
      details: document.getElementById('maDetails').value.trim(),
      products: document.getElementById('maProducts').value.trim(),
      productsKg: document.getElementById('maProductsKg').value.trim() ? parseFloat(document.getElementById('maProductsKg').value.trim().replace(',', '.')) : null,
      clientName: document.getElementById('maName').value.trim(),
      phone: document.getElementById('maPhone').value.trim(),
      amount: parseAmount(document.getElementById('maAmount').value),
      paymentMethod: document.getElementById('maPayment').value
    });
    close();
    renderAddresses();
    switchToTab('panel-adrese');
    maybeShowGeocodeButton();
  });
}

/**
 * Recovers work from a PREVIOUSLY-EXPORTED Excel file (exportRoutesXlsx's own fixed output
 * format below) — a fallback for whenever a day's work was lost before it could be saved
 * through the normal means (localStorage, the JSON state file, route history). That export
 * has no coordinates or route geometry, so it can't restore the exact optimized route, but
 * it DOES restore which address belongs to which courier — the part that's actually
 * laborious to redo, especially after manual reassignments. Each address is re-added as
 * manually assigned to its original courier, so "Repartizează automat" only needs to
 * recompute visiting ORDER (via OSRM) once addresses are re-geocoded, not redo the
 * courier-by-courier split from scratch.
 *
 * Column order MUST stay in sync with the `header` array in exportRoutesXlsx().
 */
const EXPORTED_EXCEL_COLUMNS = ['courierName', 'interval', 'orderNumber', 'firstName', 'lastName', 'phone', 'raw', 'details', 'products', 'productsKg', 'paymentMethod', 'amount', 'customerNote', 'observatii'];

function parseExportedExcelRows(rows){
  const parsed = [];
  for (let i = 1; i < rows.length; i++){ // row 0 is the header
    const row = rows[i];
    if (!row || !row.length) continue;
    const entry = {};
    EXPORTED_EXCEL_COLUMNS.forEach((key, idx) => { entry[key] = row[idx]; });
    if (!String(entry.raw || '').trim()) continue; // skip blank rows
    entry.courierName = String(entry.courierName || '').trim();
    entry.orderNumber = String(entry.orderNumber || '').trim();
    entry.firstName = String(entry.firstName || '').trim();
    entry.lastName = String(entry.lastName || '').trim();
    entry.phone = String(entry.phone || '').trim();
    if (/^7\d{8}$/.test(entry.phone)) entry.phone = `0${entry.phone}`; // Excel dropped the leading 0 (see getPhoneCell above)
    entry.raw = String(entry.raw || '').trim();
    entry.details = String(entry.details || '').trim();
    entry.products = String(entry.products || '').trim();
    entry.productsKg = entry.productsKg !== '' && entry.productsKg != null ? parseFloat(String(entry.productsKg).replace(',', '.')) : null;
    entry.paymentMethod = String(entry.paymentMethod || '').trim();
    entry.amount = parseAmount(entry.amount);
    entry.customerNote = String(entry.customerNote || '').trim();
    entry.observatii = String(entry.observatii || '').trim();
    parsed.push(entry);
  }
  return parsed;
}

function importFromExportedExcel(file){
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const parsed = parseExportedExcelRows(rows);

      if (!parsed.length){
        showToast('Nu am găsit rânduri valide în acest fișier — verifică dacă e exportul corect de Excel.', true);
        return;
      }
      const courierNames = [...new Set(parsed.map(r => r.courierName).filter(Boolean))];
      if (!confirm(`Recuperez ${parsed.length} adrese pentru ${courierNames.length} curieri (${courierNames.join(', ')}). Adresele vor trebui re-localizate, apoi apeși "Repartizează automat" ca să recalculezi ordinea optimă — alocarea pe curieri rămâne cea din fișier. Continui?`)) return;

      parsed.forEach(r => {
        let courier = r.courierName ? state.couriers.find(c => c.name.trim().toLowerCase() === r.courierName.toLowerCase()) : null;
        if (!courier && r.courierName){
          addCourier();
          courier = state.couriers[state.couriers.length - 1];
          courier.name = r.courierName;
        }
        addAddress({
          orderNumber: r.orderNumber,
          raw: r.raw,
          details: r.details,
          products: r.products,
          productsKg: r.productsKg,
          clientName: [r.firstName, r.lastName].filter(Boolean).join(' '),
          firstName: r.firstName,
          phone: r.phone,
          amount: r.amount,
          paymentMethod: r.paymentMethod,
          customerNote: r.customerNote,
          observatii: r.observatii,
          courierId: courier ? courier.id : null,
          manuallyAssigned: !!courier
        });
      });

      renderCouriers();
      renderAddresses();
      switchToTab('panel-adrese');
      maybeShowGeocodeButton();
      showToast(`${parsed.length} adrese recuperate. Completează punctele de plecare ale curierilor, apoi "Localizează adresele" și "Repartizează automat".`);
    } catch (err){
      console.error('Nu am putut citi fișierul Excel exportat', err);
      showToast('Nu am putut citi fișierul — verifică dacă e exportul corect de Excel.', true);
    }
  };
  reader.readAsArrayBuffer(file);
}

function handleFile(file){
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')){
    Papa.parse(file, {
      complete: res => onParsedRows(res.data),
      skipEmptyLines: true
    });
  } else if (name.endsWith('.xlsx') || name.endsWith('.xls')){
    const reader = new FileReader();
    reader.onload = e => {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type:'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header:1, defval:'' });
      onParsedRows(rows);
    };
    reader.readAsArrayBuffer(file);
  } else {
    showToast('Format neacceptat. Folosește CSV sau XLSX.', true);
  }
}

function onParsedRows(rows){
  if (!rows || !rows.length){
    showToast('Fișierul este gol.', true);
    return;
  }
  showColumnMapper(rows);
}

const FIELD_DEFS = [
  { key: 'orderNumber', label: 'Nr. Comandă', required: false, patterns: /order.?number|nr\.?\s*comand/i },
  { key: 'firstName', label: 'Prenume', required: false, patterns: /first.?name|prenume/i },
  { key: 'lastName', label: 'Nume', required: false, patterns: /last.?name|^nume$|de familie/i },
  { key: 'phone', label: 'Telefon', required: false, patterns: /phone|telefon|tel\b|mobil/i },
  { key: 'city', label: 'Oraș', required: false, patterns: /^city|ora[sș]|localitate/i },
  { key: 'street', label: 'Stradă', required: true, patterns: /^strada$|^street$|^stradă$/i },
  { key: 'number', label: 'Număr', required: false, patterns: /^nr\.?$|^number$|num[aă]r/i },
  { key: 'details', label: 'Detalii (bloc/scară/ap)', required: false, patterns: /detalii|detail|^bloc$|scar[aă]|interfon/i },
  { key: 'paymentMethod', label: 'Metodă de plată', required: false, patterns: /payment.?method|metod[aă].*plat[aă]|modalitate/i },
  { key: 'amount', label: 'Sumă de plată', required: false, patterns: /amount|total|sum[aă]|valoare|pret|preț/i },
  { key: 'productName', label: 'Produs', required: false, patterns: /product.?name|denumire.*produs|^produs$/i },
  { key: 'quantity', label: 'Cantitate', required: false, patterns: /^qty$|quantity|cantitate/i },
  { key: 'customerNote', label: 'Notă client', required: false, patterns: /customer.?note|not[aă].*client|observa/i },
];

function guessColumnMapping(header){
  const mapping = {};
  FIELD_DEFS.forEach(field => {
    const idx = header.findIndex(h => field.patterns.test(String(h)));
    mapping[field.key] = idx !== -1 ? idx : null;
  });
  return mapping;
}

function showColumnMapper(rows){
  const numCols = rows[0].length;
  // assume first row is a header if it has text-like, non-numeric cells and there's more than one row
  const looksLikeHeader = rows.length > 1 && rows[0].every(c => isNaN(parseFloat(c)) || c === '');
  const header = looksLikeHeader ? rows[0].map(h => String(h)) : rows[0].map((_, i) => `Coloana ${i+1}`);
  const guess = guessColumnMapping(header);

  const colOptions = (selectedIdx) => {
    let opts = `<option value="">— nefolosit —</option>`;
    header.forEach((h, i) => {
      opts += `<option value="${i}" ${i === selectedIdx ? 'selected' : ''}>${escapeHtml(h)}</option>`;
    });
    return opts;
  };

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">Asociază coloanele din fișier</div>
      <label style="display:flex; align-items:center; gap:5px; margin-bottom:9px; font-weight:400; text-transform:none; font-size:12.5px;">
        <input type="checkbox" id="hasHeaderCb" ${looksLikeHeader ? 'checked' : ''}> prima linie este antet
      </label>
      ${FIELD_DEFS.map(field => `
        <div class="field" style="margin-bottom:7px;">
          <label>${field.label}${field.required ? ' *' : ''}</label>
          <select id="map_${field.key}" style="width:100%; padding:7px; border:1px solid var(--line); border-radius:2px; font-family:inherit; font-size:13px;">
            ${colOptions(guess[field.key])}
          </select>
        </div>
      `).join('')}
      <div style="display:flex; gap:6px; margin-top:14px;">
        <button class="btn btn-ghost btn-sm" id="cancelColBtn" style="flex:1;">Anulează</button>
        <button class="btn btn-primary btn-sm" id="confirmColBtn" style="flex:1;">Importă ${rows.length - (looksLikeHeader ? 1 : 0)} rânduri</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('cancelColBtn').addEventListener('click', close);

  document.getElementById('confirmColBtn').addEventListener('click', () => {
    const hasHeader = document.getElementById('hasHeaderCb').checked;
    const startIdx = hasHeader ? 1 : 0;
    const colMap = {};
    FIELD_DEFS.forEach(field => {
      const val = document.getElementById(`map_${field.key}`).value;
      colMap[field.key] = val === '' ? null : parseInt(val);
    });

    if (colMap.street === null){
      showToast('Trebuie să selectezi coloana cu strada.', true);
      return;
    }

    const getCell = (row, key) => colMap[key] !== null ? String(row[colMap[key]] ?? '').trim() : '';

    // When the phone column in the source file is a real Excel number (not text), SheetJS
    // returns it without a leading 0 (0722598835 -> 722598835). A bare 9-digit number starting
    // with 7 is unambiguously a Romanian mobile that lost its 0, so restore it here, at the
    // point of entry, rather than leaving every downstream use (calling, display, messages) broken.
    const getPhoneCell = (row) => {
      const raw = getCell(row, 'phone');
      return /^7\d{8}$/.test(raw) ? `0${raw}` : raw;
    };

    // Some order exports (WooCommerce among them) put one product per row: only the FIRST
    // row of a multi-product order carries the address/customer columns, and every extra
    // product for that same order appears on its own row afterward with those columns left
    // blank. Those continuation rows must be merged into the order they belong to (the most
    // recently added address), not skipped or treated as their own (address-less) entry.
    let imported = 0;
    let lastAddedAddr = null;
    for (let i = startIdx; i < rows.length; i++){
      const row = rows[i];
      const productName = getCell(row, 'productName');
      const quantity = getCell(row, 'quantity');
      const productEntry = productName ? `${quantity ? quantity + 'x ' : ''}${productName}` : '';
      const quantityKg = parseFloat(quantity.replace(',', '.')) || 0; // every product is sold by the kg — quantity IS the weight

      const streetRaw = getCell(row, 'street');
      if (!streetRaw){
        if (productEntry && lastAddedAddr){
          lastAddedAddr.products = lastAddedAddr.products ? `${lastAddedAddr.products}, ${productEntry}` : productEntry;
          lastAddedAddr.productsKg = (lastAddedAddr.productsKg || 0) + quantityKg;
        }
        continue;
      }

      const firstName = getCell(row, 'firstName');
      const lastName = getCell(row, 'lastName');
      const clientName = [firstName, lastName].filter(Boolean).join(' ');

      const city = normalizeCityForGeocoding(getCell(row, 'city'));
      const number = getCell(row, 'number');
      const details = getCell(row, 'details');

      const street = normalizeStreetPrefix(streetRaw);
      const streetPart = [street, number].filter(Boolean).join(' ');
      const fullAddress = [streetPart, city, 'România'].filter(Boolean).join(', ');

      lastAddedAddr = addAddress({
        orderNumber: getCell(row, 'orderNumber'),
        raw: fullAddress,
        details,
        clientName,
        firstName,
        phone: getPhoneCell(row),
        amount: colMap.amount !== null ? parseAmount(row[colMap.amount]) : null,
        paymentMethod: colMap.paymentMethod !== null ? normalizePaymentMethod(row[colMap.paymentMethod]) : '',
        products: productEntry,
        productsKg: productEntry ? quantityKg : null,
        customerNote: getCell(row, 'customerNote')
      });
      imported++;
    }
    close();
    renderAddresses();
    switchToTab('panel-adrese');
    maybeShowGeocodeButton();
    showToast(`${imported} adrese importate.`);
  });
}

function parseAmount(val){
  if (val === null || val === undefined || val === '') return null;
  const cleaned = String(val).replace(/[^\d.,-]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function normalizePaymentMethod(val){
  const str = String(val || '').trim();
  if (!str) return '';
  const lower = str.toLowerCase();
  // try exact match first
  const exact = PAYMENT_METHODS.find(m => m.toLowerCase() === lower);
  if (exact) return exact;
  // try contains match (e.g. "Plata prin Revolut" -> "Revolut")
  const contains = PAYMENT_METHODS.find(m => lower.includes(m.toLowerCase()));
  if (contains) return contains;
  return str; // keep original text if it doesn't match known options
}

function addAddress(data){
  const addr = {
    id: state.nextAddrId++,
    orderNumber: data.orderNumber || '',
    raw: data.raw,
    details: data.details || '',
    clientName: data.clientName || '',
    firstName: data.firstName || '', // as typed in the order's own "First Name" field, kept separate from clientName since customers don't always split first/last name correctly
    greetingNameOverride: data.greetingNameOverride || '', // manual correction from the "verifică mesajele" review step, wins over any auto-detected greeting name
    phone: data.phone || '',
    amount: data.amount ?? null,
    paymentMethod: data.paymentMethod || '',
    products: data.products || '', // e.g. "6x Piersici Turtite, 1x Mere de Vara" — what's actually being delivered
    productsKg: data.productsKg ?? null, // total weight — every product is sold by the kg, so this is just the summed quantities
    customerNote: data.customerNote || '',
    observatii: data.observatii || '', // working notes editable both by dispatcher and by the courier on their phone; synced back via the check-in return link
    lat: null,
    lng: null,
    status: 'pending',
    confidence: null,        // 'high' | 'medium' | 'low' | null — geocoding precision indicator
    manuallyAdjusted: false, // true once the pin has been dragged to a corrected position
    outOfArea: false,        // true if geocoding only found results outside the Bucharest/Ilfov service area
    allowOutOfArea: false,   // true if the user explicitly opted in to allow this address outside the service area
    courierId: data.courierId ?? null,
    manuallyAssigned: data.manuallyAssigned ?? false, // true once the courier was set explicitly (reassign dropdown, or a recovered courier-column import)
    cancelled: data.cancelled ?? false // order cancelled after routes/time windows were already communicated — pulled off the map/route but kept as a record, not deleted
  };
  state.addresses.push(addr);
  return addr;
}

function maybeShowGeocodeButton(){
  const section = document.getElementById('geocodeSection');
  const btn = document.getElementById('geocodeBtn');
  const statusRow = document.getElementById('geocodeStatus');
  const pending = state.addresses.filter(a => a.status === 'pending').length;
  if (pending > 0){
    section.style.display = 'block';
    statusRow.style.display = 'none';
    btn.style.display = 'block';
    btn.textContent = `Localizează ${pending} ${pending === 1 ? 'adresă' : 'adrese'}`;
  } else if (state.addresses.length > 0){
    section.style.display = 'block';
    statusRow.style.display = 'none';
    btn.style.display = 'none';
  } else {
    section.style.display = 'none';
  }
}

// -------------------------------------------------------------------
// ADDRESSES — render / list interactions / drag-drop
// -------------------------------------------------------------------
// True when an address needs the dispatcher's attention — same conditions that drive the
// ⚠/✕ badges below, kept in one place so the "Cu probleme" filter can't drift out of sync.
function addressHasIssue(a){
  if (a.cancelled) return false;
  if (a.status === 'error') return true;
  if (a.status === 'ok' && a.outOfArea) return true;
  if (a.status === 'ok' && a.confidence && a.confidence !== 'high' && a.confidence !== 'verified' && !a.manuallyAdjusted) return true;
  return false;
}

let addrFilterMode = 'all';
let addrSearchQuery = '';

function renderAddresses(){
  const list = document.getElementById('addrList');
  if (!state.addresses.length){
    list.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">${ICONS.emptyPin}</div>
        <div class="es-title">Nicio adresă încărcată</div>
        <div class="es-sub">Importă un fișier CSV/Excel sau adaugă manual</div>
      </div>`;
    if (!applyingRemoteSnapshot) saveAddressesToStorage(); // see the guard note at the end of this function
    return;
  }

  const query = addrSearchQuery.trim().toLowerCase();
  const visibleAddresses = state.addresses.filter(a => {
    if (addrFilterMode === 'problems' && !addressHasIssue(a)) return false;
    if (addrFilterMode === 'unassigned' && (a.courierId != null || a.cancelled)) return false;
    if (query){
      const haystack = [a.clientName, a.raw, a.phone, a.details].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  if (!visibleAddresses.length){
    list.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">${ICONS.emptyPin}</div>
        <div class="es-title">Nicio adresă corespunde filtrului</div>
        <div class="es-sub">Încearcă „Toate” sau schimbă termenul de căutare</div>
      </div>`;
    if (!applyingRemoteSnapshot) saveAddressesToStorage();
    return;
  }

  list.innerHTML = '';
  visibleAddresses.forEach((a) => {
    const idx = state.addresses.indexOf(a);
    const item = document.createElement('div');
    item.className = 'addr-item';
    item.dataset.id = a.id;

    let statusHtml = '';
    if (a.status === 'pending') statusHtml = `<div class="addr-status">în așteptare</div>`;
    else if (a.status === 'ok'){
      if (a.outOfArea && a.allowOutOfArea){
        statusHtml = `<div class="addr-status warn">⚠ în afara zonei București/Ilfov (permis manual) <button class="addr-locate-btn" data-locate="${a.id}">verifică pe hartă</button></div>`;
      } else if (a.outOfArea){
        statusHtml = `<div class="addr-status warn">⚠ poziție în afara zonei București/Ilfov <button class="addr-locate-btn" data-locate="${a.id}">verifică pe hartă</button></div>`;
      } else if (a.confidence === 'verified'){
        statusHtml = `<div class="addr-status ok">✓ din baza de adrese verificate</div>`;
      } else if (a.manuallyAdjusted){
        statusHtml = `<div class="addr-status ok">✓ poziție ajustată manual</div>`;
      } else if (a.confidence === 'high'){
        statusHtml = `<div class="addr-status ok">✓ localizată precis</div>`;
      } else if (a.confidence === 'medium'){
        statusHtml = `<div class="addr-status warn">⚠ aproximativ (nivel stradă) <button class="addr-locate-btn" data-locate="${a.id}">verifică pe hartă</button></div>`;
      } else {
        statusHtml = `<div class="addr-status warn">⚠ incert (nivel zonă) <button class="addr-locate-btn" data-locate="${a.id}">verifică pe hartă</button></div>`;
      }
    }
    else if (a.status === 'error'){
      statusHtml = a.outOfArea
        ? `<div class="addr-status err">✕ în afara zonei (București/Ilfov) <button class="addr-action-link" data-edit="${a.id}" style="font-size:10.5px;">corectează</button></div>`
        : `<div class="addr-status err">✕ neidentificată</div>`;
    }

    const courier = state.couriers.find(c => c.id === a.courierId);
    const courierSelect = `
      <select class="addr-courier-select" data-id="${a.id}" style="border-color:${courier ? courier.color : 'var(--line)'}; color:${courier ? courier.color : 'var(--ink-soft)'};">
        <option value="">— nerepartizat —</option>
        ${state.couriers.map(c => `<option value="${c.id}" ${c.id === a.courierId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
      </select>`;

    const titleLine = a.clientName ? escapeHtml(a.clientName) : escapeHtml(a.raw);
    const subAddressLine = a.clientName ? `<div class="addr-sub-addr">${escapeHtml(a.raw)}</div>` : '';
    const detailsLine = a.details ? `<div class="addr-sub-addr">${ICONS.building}${escapeHtml(a.details)}</div>` : '';
    const productsLine = a.products ? `<div class="addr-sub-addr">${ICONS.apple}${formatProductsWithKg(a)}</div>` : '';
    const phoneLine = a.phone ? `<div class="addr-sub-addr">${escapeHtml(a.phone)}</div>` : '';
    const noteLine = a.customerNote ? `<div class="addr-sub-addr">${ICONS.note}${escapeHtml(a.customerNote)}</div>` : '';
    const obsLine = a.observatii ? `<div class="addr-obs-line">${ICONS.tag}${escapeHtml(a.observatii)}</div>` : '';
    // Written live by the client on their own tracking page — see applyCourierRunUpdates.
    const clientConfirmedLine = a.clientConfirmed === true ? `<div class="addr-client-line">✓ Clientul a confirmat: va fi acasă</div>` : '';
    const clientNoteLine = a.clientNote ? `<div class="addr-client-line">${ICONS.note}Client: „${escapeHtml(a.clientNote)}”</div>` : '';
    const paymentChip = (a.amount != null || a.paymentMethod)
      ? `<div class="addr-payment-chip ${a.paymentMethod === 'Ramburs' ? 'cod' : ''}">${a.amount != null ? a.amount.toFixed(2) + ' lei' : ''}${a.amount != null && a.paymentMethod ? ' · ' : ''}${escapeHtml(a.paymentMethod || '')}</div>`
      : '';

    const cancelledBadge = a.cancelled ? `<div class="addr-status err">✕ comandă anulată <button class="addr-action-link" data-restore="${a.id}" style="font-size:10.5px;">restaurează</button></div>` : '';
    const deliveryBadge = a.deliveryStatus === 'delivered' ? `<span class="delivery-badge delivered">✓ Livrat</span>`
      : a.deliveryStatus === 'failed' ? `<span class="delivery-badge failed">✕ Nelivrat</span>`
      : '';
    const actionRow = a.cancelled ? '' : `
        <div class="addr-action-row">
          <button class="addr-action-link" data-edit="${a.id}">${ICONS.pencil} editează</button>
          <span class="addr-action-sep">·</span>
          <span class="addr-action-label">realoca:</span>
          ${courierSelect}
          ${a.manuallyAssigned ? `<span class="addr-lock-badge" title="Alocare manuală — nu va fi schimbată de repartizarea automată">${ICONS.lock}</span>` : ''}
        </div>`;

    if (a.cancelled) item.classList.add('addr-cancelled');
    if (a.deliveryStatus === 'delivered') item.classList.add('addr-delivered');
    else if (a.deliveryStatus === 'failed') item.classList.add('addr-delivery-failed');
    item.innerHTML = `
      <span class="addr-badge">${idx + 1}</span>
      <div class="addr-text">
        ${deliveryBadge}
        <div class="addr-main">${titleLine}</div>
        ${subAddressLine}
        ${detailsLine}
        ${productsLine}
        ${phoneLine}
        ${noteLine}
        ${obsLine}
        ${clientConfirmedLine}
        ${clientNoteLine}
        ${paymentChip}
        ${cancelledBadge}
        ${statusHtml}
        ${actionRow}
      </div>
      <button class="addr-remove" data-id="${a.id}" title="Șterge">×</button>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('[data-restore]').forEach(btn => {
    btn.addEventListener('click', () => restoreCancelledStop(parseInt(btn.dataset.restore)));
  });

  list.querySelectorAll('.addr-courier-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const id = parseInt(sel.dataset.id);
      const addr = state.addresses.find(a => a.id === id);
      if (!addr) return;
      const newCourierId = sel.value ? parseInt(sel.value) : null;
      const oldCourierId = addr.courierId;
      if (newCourierId === oldCourierId) return;
      addr.courierId = newCourierId;
      addr.manuallyAssigned = newCourierId != null; // unassigning (—) clears the manual lock too

      // pull this address out of any existing route (old courier), and append it to the
      // new courier's route order if that courier already has an active route
      [oldCourierId, newCourierId].forEach(cid => {
        if (cid == null) return;
        const route = state.routes[cid];
        if (!route) return;
        if (cid === oldCourierId){
          const i = route.order.indexOf(id);
          if (i !== -1) route.order.splice(i, 1);
        }
        if (cid === newCourierId && !route.order.includes(id)){
          route.order.push(id);
        }
        if (route.order.length){
          recalcRouteDistance(cid);
        } else {
          delete state.routes[cid];
        }
      });

      renderAddresses();
      renderCouriers();
      renderRouteSummary();
      redrawMap();
      showToast(newCourierId ? `Adresă alocată manual către ${state.couriers.find(c=>c.id===newCourierId)?.name}.` : 'Adresă scoasă din alocare.');
    });
  });

  list.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.edit);
      showEditAddressForm(id);
    });
  });

  list.querySelectorAll('.addr-locate-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.locate);
      focusAddressOnMap(id);
    });
  });

  list.querySelectorAll('.addr-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      const addrIndex = state.addresses.findIndex(a => a.id === id);
      if (addrIndex === -1) return;
      const addr = state.addresses[addrIndex];
      const label = addr.clientName || addr.raw;

      // Snapshot each route this address was part of (courier + its position in the order)
      // so "Anulează" can put everything back exactly where it was, not just re-add the address.
      const routeBackups = [];
      Object.keys(state.routes).forEach(courierId => {
        const orderIdx = state.routes[courierId].order.indexOf(id);
        if (orderIdx !== -1) routeBackups.push({ courierId: parseInt(courierId), orderIdx });
      });

      state.addresses.splice(addrIndex, 1);
      routeBackups.forEach(({courierId, orderIdx}) => {
        const route = state.routes[courierId];
        route.order.splice(orderIdx, 1);
        if (route.order.length){
          recalcRouteDistance(courierId);
        } else {
          delete state.routes[courierId];
        }
      });
      renderAddresses();
      renderCouriers();
      renderRouteSummary();
      maybeShowGeocodeButton();
      redrawMap();

      showToast(`Adresă ștearsă: ${label}`, false, {
        label: 'Anulează',
        onClick: () => {
          state.addresses.splice(addrIndex, 0, addr);
          routeBackups.forEach(({courierId, orderIdx}) => {
            if (!state.routes[courierId]) state.routes[courierId] = { order: [] };
            state.routes[courierId].order.splice(orderIdx, 0, id);
            recalcRouteDistance(courierId);
          });
          renderAddresses();
          renderCouriers();
          renderRouteSummary();
          maybeShowGeocodeButton();
          redrawMap();
          showToast('Ștergere anulată.');
        }
      });
    });
  });

  // Guarded — see the note on the equivalent line in renderCouriers().
  if (!applyingRemoteSnapshot) saveAddressesToStorage();
}

// -------------------------------------------------------------------
// GEOCODING — Nominatim, with confidence scoring and query cascade
// -------------------------------------------------------------------
const geocodeCache = new Map();

// ---- Persistent verified-address database (localStorage) ----------
// Once an address has been manually confirmed as correctly located (dragged on the map,
// or edited and re-confirmed), its exact text + coordinates are saved here. Future imports
// of the SAME exact address text skip Nominatim entirely and reuse the verified position —
// this is how repeat customers' addresses get more reliable over time.
const VERIFIED_ADDR_STORAGE_KEY = 'trasee-curieri:verified-addresses';

function loadVerifiedAddressDB(){
  try {
    const raw = localStorage.getItem(VERIFIED_ADDR_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e){
    console.error('Could not read verified address DB', e);
    return {};
  }
}

function saveVerifiedAddressDB(db){
  try {
    localStorage.setItem(VERIFIED_ADDR_STORAGE_KEY, JSON.stringify(db));
  } catch (e){
    console.error('Could not save verified address DB', e);
  }
}

/**
 * Normalizes ONLY whitespace and case for the lookup key — exact text match otherwise,
 * as requested (no fuzzy matching). "Strada Garleni 11, București" and
 * "  strada garleni 11, bucuresti  " are treated as the same key, but any other
 * difference (missing word, different number, etc.) is a different address.
 */
function addressLookupKey(address){
  return String(address || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getVerifiedAddress(address){
  const db = loadVerifiedAddressDB();
  return db[addressLookupKey(address)] || null;
}

function saveVerifiedAddress(address, lat, lng){
  const db = loadVerifiedAddressDB();
  db[addressLookupKey(address)] = { lat, lng, originalText: address, savedAt: new Date().toISOString() };
  saveVerifiedAddressDB(db);
  updateVerifiedDbCounter();
}

function removeVerifiedAddress(address){
  const db = loadVerifiedAddressDB();
  delete db[addressLookupKey(address)];
  saveVerifiedAddressDB(db);
}

function countVerifiedAddresses(){
  return Object.keys(loadVerifiedAddressDB()).length;
}

/**
 * Builds a list of query variants to try, from most to least specific.
 * Romanian street addresses are often abbreviated/incomplete (e.g. "Oltenitei 44"
 * instead of "Soseaua Oltenitei 44"), so common prefixes are tried explicitly.
 */
/**
 * Normalizes the road-type prefix on a street name as typed by a customer in a checkout form.
 * Handles common Romanian abbreviations (str, bd, sos, cal, alee, dr) and expands them to the
 * full word, which Nominatim matches far more reliably than abbreviations.
 * If no prefix is present at all, leaves the street name untouched (buildAddressVariants will
 * try adding "Strada"/"Șoseaua" as fallback variants during geocoding).
 */
const STREET_PREFIX_MAP = [
  { re: /^(str|strada)\.?\s+/i, full: 'Strada' },
  { re: /^(sos|șos|sosea|șoseaua?)\.?\s+/i, full: 'Șoseaua' },
  { re: /^(bd|blvd|bul|bulevardul?)\.?\s+/i, full: 'Bulevardul' },
  { re: /^(cal|calea)\.?\s+/i, full: 'Calea' },
  { re: /^(al|alee|aleea)\.?\s+/i, full: 'Aleea' },
  { re: /^(dr|drum|drumul)\.?\s+/i, full: 'Drumul' },
  { re: /^(int|intrarea)\.?\s+/i, full: 'Intrarea' },
  { re: /^(spl|splai|splaiul)\.?\s+/i, full: 'Splaiul' },
  { re: /^(pia[tț]a)\.?\s+/i, full: 'Piața' },
];

function normalizeStreetPrefix(street){
  const trimmed = street.trim();
  for (const { re, full } of STREET_PREFIX_MAP){
    if (re.test(trimmed)){
      return trimmed.replace(re, `${full} `);
    }
  }
  return trimmed; // no recognized prefix — left as-is, geocoding cascade will try adding one
}

/**
 * WooCommerce shipping forms in Bucharest often capture only "Sector N" as the city,
 * without "București". Nominatim needs the city name to resolve the sector reliably,
 * so "Sector 4" becomes "Sector 4, București" while other cities are left untouched.
 */
function normalizeCityForGeocoding(city){
  const trimmed = city.trim();
  if (/^sector\s*\d/i.test(trimmed) && !/bucure[sș]ti/i.test(trimmed)){
    return `${trimmed}, București`;
  }
  return trimmed;
}

function buildAddressVariants(address){
  const variants = [address];
  const ROAD_PREFIXES = ['Șoseaua', 'Strada', 'Bulevardul', 'Calea', 'Aleea', 'Drumul'];

  // if address has no known road-type prefix on its street segment, try adding common ones
  const hasPrefix = ROAD_PREFIXES.some(p => address.toLowerCase().includes(p.toLowerCase()));
  if (!hasPrefix){
    // format is "Stradă Nr, Oraș[, România]" — the street+number segment is always first
    const segments = address.split(',').map(s => s.trim());
    if (segments[0]){
      ROAD_PREFIXES.slice(0, 2).forEach(prefix => {
        const modified = [...segments];
        modified[0] = `${prefix} ${modified[0]}`;
        variants.push(modified.join(', '));
      });
    }
  }

  // fallback: drop the house number entirely (street+city only) — less precise but better than nothing
  const withoutNumber = address.replace(/,?\s*\b\d+[A-Za-z]?\b\s*(,|$)/, '$1').replace(/,\s*,/g, ',').trim();
  if (withoutNumber && withoutNumber !== address) variants.push(withoutNumber);

  return variants;
}

/**
 * Scores a Nominatim result's specificity based on its returned "type"/"class".
 * Returns 'high' (house-level), 'medium' (street-level), or 'low' (area/city-level only).
 */
function scoreResultConfidence(result){
  const type = result.type || '';
  if (result.address && result.address.house_number) return 'high';
  if (result.class === 'building' || type === 'house') return 'high';
  if (type === 'road' || type === 'street' || result.class === 'highway') return 'medium';
  return 'low';
}

// Service area: Bucharest + Ilfov county + ~25-30km margin around it (covers nearby
// localities like Snagov, Buftea, Periș, Ștefăneștii de Jos, etc.). Any geocoding result
// landing outside this box is treated as wrong/out-of-country and rejected outright,
// since deliveries are exclusively within this region.
const SERVICE_AREA_BOUNDS = { minLat: 43.93, maxLat: 44.93, minLng: 25.40, maxLng: 26.80 };

function isWithinServiceArea(lat, lng){
  return lat >= SERVICE_AREA_BOUNDS.minLat && lat <= SERVICE_AREA_BOUNDS.maxLat &&
         lng >= SERVICE_AREA_BOUNDS.minLng && lng <= SERVICE_AREA_BOUNDS.maxLng;
}

async function geocodeOne(address, allowOutOfArea = false){
  const cacheKey = allowOutOfArea ? `${address}__allowOOA` : address;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);

  // 1. Check the persistent verified-address database first — exact text match only.
  //    Skips Nominatim entirely for addresses we've already confirmed correct before.
  const verified = getVerifiedAddress(address);
  if (verified){
    const result = { lat: verified.lat, lng: verified.lng, confidence: 'verified', matchedQuery: address, displayName: '' };
    geocodeCache.set(cacheKey, result);
    return result;
  }

  const variants = buildAddressVariants(address);
  let bestResult = null;
  let bestOutOfAreaResult = null;
  let sawOutOfAreaResult = false;

  for (const variant of variants){
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&countrycodes=ro&q=${encodeURIComponent(variant)}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'ro' } });
      const data = await res.json();
      if (data && data.length){
        const lat = parseFloat(data[0].lat);
        const lng = parseFloat(data[0].lon);
        const confidence = scoreResultConfidence(data[0]);

        if (!isWithinServiceArea(lat, lng)){
          // Outside Bucharest/Ilfov+margin — rejected by default, but if the user explicitly
          // allowed out-of-area for this address, keep the best such result as a fallback
          // (still prefer continuing the cascade in case a later variant lands in-area).
          sawOutOfAreaResult = true;
          if (allowOutOfArea && (!bestOutOfAreaResult || confidence === 'high')){
            bestOutOfAreaResult = { lat, lng, confidence, matchedQuery: variant, displayName: data[0].display_name || '' };
          }
          continue;
        }

        const result = {
          lat, lng,
          confidence,
          matchedQuery: variant,
          displayName: data[0].display_name || ''
        };
        if (confidence === 'high'){
          geocodeCache.set(cacheKey, result);
          return result;
        }
        if (!bestResult) bestResult = result; // keep first medium/low as fallback, but keep trying for better
      }
    } catch (e){
      console.error('Geocode error', e);
    }
    if (variant !== variants[variants.length - 1]) await sleep(1000); // respect Nominatim rate limit between cascade attempts
  }

  if (!bestResult && allowOutOfArea && bestOutOfAreaResult){
    geocodeCache.set(cacheKey, bestOutOfAreaResult);
    return bestOutOfAreaResult;
  }

  if (!bestResult && sawOutOfAreaResult){
    // every variant resolved to somewhere outside the service area — flag distinctly so the
    // UI can show a clear "out of area" error instead of a generic "not found"
    geocodeCache.set(cacheKey, { outOfArea: true });
    return { outOfArea: true };
  }

  geocodeCache.set(cacheKey, bestResult);
  return bestResult;
}

async function geocodeAllPending(){
  const section = document.getElementById('geocodeSection');
  const statusRow = document.getElementById('geocodeStatus');
  const btn = document.getElementById('geocodeBtn');
  const pending = state.addresses.filter(a => a.status === 'pending');
  if (!pending.length) return;

  btn.style.display = 'none';
  statusRow.style.display = 'flex';

  let done = 0;
  let lowConfidenceCount = 0;
  let outOfAreaCount = 0;
  for (const a of pending){
    statusRow.querySelector('span:last-child').textContent = `Se localizează ${done + 1}/${pending.length}…`;
    const result = await geocodeOne(a.raw, a.allowOutOfArea);
    if (result && result.outOfArea){
      a.status = 'error';
      a.confidence = null;
      a.outOfArea = true;
      outOfAreaCount++;
    } else if (result){
      a.lat = result.lat;
      a.lng = result.lng;
      a.status = 'ok';
      a.confidence = result.confidence;
      a.outOfArea = !isWithinServiceArea(result.lat, result.lng); // true even when allowed, for visual flagging
      if (result.confidence !== 'high' && result.confidence !== 'verified') lowConfidenceCount++;
      if (result.confidence === 'high' && !a.outOfArea){
        saveVerifiedAddress(a.raw, result.lat, result.lng);
      }
    } else {
      a.status = 'error';
      a.confidence = null;
      a.outOfArea = false;
    }
    done++;
    // Guarded (no save-per-iteration): renderAddresses() normally saves to Firestore at the
    // end of every render, but doing that on every single address here means the resulting
    // onSnapshot echo can arrive mid-loop and REPLACE state.addresses with a slightly older
    // snapshot — silently discarding whatever this loop had already geocoded past that point
    // (surfacing as "bulk locate didn't do them all, had to do each one by hand"). One real
    // save after the whole loop finishes avoids the mid-loop race entirely.
    applyingRemoteSnapshot = true;
    renderAddresses();
    redrawMap();
    applyingRemoteSnapshot = false;
    // Nominatim usage policy: max ~1 request/sec
    await sleep(1000);
  }
  saveAddressesToStorage();

  statusRow.style.display = 'none';
  const errCount = state.addresses.filter(a => a.status === 'error').length;
  if (outOfAreaCount > 0){
    showToast(`${outOfAreaCount} adrese localizate în afara zonei de livrare (București/Ilfov) — corectează-le manual.`, true);
  } else if (errCount > 0){
    showToast(`${done} adrese procesate, ${errCount} neidentificate.`, true);
  } else if (lowConfidenceCount > 0){
    showToast(`${done} adrese localizate, ${lowConfidenceCount} cu precizie aproximativă — verifică-le pe hartă.`, true);
  } else {
    showToast(`${done} adrese localizate cu precizie ridicată.`);
  }
  maybeShowGeocodeButton();
  fitMapToAll();
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// -------------------------------------------------------------------
// AUTO-ASSIGNMENT (clustering) + ROUTE OPTIMIZATION (OSRM)
// -------------------------------------------------------------------
function initRoutePanel(){
  document.getElementById('autoAssignBtn').addEventListener('click', runAutoAssignAndRoute);
  document.getElementById('historyBtn').addEventListener('click', showHistoryModal);
}

async function runAutoAssignAndRoute(){
  const geocodedAddrs = state.addresses.filter(a => a.status === 'ok');
  if (!geocodedAddrs.length){
    showToast('Nu există adrese localizate. Importă și geocodează mai întâi.', true);
    return;
  }

  // make sure every courier's start/end point reflects what's currently typed in the input,
  // even if the user never blurred the field (e.g. typed the address then clicked "Repartizează automat")
  await ensureAllCourierPointsGeocoded();

  const validCouriers = state.couriers.filter(c => c.start.status === 'ok');
  const invalidCouriers = state.couriers.filter(c => c.start.status !== 'ok');

  if (!validCouriers.length){
    showToast('Niciun curier nu are un punct de plecare valid. Completează adresa și încearcă din nou.', true);
    return;
  }
  if (invalidCouriers.length){
    const names = invalidCouriers.map(c => c.name).join(', ');
    showToast(`${names} ${invalidCouriers.length === 1 ? 'nu are' : 'nu au'} punct de plecare valid — exclus din repartizare.`, true);
  }

  showToast('Se repartizează adresele…');

  // 1. Assign each address to nearest courier start point (simple geographic clustering),
  //    then balance so no courier is overloaded relative to others.
  assignAddressesToNearestCourier(geocodedAddrs, validCouriers);

  renderAddresses();
  renderCouriers();

  // 2. For each courier, compute optimized order via OSRM
  for (const courier of validCouriers){
    const assigned = state.addresses.filter(a => a.courierId === courier.id && a.status === 'ok');
    if (!assigned.length){
      delete state.routes[courier.id];
      continue;
    }
    await computeOptimizedRoute(courier, assigned);
  }

  // 3. Refine for finish-time balance: if the gap between the longest and shortest route
  //    exceeds the allowed buffer, move addresses from the busiest courier to the lightest
  //    one and recompute, until everyone's total time is within the buffer (or nothing more
  //    can be moved without breaking the count-balance guarantee from step 1).
  await balanceRoutesByTime(validCouriers);

  // 4. Clean up local inefficiencies the earlier passes can't see: an address whose own
  //    courier's route detours to reach it, sitting right next to a stop (or right on the
  //    path) of a courier who was going to be in that area anyway. Uses the real, now-known
  //    route data instead of pre-route approximations (bearing/centroid/distance-to-start).
  await reassignByRouteInsertionSavings(validCouriers);

  renderCouriers();
  renderRouteSummary();
  redrawMap();
  updateMapTopBar();
  updateExportButtonsState();
  pushHistorySnapshot();
  showToast('Trasee generate.');
  switchToTab('panel-trasee');
}

// -------------------------------------------------------------------
// ROUTE HISTORY — automatic snapshot of the last MAX_HISTORY_ENTRIES successful
// "Repartizează automat" runs, so an earlier version of today's routes is always one
// click away (e.g. after a bad manual edit, or wanting to compare two attempts) without
// needing to have manually saved a file beforehand.
// -------------------------------------------------------------------
const HISTORY_STORAGE_KEY = 'trasee-curieri:history';
const MAX_HISTORY_ENTRIES = 5;

function pushHistorySnapshot(){
  try {
    const history = loadHistory();
    history.unshift({
      savedAt: new Date().toISOString(),
      couriers: state.couriers,
      nextCourierId: state.nextCourierId,
      addresses: state.addresses,
      nextAddrId: state.nextAddrId,
      routes: state.routes
    });
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, MAX_HISTORY_ENTRIES)));
  } catch (e){
    console.error('Could not save route history', e);
  }
}

function loadHistory(){
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    const history = raw ? JSON.parse(raw) : [];
    return Array.isArray(history) ? history : [];
  } catch (e){
    console.error('Could not load route history', e);
    return [];
  }
}

function restoreHistorySnapshot(index){
  const history = loadHistory();
  const snap = history[index];
  if (!snap) return;
  if (!confirm('Sigur vrei să restaurezi acest traseu? Se va suprascrie tot ce ai acum (curieri, adrese, trasee).')) return;

  state.couriers = snap.couriers;
  state.nextCourierId = snap.nextCourierId || (snap.couriers.length ? Math.max(...snap.couriers.map(c => c.id)) + 1 : 1);
  state.addresses = snap.addresses;
  state.nextAddrId = snap.nextAddrId || (snap.addresses.length ? Math.max(...snap.addresses.map(a => a.id)) + 1 : 1);
  state.routes = (snap.routes && typeof snap.routes === 'object' && !Array.isArray(snap.routes)) ? snap.routes : {};
  state.routeSelection.clear();

  renderCouriers();
  renderAddresses();
  renderRouteSummary();
  maybeShowGeocodeButton();
  updateExportButtonsState();
  redrawMap();
  fitMapToAll();
  showToast('Traseu restaurat din istoric.');
}

function showHistoryModal(){
  const history = loadHistory();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:380px;">
      <div class="modal-title">Istoric trasee generate</div>
      ${history.length ? `
        <div class="hint" style="margin-bottom:10px;">Ultimele ${history.length} repartizări automate. Restaurarea suprascrie starea curentă.</div>
        <div id="historyList">
          ${history.map((h, i) => {
            const courierCount = h.couriers.length;
            const addrCount = h.addresses.length;
            const routedCount = Object.values(h.routes || {}).reduce((s, r) => s + r.order.length, 0);
            const when = new Date(h.savedAt).toLocaleString('ro-RO', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
            return `
              <div class="verified-db-row">
                <div class="verified-db-text">
                  <div class="verified-db-addr">${escapeHtml(when)}</div>
                  <div class="verified-db-coords">${courierCount} curieri · ${routedCount}/${addrCount} adrese repartizate</div>
                </div>
                <button class="btn btn-sm" data-restore-history="${i}">Restaurează</button>
              </div>
            `;
          }).join('')}
        </div>
      ` : `<div class="hint">Nu există încă niciun traseu generat în istoric — apare aici după prima „Repartizează automat".</div>`}
      <button class="btn btn-ghost btn-sm btn-block" id="closeHistoryBtn" style="margin-top:14px;">Închide</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('closeHistoryBtn').addEventListener('click', close);
  overlay.querySelectorAll('[data-restore-history]').forEach(btn => {
    btn.addEventListener('click', () => {
      restoreHistorySnapshot(parseInt(btn.dataset.restoreHistory));
      close();
    });
  });
}

const TIME_BALANCE_BUFFER_MIN = 30; // couriers' total route time should end up within ~30min of each other

/**
 * Moves addresses from the courier with the longest total route time to the one with the
 * shortest, recomputing both routes each time, until the gap is within the buffer or no
 * further beneficial move exists.
 *
 * Count balance outranks time balance: this pass is only allowed to widen the gap in stop
 * counts between the two couriers involved up to MAX_COUNT_GAP. A courier whose
 * stops are far apart can still legitimately end up with fewer of them for the same total
 * time — that's the intended exception — but earlier this pass had no ceiling at all, which
 * let a handful of far-flung stops chain-drag the same courier's count down pass after pass
 * (14 vs 24 in practice) chasing a 30min time gap that a few extra minutes of imbalance
 * would have been an acceptable trade for. The floor "never fully empty a courier's route
 * out from under them mid-balance" is kept for the same reason as before: without an
 * explicit "eligible source" check, a courier already down to its last address (or one the
 * previous pass just emptied) would incorrectly keep being picked as "longest" forever if
 * its few remaining stops are still far apart, blocking ALL further balancing — including
 * between two completely different couriers whose own gap has nothing to do with it.
 *
 * Each candidate move is verified, not assumed: since a single address can carry a big
 * chunk of drive time, moving it can overshoot and make the gap WORSE (the courier that
 * was shortest becomes the new longest). If that happens the move is reverted — using the
 * already-computed previous route, no extra OSRM calls — and the next-best edge candidate
 * is tried instead, up to a small cap per pass. This is what makes a tight buffer safe:
 * without it, a strict target could thrash the same address back and forth every pass
 * without ever converging.
 */
const MAX_CANDIDATES_PER_BALANCE_PASS = 3;
const MAX_COUNT_GAP = 5; // hard ceiling on stop-count gap between any two couriers — enforced both after geographic assignment (enforceCountBalance) and during time-balancing

async function balanceRoutesByTime(couriers){
  const MAX_PASSES = 30;
  for (let pass = 0; pass < MAX_PASSES; pass++){
    const withRoutes = couriers
      .map(c => ({ courier: c, route: state.routes[c.id] }))
      .filter(x => x.route);
    if (withRoutes.length < 2) return;

    const countOf = courierId => state.addresses.filter(a => a.courierId === courierId && a.status === 'ok').length;
    // A courier whose every stop was manually reassigned by the user has nothing this pass
    // is allowed to move — excluded from "longest" candidacy entirely, rather than picked
    // and then failing to find any movable address, so balancing still proceeds against the
    // next-worst courier it CAN actually act on.
    const hasMovableAddr = courierId => state.addresses.some(a => a.courierId === courierId && a.status === 'ok' && !a.manuallyAssigned);
    const eligibleSources = withRoutes.filter(x => countOf(x.courier.id) > 1 && hasMovableAddr(x.courier.id));
    if (!eligibleSources.length) return;

    const longest = eligibleSources.reduce((a,b) => b.route.totalMin > a.route.totalMin ? b : a);
    const shortest = withRoutes.reduce((a,b) => b.route.totalMin < a.route.totalMin ? b : a);
    const gap = longest.route.totalMin - shortest.route.totalMin;
    if (gap <= TIME_BALANCE_BUFFER_MIN || longest.courier.id === shortest.courier.id) return;

    // kept as the full set (including manually-locked stops) for the sector-center/bearing
    // math below — that's a geographic reference point and should reflect ALL of the
    // courier's real stops, even ones the pass below isn't allowed to move.
    const longestAddrs = state.addresses.filter(a => a.courierId === longest.courier.id && a.status === 'ok');

    // Only consider addresses that sit at the angular EDGE of the longest courier's own
    // sector, closest to the shortest courier's direction — never an address from deep
    // inside the sector just because it happens to be close in straight-line distance to
    // the other courier's start. This keeps each courier's wedge geographically intact.
    const sectorCenterLat = longestAddrs.reduce((s,a) => s+a.lat, 0) / longestAddrs.length;
    const sectorCenterLng = longestAddrs.reduce((s,a) => s+a.lng, 0) / longestAddrs.length;
    const bearingOfShortest = Math.atan2(
      (shortest.courier.start.lng - sectorCenterLng) * Math.cos(sectorCenterLat * Math.PI / 180),
      shortest.courier.start.lat - sectorCenterLat
    ) * 180 / Math.PI;

    // rank longest's MOVABLE addresses (never a manually-reassigned one — that lock must
    // survive "Repartizează automat" the same way it already does in the other two passes)
    // by how close their own bearing (from their sector center) is to the direction of the
    // shortest courier — the "edge facing" candidates come first
    const ranked = longestAddrs.filter(a => !a.manuallyAssigned).map(a => {
      const bearing = Math.atan2(
        (a.lng - sectorCenterLng) * Math.cos(sectorCenterLat * Math.PI / 180),
        a.lat - sectorCenterLat
      ) * 180 / Math.PI;
      let diff = Math.abs(bearing - bearingOfShortest);
      if (diff > 180) diff = 360 - diff;
      return { addr: a, angularDist: diff };
    }).sort((a, b) => a.angularDist - b.angularDist);

    let madeProgress = false;
    for (const candidate of ranked.slice(0, MAX_CANDIDATES_PER_BALANCE_PASS)){
      const moveAddr = candidate.addr;

      // Count balance beats time balance: reject this candidate outright (no OSRM calls
      // wasted) if taking it from the busier-by-time courier would push the stop-count gap
      // between these two couriers past the ceiling, even though it would help the time gap.
      // Exception: if the gap is ALREADY past the ceiling (e.g. an upstream geographic split
      // handed us a bad starting point), still allow moves that shrink it — otherwise this
      // guard would freeze an already-broken split in place instead of letting it converge
      // down toward the ceiling. Only moves that would make an over-ceiling gap equal or worse
      // are rejected.
      const countGapBefore = Math.abs(countOf(longest.courier.id) - countOf(shortest.courier.id));
      const countGapAfterMove = Math.abs((countOf(longest.courier.id) - 1) - (countOf(shortest.courier.id) + 1));
      if (countGapAfterMove > MAX_COUNT_GAP && countGapAfterMove >= countGapBefore) continue;

      const prevCourierId = moveAddr.courierId;
      const prevManuallyAssigned = moveAddr.manuallyAssigned;
      const prevLongestRoute = state.routes[longest.courier.id];
      const prevShortestRoute = state.routes[shortest.courier.id];

      moveAddr.courierId = shortest.courier.id;
      moveAddr.manuallyAssigned = false;

      const longestRemaining = state.addresses.filter(a => a.courierId === longest.courier.id && a.status === 'ok');
      const shortestNew = state.addresses.filter(a => a.courierId === shortest.courier.id && a.status === 'ok');
      if (longestRemaining.length){
        await computeOptimizedRoute(longest.courier, longestRemaining);
      } else {
        delete state.routes[longest.courier.id];
      }
      await computeOptimizedRoute(shortest.courier, shortestNew);

      const newLongestMin = state.routes[longest.courier.id] ? state.routes[longest.courier.id].totalMin : 0;
      const newShortestMin = state.routes[shortest.courier.id].totalMin;
      const newGap = Math.abs(newLongestMin - newShortestMin);

      if (newGap < gap){
        madeProgress = true;
        break; // kept — re-evaluate longest/shortest fresh from the top on the next pass
      }

      // overshot or made no difference — revert to the exact prior state (cheap, no
      // network calls needed since we still hold the previously computed routes) and
      // try the next-best edge candidate instead
      moveAddr.courierId = prevCourierId;
      moveAddr.manuallyAssigned = prevManuallyAssigned;
      if (prevLongestRoute) state.routes[longest.courier.id] = prevLongestRoute;
      else delete state.routes[longest.courier.id];
      state.routes[shortest.courier.id] = prevShortestRoute;
    }

    if (!madeProgress) return; // no single-address move between the current extremes can help further
  }
}

const ROUTE_SAVINGS_MAX_CANDIDATE_KM = 6; // cheap pre-filter only — real decision is the OSRM-verified time check below
const ROUTE_SAVINGS_MIN_IMPROVEMENT_MIN = 1; // minimum combined-time improvement required to commit a move (avoids thrashing on noise)
const ROUTE_SAVINGS_MAX_TRIES = 20; // hard cap on candidates tried per run, to bound OSRM calls

/**
 * Fixes local inefficiencies the earlier passes structurally can't see: sectorizeAddressesByCourier,
 * refineSectorBoundaries and rescueDistanceOutliers all reason about an address's position relative
 * to bearings, centroids, or a courier's START point — none of them know what a courier's actual,
 * now-optimized route looks like. An address can sit right next to another courier's stop (or right
 * on their path) purely because that courier was already headed that way for an unrelated reason
 * (e.g. a stop further out in the same direction), and no pre-route heuristic can see that.
 *
 * This pass only trusts real data: for each candidate address, it actually moves it, recomputes
 * both affected routes via OSRM, and checks whether the COMBINED total time of the two couriers
 * involved went down. If not, it reverts — same "verify, don't assume" approach as balanceRoutesByTime,
 * and for the same reason (a single stop can carry a disproportionate share of drive time, so the
 * effect of moving it is not reliably predictable from distance alone).
 *
 * The candidate search itself stays cheap (haversine, no network calls): for every non-locked
 * address, find the nearest address currently held by a DIFFERENT courier. Only addresses within
 * ROUTE_SAVINGS_MAX_CANDIDATE_KM of such a neighbor are worth spending an OSRM round-trip on — the
 * threshold is deliberately generous, since the real accept/reject decision is the verified time
 * check, not this pre-filter.
 *
 * Respects the same MAX_COUNT_GAP guard as balanceRoutesByTime, with the same "allow if it improves
 * an already-over-cap gap, block if it would make a healthy gap worse" rule — a route-efficiency
 * fix should not be allowed to quietly undo the count-balance guarantee.
 */
async function reassignByRouteInsertionSavings(couriers){
  const rejected = new Set(); // address ids tried and rejected this run — don't re-offer them
  let tries = 0;

  while (tries < ROUTE_SAVINGS_MAX_TRIES){
    const withRoutes = couriers.filter(c => state.routes[c.id]);
    if (withRoutes.length < 2) return;

    const countOf = courierId => state.addresses.filter(a => a.courierId === courierId && a.status === 'ok').length;
    const routedIds = new Set(withRoutes.map(c => c.id));
    const candidates = state.addresses.filter(a =>
      a.status === 'ok' && a.courierId != null && !a.manuallyAssigned &&
      !rejected.has(a.id) && routedIds.has(a.courierId) && countOf(a.courierId) > 1
    );

    let best = null;
    for (const addr of candidates){
      let nearestOther = null, nearestDist = Infinity;
      for (const other of state.addresses){
        if (other.status !== 'ok' || other.courierId == null) continue;
        if (other.courierId === addr.courierId || !routedIds.has(other.courierId)) continue;
        const d = haversine(addr.lat, addr.lng, other.lat, other.lng);
        if (d < nearestDist){ nearestDist = d; nearestOther = other; }
      }
      if (!nearestOther || nearestDist > ROUTE_SAVINGS_MAX_CANDIDATE_KM) continue;
      if (!best || nearestDist < best.dist){
        best = { addr, fromId: addr.courierId, toId: nearestOther.courierId, dist: nearestDist };
      }
    }

    if (!best) return; // no remaining cross-courier pair close enough to be worth testing

    tries++;
    const fromCourier = couriers.find(c => c.id === best.fromId);
    const toCourier = couriers.find(c => c.id === best.toId);

    const countGapBefore = Math.abs(countOf(fromCourier.id) - countOf(toCourier.id));
    const countGapAfter = Math.abs((countOf(fromCourier.id) - 1) - (countOf(toCourier.id) + 1));
    if (countGapAfter > MAX_COUNT_GAP && countGapAfter >= countGapBefore){
      rejected.add(best.addr.id);
      continue;
    }

    const prevFromRoute = state.routes[fromCourier.id];
    const prevToRoute = state.routes[toCourier.id];
    const prevCourierId = best.addr.courierId;
    const combinedBefore = (prevFromRoute ? prevFromRoute.totalMin : 0) + (prevToRoute ? prevToRoute.totalMin : 0);

    best.addr.courierId = toCourier.id;

    const fromRemaining = state.addresses.filter(a => a.courierId === fromCourier.id && a.status === 'ok');
    const toNew = state.addresses.filter(a => a.courierId === toCourier.id && a.status === 'ok');

    if (fromRemaining.length) await computeOptimizedRoute(fromCourier, fromRemaining);
    else delete state.routes[fromCourier.id];
    await computeOptimizedRoute(toCourier, toNew);

    const combinedAfter = (state.routes[fromCourier.id] ? state.routes[fromCourier.id].totalMin : 0) + state.routes[toCourier.id].totalMin;

    if (combinedBefore - combinedAfter >= ROUTE_SAVINGS_MIN_IMPROVEMENT_MIN){
      continue; // kept — rescan fresh from the top, state has changed
    }

    // not worth it — revert to the exact prior state (cheap, no extra network calls) and
    // mark this address as tried so it isn't offered again this run
    best.addr.courierId = prevCourierId;
    if (prevFromRoute) state.routes[fromCourier.id] = prevFromRoute;
    else delete state.routes[fromCourier.id];
    state.routes[toCourier.id] = prevToRoute;
    rejected.add(best.addr.id);
  }
}

/**
 * Geocodes any courier start/end point that has text typed in but hasn't been confirmed
 * yet (status still 'pending'). This covers the case where a courier was just added/edited
 * and the user clicked straight to "Repartizează automat" without tabbing out of the field.
 * Reads directly from the DOM inputs first, since unconfirmed edits (no blur yet) haven't
 * been written back to state.
 */
async function ensureAllCourierPointsGeocoded(){
  document.querySelectorAll('.start-input').forEach(input => {
    const courier = state.couriers.find(c => c.id === parseInt(input.dataset.courier));
    if (courier && input.value.trim() !== courier.start.address){
      courier.start.address = input.value.trim();
      courier.start.status = 'pending';
      courier.start.lat = null;
      courier.start.lng = null;
    }
  });
  document.querySelectorAll('.end-input').forEach(input => {
    const courier = state.couriers.find(c => c.id === parseInt(input.dataset.courier));
    if (courier && input.value.trim() !== courier.end.address){
      courier.end.address = input.value.trim();
      courier.end.status = 'pending';
      courier.end.lat = null;
      courier.end.lng = null;
    }
  });

  for (const courier of state.couriers){
    for (const pointKey of ['start', 'end']){
      const point = courier[pointKey];
      if (point.address && point.status === 'pending'){
        const result = await geocodeOne(point.address);
        if (result && result.outOfArea){
          point.status = 'error';
        } else if (result){
          point.lat = result.lat;
          point.lng = result.lng;
          point.status = 'ok';
        } else {
          point.status = 'error';
        }
      }
    }
  }
  renderCouriers();
}

/**
 * Two-phase address assignment:
 * 1. Geographic + count balance — assigns by proximity first, then forcibly rebalances
 *    so no courier ends up with zero (or far too few) addresses just because their start
 *    point happens to be geographically distant from the cluster. Balance target allows a
 *    buffer of up to COUNT_BUFFER addresses between the busiest and lightest courier.
 * 2. Time balance — handled separately in runAutoAssignAndRoute, after routes are computed,
 *    since it requires real driving-time data from OSRM.
 */
const COUNT_BUFFER = 6; // addresses of slack allowed between the busiest and lightest courier

/**
 * Splits addresses into N angular sectors (wedges) radiating from a central point, one
 * per courier, anchored on each courier's own bearing from that center — not freely
 * rotated to balance counts. This guarantees a courier whose start point is, say, due
 * north of the delivery area always gets the northern sector, regardless of how many
 * addresses naturally fall there. Two couriers starting near each other will always end
 * up with adjacent (not opposite) sectors, since sector boundaries sit at the midpoint
 * between each pair of neighboring courier bearings.
 *
 * The count buffer is still enforced afterward by trading addresses across adjacent
 * sector boundaries only — it can rebalance load, but it can no longer relocate an
 * entire sector to a courier on the opposite side of the city.
 */
function sectorizeAddressesByCourier(addrs, couriers, centerLat, centerLng, minSize, maxSize){
  const numSectors = couriers.length;
  if (!addrs.length || numSectors <= 0) return [];
  if (numSectors === 1) return [addrs.slice()];

  const bearingOf = (lat, lng) => {
    const dLat = lat - centerLat;
    const dLng = (lng - centerLng) * Math.cos(centerLat * Math.PI / 180);
    let angle = Math.atan2(dLng, dLat) * 180 / Math.PI; // 0° = north, increasing clockwise
    if (angle < 0) angle += 360;
    return angle;
  };

  // Each courier's own bearing from the delivery centroid, sorted around the compass.
  const courierBearings = couriers
    .map((c, idx) => ({ idx, bearing: bearingOf(c.start.lat, c.start.lng) }))
    .sort((a, b) => a.bearing - b.bearing);

  // Sector boundaries sit at the midpoint between each pair of consecutive courier
  // bearings (wrapping around 360°) — so sector i spans from the midpoint before
  // courier i's bearing to the midpoint after it, centered on that courier's direction.
  const boundaries = courierBearings.map((cur, i) => {
    const next = courierBearings[(i + 1) % courierBearings.length].bearing;
    let span = next - cur.bearing;
    if (span <= 0) span += 360;
    return cur.bearing + span / 2; // upper boundary of this courier's sector
  });

  const withAngles = addrs.map(a => ({ addr: a, angle: bearingOf(a.lat, a.lng) }));

  // sectorForCourierSlot[i] = list of addresses whose bearing falls within the wedge
  // belonging to courierBearings[i] (in sorted-by-bearing order, NOT original courier order)
  const sectorsBySlot = Array.from({length: numSectors}, () => []);
  withAngles.forEach(({addr, angle}) => {
    // find which slot's wedge contains this angle: slot i owns (lowerBoundary[i-1], boundaries[i]]
    let slot = 0;
    for (let i = 0; i < numSectors; i++){
      const lower = boundaries[(i - 1 + numSectors) % numSectors];
      const upper = boundaries[i];
      const inWedge = lower < upper
        ? (angle > lower && angle <= upper)
        : (angle > lower || angle <= upper); // wedge wraps past 360°/0°
      if (inWedge){ slot = i; break; }
    }
    sectorsBySlot[slot].push(addr);
  });

  // Enforce the count buffer by trading addresses across ADJACENT slot boundaries only —
  // this can shrink/grow a wedge slightly but never reassigns it to a non-neighboring slot.
  // Cap is proportional to the address count, not a small fixed multiple of numSectors: each
  // iteration moves exactly one address, and a skewed initial bearing split (e.g. two couriers
  // starting close to each other, or close to the delivery centroid, makes their bearings
  // numerically unstable) can require moving dozens of addresses to reach maxSize — a fixed
  // `numSectors * 4` cap silently gave up after 8 moves regardless of how far off the split was.
  let iterations = 0;
  const maxIterations = Math.max(numSectors * 4, addrs.length * 2);
  while (iterations < maxIterations){
    iterations++;
    const over = sectorsBySlot.map((s, i) => ({ i, size: s.length })).filter(s => s.size > maxSize).sort((a,b) => b.size - a.size)[0];
    if (!over) break;
    const candidates = [(over.i - 1 + numSectors) % numSectors, (over.i + 1) % numSectors]
      .filter(ni => sectorsBySlot[ni].length < maxSize);
    if (!candidates.length) break;
    const targetSlot = candidates.reduce((best, ni) => sectorsBySlot[ni].length < sectorsBySlot[best].length ? ni : best, candidates[0]);
    const boundaryAngle = boundaries[over.i === targetSlot - 1 || (over.i === numSectors - 1 && targetSlot === 0) ? over.i : (over.i - 1 + numSectors) % numSectors];
    let moveIdx = 0, moveDist = Infinity;
    sectorsBySlot[over.i].forEach((a, idx) => {
      const aAngle = withAngles.find(w => w.addr === a).angle;
      const d = Math.min(Math.abs(aAngle - boundaryAngle), 360 - Math.abs(aAngle - boundaryAngle));
      if (d < moveDist){ moveDist = d; moveIdx = idx; }
    });
    const [moved] = sectorsBySlot[over.i].splice(moveIdx, 1);
    sectorsBySlot[targetSlot].push(moved);
  }

  // Map slots back to original courier order/indices
  const sectorsByOriginalCourierIdx = new Array(numSectors);
  courierBearings.forEach((cb, slot) => { sectorsByOriginalCourierIdx[cb.idx] = sectorsBySlot[slot]; });
  return sectorsByOriginalCourierIdx;
}

function assignAddressesToNearestCourier(addrs, couriers){
  const locked = addrs.filter(a => a.manuallyAssigned && a.courierId != null && couriers.some(c => c.id === a.courierId));
  const free = addrs.filter(a => !locked.includes(a));

  free.forEach(a => a.courierId = null);
  if (!free.length) return;

  const target = addrs.length / couriers.length;
  const minAllowed = Math.max(1, Math.floor(target - COUNT_BUFFER / 2));
  const maxAllowed = Math.ceil(target + COUNT_BUFFER / 2);

  // Center the sectors on the centroid of all free addresses (not a fixed city point),
  // so the split adapts to wherever the actual deliveries are concentrated that day.
  const centerLat = free.reduce((s,a) => s+a.lat, 0) / free.length;
  const centerLng = free.reduce((s,a) => s+a.lng, 0) / free.length;

  // Split the free addresses into sectors anchored on each courier's own bearing from
  // that center — sector i is already tied to couriers[i] by construction, so no separate
  // sector-to-courier matching step is needed (and none can accidentally swap two couriers'
  // wedges just because a rotation search happened to balance counts slightly better).
  const sectorsByCourierIdx = sectorizeAddressesByCourier(free, couriers, centerLat, centerLng, minAllowed, maxAllowed);

  couriers.forEach((c, idx) => {
    (sectorsByCourierIdx[idx] || []).forEach(a => { a.courierId = c.id; });
  });

  refineSectorBoundaries(free);
  rescueDistanceOutliers(free, couriers);
  enforceCountBalance(free, couriers);
}

const BOUNDARY_SWAP_MAX_ITERATIONS = 4;
const BOUNDARY_SWAP_RATIO = 0.6;   // only move if the cross-courier neighbor is under 60% of the distance to the nearest same-courier address
const BOUNDARY_SWAP_MAX_KM = 1.5;  // ...and that cross-courier neighbor is genuinely close by (not just "closer of two far options")

/**
 * The angular sector boundary is a straight line through the delivery centroid — it has no
 * idea that two addresses sitting almost on top of each other can fall on opposite sides of
 * it. That produces exactly the kind of pair a dispatcher immediately spots as wrong on a
 * map: address A (courier X) and address B (courier Y), a block apart, sent to two different
 * couriers who both now have to drive out to that same corner separately.
 *
 * This pass compares each address's nearest cross-courier neighbor against TWO measures of
 * how well it belongs to its own courier: the nearest same-courier neighbor, AND the distance
 * to its own courier's centroid. The centroid check matters because a small huddle of 2-3
 * stragglers protects itself from the nearest-neighbor check alone — each one's closest
 * same-courier point is simply the OTHER straggler right next to it, which makes the pair
 * look "well anchored" to each other even though both are far from the rest of their own
 * courier's addresses and sitting right on top of a different courier's cluster. Either
 * signal is enough to trigger a move; repeated a few times so a whole small huddle gets
 * pulled across together, not just whichever single address is checked first.
 */
function refineSectorBoundaries(free){
  for (let iter = 0; iter < BOUNDARY_SWAP_MAX_ITERATIONS; iter++){
    let movedAny = false;
    for (const addr of free){
      let nearestOtherDist = Infinity, nearestOtherCourierId = null;
      let nearestSameDist = Infinity;
      let sameSumLat = 0, sameSumLng = 0, sameCount = 0;
      free.forEach(other => {
        if (other === addr) return;
        const d = haversine(addr.lat, addr.lng, other.lat, other.lng);
        if (other.courierId === addr.courierId){
          if (d < nearestSameDist) nearestSameDist = d;
          sameSumLat += other.lat; sameSumLng += other.lng; sameCount++;
        } else if (d < nearestOtherDist){
          nearestOtherDist = d;
          nearestOtherCourierId = other.courierId;
        }
      });
      if (nearestOtherCourierId == null || nearestOtherDist > BOUNDARY_SWAP_MAX_KM) continue;

      const centroidDist = sameCount
        ? haversine(addr.lat, addr.lng, sameSumLat / sameCount, sameSumLng / sameCount)
        : Infinity;
      const isStragglerByNeighbor = nearestOtherDist < nearestSameDist * BOUNDARY_SWAP_RATIO;
      const isStragglerByCentroid = sameCount > 0 && nearestOtherDist < centroidDist * BOUNDARY_SWAP_RATIO;

      if (isStragglerByNeighbor || isStragglerByCentroid){
        addr.courierId = nearestOtherCourierId;
        movedAny = true;
      }
    }
    if (!movedAny) break;
  }
}

const OUTLIER_RESCUE_MIN_SAVING_KM = 3;   // only reassign if switching saves at least this many km
const OUTLIER_RESCUE_MAX_RATIO = 0.7;     // ...and the nearest courier's distance is at most 70% of the assigned one

/**
 * Sector assignment above groups addresses purely by BEARING from the delivery centroid.
 * That works well for a compact cluster, but for an address far outside it (e.g. a couple
 * of Ilfov deliveries mixed into an otherwise all-Bucharest batch), bearing from the
 * centroid says nothing about which courier's start point is actually closest — the sector
 * that "happens" to cover that direction can easily belong to a courier who starts on the
 * opposite side of the city. This pass corrects just those cases: it only moves an address
 * when a different courier is substantially closer by real driving-adjacent distance, so
 * sector coherence for addresses that actually sit inside the cluster is left untouched.
 *
 * Deliberately ignores the count-balance cap: it only ever moves a handful of genuine
 * outliers (the saving/ratio thresholds see to that), and getting a stray address to the
 * courier who can actually reach it matters more here than keeping counts even — any
 * resulting imbalance is smoothed out afterward by the time-based balancing pass that
 * runs once real route durations are known.
 */
function rescueDistanceOutliers(free, couriers){
  free.forEach(addr => {
    const currentCourier = couriers.find(c => c.id === addr.courierId);
    if (!currentCourier) return;
    const currentDist = haversine(addr.lat, addr.lng, currentCourier.start.lat, currentCourier.start.lng);

    let nearest = currentCourier, nearestDist = currentDist;
    couriers.forEach(c => {
      const d = haversine(addr.lat, addr.lng, c.start.lat, c.start.lng);
      if (d < nearestDist){ nearestDist = d; nearest = c; }
    });
    if (nearest.id === currentCourier.id) return;

    const saving = currentDist - nearestDist;
    const ratio = nearestDist / currentDist;
    if (saving < OUTLIER_RESCUE_MIN_SAVING_KM || ratio > OUTLIER_RESCUE_MAX_RATIO) return;

    addr.courierId = nearest.id;
  });
}

/**
 * Final hard enforcement of count balance, run after all three geographic passes above.
 * sectorizeAddressesByCourier's own COUNT_BUFFER trading already gets each courier within
 * ~MAX_COUNT_GAP on its own, but refineSectorBoundaries and rescueDistanceOutliers both
 * intentionally ignore that cap afterward (geographic coherence for the handful of addresses
 * they each touch matters more to them than the running count) — their combined effect can
 * still add up to a bigger gap than any single pass intended. This closes it deterministically
 * instead of hoping the time-balance pass happens to need to move enough addresses to fix it
 * as a side effect (it won't, if the two routes already happen to take similar total time
 * despite the count gap): repeatedly hand the heaviest courier's address closest to the
 * lightest courier's start point over to them, until every pair is within MAX_COUNT_GAP or
 * the heaviest courier is down to its last stop.
 */
function enforceCountBalance(free, couriers){
  if (couriers.length < 2) return;
  const maxIterations = free.length * 2;
  for (let i = 0; i < maxIterations; i++){
    const counts = couriers
      .map(c => ({ c, addrs: free.filter(a => a.courierId === c.id) }))
      .sort((a, b) => b.addrs.length - a.addrs.length);
    const over = counts[0];
    const under = counts[counts.length - 1];
    if (over.addrs.length - under.addrs.length <= MAX_COUNT_GAP || over.addrs.length <= 1) break;

    let best = null, bestDist = Infinity;
    over.addrs.forEach(a => {
      const d = haversine(a.lat, a.lng, under.c.start.lat, under.c.start.lng);
      if (d < bestDist){ bestDist = d; best = a; }
    });
    if (!best) break;
    best.courierId = under.c.id;
  }
}

function haversine(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Build coordinate list: start -> stops -> end, ask OSRM /trip for optimized order of stops
const STOP_BUFFER_MIN = 10; // fixed handoff/buffer time added per delivery stop

/**
 * Fetches a full pairwise driving-duration matrix for a list of {lat,lng} points via
 * OSRM Table Service. Returns durations in seconds as a 2D array, or null on failure.
 */
async function fetchDurationMatrix(points){
  const coordStr = points.map(p => `${p.lng},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/table/v1/driving/${coordStr}?annotations=duration`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.durations) return null;
  return data.durations; // durations[i][j] = seconds from point i to point j
}

/**
 * Classic 2-opt local search: repeatedly reverses a segment of the route whenever doing so
 * shortens total travel time, until no further improvement is found. Operates on indices
 * into `points`, where index 0 is the fixed start and the last index is the fixed end —
 * only the order of the middle stops (1..n-2) is ever changed, since the courier's start
 * and end points are not negotiable.
 *
 * This is far better suited to 10-20 stop problems than OSRM Trip's farthest-insertion
 * heuristic, which is documented to only approximate and can produce visually incoherent
 * "backtracking" routes — exactly the zig-zag pattern seen in practice with Trip Service.
 */
function twoOptOptimize(matrix, initialOrder){
  let order = initialOrder.slice();
  const routeLength = (ord) => {
    let total = 0;
    for (let i = 0; i < ord.length - 1; i++) total += matrix[ord[i]][ord[i+1]];
    return total;
  };

  let improved = true;
  let iterations = 0;
  const maxIterations = 200; // safety cap; real loops converge in far fewer passes for ~20 stops
  while (improved && iterations < maxIterations){
    improved = false;
    iterations++;
    // i and j range over the MIDDLE stops only (1..length-2), never touching index 0
    // (fixed start) or the last index (fixed end)
    for (let i = 1; i < order.length - 2; i++){
      for (let j = i + 1; j < order.length - 1; j++){
        const a = order[i-1], b = order[i], c = order[j], d = order[j+1];
        const currentCost = matrix[a][b] + matrix[c][d];
        const swappedCost = matrix[a][c] + matrix[b][d];
        if (swappedCost < currentCost - 0.01){ // small epsilon to avoid float-noise thrashing
          // reverse the segment between i and j
          const segment = order.slice(i, j+1).reverse();
          order = [...order.slice(0, i), ...segment, ...order.slice(j+1)];
          improved = true;
        }
      }
    }
  }
  return order;
}

/**
 * Builds an initial nearest-neighbor tour over the middle stops (indices 1..n-2), starting
 * from the fixed start point (index 0) and always choosing the closest unvisited stop next.
 * This seed is then refined by 2-opt — starting from a reasonable tour converges faster
 * and more reliably than starting from the input order.
 */
function nearestNeighborOrder(matrix, numPoints){
  const middleIndices = [];
  for (let i = 1; i < numPoints - 1; i++) middleIndices.push(i);

  const order = [0];
  const remaining = new Set(middleIndices);
  let current = 0;
  while (remaining.size){
    let best = null, bestDist = Infinity;
    remaining.forEach(idx => {
      if (matrix[current][idx] < bestDist){ bestDist = matrix[current][idx]; best = idx; }
    });
    order.push(best);
    remaining.delete(best);
    current = best;
  }
  order.push(numPoints - 1);
  return order;
}

/**
 * Runs 2-opt from the nearest-neighbor seed AND several randomized starting orders,
 * keeping whichever converges to the shortest total time. A single nearest-neighbor
 * seed can lead 2-opt into a local optimum that skips over a cluster of stops sitting
 * geometrically "on the way" between two others — visible on the map as an unnecessary
 * long round-trip leg to a far stop instead of a route that flows through the stops in
 * between. Trying several independent random starting orders and keeping the best
 * result catches those cases. All restarts reuse the SAME already-fetched duration
 * matrix, so this costs zero extra network calls — only cheap local computation, well
 * under a second for the ~10-30 stop routes this app plans for.
 */
const TWO_OPT_RANDOM_RESTARTS = 40;

function optimizeOrderMultiStart(matrix, numPoints){
  const routeLength = (ord) => {
    let total = 0;
    for (let i = 0; i < ord.length - 1; i++) total += matrix[ord[i]][ord[i+1]];
    return total;
  };

  let bestOrder = twoOptOptimize(matrix, nearestNeighborOrder(matrix, numPoints));
  let bestCost = routeLength(bestOrder);

  const middleIndices = [];
  for (let i = 1; i < numPoints - 1; i++) middleIndices.push(i);

  for (let r = 0; r < TWO_OPT_RANDOM_RESTARTS; r++){
    const shuffled = middleIndices.slice();
    for (let i = shuffled.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const candidateOrder = twoOptOptimize(matrix, [0, ...shuffled, numPoints - 1]);
    const candidateCost = routeLength(candidateOrder);
    if (candidateCost < bestCost){
      bestCost = candidateCost;
      bestOrder = candidateOrder;
    }
  }

  return bestOrder;
}

/**
 * Turns OSRM's own per-leg breakdown (requires &steps=true on the request) into a map from
 * stop id -> that stop's incoming leg geometry ([{lng,lat},...], from wherever the courier
 * was before to this stop). Authoritative — OSRM decides where each leg starts/ends, so
 * there's no need to guess a split point along a single merged line (which is fragile: a
 * stop's nearest point on the full route isn't always where the courier actually turns off
 * to reach it). Legs beyond orderedIds.length (the final stop -> end depot) are dropped —
 * that leg isn't tied to any one customer, so it's not needed for delivery-status coloring.
 * Stored as an object keyed by stop id (not an array of arrays) because Firestore rejects
 * arrays directly containing arrays — see routesForFirestore/routesFromFirestore.
 */
function buildLegGeometries(routeData, orderedIds){
  const legs = {};
  routeData.routes[0].legs.forEach((leg, i) => {
    if (i >= orderedIds.length) return;
    legs[orderedIds[i]] = leg.steps.flatMap(step => step.geometry.coordinates.map(([lng, lat]) => ({ lng, lat })));
  });
  return legs;
}

async function computeOptimizedRoute(courier, stops){
  const end = courier.sameAsStart || courier.end.status !== 'ok' ? courier.start : courier.end;
  const points = [courier.start, ...stops.map(s => ({lat:s.lat,lng:s.lng})), end];

  try {
    // 1. Get the real driving-time matrix between every pair of points
    const matrix = await fetchDurationMatrix(points);
    if (!matrix) throw new Error('Table service returned no data');

    // 2. Find a good visiting order locally: nearest-neighbor seed plus several random
    //    restarts, refined by 2-opt, keeping the shortest result found. Indices 0 and
    //    (points.length-1) stay fixed as start/end throughout.
    const optimizedOrder = optimizeOrderMultiStart(matrix, points.length);

    // optimizedOrder is a list of point-indices; translate the middle ones back to stops
    const orderedIds = optimizedOrder.slice(1, -1).map(idx => stops[idx - 1].id);

    // per-leg duration, in the final optimized order
    const legDurationsMin = [];
    for (let i = 0; i < optimizedOrder.length - 1; i++){
      legDurationsMin.push(matrix[optimizedOrder[i]][optimizedOrder[i+1]] / 60);
    }
    const totalMin = legDurationsMin.reduce((s, m) => s + m, 0);

    // 3. Fetch the real geometry (for drawing on the map) and total distance via Route
    //    Service, using the now-fixed optimized order — Route Service draws the path
    //    through the given points in the given order, it does not reorder them.
    const orderedPoints = optimizedOrder.map(idx => points[idx]);
    const routeCoordStr = orderedPoints.map(p => `${p.lng},${p.lat}`).join(';');
    let geometry = null, legGeometries = null, totalKm = null;
    try {
      const routeUrl = `https://router.project-osrm.org/route/v1/driving/${routeCoordStr}?overview=full&geometries=geojson&steps=true`;
      const routeRes = await fetch(routeUrl);
      const routeData = await routeRes.json();
      if (routeData.code === 'Ok' && routeData.routes && routeData.routes.length){
        geometry = routeData.routes[0].geometry;
        legGeometries = buildLegGeometries(routeData, orderedIds);
        totalKm = routeData.routes[0].distance / 1000;
      }
    } catch (e){
      console.error('OSRM route geometry fetch failed', e);
    }
    if (totalKm == null){
      // Route Service failed but we still have real driving times from the Table Service —
      // approximate distance from time at a typical urban average so the UI never crashes
      // on a null totalKm, and geometry simply stays unavailable (straight-line fallback draw)
      totalKm = totalMin / 60 * 35;
    }

    state.routes[courier.id] = {
      order: orderedIds,
      totalKm,
      totalMin,
      geometry,
      legGeometries,
      legDurationsMin
    };
    computeDeliveryWindows(courier, state.routes[courier.id]);
  } catch (e){
    console.error('Route optimization error', e);
    fallbackRoute(courier, stops, end);
  }
}

/**
 * Refreshes a route's real driving times/geometry/delivery windows for its EXISTING stop
 * order, left completely untouched — used after cancelling a single stop. Unlike
 * computeOptimizedRoute, this never reorders or reassigns anything (no 2-opt, no
 * sectorizing): every other customer's stop stays in the exact position already
 * communicated, only the timing gets corrected so a cancelled delivery doesn't leave a
 * stale (too-long) estimate behind.
 */
async function recomputeRouteFixedOrder(courier, route){
  const stops = route.order.map(id => state.addresses.find(a => a.id === id)).filter(Boolean);
  const end = courier.sameAsStart || courier.end.status !== 'ok' ? courier.start : courier.end;
  const points = [courier.start, ...stops.map(s => ({lat: s.lat, lng: s.lng})), end];

  try {
    const matrix = await fetchDurationMatrix(points);
    if (!matrix) throw new Error('Table service returned no data');

    const legDurationsMin = [];
    for (let i = 0; i < points.length - 1; i++) legDurationsMin.push(matrix[i][i + 1] / 60);
    const totalMin = legDurationsMin.reduce((s, m) => s + m, 0);

    const routeCoordStr = points.map(p => `${p.lng},${p.lat}`).join(';');
    let geometry = null, legGeometries = null, totalKm = null;
    try {
      const routeUrl = `https://router.project-osrm.org/route/v1/driving/${routeCoordStr}?overview=full&geometries=geojson&steps=true`;
      const routeRes = await fetch(routeUrl);
      const routeData = await routeRes.json();
      if (routeData.code === 'Ok' && routeData.routes && routeData.routes.length){
        geometry = routeData.routes[0].geometry;
        legGeometries = buildLegGeometries(routeData, route.order);
        totalKm = routeData.routes[0].distance / 1000;
      }
    } catch (e){
      console.error('OSRM route geometry fetch failed', e);
    }
    if (totalKm == null) totalKm = totalMin / 60 * 35;

    route.totalKm = totalKm;
    route.totalMin = totalMin;
    route.geometry = geometry;
    route.legGeometries = legGeometries;
    route.legDurationsMin = legDurationsMin;
    computeDeliveryWindows(courier, route);
  } catch (e){
    console.error('Recalcul după anulare eșuat, folosesc estimarea aproximativă existentă', e);
    recalcRouteDistance(courier.id);
  }
}

/**
 * If this courier's route was already sent (has a courierRunId), pushes the current route
 * state to their live app in the background — fire-and-forget from the caller's perspective,
 * since this is a follow-up sync after a route edit, not something worth blocking the UI on.
 * Without this, editing a route after "Trimite traseul" was already pressed (cancelling a
 * stop, reassigning one to a different courier) would silently never reach the courier — see
 * ensureCourierRun/resyncCourierRun — until she happened to press "Trimite traseul" again.
 */
function syncRouteToCourierIfSent(courierId){
  const route = state.routes[courierId];
  // Silent on purpose: no route sent yet for this courier, nothing to sync — NOT a diagnostic
  // gap, this is the common/expected case for a route never yet shared.
  if (!route || !route.courierRunId) return;
  const courier = state.couriers.find(c => c.id === courierId);
  if (!courier) return;
  console.log('[sync-curier] pornesc resincronizarea', { courierId, courierRunId: route.courierRunId, order: route.order.slice() });
  ensureCourierRun(courier, route).then(() => {
    console.log('[sync-curier] resincronizare reușită', { courierId, courierRunId: route.courierRunId });
    showToast(`Modificarea a fost trimisă către ${courier.name}.`);
  }).catch(e => {
    console.error('[sync-curier] resincronizare EȘUATĂ', e);
    showToast(`Nu am putut trimite modificarea către ${courier.name} — ${e.message || 'verifică conexiunea'}.`, true);
  });
}

/**
 * Marks an order as cancelled — pulled off the map and out of its courier's route (so the
 * courier no longer drives there), WITHOUT touching the order/sequence of any other stop
 * already communicated to other customers. The address itself is kept (not deleted), just
 * flagged, so it stays visible as a record in the Adrese tab and can be restored if marked
 * by mistake.
 */
async function cancelStop(addrId){
  const addr = state.addresses.find(a => a.id === addrId);
  if (!addr) return;
  if (!confirm(`Sigur vrei să anulezi comanda pentru "${addr.clientName || addr.raw}"? Va fi scoasă din traseu și de pe hartă (dar rămâne vizibilă, marcată anulată, în lista de adrese).`)) return;

  addr.cancelled = true;
  const courierId = addr.courierId;
  const route = state.routes[courierId];

  if (route){
    const idx = route.order.indexOf(addrId);
    if (idx !== -1) route.order.splice(idx, 1);
    const courier = state.couriers.find(c => c.id === courierId);
    if (route.order.length){
      await recomputeRouteFixedOrder(courier, route);
    }
    // Before the route object is possibly deleted below — resyncs even the "removed the last
    // remaining stop" case, so a courier who already has this run open sees it disappear too.
    syncRouteToCourierIfSent(courierId);
    if (!route.order.length) delete state.routes[courierId];
  }

  renderAddresses();
  renderCouriers();
  renderRouteSummary();
  redrawMap();
  updateMapTopBar();
  updateExportButtonsState();
  showToast(`Comandă anulată${route ? ' — traseul rămas a fost actualizat, fără reordonare' : ''}.`);
}

/** Undoes a mistaken cancellation — unassigns the address so it can be added back into a route via "Repartizează automat" or manual reassign. */
function restoreCancelledStop(addrId){
  const addr = state.addresses.find(a => a.id === addrId);
  if (!addr) return;
  addr.cancelled = false;
  addr.courierId = null;
  addr.manuallyAssigned = false;
  renderAddresses();
  renderCouriers();
  redrawMap();
  showToast('Comandă restaurată — nerepartizată, o poți aloca din nou.');
}

function fallbackRoute(courier, stops, end){
  // simple nearest-neighbor ordering, straight-line distances
  const remaining = [...stops];
  const order = [];
  const legDurationsMin = [];
  let current = { lat: courier.start.lat, lng: courier.start.lng };
  let totalKm = 0;
  const AVG_SPEED_KMH = 35; // rough urban average for the straight-line fallback estimate
  while (remaining.length){
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((s, i) => {
      const d = haversine(current.lat, current.lng, s.lat, s.lng);
      if (d < bestDist){ bestDist = d; bestIdx = i; }
    });
    const next = remaining.splice(bestIdx, 1)[0];
    order.push(next.id);
    totalKm += bestDist;
    legDurationsMin.push(bestDist / AVG_SPEED_KMH * 60);
    current = { lat: next.lat, lng: next.lng };
  }
  const lastLegKm = haversine(current.lat, current.lng, end.lat, end.lng);
  totalKm += lastLegKm;
  legDurationsMin.push(lastLegKm / AVG_SPEED_KMH * 60);

  state.routes[courier.id] = {
    order,
    totalKm,
    totalMin: totalKm / AVG_SPEED_KMH * 60,
    geometry: null,
    legDurationsMin
  };
  computeDeliveryWindows(courier, state.routes[courier.id]);
  showToast(`Traseu pentru ${courier.name}: estimare aproximativă (serviciul de rutare a fost indisponibil).`, true);
}

// -------------------------------------------------------------------
// DELIVERY TIME WINDOWS
// -------------------------------------------------------------------

function normalizeTime(str){
  const match = String(str || '').trim().match(/^(\d{1,2})[:.h]?(\d{2})?$/);
  if (!match) return '10:00';
  let h = parseInt(match[1]);
  let m = match[2] ? parseInt(match[2]) : 0;
  h = Math.max(0, Math.min(23, h));
  m = Math.max(0, Math.min(59, m));
  return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`;
}

function parseTimeToMinutes(str){
  const normalized = normalizeTime(str);
  const [h, m] = normalized.split(':').map(Number);
  return h * 60 + m;
}

function formatMinutesToTime(totalMin){
  let m = Math.round(totalMin) % (24 * 60);
  if (m < 0) m += 24 * 60;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h.toString().padStart(2,'0')}:${mm.toString().padStart(2,'0')}`;
}

/**
 * Computes a fixed 2-hour delivery window for each stop in the route.
 * Logic: estimated arrival time = departure + cumulative driving time + (10min buffer × stops already made),
 * then rounded DOWN to the nearest hour, giving a [rounded, rounded+2h] window.
 * e.g. arrival 10:00 -> 10:00–12:00 · arrival 11:30 -> 11:00–13:00 · arrival 11:59 -> 11:00–13:00
 */
function computeDeliveryWindows(courier, route){
  const departureMin = parseTimeToMinutes(courier.departureTime || '10:00');
  const legs = route.legDurationsMin || [];
  const windows = {};

  let cumulativeMin = departureMin;
  route.order.forEach((addrId, idx) => {
    cumulativeMin += (legs[idx] || 0); // driving time to reach this stop
    const arrivalMin = cumulativeMin;
    const roundedHour = Math.floor(arrivalMin / 60) * 60;
    windows[addrId] = {
      arrivalMin,
      windowStart: formatMinutesToTime(roundedHour),
      windowEnd: formatMinutesToTime(roundedHour + 120),
      afterLimit: courier.endTimeLimit ? arrivalMin > parseTimeToMinutes(courier.endTimeLimit) : false
    };
    cumulativeMin += STOP_BUFFER_MIN; // handoff buffer before heading to the next stop
  });

  route.windows = windows;
}

function formatMinutes(min){
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h${m.toString().padStart(2,'0')}` : `${m}min`;
}

// -------------------------------------------------------------------
// ROUTE SUMMARY (sidebar tab) — drag & drop reorder, manual reassign
// -------------------------------------------------------------------
function renderRouteSummary(){
  const container = document.getElementById('routeSummary');
  const hasAny = Object.keys(state.routes).length > 0;

  if (!hasAny){
    container.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">${ICONS.emptyRoute}</div>
        <div class="es-title">Niciun traseu generat</div>
        <div class="es-sub">Adaugă curieri și adrese, apoi repartizează</div>
      </div>`;
    state.routeSelection = new Set();
    if (!applyingRemoteSnapshot) saveRoutesToStorage(); // see the guard note at the end of this function
    return;
  }

  if (!state.routeSelection) state.routeSelection = new Set();
  // drop any selected ids that no longer exist in a route (e.g. after a removal)
  const allRoutedIds = new Set(Object.values(state.routes).flatMap(r => r.order));
  state.routeSelection.forEach(id => { if (!allRoutedIds.has(id)) state.routeSelection.delete(id); });

  container.innerHTML = '';

  renderBulkMoveBar(container);

  state.couriers.forEach(c => {
    const route = state.routes[c.id];
    if (!route) return;

    const assignedAddrs = route.order.map(id => state.addresses.find(a => a.id === id)).filter(Boolean);
    const totalToCollect = assignedAddrs.reduce((sum, a) => sum + (a.amount || 0), 0);
    const cashToCollect = assignedAddrs
      .filter(a => a.paymentMethod === 'Ramburs')
      .reduce((sum, a) => sum + (a.amount || 0), 0);

    const block = document.createElement('div');
    block.style.marginBottom = '18px';
    block.innerHTML = `
      <div style="display:flex; align-items:center; gap:7px; margin-bottom:4px;">
        <span class="courier-dot" style="background:${c.color}"></span>
        <span style="font-weight:600; font-size:13px;">${escapeHtml(c.name)}</span>
        <span style="font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif; font-variant-numeric:tabular-nums; font-size:10.5px; color:var(--ink-soft);">
          ${route.totalKm.toFixed(1)} km · ${formatMinutes(route.totalMin)}
        </span>
        <button class="send-courier-btn" data-send-courier="${c.id}">${ICONS.send} trimite curierului</button>
      </div>
      ${totalToCollect > 0 ? `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif; font-variant-numeric:tabular-nums; font-size:10.5px; color:var(--ink-soft); margin-bottom:8px; padding-left:18px;">
          de încasat total: <strong style="color:var(--ink);">${totalToCollect.toFixed(2)} lei</strong>
          ${cashToCollect > 0 ? ` · ramburs: <strong style="color:var(--warn);">${cashToCollect.toFixed(2)} lei</strong>` : ''}
        </div>` : `<div style="margin-bottom:8px;"></div>`}
      <div class="route-stops" data-courier="${c.id}"></div>
    `;
    container.appendChild(block);

    const stopsDiv = block.querySelector('.route-stops');
    route.order.forEach((addrId, idx) => {
      const addr = state.addresses.find(a => a.id === addrId);
      if (!addr) return;
      const stopEl = document.createElement('div');
      stopEl.className = 'route-stop-item';
      stopEl.dataset.id = addr.id;
      stopEl.dataset.courier = c.id;

      const titleLine = addr.clientName ? escapeHtml(addr.clientName) : escapeHtml(addr.raw);
      const subAddressLine = addr.clientName ? `<div class="addr-sub-addr">${escapeHtml(addr.raw)}</div>` : '';
      const detailsLine = addr.details ? `<div class="addr-sub-addr">${ICONS.building}${escapeHtml(addr.details)}</div>` : '';
      const productsLine = addr.products ? `<div class="addr-sub-addr">${ICONS.apple}${formatProductsWithKg(addr)}</div>` : '';
      const phoneLine = addr.phone ? `<div class="addr-sub-addr">${escapeHtml(addr.phone)}</div>` : '';
      const paymentChip = (addr.amount != null || addr.paymentMethod)
        ? `<div class="addr-payment-chip ${addr.paymentMethod === 'Ramburs' ? 'cod' : ''}">${addr.amount != null ? addr.amount.toFixed(2) + ' lei' : ''}${addr.amount != null && addr.paymentMethod ? ' · ' : ''}${escapeHtml(addr.paymentMethod || '')}</div>`
        : '';
      const win = route.windows ? route.windows[addr.id] : null;
      const windowChip = win
        ? `<div class="addr-window-chip${win.afterLimit ? ' warn' : ''}">${ICONS.clock}${win.windowStart}–${win.windowEnd}${win.afterLimit ? ' · după ora limită' : ''}</div>`
        : '';
      const obsLine = addr.observatii ? `<div class="addr-obs-line">${ICONS.tag}${escapeHtml(addr.observatii)}</div>` : '';
      const clientConfirmedLine = addr.clientConfirmed === true ? `<div class="addr-client-line">✓ Clientul a confirmat: va fi acasă</div>` : '';
      const clientNoteLine = addr.clientNote ? `<div class="addr-client-line">${ICONS.note}Client: „${escapeHtml(addr.clientNote)}”</div>` : '';
      const deliveryBadge = addr.deliveryStatus === 'delivered' ? `<span class="delivery-badge delivered">✓ Livrat</span>`
        : addr.deliveryStatus === 'failed' ? `<span class="delivery-badge failed">✕ Nelivrat</span>`
        : '';
      const isFirst = idx === 0;
      const isLast = idx === route.order.length - 1;
      const isChecked = state.routeSelection.has(addr.id);

      if (addr.deliveryStatus === 'delivered') stopEl.classList.add('addr-delivered');
      else if (addr.deliveryStatus === 'failed') stopEl.classList.add('addr-delivery-failed');

      stopEl.innerHTML = `
        <div class="rs-drag-handle" draggable="true" title="Trage pentru a reordona">⠿</div>
        <input type="checkbox" class="rs-checkbox" data-select="${addr.id}" ${isChecked ? 'checked' : ''}>
        <span class="addr-badge" style="background:${c.color}">${idx + 1}</span>
        <div class="addr-text">
          ${deliveryBadge}
          <div class="addr-main">${titleLine}</div>
          ${windowChip}
          ${subAddressLine}
          ${detailsLine}
          ${productsLine}
          ${phoneLine}
          ${obsLine}
          ${clientConfirmedLine}
          ${clientNoteLine}
          ${paymentChip}
          <div class="rs-row-actions">
            <select class="rs-courier-select" data-id="${addr.id}">
              ${state.couriers.map(co => `<option value="${co.id}" ${co.id === c.id ? 'selected' : ''}>${escapeHtml(co.name)}</option>`).join('')}
            </select>
            <button class="addr-action-link" data-cancel-stop="${addr.id}" style="color:var(--danger); margin-left:8px;" title="Scoate din traseu, fără să reordoneze restul">✕ Anulează comandă</button>
          </div>
        </div>
        <div class="rs-order-buttons">
          <button class="rs-order-btn" data-move-up="${addr.id}" ${isFirst ? 'disabled' : ''} title="Mută mai sus">▲</button>
          <button class="rs-order-btn" data-move-down="${addr.id}" ${isLast ? 'disabled' : ''} title="Mută mai jos">▼</button>
        </div>
      `;
      stopsDiv.appendChild(stopEl);
    });

    enableDragReorder(stopsDiv, c.id);
  });

  wireRouteStopControls(container);

  container.querySelectorAll('[data-send-courier]').forEach(btn => {
    btn.addEventListener('click', () => showSendToCourierModal(parseInt(btn.dataset.sendCourier)));
  });

  // Guarded — see the note on the equivalent line in renderCouriers().
  if (!applyingRemoteSnapshot) saveRoutesToStorage();
}

function renderBulkMoveBar(container){
  const bar = document.createElement('div');
  bar.id = 'bulkMoveBar';
  bar.className = 'bulk-move-bar';
  bar.style.display = state.routeSelection.size ? 'flex' : 'none';
  bar.innerHTML = `
    <span class="bulk-move-count">${state.routeSelection.size} selectate</span>
    <select id="bulkMoveTarget" class="rs-courier-select" style="flex:1;">
      ${state.couriers.map(co => `<option value="${co.id}">${escapeHtml(co.name)}</option>`).join('')}
    </select>
    <button class="btn btn-primary btn-sm" id="bulkMoveBtn">Mută</button>
    <button class="btn-icon" id="bulkMoveClearBtn" title="Anulează selecția">×</button>
  `;
  container.appendChild(bar);
}

function wireRouteStopControls(container){
  // selection checkboxes
  container.querySelectorAll('[data-select]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = parseInt(cb.dataset.select);
      if (cb.checked) state.routeSelection.add(id);
      else state.routeSelection.delete(id);
      renderRouteSummary();
      redrawMap();
    });
  });

  // up/down reorder buttons
  container.querySelectorAll('[data-move-up]').forEach(btn => {
    btn.addEventListener('click', () => moveStopByOffset(parseInt(btn.dataset.moveUp), -1));
  });
  container.querySelectorAll('[data-move-down]').forEach(btn => {
    btn.addEventListener('click', () => moveStopByOffset(parseInt(btn.dataset.moveDown), 1));
  });

  // cancel order — pulls it off the map/route without reordering anything else
  container.querySelectorAll('[data-cancel-stop]').forEach(btn => {
    btn.addEventListener('click', () => cancelStop(parseInt(btn.dataset.cancelStop)));
  });

  // per-row courier reassignment
  container.querySelectorAll('.rs-courier-select').forEach(sel => {
    if (sel.id === 'bulkMoveTarget') return; // handled separately
    sel.addEventListener('change', () => {
      const addrId = parseInt(sel.dataset.id);
      const newCourierId = parseInt(sel.value);
      moveAddressToCourier(addrId, newCourierId);
    });
  });

  // bulk move bar
  const bulkBtn = document.getElementById('bulkMoveBtn');
  if (bulkBtn){
    bulkBtn.addEventListener('click', () => {
      const targetId = parseInt(document.getElementById('bulkMoveTarget').value);
      const ids = Array.from(state.routeSelection);
      ids.forEach(id => moveAddressToCourier(id, targetId, { skipRender: true }));
      state.routeSelection.clear();
      renderAddresses();
      renderCouriers();
      renderRouteSummary();
      redrawMap();
      showToast(`${ids.length} ${ids.length === 1 ? 'adresă mutată' : 'adrese mutate'}.`);
    });
  }
  const clearBtn = document.getElementById('bulkMoveClearBtn');
  if (clearBtn){
    clearBtn.addEventListener('click', () => {
      state.routeSelection.clear();
      renderRouteSummary();
      redrawMap();
    });
  }
}

// -------------------------------------------------------------------
// SEND TO COURIER — the route is written to a Firestore document
// (courierRuns/{runId}), and the courier's phone (curier.html?run=...)
// opens it via a live onSnapshot listener. Delivered/not-delivered
// marks, GPS check-ins and note edits sync back live too (see
// syncCourierRunListeners/applyCourierRunUpdates below) — no more
// manual "send checkins back" link/WhatsApp round trip.
// -------------------------------------------------------------------

/** Base URL of the app itself (strips any hash and index.html), used to build both the courier and tracking links. */
function appBaseUrl(){
  return location.href.split('#')[0].replace(/index\.html?$/i, '').replace(/\/?$/, '/');
}

/**
 * One single, permanent link per client (matched by phone — see resolveClientId), sent every
 * time regardless of how many orders they've placed. tracking.html?c={clientId} shows the
 * current/latest order live (map, ETA, confirm/note) AND the full order history below it on
 * the same page — a client used to get two separate links (live tracking + history) and found
 * that confusing, so now there's exactly one.
 */
function buildClientLink(clientId){
  return `${appBaseUrl()}tracking.html?c=${clientId}`;
}

/**
 * Finds the clients/{clientId} doc matching this phone (normalized the same way messages are
 * — see normalizePhoneForMessages), or reserves a fresh doc ID for a new one. Only reserves —
 * doesn't write — so the actual create/update happens in the SAME batch as the stop it's for
 * (see ensureCourierRun), keeping "new client + first order" atomic instead of two round trips.
 * Requires firestore.rules' `list: if isDispatcher()` on clients/ (a query, not a get-by-id).
 */
async function resolveClientId(phone){
  const normalized = normalizePhoneForMessages(phone);
  if (!normalized) return null;
  const existing = await db.collection('clients').where('phone', '==', normalized).limit(1).get();
  if (!existing.empty) return { id: existing.docs[0].id, phone: normalized, isNew: false };
  return { id: db.collection('clients').doc().id, phone: normalized, isNew: true };
}

/**
 * Stops keyed by address id (a map, not an array) so a single stop's status/check-in/note
 * can be updated in Firestore with a targeted dot-path update, without rewriting the whole
 * document — see updateStopField in curier.js. Coordinates are rounded to 6 decimals
 * (~10cm), since Nominatim returns much more precision than is useful here. winEnd isn't
 * stored — it's always winStart + 2h (see computeDeliveryWindows), so curier.js derives it.
 * stopRefs maps addrId -> a pre-generated stops/{stopId} doc ref (see ensureCourierRun) —
 * each courier-side stop remembers its own public stopId, so a status/check-in update here
 * can find the matching client-facing doc (see functions/index.js syncCourierRunToStops).
 */
function buildCourierRunStops(route, stopRefs){
  const stops = {};
  route.order.forEach((addrId, idx) => {
    const a = state.addresses.find(ad => ad.id === addrId);
    if (!a) return;
    const win = route.windows ? route.windows[addrId] : null;
    stops[addrId] = {
      order: idx + 1,
      name: a.clientName || '',
      phone: a.phone || '',
      addr: a.raw,
      details: a.details || '',
      products: a.products || '',
      productsKg: a.productsKg,
      note: a.customerNote || '',
      amount: a.amount,
      payment: a.paymentMethod || '',
      lat: Math.round(a.lat * 1e6) / 1e6,
      lng: Math.round(a.lng * 1e6) / 1e6,
      winStart: win ? win.windowStart : '',
      observatii: a.observatii || '',
      // Same geometry the dispatcher's own map draws for this leg (see buildLegGeometries) —
      // sent along so the courier's map is pixel-identical, not a separately-fetched,
      // possibly-different OSRM route. null if the route was never fully optimized (straight-line fallback).
      legGeometry: (route.legGeometries && route.legGeometries[addrId])
        ? route.legGeometries[addrId].map(p => ({ lng: Math.round(p.lng * 1e6) / 1e6, lat: Math.round(p.lat * 1e6) / 1e6 }))
        : null,
      status: 'pending',
      checkinLat: null,
      checkinLng: null,
      checkinNote: null,
      checkinAt: null,
      stopId: stopRefs[addrId].id
    };
  });
  return stops;
}

/**
 * Resolves a clients/{id} lookup for every address (in addrIds) that has a phone, sequentially
 * AND memoized per normalized phone within this one call — a fresh client doc is only ever
 * RESERVED (an id generated), not yet written to Firestore until the caller's batch.commit(),
 * so a second resolveClientId() call for the same phone wouldn't see the first one's
 * reservation via its query and would wrongly mint a second client for the same person (two
 * addresses, same phone, one route — e.g. home + workplace). Memoizing by phone here (not just
 * awaiting sequentially) is what actually prevents that. Shared by both a brand new run and
 * resyncCourierRun's newly-added addresses.
 */
async function resolveClientLookups(addrIds){
  const phoneLookupCache = {};
  const lookups = {};
  for (const addrId of addrIds){
    const a = state.addresses.find(ad => ad.id === addrId);
    if (!a || !a.phone) continue;
    const normalized = normalizePhoneForMessages(a.phone);
    if (!normalized) continue;
    if (!phoneLookupCache[normalized]) phoneLookupCache[normalized] = await resolveClientId(a.phone);
    lookups[addrId] = phoneLookupCache[normalized];
  }
  return lookups;
}

/**
 * Creates (once per route) the courierRuns doc AND, alongside it in the same batch, one public
 * stops/{stopId} doc per address — the deliberately narrow client-facing view (see
 * firestore.rules), containing only that one client's own data. If a run already exists for
 * this route, hands off to resyncCourierRun instead of a no-op — a route can legitimately
 * change AFTER it's already been sent (a cancelled stop, a reassignment), and that needs to
 * actually reach the courier, not silently stop being reflected the moment a run first exists.
 */
async function ensureCourierRun(courier, route){
  // Generated once per courier, then kept forever (persisted via saveCouriersToStorage below) —
  // this is what makes curier.html?courier={id} a permanent, install-once link: the SAME id is
  // reused every day, only its courierLinks/{id}.currentRunId pointer changes.
  if (!courier.persistentId) courier.persistentId = db.collection('courierLinks').doc().id;
  const today = new Date().toISOString().slice(0, 10);

  if (route.courierRunId && route.stopIds){
    return resyncCourierRun(courier, route, today);
  }

  const runRef = db.collection('courierRuns').doc();
  const stopRefs = {};
  route.order.forEach(addrId => { stopRefs[addrId] = db.collection('stops').doc(); });
  const stops = buildCourierRunStops(route, stopRefs);
  const clientLookups = await resolveClientLookups(route.order);

  const batch = db.batch();
  batch.set(runRef, {
    courierId: courier.id,
    courierName: courier.name,
    date: today,
    stops,
    lastPos: null,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  route.order.forEach(addrId => {
    const a = state.addresses.find(ad => ad.id === addrId);
    if (!a) return;
    const win = route.windows ? route.windows[addrId] : null;
    batch.set(stopRefs[addrId], {
      runId: runRef.id,
      addressId: addrId,
      courierId: courier.id,
      date: today,
      clientName: a.clientName || '',
      addr: a.raw,
      details: a.details || '',
      products: a.products || '',
      productsKg: a.productsKg,
      amount: a.amount,
      payment: a.paymentMethod || '',
      lat: Math.round(a.lat * 1e6) / 1e6,
      lng: Math.round(a.lng * 1e6) / 1e6,
      winStart: win ? win.windowStart : '',
      status: 'pending',
      stopsAhead: stops[addrId].order - 1,
      courierLat: null,
      courierLng: null,
      courierUpdatedAt: null,
      clientConfirmed: null,
      clientNote: ''
    });
    const lookup = clientLookups[addrId];
    if (lookup){
      const update = {
        phone: lookup.phone,
        stopIds: firebase.firestore.FieldValue.arrayUnion(stopRefs[addrId].id),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (lookup.isNew) update.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      batch.set(db.collection('clients').doc(lookup.id), update, { merge: true });
    }
  });
  batch.set(db.collection('courierLinks').doc(courier.persistentId), {
    courierId: courier.id,
    currentRunId: runRef.id,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await batch.commit();

  route.courierRunId = runRef.id;
  route.stopIds = {};
  route.clientIds = {};
  route.order.forEach(addrId => {
    route.stopIds[addrId] = stopRefs[addrId].id;
    if (clientLookups[addrId]) route.clientIds[addrId] = clientLookups[addrId].id;
  });
  saveRoutesToStorage();
  saveCouriersToStorage(); // persists courier.persistentId if it was just generated above
  syncCourierRunListeners();
  return runRef.id;
}

/**
 * Re-syncs an ALREADY-SENT run with the current route.order via targeted per-field dot-path
 * writes — never a blanket overwrite. Stops that stay in the route keep their live state
 * (status, check-ins, clientConfirmed/clientNote, courier position tracking) completely
 * untouched — only their descriptive fields and sequence number refresh. Stops removed from
 * the route (cancelled, or reassigned to a different courier) get dropped from
 * courierRuns.stops and their public stops/{stopId} doc marked 'cancelled' (kept, not deleted
 * — firestore.rules disallows it anyway — so an already-shared tracking link or history entry
 * still shows what happened, same philosophy as cancelStop keeping the address itself as a
 * record rather than deleting it).
 */
async function resyncCourierRun(courier, route, today){
  const runRef = db.collection('courierRuns').doc(route.courierRunId);
  const existingIds = Object.keys(route.stopIds);
  const currentIds = route.order.map(String);
  const newAddrIds = route.order.filter(addrId => !existingIds.includes(String(addrId)));

  const stopRefs = {};
  route.order.forEach(addrId => {
    const existingId = route.stopIds[addrId];
    stopRefs[addrId] = existingId ? { id: existingId } : db.collection('stops').doc();
  });
  const freshStops = buildCourierRunStops(route, stopRefs);
  const clientLookups = await resolveClientLookups(newAddrIds);

  const batch = db.batch();
  // Only ever touches the top-level "stops" key (via stops.* dot-paths below) — firestore.rules'
  // update rule for courierRuns allows exactly ['stops', 'lastPos'] and nothing else, so
  // courierName/date can't be included here (an earlier version did, which meant the WHOLE
  // batch — including the cancelled-stop deletion — was silently rejected by security rules
  // every time, since Firestore batches are all-or-nothing).
  const runUpdates = {};

  existingIds.filter(addrId => !currentIds.includes(addrId)).forEach(addrId => {
    runUpdates[`stops.${addrId}`] = firebase.firestore.FieldValue.delete();
    batch.update(db.collection('stops').doc(route.stopIds[addrId]), { status: 'cancelled' });
    delete route.stopIds[addrId];
    if (route.clientIds) delete route.clientIds[addrId];
  });

  route.order.forEach(addrId => {
    const fresh = freshStops[addrId];
    if (!fresh) return;
    if (newAddrIds.includes(addrId)){
      runUpdates[`stops.${addrId}`] = fresh;
      batch.set(stopRefs[addrId], {
        runId: route.courierRunId,
        addressId: addrId,
        courierId: courier.id,
        date: today,
        clientName: fresh.name,
        addr: fresh.addr,
        details: fresh.details,
        products: fresh.products,
        productsKg: fresh.productsKg,
        amount: fresh.amount,
        payment: fresh.payment,
        lat: fresh.lat,
        lng: fresh.lng,
        winStart: fresh.winStart,
        status: 'pending',
        stopsAhead: fresh.order - 1,
        courierLat: null,
        courierLng: null,
        courierUpdatedAt: null,
        clientConfirmed: null,
        clientNote: ''
      });
      route.stopIds[addrId] = stopRefs[addrId].id;
      const lookup = clientLookups[addrId];
      if (lookup){
        const update = {
          phone: lookup.phone,
          stopIds: firebase.firestore.FieldValue.arrayUnion(stopRefs[addrId].id),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (lookup.isNew) update.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        batch.set(db.collection('clients').doc(lookup.id), update, { merge: true });
        if (!route.clientIds) route.clientIds = {};
        route.clientIds[addrId] = lookup.id;
      }
    } else {
      // Already existed before this sync — refresh descriptive fields + sequence number only;
      // never status/checkinLat/checkinLng/checkinNote/checkinAt (buildCourierRunStops always
      // seeds those as pending/null, which is only correct for a brand new stop).
      ['order', 'name', 'phone', 'addr', 'details', 'products', 'productsKg', 'note', 'amount', 'payment', 'lat', 'lng', 'winStart', 'observatii', 'legGeometry'].forEach(field => {
        runUpdates[`stops.${addrId}.${field}`] = fresh[field];
      });
    }
  });

  batch.update(runRef, runUpdates);
  await batch.commit();
  saveRoutesToStorage();
  if (Object.keys(clientLookups).length) saveCouriersToStorage();
  return route.courierRunId;
}

/** Returns the courier's daily link (curier.html?run=...), creating the underlying run if needed. */
async function createCourierRun(courier, route){
  await ensureCourierRun(courier, route);
  return `${appBaseUrl()}curier.html?run=${route.courierRunId}`;
}

/** The courier's permanent, install-once link — same URL every day, see ensureCourierRun/courierLinks. */
function buildCourierPersistentLink(persistentId){
  return `${appBaseUrl()}curier.html?courier=${persistentId}`;
}

/** Flags setups where the generated link can't actually be opened from a different phone. */
function courierLinkHostWarning(){
  if (location.protocol === 'file:'){
    return 'Aplicația e deschisă direct dintr-un fișier local — linkul NU va funcționa pe telefonul curierului. Găzduiește aplicația online (ex: GitHub Pages, Netlify) sau pe un server accesibil din rețea.';
  }
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)){
    return 'Aplicația rulează pe "localhost" — linkul funcționează doar dacă curierul e pe ACEEAȘI rețea Wi-Fi și înlocuiește "localhost" cu IP-ul acestui calculator. Pentru acces de oriunde, găzduiește aplicația online.';
  }
  return null;
}

/**
 * Keeps one live Firestore listener per courier that has an active run (route.courierRunId),
 * so delivered/failed marks, GPS check-ins and note edits the courier makes on their phone
 * appear here automatically — replaces the old manual "send checkins back via WhatsApp,
 * dispatcher opens link, reviews, applies" flow entirely.
 */
let courierRunListeners = {};

function syncCourierRunListeners(){
  Object.keys(state.routes).forEach(courierId => {
    const route = state.routes[courierId];
    const runId = route && route.courierRunId;
    const existing = courierRunListeners[courierId];
    if (existing && existing.runId === runId) return;
    if (existing) existing.unsubscribe();
    if (!runId){ delete courierRunListeners[courierId]; return; }
    const unsubscribe = db.collection('courierRuns').doc(runId).onSnapshot(
      (doc) => { if (doc.exists) applyCourierRunUpdates(doc.data()); },
      (err) => console.error('Nu am putut sincroniza check-in-urile curierului', err)
    );
    courierRunListeners[courierId] = { runId, unsubscribe };
  });
  Object.keys(courierRunListeners).forEach(courierId => {
    if (!state.routes[courierId]){
      courierRunListeners[courierId].unsubscribe();
      delete courierRunListeners[courierId];
    }
  });
}

/** Applies a courier's live check-ins/notes/delivery status onto the matching dispatcher-side addresses. */
function applyCourierRunUpdates(runData){
  if (!runData || !runData.stops) return;
  let changed = false;
  Object.entries(runData.stops).forEach(([addrId, stop]) => {
    const addr = state.addresses.find(a => String(a.id) === String(addrId));
    if (!addr) return;
    if (stop.checkinLat != null && stop.checkinLng != null){
      saveVerifiedAddress(addr.raw, stop.checkinLat, stop.checkinLng);
    }
    if (stop.observatii != null && stop.observatii !== addr.observatii){
      addr.observatii = stop.observatii;
      changed = true;
    }
    if (stop.status && stop.status !== addr.deliveryStatus){
      addr.deliveryStatus = stop.status;
      changed = true;
    }
    // Written by the client on their own tracking page (stops/{stopId}), propagated here by
    // functions/index.js syncClientResponseToCourierRun — see the clientConfirmedLine/
    // clientNoteLine rendering in renderAddresses/renderRouteSummary.
    if (stop.clientConfirmed !== undefined && stop.clientConfirmed !== addr.clientConfirmed){
      addr.clientConfirmed = stop.clientConfirmed;
      changed = true;
    }
    if (stop.clientNote != null && stop.clientNote !== addr.clientNote){
      addr.clientNote = stop.clientNote;
      changed = true;
    }
  });
  updateVerifiedDbCounter();
  if (changed){
    renderAddresses();
    renderRouteSummary();
    redrawMap();
  }
}

async function showSendToCourierModal(courierId){
  const courier = state.couriers.find(c => c.id === courierId);
  const route = state.routes[courierId];
  if (!courier || !route){
    showToast('Nu există traseu pentru acest curier.', true);
    return;
  }

  const warning = courierLinkHostWarning();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:340px;">
      <div class="modal-title">Trimite traseul către ${escapeHtml(courier.name)}</div>
      <div class="hint" style="margin-bottom:4px;">Curierul scanează codul sau deschide link-ul pe telefon — vede opririle lui, în ordine, și poate bifa livrat/nelivrat direct acolo. Bifele și check-in-urile apar live și aici, pe ecranul tău.</div>
      ${warning ? `<div class="hint" style="color:var(--danger); margin-top:8px;">⚠ ${warning}</div>` : ''}
      <div class="qr-wrap" id="courierQrWrap"></div>
      <div class="loading-row" id="linkLoadingRow" style="justify-content:center; margin-top:10px;"><span class="spinner sp-dark"></span><span>Se generează linkul…</span></div>
      <div class="link-copy-row" id="linkCopyRow" style="display:none;">
        <input type="text" id="courierLinkInput" readonly value="">
        <button class="btn btn-sm" id="copyCourierLinkBtn">Copiază</button>
      </div>
      <button class="btn btn-accent btn-sm btn-block" id="waCourierLinkBtn" style="margin-top:10px;" disabled>Trimite pe WhatsApp</button>

      <div style="border-top:1px solid var(--line); margin:16px 0 12px;"></div>
      <div class="modal-title" style="font-size:14px;">Link permanent — instalează o singură dată</div>
      <div class="hint" style="margin-bottom:4px;">Curierul deschide acest link O SINGURĂ DATĂ, în Safari (pe iPhone) sau Chrome (pe Android), și îl adaugă pe ecranul principal. De atunci încolo, aplicația instalată arată automat traseul zilei — nu mai trimiți niciun link nou.</div>
      <div class="link-copy-row" id="persistentLinkCopyRow" style="display:none; margin-top:8px;">
        <input type="text" id="persistentLinkInput" readonly value="">
        <button class="btn btn-sm" id="copyPersistentLinkBtn">Copiază</button>
      </div>
      <button class="btn btn-accent btn-sm btn-block" id="waPersistentLinkBtn" style="margin-top:10px;" disabled>Trimite pe WhatsApp</button>

      <button class="btn btn-ghost btn-sm btn-block" id="closeCourierModalBtn" style="margin-top:14px;">Închide</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('closeCourierModalBtn').addEventListener('click', close);

  let link;
  try {
    link = await createCourierRun(courier, route);
  } catch (e){
    console.error('Nu am putut genera link-ul curierului', e);
    if (overlay.isConnected){
      document.getElementById('linkLoadingRow').innerHTML = '<span class="hint" style="color:var(--danger);">Nu am putut genera linkul — verifică conexiunea și încearcă din nou.</span>';
    }
    return;
  }
  if (!overlay.isConnected) return; // modal was closed while the write was in flight

  document.getElementById('linkLoadingRow').style.display = 'none';
  document.getElementById('linkCopyRow').style.display = 'flex';
  document.getElementById('courierLinkInput').value = link;
  const waBtn = document.getElementById('waCourierLinkBtn');
  waBtn.disabled = false;

  const persistentLink = buildCourierPersistentLink(courier.persistentId);
  document.getElementById('persistentLinkCopyRow').style.display = 'flex';
  document.getElementById('persistentLinkInput').value = persistentLink;
  const waPersistentBtn = document.getElementById('waPersistentLinkBtn');
  waPersistentBtn.disabled = false;

  const qrWrap = document.getElementById('courierQrWrap');
  try {
    const qr = qrcode(0, 'L'); // typeNumber 0 = auto-pick smallest version that fits the data
    qr.addData(link);
    qr.make();
    qrWrap.innerHTML = qr.createImgTag(4, 8);
  } catch (e){
    console.error('QR generation failed', e);
    qrWrap.innerHTML = `<div class="hint">Nu am putut genera codul QR — folosește link-ul de mai jos.</div>`;
  }

  document.getElementById('copyPersistentLinkBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(persistentLink);
    } catch (e){
      const input = document.getElementById('persistentLinkInput');
      input.select();
      document.execCommand('copy');
    }
    showToast('Link permanent copiat.');
  });

  waPersistentBtn.addEventListener('click', () => {
    const text = encodeURIComponent(`Link permanent pentru traseele tale (${courier.name}) — deschide-l o singură dată în Safari/Chrome și adaugă-l pe ecranul principal:\n${persistentLink}`);
    window.open(`https://wa.me/?text=${text}`, '_blank');
  });

  document.getElementById('copyCourierLinkBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link);
    } catch (e){
      const input = document.getElementById('courierLinkInput');
      input.select();
      document.execCommand('copy');
    }
    showToast('Link copiat.');
  });

  waBtn.addEventListener('click', () => {
    const text = encodeURIComponent(`Traseul tău de azi (${courier.name}):\n${link}`);
    window.open(`https://wa.me/?text=${text}`, '_blank');
  });
}

/**
 * Moves one address from its current courier's route to another courier's route,
 * appending it at the end of the destination and recomputing distances for both.
 * Mirrors the reassignment logic already used by the dropdown in the Adrese tab.
 */
function moveAddressToCourier(addrId, newCourierId, opts = {}){
  const addr = state.addresses.find(a => a.id === addrId);
  if (!addr) return;
  const oldCourierId = addr.courierId;
  if (newCourierId === oldCourierId) return;

  addr.courierId = newCourierId;
  addr.manuallyAssigned = true;

  [oldCourierId, newCourierId].forEach(cid => {
    if (cid == null) return;
    let route = state.routes[cid];
    if (!route){
      if (cid !== newCourierId) return; // nothing to clean up on the old side if it never had a route
      // destination courier has no active route yet — create a minimal one so the address
      // doesn't silently disappear from the Trasee tab after the move
      route = { order: [], totalKm: 0, totalMin: 0, geometry: null, legDurationsMin: [] };
      state.routes[cid] = route;
    }
    if (cid === oldCourierId){
      const i = route.order.indexOf(addrId);
      if (i !== -1) route.order.splice(i, 1);
    }
    if (cid === newCourierId && !route.order.includes(addrId)){
      route.order.push(addrId);
    }
    if (route.order.length){
      recalcRouteDistance(cid);
    }
    // Before a possibly-now-empty old route gets deleted below — same reasoning as cancelStop:
    // a courier who already has this run open needs to see the stop leave, or arrive, live.
    syncRouteToCourierIfSent(cid);
    if (!route.order.length) delete state.routes[cid];
  });

  if (!opts.skipRender){
    renderAddresses();
    renderCouriers();
    renderRouteSummary();
    redrawMap();
    const targetCourier = state.couriers.find(c => c.id === newCourierId);
    showToast(`Adresă mutată la ${targetCourier ? targetCourier.name : 'curier'}.`);
  }
}

function moveStopByOffset(addrId, offset){
  const courierId = state.addresses.find(a => a.id === addrId)?.courierId;
  const route = state.routes[courierId];
  if (!route) return;
  const idx = route.order.indexOf(addrId);
  const newIdx = idx + offset;
  if (idx === -1 || newIdx < 0 || newIdx >= route.order.length) return;
  [route.order[idx], route.order[newIdx]] = [route.order[newIdx], route.order[idx]];
  recalcRouteDistance(courierId);
  renderRouteSummary();
  redrawMap();
}

function enableDragReorder(container, courierId){
  let draggedId = null;
  container.querySelectorAll('.route-stop-item').forEach(item => {
    const handle = item.querySelector('.rs-drag-handle');
    if (!handle) return;

    handle.addEventListener('dragstart', e => {
      draggedId = parseInt(item.dataset.id);
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    handle.addEventListener('dragend', () => item.classList.remove('dragging'));

    item.addEventListener('dragover', e => {
      e.preventDefault();
      if (parseInt(item.dataset.id) !== draggedId) item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const targetId = parseInt(item.dataset.id);
      if (draggedId === targetId) return;
      reorderStop(courierId, draggedId, targetId);
    });
  });
}

function reorderStop(courierId, draggedId, targetId){
  const route = state.routes[courierId];
  if (!route) return;
  const fromIdx = route.order.indexOf(draggedId);
  const toIdx = route.order.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  route.order.splice(fromIdx, 1);
  route.order.splice(toIdx, 0, draggedId);
  recalcRouteDistance(courierId);
  renderRouteSummary();
  redrawMap();
}

function recalcRouteDistance(courierId){
  // recompute straight-line distance as an approximation after manual reorder
  const courier = state.couriers.find(c => c.id === courierId);
  const route = state.routes[courierId];
  if (!courier || !route) return;
  const end = courier.sameAsStart || courier.end.status !== 'ok' ? courier.start : courier.end;
  const AVG_SPEED_KMH = 35;
  let total = 0;
  const legDurationsMin = [];
  let current = { lat: courier.start.lat, lng: courier.start.lng };
  route.order.forEach(id => {
    const addr = state.addresses.find(a => a.id === id);
    const legKm = haversine(current.lat, current.lng, addr.lat, addr.lng);
    total += legKm;
    legDurationsMin.push(legKm / AVG_SPEED_KMH * 60);
    current = { lat: addr.lat, lng: addr.lng };
  });
  const lastLegKm = haversine(current.lat, current.lng, end.lat, end.lng);
  total += lastLegKm;
  legDurationsMin.push(lastLegKm / AVG_SPEED_KMH * 60);

  route.totalKm = total;
  route.totalMin = total / AVG_SPEED_KMH * 60;
  route.geometry = null; // straight-line fallback until re-optimized
  route.legGeometries = null;
  route.legDurationsMin = legDurationsMin;
  computeDeliveryWindows(courier, route);
}

// -------------------------------------------------------------------
// MAP RENDERING
// -------------------------------------------------------------------
function buildStopPopup(stopNumber, courierName, addr, win){
  const title = stopNumber ? `Stop ${stopNumber} — ${escapeHtml(courierName)}` : escapeHtml(courierName);
  const nameLine = addr.clientName ? `<div class="sp-name">${escapeHtml(addr.clientName)}</div>` : '';
  const outOfAreaLine = addr.outOfArea ? `<div class="sp-window warn">⚠ în afara zonei București/Ilfov${addr.allowOutOfArea ? ' (permis manual)' : ''}</div>` : '';
  const windowLine = win
    ? `<div class="sp-window${win.afterLimit ? ' warn' : ''}">${ICONS.clock}${win.windowStart}–${win.windowEnd}${win.afterLimit ? ' · după ora limită' : ''}</div>`
    : '';
  const detailsLine = addr.details ? `<div class="sp-meta">${ICONS.building}${escapeHtml(addr.details)}</div>` : '';
  const productsLine = addr.products ? `<div class="sp-meta">${ICONS.apple}${formatProductsWithKg(addr)}</div>` : '';
  const phoneLine = addr.phone ? `<div class="sp-meta">${ICONS.phone}${escapeHtml(addr.phone)}</div>` : '';
  const obsLine = addr.observatii ? `<div class="addr-obs-line">${ICONS.tag}${escapeHtml(addr.observatii)}</div>` : '';
  const paymentLine = (addr.amount != null || addr.paymentMethod)
    ? `<div class="sp-payment">${addr.amount != null ? addr.amount.toFixed(2) + ' lei' : ''}${addr.amount != null && addr.paymentMethod ? ' · ' : ''}${escapeHtml(addr.paymentMethod || '')}</div>`
    : '';
  return `<div class="stop-popup">
    <div class="sp-title">${title}</div>
    ${nameLine}
    ${outOfAreaLine}
    ${windowLine}
    <div class="sp-meta">${escapeHtml(addr.raw)}</div>
    ${detailsLine}
    ${productsLine}
    ${phoneLine}
    ${obsLine}
    ${paymentLine}
  </div>`;
}

function makeDotIcon(color, addr){
  const isLowConfidence = !addr.manuallyAdjusted && addr.confidence && addr.confidence !== 'high' && addr.confidence !== 'verified';
  const ringColor = isLowConfidence ? 'var(--danger)' : '#fff';
  const ringWidth = isLowConfidence ? 3 : 2;
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:${ringWidth}px solid ${ringColor};box-shadow:0 1px 3px rgba(0,0,0,0.3);"></div>`,
    iconSize: [14,14],
    iconAnchor: [7,7]
  });
}

function onAddressMarkerDragged(addrId, newLatLng){
  const addr = state.addresses.find(a => a.id === addrId);
  if (!addr) return;
  addr.lat = newLatLng.lat;
  addr.lng = newLatLng.lng;
  addr.manuallyAdjusted = true;
  addr.confidence = 'high'; // manual placement is by definition the most trustworthy
  addr.outOfArea = !isWithinServiceArea(newLatLng.lat, newLatLng.lng);

  // save to the persistent verified-address database for future imports of this exact
  // address text — but only if the corrected position is actually within the service area
  if (!addr.outOfArea && addr.raw){
    saveVerifiedAddress(addr.raw, newLatLng.lat, newLatLng.lng);
  }

  // any route containing this address now has a stale leg/geometry — recompute distances
  Object.keys(state.routes).forEach(courierId => {
    const route = state.routes[parseInt(courierId)];
    if (route && route.order.includes(addrId)){
      recalcRouteDistance(parseInt(courierId));
    }
  });

  renderAddresses();
  renderCouriers();
  renderRouteSummary();
  redrawMap();
  if (addr.outOfArea){
    showToast('Atenție: poziția trasă este în afara zonei București/Ilfov.', true);
  } else {
    showToast('Poziție actualizată manual și salvată în baza de adrese verificate.');
  }
}

function focusAddressOnMap(addrId){
  const addr = state.addresses.find(a => a.id === addrId);
  if (!addr || addr.lat == null) return;
  map.setView([addr.lat, addr.lng], 17, { animate: true });
  // small delay to let markers redraw/move before opening the popup
  setTimeout(() => {
    markersLayer.eachLayer(layer => {
      const ll = layer.getLatLng ? layer.getLatLng() : null;
      if (ll && Math.abs(ll.lat - addr.lat) < 1e-9 && Math.abs(ll.lng - addr.lng) < 1e-9){
        layer.openPopup();
      }
    });
  }, 350);
}

function redrawMap(){
  markersLayer.clearLayers();
  routeLinesLayer.clearLayers();

  const legend = document.getElementById('mapLegend');
  let legendHtml = '';
  const allPoints = [];

  state.couriers.forEach(c => {
    const route = state.routes[c.id];

    // start marker
    if (c.start.status === 'ok'){
      const m = L.circleMarker([c.start.lat, c.start.lng], {
        radius: 8, color: '#fff', weight: 2, fillColor: c.color, fillOpacity: 1
      }).addTo(markersLayer);
      m.bindPopup(`<div class="stop-popup"><div class="sp-title">${escapeHtml(c.name)} — start</div><div class="sp-meta">${escapeHtml(c.start.address)}</div></div>`);
      allPoints.push([c.start.lat, c.start.lng]);
    }

    // end marker (if different)
    if (!c.sameAsStart && c.end.status === 'ok'){
      const m = L.circleMarker([c.end.lat, c.end.lng], {
        radius: 8, color: c.color, weight: 2, fillColor: '#fff', fillOpacity: 1
      }).addTo(markersLayer);
      m.bindPopup(`<div class="stop-popup"><div class="sp-title">${escapeHtml(c.name)} — final</div><div class="sp-meta">${escapeHtml(c.end.address)}</div></div>`);
      allPoints.push([c.end.lat, c.end.lng]);
    }

    if (route){
      // numbered stop markers — colored by delivery status once the courier has acted on
      // a stop (see applyCourierRunUpdates), courier's own color while still pending
      const stopsInOrder = route.order.map(id => state.addresses.find(a => a.id === id)).filter(Boolean);
      route.order.forEach((addrId, idx) => {
        const addr = state.addresses.find(a => a.id === addrId);
        if (!addr) return;
        const isLowConfidence = !addr.manuallyAdjusted && addr.confidence && addr.confidence !== 'high' && addr.confidence !== 'verified';
        const ringColor = isLowConfidence ? 'var(--danger)' : '#fff';
        const ringWidth = isLowConfidence ? 3 : 2;
        const fillColor = addr.deliveryStatus === 'delivered' ? 'var(--delivered)'
          : addr.deliveryStatus === 'failed' ? 'var(--danger)'
          : c.color;
        const icon = L.divIcon({
          className: '',
          html: `<div style="background:${fillColor};color:#fff;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif; font-variant-numeric:tabular-nums;font-size:11px;font-weight:600;border:${ringWidth}px solid ${ringColor};box-shadow:0 1px 4px rgba(0,0,0,0.25);">${idx+1}</div>`,
          iconSize: [22,22],
          iconAnchor: [11,11]
        });
        const m = L.marker([addr.lat, addr.lng], { icon, draggable: true }).addTo(markersLayer);
        const win = route.windows ? route.windows[addr.id] : null;
        m.bindPopup(buildStopPopup(idx+1, c.name, addr, win));
        m.on('dragend', e => onAddressMarkerDragged(addr.id, e.target.getLatLng()));
        allPoints.push([addr.lat, addr.lng]);
      });

      // route line — one leg per stop (OSRM's own leg breakdown, see buildLegGeometries),
      // each colored by that stop's delivery status, so the route visually "greens up" as
      // the courier delivers along the way
      if (route.legGeometries){
        stopsInOrder.forEach(addr => {
          const legCoords = route.legGeometries[addr.id];
          if (!legCoords) return;
          const legColor = addr.deliveryStatus === 'delivered' ? 'var(--delivered)'
            : addr.deliveryStatus === 'failed' ? 'var(--danger)'
            : c.color;
          const latlngs = legCoords.map(({ lng, lat }) => [lat, lng]);
          L.polyline(latlngs, { color: legColor, weight: 3.5, opacity: 0.85 }).addTo(routeLinesLayer);
        });
      } else if (route.geometry){
        // legGeometries unavailable (e.g. route saved before this feature existed) —
        // fall back to the single flat-colored line
        const latlngs = route.geometry.coordinates.map(([lng,lat]) => [lat,lng]);
        L.polyline(latlngs, { color: c.color, weight: 3.5, opacity: 0.85 }).addTo(routeLinesLayer);
      } else {
        // straight-line fallback
        const end = c.sameAsStart || c.end.status !== 'ok' ? c.start : c.end;
        let prev = c.start;
        stopsInOrder.forEach(addr => {
          const legColor = addr.deliveryStatus === 'delivered' ? 'var(--delivered)'
            : addr.deliveryStatus === 'failed' ? 'var(--danger)'
            : c.color;
          L.polyline([[prev.lat, prev.lng], [addr.lat, addr.lng]], { color: legColor, weight: 3, opacity: 0.6, dashArray: '6,6' }).addTo(routeLinesLayer);
          prev = addr;
        });
        L.polyline([[prev.lat, prev.lng], [end.lat, end.lng]], { color: c.color, weight: 3, opacity: 0.6, dashArray: '6,6' }).addTo(routeLinesLayer);
      }

      legendHtml += `<div class="lg-row"><span class="lg-dot" style="background:${c.color}"></span><span class="lg-name">${escapeHtml(c.name)}</span><span class="lg-dist">${route.totalKm.toFixed(1)} km</span></div>`;
    } else {
      // un-routed geocoded addresses assigned to this courier
      state.addresses.filter(a => a.courierId === c.id && a.status === 'ok' && !a.cancelled).forEach(addr => {
        const m = L.marker([addr.lat, addr.lng], { icon: makeDotIcon(c.color, addr), draggable: true }).addTo(markersLayer);
        m.bindPopup(buildStopPopup(null, c.name, addr));
        m.on('dragend', e => onAddressMarkerDragged(addr.id, e.target.getLatLng()));
        allPoints.push([addr.lat, addr.lng]);
      });
    }
  });

  // unassigned geocoded addresses
  state.addresses.filter(a => !a.courierId && a.status === 'ok' && !a.cancelled).forEach(addr => {
    const m = L.marker([addr.lat, addr.lng], { icon: makeDotIcon('#999', addr), draggable: true }).addTo(markersLayer);
    m.bindPopup(buildStopPopup(null, 'Nerepartizat', addr));
    m.on('dragend', e => onAddressMarkerDragged(addr.id, e.target.getLatLng()));
    allPoints.push([addr.lat, addr.lng]);
  });

  if (legendHtml){
    legend.style.display = 'block';
    legend.innerHTML = legendHtml;
  } else {
    legend.style.display = 'none';
  }

  updateMapTopBar();
}

function fitMapToAll(){
  const pts = [];
  state.couriers.forEach(c => {
    if (c.start.status === 'ok') pts.push([c.start.lat, c.start.lng]);
    if (!c.sameAsStart && c.end.status === 'ok') pts.push([c.end.lat, c.end.lng]);
  });
  state.addresses.forEach(a => { if (a.status === 'ok') pts.push([a.lat, a.lng]); });
  if (pts.length){
    map.fitBounds(L.latLngBounds(pts), { padding: [40,40], maxZoom: 14 });
  }
}

// -------------------------------------------------------------------
// ACTION BAR — reset / export
// -------------------------------------------------------------------
/**
 * Manual backup/restore, on top of the automatic localStorage persistence — a file the
 * dispatcher controls directly, so work survives even clearing browser data, switching
 * computers, or just wanting an explicit checkpoint before doing something risky. Saves
 * the full working state (not the flattened Excel export), so loading it back needs no
 * re-geocoding or re-routing — routes, positions and manual assignments come back exactly
 * as they were.
 */
function saveStateToFile(){
  const snapshot = {
    savedAt: new Date().toISOString(),
    couriers: state.couriers,
    nextCourierId: state.nextCourierId,
    addresses: state.addresses,
    nextAddrId: state.nextAddrId,
    routes: state.routes
  };
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trasee_curieri_stare_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Starea a fost salvată într-un fișier.');
}

function loadStateFromFile(file){
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || !Array.isArray(data.couriers) || !Array.isArray(data.addresses)){
        showToast('Fișierul nu conține o stare validă.', true);
        return;
      }
      if (!confirm('Sigur vrei să încarci această stare? Se va suprascrie tot ce ai acum (curieri, adrese, trasee).')) return;

      state.couriers = data.couriers;
      state.nextCourierId = data.nextCourierId || (data.couriers.length ? Math.max(...data.couriers.map(c => c.id)) + 1 : 1);
      state.addresses = data.addresses;
      state.nextAddrId = data.nextAddrId || (data.addresses.length ? Math.max(...data.addresses.map(a => a.id)) + 1 : 1);
      state.routes = (data.routes && typeof data.routes === 'object' && !Array.isArray(data.routes)) ? data.routes : {};
      state.routeSelection.clear();

      saveCouriersToStorage();
      saveAddressesToStorage();
      saveRoutesToStorage();

      renderCouriers();
      renderAddresses();
      renderRouteSummary();
      maybeShowGeocodeButton();
      updateExportButtonsState();
      redrawMap();
      fitMapToAll();
      showToast(`Stare încărcată${data.savedAt ? ' (salvată ' + new Date(data.savedAt).toLocaleString('ro-RO') + ')' : ''}.`);
    } catch (err){
      console.error('Nu am putut citi fișierul de stare', err);
      showToast('Fișierul nu poate fi citit — verifică dacă e fișierul corect.', true);
    }
  };
  reader.readAsText(file);
}

function initActionBar(){
  document.getElementById('saveStateBtn').addEventListener('click', saveStateToFile);
  document.getElementById('loadStateBtn').addEventListener('click', () => {
    document.getElementById('loadStateInput').click();
  });
  document.getElementById('loadStateInput').addEventListener('change', (e) => {
    if (e.target.files.length) loadStateFromFile(e.target.files[0]);
    e.target.value = '';
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Sigur vrei să resetezi tot? Se vor șterge curierii salvați, adresele și traseele.')) return;
    state.couriers = [];
    state.addresses = [];
    state.routes = {};
    state.nextCourierId = 1;
    state.nextAddrId = 1;
    state.routeSelection.clear();
    addCourier();
    saveCouriersToStorage();
    saveAddressesToStorage();
    saveRoutesToStorage();
    renderAddresses();
    renderRouteSummary();
    redrawMap();
    updateExportButtonsState();
    document.getElementById('geocodeSection').style.display = 'none';
    map.setView([45.9432, 24.9668], 7);
    switchToTab('panel-curieri');
  });

  document.getElementById('resetCouriersBtn').addEventListener('click', () => {
    if (!confirm('Sigur vrei să ștergi toți curierii salvați? Adresele deja alocate vor rămâne nerepartizate, iar traseele calculate se vor șterge.')) return;
    state.couriers = [];
    state.nextCourierId = 1;
    state.addresses.forEach(a => { a.courierId = null; a.manuallyAssigned = false; });
    state.routes = {};
    state.routeSelection.clear();
    addCourier();
    saveCouriersToStorage();
    saveAddressesToStorage(); // courierId/manuallyAssigned changed on every address above
    saveRoutesToStorage();
    renderAddresses();
    renderRouteSummary();
    redrawMap();
    updateExportButtonsState();
    showToast('Curierii au fost resetați.');
  });

  document.getElementById('resetAddressesBtn').addEventListener('click', () => {
    if (!confirm('Sigur vrei să ștergi toate adresele importate? Traseele calculate se vor șterge.')) return;
    state.addresses = [];
    state.nextAddrId = 1;
    state.routes = {};
    state.routeSelection.clear();
    saveAddressesToStorage();
    saveRoutesToStorage();
    renderAddresses();
    renderCouriers();
    renderRouteSummary();
    redrawMap();
    updateExportButtonsState();
    document.getElementById('geocodeSection').style.display = 'none';
    showToast('Adresele au fost resetate.');
  });

  document.getElementById('resetRoutesBtn').addEventListener('click', () => {
    if (!Object.keys(state.routes).length){
      showToast('Nu există trasee de resetat.');
      return;
    }
    if (!confirm('Sigur vrei să ștergi traseele calculate? Adresele rămân, dar vor trebui repartizate din nou.')) return;
    state.routes = {};
    state.routeSelection.clear();
    state.addresses.forEach(a => { a.courierId = null; a.manuallyAssigned = false; });
    saveAddressesToStorage(); // courierId/manuallyAssigned changed on every address above
    saveRoutesToStorage();
    renderAddresses();
    renderCouriers();
    renderRouteSummary();
    redrawMap();
    updateExportButtonsState();
    showToast('Traseele au fost resetate.');
  });

  document.getElementById('exportBtn').addEventListener('click', exportRoutesXlsx);
  document.getElementById('generateMessagesBtn').addEventListener('click', showGenerateMessagesModal);
}

function updateExportButtonsState(){
  const hasRoutes = Object.keys(state.routes).length > 0;
  document.getElementById('exportBtn').disabled = !hasRoutes;
  document.getElementById('generateMessagesBtn').disabled = !hasRoutes;
}

function splitClientName(fullName){
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  // last word = last name, everything before = first name (handles compound first names like "Constantin Dan")
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

function toTitleCase(word){
  if (!word) return '';
  return word.charAt(0).toLocaleUpperCase('ro-RO') + word.slice(1).toLocaleLowerCase('ro-RO');
}

/**
 * Best-effort given name for a personalized greeting ("Bună Mariana,"). Customers don't always
 * split first/last name correctly at checkout (full name crammed into one field, all caps, etc.),
 * so this is a guess, not a guarantee — that's why showGenerateMessagesModal() always lets the
 * dispatcher review and correct it before anything is actually sent.
 */
function getGreetingFirstName(addr){
  if (addr.greetingNameOverride) return addr.greetingNameOverride;
  const source = addr.firstName || splitClientName(addr.clientName).firstName;
  const firstWord = String(source || '').trim().split(/\s+/)[0] || '';
  return toTitleCase(firstWord);
}

/** Romanian mobile numbers are usually typed as 07xxxxxxxx — Messages.app on Mac matches phone-number
 *  buddies most reliably in full international format, so normalize to +40 when the shape is recognizable.
 *  Also covers numbers imported from Excel where the phone cell was stored as a number rather than text:
 *  SheetJS then drops the leading 0 (0722598835 -> 722598835), so a bare 9-digit number starting with 7
 *  is treated the same as if the 0 were still there. */
function normalizePhoneForMessages(phone){
  const digits = String(phone || '').replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) return digits;
  if (/^0\d{9}$/.test(digits)) return `+40${digits.slice(1)}`;
  if (/^7\d{8}$/.test(digits)) return `+40${digits}`;
  if (/^40\d{9}$/.test(digits)) return `+${digits}`;
  if (/^0040\d{9}$/.test(digits)) return `+40${digits.slice(4)}`;
  return digits;
}

function formatWindowForMessage(win){
  if (!win) return '';
  return `${win.windowStart.replace(':', '.')} - ${win.windowEnd.replace(':', '.')}`;
}

function buildDeliveryMessage(name, dayPhrase, windowText, clientLink){
  const greeting = name ? `Buna ${name},` : 'Buna,';
  const linkLine = clientLink ? `\n\n📍 Click aici sa confirmi, sa urmaresti livrarea in timp real si sa vezi istoricul comenzilor:\n${clientLink}` : '';
  return `${greeting}\n\nIti multumim pentru comanda de fructe! \n\nComanda va ajunge ${dayPhrase}, in intervalul: ${windowText}.${linkLine}\n\n🍒Te rugam sa ne confirmi disponibilitatea pentru livrare in intervalul mentionat. \n\nO zi minunata,\nCraita Merelor - cu traditie din Voinesti!`;
}

/** All non-cancelled stops that are part of a generated route and have a computed delivery window. */
function getMessageableStops(){
  const stops = [];
  state.couriers.forEach(c => {
    const route = state.routes[c.id];
    if (!route) return;
    route.order.forEach(addrId => {
      const addr = state.addresses.find(a => a.id === addrId);
      if (!addr || addr.cancelled) return;
      const win = route.windows ? route.windows[addr.id] : null;
      if (!win || !addr.phone) return;
      stops.push({ addr, win, courier: c, route });
    });
  });
  return stops;
}

async function showGenerateMessagesModal(){
  const stops = getMessageableStops();
  if (!stops.length){
    showToast('Niciun client cu telefon și interval de livrare calculat — generează întâi traseele.', true);
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:540px;">
      <div class="modal-title">Mesaje pentru clienți</div>
      <div class="hint" style="margin-bottom:10px;">Verifică prenumele detectat pentru fiecare client — clienții nu completează mereu corect câmpurile de nume la comandă. Corectează direct în casetă dacă e greșit, apoi descarcă fișierul pentru trimitere automată prin Messages.</div>
      <div class="field" style="margin-bottom:10px; max-width:160px;">
        <label>Ziua livrării</label>
        <input type="text" id="gmDayPhrase" value="mâine">
      </div>
      <div id="gmRows" style="max-height:42vh; overflow-y:auto; display:flex; flex-direction:column; gap:10px;">
        <div class="loading-row" id="gmLoadingRow" style="justify-content:center;"><span class="spinner sp-dark"></span><span>Se pregătesc linkurile de urmărire…</span></div>
      </div>
      <div style="display:flex; gap:6px; margin-top:14px;">
        <button class="btn btn-ghost btn-sm" id="gmCancelBtn" style="flex:1;">Anulează</button>
        <button class="btn btn-primary btn-sm" id="gmDownloadBtn" style="flex:1;" disabled>Descarcă fișierul (${stops.length})</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#gmCancelBtn').addEventListener('click', close);

  // Every stop needs its own tracking link, which needs a stops/{stopId} doc to exist — reuse the
  // run/stops already created if "Trimite traseul" ran first, otherwise create them silently here
  // (ensureCourierRun is idempotent per route, so whichever action runs first "wins").
  const couriersInvolved = [...new Set(stops.map(s => s.courier))];
  try {
    await Promise.all(couriersInvolved.map(c => ensureCourierRun(c, state.routes[c.id])));
  } catch (e){
    console.error('Nu am putut pregăti linkurile de urmărire', e);
    if (overlay.isConnected){
      overlay.querySelector('#gmRows').innerHTML = '<div class="hint" style="color:var(--danger);">Nu am putut genera linkurile de urmărire pentru clienți — verifică conexiunea și încearcă din nou.</div>';
    }
    return;
  }
  if (!overlay.isConnected) return; // modal was closed while the writes were in flight

  const rowsEl = overlay.querySelector('#gmRows');
  rowsEl.innerHTML = '';
  const dayInput = overlay.querySelector('#gmDayPhrase');
  overlay.querySelector('#gmDownloadBtn').disabled = false;

  function renderRow(stop){
    const { addr, win, route } = stop;
    const windowText = formatWindowForMessage(win);
    const clientLink = route.clientIds && route.clientIds[addr.id] ? buildClientLink(route.clientIds[addr.id]) : '';
    const row = document.createElement('div');
    row.className = 'gm-row';
    row.innerHTML = `
      <div class="gm-fullname">${escapeHtml(addr.clientName || addr.raw)}</div>
      <div class="gm-row-top">
        <input type="text" class="gm-name-input" data-id="${addr.id}" value="${escapeHtml(getGreetingFirstName(addr))}" placeholder="prenume">
        <span class="gm-phone">${escapeHtml(addr.phone)}</span>
      </div>
      <div class="gm-window">${ICONS.clock}${escapeHtml(windowText)}</div>
      <div class="gm-preview" id="gmPreview-${addr.id}"></div>
    `;
    const preview = row.querySelector('.gm-preview');
    const updatePreview = () => {
      preview.textContent = buildDeliveryMessage(getGreetingFirstName(addr), dayInput.value.trim(), windowText, clientLink);
    };
    row.querySelector('.gm-name-input').addEventListener('input', (e) => {
      addr.greetingNameOverride = e.target.value.trim();
      updatePreview();
    });
    updatePreview();
    rowsEl.appendChild(row);
    return updatePreview;
  }

  const updaters = stops.map(renderRow);
  dayInput.addEventListener('input', () => updaters.forEach(fn => fn()));

  overlay.querySelector('#gmDownloadBtn').addEventListener('click', () => {
    saveAddressesToStorage(); // persist any greeting-name corrections made in this review pass
    const dayPhrase = dayInput.value.trim();
    const payload = stops.map(({ addr, win, route }) => ({
      phone: normalizePhoneForMessages(addr.phone),
      message: buildDeliveryMessage(
        getGreetingFirstName(addr), dayPhrase, formatWindowForMessage(win),
        route.clientIds && route.clientIds[addr.id] ? buildClientLink(route.clientIds[addr.id]) : ''
      )
    }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mesaje_clienti_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    close();
    showToast(`Fișier cu ${payload.length} mesaje descărcat.`);
  });
}

function exportRoutesXlsx(){
  const header = ['Curier', 'Interval Livrare', 'Nr. Comanda', 'First Name (Shipping)', 'Last Name (Shipping)', 'Phone (Billing)', 'Adresa', 'Detalii', 'Produse', 'Total Kg', 'Payment Method Title', 'Order Total Amount', 'Customer Note', 'Observatii'];
  const rows = [header];
  let fallbackOrderNo = 1;

  state.couriers.forEach(c => {
    const route = state.routes[c.id];
    if (!route) return;
    route.order.forEach(id => {
      const addr = state.addresses.find(a => a.id === id);
      if (!addr) return;
      const { firstName, lastName } = splitClientName(addr.clientName);
      const win = route.windows ? route.windows[addr.id] : null;
      const interval = win ? `${win.windowStart} - ${win.windowEnd}` : '';
      // use the real WooCommerce order number when available; only fall back to a
      // sequential counter for addresses that have none (e.g. added manually)
      const orderNo = addr.orderNumber || fallbackOrderNo++;
      rows.push([
        c.name, interval, orderNo,
        firstName, lastName, addr.phone || '',
        addr.raw, addr.details || '', addr.products || '', addr.productsKg != null ? addr.productsKg : '',
        addr.paymentMethod || '', addr.amount != null ? addr.amount : '',
        addr.customerNote || '', addr.observatii || ''
      ]);
    });
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    {wch:12},{wch:14},{wch:11},{wch:18},{wch:16},{wch:14},
    {wch:38},{wch:30},{wch:30},{wch:10},{wch:16},{wch:14},{wch:30},{wch:30}
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Trasee');
  XLSX.writeFile(wb, `trasee_curieri_${new Date().toISOString().slice(0,10)}.xlsx`);
}

// -------------------------------------------------------------------
// UTILS
// -------------------------------------------------------------------
function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/** "2x Mere, 4x Cireșe" + productsKg -> "2x Mere, 4x Cireșe · Total: 6 kg" (escaped, ready for innerHTML). */
function formatProductsWithKg(addr){
  if (!addr.products) return '';
  const kgSuffix = addr.productsKg != null ? ` · Total: ${formatKg(addr.productsKg)}` : '';
  return `${escapeHtml(addr.products)}${kgSuffix}`;
}

function formatKg(kg){
  const rounded = Math.round(kg * 100) / 100;
  return `${rounded % 1 === 0 ? rounded : rounded.toFixed(2)} kg`;
}
