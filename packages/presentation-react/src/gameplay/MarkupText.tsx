import katex from "katex";
import {
  createTextLayoutSnapshot,
  isValidTextMeasurementScale,
  normalizeTextContentHeight,
  normalizeTextUnitBox,
  resolveTextLayoutLineGroups,
  type TextLayoutSnapshot,
} from "@vectspace/text";
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
} from "@vectspace/text";
import type { TextRevealAnimation } from "@vectspace/presentation-core/types";
import type { TextRevealClock } from "./useTextRevealSession";
import {
  buildLineSweepGeometry,
  buildLineSweepTimings,
  isHardLineBreak,
  lineSweepMaskPositionPx,
  splitLinesAtPauses,
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
  /** Actual browser rows, shared with long-text pagination and editor tools. */
  onTextLayout?(layout: TextLayoutSnapshot): void;
  revealSchedule?: readonly number[];
  mathRevealDurations?: ReadonlyMap<number, number>;
  pauseWindows?: readonly { startMs: number; endMs: number }[];
  lineSweepElapsedMs?: number;
  /** Used for click-to-complete and fast-forward; it clears every reveal mask. */
  instantReveal?: boolean;
  /** Optional frame clock used to update line masks without React renders. */
  revealClock?: TextRevealClock;
  /** Scale of the containing 1920×1080 design surface. */
  measurementScale?: number;
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
  onTextLayout,
  revealSchedule = [],
  mathRevealDurations = EMPTY_MATH_REVEAL_DURATIONS,
  pauseWindows = [],
  lineSweepElapsedMs = 0,
  instantReveal = false,
  revealClock,
  measurementScale = 1,
}: MarkupTextProps): ReactElement {
  const units = useMemo(() => visibleUnits(parseMarkup(source)), [source]);
  // Reveal plans deliberately omit hard breaks: they take no time, but remain
  // mounted so that hidden text still reserves its final wrapping geometry.
  const revealIndexByLayoutIndex = useMemo(() => {
    const result = new Map<number, number>();
    let revealIndex = 0;
    units.forEach((unit, layoutIndex) => {
      if (isHardLineBreak(unit)) return;
      result.set(layoutIndex, revealIndex);
      revealIndex += 1;
    });
    return result;
  }, [units]);
  const layoutSchedule = useMemo(
    () =>
      units.map((unit, layoutIndex) => {
        const revealIndex = revealIndexByLayoutIndex.get(layoutIndex);
        return isHardLineBreak(unit) || revealIndex === undefined
          ? 0
          : (revealSchedule[revealIndex] ?? Number.POSITIVE_INFINITY);
      }),
    [revealIndexByLayoutIndex, revealSchedule, units],
  );
  const layoutUnitCps = useMemo(
    () =>
      units.map((unit, layoutIndex) => {
        const revealIndex = revealIndexByLayoutIndex.get(layoutIndex);
        return isHardLineBreak(unit) || revealIndex === undefined
          ? 30
          : (unitCps[revealIndex] ?? 30);
      }),
    [revealIndexByLayoutIndex, unitCps, units],
  );
  const layoutMathRevealDurations = useMemo(() => {
    const result = new Map<number, number>();
    units.forEach((unit, layoutIndex) => {
      const revealIndex = revealIndexByLayoutIndex.get(layoutIndex);
      if (unit.kind !== "math" || revealIndex === undefined) return;
      const duration = mathRevealDurations.get(revealIndex);
      if (duration !== undefined) result.set(layoutIndex, duration);
    });
    return result;
  }, [mathRevealDurations, revealIndexByLayoutIndex, units]);
  const lineSweepMode =
    revealAnimation === "line_sweep" &&
    visibleCount !== Number.POSITIVE_INFINITY;
  const validMeasurementScale = isValidTextMeasurementScale(measurementScale);
  const lineSweepRequested =
    lineSweepMode && fontReady && validMeasurementScale;
  const measurementRequested =
    validMeasurementScale &&
    fontReady &&
    (lineSweepRequested || onTextLayout !== undefined);
  const unitElementsRef = useRef(new Map<number, HTMLElement>());
  const rootRef = useRef<HTMLSpanElement>(null);
  const [lineGroups, setLineGroups] = useState<{
    source: string;
    groups: readonly (readonly number[])[];
    geometry: ReadonlyMap<number, LineSweepUnitGeometry>;
    featherPx: number;
    layout: TextLayoutSnapshot;
  } | null>(null);

  useLayoutEffect(() => {
    let frame = 0;
    if (!measurementRequested) {
      frame = requestAnimationFrame(() => setLineGroups(null));
      return () => cancelAnimationFrame(frame);
    }
    const root = rootRef.current;
    const measure = (): void => {
      const rootRect = root?.getBoundingClientRect();
      const boxes = new Map<
        number,
        {
          index: number;
          top: number;
          bottom: number;
          left: number;
          right: number;
        }
      >();
      units.forEach((unit, index) => {
        if (isHardLineBreak(unit)) return;
        const element = unitElementsRef.current.get(index);
        if (element === undefined || rootRect === undefined) return;
        const rect = element.getBoundingClientRect();
        boxes.set(
          index,
          normalizeTextUnitBox(index, rect, rootRect, measurementScale),
        );
      });
      const rawGroups = resolveTextLayoutLineGroups(units, boxes);
      const groups = splitLinesAtPauses(
        rawGroups,
        layoutSchedule,
        pauseWindows,
      );
      const measuredUnitCount = rawGroups.reduce(
        (total, group) => total + group.length,
        0,
      );
      const paintableUnitCount = units.filter(
        (unit) => !isHardLineBreak(unit),
      ).length;
      if (measuredUnitCount !== paintableUnitCount) return;
      const geometry = lineSweepRequested
        ? buildLineSweepGeometry(
            groups,
            unitElementsRef.current,
            measurementScale,
          )
        : new Map<number, LineSweepUnitGeometry>();
      if (lineSweepRequested && geometry.size !== paintableUnitCount) return;
      const layout = createTextLayoutSnapshot(
        rawGroups,
        boxes,
        normalizeTextContentHeight(
          root?.scrollHeight ?? 0,
          rootRect?.height ?? 0,
          boxes,
          measurementScale,
        ),
      );
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
        Math.abs(current.featherPx - featherPx) <= 0.1 &&
        sameTextLayout(current.layout, layout)
          ? current
          : { source, groups, geometry, featherPx, layout },
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
  }, [
    layoutSchedule,
    lineSweepRequested,
    measurementRequested,
    measurementScale,
    pauseWindows,
    source,
    units,
  ]);

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
    (validMeasurementScale &&
      activeLineGroups !== null &&
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
            layoutSchedule,
            layoutUnitCps,
            layoutMathRevealDurations,
            activeLineGeometry,
            pauseWindows,
          ),
    [
      activeLineGroups,
      activeLineGeometry,
      lineSweepRequested,
      layoutMathRevealDurations,
      layoutSchedule,
      layoutUnitCps,
      pauseWindows,
      units,
    ],
  );

  useLayoutEffect(() => {
    if (!lineSweepMode || revealClock === undefined) return;
    const updateMaskPositions = (elapsedMs: number): void => {
      for (const [index, timing] of lineSweepTimings) {
        const element = unitElementsRef.current.get(index);
        if (element === undefined) continue;
        element.style.setProperty(
          "--line-sweep-mask-position",
          `${lineSweepMaskPositionPx(
            timing,
            elapsedMs,
            pauseWindows,
            lineSweepFeatherPx,
          )}px`,
        );
      }
    };
    updateMaskPositions(revealClock.getElapsedMs());
    return revealClock.subscribe(updateMaskPositions);
  }, [
    lineSweepFeatherPx,
    lineSweepMode,
    lineSweepTimings,
    pauseWindows,
    revealClock,
  ]);

  useLayoutEffect(() => {
    onLineSweepLayoutChange?.(lineSweepReady);
  }, [lineSweepReady, onLineSweepLayoutChange]);

  useLayoutEffect(() => {
    if (!validMeasurementScale || lineGroups?.source !== source) return;
    onTextLayout?.(lineGroups.layout);
  }, [lineGroups, onTextLayout, source, validMeasurementScale]);

  const renderUnit = (
    unit: (typeof units)[number],
    index: number,
    revealIndex: number | undefined,
    visible: boolean,
    lineSweepTiming: LineSweepUnitTiming | undefined,
  ): ReactElement => {
    // A visible unit must inherit the visibility of its presentation
    // surface.  Writing `visibility: visible` here would opt the unit back
    // into rendering when the dialogue/long-text container is hidden (the
    // reveal renderer keeps every unit mounted for stable layout).  Hidden
    // units still get an explicit value so the typewriter can reserve their
    // final geometry without painting them.
    const style = {
      visibility: visible ? "inherit" : "hidden",
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
          cps={unitCps[revealIndex ?? 0] ?? 30}
          effectClass={effectClass}
          index={index}
          instant={instantMathReveal || instantReveal}
          key={`${index}-math-${unit.latex}`}
          onMetrics={
            revealIndex === undefined || onMathMetrics === undefined
              ? undefined
              : (_unitIndex, widthPx, fontSizePx) =>
                  onMathMetrics(revealIndex, widthPx, fontSizePx)
          }
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
        const revealIndex = revealIndexByLayoutIndex.get(index);
        const lineStartRevealIndex =
          timing === undefined
            ? undefined
            : revealIndexByLayoutIndex.get(timing.lineStartIndex);
        const visible =
          isHardLineBreak(unit) ||
          (timing === undefined
            ? (revealIndex ?? Number.POSITIVE_INFINITY) < visibleCount
            : (lineStartRevealIndex ?? Number.POSITIVE_INFINITY) <
              visibleCount);
        return renderUnit(unit, index, revealIndex, visible, timing);
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

function sameTextLayout(
  left: TextLayoutSnapshot,
  right: TextLayoutSnapshot,
): boolean {
  if (
    Math.abs(left.contentHeight - right.contentHeight) > 0.25 ||
    left.lines.length !== right.lines.length
  ) {
    return false;
  }
  return left.lines.every((line, index) => {
    const candidate = right.lines[index];
    return (
      candidate !== undefined &&
      line.unitIndices.length === candidate.unitIndices.length &&
      line.unitIndices.every(
        (unitIndex, unitOffset) =>
          unitIndex === candidate.unitIndices[unitOffset],
      ) &&
      Math.abs(line.top - candidate.top) <= 0.25 &&
      Math.abs(line.bottom - candidate.bottom) <= 0.25 &&
      Math.abs(line.left - candidate.left) <= 0.25 &&
      Math.abs(line.right - candidate.right) <= 0.25
    );
  });
}
