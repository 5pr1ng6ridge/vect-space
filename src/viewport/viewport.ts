import { useEffect, useMemo, useState, type CSSProperties } from "react";

export const DESIGN_WIDTH = 1920 as const;
export const DESIGN_HEIGHT = 1080 as const;

export interface ViewportMetrics {
  designWidth: typeof DESIGN_WIDTH;
  designHeight: typeof DESIGN_HEIGHT;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface DesignPoint {
  x: number;
  y: number;
}

export function calculateViewportMetrics(
  windowWidth: number,
  windowHeight: number,
): ViewportMetrics {
  const scale = Math.min(
    windowWidth / DESIGN_WIDTH,
    windowHeight / DESIGN_HEIGHT,
  );
  return {
    designWidth: DESIGN_WIDTH,
    designHeight: DESIGN_HEIGHT,
    scale,
    offsetX: (windowWidth - DESIGN_WIDTH * scale) / 2,
    offsetY: (windowHeight - DESIGN_HEIGHT * scale) / 2,
  };
}

export function screenToDesign(
  clientX: number,
  clientY: number,
  metrics: ViewportMetrics,
): DesignPoint {
  return {
    x: (clientX - metrics.offsetX) / metrics.scale,
    y: (clientY - metrics.offsetY) / metrics.scale,
  };
}

export function useViewportMetrics(): {
  metrics: ViewportMetrics;
  style: CSSProperties;
} {
  const [metrics, setMetrics] = useState(() =>
    calculateViewportMetrics(window.innerWidth, window.innerHeight),
  );

  useEffect(() => {
    const update = (): void => {
      setMetrics(
        calculateViewportMetrics(window.innerWidth, window.innerHeight),
      );
    };
    window.addEventListener("resize", update, { passive: true });
    update();
    return () => window.removeEventListener("resize", update);
  }, []);

  const style = useMemo<CSSProperties>(
    () => ({
      width: DESIGN_WIDTH,
      height: DESIGN_HEIGHT,
      transform: `translate(${metrics.offsetX}px, ${metrics.offsetY}px) scale(${metrics.scale})`,
      transformOrigin: "0 0",
    }),
    [metrics],
  );

  return { metrics, style };
}
