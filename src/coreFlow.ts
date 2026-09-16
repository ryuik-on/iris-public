const VERTEX = `
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT = `
precision highp float;
varying vec2 uv;
uniform sampler2D artwork;
uniform float time;
uniform float energy;
uniform float gain;
uniform float lightTheme;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
    mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}
vec2 current(vec2 p, float t) {
  vec2 q = p * 7.0 + vec2(-t * 0.15, t * 0.094);
  vec2 r = p - 0.5;
  float depth = sqrt(max(0.0, 1.0 - dot(r, r) / 0.22));
  vec2 wrap = vec2(depth * 0.55, r.x * 0.55);
  return wrap + (vec2(noise(q), noise(q + 17.3)) - 0.5) * 0.65;
}
void main() {
  vec2 p = (vec2(uv.x, 1.0 - uv.y) - 0.5) / 0.71 + 0.5;
  vec3 home = texture2D(artwork, clamp(p, 0.0, 1.0)).rgb;
  float peak = max(home.r, max(home.g, home.b));
  vec3 neighborhood = (
    texture2D(artwork, clamp(p + vec2(0.008, 0.0), 0.0, 1.0)).rgb +
    texture2D(artwork, clamp(p - vec2(0.008, 0.0), 0.0, 1.0)).rgb +
    texture2D(artwork, clamp(p + vec2(0.0, 0.008), 0.0, 1.0)).rgb +
    texture2D(artwork, clamp(p - vec2(0.0, 0.008), 0.0, 1.0)).rgb
  ) * 0.25;
  float white = smoothstep(0.06, 0.36,
    min(neighborhood.r, min(neighborhood.g, neighborhood.b)));
  float peripheral = smoothstep(0.15, 0.34, length(p - 0.5));
  float cyan = smoothstep(0.07, 0.3, min(neighborhood.g, neighborhood.b));
  float movingLayer = max(white, cyan * peripheral * 0.75);
  vec2 q = p;
  for (int i = 0; i < 5; i++) {
    q -= current(q, time - float(i) * 0.4) * (0.02 + peripheral * 0.006);
  }
  vec2 r = p - 0.5;
  float radius = length(r);
  float angle = atan(r.y, r.x);
  float sector = pow(max(0.0, cos(angle * 3.0 + 0.8)), 12.0);
  float outer = smoothstep(0.27, 0.43, radius);
  float plume = sector * outer * (0.35 + 0.65 * noise(vec2(angle * 3.0, time * 0.21)));
  vec2 sampleAt = mix(p, q, movingLayer);
  sampleAt -= r * plume * 0.13;
  vec3 color = texture2D(artwork, clamp(sampleAt, 0.0, 1.0)).rgb;
  float innerLight = exp(-dot(r - vec2(-0.03, -0.04), r - vec2(-0.03, -0.04)) * 36.0);
  color *= 1.0 + innerLight * 0.16;
  color *= 1.0 - plume * 0.3;
  color *= gain * (1.0 + energy * 0.03);
  float edge = smoothstep(0.0, 0.1, min(min(uv.x,uv.y), min(1.0-uv.x,1.0-uv.y)));
  float density = mix(peak, max(color.r, max(color.g, color.b)), outer);
  float alpha = (1.0 - exp(-density * 16.0)) * edge;
  if (lightTheme > 0.5) {
    float brightness = max(color.r, max(color.g, color.b));
    color = clamp(color / max(brightness, 0.001), 0.0, 1.0);
    color = mix(color, vec3(0.90, 0.97, 1.0), smoothstep(0.45, 1.0, brightness) * 0.35);
    alpha = smoothstep(0.015, 0.38, density) * edge;
  }
  gl_FragColor = vec4(color * alpha, alpha);
}`;

export function createCoreFlow(canvas: HTMLCanvasElement, image: HTMLImageElement) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const shaders: WebGLShader[] = [];
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Core shader unavailable');
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Core shader compilation failed');
    return shader;
  };
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  const dispose = () => {
    shaders.forEach(shader => gl.deleteShader(shader));
    gl.deleteTexture(texture);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  };
  try {
    if (!program || !buffer || !texture) throw new Error('Core resources unavailable');
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Core shader link failed');
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.uniform1i(gl.getUniformLocation(program, 'artwork'), 0);
    const timeUniform = gl.getUniformLocation(program, 'time');
    const energyUniform = gl.getUniformLocation(program, 'energy');
    const gainUniform = gl.getUniformLocation(program, 'gain');
    const lightUniform = gl.getUniformLocation(program, 'lightTheme');
    return {
      draw(time: number, energy: number, gain: number, lightTheme = 0) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform1f(timeUniform, time);
        gl.uniform1f(energyUniform, energy);
        gl.uniform1f(gainUniform, gain);
        gl.uniform1f(lightUniform, lightTheme);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },
      dispose,
    };
  } catch {
    dispose();
    return null;
  }
}
