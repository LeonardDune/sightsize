# SightSize

Een schildershulpmiddel om te leren zien en te vergelijken. Je legt een foto van je
**blockin-schets** over je **referentie** — op sight-size schaal — en controleert met een
reeks tools hoe nauwkeurig je vormen, verhoudingen, waarden en kleuren kloppen.

SightSize draait volledig in je browser. Er is geen server, geen account en geen upload:
je foto's blijven op je eigen apparaat. Het is bewust géén fotobewerker — je kijkt,
vergelijkt, meet en analyseert, maar je bewerkt de referentie niet.

---

## Wat kun je ermee?

- Een referentie en een schetsfoto **over elkaar leggen** en met dekking of flikkeren vergelijken.
- Een **scheve foto rechttrekken** (perspectiefcorrectie) door de vier hoekpunten aan te wijzen.
- De schets **uitlijnen** op de referentie met twee ankerpunten, en **meten** met afwijking in % of cm.
- De referentie zien in **grijswaarden, waarden (posterize), notan, kleurtemperatuur of verzadiging**, en één waardeband **isoleren**.
- Zelf een **blockin tekenen**: rechte contourlijnen én gevulde **waardenvlakken**.
- **Kleur en waarde sampelen**, een dominante-kleurenpalet bepalen, en een **mengrecept** krijgen op basis van je eigen verfdoos.
- Meerdere **schetsversies** en **tekenlagen** bijhouden, sessies **opslaan** en **exporteren/importeren** naar een ander apparaat.

---

## Gebruiken

### Online (aanbevolen)

Open de gehoste versie:

**https://leonarddune.github.io/sightsize/**

Werkt op telefoon, tablet en desktop in een moderne browser.

### Op je beginscherm zetten (installeren)

SightSize is een PWA: je kunt hem als app installeren en dan werkt hij **offline** (handig
bij de ezel zonder wifi).

- **iPhone/iPad (Safari):** deel-knop → *Zet op beginscherm*.
- **Android/desktop (Chrome/Edge):** het installeer-icoon in de adresbalk, of menu → *App installeren*.

### Lokaal draaien

Het is een statische site zonder build-stap. Serveer de map met een willekeurige webserver
(open `index.html` niet rechtstreeks via `file://` — opslaan en offline werken hebben `http` nodig):

```bash
git clone https://github.com/LeonardDune/sightsize.git
cd sightsize
python3 -m http.server 8000
# open daarna http://localhost:8000
```

---

## Zo werkt het

### 1. Nieuwe sessie

Tik op **Nieuwe sessie** en doorloop de wizard:

1. **Referentie** — kies wat voor afbeelding het is:
   - *Digitale afbeelding* — de verhoudingen kloppen al (bestand, scan, afbeelding van internet).
   - *Zelf genomen foto* — de app zoekt automatisch de vier hoekpunten; je kunt ze verslepen (met loep voor precisie) en het perspectief wordt rechtgetrokken.
2. **Formaat** (optioneel) — kies een papierformaat (A4, 30×40 cm, …) of vul het zelf in. Met een bekend formaat kun je later in centimeters meten.
3. **Schets** — dezelfde keuze: een rechte scan/foto, of een foto van de ezel waarvan je de vier hoeken aanwijst. Bij een volgende schetsversie neemt de app het formaat automatisch over.

Daarna kom je in de **overlay**.

### 2. De overlay

Bovenaan staat de **lagenstrook** met oogjes om lagen aan/uit te zetten: *Foto · Auto-lijnen ·
Tekening · Waarden · Schets*. Onderaan zit de **modusbalk** met zes modi. Rechtsonder zweven
de knoppen voor **flikkeren** en het **instellingenpaneel** (een bodemblad dat je omhoog sleept).
Rechtsboven schakel je tussen **licht/donker/automatisch** thema.

### 3. De modi

**Bekijken** — de referentie bestuderen.
- Weergave: *kleur · grijswaarden · waarden (posterize, 2–8 stappen) · notan · kleurtemperatuur · verzadiging (chroma)*.
- **Waarde isoleren:** tik een stap op de 9-schaal om alleen die waardeband te tonen.
- **Dynamisch bereik:** histogram van referentie en schets, met de donkerste/lichtste plek gemarkeerd op het beeld; tik op het histogram om die waarde te isoleren.
- **Auto-blockin-lijnen:** laat de software waardenlijnen (grenzen tussen waardevlakken) en/of contourlijnen tekenen, met instelbaar detail.

**Schets** — de overlay bijstellen.
- **Dekking** van de schets, **flikkeren** (instelbare snelheid), mengmodus **verschil**, of de schets als **alleen lijnen** tonen.
- Schets **verplaatsen** (slepen), **schalen/roteren** (knijpen met twee vingers of de knoppen), en fijnregelen met de pijltjestoetsen.

**Tekenen** — zelf een blockin maken, in lagen.
- Twee gereedschappen (knoppen links in de balk):
  - **Lijn** — rechte lijnstukken van punt naar punt.
  - **Vlak** — gevulde **waardenvlakken**: tik hoekpunten voor een gesloten vlak (alleen rechte randen), tik het beginpunt om te sluiten.
- **Waarde per vlak:** kies een grijs uit een instelbaar **aantal waarden (2–9)**, of neem de waarde over van de referentie met de **pipet**. De schaal volgt dezelfde posterize als de "waarden"-weergave, dus je kunt je blockin er 1-op-1 mee vergelijken. De sliderstand is niet-destructief: minder waarden vouwt je vlakken samen, meer waarden geeft ze weer terug.
- **Zelfcheck:** per vlak zie je de gemeten referentiewaarde naast je keuze, met het verschil. De schakelaar **Onthul afwijking** kleurt vlakken van groen (raak) naar rood (ver ernaast).
- **Dekking** per vlak én per laag (met reset), zodat je met foto, schets en de andere weergaven kunt vergelijken.
- **Punten bewerken** (aanpasmodus): sleep een hoekpunt, tik op een rand om een tussenpunt toe te voegen, tik op een hoekpunt om het te verwijderen. **Snappen** klikt punten vast aan hoekpunten én aan de randen van andere vlakken/lijnen, zodat vlakken naadloos aansluiten.
- **Lagen:** meerdere lijn- en waardenlagen, elk zichtbaar te schakelen, te hernoemen en te herordenen. **Ongedaan maken / opnieuw**, gum, en tekenversies opslaan/laden.

**Kleur** — kleur en waarde analyseren.
- **Pipet:** sampelt referentie én schets tegelijk; toont hex, waardenstap (9-schaal), RGB, HSL, LAB en het waardeverschil.
- **Witbalans:** sample een punt dat neutraal grijs/wit hoort te zijn en zet dat als neutraal — de kleurzweem van de foto wordt gecorrigeerd.
- **Gamut:** de kleuren van de referentie op een kleurenwiel, zodat je ziet welk beperkt gamut is gebruikt.
- **Palet:** de x meest prominente kleuren (k-means); tik een staal om te zien waar die kleur zit.
- **Verfdoos & mengsuggestie:** stel je eigen verven in en krijg een mengrecept (Kubelka-Munk) voor een doelkleur, met ΔE. Een recept kun je bij een kleurnotitie bewaren.
- **Kleurnotities:** pin kleuren vast op de foto. Palet en notities zijn te exporteren als **.gpl** (GIMP) en **.ase** (Adobe).

**Uitlijnen** — tik hetzelfde herkenbare punt (bijv. kruin en kin) op referentie en schets; de schets wordt automatisch geschaald, geroteerd en verschoven.

**Meten** — tik twee punten op de referentie en dezelfde twee op de schets. Je krijgt beide lengtes en de afwijking in procenten (in cm als het formaat bekend is). Meetpunten zijn achteraf versleepbaar.

Verder: versleepbare **hulplijnen** (het digitale schietlood) en een instelbaar **raster**.

### 4. Sessies bewaren en delen

- **Opslaan** bewaart de hele sessie lokaal (referentie, schetsen, tekening, lagen, notities, palet, instellingen).
- **Exporteren** schrijft een sessie naar één `.sightsize.json`-bestand (met de foto's erin). Via **Importeren** op het startscherm zet je die op een ander apparaat terug. Zo verhuis je je werk handmatig — er is geen automatische cloud-sync.

---

## Privacy

Alles gebeurt lokaal in je browser. Er worden geen foto's of gegevens naar een server
gestuurd, en er is geen account nodig. Opgeslagen sessies staan in de IndexedDB van je
browser op dat apparaat.

## Techniek

Vanilla JavaScript, geen dependencies en geen build-stap.

| Bestand | Inhoud |
| --- | --- |
| `js/core.js` | wiskunde, perspectief-warp (WebGL met JS-fallback), hoekdetectie, lijn- en waardenreductie, kleurruimtes, mengen (Kubelka-Munk), IndexedDB-opslag |
| `js/app.js` | wizard, hoekpunten-editor met loep, sessies opslaan/laden/exporteren/importeren |
| `js/viewer.js` | overlay-viewer: renderen, gestures, meten, uitlijnen, tekenen (lijnen + waardenvlakken), kleuranalyse |
| `sw.js`, `manifest.webmanifest` | service worker en manifest voor de installeerbare, offline PWA |

Deploy naar GitHub Pages gebeurt automatisch via GitHub Actions; elke versie krijgt een
eigen cache zodat updates meteen doorkomen.
