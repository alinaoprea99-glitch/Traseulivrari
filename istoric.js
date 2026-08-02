// ===================================================================
// Istoricul comenzilor — pagina clientului.
// Un singur link, mereu același, pentru un client (potrivit după numărul
// de telefon — vezi app.js resolveClientId/ensureCourierRun). Citește
// clients/{clientId}, care doar ȚINE o listă de stopId-uri către comenzile
// trecute — fiecare comandă e citită din stops/{stopId} (același document
// folosit de tracking.html), nu o copie separată, deci statusul rămas
// aici e mereu la zi. Nu arată NICIODATĂ comenzile altui client — vezi
// firestore.rules (get pe ID exact, list interzis pentru clienți).
// ===================================================================

const db = firebase.firestore();
let currentClientId = null;
let loadingHistory = true;
let notFound = false;
const stopCache = {}; // stopId -> stops/{stopId} data, populat o singură dată per id (nu se mai schimbă structura unei comenzi trecute, doar statusul — dar pentru istoric, o comandă deja livrată/nelivrată e stabilă)

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function formatProductsWithKg(data){
  if (!data.products) return '';
  if (data.productsKg == null) return escapeHtml(data.products);
  const rounded = Math.round(data.productsKg * 100) / 100;
  const kgText = rounded % 1 === 0 ? rounded : rounded.toFixed(2);
  return `${escapeHtml(data.products)} · Total: ${kgText} kg`;
}

const LUNI_RO = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
function formatDateRo(dateStr){
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return `${d} ${LUNI_RO[m - 1]} ${y}`;
}

const ICONS = {
  receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5L22 20H2L12 3.5z"/><path d="M12 10v4.5M12 17.5h0"/></svg>'
};

function statusBadge(status){
  if (status === 'delivered') return { cls: 'delivered', label: 'Livrată' };
  if (status === 'failed') return { cls: 'failed', label: 'Nelivrată' };
  return { cls: 'pending', label: 'În curs' };
}

function orderCardHtml(stop){
  const { cls, label } = statusBadge(stop.status);
  const paymentText = (stop.amount != null || stop.payment)
    ? `${stop.amount != null ? Number(stop.amount).toFixed(2) + ' lei' : ''}${stop.amount != null && stop.payment ? ' · ' : ''}${escapeHtml(stop.payment || '')}`
    : '';
  const windowText = stop.winStart ? ` · interval ${escapeHtml(stop.winStart)}` : '';
  return `
    <div class="order-card">
      <div class="order-card-top">
        <div class="order-date">${escapeHtml(formatDateRo(stop.date))}</div>
        <span class="order-badge ${cls}">${label}</span>
      </div>
      ${stop.products ? `<div class="order-products">${formatProductsWithKg(stop)}</div>` : ''}
      ${paymentText || windowText ? `<div class="order-meta">${paymentText}${windowText}</div>` : ''}
    </div>
  `;
}

function render(orderedStops){
  const root = document.getElementById('root');

  if (notFound || (!loadingHistory && !orderedStops)){
    root.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">${ICONS.warn}</div>
        <div class="es-title">Link invalid</div>
        <div class="es-sub">Acest link de istoric nu mai este valabil. Contactează-ne dacă ai nevoie de ajutor.</div>
      </div>`;
    return;
  }

  if (loadingHistory){
    root.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">${ICONS.receipt}</div>
        <div class="es-title">Se încarcă…</div>
      </div>`;
    return;
  }

  if (!orderedStops.length){
    root.innerHTML = `
      <div class="head">
        <div class="head-title">Istoricul comenzilor tale</div>
        <div class="head-sub">Crăița Merelor</div>
      </div>
      <div class="empty-state">
        <div class="es-icon">${ICONS.receipt}</div>
        <div class="es-title">Nicio comandă încă</div>
        <div class="es-sub">Comenzile tale vor apărea aici pe măsură ce le plasezi.</div>
      </div>`;
    return;
  }

  root.innerHTML = `
    <div class="head">
      <div class="head-title">Istoricul comenzilor tale</div>
      <div class="head-sub">Crăița Merelor · ${orderedStops.length} ${orderedStops.length === 1 ? 'comandă' : 'comenzi'}</div>
    </div>
    <div class="content">
      ${orderedStops.map(orderCardHtml).join('')}
      <div class="foot-note">Crăița Merelor — cu tradiție din Voinești!</div>
    </div>
  `;
}

/** Fetches (and caches) every stop referenced by clients/{clientId}.stopIds, newest first — arrayUnion always appends, so reversing the array gives chronological-descending order without needing a separate timestamp field to sort by. */
async function loadStops(stopIds){
  const missing = stopIds.filter(id => !stopCache[id]);
  if (missing.length){
    const docs = await Promise.all(missing.map(id => db.collection('stops').doc(id).get()));
    docs.forEach((doc, i) => { if (doc.exists) stopCache[missing[i]] = doc.data(); });
  }
  return [...stopIds].reverse().map(id => stopCache[id]).filter(Boolean);
}

function initHistory(){
  currentClientId = new URLSearchParams(location.search).get('c');
  if (!currentClientId){
    loadingHistory = false;
    notFound = true;
    render(null);
    return;
  }
  firebase.auth().setPersistence(firebase.auth.Auth.Persistence.SESSION)
    .then(() => firebase.auth().signInAnonymously())
    .then(() => {
      db.collection('clients').doc(currentClientId).onSnapshot(
        async (doc) => {
          if (!doc.exists){
            loadingHistory = false;
            notFound = true;
            render(null);
            return;
          }
          const stopIds = doc.data().stopIds || [];
          try {
            const orderedStops = await loadStops(stopIds);
            loadingHistory = false;
            render(orderedStops);
          } catch (e){
            console.error('Nu am putut încărca istoricul comenzilor', e);
            loadingHistory = false;
            notFound = true;
            render(null);
          }
        },
        (err) => {
          console.error('Nu am putut încărca istoricul comenzilor', err);
          loadingHistory = false;
          notFound = true;
          render(null);
        }
      );
    })
    .catch((err) => {
      console.error('Autentificare anonimă eșuată', err);
      loadingHistory = false;
      notFound = true;
      render(null);
    });
}

document.addEventListener('DOMContentLoaded', () => {
  render(null);
  initHistory();
});
