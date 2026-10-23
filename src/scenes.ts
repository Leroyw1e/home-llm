/** The original night scene (cabin, hills, smoke). */
export const HILLS_SVG = `<svg viewBox="0 0 1440 360" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <radialGradient id="hlh-win" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffcf7a" stop-opacity=".55"/><stop offset="1" stop-color="#ffcf7a" stop-opacity="0"/></radialGradient>
  </defs>
  <path d="M0 210 C 180 150 340 175 520 195 S 860 140 1040 165 S 1320 200 1440 170 V360 H0 Z" fill="#2b2452" opacity=".55"/>
  <path d="M0 255 C 160 215 320 225 470 245 S 760 205 930 220 S 1250 260 1440 230 V360 H0 Z" fill="#221c44" opacity=".85"/>
  <g fill="#19142f">
    <path d="M1080 236 l14 -40 l14 40 z M1096 232 l11 -30 l11 30 z M300 248 l13 -38 l13 38 z M318 246 l10 -28 l10 28 z"/>
  </g>
  <path d="M0 300 C 200 265 360 270 560 285 S 900 262 1080 272 S 1330 300 1440 285 V360 H0 Z" fill="#17122c"/>
  <g fill="#100c20">
    <path d="M610 292 l16 -48 l16 48 z M632 290 l12 -36 l12 36 z M760 286 l14 -42 l14 42 z M180 296 l13 -40 l13 40 z M1230 298 l15 -44 l15 44 z M1252 298 l11 -32 l11 32 z"/>
    <path d="M680 286 h52 v-26 l-26 -20 l-26 20 z"/>
    <rect x="714" y="236" width="7" height="14"/>
  </g>
  <circle cx="694" cy="272" r="16" fill="url(#hlh-win)"/>
  <circle cx="718" cy="272" r="16" fill="url(#hlh-win)"/>
  <rect x="689" y="267" width="9" height="9" rx="1" fill="#f4b860"/>
  <rect x="713" y="267" width="9" height="9" rx="1" fill="#f4b860"/>
  <path class="hlh-smoke" d="M718 232 c -6 -10 6 -16 0 -26 c -6 -10 6 -16 0 -26" stroke="#6d6593" stroke-width="2.5" fill="none" stroke-linecap="round" opacity=".55"/>
</svg>`;
// Background scenes. Each scene is drawn as SVG at the view's real size (redrawn on resize),
// from a fixed seed so it looks the same every time. No image files.
export type Rnd = () => number;
export function rng(seed: number): Rnd {
  let s = seed;
  return () => (s = s * 16807 % 2147483647) / 2147483647;
}
const f1 = (v: number): number => +v.toFixed(1);
/** Midpoint-displacement noise: n+1 values roughly in [-1, 1]. */
function fractal(rnd: Rnd, n: number, rough: number): number[] {
  const ys: number[] = new Array<number>(n + 1).fill(0);
  ys[0] = rnd() * 2 - 1;
  ys[n] = rnd() * 2 - 1;
  let step = n, scale = 1;
  while (step > 1) {
    const half = step / 2;
    for (let i = half; i < n; i += step)
      ys[i] = (ys[i - half] + ys[i + half]) / 2 + (rnd() * 2 - 1) * scale;
    scale *= rough;
    step = half;
  }
  return ys;
}
/** [width, height] multipliers for peaks so mountains keep their shape on tall, narrow screens. Set per draw. */
let PEAK_SCALE: [number, number] = [1, 1];
export function setPeakScale(w: number, h: number): void {
  PEAK_SCALE = [Math.max(1, 1.2 * h / w), Math.min(1, 1.5 * w / h)];
}
type Pt = [number, number];
type Peak = [number, number, number];
interface RidgeOpts {
  rough?: number;
  peaks?: Peak[];
  n?: number;
  sharp?: number;
}
/** A natural ridge line across the width: fractal roughness plus broad peaks [x 0-1, height px, width 0-1]. */
function ridge(rnd: Rnd, w: number, base: number, amp: number, opts: RidgeOpts = {}): Pt[] {
  const { rough = 0.55, peaks = [], n = 128, sharp = 2 } = opts;
  return fractal(rnd, n, rough).map((v, i) => {
    const x = i * w / n;
    let y = base + v * amp;
    for (const [px, ph, pw] of peaks)
      y -= ph * PEAK_SCALE[1] * Math.exp(-Math.pow(Math.abs((x / w - px) / (pw * PEAK_SCALE[0])), sharp));
    return [f1(x), f1(y)] as Pt;
  });
}
function ridgeY(pts: Pt[], x: number): number {
  for (let i = 1; i < pts.length; i++)
    if (pts[i][0] >= x) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + (y1 - y0) * ((x - x0) / (x1 - x0 || 1));
    }
  return pts[pts.length - 1][1];
}
/** Smooth curve through points (Catmull-Rom as cubic Béziers), without the leading move. */
function curveThrough(pts: Pt[]): string {
  let d = "";
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ` C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${p2[0]} ${p2[1]}`;
  }
  return d;
}
function smoothShape(pts: Pt[], bottom: number): string {
  return `M${pts[0][0]} ${bottom} L${pts[0][0]} ${pts[0][1]}${curveThrough(pts)} L${pts[pts.length - 1][0]} ${bottom} Z`;
}
function smoothLine(pts: Pt[]): string {
  return `M${pts[0][0]} ${pts[0][1]}${curveThrough(pts)}`;
}
function jaggedShape(pts: Pt[], bottom: number): string {
  return `M${pts[0][0]} ${bottom} ` + pts.map(([x, y]) => `L${x} ${y}`).join(" ") + ` L${pts[pts.length - 1][0]} ${bottom} Z`;
}
type Stop = [number, string, number?];
function stopsOf(stops: Stop[]): string {
  return stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a == null ? "" : ` stop-opacity="${a}"`}/>`).join("");
}
/** Vertical gradient; give y1/y2 to pin it to page coordinates instead of the shape's box. */
function vgrad(id: string, stops: Stop[], y1?: number, y2?: number): string {
  const u = y1 == null ? `x1="0" y1="0" x2="0" y2="1"` : `gradientUnits="userSpaceOnUse" x1="0" y1="${f1(y1)}" x2="0" y2="${f1(y2 ?? 0)}"`;
  return `<linearGradient id="${id}" ${u}>${stopsOf(stops)}</linearGradient>`;
}
function hgrad(id: string, stops: Stop[]): string {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${stopsOf(stops)}</linearGradient>`;
}
function rgrad(id: string, stops: Stop[]): string {
  return `<radialGradient id="${id}">${stopsOf(stops)}</radialGradient>`;
}
function blurFilter(id: string, sd: number): string {
  return `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${sd}"/></filter>`;
}
function svgDoc(w: number, h: number, defs: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none"><defs>${defs}</defs>${body}</svg>`;
}
/** Stars, denser near the top, skipping a circle around the moon/sun. */
function starField(rnd: Rnd, w: number, maxY: number, n: number, avoid?: [number, number, number]): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = Math.pow(rnd(), 1.25) * maxY;
    if (avoid && Math.hypot(x - avoid[0], y - avoid[1]) < avoid[2])
      continue;
    const bright = rnd() > 0.93;
    const r = bright ? 1.3 + rnd() * 0.7 : 0.45 + rnd() * 0.75;
    const op = (0.35 + rnd() * 0.6).toFixed(2);
    const tw = rnd() < 0.4 ? ` class="hlh-tw" style="animation-delay:-${(rnd() * 6).toFixed(1)}s;animation-duration:${(3 + rnd() * 4).toFixed(1)}s"` : "";
    if (bright)
      out += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r * 4)}" fill="#fff" opacity=".06"/>`;
    out += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="#fff" opacity="${op}"${tw}/>`;
  }
  return out;
}
/** Pine tree: stacked tiers with slightly scooped sides. */
function pine(x: number, base: number, h: number): string {
  const w = h * 0.36;
  let d = `M${f1(x - h * 0.025)} ${f1(base + h * 0.02)} h${f1(h * 0.05)} v${f1(-h * 0.1)} h${f1(-h * 0.05)} Z`;
  for (let t = 0; t < 4; t++) {
    const apex = base - h + t * h * 0.19, bottom = apex + h * 0.33 + t * h * 0.04, hw = w * (0.38 + t * 0.2);
    d += ` M${f1(x - hw)} ${f1(bottom)} Q${f1(x - hw * 0.35)} ${f1(bottom - h * 0.05)} ${f1(x)} ${f1(apex)} Q${f1(x + hw * 0.35)} ${f1(bottom - h * 0.05)} ${f1(x + hw)} ${f1(bottom)} Z`;
  }
  return d;
}
/** Round leafy tree: trunk plus a dark crown with a lighter highlight. */
function leafTree(x: number, base: number, s: number, dark: string, light: string): string {
  const cy = base - s * 1.25;
  return `<rect x="${f1(x - s * 0.08)}" y="${f1(base - s * 0.9)}" width="${f1(s * 0.16)}" height="${f1(s * 0.9)}" fill="#5b4330"/>` + `<circle cx="${f1(x - s * 0.35)}" cy="${f1(cy + s * 0.15)}" r="${f1(s * 0.6)}" fill="${dark}"/><circle cx="${f1(x + s * 0.35)}" cy="${f1(cy + s * 0.12)}" r="${f1(s * 0.62)}" fill="${dark}"/><circle cx="${f1(x)}" cy="${f1(cy - s * 0.25)}" r="${f1(s * 0.72)}" fill="${dark}"/>` + `<circle cx="${f1(x - s * 0.18)}" cy="${f1(cy - s * 0.38)}" r="${f1(s * 0.42)}" fill="${light}" opacity=".9"/>`;
}
/** Sparkling path of light on water under a moon or sun. */
function glitter(rnd: Rnd, cx: number, top: number, bottom: number, R: number, color: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    const t = i / n, y = top + 3 + Math.pow(t, 1.3) * (bottom - top - 8);
    const spread = R * 0.5 + t * R * 2.8, len = 5 + t * R * 1.1 * rnd() + rnd() * 10;
    const x = cx + (rnd() * 2 - 1) * spread - len / 2;
    out += `<rect class="hlh-glint" style="animation-delay:-${(rnd() * 4).toFixed(1)}s" x="${f1(x)}" y="${f1(y)}" width="${f1(len)}" height="${f1(1.2 + t * 1.4)}" rx="1" fill="${color}" opacity="${(0.9 - t * 0.55).toFixed(2)}"/>`;
  }
  return out;
}
export interface SceneContext {
  w: number;
  h: number;
  rnd: Rnd;
  /** Unique prefix for SVG ids. */
  p: string;
  dashboard: boolean;
}
export interface Scene {
  tone: "dark" | "light";
  /** The cabin scene is a fixed drawing rather than a generated one. */
  legacy?: boolean;
  /** Effect layers drawn between the sky and the landscape. */
  fx?: string[];
  /** Effect layers drawn in front of the landscape. */
  front?: string[];
  build?: (ctx: SceneContext) => { sky: string; land: string };
}
export const SCENES: Record<string, Scene> = {
  night: { tone: "dark", legacy: true },
  lake: {
    tone: "dark",
    build({ w, h, rnd, p, dashboard }: SceneContext) {
      const H = f1(h * 0.64), R = w < 600 ? 26 : Math.max(32, Math.min(86, Math.min(w, h) * 0.07));
      const narrow = w < 600;
      const mx = narrow ? w * 0.86 : dashboard ? w * 0.84 : w * 0.5, my = narrow ? R * 1.3 : Math.max(R * 2.1, h * 0.15);
      const far = ridge(rnd, w, H - h * 0.03, h * 0.022, { rough: 0.58, sharp: 1.35, peaks: [[0.15, h * 0.24, 0.1], [0.24, h * 0.1, 0.05], [0.85, h * 0.27, 0.09], [0.95, h * 0.12, 0.05], [0.56, h * 0.05, 0.1]] });
      const mid = ridge(rnd, w, H - h * 0.012, h * 0.028, { rough: 0.62, peaks: [[0.38, h * 0.07, 0.06], [0.67, h * 0.09, 0.05], [0.04, h * 0.05, 0.04]] });
      const near = ridge(rnd, w, H + 1, h * 0.014, { rough: 0.66, peaks: [[0.12, h * 0.045, 0.05], [0.58, h * 0.028, 0.04], [0.9, h * 0.05, 0.05]] });
      const moonC = "#fbe7c0", m = +(mx / w).toFixed(3);
      const defs = vgrad(`${p}sky`, [[0, "#13171e"], [0.45, "#1b2330"], [0.8, "#22354b"], [1, "#2e4962"]], 0, H) + rgrad(`${p}halo`, [[0, moonC, 0.34], [0.3, moonC, 0.1], [1, moonC, 0]]) + rgrad(`${p}moon`, [[0, "#fffbf2"], [0.75, "#fdeccb"], [1, "#f4d9a6"]]) + vgrad(`${p}far`, [[0, "#58656f"], [1, "#2d3842"]]) + vgrad(`${p}mid`, [[0, "#2c353e"], [1, "#1a2128"]]) + vgrad(`${p}near`, [[0, "#151b22"], [1, "#0a0e13"]]) + vgrad(`${p}mist`, [[0, "#9fb3c8", 0], [0.6, "#9fb3c8", 0.11], [1, "#9fb3c8", 0]]) + vgrad(`${p}water`, [[0, "#14293a"], [0.35, "#0c1a27"], [1, "#03080e"]], H, h) + hgrad(`${p}hz`, [[0, moonC, 0], [Math.max(0, m - 0.3), moonC, 0.15], [m, "#fff4d6", 0.95], [Math.min(1, +m + 0.3), moonC, 0.15], [1, moonC, 0]]) + blurFilter(`${p}soft`, 9) + blurFilter(`${p}ref`, 1.6) + `<clipPath id="${p}below"><rect y="${H}" width="${w}" height="${h - H}"/></clipPath>`;
      let wisps = "";
      for (let i = 0; i < 4; i++)
        wisps += `<ellipse class="hlh-drift" style="animation-duration:${50 + i * 17}s;animation-delay:-${i * 13}s" cx="${f1(mx + (rnd() - 0.5) * w * 0.3)}" cy="${f1(my + (i - 1.3) * R * 0.55)}" rx="${f1(w * (0.22 + rnd() * 0.15))}" ry="${f1(6 + rnd() * 10)}" fill="#c9d3e6" opacity="${(0.06 + rnd() * 0.05).toFixed(2)}" filter="url(#${p}soft)"/>`;
      const sky = svgDoc(w, h, defs, `<rect width="${w}" height="${h}" fill="url(#${p}sky)"/>` + starField(rnd, w, H * 0.9, Math.round(w * h / 9e3), [mx, my, R * 3]) + `<circle cx="${f1(mx)}" cy="${f1(my)}" r="${f1(R * 5.5)}" fill="url(#${p}halo)"/><circle cx="${f1(mx)}" cy="${f1(my)}" r="${f1(R)}" fill="url(#${p}moon)"/>` + `<g fill="#d9c398" opacity=".28"><circle cx="${f1(mx - R * 0.32)}" cy="${f1(my - R * 0.18)}" r="${f1(R * 0.2)}"/><circle cx="${f1(mx + R * 0.28)}" cy="${f1(my + R * 0.3)}" r="${f1(R * 0.14)}"/><circle cx="${f1(mx + R * 0.38)}" cy="${f1(my - R * 0.36)}" r="${f1(R * 0.09)}"/><circle cx="${f1(mx - R * 0.1)}" cy="${f1(my + R * 0.45)}" r="${f1(R * 0.07)}"/></g>` + wisps);
      let ripples = "";
      for (let i = 0; i < 26; i++) {
        const y = H + 4 + Math.pow(rnd(), 1.5) * (h - H - 4);
        ripples += `<rect x="${f1(rnd() * w)}" y="${f1(y)}" width="${f1(30 + rnd() * 140 * (0.4 + (y - H) / (h - H)))}" height="1" fill="#fff" opacity="${(0.025 + rnd() * 0.035).toFixed(3)}"/>`;
      }
      const mountains = `<path d="${smoothShape(far, H + 2)}" fill="url(#${p}far)"/><rect y="${f1(H - h * 0.1)}" width="${w}" height="${f1(h * 0.09)}" fill="url(#${p}mist)"/><path d="${jaggedShape(mid, H + 2)}" fill="url(#${p}mid)"/><path d="${jaggedShape(near, H + 2)}" fill="url(#${p}near)"/>`;
      const land = svgDoc(w, h, defs, mountains + `<rect y="${H}" width="${w}" height="${f1(h - H)}" fill="url(#${p}water)"/>` + `<g clip-path="url(#${p}below)"><g transform="translate(0 ${f1(2 * H)}) scale(1 -1)" opacity=".2" filter="url(#${p}ref)">${mountains}</g></g>` + `<ellipse cx="${f1(mx)}" cy="${f1(H + (h - H) * 0.4)}" rx="${f1(R * 1.7)}" ry="${f1((h - H) * 0.5)}" fill="url(#${p}halo)" opacity=".55"/>` + ripples + `<rect y="${f1(H - 0.8)}" width="${w}" height="1.6" fill="url(#${p}hz)"/>` + glitter(rnd, mx, H, h, R, "#f3e6c4", 48));
      return { sky, land };
    }
  },
  aurora: {
    tone: "dark",
    build({ w, h, rnd, p }: SceneContext) {
      const H = f1(h * 0.66);
      const far = ridge(rnd, w, H - h * 0.035, h * 0.02, { rough: 0.6, sharp: 1.3, peaks: [[0.18, h * 0.22, 0.075], [0.31, h * 0.14, 0.06], [0.7, h * 0.25, 0.08], [0.86, h * 0.15, 0.055], [0.5, h * 0.06, 0.08]] });
      const snow = ridge(rnd, w, H - h * 0.13, h * 0.035, { rough: 0.72, peaks: [[0.18, h * 0.06, 0.06], [0.7, h * 0.07, 0.06]] });
      const hill = ridge(rnd, w, H + h * 0.01, h * 0.012, { rough: 0.5, peaks: [[0.5, h * 0.02, 0.3]] });
      const ground = ridge(rnd, w, H + h * 0.1, h * 0.012, { rough: 0.45, peaks: [[0.2, h * 0.02, 0.2], [0.8, h * 0.025, 0.2]] });
      const front = ridge(rnd, w, h * 0.965, h * 0.012, { rough: 0.45 });
      const defs = vgrad(`${p}sky`, [[0, "#02060b"], [0.5, "#061520"], [0.85, "#0a2730"], [1, "#11383b"]], 0, H) + rgrad(`${p}glow`, [[0, "#3df0b0", 0.22], [1, "#3df0b0", 0]]) + vgrad(`${p}far`, [[0, "#3a5761"], [1, "#183039"]]) + vgrad(`${p}snow`, [[0, "#d9eaf0"], [1, "#86a8b4"]]) + vgrad(`${p}mist`, [[0, "#6fd6c0", 0], [0.6, "#6fd6c0", 0.08], [1, "#6fd6c0", 0]]) + vgrad(`${p}ground`, [[0, "#a7cbc6"], [0.3, "#8fa9b8"], [1, "#56707f"]]) + vgrad(`${p}front`, [[0, "#b9cdd8"], [1, "#71889a"]]) + `<clipPath id="${p}mtn"><path d="${jaggedShape(far, H + 2)}"/></clipPath>`;
      const curtains: [number, number, string, number][] = [[h * 0.33, h * 0.24, "a1", 1], [h * 0.2, h * 0.13, "a2", 0.6]];
      let aurora = "";
      curtains.forEach(([baseY, len, grad, strength], ci) => {
        const wave = fractal(rnd, 64, 0.55), bright = fractal(rnd, 64, 0.7), tall = fractal(rnd, 64, 0.6);
        let rays = "";
        for (let x = -20; x < w + 20; x += 3) {
          const i = Math.max(0, Math.min(64, Math.round((x + 20) / (w + 40) * 64)));
          const yb = baseY + wave[i] * h * 0.06 + Math.sin(x / w * Math.PI * (1.5 + ci)) * h * 0.04;
          const l = len * (0.7 + tall[i] * 0.35 + rnd() * 0.2), op = Math.max(0, (0.35 + bright[i] * 0.45 + rnd() * 0.25) * strength);
          if (op > 0.04)
            rays += `<rect x="${x}" y="${f1(yb - l)}" width="3.4" height="${f1(l)}" fill="url(#${p}${grad})" opacity="${op.toFixed(2)}"/>`;
        }
        aurora += `<g class="hlh-aurora" style="animation-delay:-${ci * 5}s"><g filter="url(#${p}aglow)" opacity=".7">${rays}</g><g filter="url(#${p}aray)">${rays}</g></g>`;
      });
      const sky = svgDoc(w, h, defs + vgrad(`${p}a1`, [[0, "#b07cff", 0], [0.45, "#9a7dff", 0.25], [0.8, "#4ef2b0", 0.8], [0.93, "#9bffd9", 0.9], [1, "#9bffd9", 0.2]]) + vgrad(`${p}a2`, [[0, "#ff7cd0", 0], [0.5, "#d47cff", 0.3], [0.88, "#5ff0c0", 0.6], [1, "#b0ffe0", 0.15]]) + blurFilter(`${p}aray`, 2) + blurFilter(`${p}aglow`, 14), `<rect width="${w}" height="${h}" fill="url(#${p}sky)"/><ellipse cx="${f1(w * 0.5)}" cy="${H}" rx="${f1(w * 0.7)}" ry="${f1(h * 0.25)}" fill="url(#${p}glow)"/>` + starField(rnd, w, H * 0.95, Math.round(w * h / 6e3)) + aurora);
      let trees = "";
      for (let i = 0; i < Math.round(w / 9); i++) {
        const x = rnd() * w;
        trees += pine(x, ridgeY(hill, x) + 2 + rnd() * 4, h * (0.03 + rnd() * 0.045));
      }
      let big = "";
      const nBig = Math.round(w / 55);
      const xs = Array.from({ length: nBig }, () => rnd() < 0.5 ? rnd() * w * 0.3 : w - rnd() * w * 0.3).sort((a, b) => a - b);
      for (const x of xs)
        big += pine(x, ridgeY(ground, x) + h * 0.01 + rnd() * h * 0.05, h * (0.11 + rnd() * 0.2));
      const land = svgDoc(w, h, defs, `<path d="${jaggedShape(far, H + 2)}" fill="url(#${p}far)"/><path d="M0 0 L${snow.map(([x, y]) => `${x} ${y}`).join(" L")} L${w} 0 Z" fill="url(#${p}snow)" opacity=".92" clip-path="url(#${p}mtn)"/>` + `<rect y="${f1(H - h * 0.08)}" width="${w}" height="${f1(h * 0.09)}" fill="url(#${p}mist)"/>` + `<path d="${smoothShape(hill, h)}" fill="#0e242a"/><path d="${trees}" fill="#0b1f25"/>` + `<path d="${smoothShape(ground, h)}" fill="url(#${p}ground)"/><path d="${big}" fill="#04100f"/><path d="${smoothShape(front, h)}" fill="url(#${p}front)"/>`);
      return { sky, land };
    }
  },
  sunset: {
    tone: "dark",
    build({ w, h, rnd, p }: SceneContext) {
      const H = f1(h * 0.68), R = Math.min(w, h) * 0.12, sx = w * 0.5, sy = H - R * 0.1;
      const defs = vgrad(`${p}sky`, [[0, "#120d2a"], [0.2, "#2e1d4c"], [0.4, "#6a2a5e"], [0.58, "#b33e5c"], [0.74, "#e66f4f"], [0.88, "#f5a45b"], [1, "#fbd07c"]], 0, H) + rgrad(`${p}glow`, [[0, "#ffd78a", 0.5], [0.35, "#ffb070", 0.18], [1, "#ff9060", 0]]) + rgrad(`${p}sun`, [[0, "#fff6d0"], [0.55, "#ffd683"], [1, "#ffa45e"]]) + blurFilter(`${p}soft`, 4) + vgrad(`${p}d1`, [[0, "#e88d60"], [1, "#c25f40"]]) + vgrad(`${p}d2`, [[0, "#c96244"], [1, "#923e31"]]) + vgrad(`${p}d3`, [[0, "#923d34"], [1, "#5f2729"]]) + vgrad(`${p}d4`, [[0, "#552029"], [1, "#2a1019"]]) + vgrad(`${p}haze`, [[0, "#ffc488", 0], [0.6, "#ffc488", 0.22], [1, "#ffc488", 0]]);
      let streaks = "";
      for (let i = 0; i < 9; i++) {
        const y = H * (0.42 + rnd() * 0.5), ww = w * (0.18 + rnd() * 0.35);
        streaks += `<rect class="hlh-drift" style="animation-duration:${60 + rnd() * 40}s;animation-delay:-${(rnd() * 40).toFixed(1)}s" x="${f1(rnd() * w - ww / 2)}" y="${f1(y)}" width="${f1(ww)}" height="${f1(2 + rnd() * 6)}" rx="6" fill="${rnd() > 0.5 ? "#f7a46c" : "#c54f6a"}" opacity="${(0.3 + rnd() * 0.35).toFixed(2)}" filter="url(#${p}soft)"/>`;
      }
      let birds = "";
      for (let i = 0; i < 9; i++) {
        const x = sx + R * (1.2 + rnd() * 3), y = sy - R * (1 + rnd() * 2.2), s = 5 + rnd() * 6;
        birds += `<path d="M${f1(x - s)} ${f1(y)} q${f1(s / 2)} ${f1(-s / 2)} ${f1(s)} 0 q${f1(s / 2)} ${f1(-s / 2)} ${f1(s)} 0"/>`;
      }
      const sky = svgDoc(w, h, defs, `<rect width="${w}" height="${h}" fill="url(#${p}sky)"/>` + starField(rnd, w, H * 0.28, Math.round(w / 25)) + `<circle cx="${f1(sx)}" cy="${f1(sy)}" r="${f1(R * 4.5)}" fill="url(#${p}glow)"/><circle cx="${f1(sx)}" cy="${f1(sy)}" r="${f1(R)}" fill="url(#${p}sun)"/>` + streaks + `<g fill="none" stroke="#2a1430" stroke-width="1.8" stroke-linecap="round" opacity=".75">${birds}</g>`);
      const dunes: [Pt[], string, number][] = [
        [ridge(rnd, w, H + 2, h * 0.012, { rough: 0.4, peaks: [[0.22, h * 0.05, 0.18], [0.78, h * 0.045, 0.15]] }), "d1", 0.4],
        [ridge(rnd, w, H + h * 0.08, h * 0.015, { rough: 0.4, peaks: [[0.08, h * 0.07, 0.15], [0.6, h * 0.075, 0.2]] }), "d2", 0.3],
        [ridge(rnd, w, H + h * 0.16, h * 0.015, { rough: 0.4, peaks: [[0.35, h * 0.08, 0.2], [0.92, h * 0.07, 0.15]] }), "d3", 0.2],
        [ridge(rnd, w, H + h * 0.25, h * 0.015, { rough: 0.4, peaks: [[0.02, h * 0.06, 0.2], [0.6, h * 0.05, 0.25]] }), "d4", 0.12]
      ];
      let body = `<rect y="${f1(H - h * 0.05)}" width="${w}" height="${f1(h * 0.07)}" fill="url(#${p}haze)"/>`;
      for (const [pts, id, rim] of dunes)
        body += `<path d="${smoothShape(pts, h)}" fill="url(#${p}${id})"/><path d="${smoothLine(pts)}" fill="none" stroke="#ffc690" stroke-width="1.6" opacity="${rim}"/>`;
      return { sky, land: svgDoc(w, h, defs, body) };
    }
  },
  dawn: {
    tone: "light",
    build({ w, h, rnd, p }: SceneContext) {
      const H = f1(h * 0.62), R = Math.min(w, h) * 0.085, sx = w * 0.5;
      const defs = vgrad(`${p}sky`, [[0, "#5b82bf"], [0.3, "#90a6d4"], [0.55, "#cbb4cf"], [0.76, "#f0c3b4"], [0.9, "#fbd8b5"], [1, "#ffe8c8"]], 0, H) + rgrad(`${p}glow`, [[0, "#fff3dc", 0.75], [0.3, "#ffe6c4", 0.3], [1, "#ffd9b0", 0]]) + rgrad(`${p}sun`, [[0, "#fffef8"], [0.7, "#fff1d6"], [1, "#ffe0b4"]]) + vgrad(`${p}cloud`, [[0, "#fde9e1"], [1, "#d6a2b6"]]) + blurFilter(`${p}soft`, 2.2) + vgrad(`${p}sea`, [[0, "#f2c9b6"], [0.1, "#cdb5c6"], [0.35, "#90a5ca"], [0.7, "#55739f"], [1, "#2d4a75"]], H, h) + hgrad(`${p}hz`, [[0, "#fff", 0], [0.3, "#fff2dc", 0.4], [0.5, "#fffaf0", 1], [0.7, "#fff2dc", 0.4], [1, "#fff", 0]]);
      let clouds = "";
      for (let i = 0; i < 9; i++) {
        const y = H * (0.18 + rnd() * 0.62), ww = w * (0.12 + rnd() * 0.3), hh = 6 + rnd() * 14;
        clouds += `<ellipse class="hlh-drift" style="animation-duration:${70 + rnd() * 50}s;animation-delay:-${(rnd() * 50).toFixed(1)}s" cx="${f1(rnd() * w)}" cy="${f1(y)}" rx="${f1(ww / 2)}" ry="${f1(hh)}" fill="url(#${p}cloud)" opacity="${(0.45 + rnd() * 0.35).toFixed(2)}" filter="url(#${p}soft)"/>`;
      }
      let gulls = "";
      for (let i = 0; i < 4; i++) {
        const x = w * (0.25 + rnd() * 0.15), y = H * (0.45 + rnd() * 0.2), s = 4 + rnd() * 4;
        gulls += `<path d="M${f1(x - s)} ${f1(y)} q${f1(s / 2)} ${f1(-s / 2)} ${f1(s)} 0 q${f1(s / 2)} ${f1(-s / 2)} ${f1(s)} 0"/>`;
      }
      const sky = svgDoc(w, h, defs, `<rect width="${w}" height="${h}" fill="url(#${p}sky)"/><circle cx="${f1(sx)}" cy="${H}" r="${f1(R * 7)}" fill="url(#${p}glow)"/><circle cx="${f1(sx)}" cy="${f1(H + R * 0.2)}" r="${f1(R)}" fill="url(#${p}sun)"/>` + clouds + `<g fill="none" stroke="#6d6f92" stroke-width="1.4" stroke-linecap="round" opacity=".6">${gulls}</g>`);
      const left: Pt[] = [[-10, H], [w * 0.03, H - h * 0.022], [w * 0.1, H - h * 0.04], [w * 0.17, H - h * 0.028], [w * 0.24, H - h * 0.008], [w * 0.3, H]].map(([x, y]) => [f1(x), f1(y)] as Pt);
      const right: Pt[] = [[w * 0.76, H], [w * 0.83, H - h * 0.018], [w * 0.91, H - h * 0.034], [w + 10, H - h * 0.02]].map(([x, y]) => [f1(x), f1(y)] as Pt);
      let waves = "";
      for (let i = 0; i < Math.round(w / 18); i++) {
        const t = Math.pow(rnd(), 1.4), y = H + 6 + t * (h - H - 10), len = 12 + t * 70 + rnd() * 20, x = rnd() * w;
        waves += `<path d="M${f1(x)} ${f1(y)} q${f1(len / 2)} ${f1(-1.5 - t * 2)} ${f1(len)} 0"/>`;
      }
      const bx = w * 0.7, by = H + 3, bs = Math.max(10, h * 0.018);
      const boat = `<g fill="#4c5680" opacity=".85"><path d="M${f1(bx - bs)} ${f1(by)} h${f1(bs * 2)} l${f1(-bs * 0.3)} ${f1(bs * 0.35)} h${f1(-bs * 1.4)} Z"/><path d="M${f1(bx)} ${f1(by - 1)} v${f1(-bs * 1.8)} l${f1(bs * 0.9)} ${f1(bs * 1.6)} Z"/><path d="M${f1(bx - 1.5)} ${f1(by - 2)} v${f1(-bs * 1.4)} l${f1(-bs * 0.7)} ${f1(bs * 1.3)} Z" opacity=".8"/></g>`;
      const land = svgDoc(w, h, defs, `<path d="${smoothShape(left, H + 1)}" fill="#8a8cb4" opacity=".85"/><path d="${smoothShape(right, H + 1)}" fill="#9798be" opacity=".8"/><rect y="${H}" width="${w}" height="${f1(h - H)}" fill="url(#${p}sea)"/>` + glitter(rnd, sx, H, h, R * 1.3, "#fff7e6", 60) + `<g class="hlh-waves" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" opacity=".28">${waves}</g>` + `<rect y="${f1(H - 0.8)}" width="${w}" height="1.6" fill="url(#${p}hz)"/>` + boat);
      return { sky, land };
    }
  },
  meadow: {
    tone: "light",
    build({ w, h, rnd, p, dashboard }: SceneContext) {
      const H = f1(h * 0.6), R = Math.max(24, Math.min(w, h) * 0.04), sx = dashboard ? w * 0.84 : w * 0.5, sy = h * 0.1;
      const defs = vgrad(`${p}sky`, [[0, "#2b7bcd"], [0.45, "#5aa3e4"], [0.8, "#a6d2f2"], [1, "#e0f2fc"]], 0, H + h * 0.05) + rgrad(`${p}glow`, [[0, "#fffbe6", 0.85], [0.25, "#fffbe6", 0.35], [1, "#fffbe6", 0]]) + vgrad(`${p}shade`, [[0, "#ffffff", 0], [1, "#c8dff0", 0.9]]) + vgrad(`${p}far`, [[0, "#a7c8e0"], [1, "#c6dceb"]]) + vgrad(`${p}h1`, [[0, "#b8de98"], [1, "#97c87a"]]) + vgrad(`${p}h2`, [[0, "#92ce72"], [1, "#6cb058"]]) + vgrad(`${p}h3`, [[0, "#6dbb5b"], [1, "#4b9944"]]) + vgrad(`${p}h4`, [[0, "#58a54d"], [1, "#387c36"]]);
      let clouds = "";
      for (let i = 0; i < 4; i++) {
        const s = Math.min(w, h) * (0.03 + rnd() * 0.035), cx = (i + 0.2 + rnd() * 0.6) * w / 4, cy = h * (0.12 + rnd() * 0.3);
        const circles = [[0, 0, 1], [-1.1, 0.35, 0.75], [1.15, 0.3, 0.8], [-0.5, -0.45, 0.8], [0.55, -0.35, 0.7], [1.9, 0.55, 0.5], [-1.9, 0.6, 0.45]].map(([dx, dy, r]) => `<circle cx="${f1(cx + dx * s)}" cy="${f1(cy + dy * s)}" r="${f1(r * s)}"/>`).join("");
        clouds += `<clipPath id="${p}c${i}">${circles}</clipPath><g class="hlh-drift" style="animation-duration:${80 + rnd() * 60}s;animation-delay:-${(rnd() * 60).toFixed(1)}s"><g fill="#fff">${circles}</g><rect x="${f1(cx - s * 2.6)}" y="${f1(cy - s * 0.2)}" width="${f1(s * 5.2)}" height="${f1(s * 1.4)}" fill="url(#${p}shade)" clip-path="url(#${p}c${i})"/></g>`;
      }
      const sky = svgDoc(w, h, defs, `<rect width="${w}" height="${h}" fill="url(#${p}sky)"/><circle cx="${f1(sx)}" cy="${f1(sy)}" r="${f1(R * 8)}" fill="url(#${p}glow)"/><circle cx="${f1(sx)}" cy="${f1(sy)}" r="${f1(R)}" fill="#fffef7"/>` + clouds);
      const far = ridge(rnd, w, H - h * 0.015, h * 0.015, { rough: 0.5, peaks: [[0.14, h * 0.13, 0.07], [0.29, h * 0.08, 0.06], [0.74, h * 0.15, 0.08], [0.9, h * 0.09, 0.05]] });
      const h1 = ridge(rnd, w, H + h * 0.025, h * 0.01, { rough: 0.4, peaks: [[0.2, h * 0.05, 0.2], [0.7, h * 0.06, 0.2]] });
      const h2 = ridge(rnd, w, H + h * 0.1, h * 0.01, { rough: 0.4, peaks: [[0.05, h * 0.07, 0.2], [0.55, h * 0.05, 0.25]] });
      const h3 = ridge(rnd, w, H + h * 0.19, h * 0.01, { rough: 0.4, peaks: [[0.4, h * 0.06, 0.22], [0.95, h * 0.07, 0.2]] });
      const h4 = ridge(rnd, w, h * 0.94, h * 0.01, { rough: 0.4, peaks: [[0.15, h * 0.05, 0.25], [0.8, h * 0.04, 0.2]] });
      const row = (pts: Pt[], n: number, sMin: number, sMax: number, dark: string, light: string) => {
        let out = "";
        for (let i = 0; i < n; i++) {
          const x = rnd() * w;
          out += leafTree(x, ridgeY(pts, x) + 3, sMin + rnd() * (sMax - sMin), dark, light);
        }
        return out;
      };
      let flowers = "";
      for (let i = 0; i < Math.round(w / 10); i++) {
        const x = rnd() * w, y = ridgeY(h4, x) + 6 + rnd() * (h - ridgeY(h4, x));
        flowers += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(1.2 + rnd() * 1.6)}" fill="${["#ffffff", "#ffe066", "#ff9ec0", "#ffd0e0"][Math.floor(rnd() * 4)]}" opacity=".9"/>`;
      }
      const land = svgDoc(w, h, defs, `<path d="${smoothShape(far, h)}" fill="url(#${p}far)" opacity=".9"/><path d="${smoothShape(h1, h)}" fill="url(#${p}h1)"/>` + row(h1, Math.round(w / 70), h * 0.008, h * 0.014, "#6aa95a", "#86c070") + `<path d="${smoothShape(h2, h)}" fill="url(#${p}h2)"/>` + row(h2, Math.round(w / 120), h * 0.016, h * 0.026, "#4c9445", "#6cb35c") + `<path d="${smoothShape(h3, h)}" fill="url(#${p}h3)"/>` + row(h3, Math.round(w / 260), h * 0.03, h * 0.045, "#3b8139", "#57a04e") + `<path d="${smoothShape(h4, h)}" fill="url(#${p}h4)"/>` + flowers);
      return { sky, land };
    }
  },
  city: {
    tone: "dark",
    front: ["rain-0", "rain-1"],
    build({ w, h, rnd, p }: SceneContext) {
      const H = f1(h * 0.76);
      const defs = vgrad(`${p}sky`, [[0, "#090d16"], [0.45, "#131a2a"], [0.8, "#272a45"], [1, "#4a3d5c"]], 0, H) + blurFilter(`${p}cloud`, 18) + blurFilter(`${p}glow`, 5) + blurFilter(`${p}wide`, 10) + vgrad(`${p}street`, [[0, "#1a1f2e"], [0.15, "#11151f"], [1, "#04060a"]], H, h) + vgrad(`${p}fog`, [[0, "#4a4f72", 0], [0.6, "#4a4f72", 0.4], [1, "#4a4f72", 0]]) + rgrad(`${p}lamp`, [[0, "#ffd48a", 0.75], [0.4, "#ffc56a", 0.25], [1, "#ffc56a", 0]]);
      let clouds = "";
      for (let i = 0; i < 8; i++)
        clouds += `<ellipse class="hlh-drift" style="animation-duration:${70 + rnd() * 50}s;animation-delay:-${(rnd() * 50).toFixed(1)}s" cx="${f1(rnd() * w)}" cy="${f1(h * (0.02 + rnd() * 0.25))}" rx="${f1(w * (0.2 + rnd() * 0.2))}" ry="${f1(h * (0.04 + rnd() * 0.05))}" fill="${rnd() > 0.5 ? "#2d3452" : "#1d2338"}" opacity=".75" filter="url(#${p}cloud)"/>`;
      const sky = svgDoc(w, h, defs, `<rect width="${w}" height="${h}" fill="url(#${p}sky)"/>` + clouds);
      const reflections: [number, string, number][] = [];
      const block = (x: number, top: number, bw: number, fill: string, rim: string) => `<rect x="${f1(x)}" y="${f1(top)}" width="${f1(bw)}" height="${f1(H - top + 2)}" fill="${fill}"/><rect x="${f1(x + bw - 1.5)}" y="${f1(top)}" width="1.5" height="${f1(H - top)}" fill="${rim}"/>`;
      const layer = (hMin: number, hMax: number, fill: string, rim: string, lit: number, colours: string[], sides: boolean) => {
        let out = "", x = -10;
        while (x < w) {
          if (sides && x > w * 0.25 && x < w * 0.75) {
            x = w * 0.75 + rnd() * 20;
            continue;
          }
          const bw = (30 + rnd() * 70) * (sides ? 1.5 : 1), bh = h * (hMin + rnd() * (hMax - hMin)), top = H - bh;
          out += block(x, top, bw, fill, rim);
          if (rnd() < 0.45) {
            const sw = bw * (0.45 + rnd() * 0.3), sh = bh * (0.08 + rnd() * 0.12);
            out += block(x + (bw - sw) / 2, top - sh, sw, fill, rim);
            if (rnd() < 0.5)
              out += `<rect x="${f1(x + bw / 2 - 0.75)}" y="${f1(top - sh - bh * 0.1)}" width="1.5" height="${f1(bh * 0.1)}" fill="${fill}"/>`;
          }
          const gw = Math.max(3.5, bw / 10), gh = gw * 1.35;
          for (let wy = top + gh; wy < H - gh * 1.5; wy += gh * 1.85)
            for (let wx = x + gw * 0.9; wx < x + bw - gw * 1.4; wx += gw * 1.75)
              if (rnd() < lit) {
                const c = colours[Math.floor(rnd() * colours.length)];
                out += `<rect x="${f1(wx)}" y="${f1(wy)}" width="${f1(gw)}" height="${f1(gh)}" fill="${c}" opacity="${(0.4 + rnd() * 0.6).toFixed(2)}"/>`;
                if (sides && rnd() < 0.08)
                  reflections.push([wx + gw / 2, c, 0.6]);
              }
          if (sides && rnd() < 0.55) {
            const c = rnd() > 0.5 ? "#ff4fa3" : "#3de0ff", sy = top + bh * (0.15 + rnd() * 0.3), sx2 = x + (rnd() > 0.5 ? 5 : bw - 13), sh = bh * 0.16;
            out += `<rect x="${f1(sx2 - 3)}" y="${f1(sy - 3)}" width="14" height="${f1(sh + 6)}" rx="4" fill="${c}" opacity=".55" filter="url(#${p}wide)"/><rect x="${f1(sx2)}" y="${f1(sy)}" width="8" height="${f1(sh)}" rx="2" fill="${c}"/><rect x="${f1(sx2 + 2.5)}" y="${f1(sy + 2)}" width="3" height="${f1(sh - 4)}" rx="1" fill="#fff" opacity=".8"/>`;
            reflections.push([sx2 + 4, c, 1.4]);
          }
          x += bw + 1 + rnd() * 6;
        }
        return out;
      };
      const farB = layer(0.16, 0.36, "#232b40", "#2c3550", 0.08, ["#a9bde0"], false);
      const tx = w * (0.55 + rnd() * 0.1), th = h * 0.52;
      const tower = `<path d="M${f1(tx - 14)} ${H} L${f1(tx - 9)} ${f1(H - th * 0.8)} L${f1(tx - 4)} ${f1(H - th * 0.86)} L${f1(tx - 1)} ${f1(H - th)} L${f1(tx + 1)} ${f1(H - th)} L${f1(tx + 4)} ${f1(H - th * 0.86)} L${f1(tx + 9)} ${f1(H - th * 0.8)} L${f1(tx + 14)} ${H} Z" fill="#1f2639"/><circle class="hlh-blink" cx="${f1(tx)}" cy="${f1(H - th - 2)}" r="2.2" fill="#ff4a4a"/>`;
      const midB = layer(0.08, 0.27, "#141a28", "#212a3e", 0.18, ["#f3c06b", "#f6d28d", "#cfe0ff"], false);
      const nearB = layer(0.32, 0.58, "#080b13", "#151b29", 0.12, ["#f3c06b", "#ffe2a8", "#bcd4ff"], true);
      let lamps = "";
      const nl = Math.max(4, Math.round(w / 220));
      for (let i = 0; i < nl; i++) {
        const lx = (i + 0.5) * w / nl + (rnd() - 0.5) * 20, ph = h * 0.075, top = H - ph;
        lamps += `<ellipse cx="${f1(lx + 10)}" cy="${f1(H + (h - H) * 0.12)}" rx="${f1(w * 0.035)}" ry="${f1((h - H) * 0.06)}" fill="url(#${p}lamp)" opacity=".45"/><circle cx="${f1(lx + 10)}" cy="${f1(top + 3)}" r="${f1(h * 0.035)}" fill="url(#${p}lamp)"/><path d="M${f1(lx)} ${H} V${f1(top + 4)} q0 -5 6 -5 h6" fill="none" stroke="#05070c" stroke-width="2.4"/><rect x="${f1(lx + 8)}" y="${f1(top - 2)}" width="8" height="3.5" rx="1.5" fill="#05070c"/><circle cx="${f1(lx + 12)}" cy="${f1(top + 2.5)}" r="2.2" fill="#fff3d4"/>`;
        reflections.push([lx + 12, "#ffd48a", 1.6]);
      }
      let streaks = "";
      for (const [rx, c, k] of reflections)
        streaks += `<rect x="${f1(rx - 1.5 * k)}" y="${f1(H + 4)}" width="${f1(3 * k + rnd() * 2)}" height="${f1((h - H) * (0.35 + rnd() * 0.55))}" fill="${c}" opacity="${(0.1 + rnd() * 0.15).toFixed(2)}" filter="url(#${p}glow)"/>`;
      const land = svgDoc(w, h, defs, farB + tower + `<rect y="${f1(H - h * 0.2)}" width="${w}" height="${f1(h * 0.21)}" fill="url(#${p}fog)"/>` + midB + nearB + `<rect y="${H}" width="${w}" height="${f1(h - H)}" fill="url(#${p}street)"/><rect y="${H}" width="${w}" height="1.5" fill="#2a3146"/>` + streaks + lamps);
      return { sky, land };
    }
  }
};
export const SCENE_LABELS: [string, string][] = [["glow", "Accent glow"], ["plain", "Plain"], ["night", "Night sky (cabin)"], ["lake", "Moonlit lake"], ["aurora", "Aurora"], ["sunset", "Sunset dunes"], ["dawn", "Ocean dawn"], ["meadow", "Sunny meadow"], ["city", "Rainy city"], ["auto", "Auto (changes with time of day)"]];
export function autoScene(): string {
  const h = (/* @__PURE__ */ new Date()).getHours();
  return h >= 5 && h < 8 ? "dawn" : h >= 8 && h < 17 ? "meadow" : h >= 17 && h < 20 ? "sunset" : "lake";
}
