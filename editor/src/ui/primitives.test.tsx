// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Plus, Trash2 } from "lucide-react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IconButton } from "./Button";
import { ConfirmProvider } from "./Dialog";
import { useConfirm, useToast } from "./feedbackContext";
import { ContextMenuArea } from "./Menu";
import { ToastProvider } from "./Toast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("IconButton", () => {
  it("is named by its label and reports toggle state", () => {
    render(<IconButton active icon={Plus} label="添加节点" />);
    const button = screen.getByRole("button", { name: "添加节点" });
    expect(button).toHaveAttribute("aria-pressed", "true");
  });
});

function ConfirmHarness({
  onResult,
}: {
  onResult(value: boolean): void;
}): ReactElement {
  const confirm = useConfirm();
  return (
    <button
      onClick={() =>
        void confirm({
          title: "删除场景？",
          description: "原 YAML 文件会保留。",
          confirmLabel: "删除场景",
          danger: true,
        }).then(onResult)
      }
      type="button"
    >
      请求确认
    </button>
  );
}

describe("ConfirmProvider", () => {
  it("resolves true from the consequence-named button", async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <ConfirmHarness onResult={onResult} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "请求确认" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("删除场景？");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "删除场景" }));
      await Promise.resolve();
    });
    expect(onResult).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves false when cancelled", async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <ConfirmHarness onResult={onResult} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "请求确认" }));
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      await Promise.resolve();
    });
    expect(onResult).toHaveBeenCalledWith(false);
  });
});

function ToastHarness(): ReactElement {
  const toast = useToast();
  const [undone, setUndone] = useState(false);
  return (
    <>
      <button
        onClick={() =>
          toast.show({
            tone: "success",
            message: "已删除节点",
            action: { label: "撤销", onAction: () => setUndone(true) },
          })
        }
        type="button"
      >
        成功
      </button>
      <button
        onClick={() => toast.show({ tone: "error", message: "保存失败" })}
        type="button"
      >
        失败
      </button>
      {undone && <p>已撤销</p>}
    </>
  );
}

describe("ToastProvider", () => {
  it("fades success toasts but keeps errors until dismissed", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "成功" }));
    fireEvent.click(screen.getByRole("button", { name: "失败" }));
    expect(screen.getByText("已删除节点")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText("已删除节点")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("保存失败");
    fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("runs the toast action once and closes the toast", () => {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "成功" }));
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getByText("已撤销")).toBeInTheDocument();
    expect(screen.queryByText("已删除节点")).toBeNull();
  });
});

describe("ContextMenuArea", () => {
  it("marks its trigger for the desktop context-menu guard and opens", async () => {
    const onSelect = vi.fn();
    render(
      <ContextMenuArea
        entries={[
          { id: "delete", label: "删除", icon: Trash2, danger: true, onSelect },
        ]}
        label="节点操作"
      >
        <div>节点</div>
      </ContextMenuArea>,
    );
    const trigger = screen.getByText("节点");
    expect(trigger).toHaveAttribute("data-allow-context-menu", "true");
    fireEvent.contextMenu(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    expect(onSelect).toHaveBeenCalled();
  });
});
