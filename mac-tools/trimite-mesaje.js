#!/usr/bin/env node
// Trimite automat, prin Messages.app, mesajele de livrare generate din butonul
// "Mesaje clienți" al aplicației (fișierul .json descărcat din acel modal).
//
// Rulează mereu întâi cu --dry-run ca să vezi exact ce s-ar trimite, înainte
// să trimiți orice mesaj real către un client.
//
// Utilizare:
//   node trimite-mesaje.js ~/Downloads/mesaje_clienti_2026-07-30.json --dry-run
//   node trimite-mesaje.js ~/Downloads/mesaje_clienti_2026-07-30.json
//
// Cerințe pe acest Mac:
//   - Messages.app deschis și logat, cu "Text Message Forwarding" activat din iPhone —
//     necesar pentru etapa 2 (SMS), vezi mai jos.
//   - La prima rulare, macOS va cere permisiunea ca Terminal (sau aplicația din
//     care rulezi) să controleze Messages — accept-o din System Settings ->
//     Privacy & Security -> Automation.
//   - Pentru verificarea REALĂ de livrare (obligatorie acum, vezi mai jos — fără ea
//     scriptul nu poate decide cine trece la etapa 2): Terminal (sau aplicația din care
//     rulezi) trebuie să aibă Full Disk Access — System Settings -> Privacy & Security ->
//     Full Disk Access.
//
// ===================================================================================
// Faza 9 (2026-10-09) — trimitere în DOUĂ ETAPE, nu un singur canal fix:
//
//   Etapa 1 — iMessage pentru toți. iMessage circulă prin serverele Apple (date/internet),
//   NU prin rețeaua SMS a operatorului — deci ocolește complet filtrarea anti-spam de
//   operator suspectată (vezi istoricul de mai jos, 2026-09-25/27). Pentru clienții cu
//   iPhone, asta elimină exact problema care tot recidivează cu SMS.
//
//   Etapa 2 — SMS DOAR pentru cei la care Etapa 1 a eșuat (telefoane non-Apple, sau
//   iMessage neînregistrat). Lista se construiește din verificarea reală (chat.db), nu din
//   ce raportează "send" (vezi motivul de mai jos) — orice destinatar NECONFIRMAT livrat
//   prin iMessage (eroare explicită SAU pur și simplu negăsit încă în chat.db) trece automat
//   la SMS, ca să nu rişte să rămână nelivrat de tot. Un eventual mesaj dublu (iMessage +
//   SMS, dacă iMessage a mers de fapt dar verificarea n-a apucat să-l vadă) e un cost mult
//   mai mic decât un client care nu primește nimic.
//
// Istoric (de ce NU se trimitea inițial tot prin iMessage):
// comanda AppleScript "send" raportează succes din momentul în care Messages.app PREIA
// mesajul de trimis, nu din momentul livrării reale — eșecul de livrare (client fără
// iMessage) se întâmplă async, în fundal, deci un simplu "send" nu-l vede. Găsit pe teren
// (iulie 2026): mesajele către clienți cu iPhone au mers, cele către restul (telefoane
// non-Apple) au apărut "failed" în Messages abia după trimitere, fără nicio eroare vizibilă
// atunci. De-aia s-a trecut la SMS ca implicit, cu iMessage doar fallback. Găsit din nou pe
// teren (2026-08-31): SMS-ul forțat prin releul de pe iPhone poate eșua la fel de silențios
// dacă releul (Text Message Forwarding) nu era activ chiar în momentul trimiterii. Și mai nou
// (2026-09-25/27): SMS-ul poate fi filtrat ca spam de operator chiar și când Messages
// raportează "Delivered" — asta a motivat revenirea la iMessage ca primă opțiune, dar de
// data asta cu verificarea reală (chat.db) decizând cine mai are nevoie de SMS, nu o
// presupunere oarbă.
// ===================================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Verificare reală de livrare: AppleScript "send" raportează succes din momentul în care
// Messages.app PREIA mesajul, nu din livrarea reală (vezi istoricul de mai sus) — deci
// singurul mod de a afla ce s-a întâmplat de-adevăratelea e să citim direct baza de date a
// Messages (chat.db), unde macOS scrie asincron rezultatul real (coloana "error" — nenulă
// dacă a eșuat — și "service", canalul folosit efectiv: SMS sau iMessage). Necesită Full Disk
// Access pentru Terminal (System Settings -> Privacy & Security -> Full Disk Access).
const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const APPLE_EPOCH_OFFSET_SEC = 978307200; // secunde între 1970-01-01 și 2001-01-01 (referința chat.db)

function normalizePhoneForMatch(phone){
  return String(phone || '').replace(/[\s().-]/g, '');
}

function queryChatDb(sql){
  return execFileSync('sqlite3', ['-json', CHAT_DB_PATH, sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Returns a Map<normalizedPhone, {service, error, dateSec}> of the most recent outgoing message per handle since sinceUnixSeconds, or null if chat.db couldn't be read (no Full Disk Access). */
function fetchDeliveryStatusSince(sinceUnixSeconds){
  const sinceAppleNs = Math.floor((sinceUnixSeconds - APPLE_EPOCH_OFFSET_SEC) * 1e9);
  const sql = `SELECT h.id as handle, m.service as service, m.error as error, m.date as date FROM message m JOIN handle h ON m.handle_id = h.ROWID WHERE m.is_from_me = 1 AND m.date >= ${sinceAppleNs} ORDER BY m.date ASC;`;
  let out;
  try {
    out = queryChatDb(sql);
  } catch (e){
    return null;
  }
  const rows = out && out.trim() ? JSON.parse(out) : [];
  const byPhone = new Map();
  rows.forEach((r) => {
    byPhone.set(normalizePhoneForMatch(r.handle), { service: r.service, error: r.error, dateSec: r.date / 1e9 + APPLE_EPOCH_OFFSET_SEC });
  });
  return byPhone;
}

// Etapa 1: FORȚEAZĂ iMessage — fără fallback intern la SMS (fallback-ul e acum Etapa 2,
// decisă explicit mai jos pe baza verificării reale, nu orbește ca înainte). Dacă numărul nu
// are deloc cont iMessage, "buddy" poate arunca eroare sincron aici — prins în sendOne mai
// jos și tratat ca eșec imediat, fără să mai aștepte verificarea din chat.db pentru el.
const SEND_IMESSAGE_APPLESCRIPT = `
on run argv
  set targetPhone to item 1 of argv
  set targetMessage to item 2 of argv
  tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy targetPhone of targetService
    send targetMessage to targetBuddy
  end tell
end run
`;

// Etapa 2: SMS explicit — fallback la iMessage DOAR dacă serviciul SMS nu există deloc pe
// acest Mac (Text Message Forwarding neconfigurat), nu per-destinatar.
const SEND_SMS_APPLESCRIPT = `
on run argv
  set targetPhone to item 1 of argv
  set targetMessage to item 2 of argv
  tell application "Messages"
    try
      set targetService to 1st service whose service type = SMS
      set targetBuddy to buddy targetPhone of targetService
    on error
      set targetService to 1st service whose service type = iMessage
      set targetBuddy to buddy targetPhone of targetService
    end try
    send targetMessage to targetBuddy
  end tell
end run
`;

function sendVia(script, phone, message){
  execFileSync('osascript', ['-e', script, phone, message], { stdio: 'pipe' });
}

function sleepSeconds(seconds){
  execFileSync('sleep', [String(seconds)]);
}

// Găsit pe teren (2026-09-27): trimiterea prea rapidă (ritm automatizat, nu uman) poate fi
// filtrată ca spam de operator — păstrăm aceeași pauză și pentru etapa 2 (SMS), unde riscul
// ăsta chiar există (spre deosebire de etapa 1, iMessage, care nu trece prin operator).
const SEND_INTERVAL_SEC = 10;
const VERIFY_WAIT_SEC = 8; // Messages scrie rezultatul real în chat.db asincron, la câteva secunde după "send"

/** Trimite o listă de {phone, message} pe rândul dat de script, cu pauză între mesaje — fără nicio verificare, doar trimiterea propriu-zisă. Returnează lista celor la care "send" a aruncat eroare imediat. */
function sendBatch(script, entries, label){
  const failedImmediately = [];
  entries.forEach((entry, i) => {
    const { phone, message } = entry;
    console.log(`[${label} ${i + 1}/${entries.length}] -> ${phone}`);
    try {
      sendVia(script, phone, message);
      console.log('    ✓ preluat de Messages\n');
    } catch (e){
      failedImmediately.push(entry);
      console.log(`    ✗ eșuat imediat (${e.message.split('\n')[0]})\n`);
    }
    if (i < entries.length - 1) sleepSeconds(SEND_INTERVAL_SEC);
  });
  return failedImmediately;
}

/**
 * Așteaptă VERIFY_WAIT_SEC, apoi citește chat.db pentru starea reală a mesajelor trimise
 * (din `entries`) de la `sinceUnixSeconds` încoace. Returnează { confirmedOk, needsRetry } —
 * needsRetry include orice eroare confirmată SAU orice mesaj încă negăsit (tratat ca
 * neconfirmat, deci trece mai departe) — vezi nota din comentariul de sus despre riscul
 * acceptat (eventual mesaj dublu) vs. riscul evitat (client fără niciun mesaj).
 */
function verifyAndSplit(entries, sinceUnixSeconds){
  if (!entries.length) return { confirmedOk: [], needsRetry: [], dbReadable: true };
  console.log(`Verific starea reală de livrare (aștept ${VERIFY_WAIT_SEC}s)...`);
  sleepSeconds(VERIFY_WAIT_SEC);

  const statusByPhone = fetchDeliveryStatusSince(sinceUnixSeconds);
  if (statusByPhone === null){
    console.log('Nu am putut verifica — Terminal nu are Full Disk Access pentru Messages.');
    console.log('Activează din System Settings -> Privacy & Security -> Full Disk Access -> adaugă Terminal, apoi rulează din nou.\n');
    return { confirmedOk: [], needsRetry: [], dbReadable: false };
  }

  const confirmedOk = [], needsRetry = [];
  entries.forEach((entry) => {
    const status = statusByPhone.get(normalizePhoneForMatch(entry.phone));
    if (!status){
      needsRetry.push(entry);
      console.log(`  ? ${entry.phone}: neconfirmat încă — trece la etapa următoare`);
    } else if (status.error && status.error !== 0){
      needsRetry.push(entry);
      console.log(`  ✗ ${entry.phone}: NELIVRAT (eroare ${status.error}, canal ${status.service || 'necunoscut'}) — trece la etapa următoare`);
    } else {
      confirmedOk.push(entry);
      console.log(`  ✓ ${entry.phone}: confirmat (canal ${status.service || 'necunoscut'})`);
    }
  });
  return { confirmedOk, needsRetry, dbReadable: true };
}

function main(){
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const filePath = args.find((a) => !a.startsWith('--'));

  if (!filePath){
    console.error('Utilizare: node trimite-mesaje.js <fisier.json> [--dry-run]');
    process.exit(1);
  }

  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e){
    console.error(`Nu am putut citi fișierul "${filePath}": ${e.message}`);
    process.exit(1);
  }

  if (!Array.isArray(entries) || !entries.length){
    console.error('Fișierul nu conține niciun mesaj de trimis.');
    process.exit(1);
  }

  console.log(`${entries.length} mesaje de trimis${dryRun ? '  —  DRY RUN: nu se trimite nimic real' : ''}.`);
  console.log('Etapa 1: iMessage pentru toți. Etapa 2: SMS doar pentru cei neconfirmați din etapa 1.\n');

  if (dryRun){
    const estMin = Math.round((entries.length - 1) * SEND_INTERVAL_SEC / 60);
    console.log(`(Etapa 1 ar dura aproximativ ${estMin} min; etapa 2 ar urma, doar pentru cei rămași.)\n`);
    entries.forEach((entry, i) => {
      console.log(`[${i + 1}/${entries.length}] -> ${entry.phone}`);
      console.log(entry.message.split('\n').map((l) => `    ${l}`).join('\n'));
      console.log('    (dry-run, nu s-a trimis)\n');
    });
    return;
  }

  // ---- Etapa 1: iMessage ----
  const phase1Start = Math.floor(Date.now() / 1000) - 2; // marjă mică, ca să nu rateze mesaje trimise chiar la limită
  const phase1ImmediateFails = sendBatch(SEND_IMESSAGE_APPLESCRIPT, entries, 'iMessage');
  const phase1SentOk = entries.filter((e) => !phase1ImmediateFails.includes(e));
  const { confirmedOk: phase1Confirmed, needsRetry: phase1Unconfirmed, dbReadable } = verifyAndSplit(phase1SentOk, phase1Start);

  const needsSms = [...phase1ImmediateFails, ...phase1Unconfirmed];
  console.log(`\nEtapa 1 (iMessage): ${phase1Confirmed.length} confirmate, ${needsSms.length} trec la etapa 2 (SMS).\n`);

  if (!dbReadable){
    console.log('Nu pot decide automat cine trece la etapa 2 fără verificarea reală — oprit aici. Activează Full Disk Access și rulează din nou.');
    return;
  }
  if (!needsSms.length){
    console.log('Toate mesajele confirmate prin iMessage — nu e nevoie de SMS.');
    return;
  }

  // ---- Etapa 2: SMS, doar pentru cei neconfirmați mai sus ----
  console.log('--- Etapa 2: SMS ---\n');
  const phase2Start = Math.floor(Date.now() / 1000) - 2;
  sendBatch(SEND_SMS_APPLESCRIPT, needsSms, 'SMS');
  const { confirmedOk: phase2Confirmed, needsRetry: phase2Failed } = verifyAndSplit(needsSms, phase2Start);

  console.log(`\nRezultat final: ${phase1Confirmed.length} prin iMessage, ${phase2Confirmed.length} prin SMS, ${phase2Failed.length} NECONFIRMATE pe niciun canal.`);
  if (phase2Failed.length){
    console.log('Cei neconfirmați nici prin SMS nu au primit nimic — verifică manual sau retrimite individual:');
    phase2Failed.forEach((e) => console.log(`  - ${e.phone}`));
  }
}

main();
