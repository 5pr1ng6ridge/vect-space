// @vitest-environment jsdom
/**
 * Shared asset chooser: hidden policy, search, keyboard access and the
 * single/multi selection model that every asset seam reuses.
 */
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssetKind, EditorLayout } from "../types";
import {
  AssetChooser,
  AssetLayoutProvider,
  type AssetChooserProps,
} from "./AssetChooser";

afterEach(cleanup);

interface Option {
  id: string;
  kind: AssetKind;
  path?: string;
}

const ASSETS: Option[] = [
  { id: "bg.room", kind: "background", path: "backgrounds/room.png" },
  { id: "bg.old", kind: "background", path: "backgrounds/old.png" },
  { id: "bg.nested", kind: "background", path: "backgrounds/nested.png" },
  { id: "sp.hero", kind: "sprite", path: "sprites/hero.png" },
  { id: "gui.box", kind: "gui", path: "gui/box.png" },
];

const LAYOUT: EditorLayout = {
  version: 1,
  scenes: {},
  asset_folders: {
    archive: { parent_id: null, name: "归档", order: 0 },
    archive_child: { parent_id: "archive", name: "旧子级", order: 0 },
    deep: { parent_id: null, name: "深层", order: 1 },
    deep_more: { parent_id: "deep", name: "更深处", order: 0 },
  },
  asset_metadata: {
    "bg.old": { hidden: true, folder_id: "archive", display_name: "旧客厅" },
    "bg.nested": { folder_id: "deep_more" },
    "bg.room": { display_name: "客厅" },
  },
};

function renderChooser(props: Partial<AssetChooserProps>): void {
  const merged = {
    assets: ASSETS,
    label: "素材",
    value: null,
    onChange: () => undefined,
    ...props,
  } as AssetChooserProps;
  render(
    <AssetLayoutProvider layout={LAYOUT}>
      <AssetChooser {...merged} />
    </AssetLayoutProvider>,
  );
}

function open(): void {
  fireEvent.click(screen.getByRole("button", { name: "素材" }));
}

/** Options inside the popover listbox (not the native filter selects). */
function options(): HTMLElement[] {
  return within(screen.getByRole("listbox")).getAllByRole("option");
}

function optionIds(): (string | null)[] {
  return options().map((option) => option.getAttribute("data-asset-id"));
}

describe("AssetChooser node-field drops", () => {
  const drop = (id: string): void => {
    const trigger = screen.getByRole("button", { name: "素材" });
    const target = trigger.closest(".asset-chooser");
    if (target === null) throw new Error("missing chooser root");
    fireEvent.drop(target, {
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-vect-asset" ? id : "",
      },
    });
  };

  it("assigns only matching asset kinds, preserving the field on mismatch", () => {
    const onChange = vi.fn();
    renderChooser({ kind: "background", value: "bg.room", onChange });
    drop("sp.hero");
    expect(onChange).not.toHaveBeenCalled();
    drop("bg.nested");
    expect(onChange).toHaveBeenCalledWith("bg.nested");
  });

  it("rejects hidden assets and unknown drag IDs, even when the explorer shows them", () => {
    const onChange = vi.fn();
    renderChooser({ kind: "background", onChange });
    drop("bg.old");
    drop("other.id");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adds a matching asset to a multi-value field", () => {
    const onChange = vi.fn();
    renderChooser({
      multiple: true,
      kind: "background",
      value: ["bg.room"],
      onChange,
    });
    drop("bg.nested");
    expect(onChange).toHaveBeenCalledWith(["bg.room", "bg.nested"]);
  });
});

describe("AssetChooser hidden policy", () => {
  it("excludes hidden assets from new choices and shows display names", () => {
    renderChooser({});
    expect(screen.getByRole("button", { name: "素材" })).toHaveTextContent(
      "— 请选择 —",
    );
    open();
    expect(optionIds()).not.toContain("bg.old");
    expect(
      options().find(
        (option) => option.getAttribute("data-asset-id") === "bg.room",
      ),
    ).toHaveTextContent("客厅");
  });

  it("keeps a currently selected hidden id visible and marked", () => {
    renderChooser({ value: "bg.old" });
    expect(screen.getByRole("button", { name: "素材" })).toHaveTextContent(
      "旧客厅",
    );
    open();
    const option = options().find(
      (candidate) => candidate.getAttribute("data-asset-id") === "bg.old",
    );
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(option).toHaveTextContent("已隐藏");
    expect(option).toHaveTextContent("目录：归档");
  });
});

describe("AssetChooser search and keyboard", () => {
  it("searches display name, id, path and folder case-insensitively", () => {
    renderChooser({ includeHidden: true });
    open();
    const search = screen.getByLabelText("搜索素材");
    fireEvent.change(search, { target: { value: "ROOM" } });
    expect(optionIds()).toEqual(["bg.room"]);
    fireEvent.change(search, { target: { value: "sprites/hero" } });
    expect(optionIds()).toEqual(["sp.hero"]);
    fireEvent.change(search, { target: { value: "归档" } });
    expect(optionIds()).toEqual(["bg.old"]);
  });

  it("commits with the keyboard and closes on Escape", () => {
    const onChange = vi.fn();
    renderChooser({ onChange });
    open();
    const search = screen.getByLabelText("搜索素材");
    const first = options()[0].getAttribute("data-asset-id");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(first);
    expect(screen.queryByRole("listbox")).toBeNull();

    open();
    const arrow = screen.getByLabelText("搜索素材");
    const second = options()[1].getAttribute("data-asset-id");
    fireEvent.keyDown(arrow, { key: "ArrowDown" });
    fireEvent.keyDown(arrow, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(second);

    open();
    fireEvent.keyDown(screen.getByLabelText("搜索素材"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clears the value through the explicit none option", () => {
    const onChange = vi.fn();
    renderChooser({ allowEmpty: true, onChange, value: "bg.room" });
    open();
    fireEvent.click(screen.getByRole("option", { name: "— 无 —" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("filters by kind and folder inside the popover", () => {
    renderChooser({ kind: ["background", "sprite"] });
    open();
    fireEvent.change(screen.getByLabelText("素材类型筛选"), {
      target: { value: "sprite" },
    });
    expect(optionIds()).toEqual(["sp.hero"]);
    fireEvent.change(screen.getByLabelText("素材类型筛选"), {
      target: { value: "all" },
    });
    // A folder id includes the folder and its descendants.
    fireEvent.change(screen.getByLabelText("文件夹筛选"), {
      target: { value: "deep" },
    });
    expect(optionIds()).toEqual(["bg.nested"]);
    // The root option means *unassigned only*: bg.nested lives in a nested
    // folder and must not be included.
    fireEvent.change(screen.getByLabelText("文件夹筛选"), {
      target: { value: "" },
    });
    expect(optionIds().sort()).toEqual(["bg.room", "sp.hero"]);
  });
});

describe("AssetChooser multi selection", () => {
  it("toggles several ids and keeps a hidden current pick", () => {
    const onChange = vi.fn();
    renderChooser({
      multiple: true,
      onChange,
      value: ["bg.old"],
    });
    open();
    expect(screen.getByRole("button", { name: "素材" })).toHaveTextContent(
      "已选 1 项",
    );
    expect(optionIds()).toContain("bg.old");
    fireEvent.click(
      options().find(
        (option) => option.getAttribute("data-asset-id") === "sp.hero",
      ) as HTMLElement,
    );
    expect(onChange).toHaveBeenLastCalledWith(["bg.old", "sp.hero"]);
    fireEvent.click(
      options().find(
        (option) => option.getAttribute("data-asset-id") === "bg.old",
      ) as HTMLElement,
    );
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
