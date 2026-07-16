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
const STOP_FIELDS = ['id', 'o', 'name', 'phone', 'addr', 'details', 'note', 'amount', 'payment', 'lat', 'lng', 'winStart'];

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

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function mapsUrl(lat, lng){
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}
function wazeUrl(lat, lng){
  return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}

let payload = null;
let statuses = {};

function render(){
  const root = document.getElementById('root');

  if (!payload || !Array.isArray(payload.stops)){
    root.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">⚠</div>
        <div class="es-title">Link invalid sau incomplet</div>
        <div class="es-sub">Acest link nu conține un traseu valid. Cere dispecerului un link nou.</div>
      </div>`;
    return;
  }

  const total = payload.stops.length;
  const delivered = payload.stops.filter(s => statuses[s.id] === 'delivered').length;
  const failed = payload.stops.filter(s => statuses[s.id] === 'failed').length;
  const remaining = total - delivered - failed;
  const pct = total ? Math.round((delivered + failed) / total * 100) : 0;

  root.innerHTML = `
    <div class="head">
      <div class="head-title">${escapeHtml(payload.courier || 'Curier')}</div>
      <div class="head-sub">${escapeHtml(payload.date || '')} · ${total} ${total === 1 ? 'oprire' : 'opriri'}</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="progress-label">${delivered} livrate${failed ? ` · ${failed} nelivrate` : ''} · ${remaining} rămase</div>
    </div>
    <div class="stop-list" id="stopList"></div>
    <div class="foot-note">Bifele rămân salvate doar pe acest telefon.</div>
  `;

  const list = document.getElementById('stopList');
  payload.stops.forEach(s => {
    const status = statuses[s.id] || 'pending';
    const card = document.createElement('div');
    card.className = `stop-card status-${status}`;

    const paymentChip = (s.amount != null || s.payment)
      ? `<div class="chip chip-payment ${s.payment === 'Ramburs' ? 'cod' : ''}">${s.amount != null ? Number(s.amount).toFixed(2) + ' lei' : ''}${s.amount != null && s.payment ? ' · ' : ''}${escapeHtml(s.payment || '')}</div>`
      : '';
    const windowChip = s.winStart ? `<div class="chip chip-window">⏱ ${escapeHtml(s.winStart)}–${escapeHtml(s.winEnd)}</div>` : '';

    card.innerHTML = `
      <div class="stop-head">
        <span class="stop-badge">${s.o}</span>
        <div class="stop-title">${escapeHtml(s.name || s.addr)}</div>
      </div>
      ${s.name ? `<div class="stop-addr">${escapeHtml(s.addr)}</div>` : ''}
      ${s.details ? `<div class="stop-line">📦 ${escapeHtml(s.details)}</div>` : ''}
      ${s.note ? `<div class="stop-line">💬 ${escapeHtml(s.note)}</div>` : ''}
      <div class="chip-row">${windowChip}${paymentChip}</div>
      <div class="action-row">
        ${s.phone ? `<a class="pill-btn" href="tel:${escapeHtml(s.phone)}">📞 Sună</a>` : ''}
        ${s.lat != null ? `<a class="pill-btn" href="${mapsUrl(s.lat, s.lng)}" target="_blank" rel="noopener">🗺 Maps</a>` : ''}
        ${s.lat != null ? `<a class="pill-btn" href="${wazeUrl(s.lat, s.lng)}" target="_blank" rel="noopener">🚗 Waze</a>` : ''}
      </div>
      <div class="status-row">
        <button class="status-btn deliver ${status === 'delivered' ? 'active' : ''}" data-mark="${s.id}" data-value="delivered">✓ Livrat</button>
        <button class="status-btn fail ${status === 'failed' ? 'active' : ''}" data-mark="${s.id}" data-value="failed">✕ Nelivrat</button>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('[data-mark]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.mark;
      const value = btn.dataset.value;
      if (statuses[id] === value) delete statuses[id];
      else statuses[id] = value;
      saveStatuses(payload.routeId, statuses);
      render();
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  payload = loadPayloadFromHash();
  if (payload && payload.routeId) statuses = loadStatuses(payload.routeId);
  render();
});
