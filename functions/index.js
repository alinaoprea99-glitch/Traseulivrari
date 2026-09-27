// Faza 4 — sincronizare live curier <-> pagina de urmărire a clientului.
//
// Cele două colecții au scopuri diferite și niciuna nu are voie să scrie direct în
// cealaltă din partea clientului browser (vezi firestore.rules): courierRuns e scrisă de
// dispecer (creare) și curier (stops.*, lastPos); stops e scrisă de client DOAR pe
// clientConfirmed/clientNote. Aceste două funcții sunt singura punte între ele, rulând cu
// drepturi admin (ocolesc regulile de securitate, care există doar pentru clienți browser).
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();

const DISPATCHER_EMAIL = 'alinaoprea99@gmail.com'; // vezi și isDispatcher() din firestore.rules
const googleMapsApiKey = defineSecret('GOOGLE_MAPS_API_KEY');

/**
 * Faza 8 — geocodare de rezervă prin Google, DOAR pentru adresele pe care Nominatim (gratuit,
 * folosit ca primă opțiune în app.js) le-a găsit cu încredere scăzută sau deloc — nu înlocuiește
 * Nominatim, îl completează. Costă bani (spre deosebire de Nominatim/OSRM), de-aia rulează
 * server-side, cu cheia ținută ca secret Firebase (niciodată expusă în browser), și verifică
 * explicit că cel ce apelează e chiar dispecerul — un apel neautorizat ar consuma din cotă/cost
 * degeaba. components=country:RO oglindește countrycodes=ro folosit deja la Nominatim.
 */
exports.geocodeAddressFallback = onCall({ secrets: [googleMapsApiKey], region: 'europe-west1' }, async (request) => {
  if (!request.auth || request.auth.token.email !== DISPATCHER_EMAIL){
    throw new HttpsError('permission-denied', 'Doar dispecerul poate folosi geocodarea de rezervă.');
  }
  const address = request.data && request.data.address;
  if (!address || typeof address !== 'string'){
    throw new HttpsError('invalid-argument', 'Lipsește adresa de geocodat.');
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&components=country:RO&key=${googleMapsApiKey.value()}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== 'OK' || !json.results || !json.results.length){
    return { found: false, status: json.status };
  }

  const result = json.results[0];
  const loc = result.geometry.location;
  const locationType = result.geometry.location_type; // ROOFTOP, RANGE_INTERPOLATED, GEOMETRIC_CENTER, APPROXIMATE
  const hasHouseNumber = (result.address_components || []).some((c) => c.types.includes('street_number'));
  const confidence = (locationType === 'ROOFTOP' || (hasHouseNumber && locationType === 'RANGE_INTERPOLATED')) ? 'high' : 'medium';

  return {
    found: true,
    lat: loc.lat,
    lng: loc.lng,
    confidence,
    displayName: result.formatted_address
  };
});

/** Trimite un push la un token dat; șterge tokenul (via onInvalidToken) dacă a expirat/dezinstalat — orice altă eroare doar se loghează, fără să blocheze restul sincronizării. */
async function sendPush(token, { title, body, link }, onInvalidToken){
  if (!token) return;
  try {
    await getMessaging().send({
      token,
      notification: { title, body },
      webpush: { fcmOptions: { link } }
    });
  } catch (e){
    if (e.code === 'messaging/registration-token-not-registered') await onInvalidToken();
    else console.error('Nu am putut trimite notificarea push', e);
  }
}

/**
 * courierRuns -> stops: la fiecare schimbare de poziție/status a curierului, propagă spre
 * fiecare document public stops/{stopId} DOAR ce are voie să vadă clientul respectiv —
 * niciodată traseul complet sau alți clienți. stopsAhead se recalculează de fiecare dată
 * (nu se stochează separat pe courierRuns) — numărul de opriri încă "pending" cu order mai
 * mic decât al acestei opriri.
 *
 * Faza 6: timpul de sosire afișat clientului era calculat GREȘIT (tracking.js calcula, client-
 * side, ruta directă curier -> el, ignorând opririle dintre ei — deci arăta timpul "dacă ar
 * veni acum direct la tine", nu timpul real). Calculul corect are nevoie de tot traseul rămas,
 * la care un client nu are voie acces (vezi firestore.rules) — de-aia se face aici, o singură
 * dată per update de poziție, pentru toate opririle pending deodată (computeCourierEtas mai
 * jos), și se trimite mai departe fiecărui client DOAR rezultatul lui: timp/distanță cumulate
 * și coordonatele (fără nume/adresă/alte detalii) opririlor dinaintea lui.
 *
 * Faza 6.1: OSRM (serviciul de rutare, gratuit) nu are date de trafic live — estimează doar
 * "drum liber", ceea ce poate diferi cu 10+ minute într-o zi aglomerată. Calibrăm la fiecare
 * update: comparăm timpul REAL scurs între ultimele două poziții GPS ale curierului cu timpul
 * pe care OSRM l-ar estima pentru exact acea distanță — dacă a durat mai mult (trafic), scalăm
 * ETA-ul rămas proporțional. Fără nicio stare persistentă între update-uri (nu scriem factorul
 * înapoi pe courierRuns — ar re-declanșa funcția asta la infinit); se recalibrează din ultimul
 * interval de ~15s de fiecare dată, amortizat ca o singură oprire la semafor să nu răstoarne
 * estimarea (vezi computeCourierEtas).
 */
exports.syncCourierRunToStops = onDocumentUpdated('courierRuns/{runId}', async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!after || !after.stops) return;

  const entries = Object.entries(after.stops);
  const pendingEntries = entries
    .filter(([, s]) => (s.status || 'pending') === 'pending')
    .sort((a, b) => a[1].order - b[1].order);
  const pendingOrders = pendingEntries.map(([, s]) => s.order);

  let etas = {};
  if (after.lastPos && pendingEntries.length){
    try {
      const prevPos = before && before.lastPos;
      // doar dacă poziția chiar s-a schimbat față de update-ul trecut (nu un re-trigger din
      // status/clientNote) — altfel n-avem un interval real de calibrat
      const calibratePos = (prevPos && prevPos.updatedAt !== after.lastPos.updatedAt) ? prevPos : null;
      const actualElapsedSec = calibratePos ? (new Date(after.lastPos.updatedAt) - new Date(calibratePos.updatedAt)) / 1000 : 0;
      etas = await computeCourierEtas(after.lastPos, pendingEntries, calibratePos, actualElapsedSec);
    } catch (e){
      console.error('Nu am putut calcula timpii estimați de sosire', e);
    }
  }

  const batch = db.batch();
  entries.forEach(([addrKey, s]) => {
    if (!s.stopId) return; // run-uri create înainte de Faza 4 nu au stops/ asociat — ignorate
    const status = s.status || 'pending';
    const stopsAhead = status === 'pending'
      ? pendingOrders.filter((o) => o < s.order).length
      : 0;
    const eta = etas[addrKey];
    batch.update(db.collection('stops').doc(s.stopId), {
      status,
      stopsAhead,
      courierLat: after.lastPos ? after.lastPos.lat : null,
      courierLng: after.lastPos ? after.lastPos.lng : null,
      courierUpdatedAt: after.lastPos ? after.lastPos.updatedAt : null,
      courierEtaMinutes: eta ? eta.etaMinutes : null,
      courierEtaKm: eta ? eta.etaKm : null,
      courierRouteGeometry: eta ? eta.geometry : null,
      courierIntermediateStops: eta ? eta.intermediateStops : null
    });
  });
  await batch.commit();
});

/**
 * Un singur apel OSRM cu poziția curierului + toate opririle pending ca waypoint-uri, în ordine
 * — mult mai eficient decât înainte (fiecare client, în tracking.js, își calcula singur, client-
 * side, un apel OSRM separat, repetat la fiecare ~15s cât avea pagina deschisă: N clienți
 * deschiși = N apeluri repetate; acum e UN apel per update de poziție al curierului, indiferent
 * câți clienți urmăresc). steps=true ca să putem reconstitui geometria traseului PARȚIAL de la
 * curier până la fiecare oprire i (concatenând geometria fiecărui pas din legs[0..i]) —
 * overview=full ar da doar geometria traseului ÎNTREG, nu utilă per-oprire.
 *
 * calibratePos (opțional) — poziția ANTERIOARĂ a curierului: dacă e dată, o punem ca prim
 * waypoint, ca leg-ul 0 (calibratePos -> courierPos) să ne dea timpul pe care OSRM l-ar estima
 * pentru distanța pe care curierul TOCMAI a parcurs-o. Comparat cu actualElapsedSec (timpul
 * REAL scurs între cele două poziții GPS), obținem un factor de trafic aplicat la tot restul
 * estimărilor. Ignorat (factor neutru) dacă intervalul e prea scurt/lung ca să reflecte trafic
 * real (curier oprit la o livrare, semnal GPS pierdut) — vezi pragurile de mai jos.
 */
async function computeCourierEtas(courierPos, pendingEntries, calibratePos, actualElapsedSec){
  const waypoints = [
    ...(calibratePos ? [calibratePos] : []),
    courierPos,
    ...pendingEntries.map(([, s]) => ({ lat: s.lat, lng: s.lng }))
  ];
  const coordStr = waypoints.map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=false&geometries=geojson&steps=true`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.code !== 'Ok' || !json.routes || !json.routes.length) return {};

  const legs = json.routes[0].legs;
  let legOffset = 0;
  let trafficFactor = 1;
  if (calibratePos){
    legOffset = 1;
    const predictedSec = legs[0].duration;
    // sub 15s estimate OSRM sau interval real în afara a 5-90s — prea nesigur ca semnal de
    // trafic (curier oprit la livrare, poziții aproape identice, gap de semnal GPS) — păstrăm
    // estimarea de drum liber neschimbată în loc să riscăm un factor aberant
    if (predictedSec >= 15 && actualElapsedSec >= 5 && actualElapsedSec <= 90){
      const instantRatio = Math.min(2, Math.max(0.5, actualElapsedSec / predictedSec));
      trafficFactor = 1 + 0.5 * (instantRatio - 1); // amortizat — o singură oprire la semafor nu răstoarnă estimarea
    }
  }

  const result = {};
  let cumDuration = 0, cumDistance = 0;
  const geometrySoFar = [];
  const intermediateStops = [];
  for (let i = legOffset; i < legs.length; i++){
    const leg = legs[i];
    cumDuration += leg.duration;
    cumDistance += leg.distance;
    (leg.steps || []).forEach((step) => {
      const coords = (step.geometry && step.geometry.coordinates) || [];
      coords.forEach(([lng, lat]) => geometrySoFar.push({ lat, lng }));
    });
    const pendingIdx = i - legOffset;
    const [addrKey] = pendingEntries[pendingIdx];
    result[addrKey] = {
      etaMinutes: Math.round(cumDuration * trafficFactor / 60),
      etaKm: Math.round(cumDistance / 100) / 10,
      geometry: geometrySoFar.slice(),
      intermediateStops: intermediateStops.slice()
    };
    intermediateStops.push({ lat: pendingEntries[pendingIdx][1].lat, lng: pendingEntries[pendingIdx][1].lng });
  }
  return result;
}

/**
 * stops -> courierRuns: răspunsul clientului (confirmare + observație) apare live la curier
 * și dispecer, într-un câmp separat de "observatii" (notele curierului), ca să nu se
 * amestece cele două surse. Verifică explicit ce s-a schimbat, ca să nu intre în buclă cu
 * funcția de mai sus (care scrie pe stops de fiecare dată când courierRuns se schimbă, dar
 * niciodată pe clientConfirmed/clientNote).
 *
 * Faza 5: după sincronizare, trimite și o notificare push curierului ȘI dispecerului (dacă au
 * fcmToken — vezi curier.js/app.js/firestore.rules) — DOAR când clientul confirmă sau scrie
 * ceva nou, nu și când retrage o confirmare/observație, ca să nu-i deranjeze fără motiv.
 */
exports.syncClientResponseToCourierRun = onDocumentUpdated('stops/{stopId}', async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!after || !after.runId || !after.addressId) return;
  if (before.clientConfirmed === after.clientConfirmed && before.clientNote === after.clientNote) return;

  const runRef = db.doc(`courierRuns/${after.runId}`);
  await runRef.update({
    [`stops.${after.addressId}.clientConfirmed`]: after.clientConfirmed ?? null,
    [`stops.${after.addressId}.clientNote`]: after.clientNote || ''
  });

  const parts = [];
  if (after.clientConfirmed === true && before.clientConfirmed !== true){
    parts.push(`✓ ${after.clientName || 'Clientul'} a confirmat: va fi acasă`);
  }
  if (after.clientNote && after.clientNote !== before.clientNote){
    parts.push(`💬 Observație: „${after.clientNote}”`);
  }
  if (!parts.length) return;
  const notification = { title: 'Crăița — actualizare client', body: parts.join(' · ') };

  const runSnap = await runRef.get();
  const courierToken = runSnap.exists ? runSnap.data().fcmToken : null;
  await sendPush(courierToken, { ...notification, link: 'curier.html' },
    () => runRef.update({ fcmToken: FieldValue.delete() }));

  const dispatcherRef = db.doc('dispatcherData/push');
  const dispatcherSnap = await dispatcherRef.get();
  const dispatcherToken = dispatcherSnap.exists ? dispatcherSnap.data().fcmToken : null;
  await sendPush(dispatcherToken, { ...notification, link: 'index.html' },
    () => dispatcherRef.update({ fcmToken: FieldValue.delete() }));
});
