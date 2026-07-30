'use strict';

/* SightSize — overlay-viewer: schets over referentie met vergelijkingstools */

const V = {
  cv: null,
  ctx: null,
  wired: false,
  view: { s: 1, tx: 0, ty: 0 },
  mode: 'pan',
  pointers: new Map(),
  gesture: null,
  flickerTimer: null,
  flickerHidden: false,
  measure: { stage: 0, refPts: [], skPts: [], result: null },
  align: { stage: 0, pts: [] },
  dragKind: null, // 'ref' of 'sketch' tijdens het verslepen van een meet-/ankerpunt
  draw: { erase: false, edit: false, cur: null, editPt: null, editStroke: null,
          tool: 'line', poly: null, selShape: null, vtx: null, lastVal: 0.5, redo: [] }, // tekenmodus
  sample: null,   // laatste pipet-meting {world, ref:{r,g,b}, sk:{r,g,b}|null}
  selNote: -1,    // geselecteerde kleurnotitie in pipet-modus
  palette: null,  // {colors, assign, w, h, hi, hiCanvas, hiIdx}
  layerDrag: null, // actieve laag-versleepactie
  rangeMarks: null, // donkerste/lichtste markeringen op ref + schets
  raf: 0,
};

function session() { return App.session; }
function refItem() { return App.session.ref; }
function activeSketch() { return App.session.sketches[App.session.active]; }
function settings() { return App.session.settings; }

/* ---------- coördinaten ---------- */
function screenToWorld(p) {
  return { x: (p.x - V.view.tx) / V.view.s, y: (p.y - V.view.ty) / V.view.s };
}
function worldToScreen(p) {
  return { x: p.x * V.view.s + V.view.tx, y: p.y * V.view.s + V.view.ty };
}
function eventPos(e) {
  const r = V.cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/* ---------- levenscyclus ---------- */
function enterOverlay() {
  wireOverlay();
  App.setPhase('overlay');
  resizeViewCanvas();
  viewFit();
  syncPanel();
  updateVersionSelect();
  updateDrawVersionSelect();
  V.palette = null;
  V.rangeMarks = null;
  V.draw.redo = [];
  V.draw.poly = null;
  V.draw.selShape = null;
  $('#histogram').hidden = true;
  $('#range-info').hidden = true;
  renderPaletteRow();
  renderNotesRow();
  renderPaintList();
  renderLayerList();
  $('#mix-results').innerHTML = '';
  $('#btn-snap').classList.toggle('on', settings().drawSnap);
  setMode('pan');
  applyFlicker();
  requestRender();
}

function leaveOverlay() {
  if (V.flickerTimer) { clearInterval(V.flickerTimer); V.flickerTimer = null; }
  V.flickerHidden = false;
}

function resizeViewCanvas() {
  const r = V.cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (V.cv.width !== w || V.cv.height !== h) {
    V.cv.width = w;
    V.cv.height = h;
  }
}

function viewFit() {
  const r = V.cv.getBoundingClientRect();
  const ref = refItem().canvas;
  const s = Math.min(r.width / ref.width, r.height / ref.height) * 0.95;
  V.view.s = s;
  V.view.tx = (r.width - ref.width * s) / 2;
  V.view.ty = (r.height - ref.height * s) / 2;
  requestRender();
}

/* ---------- afgeleide beelden (lui berekend) ---------- */
function refView() {
  const it = refItem();
  const st = settings();
  // ongewijzigde kleurfoto: geen bewerking nodig
  if (st.refMode === 'color' && st.refIsolate <= 0) return it.canvas;
  const key = `${st.refMode}|${st.refLevels}|${st.refThreshold}|${st.refBlur}|${st.refIsolate}`;
  if (!it.derived || it.derived.key !== key) {
    it.derived = {
      key,
      canvas: reduceValues(it.canvas, {
        mode: st.refMode, levels: st.refLevels,
        threshold: st.refThreshold, blur: st.refBlur, isolate: st.refIsolate,
      }),
    };
  }
  return it.derived.canvas;
}

function sketchLines(it) {
  const color = settings().lineColor;
  if (!it.lines || it.lines.color !== color) {
    it.lines = { color, canvas: extractLines(it.canvas, color) };
  }
  return it.lines.canvas;
}

function blockinLines() {
  const it = refItem();
  const st = settings();
  if (!st.blockinValues && !st.blockinContours) return null;
  const key = `${st.blockinValues}|${st.blockinContours}|${st.blockinDetail}|${st.refLevels}|${st.refBlur}`;
  if (!it.blockin || it.blockin.key !== key) {
    it.blockin = {
      key,
      values: st.blockinValues
        ? blockinValueLines(it.canvas, { levels: st.refLevels, blur: st.refBlur, detail: st.blockinDetail })
        : [],
      contours: st.blockinContours
        ? blockinContourLines(it.canvas, { detail: st.blockinDetail })
        : [],
    };
  }
  return it.blockin;
}

/* ---------- renderen ---------- */
function requestRender() {
  if (V.raf) return;
  V.raf = requestAnimationFrame(() => { V.raf = 0; renderScene(); });
}

// tijdens uitlijnen/meten wisselt de zichtbaarheid zodat je het juiste beeld ziet
function visibilityOverride() {
  if (V.dragKind) return V.dragKind;
  if (V.mode === 'align' && V.align.stage < 4) {
    return V.align.stage % 2 === 0 ? 'ref' : 'sketch';
  }
  if (V.mode === 'measure' && V.measure.stage < 4) {
    return V.measure.stage < 2 ? 'ref' : 'sketch';
  }
  return null;
}

/* ---------- inhoudslagen: volgorde en dekking ---------- */
const LAYER_GROUPS = ['ref', 'blockin', 'drawing', 'values', 'sketch'];
const LAYER_NAMES = { ref: 'Foto', blockin: 'Auto-lijnen', drawing: 'Tekening (lijnen)', values: 'Waardenvlakken', sketch: 'Schets' };

// geldige, complete volgorde teruggeven (ontbrekende groepen aanvullen, onbekende weglaten)
function layerOrderList() {
  const st = settings();
  let ord = Array.isArray(st.layerOrder) ? st.layerOrder.filter(g => LAYER_GROUPS.includes(g)) : [];
  for (const g of LAYER_GROUPS) if (!ord.includes(g)) ord.push(g);
  st.layerOrder = ord;
  return ord;
}
function groupOpacity(gp) {
  const st = settings();
  if (gp === 'sketch') return st.opacity;
  const o = st.layerOpacity && st.layerOpacity[gp];
  return o == null ? 1 : o;
}

function drawRefGroup(ctx, ov) {
  const st = settings();
  const ref = refItem();
  ctx.globalAlpha = ov === 'sketch' ? 0.25 : (ov === 'ref' ? 1 : groupOpacity('ref'));
  if (st.showRef || ov === 'ref') {
    ctx.drawImage(refView(), 0, 0);
  } else if (!ov) {
    ctx.fillStyle = Theme.paper;
    ctx.fillRect(0, 0, ref.canvas.width, ref.canvas.height);
  }
  ctx.globalAlpha = 1;
  // palet-highlight hoort bij de foto: dim alles buiten de gekozen kleurcluster
  const pc = paletteHighlightCanvas();
  if (pc && ov !== 'sketch') ctx.drawImage(pc, 0, 0, ref.canvas.width, ref.canvas.height);
}

function drawSketchGroup(ctx, ov) {
  const st = settings();
  const sk = activeSketch();
  let alpha = st.showSketch ? st.opacity : 0;
  if (ov === 'ref') alpha = 0;
  else if (ov === 'sketch') alpha = 1;
  if (V.flickerHidden && !ov) alpha = 0;
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (st.blend === 'difference' && !ov) ctx.globalCompositeOperation = 'difference';
  const T = sk.transform;
  ctx.transform(T.a, T.b, -T.b, T.a, T.tx, T.ty);
  ctx.drawImage(st.sketchMode === 'lines' ? sketchLines(sk) : sk.canvas, 0, 0);
  ctx.restore();
}

function drawBlockinGroup(ctx) {
  const bl = blockinLines();
  if (!bl) return;
  ctx.save();
  ctx.globalAlpha = groupOpacity('blockin');
  ctx.lineWidth = 2 / V.view.s;
  ctx.lineJoin = 'round';
  const drawPolys = (polys, color) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (const poly of polys) {
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    }
    ctx.stroke();
  };
  drawPolys(bl.values, '#ff9f1a');
  drawPolys(bl.contours, '#38bdf8');
  ctx.restore();
}

function drawLineGroup(ctx) {
  const st = settings();
  if (!st.showDrawing) return;
  ctx.save();
  ctx.globalAlpha = groupOpacity('drawing');
  const layers = drawingLayers();
  for (let i = layers.length - 1; i >= 0; i--) {
    const L = layers[i];
    if (L.visible && L.kind !== 'values') drawStrokes(ctx, L.strokes);
  }
  ctx.restore();
}

function drawValuesGroup(ctx) {
  const st = settings();
  if (!st.showValues) return;
  const N = st.valueN;
  const go = groupOpacity('values');
  const layers = drawingLayers();
  for (let i = layers.length - 1; i >= 0; i--) {
    const L = layers[i];
    if (L.visible && L.kind === 'values') drawValueShapes(ctx, L, N, go);
  }
}

function renderScene() {
  if (App.phase !== 'overlay' || !refItem() || !activeSketch()) return;
  resizeViewCanvas();
  const ctx = V.ctx;
  const dpr = window.devicePixelRatio || 1;
  const st = settings();
  const ov = visibilityOverride();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = Theme.canvasBg;
  ctx.fillRect(0, 0, V.cv.width, V.cv.height);
  ctx.translate(V.view.tx, V.view.ty);
  ctx.scale(V.view.s, V.view.s);

  // inhoudslagen in de door de gebruiker gekozen stapelvolgorde (onder → boven)
  const ref = refItem();
  for (const gp of layerOrderList()) {
    if (gp === 'ref') drawRefGroup(ctx, ov);
    else if (gp === 'sketch') drawSketchGroup(ctx, ov);
    else if (ov === 'sketch') continue; // bij "alleen schets" andere lagen verbergen
    else if (gp === 'blockin') drawBlockinGroup(ctx);
    else if (gp === 'drawing') drawLineGroup(ctx);
    else if (gp === 'values') drawValuesGroup(ctx);
  }

  // wat je nu aan het tekenen bent + de grepen: altijd bovenop en op volle dekking
  if (V.mode === 'draw' && ov !== 'sketch') {
    if (V.draw.tool === 'shape') { drawShapeInProgress(ctx); drawShapeHandles(ctx); }
    else { if (V.draw.cur) drawStrokes(ctx, [V.draw.cur]); drawEndpointHandles(ctx); }
  }

  // Loomis-constructie-overlay
  if (con().on && ov !== 'sketch') drawConstruction(ctx);

  // kleurnotities (vastgepinde stalen)
  if (st.showNotes && ov !== 'sketch') {
    const rr = 9 / V.view.s;
    session().notes.forEach((n, i) => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = rgbToHex(n.r, n.g, n.b);
      ctx.fill();
      ctx.lineWidth = (i === V.selNote ? 3 : 1.5) / V.view.s;
      ctx.strokeStyle = i === V.selNote ? '#4da3ff' : '#ffffff';
      ctx.stroke();
    });
  }

  // donkerste/lichtste markeringen uit de bereikanalyse (alleen in bekijken)
  if (V.rangeMarks && V.mode === 'pan' && ov !== 'sketch') {
    for (const m of V.rangeMarks) {
      if (m.src === 'ref' && !st.showRef) continue;
      if (m.src === 'sk' && !st.showSketch) continue;
      const rr = 11 / V.view.s;
      ctx.beginPath();
      ctx.arc(m.world.x, m.world.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = m.kind === 'D' ? '#101318cc' : '#f4f1e8cc';
      ctx.fill();
      ctx.lineWidth = 2.5 / V.view.s;
      ctx.strokeStyle = m.src === 'sk' ? '#ff5555' : '#4da3ff';
      ctx.stroke();
      ctx.fillStyle = m.kind === 'D' ? '#f4f1e8' : '#101318';
      ctx.font = `${14 / V.view.s}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${m.kind}${m.step}`, m.world.x, m.world.y);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  // pipet-markering
  if (V.mode === 'sample' && V.sample) {
    ctx.beginPath();
    ctx.arc(V.sample.world.x, V.sample.world.y, st.sampleRadius, 0, Math.PI * 2);
    ctx.lineWidth = 1.5 / V.view.s;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(V.sample.world.x, V.sample.world.y, st.sampleRadius + 2 / V.view.s, 0, Math.PI * 2);
    ctx.strokeStyle = '#000000aa';
    ctx.stroke();
  }

  // raster
  if (st.grid) drawGrid(ctx, ref, st);

  // meet- en ankerpunten
  const lw = 1.5 / V.view.s;
  drawMarkers(ctx, V.measure.refPts, '#ff5555', lw);
  drawMarkers(ctx, V.measure.skPts, '#4da3ff', lw);
  if (V.measure.refPts.length === 2) drawLine(ctx, V.measure.refPts, '#ff5555', lw);
  if (V.measure.skPts.length === 2) drawLine(ctx, V.measure.skPts, '#4da3ff', lw);
  if (V.mode === 'align') drawMarkers(ctx, V.align.pts.map(p => p.world), '#ffd60a', lw);

  // hulplijnen in schermruimte (altijd scherp en over volle breedte)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const r = V.cv.getBoundingClientRect();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = '#2dd4bf';
  for (const g of session().guides) {
    ctx.beginPath();
    if (g.type === 'h') {
      const y = g.pos * V.view.s + V.view.ty;
      ctx.moveTo(0, y);
      ctx.lineTo(r.width, y);
    } else {
      const x = g.pos * V.view.s + V.view.tx;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, r.height);
    }
    ctx.stroke();
  }

  // loep tijdens het verslepen van een eind-, vlak- of constructiepunt
  if (V.mode === 'draw') {
    if (V.draw.editPt) drawLoupe(ctx, V.draw.editPt);
    else if (V.draw.vtx) drawLoupe(ctx, V.draw.vtx.pts[V.draw.vtx.i]);
  } else if (V.mode === 'pan' && V.gesture && V.gesture.con) {
    drawLoupe(ctx, V.gesture.con.get());
  }
}

// loep: uitvergroting van de referentie rond een punt (zoals bij de hoekpunten)
function drawLoupe(ctx, world) {
  const r = V.cv.getBoundingClientRect();
  const sp = worldToScreen(world);
  const rad = 54, zoom = 2.6;
  const scale = V.view.s * zoom;
  const half = rad / scale;
  let lx = sp.x, ly = sp.y - 96;
  if (ly < rad + 8) ly = sp.y + 96;
  lx = clamp(lx, rad + 6, r.width - rad - 6);
  ly = clamp(ly, rad + 6, r.height - rad - 6);

  ctx.save();
  ctx.beginPath();
  ctx.arc(lx, ly, rad, 0, Math.PI * 2);
  ctx.clip();
  // achtergrond: referentie of papier
  ctx.fillStyle = Theme.canvasBg;
  ctx.fillRect(lx - rad, ly - rad, rad * 2, rad * 2);
  if (settings().showRef) {
    ctx.drawImage(refView(), world.x - half, world.y - half, half * 2, half * 2,
      lx - rad, ly - rad, rad * 2, rad * 2);
  } else {
    ctx.fillStyle = Theme.paper;
    ctx.fillRect(lx - rad, ly - rad, rad * 2, rad * 2);
  }
  // zichtbare tekenlijnen mee in de loep
  const map = (p) => ({ x: (p.x - world.x) * scale + lx, y: (p.y - world.y) * scale + ly });
  ctx.lineCap = 'round';
  for (const layer of drawingLayers()) {
    if (!layer.visible || layer.kind === 'values') continue;
    for (const s of layer.strokes) {
      if (s.pts.length < 2) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.w * scale;
      ctx.beginPath();
      const a = map(s.pts[0]), b = map(s.pts[s.pts.length - 1]);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  ctx.restore();
  // dradenkruis op het punt
  ctx.save();
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(lx - rad, ly); ctx.lineTo(lx + rad, ly);
  ctx.moveTo(lx, ly - rad); ctx.lineTo(lx, ly + rad);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(lx, ly, rad, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawGrid(ctx, ref, st) {
  const cmPerPx = ref.dims ? ref.dims.w / ref.canvas.width : null;
  const step = cmPerPx ? st.gridCm / cmPerPx : ref.canvas.width / (st.gridCm * 2.4);
  if (step < 4) return;
  ctx.save();
  ctx.lineWidth = 1 / V.view.s;
  ctx.strokeStyle = '#2dd4bf55';
  ctx.beginPath();
  for (let x = 0; x <= ref.canvas.width + 0.5; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ref.canvas.height);
  }
  for (let y = 0; y <= ref.canvas.height + 0.5; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(ref.canvas.width, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawStrokes(ctx, strokes) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    const p = s.pts;
    if (p.length === 1) {
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(p[0].x, p[0].y, s.w / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length - 1; i++) {
      ctx.quadraticCurveTo(p[i].x, p[i].y, (p[i].x + p[i + 1].x) / 2, (p[i].y + p[i + 1].y) / 2);
    }
    ctx.lineTo(p[p.length - 1].x, p[p.length - 1].y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawMarkers(ctx, pts, color, lw) {
  ctx.save();
  ctx.lineWidth = lw * 1.4;
  ctx.strokeStyle = color;
  const rr = 7 / V.view.s;
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
    ctx.moveTo(p.x - rr * 1.6, p.y);
    ctx.lineTo(p.x + rr * 1.6, p.y);
    ctx.moveTo(p.x, p.y - rr * 1.6);
    ctx.lineTo(p.x, p.y + rr * 1.6);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLine(ctx, pts, color, lw) {
  ctx.save();
  ctx.lineWidth = lw;
  ctx.strokeStyle = color;
  ctx.setLineDash([6 / V.view.s, 4 / V.view.s]);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  ctx.lineTo(pts[1].x, pts[1].y);
  ctx.stroke();
  ctx.restore();
}

/* ---------- Loomis-kopconstructie (bal + kruis + kin) ---------- */
function con() {
  const s = session();
  if (!s.construction) s.construction = newConstruction();
  return s.construction;
}
function conInit() {
  const c = con();
  if (c._init && c.r > 0) return;
  const ref = refItem().canvas;
  c.cx = ref.width / 2;
  c.cy = ref.height * 0.36;
  c.r = Math.min(ref.width, ref.height) * 0.16;
  c.nx = 0; c.ny = 0;
  c.chinx = c.cx;
  c.chiny = c.cy + c.r * 2.3;
  c._init = true;
}
function cross3(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
// orthonormaal kopframe uit de gezichtsnormaal (stand) en de kin-richting (rol)
function conFrame(c) {
  const nx = clamp(c.nx, -0.92, 0.92), ny = clamp(c.ny, -0.92, 0.92);
  const nz = Math.sqrt(Math.max(0.02, 1 - nx * nx - ny * ny));
  const fwd = { x: nx, y: ny, z: nz };
  let dx = c.chinx - c.cx, dy = c.chiny - c.cy;
  const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
  let up = { x: -dx, y: -dy, z: (dx * nx + dy * ny) / nz };
  const ul = Math.hypot(up.x, up.y, up.z) || 1; up = { x: up.x / ul, y: up.y / ul, z: up.z / ul };
  let right = cross3(up, fwd);
  const rl = Math.hypot(right.x, right.y, right.z) || 1; right = { x: right.x / rl, y: right.y / rl, z: right.z / rl };
  return { fwd, up, right };
}
// framecoördinaat (a·right + b·up + cc·fwd) op de eenheidsbol → scherm + diepte
function conProject(c, F, a, b, cc) {
  return {
    x: c.cx + c.r * (a * F.right.x + b * F.up.x + cc * F.fwd.x),
    y: c.cy + c.r * (a * F.right.y + b * F.up.y + cc * F.fwd.y),
    z: a * F.right.z + b * F.up.z + cc * F.fwd.z,
  };
}
function conSeg(ctx, a, b, front, lw) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  ctx.setLineDash(front ? [] : [5 / V.view.s, 5 / V.view.s]);
  ctx.lineWidth = front ? lw : lw * 0.7;
  ctx.stroke();
  ctx.setLineDash([]);
}
// grootcirkel; 'vertical' = middellijn (up×fwd), 'horizontal' = brauwlijn (right×fwd)
function conGreatCircle(ctx, c, F, kind, lw) {
  const steps = 72;
  let prev = null, prevF = null;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps * Math.PI * 2, co = Math.cos(t), si = Math.sin(t);
    const P = kind === 'vertical' ? conProject(c, F, 0, co, si) : conProject(c, F, co, 0, si);
    const front = P.z >= -0.02;
    if (prev) conSeg(ctx, prev, P, front && prevF, lw);
    prev = P; prevF = front;
  }
}
// wangvlak: kleine cirkel op de bol op right-coördinaat = ±k
function conSideCircle(ctx, c, F, k, lw) {
  const rho = Math.sqrt(Math.max(0, 1 - k * k));
  const steps = 48;
  let prev = null, prevF = null;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps * Math.PI * 2, co = Math.cos(t), si = Math.sin(t);
    const P = conProject(c, F, k, rho * co, rho * si);
    const front = P.z >= -0.02;
    if (prev) conSeg(ctx, prev, P, front && prevF, lw * 0.8);
    prev = P; prevF = front;
  }
}
const CON_K = 0.62;
function conCheek(c, F, sign) {
  return conProject(c, F, sign * CON_K, 0, Math.sqrt(1 - CON_K * CON_K));
}
function drawConFace(ctx, c, F, lw) {
  const Fc = conProject(c, F, 0, 0, 1);       // gezichtsmidden (brauw)
  const chin = { x: c.chinx, y: c.chiny };
  let dx = chin.x - Fc.x, dy = chin.y - Fc.y;
  const dl = Math.hypot(dx, dy) || 1, ux = dx / dl, uy = dy / dl, px = -uy, py = ux;
  const tick = c.r * 0.5;
  const markAt = (t, len) => {
    const mx = Fc.x + ux * dl * t, my = Fc.y + uy * dl * t;
    ctx.beginPath(); ctx.moveTo(mx - px * len, my - py * len); ctx.lineTo(mx + px * len, my + py * len); ctx.stroke();
  };
  ctx.setLineDash([]); ctx.lineWidth = lw * 0.8;
  markAt(0, tick * 0.9);      // brauw
  markAt(0.5, tick * 0.8);    // neusbasis
  markAt(0.78, tick * 0.62);  // mond
  const hb = dl * 0.5;        // haarlijn boven de brauw
  ctx.beginPath();
  ctx.moveTo(Fc.x - ux * hb - px * tick * 0.7, Fc.y - uy * hb - py * tick * 0.7);
  ctx.lineTo(Fc.x - ux * hb + px * tick * 0.7, Fc.y - uy * hb + py * tick * 0.7);
  ctx.stroke();
  // kaaklijnen van de wangvlakken naar de kin
  const cl = conCheek(c, F, -1), cr = conCheek(c, F, 1);
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(cl.x, cl.y); ctx.lineTo(chin.x, chin.y);
  ctx.moveTo(cr.x, cr.y); ctx.lineTo(chin.x, chin.y);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(chin.x, chin.y, lw * 1.3, 0, Math.PI * 2); ctx.fillStyle = c.color; ctx.fill();
}
function conHandles(c) {
  return [
    { kind: 'center', x: c.cx, y: c.cy },
    { kind: 'radius', x: c.cx, y: c.cy - c.r },
    { kind: 'orient', x: c.cx + c.r * clamp(c.nx, -0.92, 0.92), y: c.cy + c.r * clamp(c.ny, -0.92, 0.92) },
    { kind: 'chin', x: c.chinx, y: c.chiny },
  ];
}
function drawConHandles(ctx, c) {
  const rr = 7 / V.view.s;
  ctx.save();
  ctx.lineWidth = 1.6 / V.view.s;
  for (const h of conHandles(c)) {
    ctx.beginPath(); ctx.arc(h.x, h.y, rr, 0, Math.PI * 2);
    ctx.fillStyle = h.kind === 'orient' ? '#ffd60a' : '#ffffffcc';
    ctx.fill(); ctx.strokeStyle = '#000000aa'; ctx.stroke();
  }
  ctx.restore();
}
function drawConstruction(ctx) {
  conInit();
  const c = con();
  const F = conFrame(c);
  ctx.save();
  ctx.globalAlpha = c.opacity;
  ctx.strokeStyle = c.color;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const lw = 2 / V.view.s;
  ctx.setLineDash([]); ctx.lineWidth = lw;
  ctx.beginPath(); ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2); ctx.stroke(); // bal
  conSideCircle(ctx, c, F, CON_K, lw);
  conSideCircle(ctx, c, F, -CON_K, lw);
  conGreatCircle(ctx, c, F, 'vertical', lw);
  conGreatCircle(ctx, c, F, 'horizontal', lw);
  drawConFace(ctx, c, F, lw);
  ctx.restore();
  if (V.mode === 'pan') drawConHandles(ctx, c);
}
// dichtstbijzijnde constructie-handvat om te verslepen (alleen in bekijken, indien aan)
function hitConstructionHandle(p) {
  const c = con();
  if (!c.on) return null;
  const tol = 16;
  let best = null, bestD = tol;
  for (const h of conHandles(c)) {
    const d = dist(worldToScreen({ x: h.x, y: h.y }), p);
    if (d < bestD) { bestD = d; best = h; }
  }
  if (!best) return null;
  const kind = best.kind;
  return {
    kind,
    get: () => { const h = conHandles(con()).find(x => x.kind === kind); return { x: h.x, y: h.y }; },
    set: (w) => {
      const cc = con();
      if (kind === 'center') { const dx = w.x - cc.cx, dy = w.y - cc.cy; cc.cx = w.x; cc.cy = w.y; cc.chinx += dx; cc.chiny += dy; }
      else if (kind === 'radius') cc.r = clamp(dist(w, { x: cc.cx, y: cc.cy }), 8, 100000);
      else if (kind === 'orient') { cc.nx = clamp((w.x - cc.cx) / cc.r, -0.92, 0.92); cc.ny = clamp((w.y - cc.cy) / cc.r, -0.92, 0.92); }
      else if (kind === 'chin') { cc.chinx = w.x; cc.chiny = w.y; }
    },
  };
}

/* ---------- hints ---------- */
function updateHint() {
  const el = $('#view-hint');
  const measureMsgs = [
    'Meten — tik <b>punt 1</b> op de <b>referentie</b> (bijv. de kruin).',
    'Meten — tik <b>punt 2</b> op de <b>referentie</b> (bijv. de kin).',
    'Meten — tik <b>hetzelfde punt 1</b> op je <b>schets</b>.',
    'Meten — tik <b>hetzelfde punt 2</b> op je <b>schets</b>.',
  ];
  const alignMsgs = [
    'Anker 1 — tik een herkenbaar punt op de <b>referentie</b>.',
    'Anker 1 — tik <b>hetzelfde punt</b> op je <b>schets</b>.',
    'Anker 2 — tik een tweede punt op de <b>referentie</b>.',
    'Anker 2 — tik <b>hetzelfde punt</b> op je <b>schets</b>.',
  ];
  let html = '';
  if (V.mode === 'pan') html = 'Sleep om te verschuiven, knijp of scroll om te zoomen. Hulplijnen kun je verslepen.';
  else if (V.mode === 'move') html = 'Sleep de <b>schets</b> om te verschuiven; knijp met twee vingers om te schalen en roteren.';
  else if (V.mode === 'draw') {
    if (V.draw.tool === 'shape') {
      if (V.draw.erase) html = '<b>Gum</b> — tik op een <b>vlak</b> om het te wissen.';
      else if (V.draw.edit) html = '<b>Punten aanpassen</b> — sleep een hoekpunt; tik op een <b>rand</b> om een punt toe te voegen, tik op een <b>hoekpunt</b> om het te verwijderen.';
      else if (V.draw.poly) html = 'Tik verder voor <b>hoekpunten</b>; tik het <b>beginpunt</b> om het vlak te sluiten.';
      else html = 'Tik <b>hoekpunten</b> voor een gesloten <b>waardenvlak</b> (rechte randen), of tik een vlak om het te selecteren.';
    }
    else if (V.draw.erase) html = '<b>Gum</b> — tik of sleep over een lijn om die te wissen.';
    else if (V.draw.edit) html = '<b>Eindpunten aanpassen</b> — sleep een bolletje naar de juiste plek.';
    else html = 'Sleep een <b>rechte lijn</b> van punt naar punt. Twee vingers pannen/zoomen.';
  } else if (V.mode === 'sample') {
    html = 'Tik om een <b>kleur te sampelen</b>; 📌 pint de kleur vast als notitie. Tik een notitie aan om die te bekijken.';
  }
  else if (V.mode === 'align') {
    html = V.align.stage < 4 ? alignMsgs[V.align.stage]
      : 'Sleep ankerpunten om bij te stellen en tik <b>✓ Toepassen</b>.';
  } else if (V.mode === 'measure') {
    html = V.measure.stage < 4 ? measureMsgs[V.measure.stage]
      : `${V.measure.result} — sleep een punt om bij te stellen, tik elders om opnieuw te meten.`;
  }
  el.innerHTML = html;
}

/* ---------- modi ---------- */
function setMode(mode) {
  V.mode = mode;
  V.measure = { stage: 0, refPts: [], skPts: [], result: null };
  V.align = { stage: 0, pts: [] };
  V.dragKind = null;
  $$('#mode-bar .mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('#move-tools').hidden = mode !== 'move';
  $('#align-tools').hidden = mode !== 'align';
  $('#draw-tools').hidden = mode !== 'draw';
  $('#layer-panel').hidden = mode !== 'draw';
  $('#sample-card').hidden = mode !== 'sample';
  $('#btn-align-apply').disabled = true;
  V.sample = null;
  V.selNote = -1;
  V.draw.cur = null;
  V.draw.editPt = null;
  V.draw.editStroke = null;
  V.draw.poly = null;
  V.draw.vtx = null;
  if (mode !== 'draw') selectShape(null);
  if (mode === 'sample') { updateSampleCard(); renderNotesRow(); }
  if (mode === 'draw') {
    if (V.draw.tool === 'shape') { settings().showValues = true; activeValueLayer(); }
    else settings().showDrawing = true;
    renderLayerList();
    buildVScale();
    updateDrawToggles();
  }
  refreshLayerStrip();
  filterContext();
  updateHint();
  requestRender();
}

/* ---------- pipet: kleur en waarde sampelen ---------- */
function doSample(world) {
  const st = settings();
  const refC = averageArea(refItem().canvas, world.x, world.y, st.sampleRadius);
  if (!refC) { V.sample = null; return; }
  let skC = null;
  const sk = activeSketch();
  const T = sk.transform;
  const local = applySim(invertSim(T), world);
  const scale = Math.hypot(T.a, T.b) || 1;
  skC = averageArea(sk.canvas, local.x, local.y, st.sampleRadius / scale);
  V.sample = { world, ref: refC, sk: skC };
}

function sampleInfoHtml(c, skC) {
  const lab = rgbToLab(c.r, c.g, c.b);
  const hsl = rgbToHsl(c.r, c.g, c.b);
  const step = valueStep(c.r, c.g, c.b);
  let html = `<b>${rgbToHex(c.r, c.g, c.b)}</b> · waarde <b>${step}/9</b>`
    + `<br><span class="num">rgb ${c.r},${c.g},${c.b}</span>`
    + `<br><span class="num">hsl ${fmt(hsl.h, 0)}° ${fmt(hsl.s * 100, 0)}% ${fmt(hsl.l * 100, 0)}%</span>`
    + `<br><span class="num">lab ${fmt(lab.L, 0)} ${fmt(lab.a, 0)} ${fmt(lab.b, 0)}</span>`;
  if (skC) {
    const skStep = valueStep(skC.r, skC.g, skC.b);
    const d = skStep - step;
    const rel = d === 0 ? 'gelijk' : `${Math.abs(d)} stap${Math.abs(d) === 1 ? '' : 'pen'} ${d > 0 ? 'lichter' : 'donkerder'}`;
    html += `<br>schets: waarde ${skStep}/9 — ${rel}`;
  }
  return html;
}

function renderNotesRow() {
  const row = $('#notes-row');
  row.innerHTML = '';
  const notes = session().notes;
  $('#notes-export').hidden = notes.length === 0;
  notes.forEach((n, i) => {
    const b = document.createElement('button');
    b.style.background = rgbToHex(n.r, n.g, n.b);
    b.title = `${rgbToHex(n.r, n.g, n.b)} · waarde ${valueStep(n.r, n.g, n.b)}/9`;
    b.classList.toggle('hi', V.selNote === i);
    b.addEventListener('click', () => {
      V.selNote = V.selNote === i ? -1 : i;
      V.sample = null;
      renderNotesRow();
      updateSampleCard();
      requestRender();
    });
    row.appendChild(b);
  });
}

function updateSampleCard() {
  const swRef = $('#sw-ref'), swSk = $('#sw-sk'), info = $('#sample-info');
  const pin = $('#btn-pin'), del = $('#btn-note-del');
  swRef.hidden = swSk.hidden = pin.hidden = del.hidden = true;
  if (V.selNote >= 0 && session().notes[V.selNote]) {
    const n = session().notes[V.selNote];
    swRef.hidden = false;
    swRef.style.background = rgbToHex(n.r, n.g, n.b);
    let html = `Notitie · ${sampleInfoHtml(n, null)}`;
    if (n.recipe) html += `<div class="note-recipe"><b>Mengrecept</b>${mixItemHtml(n.recipe, n)}</div>`;
    info.innerHTML = html;
    del.hidden = false;
  } else if (V.sample && V.sample.ref) {
    swRef.hidden = false;
    swRef.style.background = rgbToHex(V.sample.ref.r, V.sample.ref.g, V.sample.ref.b);
    if (V.sample.sk) {
      swSk.hidden = false;
      swSk.style.background = rgbToHex(V.sample.sk.r, V.sample.sk.g, V.sample.sk.b);
    }
    info.innerHTML = sampleInfoHtml(V.sample.ref, V.sample.sk);
    pin.hidden = false;
  } else {
    info.textContent = 'Tik op de afbeelding om een kleur te sampelen.';
  }
}

function hitNote(p) {
  const notes = session().notes;
  for (let i = notes.length - 1; i >= 0; i--) {
    if (dist(worldToScreen(notes[i]), p) < 15) return i;
  }
  return -1;
}

/* ---------- kleurenschema (dominante kleuren) ---------- */
function computePalette() {
  V.palette = dominantColors(refItem().canvas, settings().paletteK);
  V.palette.hi = -1;
  V.palette.hiCanvas = null;
  renderPaletteRow();
  requestRender();
}

function renderPaletteRow() {
  const row = $('#palette-row');
  row.innerHTML = '';
  $('#palette-export').hidden = !V.palette || !V.palette.colors.length;
  if (!V.palette) return;
  V.palette.colors.forEach((c, i) => {
    const b = document.createElement('button');
    b.style.background = c.hex;
    b.title = `${c.hex} · waarde ${c.step}/9 · ${fmt(c.share * 100, 0)}%`;
    b.classList.toggle('hi', V.palette.hi === i);
    b.addEventListener('click', () => {
      V.palette.hi = V.palette.hi === i ? -1 : i;
      toast(`${c.hex} · waarde ${c.step}/9 · aandeel ${fmt(c.share * 100, 0)}%`);
      renderPaletteRow();
      requestRender();
    });
    row.appendChild(b);
  });
}

function paletteHighlightCanvas() {
  const P = V.palette;
  if (!P || P.hi < 0) return null;
  if (!P.hiCanvas || P.hiIdx !== P.hi) {
    const cv = document.createElement('canvas');
    cv.width = P.w;
    cv.height = P.h;
    const ctx = cv.getContext('2d');
    // toon alleen de delen met deze kleur; de rest wordt effen achtergrond
    const id = ctx.createImageData(P.w, P.h);
    for (let i = 0; i < P.w * P.h; i++) {
      if (P.assign[i] !== P.hi) {
        id.data[i * 4] = 12;
        id.data[i * 4 + 1] = 13;
        id.data[i * 4 + 2] = 16;
        id.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
    P.hiCanvas = cv;
    P.hiIdx = P.hi;
  }
  return P.hiCanvas;
}

/* ---------- palet / notities exporteren ---------- */
function exportColors(which) {
  const [what, fmt] = which.split('-');
  const src = what === 'palette'
    ? (V.palette ? V.palette.colors : [])
    : session().notes;
  if (!src.length) { toast('Niets om te exporteren'); return; }
  const colors = src.map(c => ({ r: c.r, g: c.g, b: c.b, label: rgbToHex(c.r, c.g, c.b) }));
  const base = (session().name || 'sightsize').replace(/[^\w-]+/g, '_');
  const name = `${base}-${what === 'palette' ? 'palet' : 'notities'}`;
  if (fmt === 'gpl') downloadFile(`${name}.gpl`, buildGpl(name, colors), 'text/plain');
  else downloadFile(`${name}.ase`, buildAse(colors), 'application/octet-stream');
  toast(`${colors.length} kleuren geëxporteerd (.${fmt})`);
}

/* ---------- mengsuggestie ---------- */
function currentTargetColor() {
  if (settings().mixTarget === 'note') {
    return V.selNote >= 0 ? session().notes[V.selNote] : null;
  }
  return V.sample ? V.sample.ref : null;
}

function mixItemHtml(m, target) {
  const recipe = m.paints
    .slice().sort((a, b) => b.weight - a.weight)
    .map(p => `<span class="dot" style="background:${p.hex}"></span>${p.name} ${Math.round(p.weight * 100)}%`)
    .join('<br>');
  return `<div class="mix-item">
      <span class="pair">
        <span class="chip target" style="background:${rgbToHex(target.r, target.g, target.b)}" title="doel"></span>
        <span class="chip mixed" style="background:${rgbToHex(m.rgb.r, m.rgb.g, m.rgb.b)}" title="mengsel"></span>
      </span>
      <span class="recipe">${recipe}<br><span class="de">verhouding ${m.ratio} · ΔE ${fmt(m.dE, 1)}</span></span>
    </div>`;
}

function computeMix() {
  const target = currentTargetColor();
  const box = $('#mix-results');
  if (!target) { box.innerHTML = '<div class="muted">Sample eerst een kleur (of kies een notitie).</div>'; return; }
  const paints = activePaints();
  if (paints.length < 1) { box.innerHTML = '<div class="muted">Zet minstens één verf aan in de verfdoos.</div>'; return; }
  const mixes = suggestMixes(target, paints, 3);
  box.innerHTML = mixes.map(m => mixItemHtml(m, target)).join('');
  // beste recept bewaren bij de gekozen kleurnotitie
  if (settings().mixTarget === 'note' && V.selNote >= 0 && session().notes[V.selNote] && mixes[0]) {
    session().notes[V.selNote].recipe = mixes[0];
    updateSampleCard();
    toast('Mengrecept bewaard bij notitie ✓');
  }
}

/* ---------- gamut: kleuren van de referentie op een kleurenwiel ---------- */
function renderGamut() {
  const cv = $('#gamut');
  cv.hidden = false;
  const pts = gamutPoints(refItem().canvas);
  const W = cv.width, H = cv.height;
  const ctx = cv.getContext('2d');
  const cx = W / 2, cy = H / 2, R = Math.min(cx, cy) - 6;
  const maxC = 110; // ongeveer de maximale chroma in Lab
  ctx.clearRect(0, 0, W, H);
  // neutrale schijf met assen en chroma-ringen
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = Theme.canvasBg;
  ctx.fill();
  ctx.strokeStyle = '#ffffff30';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.stroke();
  for (const f of [0.33, 0.66, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
    ctx.stroke();
  }
  // punten: +a (rood) naar rechts, +b (geel) omhoog; afstand = verzadiging
  for (const p of pts) {
    const x = cx + clamp(p.a / maxC, -1, 1) * R;
    const y = cy - clamp(p.b / maxC, -1, 1) * R;
    ctx.fillStyle = p.hex;
    ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  }
}

/* ---------- tekenlagen ---------- */
function drawingLayers() { return session().drawing.layers; }
function lineLayers() { return drawingLayers().filter(l => l.kind !== 'values'); }
function valueLayers() { return drawingLayers().filter(l => l.kind === 'values'); }
function activeLayer() {
  const d = session().drawing;
  return d.layers[d.active];
}

// hoekpunten van het canvas (referentievlak) — handig om precies op de rand te mikken
function canvasCorners() {
  const c = refItem().canvas;
  return [{ x: 0, y: 0 }, { x: c.width, y: 0 }, { x: c.width, y: c.height }, { x: 0, y: c.height }];
}

// verzamel alle "vastklik"-punten: lijnuiteinden, vlakhoekpunten én canvas-hoeken
function snapCandidates(exclude) {
  const out = [];
  for (const layer of drawingLayers()) {
    if (!layer.visible) continue;
    if (layer.kind === 'values') {
      for (const sh of layer.shapes) for (const p of sh.pts) { if (p !== exclude) out.push(p); }
    } else {
      for (const s of layer.strokes) for (const p of [s.pts[0], s.pts[s.pts.length - 1]]) { if (p !== exclude) out.push(p); }
    }
  }
  for (const c of canvasCorners()) out.push(c);
  return out;
}

// alle randsegmenten om op te snappen: vlakranden en lijnstukken (voor aansluiten)
function snapSegments(exclude, excludeShape) {
  const segs = [];
  for (const layer of drawingLayers()) {
    if (!layer.visible) continue;
    if (layer.kind === 'values') {
      for (const sh of layer.shapes) {
        if (sh === excludeShape || sh.pts.length < 2) continue;
        for (let i = 0; i < sh.pts.length; i++) {
          const a = sh.pts[i], b = sh.pts[(i + 1) % sh.pts.length];
          if (a === exclude || b === exclude) continue; // eigen aangrenzende rand overslaan
          segs.push({ a, b });
        }
      }
    } else {
      for (const s of layer.strokes) {
        for (let i = 0; i + 1 < s.pts.length; i++) {
          const a = s.pts[i], b = s.pts[i + 1];
          if (a === exclude || b === exclude) continue;
          segs.push({ a, b });
        }
      }
    }
  }
  // randen van het canvas
  const cc = canvasCorners();
  for (let i = 0; i < 4; i++) segs.push({ a: cc[i], b: cc[(i + 1) % 4] });
  return segs;
}

// dichtstbijzijnde punt op een lijnstuk
function closestOnSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return { x: a.x, y: a.y };
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return { x: a.x + t * dx, y: a.y + t * dy };
}

// klik een punt vast: eerst aan een hoekpunt/uiteinde, anders aan een rand van
// een ander vlak of lijn (zodat vlakken op elkaars lijn aansluiten)
function snapToEndpoint(w, exclude, excludeShape) {
  if (!settings().drawSnap) return { x: w.x, y: w.y };
  const tol = 12 / V.view.s;
  let best = null, bestD = tol;
  for (const p of snapCandidates(exclude)) {
    const d = dist(p, w);
    if (d < bestD) { bestD = d; best = { x: p.x, y: p.y }; }
  }
  if (best) return best; // hoekpunt/uiteinde heeft voorrang
  let bestE = null, bestED = tol;
  for (const seg of snapSegments(exclude, excludeShape)) {
    const q = closestOnSeg(w, seg.a, seg.b);
    const d = dist(q, w);
    if (d < bestED) { bestED = d; bestE = q; }
  }
  return bestE || { x: w.x, y: w.y };
}

// dichtstbijzijnde eindpunt van een zichtbare lijn om te verslepen
function hitEndpoint(screenPt) {
  const tol = 16;
  let best = null, bestD = tol;
  for (const layer of drawingLayers()) {
    if (!layer.visible || layer.kind === 'values') continue;
    for (const s of layer.strokes) {
      for (const p of [s.pts[0], s.pts[s.pts.length - 1]]) {
        const d = dist(worldToScreen(p), screenPt);
        if (d < bestD) { bestD = d; best = { stroke: s, pt: p }; }
      }
    }
  }
  return best;
}

function drawEndpointHandles(ctx) {
  if (!V.draw.edit) return;
  const rr = 5 / V.view.s;
  ctx.save();
  ctx.lineWidth = 1.5 / V.view.s;
  for (const layer of drawingLayers()) {
    if (!layer.visible || layer.kind === 'values') continue;
    for (const s of layer.strokes) {
      for (const p of [s.pts[0], s.pts[s.pts.length - 1]]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffffcc';
        ctx.fill();
        ctx.strokeStyle = '#000000aa';
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function eraseAt(w) {
  const tol = 10 / V.view.s;
  for (const layer of drawingLayers()) {
    if (!layer.visible || layer.kind === 'values') continue;
    const strokes = layer.strokes;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      const hit = s.pts.length === 1
        ? dist(s.pts[0], w) < s.w / 2 + tol
        : s.pts.some((p, j) => j > 0 && distToSeg(w, s.pts[j - 1], p) < s.w / 2 + tol);
      if (hit) {
        strokes.splice(i, 1);
        clearRedo();
        requestRender();
        return;
      }
    }
  }
}

function drawingEmpty() {
  return drawingLayers().every(l => l.kind === 'values' ? !l.shapes.length : !l.strokes.length);
}

/* ---------- waardenvlakken: meten, renderen, gereedschap ---------- */
// gemeten luminantie van de referentie onder een vlak (gecached tot het wijzigt)
function shapeLum(sh) {
  if (sh._lum == null) sh._lum = averageLuminanceInPolygon(refItem().canvas, sh.pts);
  return sh._lum;
}

function drawValueShapes(ctx, layer, N, groupAlpha = 1) {
  const reveal = settings().valueReveal;
  const lop = layer.opacity == null ? 1 : layer.opacity;
  for (const sh of layer.shapes) {
    if (!sh.pts || sh.pts.length < 3) continue;
    const step = stepOfValue(sh.v, N);
    let fill;
    if (reveal) {
      const lum = shapeLum(sh);
      if (lum == null) { const g = greyOfStep(step, N); fill = `rgb(${g},${g},${g})`; }
      else {
        const diff = Math.abs(stepOfValue(lum, N) - step);
        const t = clamp(diff / 3, 0, 1); // 0 = raak (groen), >=3 = ver ernaast (rood)
        fill = `rgb(${Math.round(40 + t * 200)},${Math.round(190 - t * 150)},70)`;
      }
    } else {
      const g = greyOfStep(step, N);
      fill = `rgb(${g},${g},${g})`;
    }
    ctx.save();
    ctx.globalAlpha = clamp(groupAlpha * lop * (sh.opacity == null ? 1 : sh.opacity), 0, 1);
    ctx.fillStyle = fill;
    tracePoly(ctx, sh.pts);
    ctx.fill();
    ctx.restore();
    if (V.mode === 'draw' && V.draw.tool === 'shape' && V.draw.selShape && V.draw.selShape.shape === sh) {
      ctx.save();
      ctx.lineWidth = 2 / V.view.s;
      ctx.strokeStyle = '#4da3ff';
      tracePoly(ctx, sh.pts);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function tracePoly(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

// vlak-in-wording: lijnen tussen de gezette punten + terug naar het begin
function drawShapeInProgress(ctx) {
  const poly = V.draw.poly;
  if (!poly || !poly.length) return;
  ctx.save();
  ctx.lineWidth = 1.6 / V.view.s;
  ctx.strokeStyle = '#4da3ff';
  ctx.setLineDash([6 / V.view.s, 4 / V.view.s]);
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  if (poly.length >= 2) ctx.lineTo(poly[0].x, poly[0].y);
  ctx.stroke();
  ctx.restore();
}

// hoekpunt-grepen: van het vlak-in-wording, of van het geselecteerde vlak in aanpasmodus
function drawShapeHandles(ctx) {
  const rr = 5 / V.view.s;
  const draw = (pts, first) => {
    ctx.save();
    ctx.lineWidth = 1.5 / V.view.s;
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = (first && i === 0) ? '#4da3ff' : '#ffffffcc';
      ctx.fill();
      ctx.strokeStyle = '#000000aa';
      ctx.stroke();
    });
    ctx.restore();
  };
  if (V.draw.poly && V.draw.poly.length) draw(V.draw.poly, true);
  if (V.draw.edit && V.draw.selShape) draw(V.draw.selShape.shape.pts, false);
}

// dichtstbijzijnde hoekpunt van het geselecteerde vlak om te verslepen (aanpasmodus)
function hitShapeVertex(screenPt) {
  const tol = 16;
  let best = null, bestD = tol;
  if (V.draw.selShape) {
    V.draw.selShape.shape.pts.forEach((p, i) => {
      const d = dist(worldToScreen(p), screenPt);
      if (d < bestD) { bestD = d; best = { pts: V.draw.selShape.shape.pts, i, shape: V.draw.selShape.shape }; }
    });
  }
  return best;
}

// dichtstbijzijnde rand van het geselecteerde vlak (voor een tussenpunt), niet vlak bij een hoekpunt
function hitShapeEdge(screenPt) {
  if (!V.draw.selShape) return null;
  const pts = V.draw.selShape.shape.pts;
  const tol = 12;
  let best = null, bestD = tol;
  for (let i = 0; i < pts.length; i++) {
    const a = worldToScreen(pts[i]);
    const b = worldToScreen(pts[(i + 1) % pts.length]);
    if (dist(a, screenPt) < 14 || dist(b, screenPt) < 14) continue; // bij een hoekpunt: geen rand-actie
    const d = distToSeg(screenPt, a, b);
    if (d < bestD) { bestD = d; best = { index: i + 1 }; }
  }
  return best;
}

// een tik in vlak-gereedschap: punt zetten, vlak sluiten, tussenpunt toevoegen of een vlak selecteren
function shapeTap(w) {
  const poly = V.draw.poly;
  if (poly) {
    if (poly.length >= 3 && dist(worldToScreen(poly[0]), worldToScreen(w)) < 16) closePoly();
    else poly.push(snapToEndpoint(w));
    requestRender();
    return;
  }
  // aanpasmodus: tik op een rand van het geselecteerde vlak → tussenpunt toevoegen
  if (V.draw.edit && V.draw.selShape) {
    const ins = hitShapeEdge(worldToScreen(w));
    if (ins) {
      const p = snapToEndpoint(w, null, V.draw.selShape.shape);
      V.draw.selShape.shape.pts.splice(ins.index, 0, { x: p.x, y: p.y });
      V.draw.selShape.shape._lum = null;
      clearRedo();
      updateShapeCheck();
      toast('Punt toegevoegd');
      requestRender();
      return;
    }
  }
  const hit = hitShape(w);
  if (hit) selectShape(hit);
  else if (V.draw.edit) selectShape(null); // in aanpasmodus geen nieuw vlak beginnen
  else { V.draw.poly = [snapToEndpoint(w)]; selectShape(null); }
  requestRender();
}

function closePoly() {
  const layer = activeValueLayer();
  const shape = { pts: V.draw.poly.map(p => ({ x: p.x, y: p.y })), v: V.draw.lastVal, opacity: 1, _lum: null };
  layer.shapes.unshift(shape);
  clearRedo();
  V.draw.poly = null;
  settings().showValues = true;
  refreshLayerStrip();
  selectShape({ layer, shape });
  toast('Vlak toegevoegd — kies een waarde');
}

// bovenste zichtbare vlak onder een wereldpunt
function hitShape(w) {
  const layers = drawingLayers();
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    if (L.kind !== 'values' || !L.visible) continue;
    for (let j = L.shapes.length - 1; j >= 0; j--) {
      const sh = L.shapes[j];
      if (sh.pts.length >= 3 && pointInPolygon(w.x, w.y, sh.pts)) return { layer: L, shape: sh };
    }
  }
  return null;
}

function eraseShapeAt(w) {
  const hit = hitShape(w);
  if (!hit) return;
  const arr = hit.layer.shapes;
  arr.splice(arr.indexOf(hit.shape), 1);
  clearRedo();
  if (V.draw.selShape && V.draw.selShape.shape === hit.shape) selectShape(null);
  requestRender();
}

// zorg dat de actieve laag van het gevraagde type is; maak er anders een
function ensureLayerKind(kind) {
  const d = session().drawing;
  if (d.layers[d.active] && d.layers[d.active].kind === kind) return d.layers[d.active];
  const idx = d.layers.findIndex(l => l.kind === kind);
  if (idx >= 0) { d.active = idx; return d.layers[idx]; }
  return addLayer(kind);
}

function activeValueLayer() { return ensureLayerKind('values'); }

/* ---------- ongedaan maken / opnieuw (lijnen en vlakken) ---------- */
function clearRedo() { V.draw.redo = []; }

function drawUndo() {
  if (V.draw.tool === 'shape') {
    if (V.draw.poly) { // eerst punten van het vlak-in-wording terugnemen
      V.draw.poly.pop();
      if (!V.draw.poly.length) V.draw.poly = null;
    } else {
      const l = activeValueLayer();
      const sh = l.shapes.shift();
      if (sh) {
        V.draw.redo.push({ kind: 'shape', layer: l, item: sh });
        if (V.draw.selShape && V.draw.selShape.shape === sh) selectShape(null);
      }
    }
  } else {
    const l = ensureLayerKind('lines');
    const s = l.strokes.pop();
    if (s) V.draw.redo.push({ kind: 'stroke', layer: l, item: s });
  }
  requestRender();
}

function drawRedo() {
  const op = V.draw.redo.pop();
  if (!op) { toast('Niets om opnieuw te doen'); return; }
  if (op.kind === 'shape') {
    op.layer.shapes.unshift(op.item);
    op.item._lum = null;
    settings().showValues = true;
    if (V.draw.tool === 'shape') selectShape({ layer: op.layer, shape: op.item });
  } else {
    op.layer.strokes.push(op.item);
  }
  refreshLayerStrip();
  requestRender();
}

function saveDrawingVersion() {
  const s = session();
  if (drawingEmpty()) { toast('Nog geen tekening om op te slaan'); return; }
  const name = prompt('Naam voor deze tekenversie:', `Tekening ${s.drawingVersions.length + 1}`);
  if (name === null) return;
  s.drawingVersions.push({
    label: name.trim() || `Tekening ${s.drawingVersions.length + 1}`,
    created: Date.now(),
    drawing: JSON.parse(JSON.stringify(s.drawing)),
  });
  updateDrawVersionSelect();
  toast('Tekenversie opgeslagen ✓');
}

/* ---------- lagenbeheer-UI ---------- */
function renderLayerList() {
  const box = $('#layer-list');
  if (!box) return;
  box.innerHTML = '';
  const d = session().drawing;
  d.layers.forEach((layer, i) => {
    const row = document.createElement('div');
    row.className = 'layer-row' + (i === d.active ? ' active' : '');
    const handle = document.createElement('button');
    handle.className = 'handle';
    handle.innerHTML = svgIcon('grip');
    handle.title = 'Sleep om de volgorde te wijzigen';
    handle.addEventListener('pointerdown', (e) => startLayerDrag(e, layer));
    const vis = document.createElement('button');
    vis.className = 'vis';
    vis.innerHTML = svgIcon(layer.visible ? 'eye' : 'eyeOff');
    vis.title = layer.visible ? 'Laag verbergen' : 'Laag tonen';
    vis.addEventListener('click', (e) => {
      e.stopPropagation();
      layer.visible = !layer.visible;
      renderLayerList();
      requestRender();
    });
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.innerHTML = svgIcon(layer.kind === 'values' ? 'fill' : 'draw');
    kind.title = layer.kind === 'values' ? 'Waardenlaag' : 'Lijnlaag';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = layer.name;
    name.addEventListener('click', () => { d.active = i; renderLayerList(); });
    name.addEventListener('dblclick', () => {
      const nn = prompt('Laagnaam:', layer.name);
      if (nn !== null) { layer.name = nn.trim() || layer.name; renderLayerList(); }
    });
    const del = document.createElement('button');
    del.className = 'del';
    del.innerHTML = svgIcon('trash');
    del.title = 'Laag verwijderen';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (d.layers.length === 1) { toast('Minstens één laag nodig'); return; }
      const nonEmpty = layer.kind === 'values' ? layer.shapes.length : layer.strokes.length;
      if (nonEmpty && !confirm(`Laag “${layer.name}” verwijderen?`)) return;
      d.layers.splice(i, 1);
      d.active = Math.min(d.active, d.layers.length - 1);
      clearRedo();
      renderLayerList();
      requestRender();
    });
    row.append(handle, vis, kind, name, del);
    if (V.layerDrag && V.layerDrag.layer === layer) row.classList.add('dragging');
    box.appendChild(row);
  });
}

// lagen slepen om de stapelvolgorde te wijzigen
function startLayerDrag(e, layer) {
  e.preventDefault();
  e.stopPropagation();
  const d = session().drawing;
  const activeObj = d.layers[d.active];
  V.layerDrag = { layer };
  const box = $('#layer-list');
  const move = (ev) => {
    const rows = [...box.children];
    let target = rows.findIndex(rw => {
      const rect = rw.getBoundingClientRect();
      return ev.clientY < rect.top + rect.height / 2;
    });
    if (target < 0) target = d.layers.length;
    const cur = d.layers.indexOf(layer);
    let ins = target > cur ? target - 1 : target;
    ins = clamp(ins, 0, d.layers.length - 1);
    if (ins !== cur) {
      d.layers.splice(cur, 1);
      d.layers.splice(ins, 0, layer);
      d.active = d.layers.indexOf(activeObj);
      renderLayerList();
      requestRender();
    }
  };
  const up = () => {
    V.layerDrag = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    renderLayerList();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function updateDrawToggles() {
  $('#btn-eraser').classList.toggle('on', V.draw.erase);
  $('#btn-edit').classList.toggle('on', V.draw.edit);
  $('#btn-tool-line').classList.toggle('on', V.draw.tool === 'line');
  $('#btn-tool-shape').classList.toggle('on', V.draw.tool === 'shape');
  // lijnkleur/-dikte alleen relevant voor het lijngereedschap
  const lineOnly = V.draw.tool === 'shape' ? 'none' : '';
  $('#set-drawcolor').style.display = lineOnly;
  $('#set-drawwidth').style.display = lineOnly;
  updateHint();
  requestRender();
}

function addLayer(kind = 'lines') {
  const d = session().drawing;
  // nieuwe laag bovenop: vooraan in de lijst (die van boven naar onder stapelt)
  d._counter = (d._counter || d.layers.length) + 1;
  const layer = kind === 'values'
    ? { name: `Waarden ${d._counter}`, kind: 'values', visible: true, shapes: [], opacity: 1 }
    : { name: `Laag ${d._counter}`, kind: 'lines', visible: true, strokes: [] };
  d.layers.unshift(layer);
  d.active = 0;
  if (kind === 'values') settings().showValues = true; else settings().showDrawing = true;
  clearRedo();
  refreshLayerStrip();
  renderLayerList();
  requestRender();
  return layer;
}

/* ---------- waardenvlak: gereedschap en instellingen ---------- */
function setDrawTool(tool) {
  V.draw.tool = tool;
  V.draw.poly = null;
  V.draw.erase = false;
  V.draw.edit = false;
  if (tool === 'shape') { activeValueLayer(); settings().showValues = true; }
  else ensureLayerKind('lines');
  selectShape(null);
  refreshLayerStrip();
  renderLayerList();
  buildVScale();
  updateDrawToggles();
}

function selectShape(sel) {
  V.draw.selShape = sel;
  const box = $('#vshape-controls');
  if (box) box.hidden = !sel;
  if (sel) {
    $('#set-vshape-op').value = sel.shape.opacity == null ? 1 : sel.shape.opacity;
    buildVScale();
    updateShapeCheck();
  }
  requestRender();
}

// waardenstrook opbouwen op basis van het huidige aantal waarden (N)
function buildVScale() {
  const el = $('#vscale');
  if (!el) return;
  const N = settings().valueN;
  const selStep = V.draw.selShape ? stepOfValue(V.draw.selShape.shape.v, N) : -1;
  el.innerHTML = '';
  for (let i = 0; i < N; i++) {
    const g = greyOfStep(i, N);
    const s = document.createElement('span');
    s.style.background = `rgb(${g},${g},${g})`;
    s.title = `Waarde ${i + 1}/${N}`;
    if (i === selStep) s.classList.add('sel');
    s.addEventListener('click', () => {
      const v = N <= 1 ? 0.5 : i / (N - 1);
      V.draw.lastVal = v;
      if (V.draw.selShape) { V.draw.selShape.shape.v = v; updateShapeCheck(); }
      buildVScale();
      requestRender();
    });
    el.appendChild(s);
  }
}

// zelfcheck: gemeten referentiewaarde onder het vlak vs de gekozen waarde
function updateShapeCheck() {
  const box = $('#vshape-check');
  if (!box) return;
  const sel = V.draw.selShape;
  if (!sel) { box.textContent = ''; return; }
  const N = settings().valueN;
  const step = stepOfValue(sel.shape.v, N) + 1;
  const lum = shapeLum(sel.shape);
  if (lum == null) { box.innerHTML = `Gekozen waarde <b>${step}/${N}</b>.`; return; }
  const meas = stepOfValue(lum, N) + 1;
  const d = step - meas;
  const rel = d === 0 ? 'gelijk aan de referentie'
    : `${Math.abs(d)} stap${Math.abs(d) === 1 ? '' : 'pen'} ${d > 0 ? 'lichter' : 'donkerder'} dan de referentie`;
  box.innerHTML = `Gekozen <b>${step}/${N}</b> · referentie <b>${meas}/${N}</b> — ${rel}.`;
}

function updateDrawVersionSelect() {
  const sel = $('#set-drawversion');
  sel.innerHTML = '<option value="">— kies —</option>';
  session().drawingVersions.forEach((v, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = v.label;
    sel.appendChild(o);
  });
}

/* ---------- tikacties (meten / uitlijnen) ---------- */
function updateMeasureResult() {
  const m = V.measure;
  if (m.refPts.length < 2 || m.skPts.length < 2) { m.result = null; return; }
  const lenRef = dist(m.refPts[0], m.refPts[1]);
  const lenSk = dist(m.skPts[0], m.skPts[1]);
  const pct = lenRef > 1e-6 ? ((lenSk - lenRef) / lenRef) * 100 : 0;
  const dims = refItem().dims;
  const toStr = dims
    ? (px) => `${fmt(px * dims.w / refItem().canvas.width)} cm`
    : (px) => `${fmt(px, 0)} px`;
  const sign = pct >= 0 ? '+' : '';
  m.result = `Referentie ${toStr(lenRef)} · schets ${toStr(lenSk)} · afwijking ${sign}${fmt(pct)}%`;
}

function handleTap(world) {
  if (V.mode === 'measure') {
    const m = V.measure;
    if (m.stage >= 4) {
      V.measure = { stage: 0, refPts: [], skPts: [], result: null };
      updateHint();
      requestRender();
      return;
    }
    (m.stage < 2 ? m.refPts : m.skPts).push(world);
    m.stage++;
    if (m.stage === 4) updateMeasureResult();
    updateHint();
    requestRender();
  } else if (V.mode === 'align') {
    const a = V.align;
    if (a.stage >= 4) return;
    a.pts.push({ world, kind: a.stage % 2 === 0 ? 'ref' : 'sk' });
    a.stage++;
    $('#btn-align-apply').disabled = a.stage < 4;
    updateHint();
    requestRender();
  } else if (V.mode === 'sample') {
    const ni = hitNote(worldToScreen(world));
    if (ni >= 0) {
      V.selNote = ni;
      V.sample = null;
    } else {
      V.selNote = -1;
      doSample(world);
    }
    updateSampleCard();
    renderNotesRow();
    requestRender();
  }
}

// de aangetikte schetspunten zijn wereldposities van schetsdetails; pas bij het
// toepassen worden ze via de huidige transform naar schetscoördinaten vertaald
function applyAlign() {
  const a = V.align;
  if (a.stage < 4) return;
  const refPts = a.pts.filter(p => p.kind === 'ref').map(p => p.world);
  const inv = invertSim(activeSketch().transform);
  const skPts = a.pts.filter(p => p.kind === 'sk').map(p => applySim(inv, p.world));
  const T = similarityFrom2(skPts[0], skPts[1], refPts[0], refPts[1]);
  if (T) {
    activeSketch().transform = T;
    toast('Schets uitgelijnd ✓');
    setMode('pan');
  } else {
    toast('Punten liggen te dicht bij elkaar');
  }
}

/* ---------- gezette meet-/ankerpunten oppakken om bij te stellen ----------
   Tijdens het plaatsen zijn alleen punten van de reeks die je nu zet
   oppakbaar; zo kan een schetspunt vlak naast een referentiepunt gezet
   worden. Bij overlappende punten wint het dichtstbijzijnde.              */
function hitAdjustPoint(p) {
  const grab = 18;
  const cands = [];
  if (V.mode === 'measure') {
    const m = V.measure;
    const lists = m.stage >= 4 ? [[m.refPts, 'ref'], [m.skPts, 'sketch']]
      : m.stage < 2 ? [[m.refPts, 'ref']] : [[m.skPts, 'sketch']];
    for (const [list, kind] of lists) {
      list.forEach((pt, i) => cands.push({
        d: dist(worldToScreen(pt), p), kind,
        set: (w) => { list[i] = w; updateMeasureResult(); },
      }));
    }
  } else if (V.mode === 'align') {
    const a = V.align;
    const curKind = a.stage >= 4 ? null : (a.stage % 2 === 0 ? 'ref' : 'sk');
    for (const pt of a.pts) {
      if (curKind && pt.kind !== curKind) continue;
      cands.push({
        d: dist(worldToScreen(pt.world), p),
        kind: pt.kind === 'sk' ? 'sketch' : 'ref',
        set: (w) => { pt.world = w; },
      });
    }
  }
  cands.sort((a, b) => a.d - b.d);
  return cands.length && cands[0].d < grab ? cands[0] : null;
}

/* ---------- hulplijnen ---------- */
function hitGuide(p) {
  const guides = session().guides;
  for (let i = 0; i < guides.length; i++) {
    const g = guides[i];
    const d = g.type === 'h'
      ? Math.abs(g.pos * V.view.s + V.view.ty - p.y)
      : Math.abs(g.pos * V.view.s + V.view.tx - p.x);
    if (d < 12) return i;
  }
  return null;
}

function addGuide(type) {
  const r = V.cv.getBoundingClientRect();
  const c = screenToWorld({ x: r.width / 2, y: r.height / 2 });
  session().guides.push({ type, pos: type === 'h' ? c.y : c.x });
  requestRender();
}

/* ---------- gestures ---------- */
function onPointerDown(e) {
  V.cv.setPointerCapture(e.pointerId);
  const p = eventPos(e);
  V.pointers.set(e.pointerId, p);
  if (V.pointers.size === 1) {
    V.gesture = { type: 'single', start: p, last: p, moved: false, guide: null, adjust: null, con: null, drawing: false };
    if (V.mode === 'pan') {
      V.gesture.con = hitConstructionHandle(p); // handvatten van de kopconstructie eerst
      if (!V.gesture.con) V.gesture.guide = hitGuide(p);
    }
    V.gesture.adjust = hitAdjustPoint(p);
    if (V.gesture.adjust) { V.dragKind = V.gesture.adjust.kind; requestRender(); }
    else if (V.mode === 'draw' && V.draw.tool === 'shape') {
      const w = screenToWorld(p);
      if (V.draw.erase) {
        V.gesture.drawing = true;
        eraseShapeAt(w);
      } else if (V.draw.edit && V.draw.selShape) {
        // in aanpasmodus een hoekpunt van het geselecteerde vlak oppakken
        const grab = hitShapeVertex(p);
        if (grab) { V.gesture.drawing = true; V.draw.vtx = grab; grab.shape._lum = null; }
      }
      // anders: geen sleep — een tik zet een punt, sluit het vlak of selecteert er een
      requestRender();
    }
    else if (V.mode === 'draw') {
      V.gesture.drawing = true;
      const w = screenToWorld(p);
      if (V.draw.erase) {
        eraseAt(w);
      } else if (V.draw.edit) {
        // eindpunt van een bestaande lijn oppakken en verslepen
        const grab = hitEndpoint(p);
        if (grab) { V.draw.editPt = grab.pt; V.draw.editStroke = grab.stroke; }
      } else {
        const start = snapToEndpoint(w);
        V.draw.cur = { color: settings().drawColor, w: settings().drawWidth, pts: [start, start] };
      }
      requestRender();
    }
  } else if (V.pointers.size === 2) {
    // tweede vinger: lijn-/punt-in-wording annuleren, gebaar wordt pannen/zoomen
    V.draw.cur = null;
    V.draw.vtx = null;
    const ids = [...V.pointers.keys()];
    V.gesture = {
      type: 'pinch',
      ids,
      start: ids.map(id => ({ ...V.pointers.get(id) })),
      view0: { ...V.view },
      T0: { ...activeSketch().transform },
    };
  }
  e.preventDefault();
}

function onPointerMove(e) {
  if (!V.pointers.has(e.pointerId)) return;
  const p = eventPos(e);
  const prev = V.pointers.get(e.pointerId);
  V.pointers.set(e.pointerId, p);
  const g = V.gesture;
  if (!g) return;

  if (g.type === 'single' && V.pointers.size === 1) {
    const dx = p.x - prev.x, dy = p.y - prev.y;
    if (dist(p, g.start) > 6) g.moved = true;
    if (g.adjust) {
      g.adjust.set(screenToWorld(p));
      updateHint();
    } else if (g.con) {
      g.con.set(screenToWorld(p));
    } else if (g.drawing) {
      const w = screenToWorld(p);
      if (V.draw.tool === 'shape') {
        if (V.draw.erase) eraseShapeAt(w);
        else if (V.draw.vtx) {
          const snapped = snapToEndpoint(w, V.draw.vtx.pts[V.draw.vtx.i], V.draw.vtx.shape);
          V.draw.vtx.pts[V.draw.vtx.i] = { x: snapped.x, y: snapped.y };
          if (V.draw.vtx.shape) V.draw.vtx.shape._lum = null;
        }
      } else if (V.draw.erase) {
        eraseAt(w);
      } else if (V.draw.editPt) {
        const snapped = snapToEndpoint(w, V.draw.editPt);
        V.draw.editPt.x = snapped.x;
        V.draw.editPt.y = snapped.y;
      } else if (V.draw.cur) {
        V.draw.cur.pts[1] = snapToEndpoint(w);
      }
    } else if (g.guide != null) {
      const guide = session().guides[g.guide];
      if (guide) guide.pos += (guide.type === 'h' ? dy : dx) / V.view.s;
    } else if (V.mode === 'move') {
      const T = activeSketch().transform;
      T.tx += dx / V.view.s;
      T.ty += dy / V.view.s;
    } else {
      V.view.tx += dx;
      V.view.ty += dy;
    }
    requestRender();
  } else if (g.type === 'pinch' && V.pointers.size === 2) {
    const cur = g.ids.map(id => V.pointers.get(id));
    if (!cur[0] || !cur[1]) return;
    if (V.mode === 'move') {
      // twee vingers transformeren de schets (schaal + rotatie + translatie)
      const w0 = g.start.map(screenToWorld);
      const w1 = cur.map(screenToWorld);
      const S = similarityFrom2(w0[0], w0[1], w1[0], w1[1]);
      if (S) activeSketch().transform = composeSim(S, g.T0);
    } else {
      const d0 = Math.max(1e-6, dist(g.start[0], g.start[1]));
      const k = dist(cur[0], cur[1]) / d0;
      const s1 = clamp(g.view0.s * k, 0.02, 60);
      const mid0 = { x: (g.start[0].x + g.start[1].x) / 2, y: (g.start[0].y + g.start[1].y) / 2 };
      const mid1 = { x: (cur[0].x + cur[1].x) / 2, y: (cur[0].y + cur[1].y) / 2 };
      const m = { x: (mid0.x - g.view0.tx) / g.view0.s, y: (mid0.y - g.view0.ty) / g.view0.s };
      V.view.s = s1;
      V.view.tx = mid1.x - m.x * s1;
      V.view.ty = mid1.y - m.y * s1;
    }
    requestRender();
  }
  e.preventDefault();
}

function onPointerUp(e) {
  if (!V.pointers.has(e.pointerId)) return;
  const p = eventPos(e);
  const g = V.gesture;
  V.pointers.delete(e.pointerId);

  V.dragKind = null;
  if (V.pointers.size === 0 && (V.draw.cur || V.draw.editPt)) {
    if (V.draw.cur) {
      // alleen een echt lijnstuk bewaren; een tikje zonder sleep vervalt
      if (dist(V.draw.cur.pts[0], V.draw.cur.pts[1]) > 3 / V.view.s) {
        ensureLayerKind('lines').strokes.push(V.draw.cur);
        clearRedo();
      }
      V.draw.cur = null;
    }
    V.draw.editPt = null;
    V.draw.editStroke = null;
    requestRender();
  }
  if (V.pointers.size === 0 && V.draw.vtx) {
    const sh = V.draw.vtx.shape;
    const idx = V.draw.vtx.i;
    const wasTap = g && !g.moved;
    V.draw.vtx = null;
    if (wasTap && sh && V.draw.edit) {
      // tik (zonder slepen) op een hoekpunt in aanpasmodus → verwijderen
      if (sh.pts.length > 3) { sh.pts.splice(idx, 1); sh._lum = null; clearRedo(); updateShapeCheck(); toast('Punt verwijderd'); }
      else toast('Een vlak heeft minstens 3 punten nodig');
    } else if (sh) {
      sh._lum = null;
      if (V.draw.selShape && V.draw.selShape.shape === sh) updateShapeCheck();
    }
    requestRender();
  }
  if (g && g.type === 'single' && V.pointers.size === 0) {
    if (g.adjust || g.drawing) {
      // punt bijgesteld of lijn getekend; geen tik-actie
    } else if (g.guide != null) {
      // hulplijn buiten het referentievlak gesleept → verwijderen
      const guide = session().guides[g.guide];
      const ref = refItem().canvas;
      if (guide) {
        const lim = guide.type === 'h' ? ref.height : ref.width;
        if (guide.pos < -lim * 0.02 || guide.pos > lim * 1.02) {
          session().guides.splice(g.guide, 1);
          toast('Hulplijn verwijderd');
        }
      }
    } else if (!g.moved && (V.mode === 'measure' || V.mode === 'align' || V.mode === 'sample')) {
      handleTap(screenToWorld(p));
    } else if (!g.moved && V.mode === 'draw' && V.draw.tool === 'shape' && !V.draw.erase) {
      shapeTap(screenToWorld(p));
    }
    V.gesture = null;
  } else if (V.pointers.size === 1) {
    // van pinch terug naar één vinger: opnieuw beginnen zonder sprong
    const rest = [...V.pointers.values()][0];
    V.gesture = { type: 'single', start: rest, last: rest, moved: true, guide: null };
  } else if (V.pointers.size === 0) {
    V.gesture = null;
  }
  requestRender();
}

function onWheel(e) {
  e.preventDefault();
  const p = eventPos(e);
  const k = Math.exp(-e.deltaY * 0.0015);
  const s1 = clamp(V.view.s * k, 0.02, 60);
  const m = screenToWorld(p);
  V.view.s = s1;
  V.view.tx = p.x - m.x * s1;
  V.view.ty = p.y - m.y * s1;
  requestRender();
}

/* ---------- schets stapsgewijs bijstellen ---------- */
function nudgeSketch(kind) {
  const sk = activeSketch();
  const c = applySim(sk.transform, { x: sk.canvas.width / 2, y: sk.canvas.height / 2 });
  let S = null;
  if (kind === 'rotl') S = simAboutPoint(c, 1, -Math.PI / 360);
  else if (kind === 'rotr') S = simAboutPoint(c, 1, Math.PI / 360);
  else if (kind === 'smaller') S = simAboutPoint(c, 1 / 1.01, 0);
  else if (kind === 'bigger') S = simAboutPoint(c, 1.01, 0);
  if (S) {
    sk.transform = composeSim(S, sk.transform);
    requestRender();
  }
}

/* ---------- flikkeren ---------- */
function applyFlicker() {
  const st = settings();
  if (V.flickerTimer) { clearInterval(V.flickerTimer); V.flickerTimer = null; }
  V.flickerHidden = false;
  if (st.flicker) {
    V.flickerTimer = setInterval(() => {
      V.flickerHidden = !V.flickerHidden;
      requestRender();
    }, st.flickerMs);
  }
  $('#btn-flicker').classList.toggle('on', st.flicker);
  $('#set-flicker').checked = st.flicker;
  requestRender();
}

/* ---------- paneel ---------- */
function syncPanel() {
  const st = settings();
  $('#set-opacity').value = st.opacity;
  $('#set-sketchmode').value = st.sketchMode;
  $('#set-linecolor').value = st.lineColor;
  $('#set-blend').value = st.blend;
  $('#set-refmode').value = st.refMode;
  $('#set-levels').value = st.refLevels;
  $('#set-threshold').value = st.refThreshold;
  $('#set-blur').value = st.refBlur;
  $('#set-blvalues').checked = st.blockinValues;
  $('#set-blcontours').checked = st.blockinContours;
  $('#set-blockindetail').value = st.blockinDetail;
  $('#set-drawcolor').value = st.drawColor;
  $('#set-drawwidth').value = st.drawWidth;
  $('#set-valuen').value = st.valueN;
  $('#valuen-out').textContent = st.valueN;
  const vl0 = valueLayers()[0];
  $('#set-vlayer-op').value = vl0 ? (vl0.opacity == null ? 1 : vl0.opacity) : 1;
  $('#set-valuereveal').checked = st.valueReveal;
  $('#set-samplerad').value = st.sampleRadius;
  buildVScale();
  $('#set-palk').value = st.paletteK;
  $('#palk-out').textContent = st.paletteK;
  $('#set-shownotes').checked = st.showNotes;
  $('#set-mixtarget').value = st.mixTarget;
  $('#set-flicker').checked = st.flicker;
  $('#set-flickerms').value = st.flickerMs;
  $('#set-grid').checked = st.grid;
  $('#set-gridsize').value = st.gridCm;
  const c = con();
  $('#set-con').checked = c.on;
  $('#set-con-color').value = c.color;
  $('#set-con-op').value = c.opacity;
  updateRefRows();
  refreshLayerStrip();
  renderOrderList();
}

/* ---------- persistente lagenstrook ---------- */
function autoLinesOn() { return settings().blockinValues || settings().blockinContours; }

function refreshLayerStrip() {
  const st = settings();
  const map = { ref: st.showRef, blockin: autoLinesOn(), drawing: st.showDrawing, values: st.showValues, sketch: st.showSketch };
  for (const chip of $$('#layer-strip .lchip')) {
    const on = map[chip.dataset.layer];
    chip.classList.toggle('off', !on);
    chip.querySelector('.eye').innerHTML = svgIcon(on ? 'eye' : 'eyeOff');
  }
}

function groupVisible(gp) {
  const st = settings();
  if (gp === 'ref') return st.showRef;
  if (gp === 'sketch') return st.showSketch;
  if (gp === 'drawing') return st.showDrawing;
  if (gp === 'values') return st.showValues;
  if (gp === 'blockin') return autoLinesOn();
  return true;
}

// stapelvolgorde van een inhoudslaag wijzigen (+1 = naar boven op de stapel)
function moveGroup(gp, dir) {
  const order = layerOrderList();
  const i = order.indexOf(gp);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  renderOrderList();
  requestRender();
}

function renderOrderList() {
  const box = $('#order-list');
  if (!box) return;
  const st = settings();
  box.innerHTML = '';
  const top = layerOrderList().slice().reverse(); // boven in de lijst = bovenop
  top.forEach((gp, di) => {
    const row = document.createElement('div');
    row.className = 'order-row' + (groupVisible(gp) ? '' : ' off');
    const up = document.createElement('button');
    up.className = 'mv'; up.innerHTML = svgIcon('chevUp'); up.title = 'Naar boven'; up.disabled = di === 0;
    up.addEventListener('click', () => moveGroup(gp, +1));
    const down = document.createElement('button');
    down.className = 'mv'; down.innerHTML = svgIcon('chevDown'); down.title = 'Naar onder'; down.disabled = di === top.length - 1;
    down.addEventListener('click', () => moveGroup(gp, -1));
    const vis = document.createElement('button');
    vis.className = 'vis';
    const on = groupVisible(gp);
    vis.innerHTML = svgIcon(on ? 'eye' : 'eyeOff');
    vis.title = on ? 'Verbergen' : 'Tonen';
    vis.addEventListener('click', () => toggleLayer(gp));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = LAYER_NAMES[gp];
    const op = document.createElement('input');
    op.type = 'range'; op.min = 0; op.max = 1; op.step = 0.05; op.className = 'op';
    op.value = gp === 'sketch' ? st.opacity : (st.layerOpacity && st.layerOpacity[gp] != null ? st.layerOpacity[gp] : 1);
    op.addEventListener('input', () => {
      const v = +op.value;
      if (gp === 'sketch') { st.opacity = v; const so = $('#set-opacity'); if (so) so.value = v; }
      else { st.layerOpacity = st.layerOpacity || {}; st.layerOpacity[gp] = v; }
      requestRender();
    });
    row.append(up, down, vis, name, op);
    box.appendChild(row);
  });
}

function toggleLayer(which) {
  const st = settings();
  if (which === 'ref') st.showRef = !st.showRef;
  else if (which === 'drawing') st.showDrawing = !st.showDrawing;
  else if (which === 'values') st.showValues = !st.showValues;
  else if (which === 'sketch') st.showSketch = !st.showSketch;
  else if (which === 'blockin') {
    if (autoLinesOn()) {
      V.lastBlockin = { v: st.blockinValues, c: st.blockinContours };
      st.blockinValues = st.blockinContours = false;
    } else if (V.lastBlockin && (V.lastBlockin.v || V.lastBlockin.c)) {
      st.blockinValues = V.lastBlockin.v;
      st.blockinContours = V.lastBlockin.c;
    } else {
      st.blockinContours = true; // eerste keer: contourlijnen als standaard
    }
    $('#set-blvalues').checked = st.blockinValues;
    $('#set-blcontours').checked = st.blockinContours;
  }
  updateRefRows();
  refreshLayerStrip();
  renderOrderList();
  requestRender();
}

/* ---------- contextueel paneel: alleen secties van de actieve modus ---------- */
function filterContext() {
  for (const sec of $$('#panel .ctx')) {
    sec.hidden = !sec.dataset.modes.split(' ').includes(V.mode);
  }
}

/* ---------- instellingen-bodemblad ---------- */
function wrapH() {
  const el = document.querySelector('.canvas-wrap');
  return (el && el.clientHeight) || window.innerHeight * 0.7;
}
function sheetSnaps() { const h = wrapH(); return [Math.round(h * 0.44), Math.round(h * 0.82)]; }

function openSheet(px) {
  const p = $('#panel');
  const snaps = sheetSnaps();
  p.style.setProperty('--sheet-h', (px || snaps[0]) + 'px');
  p.hidden = false;
  filterContext();
  $('#btn-panel').classList.add('on');
  $('#btn-flicker').hidden = true; // enkel het tandwiel blijft over de sheet zweven
}
function closeSheet() {
  $('#panel').hidden = true;
  $('#btn-panel').classList.remove('on');
  $('#btn-flicker').hidden = false;
}

function wireSheet() {
  const p = $('#panel');
  const handle = $('#sheet-handle');
  let startY = 0, startH = 0, dragging = false, moved = false;
  const down = (e) => {
    dragging = true; moved = false;
    startY = e.clientY;
    startH = p.offsetHeight;
    p.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const move = (e) => {
    if (!dragging) return;
    if (Math.abs(e.clientY - startY) > 4) moved = true;
    const h = wrapH();
    const newH = clamp(startH + (startY - e.clientY), 60, h * 0.94);
    p.style.setProperty('--sheet-h', newH + 'px');
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    p.classList.remove('dragging');
    const h = wrapH();
    const snaps = sheetSnaps();
    if (!moved) {
      // tik op de greep: wissel tussen half en vol
      const cur = p.offsetHeight;
      const target = cur < (snaps[0] + snaps[1]) / 2 ? snaps[1] : snaps[0];
      p.style.setProperty('--sheet-h', target + 'px');
      return;
    }
    const cur = p.offsetHeight;
    if (cur < h * 0.24) { closeSheet(); return; }
    const target = snaps.reduce((a, b) => Math.abs(b - cur) < Math.abs(a - cur) ? b : a);
    p.style.setProperty('--sheet-h', target + 'px');
  };
  handle.addEventListener('pointerdown', down);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}

// sliders alleen tonen bij de weergave waar ze bij horen
const VALSCALE = ['#141414','#333333','#4d4d4d','#666666','#808080','#999999','#b3b3b3','#cccccc','#f2f2f2'];
function buildValScale() {
  const el = $('#valscale');
  if (el.children.length) return;
  VALSCALE.forEach((c, i) => {
    const s = document.createElement('span');
    s.style.background = c;
    s.dataset.v = i + 1;
    s.title = `Waarde ${i + 1}/9`;
    s.addEventListener('click', () => {
      const st = settings();
      st.refIsolate = st.refIsolate === i + 1 ? -1 : i + 1;
      updateRefRows();
      requestRender();
    });
    el.appendChild(s);
  });
}

function updateRefRows() {
  buildValScale();
  const st = settings();
  const mode = st.refMode;
  $('#row-levels').hidden = mode !== 'values';
  $('#row-threshold').hidden = mode !== 'notan';
  $('#row-blur').hidden = mode === 'color' || mode === 'gray';
  $('#levels-out').textContent = st.refLevels;
  // waarde isoleren: zinvol op kleur/grijs/waarden, niet op notan/temp/chroma
  $('#row-isolate').hidden = mode === 'notan' || mode === 'temp' || mode === 'chroma';
  $$('#valscale span').forEach(s => s.classList.toggle('sel', +s.dataset.v === st.refIsolate));
  $('#btn-isolate-off').style.opacity = st.refIsolate > 0 ? '1' : '0.5';
  $('#row-blockin-detail').hidden = !st.blockinValues && !st.blockinContours;
  updateMapLegend();
}

// legenda voor de temperatuur- en chroma-kaart
function updateMapLegend() {
  const st = settings();
  const leg = $('#map-legend');
  const show = st.showRef && (st.refMode === 'temp' || st.refMode === 'chroma');
  leg.hidden = !show;
  if (!show) return;
  if (st.refMode === 'temp') {
    $('#ml-lo').textContent = 'koel'; $('#ml-hi').textContent = 'warm';
    $('#ml-bar').style.background = 'linear-gradient(90deg, #5aa9ff, #d9d4c8, #ff7a4d)';
  } else {
    $('#ml-lo').textContent = 'neutraal'; $('#ml-hi').textContent = 'verzadigd';
    $('#ml-bar').style.background = 'linear-gradient(90deg, #20242c, #ffd24d)';
  }
}

/* ---------- dynamisch bereik / histogram ---------- */
function computeRange() {
  const ref = luminanceHistogram(refItem().canvas);
  if (!ref) return;
  const sk = activeSketch();
  const skHist = sk ? luminanceHistogram(sk.canvas) : null;

  // histogram tekenen: referentie als grijze staven, schets als rode omtrek
  const cv = $('#histogram');
  cv.hidden = false;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 240, h = 60;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  let max = 0;
  for (const v of ref.hist) if (v > max) max = v;
  if (skHist) for (const v of skHist.hist) if (v > max) max = v;
  const bw = w / ref.bins;
  for (let i = 0; i < ref.bins; i++) {
    const bh = max ? (ref.hist[i] / max) * (h - 4) : 0;
    const g = Math.round(i / (ref.bins - 1) * 255);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 0.5), bh);
  }
  if (skHist) {
    ctx.strokeStyle = '#ff5555';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < skHist.bins; i++) {
      const bh = max ? (skHist.hist[i] / max) * (h - 4) : 0;
      const x = i * bw + bw / 2, y = h - bh;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }

  // donkerste/lichtste plek lokaliseren op referentie (+ schets via transform)
  const marks = [];
  const er = findValueExtremes(refItem().canvas);
  marks.push({ world: er.dark, step: er.dark.step, kind: 'D', src: 'ref' });
  marks.push({ world: er.light, step: er.light.step, kind: 'L', src: 'ref' });
  if (sk) {
    const es = findValueExtremes(sk.canvas);
    marks.push({ world: applySim(sk.transform, es.dark), step: es.dark.step, kind: 'D', src: 'sk' });
    marks.push({ world: applySim(sk.transform, es.light), step: es.light.step, kind: 'L', src: 'sk' });
  }
  V.rangeMarks = marks;

  const info = $('#range-info');
  info.hidden = false;
  let html = `<b>Referentie</b>: waarde ${ref.minStep}–${ref.maxStep} (${ref.range}/9) · ${ref.key}`;
  if (skHist) {
    html += `<br><b style="color:#ff8a8a">Schets</b>: waarde ${skHist.minStep}–${skHist.maxStep} (${skHist.range}/9)`;
    if (skHist.minStep > ref.minStep + 0.5) html += ` — <b>je schets mist de donkerste noten</b>`;
    else if (skHist.maxStep < ref.maxStep - 0.5) html += ` — <b>je schets mist de lichtste noten</b>`;
    else html += ` — bereik komt overeen`;
  }
  html += `<br>D/L-ringen op het beeld tonen de donkerste en lichtste plek. Tik op het histogram om die waarde te isoleren.`;
  info.innerHTML = html;
  requestRender();
}

function isolateFromHistogram(e) {
  const cv = $('#histogram');
  const r = cv.getBoundingClientRect();
  const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
  settings().refIsolate = clamp(1 + Math.round(frac * 8), 1, 9);
  if (settings().refMode === 'notan' || settings().refMode === 'temp' || settings().refMode === 'chroma') {
    settings().refMode = 'gray';
    $('#set-refmode').value = 'gray';
  }
  updateRefRows();
  requestRender();
}

/* ---------- verfdoos ---------- */
function activePaints() {
  return session().paints.filter(p => p.enabled);
}

function renderPaintList() {
  const box = $('#paint-list');
  if (!box) return;
  box.innerHTML = '';
  session().paints.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'paint-row' + (p.enabled ? '' : ' off');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.enabled;
    cb.addEventListener('change', () => { p.enabled = cb.checked; row.classList.toggle('off', !cb.checked); });
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = p.hex;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name;
    row.append(cb, sw, nm);
    if (p.custom) {
      const del = document.createElement('button');
      del.className = 'del';
      del.innerHTML = svgIcon('trash');
      del.title = 'Verwijderen';
      del.addEventListener('click', () => { session().paints.splice(i, 1); renderPaintList(); });
      row.append(del);
    }
    box.appendChild(row);
  });
}

function addPaint() {
  const suggested = V.sample && V.sample.ref ? rgbToHex(V.sample.ref.r, V.sample.ref.g, V.sample.ref.b) : '#888888';
  const name = prompt('Naam van de verf:', 'Eigen verf');
  if (name === null) return;
  const hex = prompt('Kleur (hex, bijv. #a06b40) — leeg = laatste pipet-sample:', suggested);
  if (hex === null) return;
  const clean = /^#?[0-9a-f]{6}$/i.test(hex.trim()) ? (hex.trim().startsWith('#') ? hex.trim() : '#' + hex.trim()) : suggested;
  session().paints.push({
    id: 'eigen-' + Date.now(), name: name.trim() || 'Eigen verf',
    hex: clean, ...hexToRgb(clean), enabled: true, custom: true,
  });
  renderPaintList();
  toast('Verf toegevoegd ✓');
}

function updateVersionSelect() {
  const sel = $('#set-version');
  sel.innerHTML = '';
  session().sketches.forEach((sk, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = sk.label || `Schets ${i + 1}`;
    sel.appendChild(o);
  });
  sel.value = session().active;
}

/* ---------- eenmalige bedrading ---------- */
function wireOverlay() {
  if (V.wired) return;
  V.wired = true;
  V.cv = $('#view-canvas');
  V.ctx = V.cv.getContext('2d');

  V.cv.addEventListener('pointerdown', onPointerDown);
  V.cv.addEventListener('pointermove', onPointerMove);
  V.cv.addEventListener('pointerup', onPointerUp);
  V.cv.addEventListener('pointercancel', onPointerUp);
  V.cv.addEventListener('wheel', onWheel, { passive: false });
  new ResizeObserver(() => requestRender()).observe(V.cv);

  $$('#mode-bar .mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

  $('#btn-flicker').addEventListener('click', () => {
    settings().flicker = !settings().flicker;
    applyFlicker();
  });
  $('#btn-panel').addEventListener('click', () => {
    const p = $('#panel');
    if (p.hidden) openSheet(); else closeSheet();
  });
  wireSheet();

  $$('#move-tools [data-nudge]').forEach(b =>
    b.addEventListener('click', () => nudgeSketch(b.dataset.nudge)));
  $('#btn-align-reset').addEventListener('click', () => {
    const sk = activeSketch();
    sk.transform = fitTransform(sk.canvas, refItem().canvas);
    requestRender();
  });
  $('#btn-align-apply').addEventListener('click', applyAlign);
  $('#btn-align-redo').addEventListener('click', () => setMode('align'));

  const bind = (id, ev, fn) => $(id).addEventListener(ev, fn);
  bind('#set-opacity', 'input', e => {
    settings().opacity = +e.target.value;
    renderOrderList(); // schets-dekking staat ook in de lagenlijst
    requestRender();
  });
  bind('#set-sketchmode', 'change', e => { settings().sketchMode = e.target.value; requestRender(); });
  bind('#set-linecolor', 'change', e => { settings().lineColor = e.target.value; requestRender(); });
  bind('#set-blend', 'change', e => { settings().blend = e.target.value; requestRender(); });
  bind('#set-refmode', 'change', e => { settings().refMode = e.target.value; updateRefRows(); requestRender(); });
  bind('#btn-isolate-off', 'click', () => { settings().refIsolate = -1; updateRefRows(); requestRender(); });
  bind('#set-levels', 'input', e => { settings().refLevels = +e.target.value; updateRefRows(); requestRender(); });
  bind('#set-threshold', 'input', e => { settings().refThreshold = +e.target.value; requestRender(); });
  bind('#set-blur', 'input', e => { settings().refBlur = +e.target.value; requestRender(); });
  $$('#layer-strip .lchip').forEach(c => c.addEventListener('click', () => toggleLayer(c.dataset.layer)));
  bind('#set-blvalues', 'change', e => { settings().blockinValues = e.target.checked; updateRefRows(); requestRender(); });
  bind('#set-blcontours', 'change', e => { settings().blockinContours = e.target.checked; updateRefRows(); requestRender(); });
  bind('#set-blockindetail', 'input', e => { settings().blockinDetail = +e.target.value; requestRender(); });
  bind('#set-con', 'change', e => { con().on = e.target.checked; if (con().on) conInit(); requestRender(); });
  bind('#set-con-color', 'input', e => { con().color = e.target.value; requestRender(); });
  bind('#set-con-op', 'input', e => { con().opacity = +e.target.value; requestRender(); });
  bind('#btn-con-reset', 'click', () => { con().nx = 0; con().ny = 0; requestRender(); });
  bind('#btn-con-place', 'click', () => { con()._init = false; conInit(); con().on = true; $('#set-con').checked = true; requestRender(); });
  bind('#set-drawcolor', 'input', e => { settings().drawColor = e.target.value; });
  bind('#set-drawwidth', 'input', e => { settings().drawWidth = +e.target.value; });
  bind('#btn-eraser', 'click', () => {
    V.draw.erase = !V.draw.erase;
    if (V.draw.erase) V.draw.edit = false;
    updateDrawToggles();
  });
  bind('#btn-edit', 'click', () => {
    V.draw.edit = !V.draw.edit;
    if (V.draw.edit) V.draw.erase = false;
    updateDrawToggles();
  });
  bind('#btn-snap', 'click', () => {
    settings().drawSnap = !settings().drawSnap;
    $('#btn-snap').classList.toggle('on', settings().drawSnap);
    toast(settings().drawSnap ? 'Snappen aan' : 'Snappen uit');
  });
  bind('#btn-draw-undo', 'click', drawUndo);
  bind('#btn-draw-redo', 'click', drawRedo);
  bind('#btn-draw-clear', 'click', () => {
    const l = activeLayer();
    if (l.kind === 'values') {
      if (l.shapes.length && confirm(`Waardenlaag “${l.name}” wissen?`)) { l.shapes = []; selectShape(null); clearRedo(); requestRender(); }
    } else if (l.strokes.length && confirm(`Laag “${l.name}” wissen?`)) {
      l.strokes = []; clearRedo(); requestRender();
    }
  });
  bind('#btn-layer-add', 'click', () => addLayer('lines'));
  bind('#btn-vlayer-add', 'click', () => { addLayer('values'); if (V.mode === 'draw') setDrawTool('shape'); });
  bind('#btn-tool-line', 'click', () => setDrawTool('line'));
  bind('#btn-tool-shape', 'click', () => setDrawTool('shape'));
  bind('#set-valuen', 'input', e => {
    settings().valueN = +e.target.value;
    $('#valuen-out').textContent = e.target.value;
    buildVScale();
    updateShapeCheck();
    requestRender();
  });
  bind('#set-vlayer-op', 'input', e => { activeValueLayer().opacity = +e.target.value; requestRender(); });
  bind('#btn-vlayer-op-reset', 'click', () => { activeValueLayer().opacity = 1; $('#set-vlayer-op').value = 1; requestRender(); });
  bind('#set-vshape-op', 'input', e => { if (V.draw.selShape) { V.draw.selShape.shape.opacity = +e.target.value; requestRender(); } });
  bind('#btn-vshape-op-reset', 'click', () => { if (V.draw.selShape) { V.draw.selShape.shape.opacity = 1; $('#set-vshape-op').value = 1; requestRender(); } });
  bind('#set-valuereveal', 'change', e => { settings().valueReveal = e.target.checked; requestRender(); });
  bind('#btn-vshape-del', 'click', () => {
    if (!V.draw.selShape) return;
    const arr = V.draw.selShape.layer.shapes;
    arr.splice(arr.indexOf(V.draw.selShape.shape), 1);
    selectShape(null);
    requestRender();
  });
  bind('#btn-vshape-pipet', 'click', () => {
    if (!V.draw.selShape) return;
    const lum = shapeLum(V.draw.selShape.shape);
    if (lum == null) { toast('Kon de referentie hier niet meten'); return; }
    V.draw.selShape.shape.v = lum;
    V.draw.lastVal = lum;
    buildVScale();
    updateShapeCheck();
    toast('Waarde overgenomen van de referentie');
    requestRender();
  });
  bind('#btn-drawversion-save', 'click', saveDrawingVersion);
  bind('#set-samplerad', 'input', e => {
    settings().sampleRadius = +e.target.value;
    if (V.sample) { doSample(V.sample.world); updateSampleCard(); }
    requestRender();
  });
  bind('#set-palk', 'input', e => {
    settings().paletteK = +e.target.value;
    $('#palk-out').textContent = e.target.value;
  });
  bind('#btn-palette', 'click', computePalette);
  bind('#set-shownotes', 'change', e => { settings().showNotes = e.target.checked; requestRender(); });
  bind('#btn-pin', 'click', () => {
    if (!V.sample || !V.sample.ref) return;
    session().notes.push({ x: V.sample.world.x, y: V.sample.world.y, ...V.sample.ref });
    settings().showNotes = true;
    $('#set-shownotes').checked = true;
    renderNotesRow();
    toast('Kleurnotitie vastgepind ✓');
    requestRender();
  });
  bind('#btn-note-del', 'click', () => {
    if (V.selNote < 0) return;
    session().notes.splice(V.selNote, 1);
    V.selNote = -1;
    updateSampleCard();
    renderNotesRow();
    requestRender();
  });
  $$('[data-export]').forEach(b => b.addEventListener('click', () => exportColors(b.dataset.export)));
  bind('#set-mixtarget', 'change', e => { settings().mixTarget = e.target.value; });
  bind('#btn-mix', 'click', computeMix);
  bind('#btn-wb-set', 'click', () => {
    if (!V.sample || !V.sample.world) { toast('Sample eerst een neutraal punt'); return; }
    const it = refItem();
    const raw = averageArea(it.canvasRaw, V.sample.world.x, V.sample.world.y, settings().sampleRadius);
    if (!raw) { toast('Kon het punt niet lezen'); return; }
    it.wb = whiteBalanceGains(raw);
    applyItemWB(it);
    V.palette = null; V.rangeMarks = null;
    renderPaletteRow();
    doSample(V.sample.world);
    updateSampleCard();
    toast('Witbalans ingesteld ✓');
    requestRender();
  });
  bind('#btn-wb-reset', 'click', () => {
    const it = refItem();
    it.wb = { r: 1, g: 1, b: 1 };
    applyItemWB(it);
    V.palette = null; V.rangeMarks = null;
    renderPaletteRow();
    if (V.sample) { doSample(V.sample.world); updateSampleCard(); }
    toast('Witbalans teruggezet');
    requestRender();
  });
  bind('#btn-gamut', 'click', renderGamut);
  bind('#btn-range', 'click', computeRange);
  $('#histogram').addEventListener('click', isolateFromHistogram);
  bind('#btn-paint-add', 'click', addPaint);
  bind('#btn-paint-reset', 'click', () => {
    if (confirm('Verfdoos terugzetten naar de standaard twaalf?')) {
      session().paints = defaultPaints();
      renderPaintList();
      toast('Verfdoos hersteld');
    }
  });
  bind('#set-drawversion', 'change', e => {
    if (e.target.value === '') return;
    const v = session().drawingVersions[+e.target.value];
    e.target.value = '';
    if (!v) return;
    session().drawing = normalizeDrawing(JSON.parse(JSON.stringify(v.drawing)));
    settings().showDrawing = true;
    clearRedo();
    selectShape(null);
    refreshLayerStrip();
    renderLayerList();
    buildVScale();
    toast(`“${v.label}” geladen`);
    requestRender();
  });
  bind('#set-flicker', 'change', e => { settings().flicker = e.target.checked; applyFlicker(); });
  bind('#set-flickerms', 'input', e => { settings().flickerMs = +e.target.value; applyFlicker(); });
  bind('#set-grid', 'change', e => { settings().grid = e.target.checked; requestRender(); });
  bind('#set-gridsize', 'input', e => { settings().gridCm = +e.target.value; requestRender(); });

  bind('#btn-guide-h', 'click', () => addGuide('h'));
  bind('#btn-guide-v', 'click', () => addGuide('v'));
  bind('#btn-guides-clear', 'click', () => { session().guides = []; requestRender(); });

  bind('#set-version', 'change', e => {
    session().active = +e.target.value;
    requestRender();
  });
  bind('#btn-new-sketch', 'click', () => {
    closeSheet();
    leaveOverlay();
    App.goSource('sketch');
  });
  bind('#btn-view-reset', 'click', viewFit);

  window.addEventListener('keydown', (e) => {
    if (App.phase !== 'overlay' || V.mode !== 'move') return;
    const step = e.shiftKey ? 10 : 1;
    const T = activeSketch().transform;
    if (e.key === 'ArrowLeft') T.tx -= step / V.view.s;
    else if (e.key === 'ArrowRight') T.tx += step / V.view.s;
    else if (e.key === 'ArrowUp') T.ty -= step / V.view.s;
    else if (e.key === 'ArrowDown') T.ty += step / V.view.s;
    else return;
    e.preventDefault();
    requestRender();
  });
}

function fitTransform(sk, ref) {
  const s = Math.min(ref.width / sk.width, ref.height / sk.height);
  return { a: s, b: 0, tx: (ref.width - sk.width * s) / 2, ty: (ref.height - sk.height * s) / 2 };
}
