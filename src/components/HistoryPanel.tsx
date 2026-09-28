import { useEffect, useRef, type ReactElement } from "react";

import type { DialogueHistoryEntry } from "@vectspace/presentation-core/types";
import { MarkupText } from "@vectspace/presentation-react/gameplay";

export function HistoryPanel({
  entries,
  onClose,
}: {
  entries: DialogueHistoryEntry[];
  onClose(): void;
}): ReactElement {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [entries]);
  return (
    <div className="modal-backdrop history-backdrop" data-block-story-advance>
      <section className="modal-panel history-panel" aria-label="历史记录">
        <header>
          <div>
            <p className="eyebrow">GLOBAL DIALOGUE LOG</p>
            <h2>历史记录</h2>
          </div>
          <button onClick={onClose} type="button">
            关闭
          </button>
        </header>
        <div className="history-list" ref={listRef}>
          {entries.length === 0 ? (
            <p className="history-empty">尚无对话记录。</p>
          ) : (
            entries.map((entry) => (
              <article className="history-entry" key={entry.entry_id}>
                {entry.speaker !== null && (
                  <strong style={{ color: entry.name_color ?? undefined }}>
                    {entry.speaker}
                  </strong>
                )}
                <div style={{ color: entry.text_color ?? undefined }}>
                  <MarkupText source={entry.text} />
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
