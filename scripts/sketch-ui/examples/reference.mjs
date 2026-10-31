/**
 * Reference assets: the style anchor every other group is drawn against.
 * Read these before writing a new group.
 */

import { PALETTE } from "../canvas.mjs";
import { letters, measureLetters } from "../font.mjs";
import { highlight, paperPiece, squiggle, tape } from "../parts.mjs";
import { Pen } from "../pencil.mjs";

export const assets = [
  {
    name: "choice_primary_normal",
    dir: "menu",
    width: 980,
    height: 92,
    kind: "gui",
    draw(c) {
      paperPiece(c, {
        x: 14,
        y: 12,
        w: c.w - 34,
        h: c.h - 28,
        edge: "cut",
        paper: "light",
        rules: "ruled",
        ruleGap: 30,
        ruleInset: 20,
      });
      const pen = new Pen(c, {
        color: PALETTE.graphiteMid,
        width: 1.8,
        opacity: 0.6,
      });
      squiggle(pen, 46, 140, c.h - 22, { amp: 2.4, waves: 6 });
      c.add(pen.flush());
    },
  },
  {
    name: "dialogue_box",
    dir: "hud",
    width: 1920,
    height: 387,
    kind: "gui",
    draw(c) {
      paperPiece(c, {
        x: 120,
        y: 60,
        w: c.w - 240,
        h: c.h - 100,
        edge: "torn",
        torn: [0],
        tilt: -0.4,
        paper: "cream",
        rules: "ruled",
        ruleGap: 44,
        ruleInset: 40,
        margin: true,
        shadow: { dx: 4, dy: 8, blur: 7, opacity: 0.34 },
      });
      tape(c, { x: 150, y: 38, w: 130, h: 38, angle: -8 });
      tape(c, { x: c.w - 290, y: 44, w: 130, h: 38, angle: 6 });
    },
  },
  {
    name: "title_logo",
    dir: "title",
    width: 1000,
    height: 260,
    kind: "gui",
    draw(c) {
      highlight(c, {
        x: 60,
        y: 150,
        w: 880,
        h: 56,
        color: PALETTE.highlightYellow,
        opacity: 0.5,
        angle: -1,
      });
      const pen = new Pen(c, {
        color: PALETTE.graphite,
        width: 6.5,
        passes: 3,
        wobble: 1.6,
        opacity: 0.9,
        overshoot: 2,
      });
      const size = 104;
      const width = measureLetters("VECTSPACE", size, 0.7);
      letters(pen, "VECTSPACE", (c.w - width) / 2, 205, size, { spacing: 0.7 });
      c.add(pen.flush());
    },
  },
];
