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

const fs = require('fs');
const { execFileSync } = require('child_process');

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

  let sent = 0, failed = 0;
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
      console.log('    ✓ trimis\n');
    } catch (e){
      failed++;
      console.error(`    ✗ EROARE: ${e.message}\n`);
    }

    if (i < entries.length - 1) sleepSeconds(2); // pauză scurtă între mesaje
  });

  if (!dryRun){
    console.log(`Gata. ${sent} trimise, ${failed} eșuate.`);
  }
}

main();
