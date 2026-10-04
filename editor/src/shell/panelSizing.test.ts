import { describe, expect, it } from "vitest";

import {
  clampPanelSize,
  PANEL_CLICK_SLOP,
  PANEL_COLLAPSE_DISTANCE,
  panelBounds,
  resolvePanelDrag,
  stepPanel,
  type PanelDrag,
} from "./panelSizing";

const [LEFT_MIN, LEFT_MAX] = panelBounds("left");
const [RIGHT_MIN] = panelBounds("right");

describe("panel sizing", () => {
  it("clamps widths to each panel's bounds", () => {
    expect(clampPanelSize("left", 0)).toBe(LEFT_MIN);
    expect(clampPanelSize("left", 9999)).toBe(LEFT_MAX);
    expect(clampPanelSize("right", 300.4)).toBe(300);
  });

  describe("drag from an open panel", () => {
    const drag: PanelDrag = {
      axis: "left",
      startX: 500,
      origin: 300,
      remembered: 300,
      startedCollapsed: false,
    };

    it("follows the pointer within the bounds", () => {
      expect(resolvePanelDrag(drag, 540)).toEqual({ size: 340, visible: true });
      expect(resolvePanelDrag(drag, 9999)).toEqual({
        size: LEFT_MAX,
        visible: true,
      });
    });

    it("sticks at the minimum until the collapse distance is passed", () => {
      const atEdge = 500 - (300 - LEFT_MIN) - PANEL_COLLAPSE_DISTANCE;
      expect(resolvePanelDrag(drag, atEdge)).toEqual({
        size: LEFT_MIN,
        visible: true,
      });
      expect(resolvePanelDrag(drag, atEdge - 1)).toEqual({
        size: 300,
        visible: false,
      });
    });

    it("reopens when the pointer comes back out in the same gesture", () => {
      expect(resolvePanelDrag(drag, 0).visible).toBe(false);
      expect(resolvePanelDrag(drag, 400)).toEqual({
        size: LEFT_MIN,
        visible: true,
      });
    });

    it("mirrors the direction for the right panel", () => {
      const right: PanelDrag = { ...drag, axis: "right", origin: 340 };
      expect(resolvePanelDrag(right, 460)).toEqual({
        size: 380,
        visible: true,
      });
      const collapseAt = 500 + (340 - RIGHT_MIN) + PANEL_COLLAPSE_DISTANCE;
      expect(resolvePanelDrag(right, collapseAt).visible).toBe(true);
      expect(resolvePanelDrag(right, collapseAt + 1)).toEqual({
        size: 300,
        visible: false,
      });
    });
  });

  describe("drag out of a collapsed rail", () => {
    const drag: PanelDrag = {
      axis: "left",
      startX: 60,
      origin: 0,
      remembered: 340,
      startedCollapsed: true,
    };

    it("stays collapsed within the click slop", () => {
      expect(resolvePanelDrag(drag, 60 + PANEL_CLICK_SLOP - 1)).toEqual({
        size: 340,
        visible: false,
      });
    });

    it("opens at the minimum width, then follows the pointer", () => {
      expect(resolvePanelDrag(drag, 60 + PANEL_CLICK_SLOP).size).toBe(LEFT_MIN);
      expect(resolvePanelDrag(drag, 60 + 100)).toEqual({
        size: LEFT_MIN,
        visible: true,
      });
      expect(resolvePanelDrag(drag, 60 + 400)).toEqual({
        size: 400,
        visible: true,
      });
    });

    it("pulls the right panel out toward the left", () => {
      const right: PanelDrag = { ...drag, axis: "right", startX: 900 };
      expect(resolvePanelDrag(right, 900 + 50).visible).toBe(false);
      expect(resolvePanelDrag(right, 900 - 450)).toEqual({
        size: 450,
        visible: true,
      });
    });
  });

  describe("keyboard steps", () => {
    it("resizes within bounds without collapsing early", () => {
      expect(stepPanel("left", { size: 280, visible: true }, 12)).toEqual({
        size: 292,
        visible: true,
      });
      expect(
        stepPanel("left", { size: LEFT_MIN + 5, visible: true }, -12),
      ).toEqual({ size: LEFT_MIN, visible: true });
    });

    it("collapses when pressing inward at the minimum", () => {
      expect(stepPanel("left", { size: LEFT_MIN, visible: true }, -12)).toEqual(
        { size: LEFT_MIN, visible: false },
      );
    });

    it("does not collapse on key auto-repeat", () => {
      const layout = { size: LEFT_MIN, visible: true };
      expect(stepPanel("left", layout, -12, false)).toBe(layout);
    });

    it("reopens at the remembered width when pressing outward", () => {
      expect(stepPanel("left", { size: 360, visible: false }, 12)).toEqual({
        size: 360,
        visible: true,
      });
      const hidden = { size: 360, visible: false };
      expect(stepPanel("left", hidden, -12)).toBe(hidden);
    });
  });
});
