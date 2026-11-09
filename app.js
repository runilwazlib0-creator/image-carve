(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var DEFAULTS = { pitch: 3.8, length: 32, gamma: 0.82, maxw: 1.84, seed: 41, invert: false };
  var sliders = [['pitch', 1, ' px'], ['length', 0, ' px'], ['gamma', 2, ''], ['maxw', 2, '×']];
  var source = null, result = null, worker = null, srcName = 'image';

  sliders.forEach(function (s) {
    var el = $(s[0]), out = $(s[0] + 'V');
    var upd = function () { out.textContent = (+el.value).toFixed(s[1]) + s[2]; };
    el.addEventListener('input', upd); upd();
  });
  $('reset').onclick = function () {
    $('pitch').value = DEFAULTS.pitch; $('length').value = DEFAULTS.length; $('gamma').value = DEFAULTS.gamma;
    $('maxw').value = DEFAULTS.maxw; $('seed').value = DEFAULTS.seed; $('invert').checked = DEFAULTS.invert;
    sliders.forEach(function (s) { $(s[0]).dispatchEvent(new Event('input')); });
  };

  // ----- loading -----
  var drop = $('drop');
  $('file').addEventListener('change', function (e) { if (e.target.files[0]) load(e.target.files[0]); });
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { var f = e.dataTransfer.files[0]; if (f) load(f); });
  drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  $('maxdim').addEventListener('change', function () { if (source) prepare(source.bitmap); });

  async function load(file) {
    srcName = (file.name || 'image').replace(/\.[^.]+$/, '');
    var bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (err) { setStatus('Could not read that image'); return; }
    $('dropText').innerHTML = '<strong>' + escapeHtml(file.name) + '</strong><br>' + bmp.width + ' × ' + bmp.height + ' · tap to change';
    prepare(bmp);
  }
  function prepare(bmp) {
    var max = +$('maxdim').value, w = bmp.width, h = bmp.height, k = 1;
    if (max && Math.max(w, h) > max) k = max / Math.max(w, h);
    var W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
    var c = $('orig'); c.width = W; c.height = H;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, W, H);
    source = { bitmap: bmp, width: W, height: H, origW: w, origH: h };
    result = null; $('downloads').hidden = true; $('stats').textContent = W !== w ? 'Working at ' + W + ' × ' + H + ' (downscaled from ' + w + ' × ' + h + ').' : 'Working at ' + W + ' × ' + H + '.';
    var o = $('out'); o.width = W; o.height = H; o.getContext('2d').clearRect(0, 0, W, H);
    $('stage').classList.add('loaded');
    $('render').disabled = false;
  }

  // ----- rendering -----
  $('render').onclick = function () {
    if (!source) return;
    if (worker) worker.terminate();
    var ctx = $('orig').getContext('2d', { willReadFrequently: true });
    var img = ctx.getImageData(0, 0, source.width, source.height);
    var params = {
      pitch: +$('pitch').value, length: +$('length').value, gamma: +$('gamma').value,
      maxWidthRatio: +$('maxw').value, seed: (+$('seed').value) >>> 0, invert: $('invert').checked, hires: $('hires').checked
    };
    $('render').disabled = true; $('progressWrap').hidden = false; $('downloads').hidden = true;
    setStatus('Starting…', 0);
    var t0 = performance.now();
    worker = new Worker('worker.js');
    worker.onmessage = function (ev) {
      var m = ev.data;
      if (m.type === 'progress') setStatus(m.stage + ' ' + Math.round(m.progress * 100) + '%', m.progress);
      else if (m.type === 'done') {
        result = m; result.params = params; result.elapsed = Math.round(performance.now() - t0);
        show(m); worker.terminate(); worker = null;
        $('render').disabled = false;
        setStatus('Done in ' + (result.elapsed / 1000).toFixed(1) + ' s', 1);
        $('downloads').hidden = false;
        $('dl1').textContent = 'Download PNG (' + m.width + '×' + m.height + ')';
        $('dl2').hidden = $('dl4').hidden = !m.fine;
        if (m.fine) { $('dl2').textContent = '2× (' + m.width * 2 + '×' + m.height * 2 + ')'; $('dl4').textContent = '4× (' + m.width * 4 + '×' + m.height * 4 + ')'; }
        $('stats').textContent = m.stats.cuts + ' cuts · ' + Math.round(m.stats.whiteFraction * 100) + '% carved · strokes ' + m.stats.strokeLength.p10 + '–' + m.stats.strokeLength.max + ' px';
        window.carveResult = result; // handy for debugging / automated tests
      } else if (m.type === 'error') {
        setStatus('Error: ' + m.message, 0); $('render').disabled = false;
      }
    };
    worker.postMessage({ rgba: img.data.buffer, width: source.width, height: source.height, params: params }, [img.data.buffer]);
  };

  function show(m) {
    var c = $('out'); c.width = m.width; c.height = m.height;
    var ctx = c.getContext('2d'), id = ctx.createImageData(m.width, m.height), d = id.data, o = m.out;
    for (var i = 0, j = 0; i < o.length; i++, j += 4) { var v = o[i] ? 255 : 0; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; }
    ctx.putImageData(id, 0, 0);
  }
  function setStatus(t, p) { $('status').textContent = t; if (p != null) $('progress').value = p; }

  // ----- downloads (1-bit PNG, strictly black/white) -----
  async function download(factor) {
    if (!result) return;
    var w = result.width, h = result.height, blob, btn = $('dl' + factor), label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Encoding…';
    try {
      if (factor === 1) blob = await PNG1.encode(w, h, function (x, y) { return result.out[y * w + x] !== 0; });
      else {
        var f = result.fine, FW = w * 4;
        if (factor === 4) blob = await PNG1.encode(FW, h * 4, function (x, y) { return f[y * FW + x] !== 0; });
        else blob = await PNG1.encode(w * 2, h * 2, function (x, y) { // 2x: majority of each 2x2 block of the 4x raster
          var b = (2 * y) * FW + 2 * x; return (+!!f[b] + !!f[b + 1] + !!f[b + FW] + !!f[b + FW + 1]) >= 2; });
      }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = srcName + '-carved' + (factor > 1 ? '-' + factor + 'x' : '') + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
    } finally { btn.disabled = false; btn.textContent = label; }
  }
  $('dl1').onclick = function () { download(1); };
  $('dl2').onclick = function () { download(2); };
  $('dl4').onclick = function () { download(4); };
  window.carveEncode = download;

  // ----- view tabs -----
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.onclick = function () {
      document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('active', b === t); });
      var s = $('stage'); s.classList.remove('side', 'result', 'original'); s.classList.add(t.dataset.view);
    };
  });
  function escapeHtml(s) { return s.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
})();
