// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { EditorAsset, TimelineNode } from "../types";
import { TimelineEditor } from "./TimelineEditor";

const INITIAL_NODE: TimelineNode = {
  type: "timeline",
  duration_ms: 1_000,
  await: true,
  skippable: true,
  tracks: [
    { type: "ambience", slot: "slot_2", channels: {} },
    { type: "camera", channels: {} },
  ],
  events: [],
  next: "end",
};

function Harness(): ReactElement {
  const [node, setNode] = useState(INITIAL_NODE);
  return (
    <>
      <TimelineEditor
        assets={[] as EditorAsset[]}
        hidePreview
        node={node}
        onChange={setNode}
      />
      <output data-testid="node-json">{JSON.stringify(node)}</output>
    </>
  );
}

/** Track headers of the ambience tracks, in display order. */
function ambienceTrackTitles(): string[] {
  return Array.from(document.querySelectorAll(".timeline-track-head strong"))
    .map((title) => title.textContent ?? "")
    .filter((title) => title.startsWith("环境声"));
}

describe("ambience timeline authoring", () => {
  it("assigns unused fixed slots, exposes volume automation, and caps at four tracks", () => {
    render(<Harness />);
    const trackType = screen.getAllByRole("combobox")[0];
    if (trackType === undefined) throw new Error("missing track type selector");
    fireEvent.change(trackType, { target: { value: "ambience" } });

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "＋轨道" }));
    }

    expect(ambienceTrackTitles()).toEqual([
      "环境声 2",
      "环境声 1",
      "环境声 3",
      "环境声 4",
    ]);

    // The shared toolbar channel switches to the only ambience channel.
    const comboboxes = screen.getAllByRole<HTMLSelectElement>("combobox");
    expect(comboboxes.some((field) => field.value === "volume")).toBe(true);
    const keyframeButton = screen.getAllByRole("button", {
      name: "＋关键帧",
    })[0];
    if (keyframeButton === undefined)
      throw new Error("missing ambience keyframe button");
    fireEvent.click(keyframeButton);
    expect(screen.getByTestId("node-json").textContent).toContain(
      '"volume":[{"at_ms":0,"value":1,"easing":"linear"}]',
    );

    // The fifth add is ignored rather than creating a duplicate slot or an
    // unaddressable fifth ambience lane.
    fireEvent.click(screen.getByRole("button", { name: "＋轨道" }));
    expect(ambienceTrackTitles()).toHaveLength(4);
  });
});
