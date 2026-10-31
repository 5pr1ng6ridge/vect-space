import type {
  ButtonSnapshot,
  ChoicePrompt,
  ChoiceSnapshot,
} from "@vectspace/presentation-core/types";
import { ChoiceLayer } from "@vectspace/presentation-react/choice";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ChoiceLayoutProbeCase, ChoiceLayoutProbeReport } from "./types";

/**
 * Mounts the actual shared ChoiceLayer in a real browser and records resolved
 * layout boxes for both hosts and both template modes.  This is deliberately
 * a DOM probe rather than a string-only CSS test: absolute positioning,
 * intrinsic image sizing and stacking are browser-computed behaviours.
 */
export async function runChoiceLayoutProbe(): Promise<ChoiceLayoutProbeReport> {
  const probeRoot = document.createElement("div");
  probeRoot.setAttribute("aria-hidden", "true");
  probeRoot.style.cssText =
    "position:absolute;left:-10000px;top:0;width:1920px;height:1080px;overflow:hidden;";
  document.body.append(probeRoot);
  const cases: ChoiceLayoutProbeCase[] = [];
  try {
    for (const host of ["game", "editor"] as const) {
      for (const mode of ["separate", "overlay"] as const) {
        const mount = document.createElement("div");
        mount.className = `choice-probe-${host}-${mode}`;
        mount.style.cssText =
          "position:relative;width:1920px;height:1080px;overflow:hidden;";
        probeRoot.append(mount);
        const root = createRoot(mount);
        root.render(
          createElement(ChoiceLayer, {
            assets: {
              "probe.normal": CHOICE_PROBE_IMAGE,
              "probe.hover": CHOICE_PROBE_IMAGE,
              "probe.icon": CHOICE_PROBE_IMAGE,
            },
            onChoose: () => undefined,
            prompt: choiceProbePrompt(mode),
          }),
        );
        await settleChoiceProbeDom();
        await settleChoiceProbeDom();
        const button = mount.querySelector("button");
        const fallbackButton = mount.querySelector(
          '[data-choice-id="probe.fallback"]',
        );
        if (
          !(button instanceof HTMLButtonElement) ||
          !(fallbackButton instanceof HTMLButtonElement)
        ) {
          root.unmount();
          throw new Error(`Choice ${host}/${mode} 探针没有渲染完整按钮集合`);
        }
        if (mode === "overlay") {
          // React's onPointerEnter is delegated from pointerover in browsers;
          // dispatch both names so the probe remains valid in headless engines
          // that expose only the generic Event constructor.
          const pointerOptions = {
            bubbles: true,
            clientX: button.getBoundingClientRect().left + 1,
            clientY: button.getBoundingClientRect().top + 1,
            pointerId: 1,
            pointerType: "mouse",
          };
          if (typeof PointerEvent === "function") {
            button.dispatchEvent(
              new PointerEvent("pointerover", pointerOptions),
            );
            button.dispatchEvent(
              new PointerEvent("pointerenter", pointerOptions),
            );
            button.dispatchEvent(
              new PointerEvent("pointerdown", {
                ...pointerOptions,
                button: 0,
              }),
            );
            button.dispatchEvent(
              new PointerEvent("pointerup", {
                ...pointerOptions,
                button: 0,
              }),
            );
          } else {
            button.dispatchEvent(new Event("pointerover", { bubbles: true }));
            button.dispatchEvent(new Event("pointerenter", { bubbles: true }));
          }
          // Focus is a real browser interaction and is also the keyboard
          // equivalent of hover; it keeps the probe deterministic when a
          // headless engine declines untrusted pointer events.
          button.focus();
          await settleChoiceProbeDom();
        }
        const buttonRect = rectData(button.getBoundingClientRect());
        const fallbackRect = rectData(fallbackButton.getBoundingClientRect());
        const imageElements = [
          ...mount.querySelectorAll(".choice-button-image"),
        ];
        const content = mount.querySelector(".choice-button-content");
        const icon = mount.querySelector(".choice-button-icon");
        const formula = mount.querySelector(".katex");
        if (
          content === null ||
          icon === null ||
          formula === null ||
          imageElements.length !== (mode === "overlay" ? 2 : 1)
        ) {
          root.unmount();
          throw new Error(
            `Choice ${host}/${mode} 探针 DOM 不完整 (images=${imageElements.length}, class=${button.className}, content=${content !== null}, icon=${icon !== null}, formula=${formula !== null})`,
          );
        }
        const images = imageElements.map((image) =>
          rectData(image.getBoundingClientRect()),
        );
        const contentRect = rectData(content.getBoundingClientRect());
        const iconRect = rectData(icon.getBoundingClientRect());
        const formulaRect = rectData(formula.getBoundingClientRect());
        const artworkZ = Math.max(
          ...imageElements.map((image) => computedZIndex(image)),
        );
        const contentZ = computedZIndex(content);
        const imageBoxesMatchButton = images.every((image) =>
          rectMatches(image, buttonRect),
        );
        const contentOverlaysArtwork =
          contentZ > artworkZ &&
          rectHasArea(contentRect) &&
          rectHasArea(iconRect) &&
          rectHasArea(formulaRect) &&
          images.every((image) => rectsOverlap(contentRect, image));
        cases.push({
          host,
          mode,
          button: buttonRect,
          images,
          content: contentRect,
          icon: iconRect,
          formula: formulaRect,
          fallback: fallbackRect,
          imageBoxesMatchButton,
          fallbackHeightMatches: Math.abs(fallbackRect.height - 80) <= 0.01,
          contentOverlaysArtwork,
        });
        root.unmount();
        mount.remove();
      }
    }
  } finally {
    probeRoot.remove();
  }
  return { cases };
}

const CHOICE_PROBE_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='8' height='8' fill='%2300aacc'/%3E%3C/svg%3E";

function choiceProbePrompt(mode: "separate" | "overlay"): ChoicePrompt {
  const button: ButtonSnapshot = {
    id: `probe.${mode}`,
    template: "probe.button",
    asset_mode: mode,
    fit: "stretch",
    normal: "probe.normal",
    hover: "probe.hover",
    pressed: "probe.hover",
    animations: {},
    x: 320,
    y: 248,
    width: 520,
    height: 128,
    rotation_deg: 0,
    scale_x: 1,
    scale_y: 1,
    opacity: 1,
    z: 0,
    visible: true,
    enabled: true,
    action: { sets: [], next: null },
  };
  const choice: ChoiceSnapshot = {
    id: `probe.${mode}`,
    label: "Probe $x^2+y^2$",
    enabled: true,
    icon: "probe.icon",
    template: { kind: "button", button },
    x: button.x,
    y: button.y,
    width: button.width,
    height: button.height,
  };
  const fallbackChoice: ChoiceSnapshot = {
    id: "probe.fallback",
    label: "Probe fallback",
    enabled: true,
    icon: null,
    template: { kind: "fallback" },
    x: 920,
    y: 248,
    width: 320,
    height: 80,
  };
  return {
    kind: "choice",
    prompt_id: `probe/${mode}`,
    layout: {
      stage_width: 1920,
      stage_height: 1080,
      anchor_x: 580,
      anchor_y: 312,
      direction: "vertical",
      gap: 20,
      x: button.x,
      y: button.y,
      width: button.width,
      height: button.height + 20 + fallbackChoice.height,
    },
    diagnostics: [],
    choices: [choice, fallbackChoice],
  };
}

async function settleChoiceProbeDom(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

interface ProbeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectData(rect: DOMRect): ProbeRect {
  return {
    x: roundProbeNumber(rect.x),
    y: roundProbeNumber(rect.y),
    width: roundProbeNumber(rect.width),
    height: roundProbeNumber(rect.height),
  };
}

function roundProbeNumber(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function rectMatches(left: ProbeRect, right: ProbeRect): boolean {
  return (
    Math.abs(left.x - right.x) <= 0.01 &&
    Math.abs(left.y - right.y) <= 0.01 &&
    Math.abs(left.width - right.width) <= 0.01 &&
    Math.abs(left.height - right.height) <= 0.01
  );
}

function rectHasArea(rect: ProbeRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function rectsOverlap(left: ProbeRect, right: ProbeRect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function computedZIndex(element: Element): number {
  const value = getComputedStyle(element).zIndex;
  return value === "auto" ? 0 : Number(value);
}
