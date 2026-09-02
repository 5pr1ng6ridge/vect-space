import katex from "katex";
import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";

import {
  formulaRevealDurationMs,
  parseMarkup,
  visibleUnits,
  type MathUnit,
} from "../engine/markup";
import type { TextRevealAnimation } from "../engine/types";
import { resolveVisualLineGroups } from "./visualLineGroups";

interface MarkupTextProps {
  source: string;
  visibleCount?: number;
  className?: string;
  animateMath?: boolean;
  instantMathReveal?: boolean;
  unitCps?: readonly number[];
  onMathMetrics?(unitIndex: number, widthPx: number, fontSizePx: number): void;
  revealAnimation?: TextRevealAnimation;
  fontReady?: boolean;
}

export const MarkupText = memo(function MarkupText({
  source,
  visibleCount = Number.POSITIVE_INFINITY,
  className,
  animateMath = false,
  instantMathReveal = false,
  unitCps = [],
  onMathMetrics,
  revealAnimation = "typewriter",
  fontReady = true,
}: MarkupTextProps): ReactElement {
  const units = useMemo(() => visibleUnits(parseMarkup(source)), [source]);
  const lineSweep =
    revealAnimation === "line_sweep" &&
    visibleCount !== Number.POSITIVE_INFINITY &&
    fontReady;
  const unitElementsRef = useRef(new Map<number, HTMLElement>());
  const [lineGroups, setLineGroups] = useState<{
    source: string;
    groups: readonly (readonly number[])[];
  } | null>(null);

  useLayoutEffect(() => {
    let frame = 0;
    if (!lineSweep) {
      frame = requestAnimationFrame(() => setLineGroups(null));
      return () => cancelAnimationFrame(frame);
    }
    frame = requestAnimationFrame(() => {
      const groups = resolveVisualLineGroups(units, unitElementsRef.current);
      const measuredUnitCount = groups.reduce(
        (total, group) => total + group.length,
        0,
      );
      if (groups.length === 0 || measuredUnitCount !== units.length) return;
      setLineGroups((current) =>
        current?.source === source && sameLineGroups(current.groups, groups)
          ? current
          : { source, groups },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [fontReady, lineSweep, source, units]);

  const renderUnit = (
    unit: (typeof units)[number],
    index: number,
    visible: boolean,
    suppressReveal: boolean,
  ): ReactElement => {
    const style = {
      visibility: visible ? "visible" : "hidden",
      "--unit-index": index,
    } as CSSProperties;
    const revealClass =
      !suppressReveal && visible && visibleCount !== Number.POSITIVE_INFINITY
        ? ` is-reveal-${revealAnimation}`
        : "";
    const effectClass = unit.effect === null ? "" : ` text-fx-${unit.effect}`;
    const registerElement = (element: HTMLElement | null): void => {
      if (element === null) unitElementsRef.current.delete(index);
      else unitElementsRef.current.set(index, element);
    };
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
          registerElement={registerElement}
          revealActive={
            !suppressReveal &&
            visible &&
            visibleCount !== Number.POSITIVE_INFINITY
          }
          style={style}
          unit={unit}
          visible={visible}
          revealAnimation={revealAnimation}
          fontReady={fontReady}
        />
      );
    }
    return (
      <span
        aria-hidden="true"
        className={`markup-unit character-unit${effectClass}${revealClass}`}
        key={`${index}-${unit.value}`}
        ref={registerElement}
        style={style}
      >
        <span className="markup-reveal-content">{unit.value}</span>
      </span>
    );
  };

  const activeLineGroups =
    lineGroups?.source === source ? lineGroups.groups : null;
  const groupedUnitCount =
    activeLineGroups?.reduce((total, group) => total + group.length, 0) ?? 0;
  const groupedLineSweep =
    lineSweep && activeLineGroups !== null && groupedUnitCount === units.length;
  return (
    <span className={className} aria-label={source}>
      {groupedLineSweep
        ? activeLineGroups.map((indices, lineIndex) => {
            const finalUnit = indices[indices.length - 1] ?? -1;
            const visible = finalUnit < visibleCount;
            return (
              <span
                className={`markup-line-sweep${visible ? " is-visible" : ""}`}
                key={`line-${lineIndex}-${indices[0] ?? 0}`}
                style={{ visibility: visible ? "visible" : "hidden" }}
              >
                {indices.map((index) => {
                  const unit = units[index];
                  return unit === undefined
                    ? null
                    : renderUnit(unit, index, visible, true);
                })}
              </span>
            );
          })
        : units.map((unit, index) =>
            renderUnit(unit, index, index < visibleCount, false),
          )}
    </span>
  );
});

function MathMarkupUnit({
  animate,
  cps,
  effectClass,
  index,
  instant,
  onMetrics,
  registerElement,
  revealActive,
  style,
  unit,
  visible,
  revealAnimation,
  fontReady,
}: {
  animate: boolean;
  cps: number;
  effectClass: string;
  index: number;
  instant: boolean;
  onMetrics:
    | ((unitIndex: number, widthPx: number, fontSizePx: number) => void)
    | undefined;
  registerElement(element: HTMLSpanElement | null): void;
  revealActive: boolean;
  style: CSSProperties;
  unit: MathUnit;
  visible: boolean;
  revealAnimation: TextRevealAnimation;
  fontReady: boolean;
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
    if (!animate || !fontReady) return;
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
  }, [animate, cps, fontReady, html, index, onMetrics]);

  return (
    <span
      aria-hidden="true"
      className={`markup-unit math-unit${unit.display ? " display-math" : ""}${effectClass}${animate && visible ? " is-math-revealed" : ""}${revealActive ? ` is-reveal-${revealAnimation}` : ""}${instant ? " is-math-instant" : ""}`}
      ref={registerElement}
      style={style}
    >
      <span
        className="math-reveal-content markup-reveal-content"
        dangerouslySetInnerHTML={{ __html: html }}
        ref={contentRef}
      />
    </span>
  );
}

function sameLineGroups(
  left: readonly (readonly number[])[] | null,
  right: readonly (readonly number[])[],
): boolean {
  if (left === null || left.length !== right.length) return false;
  return left.every(
    (line, index) =>
      line.length === right[index]?.length &&
      line.every((unit, unitIndex) => unit === right[index]?.[unitIndex]),
  );
}
