// Faza 4 — sincronizare live curier <-> pagina de urmărire a clientului.
//
// Cele două colecții au scopuri diferite și niciuna nu are voie să scrie direct în
// cealaltă din partea clientului browser (vezi firestore.rules): courierRuns e scrisă de
// dispecer (creare) și curier (stops.*, lastPos); stops e scrisă de client DOAR pe
// clientConfirmed/clientNote. Aceste două funcții sunt singura punte între ele, rulând cu
// drepturi admin (ocolesc regulile de securitate, care există doar pentru clienți browser).
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();

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
 */
exports.syncCourierRunToStops = onDocumentUpdated('courierRuns/{runId}', async (event) => {
  const after = event.data.after.data();
  if (!after || !after.stops) return;

  const entries = Object.entries(after.stops);
  const pendingOrders = entries
    .filter(([, s]) => (s.status || 'pending') === 'pending')
    .map(([, s]) => s.order);

  const batch = db.batch();
  entries.forEach(([, s]) => {
    if (!s.stopId) return; // run-uri create înainte de Faza 4 nu au stops/ asociat — ignorate
    const status = s.status || 'pending';
    const stopsAhead = status === 'pending'
      ? pendingOrders.filter((o) => o < s.order).length
      : 0;
    batch.update(db.collection('stops').doc(s.stopId), {
      status,
      stopsAhead,
      courierLat: after.lastPos ? after.lastPos.lat : null,
      courierLng: after.lastPos ? after.lastPos.lng : null,
      courierUpdatedAt: after.lastPos ? after.lastPos.updatedAt : null
    });
  });
  await batch.commit();
});

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
