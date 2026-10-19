/*
 * Rifiuti – logica pura (nessun accesso a DOM o rete).
 * Funziona sia nel browser (window.DL) sia in Node (module.exports) per i test.
 */
(function (root) {
  "use strict";

  const R_TERRA = 6371000;

  function distanza(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R_TERRA * Math.asin(Math.sqrt(a));
  }

  function formattaDistanza(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + " m";
    return (m / 1000).toFixed(1).replace(".", ",") + " km";
  }

  // Minuti in auto, stima prudente in città (circa 30 km/h)
  function minutiInAuto(m) {
    return Math.max(1, Math.round(m / 500));
  }

  // ---------- Contenitori della differenziata ----------
  // I colori sono quelli più diffusi in Italia: ogni comune può usarne altri.
  const BIDONI = {
    plastica: { nome: "Plastica e metalli", breve: "plastica" },
    carta: { nome: "Carta e cartone", breve: "carta" },
    vetro: { nome: "Vetro", breve: "vetro" },
    organico: { nome: "Organico (umido)", breve: "organico" },
    indiff: { nome: "Indifferenziato (secco)", breve: "indifferenziato" },
    speciale: { nome: "Raccolta speciale", breve: "raccolta speciale" }
  };
  const ALIAS_BIDONI = {
    plastica: "plastica", metalli: "plastica", metallo: "plastica", lattine: "plastica",
    carta: "carta", cartone: "carta", vetro: "vetro", organico: "organico", umido: "organico",
    indifferenziato: "indiff", indiff: "indiff", secco: "indiff", residuo: "indiff",
    speciale: "speciale", raee: "speciale", pericolosi: "speciale"
  };
  function bidone(k) {
    if (BIDONI[k]) return k;
    const parola = normalizza(k).split(/[^a-z]/)[0];
    return ALIAS_BIDONI[parola] || "indiff";
  }

  // ---------- Punti di raccolta sulla mappa (da OpenStreetMap) ----------
  const TIPI = {
    tutti: { nome: "Tutti", breve: "tutti i punti di raccolta" },
    centro: { nome: "Centri", lungo: "Centro di raccolta", breve: "centri di raccolta (isole ecologiche)", sigla: "CR", cls: "blu" },
    farmaci: { nome: "Farmaci", lungo: "Farmacia (farmaci scaduti)", breve: "farmacie per i farmaci scaduti", sigla: "F", cls: "verde" },
    pile: { nome: "Pile", lungo: "Contenitore pile", breve: "contenitori per le pile", sigla: "P", cls: "rosso" },
    raee: { nome: "Elettronici", lungo: "Raccolta elettronici (RAEE)", breve: "punti per elettronici e lampadine", sigla: "E", cls: "rosso" },
    olio: { nome: "Olio", lungo: "Olio da cucina", breve: "contenitori per l'olio da cucina", sigla: "O", cls: "giallo" },
    abiti: { nome: "Abiti", lungo: "Abiti e scarpe usati", breve: "contenitori per abiti e scarpe", sigla: "A", cls: "grigio" },
    vetro: { nome: "Vetro", lungo: "Campana del vetro", breve: "campane del vetro", sigla: "V", cls: "vetro" }
  };
  const ORDINE_TIPI = ["centro", "farmaci", "pile", "raee", "olio", "abiti", "vetro"];

  // Tipo principale di un punto (per colore e sigla del segnaposto)
  function tipoPrincipale(p, filtro) {
    const t = p.t || [];
    if (filtro && filtro !== "tutti" && t.includes(filtro)) return filtro;
    return ORDINE_TIPI.find((x) => t.includes(x)) || "centro";
  }

  // Punti entro il raggio che accettano il tipo scelto, ordinati per distanza.
  // I centri di raccolta accettano quasi tutto, quindi compaiono per ogni tipo (tranne farmaci e vetro).
  function preparaPunti(lista, lat, lon, raggio, filtro) {
    const out = [];
    for (const p of lista || []) {
      const t = p.t || [];
      if (filtro === "tutti" || !filtro) {
        if (t.length === 1 && t[0] === "vetro") continue;   // le campane del vetro solo se scelte: sono ovunque
      } else if (!t.includes(filtro) && !(t.includes("centro") && filtro !== "farmaci" && filtro !== "vetro")) continue;
      const dist = distanza(lat, lon, p.la, p.lo);
      if (dist > raggio) continue;
      out.push({ ...p, id: p.i, distanza: dist, tipo: tipoPrincipale(p, filtro) });
    }
    return out.sort((a, b) => a.distanza - b.distanza);
  }

  function statistiche(lista) {
    return {
      n: lista.length,
      centri: lista.filter((p) => (p.t || []).includes("centro")).length,
      vicino: lista.length ? lista[0].distanza : null
    };
  }

  // Tessere (file del sito) che coprono il cerchio di ricerca
  function tessereNelRaggio(lat, lon, raggio, passo) {
    const dLat = raggio / 111320, dLon = raggio / (111320 * Math.cos(lat * Math.PI / 180));
    const nomi = [];
    for (let i = Math.floor((lat - dLat) / passo); i <= Math.floor((lat + dLat) / passo); i++) {
      for (let j = Math.floor((lon - dLon) / passo); j <= Math.floor((lon + dLon) / passo); j++) {
        nomi.push(`t_${i}_${j}.json`);
      }
    }
    return nomi;
  }

  function titolo(p) {
    return (p.n || "").trim() || TIPI[p.tipo || tipoPrincipale(p)].lungo;
  }
  function capitalizza(s) {
    s = String(s || "").trim();
    if (s && s === s.toUpperCase()) {
      return s.toLowerCase().replace(/(^|[\s'’.\-/(])([a-zà-ù])/g, (m, a, b) => a + b.toUpperCase());
    }
    return s;
  }
  function indirizzo(p) {
    return [capitalizza(p.a || ""), capitalizza(p.c || "")].filter((x) => x.trim()).join(", ");
  }

  // ---------- Ricerca nel dizionario dei rifiuti ----------
  function normalizza(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[’']/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  }
  // Toglie la "s"/vocale finale per far combaciare singolare e plurale (bottiglia/bottiglie)
  const radice = (w) => w.length > 4 ? w.replace(/[aeiou]$/, "") : w;

  // Voci del dizionario: [nome (sinonimi separati da "/"), bidone, nota, dove portarlo].
  // Restituisce {voce, nome}: "nome" è il sinonimo che ha trovato (es. "Tazza" invece di "Pirofila").
  function cercaRifiuto(dizionario, testo, max) {
    const q = normalizza(testo);
    if (!q) return [];
    const parole = q.split(" ").map(radice);
    const ris = [];
    (dizionario || []).forEach((v, ordine) => {
      const nomi = v[0].split("/").map((x) => x.trim());
      let punti = 0, nome = nomi[0];
      for (const orig of nomi) {
        const n = normalizza(orig);
        let p = 0;
        if (n === q) p = 100;
        else if (n.startsWith(q)) p = 60;
        else {
          const pn = n.split(" ").map(radice);
          if (parole.every((x) => pn.some((y) => y.startsWith(x)))) p = 40 - pn.length;
        }
        if (p > punti) { punti = p; nome = orig; }
      }
      if (punti) ris.push({ punti, ordine, voce: v, nome: nome.charAt(0).toUpperCase() + nome.slice(1) });
    });
    ris.sort((a, b) => b.punti - a.punti || a.ordine - b.ordine);
    return ris.slice(0, max || 8).map((r) => ({ voce: r.voce, nome: r.nome }));
  }

  // Scheda risultato da una voce del dizionario
  function schedaDaVoce(v, nome) {
    const nomi = v[0].split("/").map((x) => x.trim());
    return {
      oggetto: nome || nomi[0],
      contenitore: bidone(v[1]),
      motivo: v[2] || "",
      dove: v[3] || "",
      fonte: "Elenco dei rifiuti dell'app"
    };
  }

  // ---------- Materiali dell'imballaggio (Open Food Facts) ----------
  const MATERIALI = [
    // [parole che compaiono nel codice del materiale, nome italiano, bidone]
    [["tetra", "pap-81", "pap-82", "pap-84", "c-pap", "composite", "brick", "poliaccoppiato"], "Poliaccoppiato (tipo Tetra Pak)", "carta"],
    [["compostable", "compostabile", "bioplastic", "pla"], "Plastica compostabile", "organico"],
    [["glass", "vetro", "gl-7"], "Vetro", "vetro"],
    [["aluminium", "aluminum", "alu", "alluminio"], "Alluminio", "plastica"],
    [["steel", "tin", "fe-40", "acciaio", "banda-stagnata", "metal", "metallo"], "Acciaio / metallo", "plastica"],
    [["pet-1", "pet", "polyethylene-terephthalate"], "Plastica PET", "plastica"],
    [["hdpe", "pe-hd", "high-density"], "Plastica HDPE", "plastica"],
    [["ldpe", "pe-ld", "low-density"], "Plastica LDPE", "plastica"],
    [["pp-5", "polypropylene", "polipropilene"], "Plastica PP", "plastica"],
    [["ps-6", "polystyrene", "polistirene", "polistirolo"], "Plastica PS / polistirolo", "plastica"],
    [["pvc"], "Plastica PVC", "plastica"],
    [["plastic", "plastica", "pe", "polyethylene", "o-7", "other-plastics"], "Plastica", "plastica"],
    [["cardboard", "cartone", "pap-20", "pap-21", "corrugated"], "Cartone", "carta"],
    [["paper", "carta", "pap-22", "pap"], "Carta", "carta"],
    [["wood", "legno", "for-50"], "Legno", "indiff"],
    [["cork", "sughero", "for-51"], "Sughero", "organico"],
    [["cotton", "tex", "fabric", "tessuto"], "Tessuto", "indiff"]
  ];
  function materiale(codice) {
    const c = normalizza(String(codice || "").replace(/^[a-z]{2}:/, "")).replace(/ /g, "-");
    if (!c) return null;
    const pezzi = c.split("-");
    // Le sigle corte (pet, pp, alu…) devono essere una parola intera: "pla" non deve trovare "plastic"
    const trova = (p) => (p.length <= 4 && !p.includes("-") ? pezzi.includes(p) : c.includes(p));
    for (const [parole, nome, bin] of MATERIALI) {
      if (parole.some(trova)) return { nome, contenitore: bin };
    }
    return null;
  }
  const FORME = {
    bottle: "Bottiglia", cap: "Tappo", lid: "Coperchio", label: "Etichetta", box: "Scatola", tray: "Vaschetta",
    jar: "Vasetto", can: "Lattina", film: "Pellicola", bag: "Sacchetto", wrapper: "Incarto", packet: "Confezione",
    pot: "Vasetto", tub: "Vaschetta", brick: "Brick", sleeve: "Fascetta", seal: "Sigillo", capsule: "Capsula",
    pouch: "Busta", sachet: "Bustina", cup: "Bicchiere", tube: "Tubetto", "individual-dose": "Monoporzione",
    "bottle-cap": "Tappo", "screw-cap": "Tappo", "pizza-box": "Cartone della pizza", envelope: "Busta"
  };
  function forma(codice) {
    const c = String(codice || "").replace(/^[a-z]{2}:/, "").toLowerCase();
    if (!c) return "";
    if (FORME[c]) return FORME[c];
    const ultimo = c.split("-").pop();
    return FORME[ultimo] || capitalizza(c.replace(/-/g, " "));
  }
  const idDi = (x) => (x && typeof x === "object" ? x.id || x.text || "" : x || "");

  /** Scheda risultato da un prodotto di Open Food Facts (null se non dice nulla dell'imballaggio). */
  function schedaDaProdotto(prod, codice) {
    if (!prod) return null;
    const nome = [prod.product_name_it || prod.product_name, prod.brands && String(prod.brands).split(",")[0]]
      .filter((x) => x && String(x).trim()).join(" – ") || "Prodotto " + codice;
    const parti = [];
    for (const p of prod.packagings || []) {
      const m = materiale(idDi(p.material));
      if (!m) continue;
      parti.push({ parte: forma(idDi(p.shape)) || "Imballaggio", materiale: m.nome, contenitore: m.contenitore });
    }
    if (!parti.length) {
      const tag = [].concat(prod.packaging_materials_tags || [], prod.packaging_tags || [],
        String(prod.packaging_text_it || prod.packaging || "").split(/[,;]/));
      const visti = new Set();
      for (const t of tag) {
        const m = materiale(t);
        if (m && !visti.has(m.nome)) { visti.add(m.nome); parti.push({ parte: "Parte in " + m.nome.toLowerCase(), materiale: m.nome, contenitore: m.contenitore }); }
      }
    }
    if (!parti.length) return { oggetto: nome, contenitore: null, parti: [], fonte: "Open Food Facts", codice };
    // Il bidone principale è quello della parte più "grande" (la prima che non sia tappo/etichetta)
    const principale = parti.find((p) => !/Tappo|Etichetta|Sigillo|Fascetta|Coperchio/.test(p.parte)) || parti[0];
    return {
      oggetto: nome, contenitore: principale.contenitore, materiale: principale.materiale,
      parti: parti.length > 1 ? parti : [], fonte: "Open Food Facts", codice
    };
  }

  // Dove portare un rifiuto speciale, dedotto dal testo se non è indicato
  function doveSpeciale(testo) {
    const t = normalizza(testo);
    if (/farmac|medicin|pastigl|sciropp/.test(t)) return "farmaci";
    if (/\bpil|batteri|accumulator/.test(t)) return "pile";
    if (/olio|frittur/.test(t)) return "olio";
    if (/abit|vestit|scarp|indument|tessil/.test(t)) return "abiti";
    if (/raee|elettr|lampad|telefon|cellular|computer|caricabatt|cavo|led/.test(t)) return "raee";
    return "centro";
  }

  const API = {
    distanza, formattaDistanza, minutiInAuto, BIDONI, bidone, TIPI, ORDINE_TIPI, tipoPrincipale, preparaPunti,
    statistiche, tessereNelRaggio, titolo, capitalizza, indirizzo, normalizza, cercaRifiuto, schedaDaVoce,
    materiale, forma, schedaDaProdotto, doveSpeciale
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.DL = API;
})(typeof window !== "undefined" ? window : globalThis);
