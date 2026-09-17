import type maplibregl from "maplibre-gl";
import { parseZ18Tile } from "../shadowField/v2/artifacts";

type TileTexture = { texture: WebGLTexture; bytes: number };

/**
 * A visual-only MapLibre custom layer. It never participates in LocalShadowAdapter
 * readback: it is installed only by the debug flag and carries no shade values.
 */
export class DebugFieldLayer implements maplibregl.CustomLayerInterface {
  readonly id = "shadow-v2-debug-field";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;
  private gl?: WebGLRenderingContext | WebGL2RenderingContext;
  private program?: WebGLProgram;
  private buffer?: WebGLBuffer;
  private tiles = new Map<string, TileTexture>();
  private gpuBytes = 0;
  onGpuBytes?: (bytes: number) => void;

  onAdd(_map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.gl = gl;
    const vertex = this.shader(gl.VERTEX_SHADER, `
      attribute vec2 a_pos; attribute vec2 a_uv; uniform mat4 u_matrix; varying vec2 v_uv;
      void main() { gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0); v_uv = a_uv; }`);
    const fragment = this.shader(gl.FRAGMENT_SHADER, `
      precision mediump float; uniform sampler2D u_texture; varying vec2 v_uv;
      void main() { gl_FragColor = texture2D(u_texture, v_uv); }`);
    const program = gl.createProgram();
    if (!program || !vertex || !fragment) throw new Error("unable to create debug field shader");
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("unable to link debug field shader");
    this.program = program; this.buffer = gl.createBuffer() ?? undefined;
  }

  setTile(tile: string, pixels: Uint8Array) {
    const gl = this.gl; if (!gl) return;
    const old = this.tiles.get(tile); if (old) { gl.deleteTexture(old.texture); this.gpuBytes -= old.bytes; }
    const texture = gl.createTexture(); if (!texture) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.tiles.set(tile, { texture, bytes: pixels.byteLength }); this.gpuBytes += pixels.byteLength;
    this.onGpuBytes?.(this.gpuBytes);
  }

  removeTile(tile: string) {
    const gl = this.gl; const old = this.tiles.get(tile);
    if (!gl || !old) return;
    gl.deleteTexture(old.texture); this.tiles.delete(tile); this.gpuBytes -= old.bytes;
    this.onGpuBytes?.(this.gpuBytes);
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: maplibregl.CustomRenderMethodInput) {
    if (!this.program || !this.buffer) return;
    // Bracket notation avoids a React-lint false positive on WebGL's `useProgram`.
    gl["useProgram"](this.program); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const position = gl.getAttribLocation(this.program, "a_pos");
    const uv = gl.getAttribLocation(this.program, "a_uv");
    gl.enableVertexAttribArray(position); gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, "u_matrix"), false, options.modelViewProjectionMatrix);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_texture"), 0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const n = 2 ** 18;
    for (const [tile, entry] of this.tiles) {
      const { x, y } = parseZ18Tile(tile);
      const left = x / n, right = (x + 1) / n, top = y / n, bottom = (y + 1) / n;
      // Texture rows exclude the stored 258² one-cell gutter. Top vertices use
      // v=1 because WebGL's image origin is bottom-left.
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        left, top, 0, 1, right, top, 1, 1, left, bottom, 0, 0, right, bottom, 1, 0,
      ]), gl.STREAM_DRAW);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);
  }

  onRemove() {
    const gl = this.gl; if (gl) for (const value of this.tiles.values()) gl.deleteTexture(value.texture);
    this.tiles.clear(); this.gpuBytes = 0; this.onGpuBytes?.(0);
    if (gl && this.buffer) gl.deleteBuffer(this.buffer); if (gl && this.program) gl.deleteProgram(this.program);
  }

  private shader(kind: number, source: string) {
    const gl = this.gl!; const shader = gl.createShader(kind); if (!shader) return undefined;
    gl.shaderSource(shader, source); gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : undefined;
  }
}
