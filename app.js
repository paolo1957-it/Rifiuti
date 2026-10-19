/*
 * Rifiuti – interfaccia: mappa, posizione, punti di raccolta, elenco e "Dove lo butto?".
 * Stessa struttura di Colonnine, Distributori e PostoLibero.
 */
(function () {
  "use strict";
  const cfg = window.RIFIUTI_CONFIG;
  const $ = (id) => document.getElementById(id);
  const PREF = "rifiuti.";
  const leggiPref = (k, def) => { try { const v = localStorage.getItem(PREF + k); return v === null ? def : v; } catch (e) { return def; } };
  const salvaPref = (k, v) => { try { localStorage.setItem(PREF + k, String(v)); } catch (e) { /* ignora */ } };

  const stato = {
    gps: null,          // ultima posizione GPS {lat, lon, acc}
    centro: null,       // punto della ricerca {lat, lon, daGps}
    raggio: +leggiPref("raggio", cfg.raggioMetri || 5000),
    tipo: leggiPref("tipo", cfg.tipo || "tutti"),
    tutti: [],          // punti delle tessere scaricate
    vicini: [],         // punti entro il raggio del tipo scelto, ordinati per distanza
    caricando: false,
    seguiGps: true,
    dopoCarica: null    // azione da fare quando i dati sono pronti (es. "mostra il più vicino")
  };
  if (![1000, 2000, 5000, 10000].includes(stato.raggio)) stato.raggio = 5000;
  if (!DL.TIPI[stato.tipo]) stato.tipo = "tutti";

  // ---------- Mappa ----------
  const mappa = L.map("mappa", { zoomControl: false, attributionControl: true })
    .setView([41.9, 12.5], 6);
  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  const sfondi = {
    stradale: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }),
    satellite: L.layerGroup([
      L.tileLayer(ESRI + "World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19, maxNativeZoom: 19,
        attribution: "Immagini: Esri, Vantor, Earthstar Geographics, GIS User Community · Strade: Esri, HERE, Garmin, © OpenStreetMap"
      }),
      L.tileLayer(ESRI + "Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, opacity: .8 }),
      L.tileLayer(ESRI + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 })
    ])
  };
  let sfondoAttivo = leggiPref("sfondo", "stradale") === "satellite" ? "satellite" : "stradale";
  function impostaSfondo(nome) {
    Object.values(sfondi).forEach((l) => mappa.removeLayer(l));
    sfondoAttivo = sfondi[nome] ? nome : "stradale";
    sfondi[sfondoAttivo].addTo(mappa);
    $("mappa").classList.toggle("satellite", sfondoAttivo === "satellite");
    salvaPref("sfondo", sfondoAttivo);
  }
  impostaSfondo(sfondoAttivo);

  const livelli = {
    raggio: L.layerGroup().addTo(mappa),
    punti: L.layerGroup().addTo(mappa),
    io: L.layerGroup().addTo(mappa)
  };
  const markerPerId = new Map();
  mappa.on("dragstart", () => { stato.seguiGps = false; });

  const icona = (cls, html) => L.divIcon({ className: "", html: `<div class="mk ${cls}">${html ?? ""}</div>`, iconSize: null });

  // ---------- Utilità UI ----------
  function messaggio(testo, errore) {
    const el = $("stato");
    el.textContent = testo;
    el.classList.toggle("errore", !!errore);
    if (errore && $("pannello").hidden && $("riconosci").hidden) toast(testo);
  }
  let timerToast;
  function toast(testo) {
    const t = $("toast");
    t.textContent = testo;
    t.hidden = false;
    clearTimeout(timerToast);
    timerToast = setTimeout(() => { t.hidden = true; }, 3200);
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const attr = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const linkNavigazione = (lat, lon) =>
    `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;

  // Scarica e legge il JSON entro "ms" millisecondi in tutto (risposta + dati)
  async function fetchJson(url, opts, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  // ---------- Punti di raccolta salvati nel sito ----------
  // Più volte al giorno GitHub scarica i punti di raccolta da OpenStreetMap e li salva nella cartella "dati"
  // del sito, divisi in tessere da 0,25 gradi. L'app scarica solo le tessere intorno a te.
  let indice = null, indiceLetto = 0;
  const tessere = new Map();
  async function leggiIndice(forza) {
    if (!forza && indice && Date.now() - indiceLetto < 15 * 60000) return indice;
    const nuovo = await fetchJson("dati/indice.json", {}, 10000);
    if (!indice || nuovo.aggiornato !== indice.aggiornato) tessere.clear(); // dati nuovi: via le tessere vecchie
    indice = nuovo;
    indiceLetto = Date.now();
    return indice;
  }
  async function caricaPunti(lat, lon, raggio, forza) {
    const ind = await leggiIndice(forza);
    const esistenti = new Set(ind.tessere || []);
    const nomi = DL.tessereNelRaggio(lat, lon, raggio, ind.passo || 0.25).filter((t) => esistenti.has(t));
    const mancanti = nomi.filter((t) => !tessere.has(t));
    const parti = await Promise.all(mancanti.map((t) => fetchJson("dati/" + t, {}, 15000)));
    mancanti.forEach((t, i) => tessere.set(t, parti[i].d || []));
    return nomi.flatMap((t) => tessere.get(t) || []);
  }

  // ---------- Suoni ----------
  let audio = null;
  let suoniAttivi = leggiPref("suoni", "1") !== "0";
  function sbloccaAudio() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state !== "running") audio.resume();
    } catch (e) { /* audio non disponibile */ }
  }
  document.addEventListener("pointerdown", sbloccaAudio, { passive: true });
  document.addEventListener("touchend", sbloccaAudio, { passive: true });
  function suona(note, volume) {
    if (!suoniAttivi || !audio || document.hidden) return;
    if (audio.state !== "running") { audio.resume().catch(() => {}); if (audio.state !== "running") return; }
    const t0 = audio.currentTime + 0.02;
    for (const [freq, inizio, durata] of note) {
      const osc = audio.createOscillator(), g = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + inizio);
      g.gain.exponentialRampToValueAtTime(volume || 0.35, t0 + inizio + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + inizio + durata);
      osc.connect(g).connect(audio.destination);
      osc.start(t0 + inizio);
      osc.stop(t0 + inizio + durata + 0.05);
    }
  }
  const SUONO = {
    aggiornato: () => suona([[1318.5, 0, 0.6], [2637, 0, 0.25]], 0.3),   // "bing"
    errore: () => suona([[392, 0, 0.25], [311, 0.22, 0.45]], 0.3),       // due note che scendono
    bip: () => suona([[1760, 0, 0.12]], 0.25)                              // codice a barre letto
  };

  // ---------- Caricamento ----------
  let giroCarica = 0;
  async function carica(forza, silenzioso) {
    if (!stato.centro) return;
    const giro = ++giroCarica;
    stato.caricando = true;
    $("btn-aggiorna").classList.add("gira");
    const { lat, lon } = stato.centro;
    if (!silenzioso) messaggio("Cerco punti di raccolta entro " + DL.formattaDistanza(stato.raggio) + "…");
    let errore = null;
    try {
      const lista = await caricaPunti(lat, lon, stato.raggio, forza);
      if (giro !== giroCarica) return;
      stato.tutti = lista;
      stato.tentativi = 0;
    } catch (e) {
      errore = e;
      console.warn("Dati non disponibili", e);
    }
    if (giro !== giroCarica) return;
    stato.caricando = false;
    $("btn-aggiorna").classList.remove("gira");
    ricalcola();

    clearTimeout(stato.timerRiprova);
    if (errore) {
      const attese = [30, 60, 120, 300];
      const sec = attese[Math.min(stato.tentativi || 0, attese.length - 1)];
      stato.tentativi = (stato.tentativi || 0) + 1;
      stato.timerRiprova = setTimeout(() => carica(true), sec * 1000);
      if (!silenzioso) SUONO.errore();
      messaggio(`Non riesco a scaricare i punti di raccolta. Riprovo da solo tra ${sec >= 60 ? sec / 60 + " min" : sec + " secondi"}.`, true);
      return;
    }
    if (!silenzioso) SUONO.aggiornato();
    const ora = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    const dove = stato.centro.daGps ? "dalla tua posizione" : "dal punto cercato";
    let delGiorno = "";
    if (indice && indice.aggiornato) {
      const d = new Date(indice.aggiornato);
      if (!isNaN(d)) {
        const oggi = new Date().toDateString() === d.toDateString();
        delGiorno = " · dati OpenStreetMap " + (oggi ? "di oggi" : "del " + d.toLocaleDateString("it-IT", { day: "numeric", month: "long" })) +
          " alle " + d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
      }
    }
    messaggio(`Entro ${DL.formattaDistanza(stato.raggio)} ${dove}${delGiorno} · controllato alle ${ora}`);
    if (stato.dopoCarica) { const f = stato.dopoCarica; stato.dopoCarica = null; f(); }
  }

  // Ricalcola distanze e filtri senza riscaricare (cambio tipo)
  function ricalcola() {
    if (!stato.centro) return;
    stato.vicini = DL.preparaPunti(stato.tutti, stato.centro.lat, stato.centro.lon, stato.raggio, stato.tipo);
    render();
  }

  // ---------- Rendering ----------
  const OPZ_POPUP = { maxWidth: 360, minWidth: 270, autoPanPadding: [16, 90] };
  function distanzaParlata(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + " metri";
    return (m / 1000).toFixed(1).replace(".", ",") + " chilometri";
  }
  const nomiTipi = (p) => (p.t || []).map((t) => DL.TIPI[t] && DL.TIPI[t].nome.toLowerCase()).filter(Boolean);

  function popupPunto(p) {
    const tit = DL.titolo(p);
    const ind = DL.indirizzo(p);
    const tipo = DL.TIPI[p.tipo];
    const voce = [tit + "."];
    const righe = [];
    if (p.n && tipo.lungo.toLowerCase() !== tit.toLowerCase()) righe.push(`<p class="ragione">${esc(tipo.lungo)}</p>`);
    if (p.o && p.o.toLowerCase() !== tit.toLowerCase()) righe.push(`<p>Gestore: ${esc(p.o)}</p>`);
    if (ind) { righe.push(`<p>${esc(ind)}</p>`); voce.push(ind + "."); }
    const t = p.t || [];
    if (t.includes("centro")) {
      righe.push('<p class="pop-accetta"><b>Accetta quasi tutti i rifiuti</b>: ingombranti, elettronici, pile, olio, vernici, potature…</p>');
      voce.push("Centro di raccolta: accetta quasi tutti i rifiuti.");
    } else {
      const nomi = nomiTipi(p);
      righe.push(`<p class="pop-accetta">Puoi portare: <b>${esc(nomi.join(", "))}</b></p>`);
      voce.push("Puoi portare: " + nomi.join(", ") + ".");
    }
    if (p.h) {
      righe.push(`<p class="pop-orari">Orari: ${esc(p.h)}</p>`);
    } else if (t.includes("centro")) {
      righe.push('<p class="avviso-lieve">Orari non indicati: controllali prima di andare</p>');
    }
    righe.push(`<p>${DL.formattaDistanza(p.distanza)} · circa ${DL.minutiInAuto(p.distanza)} min in auto</p>`);
    voce.push(distanzaParlata(p.distanza) + ".");
    righe.push(`<p class="fonte">Fonte: <a href="https://www.openstreetmap.org/${esc(p.i.replace(/^n/, "node/").replace(/^w/, "way/").replace(/^r/, "relation/"))}" target="_blank" rel="noopener">OpenStreetMap</a></p>`);
    return `<div class="pop" data-voce="${attr(voce.join(" "))}"><h3>${esc(tit)}</h3>${righe.join("")}
      <a class="pop-vai" href="${linkNavigazione(p.la, p.lo)}" target="_blank" rel="noopener">Portami qui</a></div>`;
  }

  function piuVicino() {
    return stato.vicini[0] || null;
  }

  function render() {
    livelli.raggio.clearLayers();
    livelli.punti.clearLayers();
    markerPerId.clear();
    if (!stato.centro) return;
    const { lat, lon } = stato.centro;

    L.circle([lat, lon], {
      radius: stato.raggio, color: getComputedStyle(document.documentElement).getPropertyValue("--blu").trim() || "#1b4f9c",
      weight: 1.5, opacity: .6, fillOpacity: .04, dashArray: "6 6", interactive: false
    }).addTo(livelli.raggio);
    if (!stato.centro.daGps) {
      L.circleMarker([lat, lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#172033", fillOpacity: 1 }).addTo(livelli.raggio);
    }

    const vicino = piuVicino();
    for (const p of stato.vicini) {
      const tipo = DL.TIPI[p.tipo];
      const cls = ["tipo", tipo.cls, p.tipo === "centro" ? "centro" : "", vicino && vicino.id === p.id ? "vicino" : ""].join(" ");
      // i centri di raccolta sopra gli altri quando si sovrappongono
      const z = p.tipo === "centro" ? 400 : p.tipo === "vetro" ? 0 : 200;
      const m = L.marker([p.la, p.lo], { icon: icona(cls, tipo.sigla), title: DL.titolo(p), zIndexOffset: z + (vicino && vicino.id === p.id ? 500 : 0) })
        .bindPopup(popupPunto(p), OPZ_POPUP).addTo(livelli.punti);
      markerPerId.set(p.id, m);
    }

    const st = DL.statistiche(stato.vicini);
    $("k-n").textContent = st.n;
    $("k-centri").textContent = st.centri;
    $("k-vicino").textContent = st.vicino != null ? DL.formattaDistanza(st.vicino) : "–";
    $("btn-vicino").disabled = !stato.vicini.length;

    renderLista();
  }

  function voceLista(p) {
    const li = document.createElement("li");
    li.className = "voce";
    li.tabIndex = 0;
    const tipo = DL.TIPI[p.tipo];
    const meta = [];
    const ind = DL.indirizzo(p);
    if (ind) meta.push(`<span>${esc(ind)}</span>`);
    meta.push(`<span>${(p.t || []).includes("centro") ? "accetta quasi tutto" : esc(nomiTipi(p).join(", "))}</span>`);
    if (p.h) meta.push(`<span class="tag reale">orari indicati</span>`);
    li.innerHTML = `
      <div class="icona tipo ${tipo.cls}">${tipo.sigla}</div>
      <div class="voce-testo">
        <div class="voce-titolo">${esc(DL.titolo(p))}</div>
        <div class="voce-meta">${meta.join("")}</div>
      </div>
      <div class="voce-dist"><b>${DL.formattaDistanza(p.distanza)}</b><small>~${DL.minutiInAuto(p.distanza)} min</small></div>`;
    const apri = () => { mostra(p); chiudiElenco(); };
    li.addEventListener("click", apri);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apri(); } });
    return li;
  }

  function renderLista() {
    const ol = $("lista");
    ol.innerHTML = "";
    if (!stato.vicini.length) {
      const li = document.createElement("li");
      li.className = "vuoto";
      li.textContent = stato.tipo === "tutti"
        ? "Nessun punto di raccolta nel raggio. Prova ad allargarlo."
        : "Nessun punto per " + DL.TIPI[stato.tipo].breve + " nel raggio. Prova ad allargarlo o a scegliere Tutti.";
      ol.appendChild(li);
      return;
    }
    stato.vicini.slice(0, 200).forEach((p) => ol.appendChild(voceLista(p)));
  }

  function mostra(p) {
    if (!p) return;
    stato.seguiGps = false;
    mappa.setView([p.la, p.lo], Math.max(mappa.getZoom(), 16));
    const m = markerPerId.get(p.id);
    if (m) setTimeout(() => m.openPopup(), 250);
  }

  // ---------- Posizione ----------
  let marcatoreIo, cerchioPrecisione;

  function impostaCentro(lat, lon, daGps) {
    const prima = stato.centro;
    stato.centro = { lat, lon, daGps };
    const spostato = !prima || prima.daGps !== daGps ||
      DL.distanza(prima.lat, prima.lon, lat, lon) > (cfg.ricaricaDopoMetri || 300);
    if (spostato) {
      mappa.fitBounds(L.latLng(lat, lon).toBounds(stato.raggio * 2.1));
      carica();
    }
  }

  function suPosizione(p) {
    const { latitude: lat, longitude: lon, accuracy: acc } = p.coords;
    stato.gps = { lat, lon, acc };
    if (!marcatoreIo) {
      marcatoreIo = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="io"></div>', iconSize: [18, 18] }), zIndexOffset: 1000, interactive: false }).addTo(livelli.io);
      cerchioPrecisione = L.circle([lat, lon], { radius: acc, color: "#2f7cf6", weight: 0, fillOpacity: .12, interactive: false }).addTo(livelli.io);
    } else {
      marcatoreIo.setLatLng([lat, lon]);
      cerchioPrecisione.setLatLng([lat, lon]).setRadius(acc);
    }
    if (stato.seguiGps) impostaCentro(lat, lon, true);
  }

  function erroreGps(e) {
    const testi = {
      1: "Posizione non autorizzata. Consenti l'accesso alla posizione oppure cerca un indirizzo.",
      2: "Posizione non disponibile. Cerca un indirizzo qui sopra.",
      3: "Il GPS non risponde. Cerca un indirizzo qui sopra."
    };
    if (!stato.gps) messaggio(testi[e.code] || testi[2], true);
  }

  function avviaGps() {
    if (!("geolocation" in navigator)) {
      messaggio("Questo browser non fornisce la posizione. Cerca un indirizzo qui sopra.", true);
      return;
    }
    if (!window.isSecureContext) {
      messaggio("Il GPS funziona solo su HTTPS. Pubblica l'app su un sito https o cerca un indirizzo.", true);
    }
    navigator.geolocation.watchPosition(suPosizione, erroreGps, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  }

  // ---------- Ricerca indirizzo ----------
  $("form-cerca").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("cerca-indirizzo").value.trim();
    if (!q) return;
    messaggio("Cerco “" + q + "”…");
    try {
      const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=it&accept-language=it&q=" + encodeURIComponent(q);
      const [primo] = await fetchJson(url, { headers: { Accept: "application/json" } }, 12000);
      if (!primo) { messaggio("Indirizzo non trovato. Prova ad aggiungere la città.", true); return; }
      stato.seguiGps = false;
      $("cerca-indirizzo").blur();
      impostaCentro(+primo.lat, +primo.lon, false);
    } catch (err) {
      messaggio("Ricerca non riuscita. Controlla la connessione.", true);
    }
  });

  // ---------- Controlli ----------
  $("btn-centra").addEventListener("click", () => {
    stato.seguiGps = true;
    if (stato.gps) {
      impostaCentro(stato.gps.lat, stato.gps.lon, true);
      mappa.fitBounds(L.latLng(stato.gps.lat, stato.gps.lon).toBounds(stato.raggio * 2.1));
    } else toast("Posizione non ancora disponibile.");
  });
  $("btn-aggiorna").addEventListener("click", () => carica(true));
  $("btn-vicino").addEventListener("click", () => {
    const p = piuVicino();
    if (p) mostra(p); else toast("Nessun punto di raccolta in questo raggio.");
  });

  $("raggio").value = String(stato.raggio);
  $("raggio").addEventListener("change", (e) => {
    stato.raggio = +e.target.value;
    salvaPref("raggio", stato.raggio);
    if (stato.centro) {
      mappa.fitBounds(L.latLng(stato.centro.lat, stato.centro.lon).toBounds(stato.raggio * 2.1));
      carica();
    }
  });
  function impostaTipo(t) {
    stato.tipo = DL.TIPI[t] ? t : "tutti";
    $("tipo").value = stato.tipo;
    salvaPref("tipo", stato.tipo);
    mappa.closePopup();
    ricalcola();
  }
  $("tipo").value = stato.tipo;
  $("tipo").addEventListener("change", (e) => {
    impostaTipo(e.target.value);
    toast("Ora vedi: " + DL.TIPI[stato.tipo].breve);
  });

  function apriElenco() {
    $("pannello").hidden = false;
    $("btn-elenco").setAttribute("aria-expanded", "true");
    $("btn-chiudi").focus();
  }
  function chiudiElenco() {
    if ($("pannello").hidden) return false;
    $("pannello").hidden = true;
    $("btn-elenco").setAttribute("aria-expanded", "false");
    $("btn-elenco").focus();
    return true;
  }
  $("btn-elenco").addEventListener("click", apriElenco);
  $("btn-chiudi").addEventListener("click", chiudiElenco);

  // ---------- Guida ----------
  let tornaA = null;
  function apriGuida(e) {
    tornaA = e && e.currentTarget ? e.currentTarget : $("btn-guida");
    $("guida").hidden = false;
    $("guida").querySelector(".pannello-corpo").scrollTop = 0;
    $("btn-guida").setAttribute("aria-expanded", "true");
    $("btn-chiudi-guida").focus();
  }
  function chiudiGuida() {
    if ($("guida").hidden) return false;
    $("guida").hidden = true;
    $("btn-guida").setAttribute("aria-expanded", "false");
    if (tornaA && tornaA.offsetParent) tornaA.focus();
    return true;
  }
  $("btn-guida").addEventListener("click", apriGuida);
  $("btn-guida-elenco").addEventListener("click", apriGuida);
  $("btn-chiudi-guida").addEventListener("click", chiudiGuida);
  $("guida").querySelectorAll(".g-indice a").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const dest = $("guida").querySelector(a.getAttribute("href"));
    if (dest) dest.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $("guida-versione").textContent = "Versione " + (cfg.versione || "");
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !chiudiGuida() && !chiudiRiconosci()) chiudiElenco();
  });

  // ---------- Lettura vocale ----------
  let letturaAttiva = leggiPref("lettura", "1") !== "0";
  const sintesi = window.speechSynthesis;
  function vocItaliana() {
    const voci = sintesi ? sintesi.getVoices() : [];
    return voci.find((v) => /^it[-_]IT/i.test(v.lang) && v.localService) || voci.find((v) => /^it/i.test(v.lang)) || null;
  }
  function leggi(testo) {
    if (!letturaAttiva || !sintesi || !testo) return;
    sintesi.cancel();
    const u = new SpeechSynthesisUtterance(testo);
    u.lang = "it-IT";
    const v = vocItaliana();
    if (v) u.voice = v;
    u.rate = 1;
    sintesi.speak(u);
  }
  mappa.on("popupopen", (e) => {
    const el = e.popup.getElement && e.popup.getElement();
    const pop = el ? el.querySelector(".pop") : null;
    if (pop) leggi(pop.dataset.voce);
  });
  mappa.on("popupclose", () => { if (sintesi) sintesi.cancel(); });
  if (!sintesi) { $("riga-lettura").hidden = true; }
  $("lettura").value = letturaAttiva ? "1" : "0";
  $("lettura").addEventListener("change", (e) => {
    letturaAttiva = e.target.value === "1";
    salvaPref("lettura", letturaAttiva ? "1" : "0");
    if (letturaAttiva) leggi("Lettura vocale attiva.");
    else if (sintesi) sintesi.cancel();
  });

  // ---------- Comune e chiave di Claude ----------
  $("comune").value = leggiPref("comune", "");
  $("comune").addEventListener("change", (e) => salvaPref("comune", e.target.value.trim()));
  const chiave = () => leggiPref("chiave", "").trim();
  function mostraStatoChiave() {
    const ok = /^sk-ant-/.test(chiave());
    $("chiave-stato").textContent = ok
      ? "Chiave salvata: puoi riconoscere i rifiuti dalla foto. Resta solo su questo telefono."
      : "Serve solo per riconoscere i rifiuti dalla foto. Resta solo su questo telefono.";
    $("chiave-stato").classList.toggle("ok", ok);
  }
  $("chiave").value = chiave();
  $("chiave").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (v && !/^sk-ant-/.test(v)) toast("La chiave di Claude inizia con sk-ant-");
    salvaPref("chiave", v);
    mostraStatoChiave();
  });
  mostraStatoChiave();

  // =====================================================================
  // ---------- Dove lo butto? ----------
  // =====================================================================
  let dizionario = [];
  fetchJson("dizionario.json?v=" + (cfg.versione || ""), {}, 15000)
    .then((d) => { dizionario = d.voci || []; if ($("cerca-rifiuto").value) suggerisci(); })
    .catch(() => { /* l'elenco resta vuoto: funzionano codice a barre e foto */ });

  $("legenda").innerHTML = Object.entries(DL.BIDONI)
    .map(([k, b]) => `<div><span class="pallino b-${k}"></span>${esc(b.nome)}</div>`).join("");

  function statoRic(testo, errore) {
    const el = $("stato-riconosci");
    el.textContent = testo;
    el.classList.toggle("errore", !!errore);
  }

  function apriRiconosci() {
    $("riconosci").hidden = false;
    $("btn-riconosci").setAttribute("aria-expanded", "true");
    $("riconosci").querySelector(".pannello-corpo").scrollTop = 0;
  }
  function chiudiRiconosci() {
    if ($("riconosci").hidden) return false;
    fermaCamera();
    $("riconosci").hidden = true;
    $("btn-riconosci").setAttribute("aria-expanded", "false");
    $("btn-riconosci").focus();
    return true;
  }
  $("btn-riconosci").addEventListener("click", apriRiconosci);
  $("btn-chiudi-riconosci").addEventListener("click", chiudiRiconosci);

  // --- Ricerca nell'elenco dei rifiuti ---
  function suggerisci() {
    const q = $("cerca-rifiuto").value;
    const ol = $("suggerimenti");
    ol.innerHTML = "";
    if (!q.trim()) { ol.hidden = true; return; }
    const ris = DL.cercaRifiuto(dizionario, q, 8);
    for (const { voce: v, nome } of ris) {
      const li = document.createElement("li");
      li.tabIndex = 0;
      const k = DL.bidone(v[1]);
      li.innerHTML = `<span class="pallino b-${k}"></span><b>${esc(nome)}</b><small>${esc(DL.BIDONI[k].breve)}</small>`;
      const scegli = () => { ol.hidden = true; $("cerca-rifiuto").blur(); mostraScheda(DL.schedaDaVoce(v, nome)); };
      li.addEventListener("click", scegli);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); scegli(); } });
      ol.appendChild(li);
    }
    if (!ris.length) {
      const li = document.createElement("li");
      li.className = "vuoto";
      li.textContent = chiave()
        ? "Non è nel mio elenco. Premi Invio per chiederlo a Claude, o scatta una foto."
        : "Non è nel mio elenco. Prova con un'altra parola o inquadra il codice a barre.";
      ol.appendChild(li);
    }
    ol.hidden = false;
  }
  $("cerca-rifiuto").addEventListener("input", suggerisci);
  $("form-rifiuto").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("cerca-rifiuto").value.trim();
    if (!q) return;
    const [primo] = DL.cercaRifiuto(dizionario, q, 1);
    $("suggerimenti").hidden = true;
    $("cerca-rifiuto").blur();
    if (primo) mostraScheda(DL.schedaDaVoce(primo.voce, primo.nome));
    else if (chiave()) chiediClaude({ testo: q });
    else statoRic("“" + q + "” non è nel mio elenco. Prova con un'altra parola, inquadra il codice a barre o inserisci la chiave di Claude per chiederlo a lui.", true);
  });

  // --- Scheda del risultato ---
  function mostraScheda(r) {
    const el = $("scheda");
    statoRic("");
    if (!r.contenitore) {
      el.innerHTML = `<article class="scheda"><div class="scheda-testa b-indiff">
          <div class="eyebrow">Prodotto trovato</div><div class="bidone">${esc(r.oggetto)}</div></div>
        <div class="scheda-corpo">
          <p>Il prodotto è nella banca dati di ${esc(r.fonte)}, ma senza i materiali della confezione.</p>
          <p>Scrivi il tipo di confezione qui sopra (per esempio "vasetto yogurt") o scatta una foto.</p>
          ${r.codice ? `<p class="fonte">Codice ${esc(r.codice)} · <a href="https://it.openfoodfacts.org/prodotto/${esc(r.codice)}" target="_blank" rel="noopener">aggiungi i materiali su Open Food Facts</a></p>` : ""}
        </div></article>`;
      SUONO.errore();
      return;
    }
    const k = DL.bidone(r.contenitore);
    const b = DL.BIDONI[k];
    const conf = { alta: "", media: "Probabile", bassa: "Incerto" }[r.confidenza] || "";
    const parti = (r.parti || []).filter((p) => p && p.parte);
    const passi = (r.preparazione || []).filter(Boolean);
    const dove = k === "speciale" ? (DL.TIPI[r.dove] && r.dove !== "tutti" ? r.dove : DL.doveSpeciale([r.oggetto, r.motivo, r.materiale].join(" "))) : "";
    const righe = [];
    if (r.materiale) righe.push(`<p class="materiale">Materiale: <b>${esc(r.materiale)}</b>${r.sigla ? " · " + esc(r.sigla) : ""}</p>`);
    if (r.motivo) righe.push(`<p>${esc(r.motivo)}</p>`);
    if (passi.length) righe.push(`<h4>Prima di buttarlo</h4><ul class="passi">${passi.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`);
    if (parti.length > 1) {
      righe.push(`<h4>Separa le parti</h4><ul class="parti">${parti.map((p) => {
        const kp = DL.bidone(p.contenitore);
        return `<li><span class="pallino b-${kp}"></span><div><b>${esc(p.parte)}</b><small>${esc(p.materiale || "")} → ${esc(DL.BIDONI[kp].nome)}</small></div></li>`;
      }).join("")}</ul>`);
    }
    if (r.attenzione) righe.push(`<p class="avviso-lieve">${esc(r.attenzione)}</p>`);
    const azioni = [];
    if (dove) azioni.push(`<button class="btn btn-grande btn-blu" type="button" data-dove="${dove}">Dove portarlo: il punto più vicino</button>`);
    righe.push(`<p class="fonte">Fonte: ${esc(r.fonte || "")}${r.codice ? " · codice " + esc(r.codice) : ""}. Vale sempre la regola del tuo comune.</p>`);
    el.innerHTML = `<article class="scheda">
      <div class="scheda-testa b-${k}">
        <div class="eyebrow">${conf ? esc(conf) + ": va in" : "Va in"}</div>
        <div class="bidone">${esc(r.contenitore_nome || b.nome)}</div>
        <div class="oggetto">${esc(r.oggetto)}</div>
      </div>
      <div class="scheda-corpo">${righe.join("")}${azioni.length ? `<div class="scheda-azioni">${azioni.join("")}</div>` : ""}</div>
    </article>`;
    const btn = el.querySelector("[data-dove]");
    if (btn) btn.addEventListener("click", () => portamiAlPunto(btn.dataset.dove));
    SUONO.aggiornato();
    leggi(`${r.oggetto}: ${r.contenitore_nome || b.nome}. ${r.motivo || ""}`);
    el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }

  // Dal risultato alla mappa: filtra il tipo e apre il punto più vicino
  function portamiAlPunto(tipo) {
    chiudiRiconosci();
    impostaTipo(tipo);
    const apriVicino = () => {
      const p = piuVicino();
      if (p) mostra(p);
      else toast("Nessun punto per " + DL.TIPI[tipo].breve + " entro " + DL.formattaDistanza(stato.raggio) + ". Prova ad allargare il raggio.");
    };
    if (stato.caricando || !stato.centro) stato.dopoCarica = apriVicino;
    else apriVicino();
  }

  // --- Codice a barre ---
  let flusso = null, giroScan = 0, lettore = null;
  function fermaCamera() {
    giroScan++;
    if (flusso) flusso.getTracks().forEach((t) => t.stop());
    flusso = null;
    $("video").srcObject = null;
    $("camera").hidden = true;
    $("btn-codice").classList.remove("attivo");
    $("btn-codice-testo").textContent = "Codice a barre";
  }
  function caricaScript(src) {
    return new Promise((ok, ko) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = ko;
      document.head.appendChild(s);
    });
  }
  // Lettore: quello del telefono (BarcodeDetector) se c'è, altrimenti ZXing (iPhone)
  async function preparaLettore() {
    if (lettore) return lettore;
    const formati = ["ean_13", "ean_8", "upc_a", "upc_e"];
    if ("BarcodeDetector" in window) {
      try {
        const ok = await BarcodeDetector.getSupportedFormats();
        if (formati.some((f) => ok.includes(f))) {
          const det = new BarcodeDetector({ formats: formati.filter((f) => ok.includes(f)) });
          lettore = async (video) => { const r = await det.detect(video); return r[0] ? r[0].rawValue : null; };
          return lettore;
        }
      } catch (e) { /* passa a ZXing */ }
    }
    if (!window.ZXing) await caricaScript("zxing.min.js?v=" + (cfg.versione || ""));
    const Z = window.ZXing;
    const suggerimenti = new Map();
    suggerimenti.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]);
    suggerimenti.set(Z.DecodeHintType.TRY_HARDER, true);
    const zx = new Z.MultiFormatReader();
    zx.setHints(suggerimenti);
    const tela = document.createElement("canvas");
    lettore = async (video) => {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return null;
      // solo la fascia centrale, dove c'è il mirino
      const cw = Math.round(w * 0.8), ch = Math.round(h * 0.45);
      tela.width = cw; tela.height = ch;
      tela.getContext("2d", { willReadFrequently: true }).drawImage(video, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, cw, ch);
      try {
        const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(tela)));
        return zx.decode(bmp).getText();
      } catch (e) { return null; }
    };
    return lettore;
  }
  async function avviaCodice() {
    if (flusso) { fermaCamera(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      statoRic("Questo browser non permette di usare la fotocamera. Scrivi il nome del rifiuto o usa Foto.", true);
      return;
    }
    statoRic("Accendo la fotocamera…");
    try {
      flusso = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
      flusso = null;
      statoRic(e && e.name === "NotAllowedError"
        ? "Fotocamera non autorizzata. Consenti l'accesso alla fotocamera nelle impostazioni del browser."
        : "Non riesco ad accendere la fotocamera.", true);
      return;
    }
    const video = $("video");
    video.srcObject = flusso;
    $("camera").hidden = false;
    $("btn-codice").classList.add("attivo");
    $("btn-codice-testo").textContent = "Ferma";
    try { await video.play(); } catch (e) { /* parte al tocco */ }
    statoRic("Inquadra il codice a barre dentro il riquadro.");
    let leggi1;
    try { leggi1 = await preparaLettore(); } catch (e) {
      fermaCamera();
      statoRic("Il lettore di codici a barre non si è caricato. Controlla la connessione.", true);
      return;
    }
    const giro = ++giroScan;
    const ciclo = async () => {
      if (giro !== giroScan || !flusso) return;
      let codice = null;
      try { codice = await leggi1(video); } catch (e) { /* riprova */ }
      if (giro !== giroScan) return;
      if (codice && /^\d{8,14}$/.test(codice)) {
        SUONO.bip();
        if (navigator.vibrate) navigator.vibrate(80);
        fermaCamera();
        cercaProdotto(codice);
        return;
      }
      setTimeout(ciclo, 200);
    };
    ciclo();
  }
  $("btn-codice").addEventListener("click", avviaCodice);

  async function cercaProdotto(codice) {
    statoRic("Cerco il prodotto " + codice + "…");
    $("scheda").innerHTML = "";
    const campi = "product_name,product_name_it,brands,packagings,packaging_materials_tags,packaging_tags,packaging,packaging_text_it";
    const banche = [
      ["https://world.openfoodfacts.org", "Open Food Facts"],
      ["https://world.openbeautyfacts.org", "Open Beauty Facts"],
      ["https://world.openproductsfacts.org", "Open Products Facts"]
    ];
    let trovato = null, errori = 0;
    for (const [sito, nome] of banche) {
      try {
        const r = await fetchJson(`${sito}/api/v2/product/${codice}.json?fields=${campi}`, {}, 12000);
        if (r && r.status === 1 && r.product) {
          trovato = DL.schedaDaProdotto(r.product, codice);
          if (trovato) { trovato.fonte = nome; if (trovato.contenitore) break; }
        }
      } catch (e) { errori++; }
    }
    if (trovato) { mostraScheda(trovato); return; }
    SUONO.errore();
    statoRic(errori === banche.length
      ? "Non riesco a cercare il prodotto: controlla la connessione."
      : "Prodotto " + codice + " non trovato. Scrivi cosa devi buttare qui sopra o scatta una foto.", true);
  }

  // --- Foto riconosciuta da Claude ---
  $("btn-foto").addEventListener("click", () => {
    if (!chiave()) {
      // Senza chiave: apre la pagina Claude che usa l'account Claude dell'utente
      fermaCamera();
      window.open(cfg.paginaClaude, "_blank", "noopener");
      statoRic("Ho aperto la pagina di Claude: scatta lì la foto. Usa il tuo account Claude, senza chiave e senza costi in più.");
      return;
    }
    fermaCamera();
    $("file-foto").click();
  });
  $("file-foto").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dati = await riduciFoto(file);
      chiediClaude({ immagine: dati });
    } catch (err) {
      statoRic("Non riesco a leggere la foto. Riprova.", true);
    }
  });

  // Rimpicciolisce la foto (lato lungo 1280 px) e la restituisce in base64 JPEG
  function riduciFoto(file) {
    return new Promise((ok, ko) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scala = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * scala);
        c.height = Math.round(img.naturalHeight * scala);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
      };
      img.onerror = () => { URL.revokeObjectURL(url); ko(new Error("immagine")); };
      img.src = url;
    });
  }

  function domandaClaude(testo, conFoto) {
    const comune = leggiPref("comune", "").trim();
    return `Sei un esperto di raccolta differenziata in Italia.
${conFoto ? "La foto mostra un oggetto da buttare." : `L'utente deve buttare: "${testo}".`}
${comune ? `L'utente vive nel comune di ${comune}: se conosci regole specifiche di quel comune o del suo gestore, applicale e dillo in "attenzione".` : "Usa le regole più diffuse in Italia."}
Individua l'oggetto, il materiale principale (con la sigla di riciclo se visibile o probabile, es. PET 1, PP 5, PAP 20, ALU 41, GL 70) e il contenitore giusto.
Se l'oggetto ha parti di materiali diversi, elencale con il contenitore di ognuna.
Rispondi SOLO con un oggetto JSON in italiano, senza altro testo:
{"oggetto": string breve, "materiale": string, "sigla": string o "", "contenitore": una tra "plastica"|"carta"|"vetro"|"organico"|"indiff"|"speciale", "contenitore_nome": string (es. "Plastica e metalli"), "motivo": una frase, "preparazione": [al massimo 3 frasi brevi], "parti": [{"parte": string, "materiale": string, "contenitore": stessa scelta}], "dove": per "speciale" una tra "centro"|"farmaci"|"pile"|"raee"|"olio"|"abiti", altrimenti "", "attenzione": string o "", "confidenza": "alta"|"media"|"bassa"}
${conFoto ? 'Se la foto non mostra un rifiuto riconoscibile, usa confidenza "bassa" e spiega in "attenzione" come rifare la foto.' : ""}`;
  }

  let giroClaude = 0;
  async function chiediClaude({ testo, immagine }) {
    const giro = ++giroClaude;
    $("scheda").innerHTML = "";
    statoRic(immagine ? "Claude sta guardando la foto…" : "Chiedo a Claude…");
    const contenuto = [];
    if (immagine) contenuto.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: immagine } });
    contenuto.push({ type: "text", text: domandaClaude(testo, !!immagine) });
    let risposta;
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": chiave(),
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "server-side-fallback-2026-07-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: cfg.modelloClaude || "claude-opus-5-5",
          max_tokens: 4000,
          output_config: { effort: "low" },
          fallbacks: "default",
          messages: [{ role: "user", content: contenuto }]
        })
      });
      risposta = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (risposta.error && risposta.error.message) || "";
        throw new Error(r.status === 401 ? "chiave"
          : r.status === 429 ? "troppe"
          : /credit|balance/i.test(msg) ? "credito"
          : "servizio:" + r.status + " " + msg);
      }
    } catch (e) {
      if (giro !== giroClaude) return;
      SUONO.errore();
      const m = String(e.message || "");
      statoRic(m === "chiave" ? "La chiave di Claude non è valida. Controllala nella pagina Elenco."
        : m === "troppe" ? "Troppe richieste in poco tempo. Riprova tra un minuto."
        : m === "credito" ? "Il credito della tua chiave di Claude è finito: ricaricalo su platform.claude.com."
        : m.startsWith("servizio") ? "Claude non ha risposto (" + m.slice(9) + "). Riprova più tardi."
        : "Non riesco a contattare Claude: controlla la connessione.", true);
      return;
    }
    if (giro !== giroClaude) return;
    if (risposta.stop_reason === "refusal") {
      SUONO.errore();
      statoRic("Claude non ha potuto analizzare questa richiesta. Prova con un'altra foto o scrivi il nome del rifiuto.", true);
      return;
    }
    const testoRisposta = (risposta.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    let dati = null;
    try {
      const a = testoRisposta.indexOf("{"), b = testoRisposta.lastIndexOf("}");
      dati = JSON.parse(testoRisposta.slice(a, b + 1));
    } catch (e) { dati = null; }
    if (!dati || !dati.contenitore) {
      SUONO.errore();
      statoRic("Non ho capito la risposta di Claude. Riprova.", true);
      return;
    }
    dati.contenitore = DL.bidone(dati.contenitore);
    dati.fonte = "Claude (Anthropic), può sbagliare";
    mostraScheda(dati);
  }

  // ---------- Auto-refresh ----------
  // Ogni N secondi torna sulla tua posizione e ricalcola i punti vicini.
  // I dati vengono riscaricati solo se il sito ne ha di nuovi (controllo ogni 15 minuti).
  let timerAuto;
  function autoAggiorna() {
    if (document.hidden || !stato.gps || !$("riconosci").hidden) return;
    stato.seguiGps = true;
    stato.centro = { lat: stato.gps.lat, lon: stato.gps.lon, daGps: true };
    mappa.setView([stato.gps.lat, stato.gps.lon], Math.max(mappa.getZoom(), 13));
    carica(false, true);
  }
  function impostaAuto(sec) {
    clearInterval(timerAuto);
    if (sec > 0) timerAuto = setInterval(autoAggiorna, sec * 1000);
    autoAttivo = sec > 0;
    aggiornaSchermoAcceso();
    salvaPref("auto", sec);
  }

  // ---------- Schermo sempre acceso (Wake Lock) ----------
  let autoAttivo = false, bloccoSchermo = null, richiestaInCorso = false;
  function mostraOcchio() { $("occhio").hidden = !bloccoSchermo; }
  async function aggiornaSchermoAcceso() {
    const vuole = autoAttivo && document.visibilityState === "visible";
    if (!vuole) {
      if (bloccoSchermo) { const b = bloccoSchermo; bloccoSchermo = null; b.release().catch(() => {}); }
      mostraOcchio();
      return;
    }
    if (bloccoSchermo || richiestaInCorso || !("wakeLock" in navigator)) { mostraOcchio(); return; }
    richiestaInCorso = true;
    try {
      const b = await navigator.wakeLock.request("screen");
      b.addEventListener("release", () => { if (bloccoSchermo === b) { bloccoSchermo = null; mostraOcchio(); } });
      if (autoAttivo && document.visibilityState === "visible") bloccoSchermo = b;
      else b.release().catch(() => {});
    } catch (e) { /* non supportato o negato: l'app funziona lo stesso */ }
    richiestaInCorso = false;
    mostraOcchio();
  }
  document.addEventListener("visibilitychange", () => {
    aggiornaSchermoAcceso();
    if (document.hidden) fermaCamera();
  });
  document.addEventListener("pointerdown", () => { if (autoAttivo && !bloccoSchermo) aggiornaSchermoAcceso(); }, { passive: true });
  $("occhio").addEventListener("click", () => toast("Schermo sempre acceso finché l'AUTO-REFRESH è attivo"));

  let secAuto = cfg.autoRefreshSecondi ?? 0;
  const salvato = leggiPref("auto", null);
  if (salvato !== null && ["0", "30", "60", "120"].includes(salvato)) secAuto = +salvato;
  $("auto-refresh").value = String(secAuto);
  impostaAuto(secAuto);
  $("auto-refresh").addEventListener("change", (e) => {
    impostaAuto(+e.target.value);
    toast(+e.target.value ? `Auto-refresh ogni ${e.target.value} secondi` : "Auto-refresh disattivato");
  });
  $("sfondo").value = sfondoAttivo;
  $("sfondo").addEventListener("change", (e) => impostaSfondo(e.target.value));
  $("suoni").value = suoniAttivi ? "1" : "0";
  $("suoni").addEventListener("change", (e) => {
    suoniAttivi = e.target.value === "1";
    salvaPref("suoni", suoniAttivi ? "1" : "0");
    sbloccaAudio();
    if (suoniAttivi) setTimeout(SUONO.aggiornato, 150); // prova
  });

  // Ogni 15 minuti controlla se il sito ha dati nuovi
  setInterval(() => { if (stato.centro && !stato.caricando && !document.hidden) carica(false, true); }, 15 * 60000);

  // Numero di versione lungo la diagonale della mappa
  $("filigrana-testo").textContent = "Versione " + (cfg.versione || "");
  function posizionaFiligrana() {
    const f = $("filigrana"), w = f.clientWidth, h = f.clientHeight;
    if (!w || !h) return;
    const diag = Math.hypot(w, h);
    f.style.setProperty("--fil-ang", (Math.atan2(h, w) * 180 / Math.PI).toFixed(1) + "deg");
    f.style.setProperty("--fil-size", Math.round(diag / 10.5) + "px");
  }
  posizionaFiligrana();
  window.addEventListener("resize", posizionaFiligrana);

  $("btn-vicino").disabled = true;
  avviaGps();
  if (location.hash === "#butto") apriRiconosci();

  if ("serviceWorker" in navigator && window.isSecureContext) {
    const cerano = !!navigator.serviceWorker.controller;
    let ricaricata = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (cerano && !ricaricata) { ricaricata = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js").then((reg) => reg.update()).catch(() => {});
  }
})();
