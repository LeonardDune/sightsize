# SightSize

Controleer hoe nauwkeurig je blockin-schets is ten opzichte van je referentie, op sight-size schaal. Een webapp zonder server of build-stap: open `index.html` in een moderne browser (of host de map als statische site, bijv. via GitHub Pages) en alles draait lokaal op je eigen apparaat — er wordt niets geüpload.

## Werkwijze

1. **Referentie** — kies eerst wat voor afbeelding het is:
   - *Digitale afbeelding*: de verhoudingen kloppen al; geen correctie nodig.
   - *Zelf genomen foto*: de app zoekt automatisch de vier hoekpunten van het vlak; je kunt ze daarna verslepen (met loep voor precisie). Het perspectief wordt gecorrigeerd met een homografie.
2. **Schets** — zelfde keuze: scan/rechte foto, of een foto van de ezel waarvan de vier hoeken van het papier/doek worden aangewezen en rechtgetrokken.
3. **Formaat** (optioneel) — kies een papierformaat (A4, 30×40, …) of vul het zelf in. Daarmee wordt de juiste beeldverhouding gebruikt en kun je in centimeters meten.
4. **Overlay** — de schets ligt over de referentie en je vergelijkt ze met de tools hieronder.

## Vergelijkingstools

- **Dekking-slider** en **flikker-modus** (snel wisselen tussen referentie en schets, instelbare snelheid) — het oog pikt afwijkingen zo het snelst op.
- **Weergave schets**: origineel, of *alleen lijnen* (adaptieve drempel haalt de lijnen van het papier; kleur instelbaar).
- **Mengmodus *verschil***: afwijkingen lichten op.
- **Referentie in grijswaarden** voor het vergelijken van vormen en waarden.
- **Uitlijnen met 2 ankerpunten**: tik hetzelfde punt (bijv. kruin en kin) op referentie en schets; de schets wordt automatisch geschaald, geroteerd en verschoven.
- **Schets verplaatsen**: slepen, knijpen (schalen/roteren), knoppen en pijltjestoetsen voor fijnwerk.
- **Meten**: twee punten op de referentie, dezelfde twee op de schets → lengtes en afwijking in procenten (in cm als het formaat bekend is).
- **Hulplijnen** (horizontaal/verticaal, versleepbaar — het digitale schietlood) en een instelbaar **raster**.
- **Schetsversies**: maak tijdens het tekenen meerdere foto's en wissel ertussen om je voortgang te zien.
- **Sessies opslaan** (lokaal, IndexedDB): referentie, schetsen, uitlijning en instellingen worden bewaard.

## Techniek

Vanilla JavaScript, geen dependencies.

| Bestand | Inhoud |
| --- | --- |
| `js/core.js` | homografie, perspectief-warp (WebGL met JS-fallback), automatische hoekdetectie (Otsu + grootste component), lijnextractie (adaptieve drempel via integraalbeeld), similariteitstransformaties, IndexedDB-opslag |
| `js/app.js` | wizard (bronkeuze → hoekpunten → formaat), hoekpunten-editor met loep, sessiebeheer |
| `js/viewer.js` | overlay-viewer: renderen, gestures (pan/zoom/pinch), meten, uitlijnen, flikkeren, raster en hulplijnen |

## Tests

Een end-to-end-suite (Playwright + headless Chromium) test de wiskunde, de warp, de detectie en de volledige gebruikersflow met synthetische afbeeldingen.
