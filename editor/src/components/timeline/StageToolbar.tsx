import type { ReactElement } from "react";
import {
  SCREEN_EFFECT_PRESETS,
  findScreenEffectPreset,
  type ScreenEffectPreset,
} from "../../screenEffectPresets";
import type { TimelineEvent, TimelineTrack } from "../../types";
import type { Tool } from "./gizmo";

/** Tool switch and "add" actions under the preview stage. */
export function StageToolbar({
  addTrackDisabled,
  addTrackTitle,
  buttonInstanceIds,
  hasPendingEdits,
  newTrackType,
  onAddEvent,
  onAddPreset,
  onAddTrack,
  onButtonInstanceChange,
  onCommitPending,
  onNewTrackTypeChange,
  onStop,
  onToolChange,
  selectedButtonInstanceId,
  sfxAvailable,
  tool,
}: {
  addTrackDisabled: boolean;
  addTrackTitle: string | undefined;
  buttonInstanceIds: readonly string[];
  /** Un-keyed transforms exist (auto-key is off). */
  hasPendingEdits: boolean;
  newTrackType: TimelineTrack["type"];
  onAddEvent(kind: TimelineEvent["type"]): void;
  onAddPreset(preset: ScreenEffectPreset): void;
  onAddTrack(): void;
  onButtonInstanceChange(instanceId: string): void;
  onCommitPending(): void;
  onNewTrackTypeChange(type: TimelineTrack["type"]): void;
  onStop(): void;
  onToolChange(tool: Tool): void;
  selectedButtonInstanceId: string;
  sfxAvailable: boolean;
  tool: Tool;
}): ReactElement {
  return (
    <div className="timeline-workspace-controls">
      <button onClick={onStop} type="button">
        ■
      </button>
      <button
        className={tool === "select" ? "active" : ""}
        onClick={() => onToolChange("select")}
        type="button"
      >
        选择
      </button>
      <button
        className={tool === "camera" ? "active" : ""}
        onClick={() => onToolChange("camera")}
        type="button"
      >
        镜头
      </button>
      {hasPendingEdits && (
        <button onClick={onCommitPending} type="button">
          写入所改通道
        </button>
      )}
      <select
        aria-label="新建轨道类型"
        onChange={(event) =>
          onNewTrackTypeChange(
            event.currentTarget.value as TimelineTrack["type"],
          )
        }
        value={newTrackType}
      >
        <option value="sprite">Sprite 轨</option>
        <option value="emitter">发射器整体轨</option>
        <option value="camera">镜头轨</option>
        <option value="video">视频轨</option>
        <option value="bgm">BGM 轨</option>
        <option value="ambience">环境声轨</option>
        <option value="button">按钮轨</option>
      </select>
      {newTrackType === "button" && (
        <select
          aria-label="按钮实例"
          disabled={buttonInstanceIds.length === 0}
          onChange={(event) =>
            onButtonInstanceChange(event.currentTarget.value)
          }
          value={selectedButtonInstanceId}
        >
          {buttonInstanceIds.length === 0 && (
            <option value="">暂无按钮实例</option>
          )}
          {buttonInstanceIds.map((instanceId) => (
            <option key={instanceId} value={instanceId}>
              {instanceId}
            </option>
          ))}
        </select>
      )}
      <button
        disabled={addTrackDisabled}
        onClick={onAddTrack}
        title={addTrackTitle}
        type="button"
      >
        ＋轨道
      </button>
      <button
        disabled={!sfxAvailable}
        onClick={() => onAddEvent("sfx")}
        title={
          sfxAvailable
            ? undefined
            : "没有可用的音效素材（或全部已隐藏），无法新建 SFX 事件"
        }
        type="button"
      >
        ＋SFX
      </button>
      <button onClick={() => onAddEvent("screen_effect")} type="button">
        ＋闪光
      </button>
      <select
        aria-label="插入演出预设"
        onChange={(event) => {
          const preset = findScreenEffectPreset(event.currentTarget.value);
          if (preset !== undefined) onAddPreset(preset);
        }}
        title="在播放头处插入一组组合好的屏幕效果事件，插入后可逐个调整"
        value=""
      >
        <option value="">＋演出预设…</option>
        {SCREEN_EFFECT_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}（{preset.description}）
          </option>
        ))}
      </select>
    </div>
  );
}
