'use strict';

/* SightSize — appstatus, wizard (bron → hoekpunten → formaat), sessies */

const App = {
  phase: 'start',
  session: null,
  pending: null, // item in opbouw: { target, type, blob, srcCanvas, corners, dims }
  sourceBack: null,

  setPhase(phase) {
    this.phase = phase;
    const screens = { start: '#scr-start', source: '#scr-source', corners: '#scr-corners', dims: '#scr-dims', overlay: '#scr-overlay' };
    for (const [k, sel] of Object.entries(screens)) $(sel).hidden = k !== phase;
    $('#btn-back').hidden = phase === 'start';
    $('#btn-save').hidden = phase !== 'overlay';
    const titles = {
      start: 'SightSize',
      source: this.pendingTarget === 'ref' ? 'Stap 1 · Referentie' : 'Stap 2 · Schets',
      corners: 'Hoekpunten aanwijzen',
      dims: 'Formaat',
      overlay: (this.session && this.session.name) || 'Overlay',
    };
    $('#hdr-title').textContent = titles[phase];
  },

  pendingTarget: 'ref',

  goSource(target) {
    this.pendingTarget = target;
    this.pending = null;
    const isRef = target === 'ref';
    $('#source-title').textContent = isRef ? 'Stap 1 — De referentie' : 'Stap 2 — Je schets';
    $('#source-sub').textContent = isRef
      ? 'Wat voor afbeelding is je referentie?'
      : 'Hoe leg je je schets vast?';
    $('#lbl-digital').textContent = isRef ? 'Digitale afbeelding' : 'Scan of rechte foto';
    $('#sub-digital').textContent = isRef
      ? 'De verhoudingen kloppen al: een foto uit je bestanden, een scan of een afbeelding van internet.'
      : 'Recht van boven gescand of gefotografeerd; de verhoudingen kloppen al.';
    $('#lbl-photo').textContent = isRef ? 'Zelf genomen foto' : 'Foto van de schets op de ezel';
    $('#sub-photo').textContent = isRef
      ? 'Foto van een afgedrukte referentie of een scherm. Je wijst vier hoekpunten aan; het perspectief wordt gecorrigeerd.'
      : 'Je wijst de vier hoeken van het papier of doek aan; het perspectief wordt gecorrigeerd.';
    const def = isRef ? 'digital' : 'photo';
    $$('input[name="srctype"]').forEach(r => { r.checked = r.value === def; });
    $('#file-input').value = '';
    this.setPhase('source');
  },

  async back() {
    if (this.phase === 'source') {
      if (this.pendingTarget === 'sketch' && this.session.sketches.length) enterOverlay();
      else this.setPhase('start');
    } else if (this.phase === 'corners') {
      this.setPhase('source');
    } else if (this.phase === 'dims') {
      if (this.pending && this.pending.type === 'photo') { this.setPhase('corners'); Editor.draw(); }
      else this.setPhase('source');
    } else if (this.phase === 'overlay') {
      if (confirm('Terug naar het startscherm? Sla de sessie eerst op als je verder wilt werken.')) {
        leaveOverlay();
        this.setPhase('start');
        renderSessionList();
      }
    }
  },
};

function defaultSettings() {
  return {
    opacity: 0.55, sketchMode: 'original', blend: 'normal', lineColor: '#ff3b30',
    refMode: 'color', refLevels: 4, refThreshold: 128, refBlur: 2,
    blockinMode: 'off', blockinDetail: 5,
    flicker: false, flickerMs: 600, grid: false, gridCm: 5,
  };
}

function newSession() {
  App.session = {
    id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()),
    name: '',
    ref: null,
    sketches: [],
    active: 0,
    settings: defaultSettings(),
    guides: [],
  };
  App.goSource('ref');
}

/* ---------- bestand gekozen ---------- */
async function onFileChosen(file) {
  if (!file) return;
  const type = ($('input[name="srctype"]:checked') || {}).value || 'photo';
  showSpinner('Afbeelding laden…');
  await nextTick();
  try {
    const srcCanvas = await loadScaledCanvas(file);
    App.pending = { target: App.pendingTarget, type, blob: file, srcCanvas, corners: null, dims: null };
    if (type === 'photo') enterCorners();
    else enterDims();
  } catch (err) {
    console.error(err);
    toast('Kon de afbeelding niet laden');
  } finally {
    hideSpinner();
  }
}

/* ---------- hoekpunten-editor ---------- */
const Editor = {
  cv: null, ctx: null,
  drag: -1,
  pointer: null,

  init() {
    if (this.cv) return;
    this.cv = $('#corner-canvas');
    this.ctx = this.cv.getContext('2d');
    this.cv.addEventListener('pointerdown', e => this.onDown(e));
    this.cv.addEventListener('pointermove', e => this.onMove(e));
    this.cv.addEventListener('pointerup', e => this.onUp(e));
    this.cv.addEventListener('pointercancel', e => this.onUp(e));
    new ResizeObserver(() => this.draw()).observe(this.cv);
  },

  fit() {
    const r = this.cv.getBoundingClientRect();
    const img = App.pending.srcCanvas;
    const s = Math.min(r.width / img.width, r.height / img.height) * 0.94;
    return { s, ox: (r.width - img.width * s) / 2, oy: (r.height - img.height * s) / 2, r };
  },

  toScreen(c) {
    const f = this.fit();
    const img = App.pending.srcCanvas;
    return { x: c.x * img.width * f.s + f.ox, y: c.y * img.height * f.s + f.oy };
  },

  pos(e) {
    const r = this.cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  },

  onDown(e) {
    this.cv.setPointerCapture(e.pointerId);
    const p = this.pos(e);
    let best = -1, bestD = 34;
    App.pending.corners.forEach((c, i) => {
      const d = dist(p, this.toScreen(c));
      if (d < bestD) { bestD = d; best = i; }
    });
    this.drag = best;
    this.pointer = p;
    if (best >= 0) this.moveCorner(p);
    e.preventDefault();
  },

  onMove(e) {
    if (this.drag < 0) return;
    this.pointer = this.pos(e);
    this.moveCorner(this.pointer);
    e.preventDefault();
  },

  onUp() {
    this.drag = -1;
    this.pointer = null;
    this.draw();
  },

  moveCorner(p) {
    const f = this.fit();
    const img = App.pending.srcCanvas;
    App.pending.corners[this.drag] = {
      x: clamp((p.x - f.ox) / (img.width * f.s), 0, 1),
      y: clamp((p.y - f.oy) / (img.height * f.s), 0, 1),
    };
    this.draw();
  },

  draw() {
    if (App.phase !== 'corners' || !App.pending) return;
    const dpr = window.devicePixelRatio || 1;
    const f = this.fit();
    const w = Math.max(1, Math.round(f.r.width * dpr));
    const h = Math.max(1, Math.round(f.r.height * dpr));
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
    const ctx = this.ctx;
    const img = App.pending.srcCanvas;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0c0d10';
    ctx.fillRect(0, 0, f.r.width, f.r.height);
    ctx.drawImage(img, f.ox, f.oy, img.width * f.s, img.height * f.s);

    const pts = App.pending.corners.map(c => this.toScreen(c));

    // gebied buiten de vierhoek dimmen
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, f.r.width, f.r.height);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 3; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = '#000a';
    ctx.fill('evenodd');
    ctx.restore();

    // vierhoek en handgrepen
    ctx.strokeStyle = '#4da3ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i <= 4; i++) ctx.lineTo(pts[i % 4].x, pts[i % 4].y);
    ctx.stroke();
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      ctx.fillStyle = i === this.drag ? '#4da3ff' : '#4da3ff66';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // loep tijdens het slepen
    if (this.drag >= 0 && this.pointer) {
      const c = App.pending.corners[this.drag];
      const cx = c.x * img.width, cy = c.y * img.height;
      const rad = 46, zoom = 3;
      let lx = this.pointer.x, ly = this.pointer.y - 84;
      if (ly < rad + 6) ly = this.pointer.y + 84;
      lx = clamp(lx, rad + 6, f.r.width - rad - 6);
      const half = rad / (zoom * f.s);
      ctx.save();
      ctx.beginPath();
      ctx.arc(lx, ly, rad, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#0c0d10';
      ctx.fillRect(lx - rad, ly - rad, rad * 2, rad * 2);
      ctx.drawImage(img, cx - half, cy - half, half * 2, half * 2, lx - rad, ly - rad, rad * 2, rad * 2);
      ctx.strokeStyle = '#4da3ff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(lx - rad, ly); ctx.lineTo(lx + rad, ly);
      ctx.moveTo(lx, ly - rad); ctx.lineTo(lx, ly + rad);
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(lx, ly, rad, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  },
};

async function enterCorners() {
  Editor.init();
  showSpinner('Hoeken zoeken…');
  await nextTick();
  App.pending.corners = detectCorners(App.pending.srcCanvas) || defaultCorners();
  hideSpinner();
  App.setPhase('corners');
  Editor.draw();
}

/* ---------- formaat ---------- */
function enterDims() {
  const isRef = App.pending.target === 'ref';
  $('#dims-title').textContent = isRef ? 'Formaat van de referentie' : 'Formaat van je papier of doek';
  $('#dims-sub').textContent = isRef
    ? 'Optioneel: met een bekend formaat kun je straks in centimeters meten. Anders kun je dit overslaan.'
    : 'Optioneel, maar handig: hiermee wordt de schets op de juiste verhouding rechtgetrokken.';
  $('#dims-preset').value = '';
  $('#dims-w').value = '';
  $('#dims-h').value = '';
  $('#dims-w').disabled = true;
  $('#dims-h').disabled = true;
  App.setPhase('dims');
}

function pendingAspect() {
  const p = App.pending;
  return p.type === 'photo' && p.corners
    ? estimateAspect(p.corners, p.srcCanvas)
    : p.srcCanvas.width / p.srcCanvas.height;
}

function onPresetChange() {
  const v = $('#dims-preset').value;
  const wIn = $('#dims-w'), hIn = $('#dims-h');
  if (v === '') {
    wIn.value = hIn.value = '';
    wIn.disabled = hIn.disabled = true;
  } else if (v === 'custom') {
    wIn.disabled = hIn.disabled = false;
    wIn.focus();
  } else {
    wIn.disabled = hIn.disabled = false;
    let [a, b] = v.split('x').map(Number);
    if ((pendingAspect() >= 1) !== (a >= b)) [a, b] = [b, a]; // oriëntatie volgt het beeld
    wIn.value = a;
    hIn.value = b;
  }
}

async function onDimsNext() {
  const wv = parseFloat($('#dims-w').value), hv = parseFloat($('#dims-h').value);
  App.pending.dims = (wv > 0 && hv > 0) ? { w: wv, h: hv } : null;
  await processPending();
}

/* ---------- verwerken en doorgaan ---------- */
function buildOutputCanvas(type, srcCanvas, corners, dims) {
  if (type !== 'photo') return srcCanvas;
  const aspect = dims ? dims.w / dims.h : estimateAspect(corners, srcCanvas);
  const long = 1800;
  const ow = aspect >= 1 ? long : Math.max(2, Math.round(long * aspect));
  const oh = aspect >= 1 ? Math.max(2, Math.round(long / aspect)) : long;
  return warpPerspective(srcCanvas, corners, ow, oh);
}

async function processPending() {
  const p = App.pending;
  showSpinner('Verwerken…');
  await nextTick();
  try {
    const canvas = buildOutputCanvas(p.type, p.srcCanvas, p.corners, p.dims);
    const item = {
      blob: p.blob, type: p.type, corners: p.corners, dims: p.dims,
      canvas, derived: null, lines: null,
    };
    if (p.target === 'ref') {
      App.session.ref = item;
      App.pending = null;
      App.goSource('sketch');
    } else {
      item.transform = fitTransform(canvas, App.session.ref.canvas);
      item.label = `Schets ${App.session.sketches.length + 1} · ${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`;
      App.session.sketches.push(item);
      App.session.active = App.session.sketches.length - 1;
      App.pending = null;
      enterOverlay();
    }
  } finally {
    hideSpinner();
  }
}

/* ---------- sessies opslaan en laden ---------- */
function packItem(it) {
  return {
    blob: it.blob, type: it.type, corners: it.corners, dims: it.dims,
    transform: it.transform || null, label: it.label || null,
  };
}

async function unpackItem(pk) {
  const srcCanvas = await loadScaledCanvas(pk.blob);
  const canvas = buildOutputCanvas(pk.type, srcCanvas, pk.corners, pk.dims);
  return {
    blob: pk.blob, type: pk.type, corners: pk.corners, dims: pk.dims,
    canvas, derived: null, lines: null,
    transform: pk.transform || null, label: pk.label || null,
  };
}

async function saveSession() {
  const s = App.session;
  if (!s || !s.ref || !s.sketches.length) { toast('Nog niets om op te slaan'); return; }
  if (!s.name) {
    const n = prompt('Naam voor deze sessie:', `Sessie ${new Date().toLocaleDateString('nl-NL')}`);
    if (n === null) return;
    s.name = n.trim() || 'Naamloos';
    $('#hdr-title').textContent = s.name;
  }
  const t = document.createElement('canvas');
  const ref = s.ref.canvas;
  t.width = 240;
  t.height = Math.max(1, Math.round(240 * ref.height / ref.width));
  t.getContext('2d').drawImage(ref, 0, 0, t.width, t.height);
  const rec = {
    id: s.id, name: s.name, updated: Date.now(), thumb: t.toDataURL('image/jpeg', 0.7),
    settings: s.settings, guides: s.guides, active: s.active,
    ref: packItem(s.ref), sketches: s.sketches.map(packItem),
  };
  try {
    await Store.put(rec);
    toast('Sessie opgeslagen ✓');
  } catch (err) {
    console.error(err);
    toast('Opslaan mislukt');
  }
}

async function openSession(id) {
  showSpinner('Sessie laden…');
  await nextTick();
  try {
    const rec = await Store.get(id);
    if (!rec) { toast('Sessie niet gevonden'); return; }
    const settings = { ...defaultSettings(), ...rec.settings };
    if (rec.settings && rec.settings.gray && !rec.settings.refMode) settings.refMode = 'gray';
    const s = {
      id: rec.id, name: rec.name,
      settings,
      guides: rec.guides || [],
      active: rec.active || 0,
      ref: await unpackItem(rec.ref),
      sketches: [],
    };
    for (const pk of rec.sketches) {
      const it = await unpackItem(pk);
      if (!it.transform) it.transform = fitTransform(it.canvas, s.ref.canvas);
      s.sketches.push(it);
    }
    s.active = Math.min(s.active, s.sketches.length - 1);
    App.session = s;
    enterOverlay();
  } catch (err) {
    console.error(err);
    toast('Kon de sessie niet laden');
  } finally {
    hideSpinner();
  }
}

async function renderSessionList() {
  const ul = $('#session-list');
  ul.innerHTML = '';
  let list = [];
  try {
    list = await Store.all();
  } catch { /* opslag niet beschikbaar */ }
  list.sort((a, b) => b.updated - a.updated);
  $('#no-sessions').hidden = list.length > 0;
  for (const rec of list) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = rec.thumb || '';
    img.alt = '';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = rec.name;
    const date = document.createElement('div');
    date.className = 'date';
    date.textContent = `${new Date(rec.updated).toLocaleDateString('nl-NL')} · ${rec.sketches.length} schets${rec.sketches.length === 1 ? '' : 'en'}`;
    meta.append(name, date);
    const open = document.createElement('button');
    open.className = 'open';
    open.textContent = 'Open';
    open.addEventListener('click', () => openSession(rec.id));
    const del = document.createElement('button');
    del.textContent = '🗑';
    del.title = 'Verwijderen';
    del.addEventListener('click', async () => {
      if (confirm(`Sessie “${rec.name}” verwijderen?`)) {
        await Store.remove(rec.id);
        renderSessionList();
      }
    });
    li.append(img, meta, open, del);
    ul.appendChild(li);
  }
}

/* ---------- bedrading ---------- */
document.addEventListener('DOMContentLoaded', () => {
  $('#btn-new').addEventListener('click', newSession);
  $('#btn-back').addEventListener('click', () => App.back());
  $('#btn-save').addEventListener('click', saveSession);
  $('#file-input').addEventListener('change', e => onFileChosen(e.target.files[0]));
  $('#btn-detect').addEventListener('click', async () => {
    showSpinner('Hoeken zoeken…');
    await nextTick();
    const c = detectCorners(App.pending.srcCanvas);
    hideSpinner();
    if (c) App.pending.corners = c;
    else toast('Geen vlak gevonden — wijs de hoeken handmatig aan');
    Editor.draw();
  });
  $('#btn-corners-reset').addEventListener('click', () => {
    App.pending.corners = defaultCorners();
    Editor.draw();
  });
  $('#btn-corners-next').addEventListener('click', enterDims);
  $('#dims-preset').addEventListener('change', onPresetChange);
  $('#btn-dims-next').addEventListener('click', onDimsNext);
  renderSessionList();
});
