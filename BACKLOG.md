# SightSize — backlog

Levend document met alle besproken ideeën. Uitgangspunt blijft: **een
schildershulpmiddel om te leren zien en te vergelijken — geen foto-editor.**
Dus wél kijken/vergelijken/meten/analyseren/mengen-adviseren; géén penselen,
filters, retouche of destructieve bewerking van de referentie.

Legenda: ✅ gebouwd · 🔜 volgende ronde · ⬜ open idee · 💡 optioneel/later

---

## ✅ Gebouwd (huidige versie)

**Basis & invoer**
- ✅ Referentie uploaden; keuze *digitale afbeelding* vs *eigen foto*
- ✅ Vier hoekpunten aanwijzen met automatische detectie + loep
- ✅ Perspectiefcorrectie (homografie, WebGL met JS-fallback)
- ✅ Schetsfoto op dezelfde manier; meerdere schetsversies per sessie
- ✅ Formaatkeuze (A-reeks/cm), oriëntatie volgt het beeld

**Vergelijken (overlay)**
- ✅ Dekking-slider, flikkermodus (instelbare snelheid)
- ✅ Mengmodus *verschil*, schets als *alleen lijnen* (instelbare kleur)
- ✅ Uitlijnen met 2 ankerpunten; schets verplaatsen/schalen/roteren + fijnregelen
- ✅ Meten met afwijking in %, cm bij bekend formaat, versleepbare meetpunten
- ✅ Versleepbare hulplijnen (H/V) en instelbaar raster

**Referentie-weergave**
- ✅ Kleur / grijswaarden / waarden (posterize 2–8) / notan (drempel)
- ✅ Vervaging vóór de reductie (snelle separabele box-blur)

**Automatische blockin-lijnen**
- ✅ Waardenlijnen (grenzen waardevlakken) en contourlijnen (Sobel + NMS)
- ✅ Rechttrekken met Ramer–Douglas–Peucker; detail-slider; elk apart schakelbaar

**Eigen tekening (blockin)**
- ✅ Rechte lijnstukken met snap-toggle; eindpunten los verslepen (met loep)
- ✅ Gum per lijn, ongedaan maken, laag wissen
- ✅ Meerdere tekenlagen: zichtbaar-toggle, hernoemen, activeren, verwijderen, **volgorde slepen**
- ✅ Tekenversies opslaan/laden (hele lagenstructuur)

**Kleur & waarde**
- ✅ Pipet: kleur + waardenstap (9-schaal via CIELAB) + tint/verzadiging, gemiddeld gebied
- ✅ Pipet sampelt referentie én schets tegelijk, met waardeverschil
- ✅ Dominante-kleurenpalet (k-means in Lab), highlight toont waar een kleur zit
- ✅ Kleurnotities (pins op de foto)
- ✅ Export palet/notities als **.gpl** en **.ase**
- ✅ Mengsuggesties (Kubelka-Munk, 12 klassieke olieverven, ΔE)

**Techniek**
- ✅ Volledig client-side; sessies in IndexedDB met thumbnails
- ✅ GitHub Pages-deploy, cache-busting per commit, zichtbaar versienummer

---

## 🔜 Volgende ronde (afgesproken volgorde)

### 1. Herindeling van de bediening
- ✅ **Contextueel paneel** dat de actieve modus volgt (i.p.v. één mega-⚙️-paneel)
- ✅ **Vaste lagenstrook** met oogjes: foto · auto-lijnen · tekening · schets
- ✅ Hints alleen tonen in de modi die ze nodig hebben
- 💡 Nog open: paneel als versleepbaar/dichttikbaar bodemblad i.p.v. hoek-overlay

### 2. Waarde- en temperatuuranalyse
- ✅ **Waarde isoleren**: 9-staps schaal in Bekijken; toont alleen de band rond de gekozen waarde (werkt op kleur/grijs/waarden)
- ✅ **Kleurtemperatuur-kaart** (warm-koud t.o.v. gemiddelde) als extra referentie-weergave, met legenda

---

## ⬜ Open ideeën — kleur & waarde
- ⬜ Pipet toont meerdere kleurmodellen (naast hex/waarde ook HSL, LAB, evt. CMYK)
- ⬜ **Chroma-/verzadigingskaart** — waar zit de hoogste verzadiging (valkuil: bonte schaduwen)
- ⬜ **Dynamisch bereik / luminantiehistogram** — donkerste/lichtste noot, high- vs low-key
- ⬜ **Gamut-plot** (Gurney-gamutmasking) op een kleurenwiel — welk beperkt gamut de referentie gebruikt
- ⬜ **Witbalans-correctie** via een neutraal punt — anders sample je de camerazweem mee

## ⬜ Open ideeën — verf mengen
- ⬜ **Instelbaar eigen vervenpalet** (eigen verf sampelen/toevoegen; verven aan/uit) → rekent met jóuw verfdoos
- 💡 Optioneel **Mixbox** als externe, geattribueerde bibliotheek voor accurater pigmentgedrag
- ⬜ Mengrecept bewaren bij een kleurnotitie

## ⬜ Open ideeën — vergelijken & voortgang
- 💡 **Onion-skinning** over schetsversies — je voortgang tijdens één tekening zien
- 💡 Tijdlijn/vergelijk van opeenvolgende schetsfoto's

## ⬜ Open ideeën — platform
- 💡 **PWA / "zet op beginscherm"** met manifest + offline (installeerbaar, werkt zonder net)
- 💡 Directe camera-integratie bij de ezel
- 💡 Sessie exporteren/importeren of delen

---

## Bewuste niet-doen (scope-bewaking)
- ✗ Penselen/kwasten, schilderen op het doek in de app
- ✗ Filters, curves, retouche, kleurcorrectie als doel op zich
- ✗ Destructieve bewerking of "verbeteren" van de referentie
- ✗ Alles wat de app tot een alternatieve fotobewerker maakt
