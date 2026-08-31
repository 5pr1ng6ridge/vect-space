import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StoryFlowSnapshot } from "../engine/types";
import { StoryFlowPage } from "./StoryFlowPage";

const FLOW: StoryFlowSnapshot = {
  nodes: [
    {
      scene_id: "main_1",
      title: "主线一",
      x: 240,
      y: 540,
      completed: true,
    },
    {
      scene_id: "branch_1",
      title: "分支一",
      x: 600,
      y: 300,
      completed: false,
    },
  ],
  edges: [
    {
      id: "main_branch",
      from: "main_1",
      to: "branch_1",
      label: "分支",
    },
  ],
};

afterEach(cleanup);

describe("StoryFlowPage", () => {
  it("uses the full viewport with a fixed centered main axis", () => {
    render(<StoryFlowPage flow={FLOW} onClose={() => undefined} />);

    expect(screen.queryByRole("heading", { name: "剧情流程" })).toBeNull();
    expect(screen.getByText("主线一").closest("article")).toHaveClass(
      "main-node",
    );
    expect(screen.getByText("分支一").closest("article")).toHaveClass(
      "branch-node",
    );
    expect(document.querySelector(".story-flow-main-axis")).toHaveAttribute(
      "y1",
      "540",
    );
  });

  it("pans horizontally with the wheel and returns through the floating button", () => {
    const onClose = vi.fn();
    render(<StoryFlowPage flow={FLOW} onClose={onClose} />);
    const canvas = screen.getByRole("region");
    const world = document.querySelector<HTMLElement>(".story-flow-world");
    expect(world?.style.transform).toBe("translate3d(720px, 0, 0)");

    fireEvent.wheel(canvas, { deltaY: 120 });
    expect(world?.style.transform).toBe("translate3d(600px, 0, 0)");

    fireEvent.click(screen.getByRole("button", { name: "返回标题" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
