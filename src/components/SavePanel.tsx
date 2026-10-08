import type { ReactElement } from "react";

import type { SaveSlotSummary } from "@vectspace/presentation-core/types";

interface SavePanelProps {
  slots: SaveSlotSummary[];
  canSave: boolean;
  onSave(slot: string): void;
  onLoad(slot: string): void;
  onClose(): void;
}

export function SavePanel({
  slots,
  canSave,
  onSave,
  onLoad,
  onClose,
}: SavePanelProps): ReactElement {
  return (
    <div className="modal-backdrop">
      <section className="modal-panel save-panel" aria-label="存档">
        <header>
          <div>
            <p className="eyebrow">SNAPSHOT ONLY</p>
            <h2>存档与读档</h2>
          </div>
          <button onClick={onClose} type="button">
            关闭
          </button>
        </header>
        <div className="slot-grid">
          {slots.map((slot) => (
            <article className="save-slot" key={slot.slot}>
              {slot.thumbnail_data_url !== null ? (
                <img alt="场景缩略图" src={slot.thumbnail_data_url} />
              ) : (
                <div className="empty-thumbnail">NO DATA</div>
              )}
              <div className="slot-copy">
                <strong>
                  {slot.slot === "auto" ? "自动存档" : `手动槽 ${slot.slot}`}
                </strong>
                <span>{formatTimestamp(slot.saved_at_unix_ms)}</span>
                <p>{slot.prompt_preview ?? "空存档"}</p>
              </div>
              <div className="slot-actions">
                {slot.slot !== "auto" && (
                  <button
                    disabled={!canSave}
                    onClick={() => onSave(slot.slot)}
                    type="button"
                  >
                    保存
                  </button>
                )}
                <button
                  disabled={!slot.exists}
                  onClick={() => onLoad(slot.slot)}
                  type="button"
                >
                  读取
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function formatTimestamp(value: number | null): string {
  return value === null
    ? "—"
    : new Date(value).toLocaleString("zh-CN", { hour12: false });
}
