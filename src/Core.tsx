import { useEffect, useRef } from 'react';

/**
 * The core: a flow field, drawn by what moves through it.
 *
 * Nothing here draws a stream. Several thousand particles are pushed along a
 * velocity field and each leaves a dot; an offscreen buffer is faded slightly
 * every frame, so the dots a particle left a moment ago are still there and
 * fading. The streaks are the trails, and they are brightest where a particle
 * is now — which means the sense of flow comes out of the mechanism rather
 * than being a property that has to be animated onto something.
 *
 * Three earlier attempts drew the streams directly, as ribbons or strokes, and
 * all of them failed the same way: a few wide translucent shapes over a lot of
 * empty canvas reads as a handful of grey arcs, not as a field. A field is
 * made of many small contributions accumulating. That is what this is.
 *
 * The middle stays dark because the radial field pushes outward below a floor
 * radius, so particles round it and never arrive. What says something is there
 * is that everything bends around it.
 */

export type CoreState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'tool_execution'
  | 'approval_required'
  | 'speaking'
  | 'offline';

interface Mood {
  /** Angular rate near the rim; the field scales it up toward the middle. */
  swirl: number;
  /** Strength of the in-and-out lobes. */
  radial: number;
  /**
   * Which lobe count is in play, 0 = three, 1 = five.
   *
   * Blended between two separately evaluated fields rather than by moving the
   * lobe count itself. sin(mθ) only closes at θ=2π when m is an integer, so a
   * fractional m would tear the field along one radius and particles crossing
   * it would jump. Two whole-numbered fields, mixed, stay periodic at every
   * mixture.
   */
  lobes: number;
  /** A steady radial drift on top of the lobes. Negative draws inward. */
  bias: number;
  /** How far a particle moves per second, as a multiplier on the field. */
  pace: number;
  /**
   * How long a trail lives, in seconds.
   *
   * Shortened, then partly put back, and the experiment is worth keeping.
   *
   * Halving it was meant to hit two problems at once: a cyan trail passes
   * through the range where green and blue round together on its way out, so a
   * shorter one leaves less of the field that colour, and a shorter trail is
   * also a shorter fibre. It did the first modestly — dark pixels at 180° went
   * 50.8% to 42.1% — and the second in the worst available way, by turning the
   * strands into dashes. It also did not get cheaper: frame time went slightly
   * up. The fade is a fixed-area blit and the dot count is unchanged, so there
   * was never a mechanism for it to.
   *
   * These sit between the two. The colour of the dark parts is the
   * background's problem, not this number's.
   */
  trail: number;
  /** Roughly what share of the particles are bright. */
  litFraction: number;
  brightness: number;
  /**
   * Cold end of the palette.
   *
   * The cold end, which only energetic particles ever reach.
   *
   * Hue is chosen by energy as well as position, so cyan belongs to the
   * particles carrying a packet and the quiet ones sit at the blue end. Below
   * about 192 a faint cyan's green and blue round to the same integer and the
   * pixel comes out at exactly 180°, a green cyan — which is why the cold end
   * cannot simply be pushed colder to get more of it.
   *
   * The range is narrow now: blue and cyan, no violet. The light and dark of
   * the field carry the hierarchy instead, which is what "mostly dark with a
   * little of it strongly lit" means.
   */
  hue: number;
  /**
   * How far the hot end runs past blue.
   *
   * **紫より先は一度やって失敗している。**282 まで一様に広げたら、場が
   * 組織の切片のように見えた。やり直したのは、その時**場全体を紫に振った**
   * からで、色そのものが悪かったわけではない。
   *
   * いまは端を分けている。冷たい側（`hue`）が場の地で、熱い側は
   * `hue + spread` に置くが、**そこへ届くのは最も強い粒と中心だけ**。
   * 割り当ては直線ではなく、指数で熱い側を狭めてある（`buildSprites`）。
   * 12段のうち紫紅に入るのは上の2段だけで、残りは青のまま。
   */
  spread: number;
  /** Overall size of the field, as a fraction of the canvas. */
  reach: number;
}

/**
 * States are the same field under different settings.
 *
 * Two columns are deliberately identical down every row. Colour is the brand,
 * not the state: the field was running hue 188 while listening and 208 while
 * waiting for approval, which turns an identity into a status light. And size
 * is fixed, because a core that grows when it thinks is a core whose size
 * means something — it was 0.30 to 0.41 across the table. They are held here
 * rather than moved out of the table so that adding a state cannot quietly
 * reintroduce either.
 *
 * What a state may change is how the field moves and how much of it is lit.
 */
const MOOD: Record<CoreState, Mood> = {
  offline:           { swirl: 0.10, radial: 0.08, lobes: 0.0, bias:  0.00, pace: 0.35, trail: 1.05, litFraction: 0.05, brightness: 0.34, hue: 202, spread: 134, reach: 0.355 },
  idle:              { swirl: 0.30, radial: 0.26, lobes: 0.0, bias: -0.01, pace: 1.00, trail: 1.00, litFraction: 0.14, brightness: 1.00, hue: 202, spread: 134, reach: 0.355 },
  listening:         { swirl: 0.38, radial: 0.32, lobes: 0.2, bias: -0.07, pace: 1.25, trail: 0.95, litFraction: 0.22, brightness: 1.20, hue: 202, spread: 134, reach: 0.355 },
  thinking:          { swirl: 0.72, radial: 0.44, lobes: 1.0, bias:  0.00, pace: 1.85, trail: 0.58, litFraction: 0.34, brightness: 1.28, hue: 202, spread: 134, reach: 0.355 },
  tool_execution:    { swirl: 0.46, radial: 0.38, lobes: 0.5, bias:  0.07, pace: 1.45, trail: 0.72, litFraction: 0.26, brightness: 1.22, hue: 202, spread: 134, reach: 0.355 },
  approval_required: { swirl: 0.20, radial: 0.12, lobes: 0.0, bias:  0.00, pace: 0.55, trail: 1.2, litFraction: 0.18, brightness: 1.10, hue: 202, spread: 134, reach: 0.355 },
  speaking:          { swirl: 0.40, radial: 0.36, lobes: 0.3, bias:  0.05, pace: 1.40, trail: 0.88, litFraction: 0.28, brightness: 1.24, hue: 202, spread: 134, reach: 0.355 },
};

/** Particles. Enough that the field is continuous, few enough to be cheap. */
const COUNT = 4200;

/**
 * Where the outward push begins, as a fraction of the reach.
 *
 * This is what keeps the middle empty and stops anything reaching a
 * singularity. The angular clamp below is a second, independent guarantee: if
 * this ever failed the field would still be bounded rather than violent.
 *
 * Lowered along with the outer radius, which is how the field gets denser
 * without a single extra particle. Density is particles per area, and area is
 * the thing to change: adding particles costs frame time in direct proportion
 * and the same four thousand in a narrower annulus cost nothing. The hollow is
 * still a hollow — it has to be, since the name and state sit in it.
 */
const R_FLOOR = 0.13;

/** Hard ceiling on dθ/dt, in radians per second. */
const MAX_ANGULAR = 3.2;

/** Softening in the angular law, so the rate is finite at the centre. */
const SOFTEN = 0.16;

/** Trail-fade steps are taken at a fixed cadence, independent of frame rate. */
const STEP = 1 / 60;

/**
 * Simulation steps to run before the first paint, so trails exist.
 *
 * One trail length is enough: at the idle setting that is about two seconds,
 * or 130 steps. Measured at roughly 0.8ms a step on this machine, so running
 * the lot synchronously would be a 100ms stall — which is exactly why the
 * warm-up is bounded by time rather than by this number, and why whatever does
 * not fit continues across the first frames.
 */
const WARMUP_STEPS = 130;

/** Milliseconds the synchronous part of the warm-up may take. */
const WARMUP_BUDGET_MS = 8;

/** Colours are pre-rendered into sprites; this many across the palette. */
const TINTS = 12;

function hash(i: number, salt: number): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}


/** 格子の乱数。`hash` と違い `Math.sin` を使わない — 毎フレーム何度も呼ぶので。 */
function latticeHash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 格子の間を滑らかに繋いだ乱数。 */
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const n00 = latticeHash(xi, yi);
  const n10 = latticeHash(xi + 1, yi);
  const n01 = latticeHash(xi, yi + 1);
  const n11 = latticeHash(xi + 1, yi + 1);
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}

/** 粗いうねりと細かいうねりを重ねたもの。動きに尺度を二つ持たせる。 */
/**
 * 時間で**平行移動しない。**回す。
 *
 * `x + t*0.13, y - t*0.09` と書いてあった。模様ごと斜めに流れるので、場の
 * 中央を埋めた版では**上から下へ波が通って見えた**（利用者いわく「なんか
 * 上から下に波状の何かが出ててキモいな」）。輪のあいだは空洞が真ん中を
 * 隠していただけで、**欠陥は前からある** —— 三割の粒がこの流れに乗っている。
 *
 * 平行移動は、どんなに遅くしても掃きになる。速さではなく向きの問題。座標を
 * 回して読めば、模様は動き続けるのに**どこへも行かない。**
 *
 * 二枚を逆向きに回すのは、片方だけだと全体が一緒に回って**渦の絵**になる
 * から。速さも 0.041 と 0.067 で揃えていない —— 揃えると二枚が同じ位相へ
 * 戻る周期ができる。
 */
function flowField(x: number, y: number, t: number): number {
  const a1 = t * 0.041;
  const c1 = Math.cos(a1);
  const s1 = Math.sin(a1);
  const a2 = -t * 0.067;
  const c2 = Math.cos(a2);
  const s2 = Math.sin(a2);
  return (
    valueNoise(x * c1 - y * s1, x * s1 + y * c1) * 0.65 +
    valueNoise((x * c2 - y * s2) * 2.7, (x * s2 + y * c2) * 2.7) * 0.35
  );
}

/**
 * 渦だけを取り出した流れ。ノイズをそのまま速度にすると湧き出し口と吸い込み口が
 * できて粒が団子になるので、直交勾配を取って発散を消す。
 */
function curl(x: number, y: number, t: number, out: { x: number; y: number }) {
  const e = 0.09;
  out.x = (flowField(x, y + e, t) - flowField(x, y - e, t)) / (2 * e);
  out.y = -(flowField(x + e, y, t) - flowField(x - e, y, t)) / (2 * e);
}

/**
 * 渦に乗る粒の割合。
 *
 * 全部に掛けたら**輪が歪んだ** — 渦は粒をいま乗っている円から横へ押すので、
 * 道筋が反って輪が輪に見えなくなる。欲しいのは掃くように動かないことで、
 * 形が崩れることではない。
 *
 * 多数派が形を保ち、少数派が細部を出す。三割。
 */
const WANDER = 0.3;
/** 渦の強さ。乗る粒だけに掛かるので、全体に掛けていた頃より強くできる。 */
const CURL = 0.10;

export function Core({
  state,
  /**
   * How much is being heard right now, 0–1.
   *
   * The microphone is a helper process on the machine and its levels never
   * reach the browser, so this is driven by the transcript growing instead of
   * by amplitude. A real signal about a real thing, rather than an animation
   * pretending to listen. It draws the field inward and lights more of it.
   */
  activity = 0,
  size = 320,
}: {
  state: CoreState;
  activity?: number;
  size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  const activityRef = useRef(activity);
  stateRef.current = state;
  activityRef.current = activity;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    /**
     * The buffer is half the displayed size.
     *
     * A quarter of the fill area for the fade and for every dot, and scaling
     * it back up on composite softens the trails for free — which is the look
     * this wants anyway. Nothing here has an edge that needs to be sharp.
     */
    const bufSize = Math.max(64, Math.round((size * dpr) / 2));
    const buf = document.createElement('canvas');
    buf.width = bufSize;
    buf.height = bufSize;
    const bctx = buf.getContext('2d');
    if (!bctx) return;

    /**
     * A scratch copy, used only to make the trails actually decay.
     *
     * Drawing a canvas onto itself is legal but its behaviour under 'copy' is
     * the sort of thing that differs between engines, and this runs every
     * step. One extra surface is cheaper than finding out.
     */
    const scratch = document.createElement('canvas');
    scratch.width = bufSize;
    scratch.height = bufSize;
    const sctx = scratch.getContext('2d');
    if (!sctx) return;

    /**
     * One sprite per colour step, drawn once.
     *
     * Building a gradient per particle was what made the previous version
     * expensive; a sprite is a texture upload once and a blit thereafter, and
     * the tint is chosen by picking which sprite rather than by recolouring.
     */
    const sprites: HTMLCanvasElement[] = [];
    const highlights: HTMLCanvasElement[] = [];
    /**
     * A second, small set for the faint majority.
     *
     * They are drawn a few pixels across, and asking the canvas to scale an
     * 18px texture down to three is most of the cost of drawing them — which
     * matters now that every particle is drawn rather than only the lit ones.
     * A sprite already the right size skips the resample.
     */
    const smalls: HTMLCanvasElement[] = [];
    const SMALL_PX = 6;
    const SMALL_MAX = 7;

    /**
     * 重なりを白にするための一枚。**色を持たせない。**
     *
     * 最初は熱い側のハイライト（淡い桃）を加算に流したが、桃には色相が
     * あるので、重なると青から振り切れて**場が橙に寄った**（0° が明るい
     * 画素の 30.7%）。加算で積むものは、積んでも行き先が白であるもので
     * なければならない。ごく薄い暖色を残してあるのは、白が青側に寄って
     * 見えないようにするためで、色として見える量ではない。
     */
    const buildBloom = () => {
      const px = 16;
      const c = document.createElement('canvas');
      c.width = px;
      c.height = px;
      const g = c.getContext('2d');
      if (!g) return null;
      const grad = g.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
      grad.addColorStop(0, 'hsla(350, 22%, 97%, 1)');
      grad.addColorStop(0.3, 'hsla(350, 26%, 92%, 0.42)');
      grad.addColorStop(0.85, 'hsla(350, 30%, 88%, 0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, px, px);
      return c;
    };
    const bloomArt = buildBloom();

    /**
     * **尖った点。**滲みではなく点。
     *
     * 場のスプライトは 18px の放射グラデーションで、縁が柔らかく作ってある。
     * それはそれで正しい — 尾が尾に見えるのはそのおかげ。ただし**どれだけ
     * 明るくしても玉になる。**像にある「小さく硬い輝き」は、同じ道具では
     * 作れない。
     *
     * なので芯だけ別に持つ。中心は詰まっていて、`0.34` で急に落ちる。
     * 大きさは 5px で、**粒より小さい。**大きくすると玉に戻る。
     */
    const buildSpark = () => {
      const px = 5;
      const c = document.createElement('canvas');
      c.width = px;
      c.height = px;
      const g = c.getContext('2d');
      if (!g) return null;
      const grad = g.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
      grad.addColorStop(0, 'hsla(345, 12%, 100%, 1)');
      grad.addColorStop(0.34, 'hsla(345, 16%, 99%, 0.92)');
      grad.addColorStop(0.62, 'hsla(345, 22%, 96%, 0.22)');
      grad.addColorStop(1, 'hsla(345, 26%, 94%, 0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, px, px);
      return c;
    };
    const sparkArt = buildSpark();


/**
 * 色の段。`u = 0` が一番熱く、`1` が一番冷たい。
 *
 * 中央に名前を描いていたころ、名前にも同じ段を読ませるために切り出した。
 * 名前は撤廃したので**いまの読み手は粒だけ**だが、関数のまま残す —— 段の
 * 理屈（桃に割く割合、彩度を下げる理由、冷たい端のシアン）が名前を持つより
 * ずっと長いので、`buildSprites` の途中に埋まっているより読める。
 *
 * 中身は切り出したときから動かしていない。
 */

function rampAt(u: number, hue: number): { h: number; sat: number; lit: number; chill: number; warm: boolean } {
  const ROSE = 0.25;
  const warm = u <= ROSE;
  const h = warm
    ? 344 - 10 * (u / ROSE)
    : hue + (260 - hue) * (1 - (u - ROSE) / (1 - ROSE));
  /*
   * いちばん冷たい二段だけ、シアンへ寄せる。
   *
   * ここには「180°は緑がかったシアンで、加算の破綻の印」という記録が
   * ある。**それは破綻で流れ着いた180°の話**で、意図して置く色とは
   * 別。190°は rgb(0,212,255) の澄んだ空色で、緑には見えない。
   *
   * 冷たい端だけに限るのは、参考にした像でもシアンは**外周の細い光**
   * であって、地の色ではないから。
   */
  /*
   * 帯は広く取る。0.86 から始めたときは 12 段のうち上の2段だけが
   * シアンで、**その段に届く粒がほとんど無く**、画面のシアンは 0.6%
   * だった。桃のときと同じ失敗 — 端まで色を用意しても、そこへ届く
   * 粒が居なければ置いていないのと同じ。
   */
  const chill = u > 0.68 ? (u - 0.68) / 0.32 : 0;
  // 淡さも段で変える。冷たい側はこれまでどおり彩度100%・明度50%。
  /*
   * **いちばん熱いところは赤。**そこから外へ向かって淡い桃になる。
   *
   * これまでは逆で、熱い端が一番淡かった（明度78%）。白は加算の層が
   * 作っているので、**地の色まで白へ寄せる必要は無い** — むしろ寄せると
   * 芯に置く色が無くなる。像は白い芯のすぐ外が深いクリムゾンで、そこから
   * 桃・紫・青と外へ行く。その順番に合わせる。
   *
   * ただし彩度は落としてある。`hsl(352, 92%, 50%)` の純赤にしたときは
   * **血の色**で、有機的に蠢く動きと合わさって生々しくなった。同じ
   * 「熱いところが赤」でも、**彩度が下がれば色であって体液ではない。**
   * 暖色に割く段数は 0.28 → 0.25。一度 0.21 まで詰めたが、暖色が画面の
   * 8% から 2.6% まで落ちて**「少し」の範囲を超えた** — 生々しさの
   * 出どころは量ではなく彩度なので、下げるのはそちらだけでいい。
   */
  const sat = warm ? 68 - 8 * (u / ROSE) : 100;
  const lit = warm ? 58 + 18 * (u / ROSE) : 50;
  return { h, sat, lit, chill, warm };
}

    const buildSprites = (hue: number, spread: number) => {
      sprites.length = 0;
      highlights.length = 0;
      smalls.length = 0;
      const px = 18;
      for (let i = 0; i < TINTS; i++) {
        const c = document.createElement('canvas');
        c.width = px;
        c.height = px;
        const g = c.getContext('2d');
        if (!g) continue;
        /**
         * 熱い側は**淡い。**濃い紫紅ではない。
         *
         * 前の版は端を hsl(336,100%,50%) — 彩度も明度も振り切った紫紅にして
         * いた。**参考にした像にその色は無い。**あの像は中心が白く、そこから
         * 出ているのは**白っぽいローズ**で、濃いのは芯のごく一部だけ。彩度
         * 100%・明度50%の紅を置くと、淡い光ではなく**塗った色**になる。
         *
         * なので熱い側は明度を上げ、彩度を下げる。「明度を上げると濁る」と
         * ここに書いてあるのは**暗くした場合**の話で、HSL で灰へ落ちるのは
         * 両端だが、白へ寄せた桃は灰にならない。
         *
         * 割り当ても二段に分ける。滑らかに配ると、どう指数をいじっても
         * 中間の段が紫に居座る — それが「濃い紫が入っている」と見えたもの。
         * 上の2段だけをローズにして、残りは青〜青紫のまま繋げる。
         */
        const u = i / (TINTS - 1);
        /*
         * 桃に割く段の数。
         *
         * 0.14（12段のうち2段）だと、画面の明るい画素のうち桃は **0.9%** しか
         * 無かった。彩度も明るさも狙いどおり（50〜59% / 92〜95%）でも、
         * **その割合では色が入っているとは言えない。**測って決める。
         */
        const { h, sat, lit, chill, warm } = rampAt(u, hue);
        // A little white at the hot end, so the densest knots lift toward it
        // without any particle being white on its own.
        /**
         * Fixed at the lightness of maximum chroma, and dimmed with opacity
         * only.
         *
         * Lowering lightness to make something darker also drains the colour:
         * in HSL both ends of the scale run to grey, so the faint parts of the
         * field came out muddy rather than faint. 50% is where a hue is
         * purest, and a dot at 50% lightness and low alpha is the same colour
         * as a bright one, just less of it — which is what "dark but not
         * dirty" has to mean.
         *
         * Saturation stays at 100 for the same reason. It was being reduced
         * toward the violet end, and desaturated violet is exactly the
         * grey-purple to avoid.
         */
        /**
         * The tail is cut short rather than faded to nothing.
         *
         * A radial stop running to alpha 0 spends its last third at values
         * where eight bits cannot hold a hue: green and blue round to the same
         * integer and the pixel comes out neutral. Every sprite carries that
         * ring, every dot leaves one behind, and they accumulate into a
         * desaturated halo standing a size larger than the field — 15,861
         * neutral pixels, measured, centred on the field rather than offset,
         * which is what says it is the sprites and not a stray layer.
         *
         * So the gradient reaches zero at 0.82 of the radius and the midpoint
         * comes in with it. The dot is very slightly smaller and its edge very
         * slightly harder; what it stops doing is painting grey.
         */
        const grad = g.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
        const body = `${(h - 12 * chill).toFixed(0)}, ${sat.toFixed(0)}%, ${lit.toFixed(0)}%`;
        grad.addColorStop(0, `hsla(${body}, 1)`);
        grad.addColorStop(0.25, `hsla(${body}, 0.35)`);
        grad.addColorStop(0.82, `hsla(${body}, 0)`);
        g.fillStyle = grad;
        g.fillRect(0, 0, px, px);
        sprites.push(c);

        /**
         * The highlight set: the same hue carried toward white, never white.
         *
         * Pure white would be the cheap way to say "bright" and it is what
         * makes a field look like a neon sign. This is the local colour at
         * high lightness and reduced saturation — soft blue-white at the cold
         * end, lavender at the warm one — so a highlight still belongs to the
         * place it appears in.
         */
        const hc = document.createElement('canvas');
        hc.width = px;
        hc.height = px;
        const hg = hc.getContext('2d');
        if (hg) {
          const hgrad = hg.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
          /**
           * Bluer and less washed out than it looks like it needs to be.
           *
           * At 72% saturation and 82% lightness the green and blue channels
           * land close together, and once a highlight's trail has faded they
           * round to equal — which is 180°, a green cyan, and it was 21.8% of
           * the dark pixels in the field. A highlight is only white-ish for a
           * moment; what it leaves behind has to still be blue.
           */
          const hh = h + 14 - 30 * chill;
          /*
           * 熱い側だけ白へ寄せる。
           *
           * 像の中心は白い。ただし**どの粒も単体では白にしない** — 白は
           * 「明るい」と言うための安い手で、それをやると電飾になる。熱い段の
           * ハイライトだけ明度を上げ、冷たい段はこれまでどおり青白のままに
           * する。白く見えるのは、熱い粒が重なったところだけ。
           */
          // 熱い段のハイライトは白桃。像の芯がそう見えている。
          /*
           * 冷たい端のハイライトはシアン寄りの青白。像の外周にある細い光が
           * それで、**地の青とは別の明るさ**として立つ。
           */
          const hl = warm ? 90 : 76 + 8 * chill;
          const hsat = warm ? 76 : 90 - 14 * chill;
          hgrad.addColorStop(0, `hsla(${hh.toFixed(0)}, ${hsat}%, ${hl}%, 1)`);
          hgrad.addColorStop(0.3, `hsla(${hh.toFixed(0)}, ${hsat + 6}%, ${hl - 16}%, 0.5)`);
          hgrad.addColorStop(1, `hsla(${hh.toFixed(0)}, 100%, 50%, 0)`);
          hg.fillStyle = hgrad;
          hg.fillRect(0, 0, px, px);
          highlights.push(hc);
        }

        const sc = document.createElement('canvas');
        sc.width = SMALL_PX;
        sc.height = SMALL_PX;
        const sg = sc.getContext('2d');
        if (sg) {
          const sgrad = sg.createRadialGradient(
            SMALL_PX / 2, SMALL_PX / 2, 0, SMALL_PX / 2, SMALL_PX / 2, SMALL_PX / 2
          );
          // Same cut as the large sprite, and for the same reason: the faint
          // majority are drawn with these, so their tails are most of the halo.
          /*
           * **大きい方と同じ段を読む。**ここだけ `100%, 50%` の直書きだった。
           *
           * 多数派の粒はこの絵で描かれるので、**段（`rampAt`）の彩度や明度を
           * 変えても画面がほとんど動かない。**2026-09-05 に段を 100 → 62 → 44 と
           * 三度落として「彩度は効かない」と結論し、明るさ・加算の層・尾の
           * 積み上がりを順に疑って回った。探す先が全部間違っていた。
           *
           * **色を二箇所に書くと、片方だけ変えたときに変えたことが画面に
           * 出ない。**出ないので、原因を別の場所に探しに行くことになる。
           *
           * いまの段は冷たい側が `sat 100 / lit 50` なので、この差し替えで
           * 青の見た目は変わらない。変わるのは暖色の少数だけ。
           */
          const body2 = `${(h - 12 * chill).toFixed(0)}, ${sat.toFixed(0)}%, ${lit.toFixed(0)}%`;
          sgrad.addColorStop(0, `hsla(${body2}, 1)`);
          sgrad.addColorStop(0.25, `hsla(${body2}, 0.35)`);
          sgrad.addColorStop(0.82, `hsla(${body2}, 0)`);
          sg.fillStyle = sgrad;
          sg.fillRect(0, 0, SMALL_PX, SMALL_PX);
          smalls.push(sc);
        }
      }
    };
    let tintHue = MOOD.idle.hue;
    let tintSpread = MOOD.idle.spread;
    buildSprites(tintHue, tintSpread);

    // Particle state, in polar coordinates because the field is written that
    // way. Flat typed arrays rather than objects: this is touched 4200 times a
    // step and allocation per particle would dominate.
    const pr = new Float32Array(COUNT);
    const pa = new Float32Array(COUNT);
    const plife = new Float32Array(COUNT);
    const pspan = new Float32Array(COUNT);
    const pweight = new Float32Array(COUNT);
    /**
     * 粒が**持ち歩く**熱の印。生まれた時の位置と時刻で決まり、以後変わらない。
     *
     * 熱を「場所の関数」にしていたので、**模様の方が止まっていて、粒はその上を
     * 通り過ぎるだけ**だった。だから同じ角度がいつまでも同じ色になる — 染めた
     * 布の上を水が流れているようなもので、混ざらない。
     *
     * 印を粒に持たせると、色は流れに乗って運ばれる。内側と外側で回る速さが
     * 違うので、**同じ印を持つ粒の並びは時間とともに引き伸ばされ、渦を巻き、
     * 隣の色と噛み合う。**染料を流し込んだときに起きることと同じ。
     */
    const pheat = new Float32Array(COUNT);
    /** 渦に乗るか。粒ごとに固定で、一度決めたら変えない。 */
    const pwander = new Uint8Array(COUNT);
    /**
     * 面の**手前か奥か**。-1 が奥、+1 が手前。粒ごとに固定で、生まれ直しても
     * 変わらない。
     *
     * 場はいままで**厚みの無い一枚**だった。輪の中で粒が重なっても、大きさも
     * 明るさも同じなので、どれが手前か分からない — 重なりが**混雑**にしか
     * 見えず、**層**にならない。
     *
     * 固定にしてあるのは、これで描く順を**一度だけ**決められるから。毎フレーム
     * 4200 個を並べ替えるのは高くつくし、粒はどれも取り替えが利くので、
     * 位置が入れ替わる必要はない。
     */
    const pz = new Float32Array(COUNT);
    /** 奥から手前への描き順。`pz` が動かないので一度作れば足りる。 */
    const order = new Int32Array(COUNT);
    const ptint = new Uint8Array(COUNT);


    const respawn = (i: number, initial: boolean, at = 0) => {
      // Weighted to the rim: particles enter from outside and work inward.
      pr[i] = 0.72 + hash(i, initial ? 21 : Math.floor(plife[i] * 1000) + 21) * 0.4;
      pa[i] = hash(i, initial ? 22 : Math.floor(pr[i] * 9973) + 22) * Math.PI * 2;
      pspan[i] = 3.5 + hash(i, 23) * 6;
      /*
       * 生まれた瞬間の場で決める。**隣り合って生まれた粒は同じ印を持つ**ので
       * 塊として出発し、そこから流れに引き伸ばされていく。
       */
      {
        const a0 = pa[i];
        const r0 = Math.min(1, Math.max(0, pr[i]));
        // 時刻は引数で受ける。**`simTime` は宣言より前**にあるので、
        // ここから直に触ると初回の生成で落ちる（実際に落とした）。
        const n1 = Math.sin(a0 * 7 - at * 0.31 + r0 * 5.5);
        const n2 = Math.sin(a0 * 11 + at * 0.17 + r0 * 3.1);
        const n3 = Math.sin(a0 * 4 - at * 0.23 + r0 * 7.9);
        pheat[i] = 0.5 + 0.5 * Math.max(-1, Math.min(1, n1 * 0.52 + n2 * 0.30 + n3 * 0.34));
      }
      // Staggered on the first fill so respawns never arrive in a wave.
      plife[i] = initial ? hash(i, 24) * pspan[i] : pspan[i];
    };

    for (let i = 0; i < COUNT; i++) {
      respawn(i, true);
      pweight[i] = hash(i, 25);
      pz[i] = hash(i, 27) * 2 - 1;
      pwander[i] = hash(i, 28) < WANDER ? 1 : 0;
      ptint[i] = Math.floor(hash(i, 26) * TINTS);
      order[i] = i;
    }
    /*
     * 奥から手前へ。**一度だけ**。
     *
     * 手前の粒があとから描かれるので、重なったところで手前が勝つ。これが
     * 無いと、大きさと明るさで差を付けても**奥の粒が手前の上に乗る**ことが
     * あり、層に見えない。
     */
    order.sort((p, q) => pz[p] - pz[q]);

    /** 渦の受け皿。粒ごとに作ると毎フレーム四千個のごみになる。 */
    const whirl = { x: 0, y: 0 };
    const shown: Mood = { ...MOOD.idle };
    let simTime = 0;
    let raf = 0;
    let last = 0;
    let warmed = 0;
    /** Left-over time between fixed steps, carried to the next frame. */
    let accrued = 0;

    // Rolling cost, so "is this cheaper than the last one" is a measurement
    // rather than an opinion. Read it from the console as window.__irisCore.
    let costMs = 0;
    let costN = 0;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    /** One simulation step at a fixed cadence, plus the dots it leaves. */
    const step = (dt: number) => {
      simTime += dt;

      const heard = activityRef.current;
      const swirl = shown.swirl;
      const radial = shown.radial;
      const blend = shown.lobes;
      const bias = shown.bias - heard * 0.05;
      const pace = shown.pace * (1 + heard * 0.15);
      const lit = shown.litFraction + heard * 0.1;

      const scale = bufSize * shown.reach;
      const cx = bufSize / 2;
      const cy = bufSize / 2;

      // Lobes rotate slowly, and the two fields at different rates, so the
      // pattern of inflow and outflow never settles.
      const roll3 = simTime * 0.055;
      const roll5 = -simTime * 0.037;

      /**
       * Dots composite normally, not additively.
       *
       * Additive was the obvious choice — crossing flows should brighten — and
       * it destroyed the palette. Channels clip one at a time: blue tops out
       * first, and every dot after that only raises green, so a cyan region
       * walks from 197° toward 180° and a violet one walks toward 300°.
       * Measured on the settled field, the largest hue bin was 180° at 31.8%
       * and there was 5% magenta, neither of which is in a palette that runs
       * 197 to 254. The effective-brightness check missed it because the alpha
       * was low enough to hide the clipping from the composited value while
       * the hue was already gone.
       *
       * Compositing normally makes density an opacity rather than a sum, so
       * the colour of a pixel is always a colour that was drawn. Crossing
       * flows read as more opaque instead of brighter, which is a fair trade
       * for a field that can no longer leave its own palette.
       */
      bctx.globalCompositeOperation = 'source-over';

      /*
       * 中央には名前を置かない。**そう決めた**（利用者、2026-09-05
       * 「IRISの中央の文字は上手く行かなそうだから撤廃」）。
       *
       * 四度作っている —— 部品と二行の文字、粒で書いたもの、書体を打った
       * もの、作図して場の光で塗ったもの。最後のものは形も色も測って
       * 合わせたが、**それでも中央に馴染まなかった。**
       *
       * 直し方の問題ではなく、置くことの問題だったと見る。空洞は粒が
       * 届かない場所で、そこに何を置いても**場の外から来たもの**になる。
       * 実装は `dc70f33` に残っている。
       */

      for (let k = 0; k < COUNT; k++) {
        const i = order[k];
        let r = pr[i];
        let a = pa[i];

        /**
         * Angular velocity — dθ/dt directly, not a tangential speed.
         *
         * Written as a speed it would be divided by r again on the way into
         * dθ/dt, giving a 1/r² law that is violent near the middle. As an
         * angular rate it rises toward the centre and stays finite, which is
         * the behaviour wanted: hard turns close in, long sweeps outside. The
         * clamp is a second guarantee, independent of the floor below.
         */
        /**
         * 粒ごとに速さが違う。**同じ半径でも揃わない。**
         *
         * ここは半径だけで決まっていたので、同じ輪に居る粒が寸分違わず同じ
         * 速さで回り、跡が**完全な同心円**になっていた。「鯉が回っている
         * ように見える」と言われたのがそれで、生き物というより回転台。
         *
         * HUD 側のコアには最初から粒ごとの速さがあり、あちらがそう見えない
         * のはそのため。**片方にしか無い性質だった。**
         *
         * 幅は ±14%。これ以上開くと、速い粒が遅い粒を追い越して**環が二重に
         * 見える。**
         */
        const own = 0.86 + pweight[i] * 0.28;
        /*
         * 三割だけ、湧いては消える渦の中を漂う。残りは円のまま。
         *
         * 全部に掛けると輪が歪む。少数なら、**形は多数派が保ったまま、
         * 道筋の乱れだけが見える。**
         */
        let swirlR = 0;
        let swirlT = 0;
        if (pwander[i]) {
          curl(Math.cos(a) * r * 1.7, Math.sin(a) * r * 1.7, simTime, whirl);
          swirlR = whirl.x * Math.cos(a) + whirl.y * Math.sin(a);
          swirlT = -whirl.x * Math.sin(a) + whirl.y * Math.cos(a);
        }
        /*
         * 場所によるゆらぎ。粒ごとの差だけだと、**速い粒の環と遅い粒の環**に
         * 分かれてしまう。位置で揺らすと、同じ粒でも速い場所と遅い場所を
         * 通るので、筋が曲がる。
         */
        const shear = 1 + Math.sin(a * 5 - r * 9 + simTime * 0.37) * 0.11;
        const angular = Math.min(MAX_ANGULAR, (swirl / (r + SOFTEN)) * own * shear);
        a += (angular + (swirlT * CURL) / Math.max(0.2, r)) * pace * dt;

        /**
         * Two whole-numbered lobe fields, mixed. Each is periodic on its own,
         * so every mixture is periodic too and there is no radius along which
         * the field tears.
         */
        const lobe3 = Math.sin(3 * a - roll3 * 6.283);
        const lobe5 = Math.sin(5 * a - roll5 * 6.283);
        const lobes = lobe3 * (1 - blend) + lobe5 * blend;

        // Zero at the centre and at the rim, so nothing collapses or escapes.
        const shape = r * (1 - Math.min(1, r));
        let vr = radial * lobes * shape + bias;

        // Containment, and the reason the middle stays empty.
        if (r < R_FLOOR) vr += (R_FLOOR - r) * 1.6;
        if (r > 1) vr -= (r - 1) * 2.2;

        // A little incoherence, or the field reads as a diagram of field lines.
        vr += Math.sin(a * 7 + r * 11 + simTime * 0.6 + i * 0.37) * 0.012;

        r += (vr + swirlR * CURL) * pace * dt;
        if (r < 0.02) r = 0.02;

        plife[i] -= dt;
        if (plife[i] <= 0) {
          respawn(i, false, simTime);
          r = pr[i];
          a = pa[i];
        }

        pr[i] = r;
        pa[i] = a;

        /**
         * Most particles are barely there. A few thousand equally bright dots
         * is fog; the field only has structure if a minority carries it.
         */
        const tide = 0.5 + 0.5 * Math.sin(simTime * 0.11 + pweight[i] * 19.7);
        const rank = pweight[i] * 0.7 + tide * 0.3;
        const cut = 1 - Math.min(0.9, lit);

        /**
         * Three kinds of stream, not one kind at a hundred brightnesses.
         *
         * Every particle used to be the same narrow mark at a different
         * opacity, so four thousand of them read as four thousand separately
         * legible fibres — a hank of hair rather than a fluid. They are
         * banded now, and the bands differ in width and softness as well as in
         * brightness, which is the part that matters: a wide faint mark and a
         * narrow bright one do not look like the same brush at two settings.
         *
         *   dust    the majority, barely there, a few pixels
         *   body    wide and soft, the mass the eye reads as flow
         *   energy  narrow and bright, the filaments running through it
         */
        const bodyCut = cut * 0.62;
        let standing: number;
        let widthBase: number;
        let widthGain: number;
        let alphaScale: number;
        if (rank <= bodyCut) {
          standing = 0.30 * (rank / Math.max(0.001, bodyCut));
          // Dust is what fringes the outside of the field, and the fringe was
          // the dirtiest part of it — faint, wide-radius, and sitting exactly
          // in the range where colour is rounding. Quieter.
          // Deeper than before. With the palette narrowed to blue and cyan the
          // hierarchy has to be carried by brightness instead of by hue, which
          // means the quiet majority has to actually be quiet.
          /*
           * 細くした。**筋にするため。**
           *
           * 参考にした像は髪のような細い筋の束で、こちらは丸い点だった。
           * 点を筋にする一番安い方法は、**点を細くする**こと — 一本ずつ線を
           * 引くと4200本ぶんの変換が要るが、これは幅の数字を変えるだけで済む。
           *
           * 尾も伸ばしてみたが（0.85→1.30）、**筋になるどころか全部つながって
           * 一枚の光になった。**像の筋は一本ずつ分かれているので逆方向。
           * 四千個が狭い環に居る以上、跡が長いほど重なる。0.85 から 1.00 まで
           * だけ。
           */
          widthBase = 1.1;
          widthGain = 1.0;
          alphaScale = 0.20;
        } else if (rank <= cut) {
          const t = (rank - bodyCut) / Math.max(0.001, cut - bodyCut);
          standing = 0.30 + 0.34 * t;
          // Visible, but not this wide: at 11–21 the body spread the field
          // into a thick tube. The band's radial extent is the flow's, and the
          // dots should not be adding to it.
          widthBase = 5.2;
          widthGain = 5.6;
          alphaScale = 0.58;
        } else {
          standing = 0.64 + 0.36 * Math.min(1, (rank - cut) / Math.max(0.08, 1 - cut));
          // Slightly wider and slightly quieter than it was, so the filaments
          // sit inside the body rather than reading as separate bright dashes
          // laid over it.
          // And the few that carry the energy have to be unmistakably brighter
          // than everything around them.
          widthBase = 3.0;
          widthGain = 5.0;
          alphaScale = 1.0;
        }

        /**
         * A packet of brightness travelling through the stream.
         *
         * The trail is a record of where a particle has been, so varying how
         * brightly it draws over time writes bright stretches into that
         * record: energy visibly running along a line rather than a line that
         * happens to be coloured. The period is around a trail length, so each
         * stream carries one or two packets at a time rather than shimmering.
         */
        const beat = simTime * (0.42 + pweight[i] * 0.5) + pweight[i] * 41.3;
        // Shallower than it was: at 0.18 and a steep curve the field split into
        // bright knots on black, with nothing in between carrying colour.
        const packet = 0.36 + 0.64 * Math.pow(0.5 + 0.5 * Math.sin(beat), 1.7);
        const shine = standing * packet;

        // Fades in and out over its life, so nothing pops when it respawns.
        const age = plife[i] / pspan[i];
        const ends = Math.min(1, Math.min(age, 1 - age) * 8);

        const x = cx + Math.cos(a) * r * scale;
        const y = cy + Math.sin(a) * r * scale;

        /**
         * Colour belongs to the place, not to the particle.
         *
         * Giving each particle its own hue put cyan next to violet next to
         * blue everywhere, and adding those together is grey — which is
         * exactly what the field looked like, coloured streaks over a muddy
         * base. Deriving it from angle and radius means neighbours share a
         * hue, so density deepens the colour instead of cancelling it, and
         * the regions drift slowly rather than being fixed to the screen. The
         * per-particle part is left as a nudge of one step, enough that the
         * boundaries between regions are ragged rather than drawn.
         */
        const inward = Math.min(1, Math.max(0, 1 - r));
        /**
         * Periodic by construction, not by wrapping.
         *
         * The angle accumulates without bound, so any attempt to fold it into
         * a range has a point where it jumps — and because the angular term is
         * only part of the sum, that jump is not a whole period and does not
         * cancel. Folding it did not help; the seam stayed, a hard line across
         * the field at θ=0. A cosine of the angle has no such point: it is
         * smooth everywhere and repeats exactly, so there is nowhere for an
         * edge to be.
         */
        // Weighted so the violet end is actually reached: at 0.55/0.45 it
        // needed the angle and the radius to peak together, which is rare, and
        // a palette described as running to violet had no violet in it.
        // Biased so the violet end occupies a real share of the field rather
        // than only the corner where angle and radius peak together.
        /**
         * Energy decides the colour as much as position does.
         *
         * Index 0 is ice cyan and the last is blue-violet, and `shine` pulls
         * toward the cold end — so a quiet trail is deep blue running to
         * violet, and only where a packet is passing does it rise to cyan.
         * That is the same thing as saying the light in this field is cyan and
         * everything else is the medium it moves through, which is what makes
         * a moving packet read as energy rather than as a brighter line.
         */
        /**
         * 熱いのは**中心と、強く光っている粒**。
         *
         * これまでは逆だった — エネルギーの高い粒を冷たいシアンに置き、
         * 中心ほど紫に寄せていた。「この場の光はシアンで、他はそれが通る
         * 媒質」という筋は通っていたが、**中心が冷たい**ので、見た目は
         * どこも同じ青になる。
         *
         * `around` は角度のゆっくりした回りで、色が半径だけで決まらないよう
         * にしている。これが無いと同心円になって、動いていても止まって見える。
         */
        /**
         * 熱は**場所に付く**。粒ごとではない。
         *
         * 最初は粒の明滅（`shine`）で色を決めた。結果は青地に紫紅の点が散る
         * だけで、**塊にならない**ので動いて見えない。色が粒の乱数に乗って
         * いるあいだは、どれだけ幅を広げても斑点にしかならない。
         *
         * いまは角度と半径の滑らかな波で決める。隣り合う粒は同じ熱を持つので
         * 熱い部分が**塊として現れ、回っていく。**粒の明滅は、その上に乗る
         * 細かい揺らぎとして残す。
         *
         * **間隔を揃えない。**
         *
         * ここは順に、山2つ → 5つ → 9つ と増やしてきた。数が増えて散りは
         * したが、単一の `sin` は周期がひとつしか無いので**山が等間隔に
         * 並ぶ** — 散らばりではなく、目盛りになる。
         *
         * なので周期の違う波を三つ足す。7・11・4 は互いに割り切れないので、
         * 合成の山は**一周のあいだ不規則な位置に落ちる。**進む速さも向きも
         * 別々にしてあるので、間隔の並びは時間とともに組み替わる。
         *
         * 半径の項（`5.5` / `3.1` / `7.9`）が内側と外側で山をずらすので、
         * 環を横切る帯にはならない。
         *
         * 掛ける側（`a * 3` の方）の谷は浅く取る。**深いと5つの山のうち
         * 2〜3個しか立たない** — 数を5にしても、12区間のうち2つが63%を
         * 占めていた。偏りの原因は山の数ではなく、山を潰す側の深さだった。
         */
        /*
         * 持ち歩いている印が主。場の波は、その上に薄くかける揺らぎ。
         *
         * 全部を持ち歩きにすると、粒が生きているあいだ色が変わらないので
         * 硬く見える。全部を場にすると、模様が止まって同じ場所が同じ色に
         * なる。**運ばれる分と、その場で移ろう分を混ぜる。**
         */
        const drift = Math.sin(a * 3 + simTime * 0.26 + r * 2.4);
        const wave = Math.min(1, Math.max(0, pheat[i] * 0.82 + (0.5 + 0.5 * drift) * 0.18));
        const energy = Math.min(1, shine * 1.7);
        /*
         * 波を強く取る。
         *
         * 最初の配分（波 0.52）では環の上で熱が 0.66 までしか上がらず、
         * **12段のうち紫止まりで、紫紅の2段に一度も届いていなかった。**
         * 幅を広げたのに端が使われていないなら、広げていないのと同じ。
         */
        const heat = Math.min(1, Math.max(0, wave * 0.70 + energy * 0.26 + inward * 0.16 - 0.04));
        const warmth = 1 - heat;
        let tint = Math.min(TINTS - 1, Math.floor(warmth * (TINTS - 1)) + (ptint[i] & 1));
        const sprite = sprites[tint];
        if (!sprite) continue;

        /**
         * Wide and faint rather than narrow and solid.
         *
         * At three pixels the trails came out as distinct threads and the
         * field read as wire wool — every path separately legible, which is
         * the same failure as the ribbon versions in a different form. A dot
         * several times wider, at a fraction of the opacity, overlaps its
         * neighbours instead of sitting beside them, and the structure comes
         * from where they pile up.
         */
        /**
         * Held below the point where the blue channel clips.
         *
         * Additive blending saturates one channel at a time, and with a
         * blue-heavy palette blue goes first — after which every further dot
         * only raises red and green, so the densest parts drift toward white
         * while the thin parts stay blue.
         *
         * Measured rather than guessed: at 0.08 the brightest pixel in the
         * field read (49, 255, 255), with two channels pinned. This is set so
         * the peak stays clear of the ceiling. Sampling the canvas is the only
         * way to know — clipping looks like a colour choice, not like a bug.
         */
        /**
         * Raised hard, on a measurement that corrected an earlier one.
         *
         * getImageData returns unpremultiplied colour, so reading R,G,B from
         * it says nothing about how bright a pixel looks — the visible value
         * is colour times alpha. Measured properly the field averaged 22 out
         * of 255 with not one pixel clipped in any channel, which is not a
         * balance between brightness and clipping. It was simply dark, and the
         * headroom had been there all along.
         *
         * And the settled field is dimmer than the early one, not brighter:
         * the particles spread as they run, so the same light covers about
         * 1.7x the area after half a minute. 71 average at 300 steps, 29 at
         * 1800. The number that matters is the settled one, since that is what
         * a screen left open shows, so this is set against that.
         */
        /**
         * Opacity is the whole brightness control now.
         *
         * Compositing normally means a pixel can never exceed the colour that
         * was drawn into it, so density arrives as coverage rather than as
         * sum. Held low, that reads as a dark smear; the field has to be drawn
         * close to opaque where it is dense for the colour to be visible at
         * all.
         */
        /**
         * 奥行きで、大きさと明るさを分ける。
         *
         * 遠近感は**片方だけでは出ない。**大きさだけ変えると大小の粒が混ざって
         * いるようにしか見えず、明るさだけ変えると濃淡のむらに見える。二つが
         * 一緒に動いて初めて「手前」「奥」になる。
         *
         * 幅は狭く取ってある（0.78〜1.22）。輪は面に対してほぼ正対していて、
         * **奥行きは輪の太さぶんしかない。**そこに強い遠近を付けると、平らな
         * 輪ではなく球に見えてしまう。
         */
        const near = 0.5 + 0.5 * pz[i];
        /*
         * 幅を広げた。0.78〜1.22 では**差が読み取れなかった** — 柔らかい点が
         * 四千個ある中で、二割の大小は見分けが付かない。
         */
        const depthSize = 0.62 + 0.76 * near;
        /*
         * 平均が 1.0 になるように取る。**奥を暗くするのではなく、手前を
         * 明るくする。**0.62〜1.00 にしたときは全体が二割暗くなり、下限を
         * 割った粒が消えて場が痩せた — 奥行きを付けるために明るさを
         * 差し出したことになる。
         */
        const depthLight = 0.70 + 0.60 * near;
        const alpha = Math.min(0.95, 1.95 * alphaScale * shine * ends * shown.brightness * depthLight);
        /**
         * Below this a dot changes nothing that survives the fade, and there
         * are thousands of them. This is the only lever left that cuts draw
         * calls without touching the particle count or the buffer, both of
         * which are fixed — and it is a balance, not a free win: at 0.014 the
         * field thinned into fragments, at 0.005 it cost 2.35ms a step. Here
         * with the opacity above raised to match, so what survives the cut is
         * brighter rather than there being more of it.
         */
        // Raised to hold the cost: lifting the quiet majority pushed a lot
        // more particles over the old floor and a step went from 2.3ms to
        // 3.7ms. These are the ones that leave nothing behind.
        // Raised from 0.085. Below about a ninth, a dot contributes nothing
        // a person can see and a neutral edge they can.
        if (alpha < 0.11) continue;
        /**
         * Size follows brightness steeply, which is a cost decision as much as
         * a visual one: drawing every particle instead of only the lit ones
         * took a step from 0.55ms to 2.0ms, and almost all of that was fill
         * area on dots nobody can see. A faint particle needs to be present,
         * not large.
         */
        /**
         * Small — a dot only has to be wider than the gap it leaves.
         *
         * These were widened to make neighbouring trails merge, and that was
         * the wrong lever: a particle covers a little over a pixel per step,
         * so anything past a few pixels does not join the trail up any better,
         * it just makes each dot individually visible. At twenty-five the
         * field was a row of capsules. Lateral continuity comes from there
         * being four thousand of them, not from each being large.
         */
        const w = (widthBase + shine * widthGain) * depthSize;

        bctx.globalAlpha = alpha;
        /**
         * 奥はぼかす。**これが一番強く効く。**
         *
         * 大きさと明るさだけでは差が読めなかった。写真で奥行きを作っている
         * のはピントの差で、**奥の輪郭が緩い**ことがそのまま距離になる。
         *
         * 手前は 6px の芯を持つ絵、奥は 18px の緩い絵を同じ大きさに縮めて
         * 描く。縮めると 18px の方は輪郭が残らないので、**同じ大きさでも
         * 滲んで見える。**
         */
        const art = near > 0.45 && w <= SMALL_MAX ? (smalls[tint] ?? sprite) : sprite;
        bctx.drawImage(art, x - w / 2, y - w / 2, w, w);

        /**
         * A highlight only where a packet is at its peak on a leading stream.
         * Small, local, and carried along by the flow rather than placed.
         */
        if (shine > 0.55) {
          const hs = highlights[tint];
          if (hs) {
            const hw = w * 0.5;
            bctx.globalAlpha = Math.min(0.9, alpha * (shine - 0.55) / 0.45);
            bctx.drawImage(hs, x - hw / 2, y - hw / 2, hw, hw);
          }
        }

        /**
         * **重なりが白になる層。**加算で描くのはここだけ。
         *
         * 場全体を加算にしたことが一度あって、色相が壊れた — 青が先に振り切れ、
         * そこから先は緑だけが上がるので、シアンの領域が 197° から 180° の
         * 緑シアンへ歩く（実測で最大の山が180°、31.8%）。**足し算そのものが
         * 悪いのではなく、足すものに色相があるのが悪い。**
         *
         * なので加算するのは**白くなるべきもの**だけにする。淡い桃を薄く、
         * いちばん熱くていちばん光っている粒にだけ重ねる。重なれば白へ寄り、
         * 重ならなければ何も起きない。**壊れる色相を持っていないので、
         * 振り切れても白になるだけ。**
         *
         * 像の中心が白いのは、白い粒があるからではなく、**熱い粒が重なって
         * いるから。**この層はその重なりを作っている。
         */
        const bloom = heat * shine;
        /*
         * 閾値は、波の谷を浅くしたときに上げ直した。
         *
         * 谷を浅くすると**高い値に届く粒が増える**ので、同じ閾値のままだと
         * 総量が倍になる（白い芯が 3.9% から 8.7% へ跳ね、粒立ちが消えて
         * 筋になった）。散らばりと明るさは別々に決める。
         */
        if (bloom > 0.22 && bloomArt) {
          /*
           * 粒より少しだけ大きい。大きくすると玉になって、**細かさが消える。**
           * 1.9 倍にしたときは熾火が並んでいるように見えた。
           */
          const bw = w * 1.15;
          bctx.globalCompositeOperation = 'lighter';
          /*
           * 早く始めて、ゆっくり上げて、低いところで止める。
           *
           * 前は 0.30 から 2.1 の勾配で 0.58 まで上げていた。`shine` は脈を
           * 打っているので、**閾値をまたぐ瞬間に一気に点く** — 白が出ている
           * ときと出ていないときの差が、そこで目に付いていた。
           *
           * 始まりを下げると、点くのではなく**滲み出す。**勾配を寝かせると、
           * 脈のぶんの上下が小さくなる。頂点を下げたのは、単に白が多かった
           * から。
           */
          /*
           * **この層は尾に積み上がる。**いまは割り引いていない。
           *
           * 尾は毎フレーム `keep`（およそ 0.983）倍に薄まるので、同じ量を
           * 足し続けると `a / (1 - keep)` —— 六十倍に落ち着く。どれだけ
           * 小さく足しても上限へ達する。名前を中央に描いていたときは同じ
           * 割引を入れてあったのに、**層ごとに別々に気づいて規則にして
           * いなかった。**
           *
           * ここを割り引くと場が目に見えて暗くなる。この輪の明るさは調整済み
           * なので、**いま入れると調整結果の方が壊れる。**明るさを取り直す
           * ときに、`1 - exp(-dt / trail)` を掛けたうえで係数を測り直す。
           */
          bctx.globalAlpha = Math.min(0.24, (bloom - 0.22) * 0.85) * shown.brightness;
          bctx.drawImage(bloomArt, x - bw / 2, y - bw / 2, bw, bw);

          /*
           * いちばん上だけ、尖らせる。
           *
           * 滲みの上に硬い芯が乗ることで点になる。**滲みだけでは玉、芯だけ
           * では点が浮く。**両方要る。
           *
           * 閾値は滲みよりだいぶ高い。**きらめきは、そこら中にあると
           * きらめきではない。**
           */
          /*
           * きらめきは**手前だけ。**奥の粒が鋭く光ると、大きさと明るさで
           * 付けた奥行きがその一点で壊れる。遠くのものは滲む。
           */
          if (bloom > 0.54 && near > 0.55 && sparkArt) {
            const sw = 3.8;
            bctx.globalAlpha = Math.min(0.82, (bloom - 0.54) * 3.4) * shown.brightness;
            bctx.drawImage(sparkArt, x - sw / 2, y - sw / 2, sw, sw);
          }
          bctx.globalCompositeOperation = 'source-over';
        }
      }

      bctx.globalAlpha = 1;

      /**
       * Fade by scaling the whole pixel, colour included.
       *
       * This was destination-out, chosen because painting low-alpha black
       * never quite reaches zero. It does subtract alpha and it does reach
       * zero — and it leaves the colour untouched, which is worse.
       *
       * The buffer stores premultiplied pixels and additive drawing clamps
       * alpha at 1. Once a busy region is fully opaque, alpha can no longer
       * rise, so the fade has nothing left to take away, while every further
       * dot keeps adding to the colour. The result does not settle: measured
       * over one run, two-channel clipping went 0.3% at 240 steps, 17.6% at
       * 840, 60.9% at 2040, with 55,845 pixels blown fully white and a fifth
       * of the field turned red. Which is exactly what a screen that has been
       * open for a few minutes looks like, and why a short measurement said
       * the colours were clean.
       *
       * Redrawing the buffer through itself at a fraction of opacity scales
       * the premultiplied colour as well as the alpha, so every pixel decays
       * geometrically and the field reaches a steady state.
       */
      const keep = Math.exp(-dt / Math.max(0.2, shown.trail));
      // The band the fade cannot leave, recomputed from the fade that is
      // actually being applied. See `cull`.
      cullFloor = Math.min(CULL_CAP, Math.ceil(0.5 / Math.max(1e-4, 1 - keep)));
      sctx.globalCompositeOperation = 'copy';
      sctx.globalAlpha = 1;
      sctx.drawImage(buf, 0, 0);
      bctx.globalCompositeOperation = 'copy';
      bctx.globalAlpha = keep;
      bctx.drawImage(scratch, 0, 0);
      bctx.globalAlpha = 1;
    };

    /**
     * Sweeps out what the fade cannot reach.
     *
     * The fade is a multiply — the buffer redrawn through itself at `keep`,
     * around 0.98 at sixty frames a second — and a multiply on eight-bit
     * values has a fixed point. `round(v · keep) === v` for every v up to
     * `0.5 / (1 - keep)`, about 24 of 255, so anything that decays into that
     * band stays there forever. Measured on the running field: 48,722 pixels
     * held values that were byte-for-byte identical four seconds apart, not
     * one of them dimmer. Every place a particle has ever been keeps a faint
     * mark, and over minutes those marks accumulate into the grey ghost of a
     * field standing behind the live one.
     *
     * No multiplicative fade can fix this. Reaching a floor below 1 needs to
     * lose a third of the brightness per step, which is a visible flicker. So
     * the floor is cleared outright, which is a read back from the GPU — 2.8ms
     * for the whole buffer, with a tail past 40ms, far too spiky for a surface
     * that is always on screen.
     *
     * A band at a time instead: 0.1ms typical, 0.8ms at the ninetieth
     * percentile, and the whole buffer swept every seventeen frames. A mark
     * therefore survives at most a third of a second past the point where it
     * stopped fading, which is shorter than the trails themselves.
     */
    const CULL_BAND = 32;
    /**
     * Where the floor is, which is not a constant.
     *
     * `round(v · keep) === v` holds for every v up to `0.5 / (1 - keep)`, and
     * `keep` moves with the frame time and the mood's trail length: 25 of 255
     * at keep 0.98, 50 at 0.99. A fixed threshold was tried at 24 and removed
     * exactly nothing — one short of the fixed point is the same as no cull at
     * all. Measured over 900 simulated frames: at the computed floor, 30,976
     * stuck pixels go to zero; at 24, all 30,976 remain.
     *
     * Capped because the relation runs away as keep approaches 1. A very long
     * trail on a fast display would put the fixed point above anything the
     * field actually draws, and clearing that would be clearing the picture.
     * Past the cap some residue survives, which is the right way round: a
     * faint ghost is a smaller fault than a truncated field.
     */
    const CULL_CAP = 36;
    let cullFloor = 0;
    let cullY = 0;
    const cull = () => {
      if (cullFloor <= 0) return;
      const CULL_FLOOR = cullFloor * 255;
      const height = Math.min(CULL_BAND, bufSize - cullY);
      const image = bctx.getImageData(0, cullY, bufSize, height);
      const px = image.data;
      let touched = false;
      for (let i = 0; i < px.length; i += 4) {
        const a = px[i + 3];
        if (a === 0) continue;
        const mx = px[i] > px[i + 1] ? (px[i] > px[i + 2] ? px[i] : px[i + 2]) : (px[i + 1] > px[i + 2] ? px[i + 1] : px[i + 2]);
        if (mx * a <= CULL_FLOOR) {
          px[i] = 0;
          px[i + 1] = 0;
          px[i + 2] = 0;
          px[i + 3] = 0;
          touched = true;
        }
      }
      // Written back only when something was actually removed. `putImageData`
      // replaces the band wholesale, and a round trip through unpremultiplied
      // bytes is not exactly lossless — no reason to spend that on a band that
      // had nothing in it.
      if (touched) bctx.putImageData(image, 0, cullY);
      cullY = cullY + height >= bufSize ? 0 : cullY + height;
    };

    const present = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(buf, 0, 0, canvas.width, canvas.height);
    };

    const render = (nowMs: number) => {
      const started = performance.now();
      const target = MOOD[stateRef.current] ?? MOOD.idle;

      const dt = last === 0 ? STEP : Math.min(0.1, (nowMs - last) / 1000);
      last = nowMs;

      for (const key of Object.keys(shown) as Array<keyof Mood>) {
        shown[key] += (target[key] - shown[key]) * 0.04;
      }

      // Sprites are only rebuilt when the palette has actually moved, not on
      // every frame of an eased transition.
      if (Math.abs(shown.hue - tintHue) > 1.5 || Math.abs(shown.spread - tintSpread) > 2) {
        tintHue = shown.hue;
        tintSpread = shown.spread;
        buildSprites(tintHue, tintSpread);
      }

      /**
       * The warm-up continues here when the synchronous part ran out of time.
       * Spreading it over the first frames costs a brief thinner field rather
       * than a stall, and it needs no separate low-resolution path.
       */
      if (warmed < WARMUP_STEPS) {
        const deadline = performance.now() + 4;
        while (warmed < WARMUP_STEPS && performance.now() < deadline) {
          step(STEP);
          warmed++;
        }
      }

      /**
       * Fixed steps, however long the frame was.
       *
       * Integrating the frame's own delta looked fine at a steady 60Hz and
       * broke everywhere else: a long frame moves every particle several times
       * further in one go, so instead of a trail it leaves a row of separate
       * dots. Which is what the first version did — the trails came out as
       * dashes. A fixed step keeps the spacing between dots constant no matter
       * what the frame rate does.
       *
       * Capped at three, so a stall does not turn into a longer stall trying
       * to catch up on simulation nobody saw.
       */
      if (!reduced) {
        accrued = Math.min(accrued + dt, STEP * 3);
        while (accrued >= STEP) {
          step(STEP);
          accrued -= STEP;
        }
        // One band per frame, and only while the field is running: a paused
        // core has nothing arriving to freeze, and a still image does not need
        // sweeping.
        cull();
      }
      present();

      costMs += performance.now() - started;
      costN++;
      if (costN >= 30) {
        (window as any).__irisCore = { avgRenderMs: costMs / costN, samples: costN, particles: COUNT, bufSize };
        costMs = 0;
        costN = 0;
      }
    };

    const loop = (nowMs: number) => {
      render(nowMs);
      raf = requestAnimationFrame(loop);
    };

    /**
     * Trails need history, so a single frame is not a picture — it is a
     * scatter of dots. The field is run forward before the first paint.
     *
     * Bounded by wall time rather than by step count, because the cost of a
     * step is a property of the machine and 200 of them was a guess. Whatever
     * does not fit in the budget continues across the first frames above.
     */
    const warmDeadline = performance.now() + WARMUP_BUDGET_MS;
    while (warmed < WARMUP_STEPS && performance.now() < warmDeadline) {
      step(STEP);
      warmed++;
    }
    (window as any).__irisCoreWarmup = { stepsBeforePaint: warmed, budgetMs: WARMUP_BUDGET_MS };

    /**
     * A way to advance the field from outside, and the reason it exists.
     *
     * An accumulation buffer has no single-frame appearance: what is on screen
     * after one step is a scatter of dots, and the trails only exist because
     * frames have gone by. So it cannot be judged from a screenshot of a page
     * that is not running — which is exactly the situation in a headless or
     * backgrounded tab, where requestAnimationFrame is throttled to nothing.
     *
     * `advance(n)` runs n steps and repaints, and returns what they cost. That
     * makes both the look and the price measurable rather than assumed, which
     * is the only reason this is worth the two lines it takes.
     */
    (window as any).__irisCoreDebug = {
      advance(steps: number) {
        const started = performance.now();
        for (let i = 0; i < steps; i++) step(STEP);
        present();
        const ms = performance.now() - started;
        return { steps, totalMs: ms, msPerStep: ms / steps, particles: COUNT, bufSize };
      },
      /**
       * 粒がどこに居るかを、画面ではなく配列から読む。
       *
       * 2026-09-05、画面から測って三度読み違えた —— 色相で絞ったら文字では
       * なく環の青を拾い、明るさの指標は純青で 0.33 の下限を持っていて
       * 「これ以上暗くならない」を「暗いところが無い」と読み、`getImageData`
       * が返す乗算前の値を飽和と読んだ。**そのたびに別の場所を疑って直した。**
       *
       * 位置は配列にある。**位置は位置を見る。**
       */
      radii() {
        const B = 12;
        const bins = new Array(B).fill(0);
        let sum = 0;
        for (let i = 0; i < COUNT; i++) {
          const r = pr[i];
          sum += r;
          bins[Math.min(B - 1, Math.max(0, Math.floor((r / 1.3) * B)))]++;
        }
        return { mean: sum / COUNT, bins, pace: shown.pace, trail: shown.trail };
      },
    };

    /**
     * The animation stops while the tab is hidden. The picture does not — the
     * buffer keeps whatever it last held, so a hidden tab freezes rather than
     * emptying. The first frame is presented unconditionally: being wrong
     * about visibility should cost motion, never presence.
     */
    render(performance.now());

    const onVisibility = () => {
      cancelAnimationFrame(raf);
      last = 0;
      if (!document.hidden && !reduced) raf = requestAnimationFrame(loop);
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden && !reduced) raf = requestAnimationFrame(loop);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(raf);
    };
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      aria-hidden="true"
      className="pointer-events-none select-none"
    />
  );
}
