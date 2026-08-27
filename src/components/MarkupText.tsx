import katex from "katex";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactElement,
} from "react";

import {
  formulaRevealDurationMs,
  parseMarkup,
  visibleUnits,
  type MathUnit,
} from "../engine/markup";

interface MarkupTextProps {
  source: string;
  visibleCount?: number;
  className?: string;
  animateMath?: boolean;
  instantMathReveal?: boolean;
  unitCps?: readonly number[];
  onMathMetrics?(unitIndex: number, widthPx: number, fontSizePx: number): void;
}

export function MarkupText({
  source,
  visibleCount = Number.POSITIVE_INFINITY,
  className,
  animateMath = false,
  instantMathReveal = false,
  unitCps = [],
  onMathMetrics,
}: MarkupTextProps): ReactElement {
  const units = useMemo(() => visibleUnits(parseMarkup(source)), [source]);
  return (
    <span className={className} aria-label={source}>
      {units.map((unit, index) => {
        const visible = index < visibleCount;
        const style = {
          visibility: visible ? "visible" : "hidden",
          "--unit-index": index,
        } as CSSProperties;
        const effectClass =
          unit.effect === null ? "" : ` text-fx-${unit.effect}`;
        if (unit.kind === "math") {
          return (
            <MathMarkupUnit
              animate={animateMath}
              cps={unitCps[index] ?? 30}
              effectClass={effectClass}
              index={index}
              instant={instantMathReveal}
              key={`${index}-math-${unit.latex}`}
              onMetrics={onMathMetrics}
              style={style}
              unit={unit}
              visible={visible}
            />
          );
        }
        return (
          <span
            aria-hidden="true"
            className={`markup-unit character-unit${effectClass}`}
            key={`${index}-${unit.value}`}
            style={style}
          >
            {unit.value}
          </span>
        );
      })}
    </span>
  );
}

function MathMarkupUnit({
  animate,
  cps,
  effectClass,
  index,
  instant,
  onMetrics,
  style,
  unit,
  visible,
}: {
  animate: boolean;
  cps: number;
  effectClass: string;
  index: number;
  instant: boolean;
  onMetrics:
    | ((unitIndex: number, widthPx: number, fontSizePx: number) => void)
    | undefined;
  style: CSSProperties;
  unit: MathUnit;
  visible: boolean;
}): ReactElement {
  const contentRef = useRef<HTMLSpanElement>(null);
  const html = useMemo(
    () =>
      katex.renderToString(unit.latex, {
        displayMode: unit.display,
        throwOnError: false,
        strict: "ignore",
        trust: false,
        output: "html",
      }),
    [unit.display, unit.latex],
  );

  useLayoutEffect(() => {
    if (!animate) return;
    const content = contentRef.current;
    const katexElement = content?.querySelector<HTMLElement>(".katex");
    if (
      content === null ||
      katexElement === null ||
      katexElement === undefined
    ) {
      return;
    }
    const measure = (): void => {
      const fontSize = Number.parseFloat(
        getComputedStyle(katexElement).fontSize,
      );
      const width = katexElement.offsetWidth;
      const duration = formulaRevealDurationMs(width, fontSize, cps);
      content.style.setProperty("--math-reveal-duration", `${duration}ms`);
      onMetrics?.(index, width, fontSize);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(katexElement);
    return () => observer.disconnect();
  }, [animate, cps, html, index, onMetrics]);

  return (
    <span
      aria-hidden="true"
      className={`markup-unit math-unit${unit.display ? " display-math" : ""}${effectClass}${animate && visible ? " is-math-revealed" : ""}${instant ? " is-math-instant" : ""}`}
      style={style}
    >
      <span
        className="math-reveal-content"
        dangerouslySetInnerHTML={{ __html: html }}
        ref={contentRef}
      />
    </span>
  );
}
