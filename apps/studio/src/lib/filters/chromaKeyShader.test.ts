import test from "node:test";
import assert from "node:assert/strict";

import {
  CHROMA_KEY_FRAGMENT_SHADER,
  CHROMA_KEY_VERTEX_SHADER,
  compileChromaKeyProgram,
  describeKeyingBackend,
  pickKeyingBackend,
  type GlLike,
} from "./chromaKeyShader.ts";

/** GL palsu yang mencatat panggilan & bisa disuruh gagal. */
function fakeGl(options: { failVertex?: boolean; failLink?: boolean } = {}): GlLike & { calls: string[] } {
  const calls: string[] = [];
  let shaderCount = 0;
  return {
    calls,
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    createShader(type: number) {
      shaderCount += 1;
      return { id: shaderCount, type };
    },
    shaderSource() {
      calls.push("shaderSource");
    },
    compileShader() {
      calls.push("compileShader");
    },
    getShaderParameter(shader: unknown) {
      if (options.failVertex === true && (shader as { type: number }).type === 1) return false;
      return true;
    },
    getShaderInfoLog() {
      return "gagal kompilasi";
    },
    createProgram() {
      return { id: "program" };
    },
    attachShader() {
      calls.push("attachShader");
    },
    linkProgram() {
      calls.push("linkProgram");
    },
    getProgramParameter() {
      return options.failLink !== true;
    },
    getProgramInfoLog() {
      return "gagal link";
    },
    deleteShader() {
      calls.push("deleteShader");
    },
    getUniformLocation(_program: unknown, name: string) {
      return { name };
    },
  } as unknown as GlLike & { calls: string[] };
}

test("shader memakai bidang kroma (bukan RGB) & punya uniform keying+spill", () => {
  assert.match(CHROMA_KEY_VERTEX_SHADER, /a_position/);
  assert.match(CHROMA_KEY_FRAGMENT_SHADER, /u_keyColor/);
  assert.match(CHROMA_KEY_FRAGMENT_SHADER, /u_similarity/);
  assert.match(CHROMA_KEY_FRAGMENT_SHADER, /u_smoothness/);
  assert.match(CHROMA_KEY_FRAGMENT_SHADER, /u_spill/);
  // Luminans dibuang dari perbandingan → bayangan di layar hijau tetap latar.
  assert.match(CHROMA_KEY_FRAGMENT_SHADER, /0\.299, 0\.587, 0\.114/);
});

test("pickKeyingBackend memprioritaskan WebGL2, lalu WebGL, lalu 2D", () => {
  assert.equal(pickKeyingBackend({ webgl2: true, webgl: true }), "webgl2");
  assert.equal(pickKeyingBackend({ webgl2: false, webgl: true }), "webgl");
  assert.equal(pickKeyingBackend({ webgl2: false, webgl: false }), "2d");
});

test("describeKeyingBackend memberi label yang bisa dibaca", () => {
  assert.equal(describeKeyingBackend("webgl2"), "WebGL 2");
  assert.equal(describeKeyingBackend("webgl"), "WebGL 1");
  assert.equal(describeKeyingBackend("2d"), "Kanvas 2D");
});

test("compileChromaKeyProgram menyusun program & menemukan uniform", () => {
  const gl = fakeGl();
  const result = compileChromaKeyProgram(gl);
  assert.ok(result !== null);
  assert.deepEqual(
    Object.keys(result.uniforms).sort(),
    ["keyColor", "similarity", "smoothness", "spill"],
  );
  assert.ok(gl.calls.includes("linkProgram"));
});

test("kompilasi vertex gagal → null (pemanggil jatuh ke 2D)", () => {
  assert.equal(compileChromaKeyProgram(fakeGl({ failVertex: true })), null);
});

test("linking gagal → null, shader tetap dihapus", () => {
  const gl = fakeGl({ failLink: true });
  assert.equal(compileChromaKeyProgram(gl), null);
  assert.ok(gl.calls.includes("deleteShader"));
});
