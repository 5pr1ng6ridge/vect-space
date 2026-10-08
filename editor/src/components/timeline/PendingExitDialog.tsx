import type { ReactElement } from "react";

/** Asked when leaving the workspace with transforms that were never keyed. */
export function PendingExitDialog({
  onCancel,
  onCommitAndLeave,
  onDiscardAndLeave,
}: {
  onCancel(): void;
  onCommitAndLeave(): void;
  onDiscardAndLeave(): void;
}): ReactElement {
  return (
    <div className="timeline-exit-dialog" role="dialog">
      <div>
        <strong>存在未写入的姿态</strong>
        <p>离开时间轴前如何处理当前修改？</p>
        <div>
          <button onClick={onCommitAndLeave} type="button">
            写入并返回
          </button>
          <button onClick={onDiscardAndLeave} type="button">
            丢弃并返回
          </button>
          <button onClick={onCancel} type="button">
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
