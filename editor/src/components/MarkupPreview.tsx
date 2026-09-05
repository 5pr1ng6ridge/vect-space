import {
  createTextLayoutSnapshot,
  parseMarkup,
  visibleUnits,
  type MarkupUnit,
  type TextEffect,
  type TextLayoutSnapshot,
} from "@vectspace/text";
import katex from "katex";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactElement,
} from "react";

/**
 * Static editor rendering for authored text.
 *
 * Markup controls are deliberately not represented by DOM nodes. They are
 * timing metadata and must not affect line wrapping or long-text pagination.
 * This keeps the editor's measured body identical to the game's static text
 * renderer.
 */
export interface MarkupPreviewProps {
  source: string;
  /** Reports the browser's real visual rows in design/CSS pixels. */
  onLayout?(layout: TextLayoutSnapshot): void;
  className?: string;
  style?: CSSProperties;
}

export function MarkupPreview({
  source,
  onLayout,
  className,
  style,
}: MarkupPreviewProps): ReactElement {
  const units = parseMarkup(source);
  const layoutUnits = visibleUnits(units);
  const rootRef = useRef<HTMLDivElement>(null);
  const onLayoutRef = useRef(onLayout);

  useLayoutEffect(() => {
    onLayoutRef.current = onLayout;
  }, [onLayout]);

  const measure = useCallback((): void => {
    const root = rootRef.current;
    const callback = onLayoutRef.current;
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
    const groups: number[][] = [];
    let current: number[] = [];
    let previousTop: number | undefined;

    layoutUnits.forEach((unit, index) => {
      if (unit.kind === "hard_break") {
        if (current.length > 0) groups.push(current);
        current = [];
        previousTop = undefined;
        return;
      }
      const element = root.querySelector<HTMLElement>(
        `[data-layout-index="${index}"]`,
      );
      const rect = element?.getBoundingClientRect();
      if (element === undefined || rect === undefined || rect.width < 0) return;
      const top = rect.top - rootRect.top;
      boxes.set(index, {
        index,
        top,
        bottom: rect.bottom - rootRect.top,
        left: rect.left - rootRect.left,
        right: rect.right - rootRect.left,
      });
      if (
        previousTop !== undefined &&
        Math.abs(top - previousTop) > Math.max(1, rect.height * 0.25)
      ) {
        if (current.length > 0) groups.push(current);
        current = [];
      }
      current.push(index);
      previousTop = top;
    });
    if (current.length > 0) groups.push(current);
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
    let frame = requestAnimationFrame(measure);
    const root = rootRef.current;
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
  }, [measure, onLayout]);

  const rootClassName =
    className === undefined ? "markup-preview" : `markup-preview ${className}`;
  return (
    <div className={rootClassName} ref={rootRef} style={style}>
      {units.map((unit, index) => {
        const layoutIndex = layoutIndexFor(units, index);
        return renderUnit(unit, index, layoutIndex);
      })}
    </div>
  );
}

function renderUnit(
  unit: MarkupUnit,
  index: number,
  layoutIndex: number | null,
): ReactElement | string | null {
  if (
    unit.kind === "pause" ||
    unit.kind === "speed" ||
    unit.kind === "auto_advance"
  ) {
    return null;
  }
  if (unit.kind === "hard_break") {
    return (
      <br data-layout-index={layoutIndex ?? undefined} key={`break-${index}`} />
    );
  }

  const className = effectClass(unit.effect);
  if (unit.kind === "character") {
    return (
      <span
        className={className}
        data-layout-index={layoutIndex ?? undefined}
        key={`text-${unit.span.start}`}
      >
        {unit.value}
      </span>
    );
  }

  return (
    <span
      className={`${className ?? ""} ${unit.display ? "markup-display-math" : ""}`.trim()}
      data-layout-index={layoutIndex ?? undefined}
      dangerouslySetInnerHTML={{
        __html: katex.renderToString(unit.latex, {
          displayMode: unit.display,
          throwOnError: false,
          strict: "warn",
          trust: false,
        }),
      }}
      key={`math-${unit.span.start}`}
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
