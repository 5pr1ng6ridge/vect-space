import type { ReactElement } from "react";
import type { TimelineEasing, TimelineKeyframe } from "../../types";
import type { TimelineSelection } from "../TimelineEditor";

export function TimelineKeyframeInspector({
  allowInherit,
  selection,
  onChange,
}: {
  allowInherit: boolean;
  selection: TimelineSelection;
  onChange(patch: Partial<TimelineKeyframe>): void;
}): ReactElement {
  const frame = selection.frame;
  const cubicEasing =
    typeof frame.easing === "object" ? frame.easing : undefined;
  const isCubic = cubicEasing !== undefined;
  const cubic =
    cubicEasing?.cubic_bezier ??
    ([0.25, 0.1, 0.25, 1] as [number, number, number, number]);
  return (
    <section className="timeline-keyframe-inspector">
      <strong>
        选中关键帧 · {selection.channel} · {frame.at_ms} ms
      </strong>
      <label>
        值来源
        <select
          value={frame.value === "inherit" ? "inherit" : "number"}
          onChange={(event) =>
            onChange({
              at_ms: event.currentTarget.value === "inherit" ? 0 : frame.at_ms,
              value: event.currentTarget.value === "inherit" ? "inherit" : 0,
            })
          }
        >
          <option value="number">固定数值</option>
          {allowInherit && <option value="inherit">继承入口值</option>}
        </select>
      </label>
      <label>
        时间
        <input
          disabled={frame.value === "inherit"}
          min={0}
          type="number"
          value={frame.at_ms}
          onChange={(event) =>
            onChange({ at_ms: Number(event.currentTarget.value) })
          }
        />
      </label>
      <label>
        数值
        <input
          disabled={frame.value === "inherit"}
          step="0.01"
          type="number"
          value={frame.value === "inherit" ? 0 : frame.value}
          onChange={(event) =>
            onChange({ value: Number(event.currentTarget.value) })
          }
        />
      </label>
      {frame.value === "inherit" && (
        <small>在 0 ms 读取该通道进入时间轴时的真实值。</small>
      )}
      <label>
        缓动
        <select
          value={isCubic ? "cubic" : (frame.easing as string)}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onChange({
              easing:
                value === "cubic"
                  ? { cubic_bezier: cubic }
                  : (value as TimelineEasing),
            });
          }}
        >
          <option value="step">step</option>
          <option value="linear">linear</option>
          <option value="ease_in">ease in</option>
          <option value="ease_out">ease out</option>
          <option value="ease_in_out">ease in/out</option>
          <option value="cubic">cubic-bezier</option>
        </select>
      </label>
      {isCubic && (
        <div className="timeline-cubic-controls">
          {cubic.map((value, index) => (
            <input
              aria-label={`Bezier ${index + 1}`}
              key={index}
              max={index % 2 === 0 ? 1 : 4}
              min={index % 2 === 0 ? 0 : -4}
              step="0.01"
              type="number"
              value={value}
              onChange={(event) => {
                const next = [...cubic] as [number, number, number, number];
                next[index] = Number(event.currentTarget.value);
                onChange({ easing: { cubic_bezier: next } });
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
