/*
 * V-carve engraving core: a browser port of dore_carve_gradual.py.
 * Pure functions, no DOM. Runs inside a Web Worker (or Node for tests).
 *
 * White = carved, black = uncut material. Output is strictly 0/255.
 */
(function (root) {
  'use strict';

  var INF = 1e20;

  // ---------- small helpers ----------
  function reflect(i, n) { // scipy.ndimage 'reflect' (half-sample symmetric)
    if (n === 1) return 0;
    var p = 2 * n;
    i %= p; if (i < 0) i += p;
    return i < n ? i : p - 1 - i;
  }
  function reflect101(i, n) { // OpenCV BORDER_DEFAULT
    if (n === 1) return 0;
    while (i < 0 || i >= n) { if (i < 0) i = -i; if (i >= n) i = 2 * n - 2 - i; }
    return i;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function gaussKernel(sigma) {
    var r = Math.floor(4 * sigma + 0.5), k = new Float32Array(2 * r + 1), s = 0;
    for (var i = -r; i <= r; i++) { var v = Math.exp(-0.5 * i * i / (sigma * sigma)); k[i + r] = v; s += v; }
    for (i = 0; i < k.length; i++) k[i] /= s;
    return { k: k, r: r };
  }

  // Separable Gaussian, scipy.ndimage.gaussian_filter(mode='reflect', truncate=4)
  function gaussian2d(src, w, h, sigma) {
    var g = gaussKernel(sigma), k = g.k, r = g.r, K = k.length;
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    var line = new Float32Array(w + 2 * r), x, y, j, s, o;
    for (y = 0; y < h; y++) {
      o = y * w;
      for (x = -r; x < w + r; x++) line[x + r] = src[o + reflect(x, w)];
      for (x = 0; x < w; x++) { s = 0; for (j = 0; j < K; j++) s += k[j] * line[x + j]; tmp[o + x] = s; }
    }
    // vertical pass, row-major accumulation (cache friendly)
    for (y = 0; y < h; y++) {
      o = y * w;
      for (j = 0; j < K; j++) {
        var kj = k[j], ro = reflect(y + j - r, h) * w;
        for (x = 0; x < w; x++) out[o + x] += kj * tmp[ro + x];
      }
    }
    return out;
  }

  function gaussian1d(arr, sigma) {
    var g = gaussKernel(sigma), n = arr.length, out = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var s = 0;
      for (var j = -g.r; j <= g.r; j++) s += g.k[j + g.r] * arr[reflect(i + j, n)];
      out[i] = s;
    }
    return out;
  }

  // cv2.bilateralFilter(src, d=2*radius+1, sigmaColor, sigmaSpace) for float images
  function bilateral(src, w, h, radius, sigmaColor, sigmaSpace) {
    var ox = [], oy = [], ow = [], dx, dy;
    for (dy = -radius; dy <= radius; dy++) for (dx = -radius; dx <= radius; dx++) {
      var rr = dx * dx + dy * dy;
      if (Math.sqrt(rr) > radius) continue;
      ox.push(dx); oy.push(dy); ow.push(Math.exp(-0.5 * rr / (sigmaSpace * sigmaSpace)));
    }
    var cc = -0.5 / (sigmaColor * sigmaColor), out = new Float32Array(w * h), m = ox.length;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var v0 = src[y * w + x], sum = 0, ws = 0;
      for (var q = 0; q < m; q++) {
        var xx = x + ox[q], yy = y + oy[q];
        if (xx < 0 || xx >= w) xx = reflect101(xx, w);
        if (yy < 0 || yy >= h) yy = reflect101(yy, h);
        var v = src[yy * w + xx], d = v - v0, wt = ow[q] * Math.exp(d * d * cc);
        sum += v * wt; ws += wt;
      }
      out[y * w + x] = sum / ws;
    }
    return out;
  }

  // Binary erosion with a (2r+1)^2 square; pixels outside the image do not erode (cv2 default).
  function erodeBinary(mask, w, h, r) {
    var tmp = new Uint8Array(w * h), out = new Uint8Array(w * h), pre = new Int32Array(Math.max(w, h) + 1), x, y, a, b;
    for (y = 0; y < h; y++) {
      pre[0] = 0;
      for (x = 0; x < w; x++) pre[x + 1] = pre[x] + (mask[y * w + x] ? 0 : 1);
      for (x = 0; x < w; x++) { a = Math.max(0, x - r); b = Math.min(w, x + r + 1); tmp[y * w + x] = (pre[b] - pre[a]) === 0 ? 1 : 0; }
    }
    for (x = 0; x < w; x++) {
      pre[0] = 0;
      for (y = 0; y < h; y++) pre[y + 1] = pre[y] + (tmp[y * w + x] ? 0 : 1);
      for (y = 0; y < h; y++) { a = Math.max(0, y - r); b = Math.min(h, y + r + 1); out[y * w + x] = (pre[b] - pre[a]) === 0 ? 1 : 0; }
    }
    return out;
  }

  // Area-weighted 1D resampling weights (cv2.INTER_AREA for downscaling).
  function areaWeights(n, m) {
    var scale = n / m, list = [];
    for (var d = 0; d < m; d++) {
      var a = d * scale, b = (d + 1) * scale, idx = [], wt = [];
      for (var s = Math.floor(a); s < Math.ceil(b) && s < n; s++) {
        var ov = Math.min(b, s + 1) - Math.max(a, s);
        if (ov > 1e-9) { idx.push(s); wt.push(ov / scale); }
      }
      list.push({ idx: idx, wt: wt });
    }
    return list;
  }
  function resizeArea(src, w, h, tw, th) {
    var wx = areaWeights(w, tw), wy = areaWeights(h, th), tmp = new Float32Array(tw * h), out = new Float32Array(tw * th), x, y, q;
    for (y = 0; y < h; y++) for (x = 0; x < tw; x++) {
      var s = 0, e = wx[x];
      for (q = 0; q < e.idx.length; q++) s += src[y * w + e.idx[q]] * e.wt[q];
      tmp[y * tw + x] = s;
    }
    for (y = 0; y < th; y++) { var f = wy[y]; for (x = 0; x < tw; x++) {
      s = 0; for (q = 0; q < f.idx.length; q++) s += tmp[f.idx[q] * tw + x] * f.wt[q];
      out[y * tw + x] = s; } }
    return out;
  }
  // cv2.INTER_LINEAR (half-pixel centres, replicated border)
  function resizeLinear(src, sw, sh, w, h) {
    var out = new Float32Array(w * h), xi0 = new Int32Array(w), xi1 = new Int32Array(w), xf = new Float32Array(w);
    function axis(n, sn, i0, i1, fr) {
      for (var d = 0; d < n; d++) {
        var f = (d + 0.5) * (sn / n) - 0.5, s = Math.floor(f), t = f - s;
        if (s < 0) { s = 0; t = 0; }
        if (s >= sn - 1) { s = sn - 1; t = 0; }
        i0[d] = s; i1[d] = Math.min(s + 1, sn - 1); fr[d] = t;
      }
    }
    axis(w, sw, xi0, xi1, xf);
    var yi0 = new Int32Array(h), yi1 = new Int32Array(h), yf = new Float32Array(h);
    axis(h, sh, yi0, yi1, yf);
    for (var y = 0; y < h; y++) {
      var r0 = yi0[y] * sw, r1 = yi1[y] * sw, ty = yf[y];
      for (var x = 0; x < w; x++) {
        var tx = xf[x];
        var top = src[r0 + xi0[x]] * (1 - tx) + src[r0 + xi1[x]] * tx;
        var bot = src[r1 + xi0[x]] * (1 - tx) + src[r1 + xi1[x]] * tx;
        out[y * w + x] = top * (1 - ty) + bot * ty;
      }
    }
    return out;
  }

  // Exact Euclidean distance transform (Felzenszwalb & Huttenlocher).
  // Returns distance from every pixel to the nearest source pixel, within a window.
  function edt1d(f, n, d, v, z) {
    var k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (var q = 1; q < n; q++) {
      var s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (q = 0; q < n; q++) { while (z[k + 1] < q) k++; var dq = q - v[k]; d[q] = dq * dq + f[v[k]]; }
  }
  function makeEDT(maxDim) {
    var f = new Float64Array(maxDim), d = new Float64Array(maxDim), v = new Int32Array(maxDim), z = new Float64Array(maxDim + 1);
    // isSource(globalIndex) -> bool; writes min(dist, existing) into target over window
    return function (isSrc, W, ax, ay, bx, by, target, mode) {
      var ww = bx - ax, hh = by - ay, buf = new Float64Array(ww * hh), x, y;
      for (x = 0; x < ww; x++) {
        for (y = 0; y < hh; y++) f[y] = isSrc((ay + y) * W + ax + x) ? 0 : INF;
        edt1d(f, hh, d, v, z);
        for (y = 0; y < hh; y++) buf[y * ww + x] = d[y];
      }
      for (y = 0; y < hh; y++) {
        for (x = 0; x < ww; x++) f[x] = buf[y * ww + x];
        edt1d(f, ww, d, v, z);
        for (x = 0; x < ww; x++) {
          var dist = d[x] >= INF * 0.5 ? INF : Math.sqrt(d[x]), gi = (ay + y) * W + ax + x;
          if (mode === 'set') target[gi] = dist; else if (dist < target[gi]) target[gi] = dist;
        }
      }
    };
  }

  // Seeded RNG (mulberry32) + Box-Muller normal.
  function makeRng(seed) {
    var a = seed >>> 0, spare = null;
    function u() { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
    function normal() {
      if (spare !== null) { var s = spare; spare = null; return s; }
      var u1 = u() || 1e-12, u2 = u(), m = Math.sqrt(-2 * Math.log(u1));
      spare = m * Math.sin(2 * Math.PI * u2); return m * Math.cos(2 * Math.PI * u2);
    }
    return { uniform: u, normal: normal };
  }

  // ---------- main renderer ----------
  function render(rgba, w, h, P, progress) {
    P = P || {}; progress = progress || function () {};
    var pitch = P.pitch != null ? +P.pitch : 3.8;
    var length = P.length != null ? +P.length : 32;
    var gamma = P.gamma != null ? +P.gamma : 0.82;
    var seed = P.seed != null ? +P.seed : 41;
    var extension = P.extension != null ? +P.extension : 1;
    var maxWidthRatio = P.maxWidthRatio != null ? +P.maxWidthRatio : 1.84; // max cut width / pitch
    var invert = !!P.invert, hires = P.hires !== false, SCALE = 4;
    var N = w * h, i, x, y;
    var now = (typeof performance !== 'undefined') ? function () { return performance.now(); } : Date.now;
    var T0 = now();

    progress('Reading tones', 0.01);
    var lum = new Float32Array(N);
    for (i = 0; i < N; i++) {
      var v = (0.25 * rgba[4 * i] + 0.60 * rgba[4 * i + 1] + 0.15 * rgba[4 * i + 2]) / 255;
      lum[i] = invert ? 1 - v : v;
    }
    // Remove print grain without sacrificing facial features.
    var smooth = bilateral(lum, w, h, 2, 0.065, 2.0);
    progress('Tone mapping', 0.05);
    var g2 = gaussian2d(smooth, w, h, 2.0), tone = new Float32Array(N);
    for (i = 0; i < N; i++) {
      var dd = smooth[i] + 0.55 * (smooth[i] - g2[i]);
      tone[i] = Math.pow(clamp((dd - 0.205) / 0.795, 0, 1), gamma);
    }
    g2 = null;

    // Coarse lighting tensor; strong silhouette gradients are clipped first.
    progress('Light direction field', 0.08);
    var light = gaussian2d(smooth, w, h, 7.0);
    var inMask = new Uint8Array(N);
    for (i = 0; i < N; i++) inMask[i] = smooth[i] > 0.29 ? 1 : 0;
    var interior = erodeBinary(inMask, w, h, 12); inMask = null;
    var gxx = new Float32Array(N), gxy = new Float32Array(N), gyy = new Float32Array(N), cap = 0.006;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x;
      var gx = w === 1 ? 0 : x === 0 ? light[i + 1] - light[i] : x === w - 1 ? light[i] - light[i - 1] : 0.5 * (light[i + 1] - light[i - 1]);
      var gy = h === 1 ? 0 : y === 0 ? light[i + w] - light[i] : y === h - 1 ? light[i] - light[i - w] : 0.5 * (light[i + w] - light[i - w]);
      var mag = Math.sqrt(gx * gx + gy * gy), wt = Math.min(1, cap / (mag + 1e-8)) * interior[i];
      gx *= wt; gy *= wt;
      gxx[i] = gx * gx; gxy[i] = gx * gy; gyy[i] = gy * gy;
    }
    light = null; interior = null;
    progress('Light direction field', 0.12);
    var A = gaussian2d(gxx, w, h, 23); gxx = null;
    progress('Light direction field', 0.16);
    var B = gaussian2d(gxy, w, h, 23); gxy = null;
    progress('Light direction field', 0.20);
    var C = gaussian2d(gyy, w, h, 23); gyy = null;
    var fb = -Math.PI / 3, c2f = Math.cos(2 * fb), s2f = Math.sin(2 * fb);
    var fc = new Float32Array(N), fs = new Float32Array(N);
    for (i = 0; i < N; i++) {
      var a = A[i], b = B[i], c = C[i];
      var coh = Math.sqrt((a - c) * (a - c) + 4 * b * b) / (a + c + 1e-10);
      var th = 0.5 * Math.atan2(2 * b, a - c);
      var st = coh * clamp((a + c) / 0.000006, 0, 1) * 0.85;
      var u = st * Math.cos(2 * th) + (1 - st) * c2f, vv = st * Math.sin(2 * th) + (1 - st) * s2f;
      th = 0.5 * Math.atan2(vv, u);
      var del = 0.5 * Math.atan2(Math.sin(2 * (th - fb)), Math.cos(2 * (th - fb)));
      th = fb + clamp(del, -0.65, 0.65);
      fc[i] = Math.cos(2 * th); fs[i] = Math.sin(2 * th);
    }
    A = B = C = null;
    // Coherent local groups: area-average onto a coarse grid, then smooth upsample.
    var group = 27, tw = Math.max(1, Math.round(w / group)), th2 = Math.max(1, Math.round(h / group));
    var fcU = resizeLinear(resizeArea(fc, w, h, tw, th2), tw, th2, w, h);
    var fsU = resizeLinear(resizeArea(fs, w, h, tw, th2), tw, th2, w, h);
    fc = fs = null;
    var angles = new Float32Array(N);
    for (i = 0; i < N; i++) angles[i] = 0.5 * Math.atan2(fsU[i], fcU[i]);
    fcU = fsU = null;

    progress('Shadow protection', 0.24);
    var patchtone = gaussian2d(tone, w, h, 1.15);
    var g21 = gaussian2d(tone, w, h, 2.1);
    var widthtone = gaussian2d(tone, w, h, 1.25);
    var forbidden = new Uint8Array(N);
    for (i = 0; i < N; i++) forbidden[i] = (tone[i] < 0.045 || (g21[i] - tone[i]) > 0.12) ? 1 : 0;
    g21 = null;
    for (x = 0; x < w; x++) { forbidden[x] = 1; forbidden[(h - 1) * w + x] = 1; }
    for (y = 0; y < h; y++) { forbidden[y * w] = 1; forbidden[y * w + w - 1] = 1; }
    var edt = makeEDT(Math.max(w, h) + 2);
    var clearance = new Float32Array(N);
    edt(function (gi) { return forbidden[gi] === 1; }, w, 0, 0, w, h, clearance, 'set');

    // ---------- stroke placement ----------
    var out = new Uint8Array(N), blocked = new Uint8Array(N), cov = new Uint8Array(N);
    var outfine = hires ? new Uint8Array(N * SCALE * SCALE) : null, FW = w * SCALE;
    var rng = makeRng(seed);
    var n = Math.floor(h * w / (pitch * pitch) * 5);
    var xs = new Float32Array(n), ys = new Float32Array(n), targets = new Float32Array(n);
    var mu = Math.log(length * 1.15);
    for (i = 0; i < n; i++) xs[i] = 1 + rng.uniform() * (w - 2);
    for (i = 0; i < n; i++) ys[i] = 1 + rng.uniform() * (h - 2);
    for (i = 0; i < n; i++) targets[i] = clamp(Math.exp(mu + 0.72 * rng.normal()), 11, 155) * extension;
    var order = new Uint32Array(n);
    for (i = 0; i < n; i++) order[i] = i;
    order.sort(function (p, q) { return targets[q] - targets[p] || p - q; });

    var ridge = 1.0, maxradius = pitch * maxWidthRatio / 2, margin = ridge + 0.55;
    var pad = Math.ceil(maxradius + margin + 3);
    var count = 0, rejected = 0, lengths = [];
    // scratch buffers
    var fineBuf = new Uint8Array(1 << 16), visit = new Uint8Array(1 << 16), stack = new Int32Array(1 << 16);
    var touched = new Int32Array(1 << 14), nTouched = 0;
    var spanY = new Int32Array(1 << 14), spanA = new Int32Array(1 << 14), spanB = new Int32Array(1 << 14), nSpans = 0;
    var rowCount = new Int32Array(1 << 12), crossX = new Float64Array(1 << 14), crossW = new Int8Array(1 << 14);
    var isWhite = function (gi) { return out[gi] === 255; };

    function grow(arr, need, Ctor) { if (arr.length >= need) return arr; var nn = arr.length; while (nn < need) nn *= 2; var na = new Ctor(nn); na.set(arr); return na; }

    // flood fill zeros in region of a uint8 buffer from its border; return true if some zero is enclosed
    function hasHole(buf, bw, rx0, ry0, rx1, ry1, isOn) {
      var rw = rx1 - rx0, rh = ry1 - ry0, area = rw * rh, zeros = 0, seen = 0, sp = 0, xx, yy;
      visit = grow(visit, area, Uint8Array); visit.fill(0, 0, area);
      stack = grow(stack, area, Int32Array);
      for (yy = 0; yy < rh; yy++) for (xx = 0; xx < rw; xx++) {
        if (isOn(buf, (ry0 + yy) * bw + rx0 + xx)) continue;
        zeros++;
        if ((xx === 0 || yy === 0 || xx === rw - 1 || yy === rh - 1)) { visit[yy * rw + xx] = 1; stack[sp++] = yy * rw + xx; }
      }
      seen = sp;
      while (sp > 0) {
        var p = stack[--sp], px = p % rw, py = (p - px) / rw;
        for (var k = 0; k < 4; k++) {
          var nx = px + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = py + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
          var q = ny * rw + nx;
          if (visit[q]) continue;
          if (isOn(buf, (ry0 + ny) * bw + rx0 + nx)) continue;
          visit[q] = 1; stack[sp++] = q; seen++;
        }
      }
      return seen < zeros;
    }
    var fineOn = function (b, k) { return b[k] !== 0; };
    var covOn = function (b, k) { return b[k] >= 8; };

    var lastReport = 0;
    for (var oi = 0; oi < n; oi++) {
      if (oi - lastReport >= 25000) { lastReport = oi; progress('Carving', 0.28 + 0.7 * oi / n); }
      var idx = order[oi], sx = xs[idx], sy = ys[idx];
      var x0i = Math.round(sx), y0i = Math.round(sy), gi0 = y0i * w + x0i;
      if (clearance[gi0] < margin + 0.45 || tone[gi0] < 0.065) continue;
      var t0 = tone[gi0], p0 = patchtone[gi0];
      var ang = angles[gi0] + 0.020 * rng.normal();
      var half = targets[idx] * 0.5 * (0.70 + 0.30 * t0);
      var arms = [];
      for (var sgn = -1; sgn <= 1; sgn += 2) {
        var xx = sx, yy = sy, heading = ang, previous = p0, arm = [];
        for (var d = 0; d < half; d += 1.2) {
          var ix = Math.round(xx), iy = Math.round(yy);
          if (!(ix >= 1 && ix < w - 1 && iy >= 1 && iy < h - 1)) break;
          var gi = iy * w + ix, t = tone[gi], pt = patchtone[gi];
          if (t < 0.045 || t < t0 * 0.46) break;
          if (Math.abs(pt - previous) > 0.105 || Math.abs(pt - p0) > 0.24) break;
          var available = clearance[gi] - margin;
          if (available < 0.45) break;
          var local = angles[gi];
          var delta = 0.5 * Math.atan2(Math.sin(2 * (local - ang)), Math.cos(2 * (local - ang)));
          if (Math.abs(delta) > 0.40) break;
          heading += clamp((ang + delta - heading) * 0.16, -0.009, 0.009);
          heading = ang + clamp(heading - ang, -0.30, 0.30);
          // Brightness widens the cut continuously, with a hard ceiling.
          var targetradius = Math.min(maxradius, pitch * (0.07 + 0.84 * Math.pow(widthtone[gi], 1.55)));
          arm.push([xx, yy, heading, Math.min(targetradius, available)]);
          xx += sgn * 1.2 * Math.cos(heading); yy += sgn * 1.2 * Math.sin(heading);
          previous = pt;
        }
        arms.push(arm);
      }
      var pts = arms[0].slice().reverse().concat(arms[1].slice(1));
      var np = pts.length;
      if (np < 9) continue;
      var radii = new Float64Array(np), j;
      for (j = 0; j < np; j++) radii[j] = pts[j][3];
      // Smooth longitudinal widths, then bound width slopes both ways.
      var sm = gaussian1d(radii, 1.5);
      for (j = 0; j < np; j++) radii[j] = Math.min(radii[j], sm[j]);
      for (j = 1; j < np; j++) radii[j] = Math.min(radii[j], radii[j - 1] + 0.16);
      for (j = np - 2; j >= 0; j--) radii[j] = Math.min(radii[j], radii[j + 1] + 0.16);
      for (j = 0; j < np; j++) { var e = Math.min(j, np - 1 - j); radii[j] *= Math.min(1, (e + 0.12) / 3); }
      for (j = 1; j < np; j++) radii[j] = Math.min(radii[j], radii[j - 1] + 0.28);
      for (j = np - 2; j >= 0; j--) radii[j] = Math.min(radii[j], radii[j + 1] + 0.28);
      // Polygon: left side forward, right side backward.
      var M = 2 * np, PX = new Float64Array(M), PY = new Float64Array(M);
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (j = 0; j < np; j++) {
        var hx = Math.cos(pts[j][2]), hy = Math.sin(pts[j][2]), rr2 = radii[j];
        PX[j] = pts[j][0] - hy * rr2; PY[j] = pts[j][1] + hx * rr2;
        PX[M - 1 - j] = pts[j][0] + hy * rr2; PY[M - 1 - j] = pts[j][1] - hx * rr2;
      }
      for (j = 0; j < M; j++) { if (PX[j] < minX) minX = PX[j]; if (PX[j] > maxX) maxX = PX[j]; if (PY[j] < minY) minY = PY[j]; if (PY[j] > maxY) maxY = PY[j]; }
      var bx0 = Math.max(0, Math.floor(minX) - 2), bx1 = Math.min(w, Math.floor(maxX) + 3);
      var by0 = Math.max(0, Math.floor(minY) - 2), by1 = Math.min(h, Math.floor(maxY) + 3);
      var fw = (bx1 - bx0) * SCALE, fh = (by1 - by0) * SCALE;

      // --- rasterize polygon at 4x (nonzero winding, fine pixel centres) ---
      // native pixel i covers [i-0.5, i+0.5); fine coordinate F = (X + 0.5) * 4
      rowCount = grow(rowCount, fh + 1, Int32Array); rowCount.fill(0, 0, fh + 1);
      var e0, yA, yB, r0, r1, FXa, FYa, FXb, FYb, total = 0;
      for (e0 = 0; e0 < M; e0++) {
        FYa = (PY[e0] + 0.5) * SCALE - by0 * SCALE; FYb = (PY[(e0 + 1) % M] + 0.5) * SCALE - by0 * SCALE;
        if (FYa === FYb) continue;
        yA = Math.min(FYa, FYb); yB = Math.max(FYa, FYb);
        r0 = Math.max(0, Math.ceil(yA - 0.5)); r1 = Math.min(fh - 1, Math.ceil(yB - 0.5) - 1);
        for (var rw2 = r0; rw2 <= r1; rw2++) { rowCount[rw2 + 1]++; total++; }
      }
      for (j = 0; j < fh; j++) rowCount[j + 1] += rowCount[j];
      crossX = grow(crossX, total, Float64Array); crossW = grow(crossW, total, Int8Array);
      var fillPos = new Int32Array(fh);
      for (j = 0; j < fh; j++) fillPos[j] = rowCount[j];
      for (e0 = 0; e0 < M; e0++) {
        var e1 = (e0 + 1) % M;
        FXa = (PX[e0] + 0.5) * SCALE - bx0 * SCALE; FYa = (PY[e0] + 0.5) * SCALE - by0 * SCALE;
        FXb = (PX[e1] + 0.5) * SCALE - bx0 * SCALE; FYb = (PY[e1] + 0.5) * SCALE - by0 * SCALE;
        if (FYa === FYb) continue;
        yA = Math.min(FYa, FYb); yB = Math.max(FYa, FYb);
        r0 = Math.max(0, Math.ceil(yA - 0.5)); r1 = Math.min(fh - 1, Math.ceil(yB - 0.5) - 1);
        var dir = FYb > FYa ? 1 : -1, slope = (FXb - FXa) / (FYb - FYa);
        for (var rr3 = r0; rr3 <= r1; rr3++) {
          var k2 = fillPos[rr3]++;
          crossX[k2] = FXa + (rr3 + 0.5 - FYa) * slope; crossW[k2] = dir;
        }
      }
      // spans
      fineBuf = grow(fineBuf, fw * fh, Uint8Array);
      nSpans = 0; nTouched = 0;
      var fminX = Infinity, fmaxX = -1, fminY = Infinity, fmaxY = -1, unsafe = false;
      for (var fy = 0; fy < fh; fy++) {
        var s0 = rowCount[fy], s1 = rowCount[fy + 1];
        if (s1 - s0 < 2) continue;
        for (var a1 = s0 + 1; a1 < s1; a1++) { // insertion sort
          var cx = crossX[a1], cw = crossW[a1], b1 = a1 - 1;
          while (b1 >= s0 && crossX[b1] > cx) { crossX[b1 + 1] = crossX[b1]; crossW[b1 + 1] = crossW[b1]; b1--; }
          crossX[b1 + 1] = cx; crossW[b1 + 1] = cw;
        }
        var wind = 0;
        for (var a2 = s0; a2 < s1 - 1; a2++) {
          wind += crossW[a2];
          if (wind === 0) continue;
          var fa = Math.max(0, Math.ceil(crossX[a2] - 0.5)), fbb = Math.min(fw - 1, Math.ceil(crossX[a2 + 1] - 0.5) - 1);
          if (fbb < fa) continue;
          // merge with previous span on same row if contiguous
          if (nSpans > 0 && spanY[nSpans - 1] === fy && spanB[nSpans - 1] >= fa - 1) {
            if (fbb > spanB[nSpans - 1]) { fa = spanB[nSpans - 1] + 1; spanB[nSpans - 1] = fbb; } else continue;
          } else {
            if (nSpans >= spanY.length) { spanY = grow(spanY, nSpans + 1, Int32Array); spanA = grow(spanA, nSpans + 1, Int32Array); spanB = grow(spanB, nSpans + 1, Int32Array); }
            spanY[nSpans] = fy; spanA[nSpans] = fa; spanB[nSpans] = fbb; nSpans++;
          }
          var cyRow = by0 + (fy >> 2);
          for (var fx = fa; fx <= fbb; fx++) {
            fineBuf[fy * fw + fx] = 1;
            var cg = cyRow * w + bx0 + (fx >> 2);
            if (cov[cg]++ === 0) {
              if (nTouched >= touched.length) touched = grow(touched, nTouched + 1, Int32Array);
              touched[nTouched++] = cg;
              if (forbidden[cg] || blocked[cg]) unsafe = true;
            }
          }
          if (spanA[nSpans - 1] < fminX) fminX = spanA[nSpans - 1];
          if (fbb > fmaxX) fmaxX = fbb;
          if (fy < fminY) fminY = fy; if (fy > fmaxY) fmaxY = fy;
        }
      }
      var ok = nSpans > 0 && !unsafe;
      if (!ok && nSpans > 0) rejected++;
      if (ok) {
        // Native footprint (majority of 16 subpixels) must not enclose a black island.
        var cminX = bx0 + (fminX >> 2), cmaxX = bx0 + (fmaxX >> 2), cminY = by0 + (fminY >> 2), cmaxY = by0 + (fmaxY >> 2);
        if (hasHole(cov, w, Math.max(0, cminX - 1), Math.max(0, cminY - 1), Math.min(w, cmaxX + 2), Math.min(h, cmaxY + 2), covOn)) { ok = false; rejected++; }
      }
      if (ok) {
        if (hasHole(fineBuf, fw, Math.max(0, fminX - 1), Math.max(0, fminY - 1), Math.min(fw, fmaxX + 2), Math.min(fh, fmaxY + 2), fineOn)) { ok = false; rejected++; }
      }
      if (ok) {
        for (j = 0; j < nTouched; j++) {
          var tg = touched[j];
          if (cov[tg] >= 8) out[tg] = 255;
          var tx2 = tg % w, ty2 = (tg - tx2) / w;
          for (var oy2 = -1; oy2 <= 1; oy2++) for (var ox2 = -1; ox2 <= 1; ox2++) {
            var qx = tx2 + ox2, qy = ty2 + oy2;
            if (qx >= 0 && qy >= 0 && qx < w && qy < h) blocked[qy * w + qx] = 1;
          }
        }
        if (outfine) for (j = 0; j < nSpans; j++) {
          var base = (by0 * SCALE + spanY[j]) * FW + bx0 * SCALE;
          outfine.fill(255, base + spanA[j], base + spanB[j] + 1);
        }
        var ax = Math.max(0, bx0 - pad), bx = Math.min(w, bx1 + pad), ay = Math.max(0, by0 - pad), by = Math.min(h, by1 + pad);
        edt(isWhite, w, ax, ay, bx, by, clearance, 'min');
        count++; lengths.push((np - 1) * 1.2);
      }
      // reset scratch
      for (j = 0; j < nTouched; j++) cov[touched[j]] = 0;
      for (j = 0; j < nSpans; j++) fineBuf.fill(0, spanY[j] * fw + spanA[j], spanY[j] * fw + spanB[j] + 1);
    }
    progress('Done', 1);
    lengths.sort(function (p, q) { return p - q; });
    var white = 0; for (i = 0; i < N; i++) if (out[i]) white++;
    function pct(p) { return lengths.length ? Math.round(lengths[Math.min(lengths.length - 1, Math.floor(p * (lengths.length - 1)))] * 10) / 10 : 0; }
    return {
      out: out, fine: outfine, width: w, height: h, scale: SCALE,
      stats: { cuts: count, rejected: rejected, candidates: n, whiteFraction: white / N,
               strokeLength: { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), max: pct(1) }, ms: Math.round(now() - T0) }
    };
  }

  root.VCarve = { render: render };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.VCarve;
})(typeof self !== 'undefined' ? self : this);
