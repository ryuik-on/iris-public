import { useEffect, useRef, useState } from 'react';
import { createCoreFlow } from './coreFlow';

export type CoreState =
  | 'idle' | 'listening' | 'thinking' | 'tool_execution'
  | 'approval_required' | 'speaking' | 'offline';

const ART = '/iris-matteo-core.png';

export function NebulaCore({ state, activity = 0, size = 640 }: {
  state: CoreState; activity?: number; size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const input = useRef({ state, activity });
  input.current = { state, activity };
  const redraw = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => { redraw.current?.(); }, [state, activity]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    setReady(false);
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const image = new Image();
    let renderer: ReturnType<typeof createCoreFlow> = null;
    let stopped = false;
    let lost = false;
    let frame = 0;
    let last = 0;
    let elapsed = 0;
    let gain = 1;
    let energy = 0;

    const draw = (now: number) => {
      frame = 0;
      if (stopped || lost || !renderer || document.hidden) return;
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      const current = input.current;
      const active = ['thinking', 'tool_execution'].includes(current.state);
      const level = Math.max(0, Math.min(1, current.activity || 0));
      const target = active ? 0.7 : current.state === 'listening' ? 0.3 + level * 0.3 : 0.1;
      const blend = motion.matches ? 1 : 1 - Math.exp(-dt * 2);
      energy += (target - energy) * blend;
      if (!motion.matches) elapsed += dt * (1 + energy * 0.35);
      const speech = current.state === 'speaking' && !motion.matches
        ? 0.035 * Math.sin(elapsed * 2.2) : 0;
      const light = current.state === 'offline' ? 0.65 : 1 + energy * 0.05 + speech;
      gain += (light - gain) * blend;
      renderer.draw(motion.matches ? 0 : elapsed, energy, gain,
        document.documentElement.dataset.theme === 'mist' ? 1 : 0);
      if (!motion.matches) frame = requestAnimationFrame(draw);
    };
    const resume = () => {
      cancelAnimationFrame(frame);
      last = 0;
      if (!stopped && !lost && !document.hidden) frame = requestAnimationFrame(draw);
    };
    const initialize = () => {
      if (stopped) return;
      renderer?.dispose();
      renderer = createCoreFlow(canvas, image);
      setReady(Boolean(renderer));
      resume();
    };
    const onLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      cancelAnimationFrame(frame);
      setReady(false);
    };
    const onRestored = () => { lost = false; initialize(); };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    document.addEventListener('visibilitychange', resume);
    motion.addEventListener('change', resume);
    window.addEventListener('iris-theme-change', resume);
    redraw.current = () => { if (motion.matches) resume(); };
    image.onload = initialize;
    image.src = ART;
    return () => {
      stopped = true;
      image.onload = null;
      cancelAnimationFrame(frame);
      renderer?.dispose();
      redraw.current = null;
      document.removeEventListener('visibilitychange', resume);
      motion.removeEventListener('change', resume);
      window.removeEventListener('iris-theme-change', resume);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    };
  }, [size]);

  return <div aria-hidden="true" className="iris-nebula" style={{ width: size, height: size }}>
    {!ready && <img className="iris-core-fallback" src={ART} alt="" />}
    <canvas ref={canvasRef} style={{ opacity: ready ? 1 : 0 }} />
  </div>;
}
