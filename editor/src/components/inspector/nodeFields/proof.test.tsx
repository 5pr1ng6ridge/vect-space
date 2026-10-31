// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proofFields } from "./proof";
import type { FieldsContext } from "../fieldsContext";
import { storyProject } from "../../../test/storyProject";

afterEach(cleanup);

describe("proof inspector", () => {
  it("lists puzzle titles, edits both destinations and removes optional abandon", () => {
    const project = storyProject();
    project.proofs = [
      {
        path: "proofs/basics.yaml",
        definition: {
          puzzles: [{ id: "truth", title: "真命题", goal: "True" }],
        },
      },
    ];
    const node = {
      type: "proof" as const,
      puzzle: "truth",
      next: "left",
      abandon: "right",
    };
    const update = vi.fn();
    const context = {
      update,
      targets: ["left", "right", "end"],
      preview: { project },
    } as unknown as FieldsContext;
    render(<>{proofFields(node, context)}</>);
    expect(
      screen.getByRole("option", { name: "真命题 (truth)" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("证明题"), {
      target: { value: "" },
    });
    expect(update).toHaveBeenLastCalledWith({ ...node, puzzle: "" });
    fireEvent.change(screen.getByLabelText("证明完成后"), {
      target: { value: "end" },
    });
    expect(update).toHaveBeenLastCalledWith({ ...node, next: "end" });
    fireEvent.change(screen.getByLabelText("放弃后"), {
      target: { value: "" },
    });
    expect(update).toHaveBeenLastCalledWith({
      type: "proof",
      puzzle: "truth",
      next: "left",
    });
    expect(
      screen.getByRole("option", { name: "不允许放弃" }),
    ).toBeInTheDocument();
  });
});
