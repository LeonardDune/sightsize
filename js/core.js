'use strict';

/* SightSize — kernfuncties: wiskunde, warping, detectie, extractie, opslag */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function fmt(n, dec = 1) {
  return n.toLocaleString('nl-NL', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/* ---------- lineair stelsel (Gauss met partiële pivotering) ---------- */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/* ---------- homografie: beeldt 4 src-punten af op 4 dst-punten ---------- */
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const X = dst[i].x, Y = dst[i].y;
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const h = solveLinear(A, b);
  return h ? [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] : null;
}

function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

/* ---------- similariteit (schaal + rotatie + translatie) ----------
   {a, b, tx, ty}: p' = [a -b; b a]·p + t                                  */
function applySim(T, p) {
  return { x: T.a * p.x - T.b * p.y + T.tx, y: T.b * p.x + T.a * p.y + T.ty };
}

function invertSim(T) {
  const d = T.a * T.a + T.b * T.b;
  const a = T.a / d, b = -T.b / d;
  return { a, b, tx: -(a * T.tx - b * T.ty), ty: -(b * T.tx + a * T.ty) };
}

function composeSim(S, T) { // (S ∘ T)(p) = S(T(p))
  const t = applySim(S, { x: T.tx, y: T.ty });
  return { a: S.a * T.a - S.b * T.b, b: S.b * T.a + S.a * T.b, tx: t.x, ty: t.y };
}

function similarityFrom2(s1, s2, r1, r2) { // beeldt s1→r1 en s2→r2 af
  const dsx = s2.x - s1.x, dsy = s2.y - s1.y;
  const drx = r2.x - r1.x, dry = r2.y - r1.y;
  const d = dsx * dsx + dsy * dsy;
  if (d < 1e-9) return null;
  const a = (dsx * drx + dsy * dry) / d;
  const b = (dsx * dry - dsy * drx) / d;
  return { a, b, tx: r1.x - (a * s1.x - b * s1.y), ty: r1.y - (b * s1.x + a * s1.y) };
}

function simAboutPoint(c, scale, angle) { // schaal/rotatie rond punt c
  const a = scale * Math.cos(angle), b = scale * Math.sin(angle);
  return { a, b, tx: c.x - (a * c.x - b * c.y), ty: c.y - (b * c.x + a * c.y) };
}

/* ---------- afbeelding laden (EXIF-rotatie gerespecteerd, geschaald) ---------- */
async function loadScaledCanvas(blob, maxSide = 2200) {
  let img;
  try {
    img = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    img = await new Promise((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = rej;
      el.src = URL.createObjectURL(blob);
    });
  }
  const iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(iw, ih));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(iw * s));
  cv.height = Math.max(1, Math.round(ih * s));
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  if (img.close) img.close();
  return cv;
}

/* ---------- perspectief-warp ----------
   cornersNorm: [LB..] 4 hoekpunten TL,TR,BR,BL genormaliseerd (0–1) in bronbeeld */
function warpPerspective(srcCv, cornersNorm, outW, outH) {
  const srcPts = cornersNorm.map(c => ({ x: c.x * srcCv.width, y: c.y * srcCv.height }));
  const dstPts = [
    { x: 0, y: 0 }, { x: outW, y: 0 },
    { x: outW, y: outH }, { x: 0, y: outH },
  ];
  const H = homography(dstPts, srcPts); // uitvoerpixel → bronpixel
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  if (!H) {
    out.getContext('2d').drawImage(srcCv, 0, 0, outW, outH);
    return out;
  }
  if (!warpGL(srcCv, H, out)) warpJS(srcCv, H, out);
  return out;
}

function warpGL(src, H, out) {
  let gl = null;
  try {
    const glCv = document.createElement('canvas');
    glCv.width = out.width;
    glCv.height = out.height;
    gl = glCv.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) return false;

    const vsSrc = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
    const fsSrc = `precision highp float;
      uniform sampler2D tex;
      uniform mat3 H;
      uniform vec2 srcSize;
      uniform vec2 outSize;
      void main(){
        vec2 o = vec2(gl_FragCoord.x, outSize.y - gl_FragCoord.y);
        vec3 s = H * vec3(o, 1.0);
        vec2 uv = (s.xy / s.z) / srcSize;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) gl_FragColor = vec4(0.0);
        else gl_FragColor = texture2D(tex, uv);
      }`;
    const mk = (type, srcCode) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, srcCode);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const locP = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(locP);
    gl.vertexAttribPointer(locP, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);

    // mat3 kolom-gewijs
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'H'), false,
      [H[0], H[3], H[6], H[1], H[4], H[7], H[2], H[5], H[8]]);
    gl.uniform2f(gl.getUniformLocation(prog, 'srcSize'), src.width, src.height);
    gl.uniform2f(gl.getUniformLocation(prog, 'outSize'), out.width, out.height);

    gl.viewport(0, 0, out.width, out.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (gl.getError() !== gl.NO_ERROR) return false;

    out.getContext('2d').drawImage(glCv, 0, 0);
    return true;
  } catch {
    return false;
  } finally {
    if (gl) {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
  }
}

function warpJS(src, H, out) {
  const sw = src.width, sh = src.height;
  const ow = out.width, oh = out.height;
  const sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const octx = out.getContext('2d');
  const od = octx.createImageData(ow, oh);
  const d = od.data;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const wz = H[6] * x + H[7] * y + H[8];
      const sx = (H[0] * x + H[1] * y + H[2]) / wz;
      const sy = (H[3] * x + H[4] * y + H[5]) / wz;
      if (sx < 0 || sy < 0 || sx > sw - 1.001 || sy > sh - 1.001) continue;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const o = (y * ow + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
        const bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
        d[o + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  octx.putImageData(od, 0, 0);
  return true;
}

/* ---------- automatische hoekdetectie ----------
   Zoekt het grootste heldere (of donkere) samenhangende vlak — meestal het
   papier of de afdruk — en geeft de vier hoeken genormaliseerd terug.       */
function detectCorners(srcCv) {
  const maxS = 420;
  const s = Math.min(1, maxS / Math.max(srcCv.width, srcCv.height));
  const w = Math.max(2, Math.round(srcCv.width * s));
  const h = Math.max(2, Math.round(srcCv.height * s));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(srcCv, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const gray = new Uint8Array(w * h);
  const hist = new Float64Array(256);
  for (let i = 0; i < w * h; i++) {
    const g = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
    gray[i] = g;
    hist[g]++;
  }

  // Otsu-drempel
  const total = w * h;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }

  const largestQuad = (bright) => {
    const visited = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let bestComp = null;
    for (let start = 0; start < w * h; start++) {
      if (visited[start]) continue;
      const inClass = bright ? gray[start] > thr : gray[start] <= thr;
      visited[start] = 1;
      if (!inClass) continue;
      let top = 0;
      stack[top++] = start;
      let count = 0;
      let minSum = Infinity, maxSum = -Infinity, minDif = Infinity, maxDif = -Infinity;
      let pTL, pBR, pTR, pBL;
      while (top > 0) {
        const idx = stack[--top];
        const x = idx % w, y = (idx / w) | 0;
        count++;
        const sum = x + y, dif = x - y;
        if (sum < minSum) { minSum = sum; pTL = { x, y }; }
        if (sum > maxSum) { maxSum = sum; pBR = { x, y }; }
        if (dif > maxDif) { maxDif = dif; pTR = { x, y }; }
        if (dif < minDif) { minDif = dif; pBL = { x, y }; }
        const nbs = [idx - 1, idx + 1, idx - w, idx + w];
        for (const nb of nbs) {
          if (nb < 0 || nb >= w * h || visited[nb]) continue;
          if (Math.abs((nb % w) - x) > 1) continue; // geen rand-omloop
          const ok = bright ? gray[nb] > thr : gray[nb] <= thr;
          visited[nb] = 1;
          if (ok) stack[top++] = nb;
        }
      }
      if (!bestComp || count > bestComp.count) {
        bestComp = { count, corners: [pTL, pTR, pBR, pBL] };
      }
    }
    if (!bestComp) return null;
    const [tl, tr, br, bl] = bestComp.corners;
    // oppervlakte van de vierhoek (schoenveter)
    const pts = [tl, tr, br, bl];
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const p = pts[i], q = pts[(i + 1) % 4];
      area += p.x * q.y - q.x * p.y;
    }
    area = Math.abs(area) / 2;
    if (area < 0.10 * w * h || bestComp.count < 0.08 * w * h) return null;
    return pts.map(p => ({ x: clamp(p.x / w, 0, 1), y: clamp(p.y / h, 0, 1) }));
  };

  return largestQuad(true) || largestQuad(false);
}

function defaultCorners(inset = 0.08) {
  return [
    { x: inset, y: inset }, { x: 1 - inset, y: inset },
    { x: 1 - inset, y: 1 - inset }, { x: inset, y: 1 - inset },
  ];
}

/* ---------- beeldverhouding schatten uit hoekpunten ---------- */
function estimateAspect(cornersNorm, cv) {
  const p = cornersNorm.map(c => ({ x: c.x * cv.width, y: c.y * cv.height }));
  const wTop = dist(p[0], p[1]), wBot = dist(p[3], p[2]);
  const hL = dist(p[0], p[3]), hR = dist(p[1], p[2]);
  const wAvg = (wTop + wBot) / 2, hAvg = (hL + hR) / 2;
  return hAvg > 1 ? wAvg / hAvg : 1;
}

/* ---------- lijnextractie via adaptieve drempel ---------- */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0xff3b30;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function extractLines(srcCv, color = '#ff3b30') {
  const w = srcCv.width, h = srcCv.height;
  const ctx = srcCv.getContext('2d');
  const data = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  // integraalbeeld voor snel lokaal gemiddelde
  const iw = w + 1;
  const I = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += g[y * w + x];
      I[(y + 1) * iw + (x + 1)] = I[y * iw + (x + 1)] + rowSum;
    }
  }
  const win = Math.max(6, Math.round(Math.min(w, h) / 28));
  const { r, g: gc, b } = hexToRgb(color);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  const od = octx.createImageData(w, h);
  const d = od.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - win), y1 = Math.min(h, y + win + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - win), x1 = Math.min(w, x + win + 1);
      const n = (x1 - x0) * (y1 - y0);
      const mean = (I[y1 * iw + x1] - I[y0 * iw + x1] - I[y1 * iw + x0] + I[y0 * iw + x0]) / n;
      const v = g[y * w + x];
      const t = mean * 0.94;
      if (v >= t) continue;
      const strength = clamp((t - v) / (mean * 0.35 + 1e-3), 0, 1);
      const o = (y * w + x) * 4;
      d[o] = r; d[o + 1] = gc; d[o + 2] = b;
      d[o + 3] = Math.round(255 * Math.pow(strength, 0.8));
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

/* ---------- waardenreductie: grijswaarden, block-in (posterize), notan ----------
   Separabele box-blur met lopende som; twee iteraties benaderen een
   gaussische vervaging. Blur vóór de reductie voorkomt dat elk detail
   zijn eigen vlekje wordt — pas dan zie je de grote vormen.             */
function boxBlurGray(g, w, h, radius, iterations = 2) {
  const r = Math.round(radius);
  if (r < 1) return g;
  const tmp = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let it = 0; it < iterations; it++) {
    // horizontaal g → tmp
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += g[row + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / n;
        sum += g[row + clamp(x + r + 1, 0, w - 1)] - g[row + clamp(x - r, 0, w - 1)];
      }
    }
    // verticaal tmp → g
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        g[y * w + x] = sum / n;
        sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
      }
    }
  }
  return g;
}

// mode: 'gray' | 'values' (posterize naar `levels` niveaus) | 'notan' (drempel)
function reduceValues(srcCv, { mode, levels = 4, threshold = 128, blur = 0 }) {
  const w = srcCv.width, h = srcCv.height;
  const d = srcCv.getContext('2d').getImageData(0, 0, w, h).data;
  let g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  if (blur > 0 && mode !== 'gray') g = boxBlurGray(g, w, h, blur);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  const od = octx.createImageData(w, h);
  const o = od.data;
  for (let i = 0; i < w * h; i++) {
    let v = g[i];
    if (mode === 'values') {
      v = Math.round((v / 255) * (levels - 1)) / (levels - 1) * 255;
    } else if (mode === 'notan') {
      v = v < threshold ? 0 : 255;
    }
    o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v;
    o[i * 4 + 3] = d[i * 4 + 3];
  }
  octx.putImageData(od, 0, 0);
  return out;
}

/* ---------- blockin-lijnen: randen → kettingen → rechte segmenten ---------- */
function downscaledGray(srcCv, maxW = 640) {
  const s = Math.min(1, maxW / srcCv.width);
  const w = Math.max(2, Math.round(srcCv.width * s));
  const h = Math.max(2, Math.round(srcCv.height * s));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(srcCv, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  return { g, w, h, s };
}

// Ramer–Douglas–Peucker: polylijn vereenvoudigen tot rechte segmenten
function rdpSimplify(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], B = pts[b];
    const dx = B.x - A.x, dy = B.y - A.y;
    const len2 = dx * dx + dy * dy || 1;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const t = clamp(((pts[i].x - A.x) * dx + (pts[i].y - A.y) * dy) / len2, 0, 1);
      const ex = A.x + t * dx - pts[i].x, ey = A.y + t * dy - pts[i].y;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx >= 0 && maxD > eps2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// verbindt 8-verbonden randpixels tot polylijnen; start bij eindpunten
function chainEdgePixels(edge, w, h, minLen) {
  const visited = new Uint8Array(w * h);
  const polys = [];
  const nb = [-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1];
  const valid = (i, j) => j >= 0 && j < w * h && Math.abs((j % w) - (i % w)) <= 1;
  const degree = (i) => {
    let n = 0;
    for (const d of nb) { const j = i + d; if (valid(i, j) && edge[j] && !visited[j]) n++; }
    return n;
  };
  const walk = (start) => {
    const pts = [];
    let cur = start;
    while (cur >= 0) {
      visited[cur] = 1;
      pts.push({ x: cur % w, y: (cur / w) | 0 });
      let next = -1, bestDeg = Infinity;
      for (const d of nb) {
        const j = cur + d;
        if (!valid(cur, j) || visited[j] || !edge[j]) continue;
        const dg = degree(j);
        if (dg < bestDeg) { bestDeg = dg; next = j; }
      }
      cur = next;
    }
    return pts;
  };
  // eerst open uiteinden (graad ≤ 1), daarna resterende lussen
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < w * h; i++) {
      if (!edge[i] || visited[i]) continue;
      if (pass === 0 && degree(i) > 1) continue;
      const pts = walk(i);
      if (pts.length >= minLen) polys.push(pts);
    }
  }
  return polys;
}

function finishPolys(polys, s, eps) {
  return polys
    .map(poly => rdpSimplify(poly, eps).map(p => ({ x: p.x / s, y: p.y / s })))
    .filter(poly => poly.length >= 2);
}

// variant 1: rechte lijnen langs de grenzen van de waardevlakken
function blockinValueLines(srcCv, { levels = 4, blur = 2, detail = 5 }) {
  const { g, w, h, s } = downscaledGray(srcCv);
  boxBlurGray(g, w, h, Math.max(2, blur), 2);
  const L = Math.max(2, levels);
  const q = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) q[i] = Math.round((g[i] / 255) * (L - 1));
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      if (q[i] !== q[i + 1] || q[i] !== q[i + w]) edge[i] = 1;
    }
  }
  const eps = Math.max(2, 13 - detail);
  const minLen = Math.max(6, 26 - detail * 2);
  return finishPolys(chainEdgePixels(edge, w, h, minLen), s, eps);
}

// variant 2: rechte lijnen langs de contouren van het beeld zelf
// (Sobel-gradiënt, non-maximum suppression, drempel op percentiel)
function blockinContourLines(srcCv, { detail = 5 }) {
  const { g, w, h, s } = downscaledGray(srcCv);
  boxBlurGray(g, w, h, 2, 2);
  const mag = new Float32Array(w * h);
  const bin = new Uint8Array(w * h);
  let maxMag = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
      const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
      const m = Math.hypot(gx, gy);
      mag[i] = m;
      if (m > maxMag) maxMag = m;
      const deg = ((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180;
      bin[i] = (deg < 22.5 || deg >= 157.5) ? 0 : deg < 67.5 ? 1 : deg < 112.5 ? 2 : 3;
    }
  }
  // drempel op percentiel van de niet-lege gradiënten
  const hist = new Float64Array(256);
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    if (mag[i] > 1) { hist[Math.min(255, (mag[i] / maxMag * 255) | 0)]++; count++; }
  }
  const pct = 0.985 - detail * 0.012;
  let acc = 0, thr = maxMag * 0.2;
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    if (acc >= count * pct) { thr = (b / 255) * maxMag; break; }
  }
  const offs = [1, w + 1, w, w - 1];
  const edge = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const o = offs[bin[i]];
      if (mag[i] > thr && mag[i] >= mag[i - o] && mag[i] >= mag[i + o]) edge[i] = 1;
    }
  }
  const eps = Math.max(2, 12 - detail);
  const minLen = Math.max(8, 30 - detail * 2);
  return finishPolys(chainEdgePixels(edge, w, h, minLen), s, eps);
}

/* ---------- IndexedDB-opslag ---------- */
const Store = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const req = indexedDB.open('sightsize', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('sessions', { keyPath: 'id' });
      req.onsuccess = () => { this._db = req.result; res(this._db); };
      req.onerror = () => rej(req.error);
    });
  },
  async _tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('sessions', mode);
      const out = fn(tx.objectStore('sessions'));
      tx.oncomplete = () => res(out.result !== undefined ? out.result : out);
      tx.onerror = () => rej(tx.error);
    });
  },
  put(rec) { return this._tx('readwrite', s => s.put(rec)); },
  get(id) { return this._tx('readonly', s => s.get(id)); },
  all() { return this._tx('readonly', s => s.getAll()); },
  remove(id) { return this._tx('readwrite', s => s.delete(id)); },
};

/* ---------- UI-helpers ---------- */
function showSpinner(msg) {
  $('#spinner-msg').textContent = msg || '';
  $('#spinner').hidden = false;
}
function hideSpinner() { $('#spinner').hidden = true; }
function nextTick(ms = 30) { return new Promise(r => setTimeout(r, ms)); }

let _toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}
