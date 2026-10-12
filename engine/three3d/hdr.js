/**
 * AE1 - a Radiance .hdr decoder (DESIGN.md §18.13).
 *
 * Hand-rolled because three.js's RGBELoader is not among our vendored addons
 * and AE1 never reaches for a network. The format is 1987-simple: an ASCII
 * header, a resolution line, then scanlines of RGBE pixels — 8-bit mantissas
 * sharing an 8-bit exponent — either raw or run-length encoded per component
 * plane. Decodes to Float32 RGBA for a THREE.DataTexture.
 *
 * Only the common shape is supported (`-Y h +X w`, the layout every exporter
 * writes). Anything surprising throws — the caller treats a failed sky as no
 * sky, never a broken scene.
 */

/** Decode a .hdr file. @param {ArrayBuffer} buf → {width, height, data(Float32Array RGBA)} */
export function decodeHDR(buf) {
  const bytes = new Uint8Array(buf);
  let pos = 0;

  // -- ASCII header: lines until the blank line ---------------------------- //
  function line() {
    let s = '';
    while (pos < bytes.length) {
      const c = bytes[pos++];
      if (c === 0x0a) return s;
      s += String.fromCharCode(c);
    }
    return s;
  }
  const magic = line();
  if (!magic.startsWith('#?')) throw new Error('not a Radiance file');
  for (;;) {
    const l = line();
    if (l === '') break; // header ends at the blank line
    if (l.startsWith('FORMAT=') && !l.includes('32-bit_rle_rgbe')) {
      throw new Error(`unsupported format: ${l}`);
    }
  }
  const res = line().trim().match(/^-Y (\d+) \+X (\d+)$/);
  if (!res) throw new Error('unsupported resolution layout');
  const height = parseInt(res[1], 10);
  const width = parseInt(res[2], 10);

  // -- scanlines ----------------------------------------------------------- //
  const data = new Float32Array(width * height * 4);
  const row = new Uint8Array(width * 4); // one scanline of RGBE, planar-assembled

  for (let y = 0; y < height; y++) {
    if (pos + 4 > bytes.length) throw new Error('truncated file');

    if (bytes[pos] === 2 && bytes[pos + 1] === 2 && ((bytes[pos + 2] << 8) | bytes[pos + 3]) === width) {
      // New-style RLE: four component planes, each run-length coded.
      pos += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width) {
          let n = bytes[pos++];
          if (n > 128) {
            // run: repeat the next byte (n - 128) times
            const v = bytes[pos++];
            for (n -= 128; n > 0; n--) row[x++ * 4 + c] = v;
          } else {
            // literal: copy n bytes
            for (; n > 0; n--) row[x++ * 4 + c] = bytes[pos++];
          }
        }
        if (x !== width) throw new Error('scanline overrun');
      }
    } else {
      // Flat RGBE (with the old (1,1,1,count) repeat convention).
      let x = 0;
      while (x < width) {
        const r = bytes[pos], g = bytes[pos + 1], b = bytes[pos + 2], e = bytes[pos + 3];
        pos += 4;
        if (r === 1 && g === 1 && b === 1 && x > 0) {
          const prev = (x - 1) * 4;
          for (let n = e; n > 0; n--, x++) {
            row[x * 4] = row[prev];
            row[x * 4 + 1] = row[prev + 1];
            row[x * 4 + 2] = row[prev + 2];
            row[x * 4 + 3] = row[prev + 3];
          }
        } else {
          row[x * 4] = r;
          row[x * 4 + 1] = g;
          row[x * 4 + 2] = b;
          row[x * 4 + 3] = e;
          x++;
        }
      }
    }

    // RGBE -> linear float. Rows arrive top-first (-Y); flip so row 0 is the
    // BOTTOM, which is the orientation three's textures expect (flipY-less).
    const out = (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x++) {
      const e = row[x * 4 + 3];
      const scale = e ? Math.pow(2, e - 136) : 0; // (m/256)·2^(e-128)
      data[out + x * 4] = row[x * 4] * scale;
      data[out + x * 4 + 1] = row[x * 4 + 1] * scale;
      data[out + x * 4 + 2] = row[x * 4 + 2] * scale;
      data[out + x * 4 + 3] = 1;
    }
  }

  return { width, height, data };
}
