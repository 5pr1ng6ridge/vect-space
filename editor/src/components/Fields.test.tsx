// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { flushPendingCommits, pendingCommitCount } from "../ui/pendingCommits";
import { DeferredInput } from "./Fields";

afterEach(cleanup);

function renderInput(value = "原值") {
  const onCommit = vi.fn();
  render(<DeferredInput aria-label="字段" onCommit={onCommit} value={value} />);
  return { input: screen.getByLabelText("字段"), onCommit };
}

describe("DeferredInput", () => {
  it("commits once on blur and not on every keystroke", () => {
    const { input, onCommit } = renderInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "新" } });
    fireEvent.change(input, { target: { value: "新值" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("新值");
  });

  it("reverts on Esc and ignores Enter while an IME composes", () => {
    const { input, onCommit } = renderInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zhong" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("原值");
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("is flushed by the pending-commit registry while focused", () => {
    const { input, onCommit } = renderInput();
    fireEvent.focus(input);
    expect(pendingCommitCount()).toBe(1);
    fireEvent.change(input, { target: { value: "快捷键保存" } });
    act(() => flushPendingCommits());
    expect(onCommit).toHaveBeenCalledWith("快捷键保存");
    fireEvent.blur(input);
    expect(pendingCommitCount()).toBe(0);
  });

  it("restores the committed value when onCommit rejects the draft", () => {
    const onCommit = vi.fn(() => false);
    render(<DeferredInput aria-label="字段" onCommit={onCommit} value="1" />);
    const input = screen.getByLabelText("字段");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(input).toHaveValue("1");
  });
});
