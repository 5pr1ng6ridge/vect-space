import katex from "katex";
import {
  createTextLayoutSnapshot,
  parseMarkup,
  resolveTextLayoutLineGroups,
  visibleUnits,
  type MarkupUnit,
  type TextEffect,
  type TextLayoutSnapshot,
  type TextRevealAnimation,
} from "@vectspace/text";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactElement,
} from "react";

export interface MeasuredMarkupProps {
  source: string;
  fontFamily?: string;
  fontSize?: number | string;
  textColor?: string;
  reveal?: TextRevealAnimation;
  visibleCount?: number;
  className?: string;
  style?: CSSProperties;
  onLayout?(layout: TextLayoutSnapshot): void;
}

/**
 * The shared DOM/KaTeX text surface. All units stay mounted and hidden units
 * reserve their final geometry, which makes it suitable for gameplay reveal
 * and editor measurement/pagination alike.
 */
export function MeasuredMarkup({
  source,
  fontFamily,
  fontSize,
  textColor,
  reveal = "typewriter",
  visibleCount = Number.POSITIVE_INFINITY,
  className,
  style,
  onLayout,
}: MeasuredMarkupProps): ReactElement {
  const units = useMemo(() => parseMarkup(source), [source]);
  const layoutUnits = useMemo(() => visibleUnits(units), [units]);
  const revealIndexByLayoutIndex = useMemo(() => {
    const result = new Map<number, number>();
    let revealIndex = 0;
    layoutUnits.forEach((unit, index) => {
      if (unit.kind === "hard_break") return;
      result.set(index, revealIndex);
      revealIndex += 1;
    });
    return result;
  }, [layoutUnits]);
  const rootRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onLayout);
  useLayoutEffect(() => {
    callbackRef.current = onLayout;
  }, [onLayout]);

  const measure = useCallback(() => {
    const root = rootRef.current;
    const callback = callbackRef.current;
    if (root === null || callback === undefined) return;
    const rootRect = root.getBoundingClientRect();
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
    layoutUnits.forEach((unit, index) => {
      if (unit.kind === "hard_break") return;
      const element = root.querySelector<HTMLElement>(
        `[data-layout-index="${index}"]`,
      );
      const rect = element?.getBoundingClientRect();
      if (rect === undefined || rect.width < 0) return;
      boxes.set(index, {
        index,
        top: rect.top - rootRect.top,
        bottom: rect.bottom - rootRect.top,
        left: rect.left - rootRect.left,
        right: rect.right - rootRect.left,
      });
    });
    const groups = resolveTextLayoutLineGroups(layoutUnits, boxes);
    const expected = layoutUnits.filter(
      (unit) => unit.kind !== "hard_break",
    ).length;
    if (groups.flat().length !== expected) return;
    callback(
      createTextLayoutSnapshot(
        groups,
        boxes,
        Math.max(root.scrollHeight, rootRect.height),
      ),
    );
  }, [layoutUnits]);

  useLayoutEffect(() => {
    if (onLayout === undefined) return;
    let disposed = false;
    let frame = 0;
    const schedule = (): void => {
      if (disposed) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // Font metrics are part of the layout contract.  Waiting for the browser
    // font set avoids publishing a fallback-font snapshot that would move
    // every subsequent line after the bundled game font finishes loading.
    const fontsReady = document.fonts?.ready;
    if (fontsReady === undefined) schedule();
    else void fontsReady.then(schedule, schedule);
    const root = rootRef.current;
    if (root === null || typeof ResizeObserver === "undefined") {
      return () => {
        disposed = true;
        cancelAnimationFrame(frame);
      };
    }
    const observer = new ResizeObserver(() => {
      schedule();
    });
    observer.observe(root);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fontFamily, fontSize, measure, onLayout, textColor]);

  const rootStyle: CSSProperties = {
    ...style,
    ...(fontFamily === undefined ? {} : { fontFamily }),
    ...(fontSize === undefined ? {} : { fontSize }),
    ...(textColor === undefined ? {} : { color: textColor }),
  };
  return (
    <div
      className={className ?? "markup-preview"}
      ref={rootRef}
      style={rootStyle}
    >
      {units.map((unit, index) => {
        const layoutIndex = layoutIndexFor(units, index);
        const revealIndex =
          layoutIndex === null
            ? undefined
            : revealIndexByLayoutIndex.get(layoutIndex);
        const visible = revealIndex === undefined || revealIndex < visibleCount;
        return renderUnit(
          unit,
          index,
          layoutIndex,
          visible,
          reveal,
          visibleCount !== Number.POSITIVE_INFINITY,
        );
      })}
    </div>
  );
}

function renderUnit(
  unit: MarkupUnit,
  index: number,
  layoutIndex: number | null,
  visible: boolean,
  reveal: TextRevealAnimation,
  isRevealing: boolean,
): ReactElement | null {
  if (
    unit.kind === "pause" ||
    unit.kind === "speed" ||
    unit.kind === "auto_advance"
  )
    return null;
  if (unit.kind === "hard_break") {
    return (
      <br data-layout-index={layoutIndex ?? undefined} key={`break-${index}`} />
    );
  }
  const effect = effectClass(unit.effect);
  const revealClass =
    visible && isRevealing ? ` is-preview-reveal-${reveal}` : "";
  const unitStyle: CSSProperties = {
    visibility: visible ? "visible" : "hidden",
  };
  if (unit.kind === "character") {
    return (
      <span
        className={`markup-preview-character${effect === undefined ? "" : ` ${effect}`}${revealClass}`}
        data-layout-index={layoutIndex ?? undefined}
        key={`text-${unit.span.start}`}
        style={unitStyle}
      >
        <span className="markup-preview-content">{unit.value}</span>
        <wbr />
      </span>
    );
  }
  return (
    <span
      className={`markup-preview-math${unit.display ? " markup-display-math" : ""}${effect === undefined ? "" : ` ${effect}`}${revealClass}`}
      data-layout-index={layoutIndex ?? undefined}
      dangerouslySetInnerHTML={{
        __html: katex.renderToString(unit.latex, {
          displayMode: unit.display,
          throwOnError: false,
          strict: "ignore",
          trust: false,
          output: "html",
        }),
      }}
      key={`math-${unit.span.start}`}
      style={unitStyle}
    />
  );
}

function layoutIndexFor(
  units: readonly MarkupUnit[],
  rawIndex: number,
): number | null {
  let index = 0;
  for (let cursor = 0; cursor <= rawIndex; cursor += 1) {
    const unit = units[cursor];
    if (unit === undefined) continue;
    if (
      unit.kind === "character" ||
      unit.kind === "hard_break" ||
      unit.kind === "math"
    ) {
      if (cursor === rawIndex) return index;
      index += 1;
    }
  }
  return null;
}

function effectClass(effect: TextEffect | null): string | undefined {
  return effect === null ? undefined : `markup-fx markup-fx-${effect}`;
}
