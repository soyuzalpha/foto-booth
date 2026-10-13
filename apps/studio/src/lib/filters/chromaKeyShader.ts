/**
 * Shader WebGL chroma key (keying + spill) — sumber program, dengan fallback 2D.
 *
 * Kanvas 2D cukup untuk foto sesekali, tapi di kiosk pengolahan berjalan pada
 * setiap jepretan; WebGL memindahkan pekerjaan ke GPU dan menjaga UI tetap
 * responsif. Yang dijaga di sini:
 *
 *   · **Shader adalah sumber kebenaran efek** — keying & spill dihitung di
 *     bidang kroma (Cb, Cr), sama seperti `chromaKey.ts`, supaya hasil GPU dan
 *     hasil CPU tidak berbeda warna.
 *   · **Fallback nyata.** Tidak semua kiosk punya WebGL (driver lama, mode
 *     hemat daya). `pickKeyingBackend` memutuskan jalur; kalau tidak ada GPU,
 *     pipeline memakai jalur 2D — bukan gagal.
 */

export const CHROMA_KEY_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`;

export const CHROMA_KEY_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_texCoord;
uniform sampler2D u_image;
uniform vec3 u_keyColor;     // 0..1
uniform float u_similarity;  // 0..1 jarak kroma maksimum yang dianggap latar
uniform float u_smoothness;  // 0..1 lebar tepi (anti-alias)
uniform float u_spill;       // 0..1 kekuatan buang pantulan warna kunci
out vec4 outColor;

// RGB -> bidang kroma. Luminans dibuang supaya bayangan di layar hijau tetap
// terbaca sebagai latar, bukan sebagai subjek.
vec2 chroma(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec2(c.b - y, c.r - y);
}

void main() {
  vec4 src = texture(u_image, v_texCoord);
  float dist = distance(chroma(src.rgb), chroma(u_keyColor));
  float alpha = smoothstep(u_similarity, u_similarity + u_smoothness + 0.0001, dist);

  // Spill: di tepi subjek (alpha antara 0..1) tarik warna ke arah netral.
  float gray = dot(src.rgb, vec3(0.299, 0.587, 0.114));
  float spillAmt = u_spill * (1.0 - alpha) * clamp(1.0 - dist, 0.0, 1.0);
  vec3 rgb = mix(src.rgb, vec3(gray), spillAmt);

  outColor = vec4(rgb, src.a * alpha);
}
`;

export type KeyingBackend = "webgl2" | "webgl" | "2d";

/** Pilih jalur keying dari kemampuan perangkat. WebGL2 dulu (shader `#version 300 es`). */
export function pickKeyingBackend(caps: { webgl2: boolean; webgl: boolean }): KeyingBackend {
  if (caps.webgl2) return "webgl2";
  if (caps.webgl) return "webgl";
  return "2d";
}

export function describeKeyingBackend(backend: KeyingBackend): string {
  switch (backend) {
    case "webgl2":
      return "WebGL 2";
    case "webgl":
      return "WebGL 1";
    default:
      return "Kanvas 2D";
  }
}

/** Subset WebGL yang dipakai untuk menyusun program (bisa dipalsukan di tes). */
export interface GlLike {
  readonly VERTEX_SHADER: number;
  readonly FRAGMENT_SHADER: number;
  readonly COMPILE_STATUS: number;
  readonly LINK_STATUS: number;
  createShader(type: number): unknown;
  shaderSource(shader: unknown, source: string): void;
  compileShader(shader: unknown): void;
  getShaderParameter(shader: unknown, pname: number): boolean;
  getShaderInfoLog(shader: unknown): string;
  createProgram(): unknown;
  attachShader(program: unknown, shader: unknown): void;
  linkProgram(program: unknown): void;
  getProgramParameter(program: unknown, pname: number): boolean;
  getProgramInfoLog(program: unknown): string;
  deleteShader(shader: unknown): void;
}

export interface ChromaKeyProgram {
  program: unknown;
  /** Lokasi uniform; `null` kalau nama tidak ada di program. */
  uniforms: { keyColor: unknown; similarity: unknown; smoothness: unknown; spill: unknown };
}

/**
 * Susun program keying. Mengembalikan `null` (bukan melempar) kalau kompilasi
 * atau linking gagal — pemanggil jatuh ke jalur 2D.
 */
export function compileChromaKeyProgram(gl: GlLike): ChromaKeyProgram | null {
  const compile = (type: number, source: string): unknown => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
    return shader;
  };

  const vs = compile(gl.VERTEX_SHADER, CHROMA_KEY_VERTEX_SHADER);
  if (vs === null) return null;
  const fs = compile(gl.FRAGMENT_SHADER, CHROMA_KEY_FRAGMENT_SHADER);
  if (fs === null) {
    gl.deleteShader(vs);
    return null;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;

  const locate = (name: string): unknown =>
    (gl as unknown as { getUniformLocation(p: unknown, n: string): unknown }).getUniformLocation(program, name);

  return {
    program,
    uniforms: {
      keyColor: locate("u_keyColor"),
      similarity: locate("u_similarity"),
      smoothness: locate("u_smoothness"),
      spill: locate("u_spill"),
    },
  };
}
