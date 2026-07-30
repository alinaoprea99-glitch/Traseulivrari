#!/bin/bash
# Dublu-click pe acest fișier trimite automat mesajele de livrare din cel mai
# recent fișier "mesaje_clienti_*.json" descărcat din aplicație în Downloads.
# Arată întâi un dry-run (fără trimitere reală), apoi cere confirmare.

cd "$(dirname "$0")"

LATEST=$(ls -t ~/Downloads/mesaje_clienti_*.json 2>/dev/null | head -1)

if [ -z "$LATEST" ]; then
  echo "Nu am găsit niciun fișier mesaje_clienti_*.json în Downloads."
  echo "Generează întâi fișierul din aplicație (butonul „Mesaje clienți”)."
  read -p "Apasă Enter ca să închizi această fereastră..."
  exit 1
fi

echo "Fișier găsit: $LATEST"
echo ""
node trimite-mesaje.js "$LATEST" --dry-run

echo ""
read -p "Trimit mesajele de mai sus acum? (y/n) " CONFIRM

if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
  echo ""
  node trimite-mesaje.js "$LATEST"
else
  echo "Anulat. Niciun mesaj nu a fost trimis."
fi

echo ""
read -p "Apasă Enter ca să închizi această fereastră..."
