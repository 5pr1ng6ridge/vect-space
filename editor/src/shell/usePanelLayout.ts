import { useCallback, useEffect, useState } from "react";

import {
  clampPanelSize,
  PANEL_CLICK_SLOP,
  resolvePanelDrag,
  stepPanel,
  type PanelAxis,
  type PanelDrag,
  type PanelLayout,
  type PanelSizes,
} from "./panelSizing";

const DEFAULT_PANEL_SIZES: PanelSizes = {
  left: 280,
  right: 340,
};

const PANEL_SIZES_KEY = "vectspace-editor:panel-sizes";

/** Panel widths are a per-machine preference, never part of the project. */
function loadPanelSizes(): PanelSizes {
  try {
    const stored = JSON.parse(
      localStorage.getItem(PANEL_SIZES_KEY) ?? "null",
    ) as Partial<PanelSizes> | null;
    return {
      left: clampPanelSize("left", stored?.left ?? DEFAULT_PANEL_SIZES.left),
      right: clampPanelSize(
        "right",
        stored?.right ?? DEFAULT_PANEL_SIZES.right,
      ),
    };
  } catch {
    return DEFAULT_PANEL_SIZES;
  }
}

/** Side-panel visibility, remembered widths and the drag-to-resize gesture. */
export function usePanelLayout() {
  const [leftPanelVisible, setLeftPanelVisible] = useState(true);
  const [rightPanelVisible, setRightPanelVisible] = useState(true);
  const [panelSizes, setPanelSizes] = useState<PanelSizes>(loadPanelSizes);
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_SIZES_KEY, JSON.stringify(panelSizes));
    } catch {
      // Preferences are best-effort; a blocked storage keeps the defaults.
    }
  }, [panelSizes]);
  const [resizeState, setResizeState] = useState<PanelDrag | null>(null);

  // Collapsing a panel only flips its visibility; the remembered width in
  // `panelSizes` is what a later click or key press reopens it at.
  const applyPanelLayout = useCallback(
    (axis: PanelAxis, layout: PanelLayout): void => {
      (axis === "left" ? setLeftPanelVisible : setRightPanelVisible)(
        layout.visible,
      );
      setPanelSizes((current) =>
        current[axis] === layout.size
          ? current
          : { ...current, [axis]: layout.size },
      );
    },
    [],
  );

  const panelLayout = (axis: PanelAxis): PanelLayout => ({
    size: panelSizes[axis],
    visible: axis === "left" ? leftPanelVisible : rightPanelVisible,
  });

  const resizeBy = (
    axis: PanelAxis,
    delta: number,
    repeated: boolean,
  ): void => {
    applyPanelLayout(
      axis,
      stepPanel(axis, panelLayout(axis), delta, !repeated),
    );
  };

  const expandPanel = (axis: PanelAxis): void => {
    applyPanelLayout(axis, { ...panelLayout(axis), visible: true });
  };

  const startResize = (axis: PanelAxis, startX: number): void => {
    const { size, visible } = panelLayout(axis);
    setResizeState({
      axis,
      startX,
      origin: visible ? size : 0,
      remembered: size,
      startedCollapsed: !visible,
    });
  };

  useEffect(() => {
    if (resizeState === null) return;
    // A press on the collapsed rail that never travels is a click.
    let travelled = false;
    const handlePointerMove = (event: globalThis.PointerEvent): void => {
      if (Math.abs(event.clientX - resizeState.startX) > PANEL_CLICK_SLOP) {
        travelled = true;
      }
      applyPanelLayout(
        resizeState.axis,
        resolvePanelDrag(resizeState, event.clientX),
      );
    };
    const handlePointerUp = (): void => {
      if (resizeState.startedCollapsed && !travelled) {
        applyPanelLayout(resizeState.axis, {
          size: resizeState.remembered,
          visible: true,
        });
      }
      setResizeState(null);
    };
    const handlePointerCancel = (): void => setResizeState(null);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    document.body.classList.add("panel-resizing");
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      document.body.classList.remove("panel-resizing");
    };
  }, [applyPanelLayout, resizeState]);

  return {
    panelSizes,
    leftPanelVisible,
    rightPanelVisible,
    setLeftPanelVisible,
    setRightPanelVisible,
    resizeBy,
    expandPanel,
    startResize,
  };
}
