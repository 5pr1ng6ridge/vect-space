import { useCallback, useEffect, useState, type ReactElement } from "react";
import { assetUrl, editorApi } from "../api";
import type { EditorAsset, RuntimeUpdate } from "../types";
import { autoReadingDelay } from "../playback";
import { MarkupPreview } from "./MarkupPreview";

export function PreviewPanel({
  assets,
  dirty,
  onNavigate,
}: {
  assets: EditorAsset[];
  dirty: boolean;
  onNavigate(sceneId: string, nodeId: string): void;
}): ReactElement {
  const [update, setUpdate] = useState<RuntimeUpdate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urls = Object.fromEntries(
    assets.map((asset) => [asset.id, assetUrl(asset.absolute_path)]),
  );
  const run = useCallback(
    async (operation: () => Promise<RuntimeUpdate>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const next = await operation();
        setUpdate(next);
        onNavigate(
          next.snapshot.location.scene_id,
          next.snapshot.location.node_id,
        );
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
      }
    },
    [onNavigate],
  );
  const prompt = update?.snapshot.prompt;
  useEffect(() => {
    if (
      update === null ||
      busy ||
      update.requires_ack ||
      prompt?.kind !== "dialogue" ||
      update.snapshot.playback.auto !== "forced"
    ) {
      return;
    }
    const timer = window.setTimeout(
      () =>
        void run(() =>
          editorApi.previewAdvance(update.snapshot.revision, "forced_auto"),
        ),
      autoReadingDelay(prompt.text),
    );
    return () => window.clearTimeout(timer);
  }, [busy, prompt, run, update]);
  return (
    <div className="preview-panel">
      <div className="preview-controls">
        <button
          disabled={busy || dirty}
          onClick={() => void run(editorApi.previewStart)}
          type="button"
        >
          ▶ 从项目入口试玩
        </button>
        {dirty && <span>保存更改后才能试玩最新内容</span>}
        {update !== null && (
          <>
            <code>
              {update.snapshot.location.scene_id}/
              {update.snapshot.location.node_id} · rev{" "}
              {update.snapshot.revision}
            </code>
            <span>
              {update.snapshot.playback.auto === "forced"
                ? "强制自动"
                : "普通自动"}
              {" · Ctrl "}
              {update.snapshot.playback.ctrl_fast_forward === "block"
                ? "禁止"
                : "允许"}
            </span>
          </>
        )}
      </div>
      {error !== null && <div className="preview-error">{error}</div>}
      <div className="preview-workspace">
        <div className="preview-stage">
          {update?.snapshot.world.background !== null &&
            update?.snapshot.world.background !== undefined && (
              <img
                className="preview-background"
                src={urls[update.snapshot.world.background]}
                alt="背景"
              />
            )}
          {update !== null &&
            Object.entries(update.snapshot.world.sprites)
              .sort(([, left], [, right]) => left.z - right.z)
              .map(([id, sprite]) => (
                <img
                  alt={id}
                  className="preview-sprite"
                  key={id}
                  src={urls[sprite.asset]}
                  style={{
                    left: `${(sprite.x / 1920) * 100}%`,
                    top: `${(sprite.y / 1080) * 100}%`,
                    opacity: sprite.opacity,
                    transform: `translate(-50%, -100%) scale(${sprite.scale})`,
                    zIndex: sprite.z,
                  }}
                />
              ))}
          {update === null && (
            <div className="preview-placeholder">
              保存项目后，从入口开始试玩
            </div>
          )}
        </div>
        <div className="preview-prompt">
          {prompt?.kind === "dialogue" && (
            <>
              <strong style={{ color: prompt.name_color ?? undefined }}>
                {prompt.speaker ?? "旁白"}
              </strong>
              <div style={{ color: prompt.text_color ?? undefined }}>
                <MarkupPreview source={prompt.text} />
              </div>
              <button
                disabled={
                  busy ||
                  (update?.requires_ack ?? false) ||
                  update?.snapshot.playback.auto === "forced"
                }
                onClick={() => {
                  if (update !== null)
                    void run(() =>
                      editorApi.previewAdvance(
                        update.snapshot.revision,
                        "manual",
                      ),
                    );
                }}
                type="button"
              >
                推进对话
              </button>
            </>
          )}
          {prompt?.kind === "choice" && (
            <div className="preview-choices">
              {prompt.choices.map((choice) => (
                <button
                  disabled={busy || !choice.enabled || update?.requires_ack}
                  key={choice.id}
                  onClick={() => {
                    if (update !== null) {
                      void run(() =>
                        editorApi.previewChoose(
                          choice.id,
                          update.snapshot.revision,
                        ),
                      );
                    }
                  }}
                  type="button"
                >
                  <MarkupPreview source={choice.label} />
                </button>
              ))}
            </div>
          )}
          {prompt?.kind === "end" && (
            <strong className="preview-end">END</strong>
          )}
          {update?.requires_ack && (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  editorApi.previewPresentationComplete(update.update_id),
                )
              }
              type="button"
            >
              完成 awaited 表现
            </button>
          )}
          {update !== null &&
            prompt?.kind === "none" &&
            !update.requires_ack && <span>运行时正在等待下一次更新。</span>}
        </div>
      </div>
    </div>
  );
}
