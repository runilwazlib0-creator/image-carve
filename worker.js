/* Web Worker: runs the carve so the page stays responsive. */
importScripts('carve-core.js');
self.onmessage = function (ev) {
  var m = ev.data;
  try {
    var r = self.VCarve.render(new Uint8ClampedArray(m.rgba), m.width, m.height, m.params, function (stage, p) {
      self.postMessage({ type: 'progress', stage: stage, progress: p });
    });
    var transfer = [r.out.buffer];
    if (r.fine) transfer.push(r.fine.buffer);
    self.postMessage({ type: 'done', out: r.out, fine: r.fine, width: r.width, height: r.height, scale: r.scale, stats: r.stats }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
