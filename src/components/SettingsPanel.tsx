import { useMemo, useState, type ReactElement } from "react";

import {
  MarkupText,
  useTextRevealSession,
} from "@vectspace/presentation-react/gameplay";
import type {
  Settings,
  TextRevealAnimation,
} from "@vectspace/presentation-core/types";
import { buildVisibleUnitCps, parseMarkup } from "@vectspace/text";

type SliderKey =
  | "master_volume"
  | "bgm_volume"
  | "ambience_volume"
  | "sfx_volume"
  | "video_volume"
  | "text_speed_cps";

const PREVIEW_SOURCE = "示例：$A \\cong B$，文字";

interface SettingsPanelProps {
  settings: Settings;
  onChange(settings: Settings): void;
  onSave(): void;
  onClose(): void;
}

export function SettingsPanel({
  settings,
  onChange,
  onSave,
  onClose,
}: SettingsPanelProps): ReactElement {
  const [animationPreviewRevision, setAnimationPreviewRevision] = useState(0);
  const animationPreviewUnits = useMemo(() => parseMarkup(PREVIEW_SOURCE), []);
  const animationPreviewCps = useMemo(
    () =>
      buildVisibleUnitCps(
        animationPreviewUnits,
        settings.text_speed_cps,
        settings.text_speed_cps,
      ),
    [animationPreviewUnits, settings.text_speed_cps],
  );
  const previewKey = `${animationPreviewRevision}:${settings.text_reveal_animation}:${settings.text_speed_cps}`;
  const [previewLineLayoutKey, setPreviewLineLayoutKey] = useState<
    string | null
  >(null);
  const preview = useTextRevealSession({
    animation: settings.text_reveal_animation,
    defaultCps: settings.text_speed_cps,
    initialCps: settings.text_speed_cps,
    instanceKey: previewKey,
    ready:
      settings.text_reveal_animation !== "line_sweep" ||
      previewLineLayoutKey === previewKey,
    restorePresentation: false,
    units: animationPreviewUnits,
    waitForInlineMath: settings.text_reveal_animation !== "drop_fade",
  });
  const rows: {
    key: SliderKey;
    label: string;
    min: number;
    max: number;
    step: number;
  }[] = [
    { key: "master_volume", label: "主音量", min: 0, max: 1, step: 0.01 },
    { key: "bgm_volume", label: "BGM", min: 0, max: 1, step: 0.01 },
    {
      key: "ambience_volume",
      label: "环境声",
      min: 0,
      max: 1,
      step: 0.01,
    },
    { key: "sfx_volume", label: "音效", min: 0, max: 1, step: 0.01 },
    { key: "video_volume", label: "视频", min: 0, max: 1, step: 0.01 },
    { key: "text_speed_cps", label: "文字速度", min: 5, max: 80, step: 1 },
  ];
  return (
    <div className="modal-backdrop">
      <section className="modal-panel settings-panel" aria-label="设置">
        <header>
          <div>
            <p className="eyebrow">LOCAL SETTINGS</p>
            <h2>设置</h2>
          </div>
          <button onClick={onClose} type="button">
            关闭
          </button>
        </header>
        {rows.map((row) => {
          // Older settings files omit ambience_volume; the Rust save layer
          // supplies the same default.
          const value =
            row.key === "ambience_volume"
              ? (settings.ambience_volume ?? 0.8)
              : settings[row.key];
          return (
            <label className="setting-row" key={row.key}>
              <span>{row.label}</span>
              <input
                aria-label={row.label}
                max={row.max}
                min={row.min}
                onChange={(event) =>
                  onChange({
                    ...settings,
                    [row.key]: Number(event.currentTarget.value),
                  })
                }
                step={row.step}
                type="range"
                value={value}
              />
              <output>{formatSetting(value, row.key)}</output>
            </label>
          );
        })}
        <label className="setting-row">
          <span>文字动画</span>
          <select
            onChange={(event) =>
              onChange({
                ...settings,
                text_reveal_animation: event.currentTarget
                  .value as TextRevealAnimation,
              })
            }
            value={settings.text_reveal_animation}
          >
            <option value="line_sweep">逐行横向渐显</option>
            <option value="typewriter">逐字 / 公式渐显</option>
            <option value="drop_fade">下落渐显</option>
          </select>
          <output />
        </label>
        <div className="text-animation-preview" key={previewKey}>
          <MarkupText
            animateMath
            instantMathReveal={preview.isComplete()}
            instantReveal={preview.isComplete()}
            lineSweepElapsedMs={preview.state.elapsedMs}
            onLineSweepLayoutChange={(ready) =>
              setPreviewLineLayoutKey(ready ? previewKey : null)
            }
            pauseWindows={preview.plan.pauses}
            revealAnimation={settings.text_reveal_animation}
            revealClock={preview.clock}
            revealSchedule={preview.plan.events.map((event) => event.atMs)}
            source={PREVIEW_SOURCE}
            unitCps={animationPreviewCps}
            visibleCount={preview.state.revealedCount}
          />
          <button
            onClick={() =>
              setAnimationPreviewRevision((revision) => revision + 1)
            }
            type="button"
          >
            重播示例
          </button>
        </div>
        <label className="setting-row">
          <span>Ctrl 快进</span>
          <select
            onChange={(event) =>
              onChange({
                ...settings,
                skip_mode: event.currentTarget.value as Settings["skip_mode"],
              })
            }
            value={settings.skip_mode}
          >
            <option value="disabled">关闭快进</option>
            <option value="read_only">快进已读内容</option>
            <option value="all">全部快进</option>
          </select>
          <output />
        </label>
        <label className="setting-row">
          <span>减弱动态效果</span>
          <input
            aria-label="减弱动态效果"
            checked={settings.reduce_motion ?? false}
            onChange={(event) =>
              onChange({
                ...settings,
                reduce_motion: event.currentTarget.checked,
              })
            }
            title="降低闪光亮度、震动幅度，以及色差、故障、冲击波等画面特效的强度与跳变速度"
            type="checkbox"
          />
          <output>{settings.reduce_motion === true ? "开启" : "关闭"}</output>
        </label>
        <button className="primary-action" onClick={onSave} type="button">
          保存设置
        </button>
      </section>
    </div>
  );
}

function formatSetting(value: number, key: SliderKey): string {
  return key === "text_speed_cps"
    ? `${Math.round(value)} cps`
    : `${Math.round(value * 100)}%`;
}
