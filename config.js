/*
 * Rifiuti – configurazione
 */
window.RIFIUTI_CONFIG = {
  // Versione dell'app, mostrata in diagonale sulla mappa. Aumentala a ogni aggiornamento
  // (insieme alla cache in sw.js e a ?v= in index.html).
  versione: "1",

  // Raggio di ricerca iniziale in metri (modificabile anche dall'app)
  raggioMetri: 5000,

  // Ricentra e ricalcola quando ti sposti di più di questi metri
  ricaricaDopoMetri: 300,

  // Punti mostrati all'avvio: "tutti", "centro", "farmaci", "pile", "raee", "olio", "abiti", "vetro"
  tipo: "tutti",

  // Auto-refresh predefinito in secondi (0 = spento). Si cambia anche dalla pagina elenco.
  autoRefreshSecondi: 0,

  // Modello di Claude usato per riconoscere i rifiuti dalla foto (serve la chiave personale)
  modelloClaude: "claude-opus-5-5"
};
