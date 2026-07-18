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
  draw: { erase: false, cur: null }, // tekenmodus: gum aan/uit en lijn-in-wording
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
  if (st.refMode === 'color') return it.canvas;
  const key = `${st.refMode}|${st.refLevels}|${st.refThreshold}|${st.refBlur}`;
  if (!it.derived || it.derived.key !== key) {
    it.derived = {
      key,
      canvas: reduceValues(it.canvas, {
        mode: st.refMode, levels: st.refLevels,
        threshold: st.refThreshold, blur: st.refBlur,
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

function renderScene() {
  if (App.phase !== 'overlay' || !refItem() || !activeSketch()) return;
  resizeViewCanvas();
  const ctx = V.ctx;
  const dpr = window.devicePixelRatio || 1;
  const st = settings();
  const ov = visibilityOverride();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0c0d10';
  ctx.fillRect(0, 0, V.cv.width, V.cv.height);
  ctx.translate(V.view.tx, V.view.ty);
  ctx.scale(V.view.s, V.view.s);

  // referentie: foto, of leeg "papier" als de fotolaag uitstaat
  const ref = refItem();
  ctx.globalAlpha = ov === 'sketch' ? 0.25 : 1;
  if (st.showRef) {
    ctx.drawImage(refView(), 0, 0);
  } else {
    ctx.fillStyle = '#ece8dd';
    ctx.fillRect(0, 0, ref.canvas.width, ref.canvas.height);
  }
  ctx.globalAlpha = 1;

  // schets
  const sk = activeSketch();
  let alpha = st.showSketch ? st.opacity : 0;
  if (ov === 'ref') alpha = 0;
  else if (ov === 'sketch') alpha = 1;
  if (V.flickerHidden && !ov) alpha = 0;
  if (alpha > 0) {
    ctx.save();
    ctx.globalAlpha = alpha;
    if (st.blend === 'difference' && !ov) ctx.globalCompositeOperation = 'difference';
    const T = sk.transform;
    ctx.transform(T.a, T.b, -T.b, T.a, T.tx, T.ty);
    ctx.drawImage(st.sketchMode === 'lines' ? sketchLines(sk) : sk.canvas, 0, 0);
    ctx.restore();
  }

  // blockin-lijnen over de referentie
  const bl = blockinLines();
  if (bl && ov !== 'sketch') {
    ctx.save();
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

  // eigen tekening
  if (st.showDrawing && ov !== 'sketch') {
    drawStrokes(ctx, session().drawing.strokes);
    if (V.draw.cur) drawStrokes(ctx, [V.draw.cur]);
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
    html = V.draw.erase
      ? '<b>Gum</b> — tik of sleep over een lijn om die te wissen.'
      : 'Sleep een <b>rechte lijn</b> van punt naar punt; uiteinden klikken vast aan bestaande lijnen. Twee vingers pannen/zoomen.';
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
  $('#btn-align-apply').disabled = true;
  if (mode === 'draw') {
    settings().showDrawing = true;
    $('#set-showdrawing').checked = true;
  }
  updateHint();
  requestRender();
}

/* ---------- tekenen op de referentie (rechte lijnstukken) ---------- */
// klik een uiteinde vast aan een bestaand lijnuiteinde binnen grijpafstand
function snapToEndpoint(w) {
  const tol = 12 / V.view.s;
  let best = null, bestD = tol;
  for (const s of session().drawing.strokes) {
    for (const p of [s.pts[0], s.pts[s.pts.length - 1]]) {
      const d = dist(p, w);
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  return best ? { x: best.x, y: best.y } : w;
}

function eraseAt(w) {
  const strokes = session().drawing.strokes;
  const tol = 10 / V.view.s;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    const hit = s.pts.length === 1
      ? dist(s.pts[0], w) < s.w / 2 + tol
      : s.pts.some((p, j) => j > 0 && distToSeg(w, s.pts[j - 1], p) < s.w / 2 + tol);
    if (hit) {
      strokes.splice(i, 1);
      requestRender();
      return;
    }
  }
}

function saveDrawingVersion() {
  const s = session();
  if (!s.drawing.strokes.length) { toast('Nog geen tekening om op te slaan'); return; }
  const name = prompt('Naam voor deze tekenversie:', `Tekening ${s.drawingVersions.length + 1}`);
  if (name === null) return;
  s.drawingVersions.push({
    label: name.trim() || `Tekening ${s.drawingVersions.length + 1}`,
    created: Date.now(),
    strokes: JSON.parse(JSON.stringify(s.drawing.strokes)),
  });
  updateDrawVersionSelect();
  toast('Tekenversie opgeslagen ✓');
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
    V.gesture = { type: 'single', start: p, last: p, moved: false, guide: null, adjust: null, drawing: false };
    if (V.mode === 'pan') V.gesture.guide = hitGuide(p);
    V.gesture.adjust = hitAdjustPoint(p);
    if (V.gesture.adjust) { V.dragKind = V.gesture.adjust.kind; requestRender(); }
    else if (V.mode === 'draw') {
      V.gesture.drawing = true;
      const w = screenToWorld(p);
      if (V.draw.erase) {
        eraseAt(w);
      } else {
        const start = snapToEndpoint(w);
        V.draw.cur = { color: settings().drawColor, w: settings().drawWidth, pts: [start, start] };
      }
      requestRender();
    }
  } else if (V.pointers.size === 2) {
    // tweede vinger: lijn-in-wording annuleren, gebaar wordt pannen/zoomen
    V.draw.cur = null;
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
    } else if (g.drawing) {
      const w = screenToWorld(p);
      if (V.draw.erase) {
        eraseAt(w);
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
  if (V.draw.cur && V.pointers.size === 0) {
    // alleen een echt lijnstuk bewaren; een tikje zonder sleep vervalt
    if (dist(V.draw.cur.pts[0], V.draw.cur.pts[1]) > 3 / V.view.s) {
      session().drawing.strokes.push(V.draw.cur);
    }
    V.draw.cur = null;
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
    } else if (!g.moved && (V.mode === 'measure' || V.mode === 'align')) {
      handleTap(screenToWorld(p));
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
  $('#set-showref').checked = st.showRef;
  $('#set-showsketch').checked = st.showSketch;
  $('#set-showdrawing').checked = st.showDrawing;
  $('#set-blvalues').checked = st.blockinValues;
  $('#set-blcontours').checked = st.blockinContours;
  $('#set-blockindetail').value = st.blockinDetail;
  $('#set-drawcolor').value = st.drawColor;
  $('#set-drawwidth').value = st.drawWidth;
  $('#set-flicker').checked = st.flicker;
  $('#set-flickerms').value = st.flickerMs;
  $('#set-grid').checked = st.grid;
  $('#set-gridsize').value = st.gridCm;
  updateRefRows();
}

// sliders alleen tonen bij de weergave waar ze bij horen
function updateRefRows() {
  const mode = settings().refMode;
  $('#row-levels').hidden = mode !== 'values';
  $('#row-threshold').hidden = mode !== 'notan';
  $('#row-blur').hidden = mode !== 'values' && mode !== 'notan';
  $('#levels-out').textContent = settings().refLevels;
  $('#row-blockin-detail').hidden = !settings().blockinValues && !settings().blockinContours;
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
    $('#panel').hidden = !$('#panel').hidden;
  });

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
  bind('#set-opacity', 'input', e => { settings().opacity = +e.target.value; requestRender(); });
  bind('#set-sketchmode', 'change', e => { settings().sketchMode = e.target.value; requestRender(); });
  bind('#set-linecolor', 'change', e => { settings().lineColor = e.target.value; requestRender(); });
  bind('#set-blend', 'change', e => { settings().blend = e.target.value; requestRender(); });
  bind('#set-refmode', 'change', e => { settings().refMode = e.target.value; updateRefRows(); requestRender(); });
  bind('#set-levels', 'input', e => { settings().refLevels = +e.target.value; updateRefRows(); requestRender(); });
  bind('#set-threshold', 'input', e => { settings().refThreshold = +e.target.value; requestRender(); });
  bind('#set-blur', 'input', e => { settings().refBlur = +e.target.value; requestRender(); });
  bind('#set-showref', 'change', e => { settings().showRef = e.target.checked; requestRender(); });
  bind('#set-showsketch', 'change', e => { settings().showSketch = e.target.checked; requestRender(); });
  bind('#set-showdrawing', 'change', e => { settings().showDrawing = e.target.checked; requestRender(); });
  bind('#set-blvalues', 'change', e => { settings().blockinValues = e.target.checked; updateRefRows(); requestRender(); });
  bind('#set-blcontours', 'change', e => { settings().blockinContours = e.target.checked; updateRefRows(); requestRender(); });
  bind('#set-blockindetail', 'input', e => { settings().blockinDetail = +e.target.value; requestRender(); });
  bind('#set-drawcolor', 'input', e => { settings().drawColor = e.target.value; });
  bind('#set-drawwidth', 'input', e => { settings().drawWidth = +e.target.value; });
  bind('#btn-eraser', 'click', () => {
    V.draw.erase = !V.draw.erase;
    $('#btn-eraser').classList.toggle('on', V.draw.erase);
    updateHint();
  });
  bind('#btn-draw-undo', 'click', () => { session().drawing.strokes.pop(); requestRender(); });
  bind('#btn-draw-clear', 'click', () => {
    if (session().drawing.strokes.length && confirm('Hele tekening wissen?')) {
      session().drawing.strokes = [];
      requestRender();
    }
  });
  bind('#btn-drawversion-save', 'click', saveDrawingVersion);
  bind('#set-drawversion', 'change', e => {
    if (e.target.value === '') return;
    const v = session().drawingVersions[+e.target.value];
    e.target.value = '';
    if (!v) return;
    session().drawing.strokes = JSON.parse(JSON.stringify(v.strokes));
    settings().showDrawing = true;
    $('#set-showdrawing').checked = true;
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
    $('#panel').hidden = true;
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
