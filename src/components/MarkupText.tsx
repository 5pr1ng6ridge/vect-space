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
  formulaPresentationDurationMs,
  formulaRevealDurationMs,
  parseMarkup,
  visibleUnits,
  type MathUnit,
} from "../engine/markup";
import type { TextRevealAnimation } from "../engine/types";
import {
  buildLineSweepGeometry,
  buildLineSweepTimings,
  isHardLineBreak,
  lineSweepMaskPositionPx,
  resolveVisualLineGroups,
  type LineSweepUnitGeometry,
  type LineSweepUnitTiming,
} from "./visualLineGroups";

const EMPTY_MATH_REVEAL_DURATIONS: ReadonlyMap<number, number> = new Map();

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
  /**
   * The prompt controller waits for a real visual-line measurement before it
   * starts a line sweep.  It prevents a slow font load from accumulating text
   * and then replaying every already-revealed row at once.
   */
  onLineSweepLayoutChange?(ready: boolean): void;
  revealSchedule?: readonly number[];
  mathRevealDurations?: ReadonlyMap<number, number>;
  pauseWindows?: readonly { startMs: number; endMs: number }[];
  lineSweepElapsedMs?: number;
  /** Used for click-to-complete and fast-forward; it clears every reveal mask. */
  instantReveal?: boolean;
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
  onLineSweepLayoutChange,
  revealSchedule = [],
  mathRevealDurations = EMPTY_MATH_REVEAL_DURATIONS,
  pauseWindows = [],
  lineSweepElapsedMs = 0,
  instantReveal = false,
}: MarkupTextProps): ReactElement {
  const units = useMemo(() => visibleUnits(parseMarkup(source)), [source]);
  const lineSweepMode =
    revealAnimation === "line_sweep" &&
    visibleCount !== Number.POSITIVE_INFINITY;
  const lineSweepRequested = lineSweepMode && fontReady;
  const unitElementsRef = useRef(new Map<number, HTMLElement>());
  const rootRef = useRef<HTMLSpanElement>(null);
  const [lineGroups, setLineGroups] = useState<{
    source: string;
    groups: readonly (readonly number[])[];
    geometry: ReadonlyMap<number, LineSweepUnitGeometry>;
    featherPx: number;
  } | null>(null);

  useLayoutEffect(() => {
    let frame = 0;
    if (!lineSweepRequested) {
      frame = requestAnimationFrame(() => setLineGroups(null));
      return () => cancelAnimationFrame(frame);
    }
    const root = rootRef.current;
    const measure = (): void => {
      const groups = resolveVisualLineGroups(units, unitElementsRef.current);
      const measuredUnitCount = groups.reduce(
        (total, group) => total + group.length,
        0,
      );
      const paintableUnitCount = units.filter(
        (unit) => !isHardLineBreak(unit),
      ).length;
      if (measuredUnitCount !== paintableUnitCount) return;
      const geometry = buildLineSweepGeometry(groups, unitElementsRef.current);
      if (geometry.size !== paintableUnitCount) return;
      const fontSizePx =
        root === null
          ? Number.NaN
          : Number.parseFloat(getComputedStyle(root).fontSize);
      const featherPx =
        Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx * 1.5 : 51;
      setLineGroups((current) =>
        current?.source === source &&
        sameLineGroups(current.groups, groups) &&
        sameLineSweepGeometry(current.geometry, geometry) &&
        Math.abs(current.featherPx - featherPx) <= 0.1
          ? current
          : { source, groups, geometry, featherPx },
      );
    };
    frame = requestAnimationFrame(measure);
    if (root === null || typeof ResizeObserver === "undefined") {
      return () => cancelAnimationFrame(frame);
    }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [lineSweepRequested, source, units]);

  const activeLineGroups =
    lineGroups?.source === source ? lineGroups.groups : null;
  const activeLineGeometry =
    lineGroups?.source === source ? lineGroups.geometry : null;
  const lineSweepFeatherPx =
    lineGroups?.source === source ? lineGroups.featherPx : 51;
  const groupedUnitCount =
    activeLineGroups?.reduce((total, group) => total + group.length, 0) ?? 0;
  const paintableUnitCount = units.filter(
    (unit) => !isHardLineBreak(unit),
  ).length;
  const lineSweepReady =
    !lineSweepMode ||
    (activeLineGroups !== null &&
      activeLineGeometry !== null &&
      groupedUnitCount === paintableUnitCount &&
      activeLineGeometry.size === paintableUnitCount);
  const lineSweepTimings = useMemo(
    () =>
      !lineSweepRequested ||
      activeLineGroups === null ||
      activeLineGeometry === null
        ? new Map<number, LineSweepUnitTiming>()
        : buildLineSweepTimings(
            units,
            activeLineGroups,
            revealSchedule,
            unitCps,
            mathRevealDurations,
            activeLineGeometry,
            pauseWindows,
          ),
    [
      activeLineGroups,
      activeLineGeometry,
      lineSweepRequested,
      mathRevealDurations,
      pauseWindows,
      revealSchedule,
      unitCps,
      units,
    ],
  );

  useLayoutEffect(() => {
    onLineSweepLayoutChange?.(lineSweepReady);
  }, [lineSweepReady, onLineSweepLayoutChange]);

  const renderUnit = (
    unit: (typeof units)[number],
    index: number,
    visible: boolean,
    lineSweepTiming: LineSweepUnitTiming | undefined,
  ): ReactElement => {
    const style = {
      visibility: visible ? "visible" : "hidden",
      "--unit-index": index,
      ...(lineSweepTiming === undefined
        ? {}
        : {
            "--line-sweep-duration": `${lineSweepTiming.durationMs}ms`,
            "--line-sweep-width": `${lineSweepTiming.lineWidthPx}px`,
            "--line-sweep-offset": `${lineSweepTiming.unitOffsetPx}px`,
            "--line-sweep-feather": `${lineSweepFeatherPx}px`,
            "--line-sweep-mask-position": `${lineSweepMaskPositionPx(
              lineSweepTiming,
              lineSweepElapsedMs,
              pauseWindows,
              lineSweepFeatherPx,
            )}px`,
          }),
    } as CSSProperties;
    const revealClass =
      visible && visibleCount !== Number.POSITIVE_INFINITY
        ? ` is-reveal-${revealAnimation}`
        : "";
    const instantClass = instantReveal && visible ? " is-reveal-instant" : "";
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
          instant={instantMathReveal || instantReveal}
          key={`${index}-math-${unit.latex}`}
          onMetrics={onMathMetrics}
          registerElement={registerElement}
          revealActive={visible && visibleCount !== Number.POSITIVE_INFINITY}
          style={style}
          unit={unit}
          visible={visible}
          revealAnimation={revealAnimation}
          fontReady={fontReady}
        />
      );
    }
    if (isHardLineBreak(unit)) {
      return (
        <span
          aria-hidden="true"
          className="markup-unit character-unit line-break-unit"
          key={`${index}-line-break`}
          style={style}
        >
          <br />
        </span>
      );
    }
    return (
      <span
        aria-hidden="true"
        className={`markup-unit character-unit${effectClass}${revealClass}${instantClass}`}
        key={`${index}-${unit.value}`}
        ref={registerElement}
        style={style}
      >
        <span className="markup-reveal-content">{unit.value}</span>
        <wbr />
      </span>
    );
  };

  return (
    <span className={className} aria-label={source} ref={rootRef}>
      {units.map((unit, index) => {
        const timing = lineSweepTimings.get(index);
        const visible =
          timing === undefined
            ? index < visibleCount
            : timing.lineStartIndex < visibleCount;
        return renderUnit(unit, index, visible, timing);
      })}
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
  const fallbackRevealDuration = formulaPresentationDurationMs(
    formulaRevealDurationMs(0, 0, cps),
    unit.display,
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
      const duration = formulaPresentationDurationMs(
        formulaRevealDurationMs(width, fontSize, cps),
        unit.display,
      );
      content.style.setProperty("--math-reveal-duration", `${duration}ms`);
      onMetrics?.(index, width, fontSize);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(katexElement);
    return () => observer.disconnect();
  }, [animate, cps, fontReady, html, index, onMetrics, unit.display]);

  return (
    <span
      aria-hidden="true"
      className={`markup-unit math-unit${unit.display ? " display-math" : ""}${effectClass}${animate && visible ? " is-math-revealed" : ""}${revealActive ? ` is-reveal-${revealAnimation}` : ""}${instant ? " is-math-instant is-reveal-instant" : ""}`}
      ref={registerElement}
      style={style}
    >
      <span
        className="math-reveal-content markup-reveal-content"
        dangerouslySetInnerHTML={{ __html: html }}
        ref={contentRef}
        style={
          {
            "--math-reveal-duration": `${fallbackRevealDuration}ms`,
          } as CSSProperties
        }
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

function sameLineSweepGeometry(
  left: ReadonlyMap<number, LineSweepUnitGeometry> | undefined,
  right: ReadonlyMap<number, LineSweepUnitGeometry>,
): boolean {
  if (left === undefined || left.size !== right.size) return false;
  for (const [index, value] of left) {
    const candidate = right.get(index);
    if (
      candidate === undefined ||
      candidate.lineWidthPx !== value.lineWidthPx ||
      candidate.unitOffsetPx !== value.unitOffsetPx
    ) {
      return false;
    }
  }
  return true;
}
