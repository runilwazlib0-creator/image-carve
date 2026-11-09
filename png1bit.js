/* Minimal 1-bit grayscale PNG encoder (pure black/white, tiny files, no canvas size limits). */
(function (root) {
  var table = null;
  function crc32(bytes) {
    if (!table) { table = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    var out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }
  // pixels: Uint8Array, nonzero = white. Optional sampler(x,y)->bool for derived resolutions.
  async function encode(width, height, isWhite) {
    var stride = Math.ceil(width / 8) + 1, raw = new Uint8Array(stride * height);
    for (var y = 0; y < height; y++) {
      var o = y * stride; raw[o] = 0;
      for (var x = 0; x < width; x++) if (isWhite(x, y)) raw[o + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
    var z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    var ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width); dv.setUint32(4, height); ihdr[8] = 1; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    var sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    return new Blob([sig, chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))], { type: 'image/png' });
  }
  root.PNG1 = { encode: encode };
})(typeof self !== "undefined" ? self : this);
