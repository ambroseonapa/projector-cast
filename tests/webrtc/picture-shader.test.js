// Compiles the native player's picture shader (PictureDrawer.java) the way the WebRTC library assembles
// it, in WebGL (same GLSL ES 1.00 dialect as the projector), and checks what it does to a pixel.
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const java = fs.readFileSync(path.join(__dirname, '../../receiver-android/src/com/projectorcast/receiver/PictureDrawer.java'), 'utf8');
const body = /String SHADER = ([\s\S]*?);\n/.exec(java)[1];
const generic = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');

// Headers as written by GlGenericDrawer.createFragmentShaderString.
const rgb = 'precision mediump float;\nvarying vec2 tc;\nuniform sampler2D tex;\n' + generic.replace(/sample\(/g, 'texture2D(tex, ');
const yuv = 'precision mediump float;\nvarying vec2 tc;\nuniform sampler2D y_tex;\nuniform sampler2D u_tex;\nuniform sampler2D v_tex;\n'
  + 'vec4 sample(vec2 p) {\n  float y = texture2D(y_tex, p).r * 1.16438;\n  float u = texture2D(u_tex, p).r;\n  float v = texture2D(v_tex, p).r;\n'
  + '  return vec4(y + 1.59603 * v - 0.874202, y - 0.391762 * u - 0.812968 * v + 0.531668, y + 2.01723 * u - 1.08563, 1);\n}\n' + generic;

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const result = await page.evaluate(([rgbSrc, yuvSrc]) => {
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    const gl = c.getContext('webgl');
    if (!gl) return { error: 'no WebGL' };
    const vs = 'attribute vec4 in_pos; varying vec2 tc; void main() { tc = in_pos.xy * 0.5 + 0.5; gl_Position = in_pos; }';
    const build = (fs) => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return { error: gl.getShaderInfoLog(s) };
        gl.attachShader(p, s);
      }
      gl.linkProgram(p);
      return gl.getProgramParameter(p, gl.LINK_STATUS) ? { p } : { error: gl.getProgramInfoLog(p) };
    };
    const yuvBuilt = build(yuvSrc);
    const prog = build(rgbSrc);
    if (prog.error || yuvBuilt.error) return { error: prog.error || yuvBuilt.error };
    const p = prog.p;
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'in_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const px = new Uint8Array(4 * 16);
    for (let i = 0; i < 16; i++) px.set([200, 100, 50, 255], i * 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const draw = (b, ct, s, sh) => {
      // Same mapping as PictureDrawer.onPrepareShader.
      gl.uniform1f(gl.getUniformLocation(p, 'brightness'), b / 250);
      gl.uniform1f(gl.getUniformLocation(p, 'contrast'), 1 + ct / 100);
      gl.uniform1f(gl.getUniformLocation(p, 'saturation'), 1 + s / 50);
      gl.uniform1f(gl.getUniformLocation(p, 'sharpness'), sh / 66);
      gl.uniform2f(gl.getUniformLocation(p, 'texel'), 1 / 4, 1 / 4);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const out = new Uint8Array(4);
      gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return [...out.slice(0, 3)];
    };
    return { neutral: draw(0, 0, 0, 0), bright: draw(50, 0, 0, 0), grey: draw(0, 0, -50, 0), contrast: draw(0, 50, 0, 0), sharp: draw(0, 0, 0, 100) };
  }, [rgb, yuv]);
  await browser.close();
  assert(!result.error, 'shader compiles: ' + result.error);
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
  assert(near(result.neutral, [200, 100, 50]), 'all at 0 leaves the picture unchanged: ' + result.neutral);
  assert(result.bright.every((v, i) => v > result.neutral[i] + 40), 'brightness raises every channel: ' + result.bright);
  assert(result.grey[0] === result.grey[1] && result.grey[1] === result.grey[2], 'colour -50 gives grey: ' + result.grey);
  assert(result.contrast[0] > 200 && result.contrast[2] < 50, 'contrast spreads the values: ' + result.contrast);
  assert(near(result.sharp, result.neutral), 'sharpening leaves a flat area alone: ' + result.sharp);
  console.log('PASS picture shader compiles (RGB and YUV input) and adjusts the picture:', JSON.stringify(result));
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
