"""
Rifiuti – scarica da OpenStreetMap i punti di raccolta in Italia e li prepara per il sito.

Punti scaricati (Overpass API):
  - centri di raccolta / isole ecologiche (amenity=recycling + recycling_type=centre)
  - contenitori per pile, elettronici (RAEE), olio da cucina, abiti, vetro (amenity=recycling + recycling:*=yes)
  - farmacie, dove si portano i farmaci scaduti (amenity=pharmacy)

Il risultato va nella cartella "dati/" del sito, divisa in tessere da 0,25 gradi:
  dati/t_<floor(lat/0.25)>_<floor(lon/0.25)>.json  →  {"d": [punto, ...]}
  dati/indice.json                                  →  data dell'aggiornamento, elenco delle tessere, conteggi
  dati/diagnosi.json                                →  quanti punti per tipo e qualche esempio

Ogni punto: {"i": "n123", "la": 44.49, "lo": 11.34, "t": ["centro"], "n": nome, "o": gestore, "h": orari, "a": via, "c": città}
(i campi vuoti non vengono scritti).

Se OpenStreetMap non risponde, ricopia i dati già pubblicati dal sito (variabile d'ambiente SITO),
così il sito non resta mai vuoto.
"""
import json
import math
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone

CARTELLA = "dati"
PASSO = 0.25          # lato della tessera in gradi
USER_AGENT = "Rifiuti/1.0 (https://github.com/paolo1957-it/Rifiuti)"
SERVER = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

QUERY = """
[out:json][timeout:900][maxsize:1073741824];
area["ISO3166-1"="IT"][admin_level=2]->.italia;
(
  nwr["amenity"="recycling"](area.italia);
  nwr["amenity"="pharmacy"](area.italia);
);
out center tags qt;
"""

SI = {"yes", "si", "sì", "true", "1"}


def si(tags, *chiavi):
    return any(str(tags.get(k, "")).strip().lower() in SI for k in chiavi)


def tipi(tags):
    """Tipi di rifiuto accettati dal punto (vuoto = punto non utile per l'app)."""
    if tags.get("amenity") == "pharmacy":
        return ["farmaci"]
    if tags.get("recycling_type") == "centre":
        t = ["centro"]
        if si(tags, "recycling:medicines", "recycling:drugs"):
            t.append("farmaci")
        return t
    t = []
    if si(tags, "recycling:medicines", "recycling:drugs"):
        t.append("farmaci")
    if si(tags, "recycling:batteries", "recycling:car_batteries"):
        t.append("pile")
    if si(tags, "recycling:electrical_items", "recycling:small_appliances", "recycling:small_electrical_appliances",
          "recycling:electrical_appliances", "recycling:mobile_phones", "recycling:computers",
          "recycling:low_energy_bulbs", "recycling:fluorescent_tubes", "recycling:light_bulbs"):
        t.append("raee")
    if si(tags, "recycling:cooking_oil", "recycling:engine_oil"):
        t.append("olio")
    if si(tags, "recycling:clothes", "recycling:shoes"):
        t.append("abiti")
    if si(tags, "recycling:glass_bottles", "recycling:glass"):
        t.append("vetro")
    return t


def scarica_osm():
    dati = urllib.parse.urlencode({"data": QUERY}).encode("utf-8")
    ultimo = None
    for giro in range(2):
        for url in SERVER:
            try:
                print(f"  chiedo a {url} …", flush=True)
                req = urllib.request.Request(url, data=dati, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=1200) as r:
                    risposta = json.loads(r.read().decode("utf-8"))
                elementi = risposta.get("elements", [])
                print(f"  ricevuti {len(elementi)} elementi")
                if risposta.get("remark"):
                    print(f"  nota del server: {risposta['remark']}")
                if len(elementi) < 1000:
                    raise ValueError(f"troppo pochi elementi ({len(elementi)})")
                return elementi
            except Exception as ex:
                print(f"  {url}: {ex}")
                ultimo = ex
                time.sleep(20)
    raise RuntimeError(f"nessun server Overpass ha risposto: {ultimo}")


def costruisci(elementi):
    punti, scartati, conta = [], Counter(), Counter()
    for el in elementi:
        tags = el.get("tags") or {}
        lat = el.get("lat", (el.get("center") or {}).get("lat"))
        lon = el.get("lon", (el.get("center") or {}).get("lon"))
        if lat is None or lon is None:
            scartati["senza coordinate"] += 1
            continue
        t = tipi(tags)
        if not t:
            scartati["solo carta/plastica o tipo non indicato"] += 1
            continue
        if tags.get("disused:amenity") or tags.get("access") in ("private", "no"):
            scartati["privato o dismesso"] += 1
            continue
        via = " ".join(x for x in (tags.get("addr:street", ""), tags.get("addr:housenumber", "")) if x).strip()
        citta = tags.get("addr:city") or tags.get("addr:place") or ""
        p = {
            "i": el["type"][0] + str(el["id"]),
            "la": round(lat, 6),
            "lo": round(lon, 6),
            "t": t,
            "n": (tags.get("name") or "").strip(),
            "o": (tags.get("operator") or "").strip(),
            "h": (tags.get("opening_hours") or "").strip(),
            "a": via,
            "c": citta.strip(),
        }
        # Per farmacie e campane del vetro il gestore non serve: dati più leggeri
        if t in (["farmaci"], ["vetro"]):
            p["o"] = ""
        punti.append({k: v for k, v in p.items() if v not in ("", None, [])})
        for x in t:
            conta[x] += 1
    print(f"  {len(punti)} punti utili; per tipo: {dict(conta)}; scartati: {dict(scartati)}")
    return punti, conta, scartati


def nome_tessera(lat, lon):
    return f"t_{math.floor(lat / PASSO)}_{math.floor(lon / PASSO)}.json"


def salva(punti, conta, diagnosi):
    if os.path.isdir(CARTELLA):
        shutil.rmtree(CARTELLA)
    os.makedirs(CARTELLA)
    tessere = {}
    for p in punti:
        tessere.setdefault(nome_tessera(p["la"], p["lo"]), []).append(p)
    for t, lista in tessere.items():
        with open(os.path.join(CARTELLA, t), "w", encoding="utf-8") as f:
            json.dump({"d": lista}, f, separators=(",", ":"), ensure_ascii=False)
    indice = {
        "passo": PASSO,
        "aggiornato": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "punti": len(punti),
        "per_tipo": dict(conta),
        "tessere": sorted(tessere),
        "fonte": "© OpenStreetMap e i suoi volontari (ODbL)",
    }
    with open(os.path.join(CARTELLA, "indice.json"), "w", encoding="utf-8") as f:
        json.dump(indice, f, indent=1, ensure_ascii=False)
    with open(os.path.join(CARTELLA, "diagnosi.json"), "w", encoding="utf-8") as f:
        json.dump(diagnosi, f, indent=1, ensure_ascii=False)
    print(f"  salvate {len(tessere)} tessere")


class MaiPubblicato(Exception):
    """Il sito non ha ancora dati pubblicati (primo avvio)."""


def recupera_dal_sito(sito):
    """Piano B: copia i dati già pubblicati sul sito (quelli dell'aggiornamento precedente)."""
    if not sito:
        raise RuntimeError("indirizzo del sito non indicato")
    sito = sito.rstrip("/") + "/"
    print(f"Recupero i dati già pubblicati da {sito}{CARTELLA}/ …")

    def scarica(url):
        for i in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=60) as r:
                    return r.read()
            except urllib.error.HTTPError as ex:
                print(f"  {url}: {ex}")
                if ex.code == 404:
                    raise MaiPubblicato(url)
                time.sleep(5)
            except Exception as ex:
                print(f"  {url}: {ex}")
                time.sleep(5)
        raise RuntimeError(f"{url} non recuperato")
    indice = json.loads(scarica(f"{sito}{CARTELLA}/indice.json").decode("utf-8"))
    if os.path.isdir(CARTELLA):
        shutil.rmtree(CARTELLA)
    os.makedirs(CARTELLA)
    for t in indice["tessere"]:
        with open(os.path.join(CARTELLA, t), "wb") as f:
            f.write(scarica(f"{sito}{CARTELLA}/{t}"))
    with open(os.path.join(CARTELLA, "indice.json"), "w", encoding="utf-8") as f:
        json.dump(indice, f, indent=1, ensure_ascii=False)
    print(f"  recuperate {len(indice['tessere'])} tessere dell'aggiornamento {indice.get('aggiornato')}")


def main():
    try:
        print("Scarico i punti di raccolta da OpenStreetMap…")
        elementi = scarica_osm()
        punti, conta, scartati = costruisci(elementi)
        if len(punti) < 1000:
            raise ValueError(f"troppo pochi punti ({len(punti)}): dati incompleti?")
        chiavi = Counter(k for el in elementi for k in (el.get("tags") or {}) if k.startswith("recycling"))
        diagnosi = {
            "elementi": len(elementi), "per_tipo": dict(conta), "scartati": dict(scartati),
            "chiavi_recycling": dict(chiavi.most_common(60)),
            "esempi": {t: [p for p in punti if t in p["t"]][:3] for t in conta},
        }
        salva(punti, conta, diagnosi)
    except Exception as ex:
        print(f"OpenStreetMap non disponibile: {ex}")
        try:
            recupera_dal_sito(os.environ.get("SITO"))
        except MaiPubblicato:
            # Primo avvio: si pubblica l'app con i dati vuoti, i punti arriveranno al prossimo aggiornamento
            print("Il sito non ha ancora dati: pubblico l'app senza punti di raccolta.")
            salva([], Counter(), {"nota": "primo avvio senza dati da OpenStreetMap"})
        except Exception as ex2:
            print(f"Nessun dato disponibile: {ex2}. Il sito resta com'era.")
            sys.exit(1)


if __name__ == "__main__":
    main()
