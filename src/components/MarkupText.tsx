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

interface MarkupTextProps {
  source: string;
  visibleCount?: number;
  className?: string;
  animateMath?: boolean;
  instantMathReveal?: boolean;
  unitCps?: readonly number[];
  onMathMetrics?(unitIndex: number, widthPx: number, fontSizePx: number): void;
  revealAnimation?: TextRevealAnimation;
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
}: MarkupTextProps): ReactElement {
  const units = useMemo(() => visibleUnits(parseMarkup(source)), [source]);
  const lineSweep =
    revealAnimation === "line_sweep" &&
    visibleCount !== Number.POSITIVE_INFINITY;
  const unitElementsRef = useRef(new Map<number, HTMLElement>());
  const [lineGroups, setLineGroups] = useState<
    readonly (readonly number[])[] | null
  >(null);

  useLayoutEffect(() => {
    let frame = 0;
    if (!lineSweep) {
      frame = requestAnimationFrame(() => setLineGroups(null));
      return () => cancelAnimationFrame(frame);
    }
    frame = requestAnimationFrame(() => {
      const groups = resolveVisualLineGroups(units, unitElementsRef.current);
      setLineGroups((current) =>
        sameLineGroups(current, groups) ? current : groups,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [lineSweep, source, units]);

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
          style={style}
          suppressReveal={suppressReveal}
          unit={unit}
          visible={visible}
          revealAnimation={revealAnimation}
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

  const groupedLineSweep = lineSweep && lineGroups !== null;
  return (
    <span className={className} aria-label={source}>
      {groupedLineSweep
        ? lineGroups.map((indices, lineIndex) => {
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
  style,
  suppressReveal,
  unit,
  visible,
  revealAnimation,
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
  style: CSSProperties;
  suppressReveal: boolean;
  unit: MathUnit;
  visible: boolean;
  revealAnimation: TextRevealAnimation;
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
      className={`markup-unit math-unit${unit.display ? " display-math" : ""}${effectClass}${animate && visible ? " is-math-revealed" : ""}${visible && !suppressReveal ? ` is-reveal-${revealAnimation}` : ""}${instant ? " is-math-instant" : ""}`}
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

function resolveVisualLineGroups(
  units: readonly ReturnType<typeof visibleUnits>[number][],
  elements: ReadonlyMap<number, HTMLElement>,
): readonly (readonly number[])[] {
  const groups: number[][] = [];
  let lastTop: number | null = null;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const element = elements.get(index);
    if (unit === undefined || element === undefined) return [];
    const top = Math.round(element.getBoundingClientRect().top * 2) / 2;
    const startsLine = lastTop === null || Math.abs(top - lastTop) > 1;
    if (startsLine) groups.push([]);
    groups[groups.length - 1]?.push(index);
    lastTop = top;
  }
  return groups;
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
