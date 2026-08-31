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
//     SMS e acum canalul implicit (vezi mai jos de ce), deci ăsta nu mai e opțional.
//   - La prima rulare, macOS va cere permisiunea ca Terminal (sau aplicația din
//     care rulezi) să controleze Messages — accept-o din System Settings ->
//     Privacy & Security -> Automation.
//   - Pentru verificarea REALĂ de livrare de după trimitere (vezi mai jos): Terminal
//     (sau aplicația din care rulezi) trebuie să aibă Full Disk Access — System Settings ->
//     Privacy & Security -> Full Disk Access. Fără el, verificarea e omisă cu un mesaj clar,
//     restul scriptului funcționează la fel ca înainte.
//
// De ce SMS implicit, nu iMessage: comanda AppleScript "send" raportează succes din
// momentul în care Messages.app PREIA mesajul de trimis, nu din momentul livrării reale —
// eșecul de livrare (client fără iMessage) se întâmplă async, în fundal, deci acest script
// nu-l vede și nu-l raportează ca eroare. Găsit pe teren: mesajele către clienți cu iPhone
// au mers, cele către restul (majoritatea, telefoane non-Apple) au apărut "failed" în
// Messages abia după trimitere, cu 0 erori afișate aici. SMS e universal — nu depinde ca
// destinatarul să aibă cont iMessage — deci e alegerea corectă pentru o bază de clienți
// obișnuită. iMessage rămâne fallback doar dacă pe acest Mac SMS chiar nu e disponibil ca
// serviciu (Text Message Forwarding neconfigurat).
//
// Găsit din nou pe teren (2026-08-31): SMS-ul forțat prin releul de pe iPhone poate eșua la
// fel de silențios dacă releul (Text Message Forwarding) nu era activ chiar în momentul
// trimiterii — iar "send"-ul tot raportează succes, orbește. De-asta scriptul verifică acum,
// DUPĂ trimitere, rezultatul real direct din chat.db (vezi verifyRealDelivery mai jos) —
// asta e singura sursă care reflectă ce s-a întâmplat de-adevăratelea.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Verificare reală de livrare, după trimitere: AppleScript "send" raportează succes din
// momentul în care Messages.app PREIA mesajul, nu din livrarea reală (vezi comentariul de
// mai sus) — deci singurul mod de a afla ce s-a întâmplat de-adevăratelea e să citim direct
// baza de date a Messages (chat.db), unde macOS scrie asincron rezultatul real (coloana
// "error" — nenulă dacă a eșuat — și "service", canalul folosit efectiv: SMS sau iMessage).
// Necesită Full Disk Access pentru Terminal (System Settings -> Privacy & Security -> Full
// Disk Access) — fără el, verificarea eșuează silențios și scriptul afișează doar starea
// veche ("✓ trimis"), fără nicio garanție reală.
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
  rows.forEach(r => {
    byPhone.set(normalizePhoneForMatch(r.handle), { service: r.service, error: r.error, dateSec: r.date / 1e9 + APPLE_EPOCH_OFFSET_SEC });
  });
  return byPhone;
}

const SEND_APPLESCRIPT = `
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

function sendOne(phone, message){
  execFileSync('osascript', ['-e', SEND_APPLESCRIPT, phone, message], { stdio: 'pipe' });
}

function sleepSeconds(seconds){
  execFileSync('sleep', [String(seconds)]);
}

function main(){
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const filePath = args.find(a => !a.startsWith('--'));

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

  console.log(`${entries.length} mesaje de trimis${dryRun ? '  —  DRY RUN: nu se trimite nimic real' : ''}.\n`);

  const runStartUnixSec = Math.floor(Date.now() / 1000) - 2; // marjă mică, ca să nu rateze mesaje trimise chiar la limită
  let sent = 0, failed = 0;
  const sentPhones = [];
  entries.forEach((entry, i) => {
    const { phone, message } = entry;
    console.log(`[${i + 1}/${entries.length}] -> ${phone}`);
    console.log(message.split('\n').map(l => `    ${l}`).join('\n'));

    if (dryRun){
      console.log('    (dry-run, nu s-a trimis)\n');
      return;
    }

    try {
      sendOne(phone, message);
      sent++;
      sentPhones.push(phone);
      console.log('    ✓ preluat de Messages (nu garantează livrarea reală — vezi verificarea de mai jos)\n');
    } catch (e){
      failed++;
      console.error(`    ✗ EROARE: ${e.message}\n`);
    }

    if (i < entries.length - 1) sleepSeconds(2); // pauză scurtă între mesaje
  });

  if (!dryRun){
    console.log(`Preluate de Messages: ${sent}, respinse imediat: ${failed}.\n`);
    verifyRealDelivery(sentPhones, runStartUnixSec);
  }
}

/**
 * Best-effort: citește chat.db direct ca să afle ce s-a întâmplat de-adevăratelea cu fiecare
 * mesaj (Messages.app scrie rezultatul real asincron, la câteva secunde după "send"). Fără
 * Full Disk Access pentru Terminal, chat.db nu poate fi citit — verificarea e omisă cu un
 * mesaj clar, restul scriptului funcționează neschimbat (ca înainte).
 */
function verifyRealDelivery(sentPhones, runStartUnixSec){
  if (!sentPhones.length) return;
  console.log('Verific starea reală de livrare (Messages actualizează asincron, aștept 8s)...');
  sleepSeconds(8);

  const statusByPhone = fetchDeliveryStatusSince(runStartUnixSec);
  if (statusByPhone === null){
    console.log('Nu am putut verifica — Terminal nu are Full Disk Access pentru Messages.');
    console.log('Activează din System Settings -> Privacy & Security -> Full Disk Access -> adaugă Terminal (sau aplicația din care rulezi acest script), apoi rulează din nou.');
    return;
  }

  let confirmedOk = 0, confirmedFailed = 0, unknown = 0;
  sentPhones.forEach(phone => {
    const status = statusByPhone.get(normalizePhoneForMatch(phone));
    if (!status){
      unknown++;
      console.log(`  ? ${phone}: nu am găsit mesajul în Messages încă (verifică manual)`);
    } else if (status.error && status.error !== 0){
      confirmedFailed++;
      console.log(`  ✗ ${phone}: NELIVRAT — Messages raportează eroare ${status.error} (canal: ${status.service || 'necunoscut'})`);
    } else {
      confirmedOk++;
      console.log(`  ✓ ${phone}: fără eroare raportată de Messages (canal: ${status.service || 'necunoscut'})`);
    }
  });

  console.log(`\nVerificare reală: ${confirmedOk} fără eroare, ${confirmedFailed} NELIVRATE confirmat, ${unknown} necunoscut.`);
  if (confirmedFailed > 0){
    console.log('Cele NELIVRATE nu au ajuns la client — corectează numărul sau retrimite manual din Messages.');
  }
}

main();
