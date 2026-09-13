import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

import type {
  ButtonSnapshot,
  ChoicePrompt,
  ChoiceSnapshot,
} from "@vectspace/presentation-core/types";

import { ChoiceLayer } from "./ChoiceLayer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function buttonSnapshot(
  overrides: Partial<ButtonSnapshot> = {},
): ButtonSnapshot {
  return {
    id: "option_a",
    template: "choice.primary",
    asset_mode: "separate",
    fit: "stretch",
    normal: "gui.button_normal",
    hover: "gui.button_hover",
    pressed: "gui.button_pressed",
    animations: {},
    x: 0,
    y: 0,
    width: 320,
    height: 88,
    rotation_deg: 0,
    scale_x: 1,
    scale_y: 1,
    opacity: 1,
    z: 0,
    visible: true,
    enabled: true,
    action: { sets: [], next: null },
    ...overrides,
  };
}

function choice(overrides: Partial<ChoiceSnapshot> = {}): ChoiceSnapshot {
  return {
    id: "option_a",
    label: "选项 A",
    enabled: true,
    icon: null,
    template: { kind: "fallback" },
    x: 470,
    y: 360,
    width: 980,
    height: 92,
    ...overrides,
  };
}

function prompt(
  choices: ChoiceSnapshot[],
  overrides: Partial<ChoicePrompt> = {},
): ChoicePrompt {
  return {
    kind: "choice",
    prompt_id: "scene/choice",
    layout: {
      stage_width: 1920,
      stage_height: 1080,
      anchor_x: 960,
      anchor_y: 540,
      direction: "vertical",
      gap: 20,
      x: 470,
      y: 360,
      width: 980,
      height: choices.length * 112 - 20,
    },
    diagnostics: [],
    choices,
    ...overrides,
  };
}

describe("ChoiceLayer", () => {
  it("places every item on its resolved design-pixel rect", () => {
    const items = [
      choice({
        id: "a",
        label: "选项 A",
        x: 470,
        y: 360,
        width: 980,
        height: 92,
      }),
      choice({
        id: "b",
        label: "选项 B",
        x: 800,
        y: 472,
        width: 320,
        height: 88,
      }),
    ];
    render(
      <ChoiceLayer
        assets={{}}
        onChoose={() => undefined}
        prompt={prompt(items)}
      />,
    );
    const first = screen.getByRole("button", { name: /选项 A/ });
    const second = screen
      .getAllByRole("button")
      .find((element) => element.getAttribute("data-choice-id") === "b");
    expect(first).toHaveStyle({ left: "470px", top: "360px" });
    expect(second).toHaveStyle({
      left: "800px",
      top: "472px",
      width: "320px",
      height: "88px",
    });
    expect(first).toHaveClass("choice-button-fallback");
  });

  it("keeps sub-92px resolved fallback and artwork-error heights exact", () => {
    const items = [
      choice({ id: "normal_fallback", label: "普通回退", height: 80 }),
      choice({
        id: "error_fallback",
        label: "贴图回退",
        height: 88,
        template: {
          kind: "button",
          button: buttonSnapshot({
            id: "error_fallback",
            normal: "gui.missing",
            height: 88,
          }),
        },
      }),
    ];
    render(
      <ChoiceLayer
        assets={{ "gui.missing": "missing.png" }}
        onChoose={() => undefined}
        prompt={prompt(items)}
      />,
    );

    const normal = screen.getByRole("button", { name: "普通回退" });
    expect(normal).toHaveClass("choice-button-fallback");
    expect(normal).toHaveStyle({ height: "80px" });
    const error = screen.getByRole("button", { name: "贴图回退" });
    const image = error.querySelector(".choice-button-image");
    expect(error).toHaveStyle({ height: "88px" });
    act(() => image?.dispatchEvent(new Event("error")));
    expect(error).toHaveClass("choice-button-fallback");
    expect(error).toHaveStyle({ height: "88px" });
  });

  it("renders the resolved template skin, gui icon and KaTeX label", () => {
    const items = [
      choice({
        id: "a",
        label: "面积 $A=\\pi r^2$",
        icon: "gui.icon.a",
        template: {
          kind: "button",
          button: buttonSnapshot({ normal: "gui.skin_n", hover: "gui.skin_h" }),
        },
      }),
    ];
    const { container } = render(
      <ChoiceLayer
        assets={{
          "gui.icon.a": "icon.png",
          "gui.skin_n": "skin_normal.png",
          "gui.skin_h": "skin_hover.png",
        }}
        onChoose={() => undefined}
        prompt={prompt(items)}
      />,
    );
    const element = screen.getByRole("button", { name: /A=\\pi r\^2/ });
    expect(element).not.toHaveClass("choice-button-fallback");
    expect(element.querySelector(".choice-button-icon")).toHaveAttribute(
      "src",
      "icon.png",
    );
    expect(element.querySelector(".choice-button-image")).toHaveAttribute(
      "src",
      "skin_normal.png",
    );
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".choice-button-label")).not.toBeNull();
  });

  it("reuses the scene-button state machine for template artwork", () => {
    const items = [
      choice({
        id: "a",
        template: {
          kind: "button",
          button: buttonSnapshot({
            normal: "gui.skin_n",
            hover: "gui.skin_h",
            pressed: "gui.skin_p",
          }),
        },
      }),
    ];
    render(
      <ChoiceLayer
        assets={{
          "gui.skin_n": "skin_normal.png",
          "gui.skin_h": "skin_hover.png",
          "gui.skin_p": "skin_pressed.png",
        }}
        onChoose={() => undefined}
        prompt={prompt(items)}
      />,
    );
    const element = screen.getByRole("button", { name: /选项 A/ });
    fireEvent.pointerEnter(element);
    expect(element).toHaveClass("choice-button-hover");
    expect(element.querySelector(".choice-button-image")).toHaveAttribute(
      "src",
      "skin_hover.png",
    );
    fireEvent.pointerDown(element, {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 1,
    });
    expect(element).toHaveClass("choice-button-pressed");
    expect(element.querySelector(".choice-button-image")).toHaveAttribute(
      "src",
      "skin_pressed.png",
    );
  });

  it("activates on a native click and on the keyboard, but not when disabled", () => {
    const onChoose = vi.fn();
    const items = [
      choice({ id: "ready", label: "可以选" }),
      choice({ id: "locked", label: "不能选", enabled: false }),
    ];
    render(
      <ChoiceLayer assets={{}} onChoose={onChoose} prompt={prompt(items)} />,
    );
    const ready = screen.getByRole("button", { name: "可以选" });
    const locked = screen.getByRole("button", { name: "不能选" });
    expect(locked).toBeDisabled();

    fireEvent.click(ready);
    expect(onChoose).toHaveBeenCalledWith("ready");

    fireEvent.click(locked);
    expect(onChoose).toHaveBeenCalledTimes(1);

    // Native activation path: Enter on a focused button produces a click.
    ready.focus();
    expect(document.activeElement).toBe(ready);
    fireEvent.keyDown(ready, { key: "Enter" });
    fireEvent.click(ready);
    expect(onChoose).toHaveBeenCalledTimes(2);
  });

  it("blocks the whole group when the host is busy", () => {
    const onChoose = vi.fn();
    render(
      <ChoiceLayer
        assets={{}}
        disabled
        onChoose={onChoose}
        prompt={prompt([choice({ id: "a" })])}
      />,
    );
    const element = screen.getByRole("button", { name: /选项 A/ });
    expect(element).toBeDisabled();
    fireEvent.click(element);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("keeps keyboard focus across a harmless re-render", () => {
    const onChoose = vi.fn();
    const { rerender } = render(
      <ChoiceLayer
        assets={{}}
        onChoose={onChoose}
        prompt={prompt([
          choice({ id: "a", label: "选项 A" }),
          choice({ id: "b", label: "选项 B" }),
        ])}
      />,
    );
    const focused = screen.getByRole("button", { name: "选项 A" });
    focused.focus();
    expect(document.activeElement).toBe(focused);

    // Same prompt identity, brand-new snapshot objects: this is what a story
    // re-render looks like.
    rerender(
      <ChoiceLayer
        assets={{}}
        onChoose={onChoose}
        prompt={prompt([
          choice({ id: "a", label: "选项 A" }),
          choice({ id: "b", label: "选项 B" }),
        ])}
      />,
    );
    const after = screen.getByRole("button", { name: "选项 A" });
    expect(after).toBe(focused);
    expect(document.activeElement).toBe(after);
  });

  it("releases focus safely when the prompt changes or an item disappears", () => {
    const onChoose = vi.fn();
    const { rerender } = render(
      <ChoiceLayer
        assets={{}}
        onChoose={onChoose}
        prompt={prompt([
          choice({ id: "a", label: "选项 A" }),
          choice({ id: "b", label: "选项 B" }),
        ])}
      />,
    );
    const focused = screen.getByRole("button", { name: "选项 A" });
    focused.focus();
    expect(document.activeElement).toBe(focused);

    // A new prompt id reuses the mounted layer: focus must not stay on an item
    // that belongs to the previous prompt.
    rerender(
      <ChoiceLayer
        assets={{}}
        onChoose={onChoose}
        prompt={{
          ...prompt([
            choice({ id: "a", label: "选项 A" }),
            choice({ id: "b", label: "选项 B" }),
          ]),
          prompt_id: "scene/other_choice",
        }}
      />,
    );
    expect(document.activeElement).not.toBe(focused);

    const next = screen.getByRole("button", { name: "选项 A" });
    next.focus();
    rerender(
      <ChoiceLayer
        assets={{}}
        onChoose={onChoose}
        prompt={{
          ...prompt([choice({ id: "b", label: "只剩下 B" })]),
          prompt_id: "scene/other_choice",
        }}
      />,
    );
    expect(document.activeElement).toBe(document.body);
  });

  it("falls back to the text skin when an icon or template artwork is missing", () => {
    const onChoose = vi.fn();
    const items = [
      choice({ id: "missing_icon", label: "图标缺失", icon: "gui.unknown" }),
      choice({
        id: "missing_art",
        label: "贴图缺失",
        template: {
          kind: "button",
          button: buttonSnapshot({ normal: "gui.missing" }),
        },
      }),
    ];
    render(
      <ChoiceLayer assets={{}} onChoose={onChoose} prompt={prompt(items)} />,
    );
    for (const element of screen.getAllByRole("button")) {
      expect(element).toHaveClass("choice-button-fallback");
      expect(element.querySelector(".choice-button-image")).toBeNull();
      expect(element.querySelector(".choice-button-icon")).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "贴图缺失" }));
    expect(onChoose).toHaveBeenCalledWith("missing_art");
  });

  it("reports runtime diagnostics once per distinct problem", () => {
    const onDiagnostic = vi.fn();
    const diagnostics = [
      {
        code: "missing_template" as const,
        message: "未知模板",
        scene_id: "scene",
        node_id: "choice",
        choice_id: "a",
      },
    ];
    const { rerender } = render(
      <ChoiceLayer
        assets={{}}
        onChoose={() => undefined}
        onDiagnostic={onDiagnostic}
        prompt={prompt([choice({ id: "a" })], { diagnostics })}
      />,
    );
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    rerender(
      <ChoiceLayer
        assets={{}}
        onChoose={() => undefined}
        onDiagnostic={onDiagnostic}
        prompt={prompt([choice({ id: "a" })], {
          diagnostics: [...diagnostics],
        })}
      />,
    );
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
  });

  it("keeps a mounted animation clock alive across a re-render", () => {
    vi.useFakeTimers();
    const animation = {
      id: "anim.choice_hover",
      width: 320,
      height: 88,
      total_duration_ms: 400,
      frames: [
        { asset: "hover_a", duration_ms: 200, url: "hover_a.png" },
        { asset: "hover_b", duration_ms: 200, url: "hover_b.png" },
      ],
    };
    const items = [
      choice({
        id: "a",
        template: {
          kind: "button",
          button: buttonSnapshot({
            normal: "gui.skin_n",
            hover: "gui.anim_hover",
          }),
        },
      }),
    ];
    const assets = {
      "gui.skin_n": "skin_normal.png",
      "gui.anim_hover": "hover_a.png",
    };
    const renderLayer = (): ReactElement => (
      <ChoiceLayer
        animations={{ "gui.anim_hover": animation }}
        assets={assets}
        onChoose={() => undefined}
        prompt={prompt(items)}
      />
    );
    const { rerender } = render(renderLayer());
    act(() => {
      vi.advanceTimersByTime(16);
    });
    const element = screen.getByRole("button", { name: /选项 A/ });
    fireEvent.pointerEnter(element);
    expect(element.querySelector(".choice-button-image")).toHaveAttribute(
      "src",
      "hover_a.png",
    );
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(element.querySelector(".choice-button-image")).toHaveAttribute(
      "src",
      "hover_b.png",
    );
    rerender(renderLayer());
    expect(element.querySelector(".choice-button-image")).toHaveAttribute(
      "src",
      "hover_b.png",
    );
    vi.useRealTimers();
  });
});
