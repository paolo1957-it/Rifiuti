# Rifiuti

Web app per il telefono che dice **in quale contenitore della differenziata va un rifiuto** e mostra
**i punti di raccolta vicino a te** (centri di raccolta, farmacie per i farmaci scaduti, contenitori per pile,
elettronici, olio, abiti e vetro). Stesso aspetto e funzionamento di Distributori e Colonnine.

Sito: https://paolo1957-it.github.io/Rifiuti/ · Guida: https://paolo1957-it.github.io/Rifiuti/guida.html

## Dove lo butto?

Il pulsante verde con la macchina fotografica apre la pagina per riconoscere un rifiuto, in tre modi:

- **Scrivi il nome**: l'app lo cerca in `dizionario.json`, un elenco dei rifiuti più comuni con le regole più diffuse in Italia.
  Funziona anche senza internet. Per aggiungere o correggere un rifiuto basta modificare questo file:
  ogni riga è `[nome / sinonimi, contenitore, consiglio, dove portarlo]`.
- **Codice a barre**: la fotocamera legge il codice (con il lettore del telefono, oppure con la libreria ZXing in `zxing.min.js`
  sull'iPhone) e l'app cerca i materiali della confezione su Open Food Facts, Open Beauty Facts e Open Products Facts.
- **Foto**: la foto viene mandata a Claude (Anthropic), che riconosce oggetto, materiale e contenitore.
  Serve una **chiave personale di Claude** (si crea su platform.claude.com → API Keys, dopo aver caricato del credito),
  da inserire nella pagina Elenco. La chiave resta solo sul telefono e viene mandata solo ad Anthropic.
  Ogni foto costa circa un centesimo o due. Il modello usato è scritto in `config.js` (`modelloClaude`).

## Come funziona la mappa

- Più volte al giorno GitHub esegue `aggiorna_rifiuti.py` (workflow `.github/workflows/pubblica.yml`):
  scarica da OpenStreetMap (Overpass API) i punti di raccolta e le farmacie di tutta Italia
  e li salva nella cartella `dati/` del sito pubblicato, divisi in tessere da 0,25°.
- La cartella `dati/` **non** sta nel repository: viene creata a ogni pubblicazione.
  Se OpenStreetMap non risponde, lo script ricopia i dati già pubblicati, così il sito non resta mai vuoto.
- `dati/diagnosi.json` dice quanti punti ci sono per tipo e quali etichette di OpenStreetMap sono state trovate.

## Pubblicazione

Impostazioni del repository → Pages → Source: **GitHub Actions**.
Per aggiornare i dati subito: Actions → *Pubblica sito e aggiorna punti di raccolta* → *Run workflow*.

## File

- `index.html`, `style.css`: interfaccia
- `core.js`: logica (distanze, tipi di punti, ricerca nell'elenco dei rifiuti, materiali delle confezioni)
- `app.js`: mappa, GPS, elenco, impostazioni, "Dove lo butto?" (codice a barre e foto), voce e suoni
- `config.js`: impostazioni iniziali, modello di Claude e numero di versione
- `dizionario.json`: elenco dei rifiuti comuni
- `zxing.min.js`: lettore di codici a barre (libreria @zxing/library 0.21.3, licenza Apache 2.0)
- `aggiorna_rifiuti.py`, `.github/workflows/pubblica.yml`: scaricamento dei dati e pubblicazione
- `sw.js`, `manifest.webmanifest`, `icon.svg`: installazione come app
- `icon-512.png`, `icon-192.png`, `apple-touch-icon.png`: logo in PNG (dall'icona SVG)
- `guida.html`: guida all'app come pagina a sé

## A ogni aggiornamento

Cambiare insieme il numero di versione in `config.js` (`versione`), in `sw.js` (`rifiuti-N`) e `?v=N` in `index.html` e `guida.html`.

## Fonti

Punti di raccolta e mappa: © OpenStreetMap e i suoi volontari (ODbL). Prodotti: Open Food Facts (ODbL).
Riconoscimento dalle foto: Claude (Anthropic).
Le regole della differenziata cambiano da comune a comune: vale sempre quello che dice il proprio comune o il gestore della raccolta.
