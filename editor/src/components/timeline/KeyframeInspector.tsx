import type { ReactElement } from "react";

import type { TimelineEasing, TimelineKeyframe } from "../../types";

/** Value, time and easing editor for the selected keyframe of a surface. */
export function KeyframeInspector({
  allowInherit,
  frame,
  onChange,
}: {
  allowInherit: boolean;
  frame: TimelineKeyframe;
  onChange(frame: TimelineKeyframe): void;
}): ReactElement {
  const cubic =
    typeof frame.easing === "object"
      ? frame.easing.cubic_bezier
      : ([0.25, 0.1, 0.25, 1] as [number, number, number, number]);
  return (
    <div className="keyframe-inspector">
      <label>
        值来源{" "}
        <select
          value={frame.value === "inherit" ? "inherit" : "number"}
          onChange={(event) =>
            onChange({
              ...frame,
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
        时间{" "}
        <input
          disabled={frame.value === "inherit"}
          type="number"
          value={frame.at_ms}
          onChange={(event) =>
            onChange({ ...frame, at_ms: Number(event.currentTarget.value) })
          }
        />
      </label>
      <label>
        数值{" "}
        <input
          disabled={frame.value === "inherit"}
          type="number"
          step="0.01"
          value={frame.value === "inherit" ? 0 : frame.value}
          onChange={(event) =>
            onChange({ ...frame, value: Number(event.currentTarget.value) })
          }
        />
      </label>
      {frame.value === "inherit" && (
        <small>0 ms 时从真实进入状态读取此通道。</small>
      )}
      <label>
        缓动{" "}
        <select
          value={typeof frame.easing === "object" ? "cubic" : frame.easing}
          onChange={(event) =>
            onChange({
              ...frame,
              easing:
                event.currentTarget.value === "cubic"
                  ? { cubic_bezier: cubic }
                  : (event.currentTarget.value as TimelineEasing),
            })
          }
        >
          <option value="step">step</option>
          <option value="linear">linear</option>
          <option value="ease_in">ease in</option>
          <option value="ease_out">ease out</option>
          <option value="ease_in_out">ease in/out</option>
          <option value="cubic">cubic-bezier</option>
        </select>
      </label>
      {typeof frame.easing === "object" && (
        <>
          <svg
            aria-label="贝塞尔缓动曲线"
            className="cubic-preview"
            viewBox="0 0 100 100"
          >
            <path d="M 0 100 L 100 0" />
            <path
              className="curve"
              d={`M 0 100 C ${cubic[0] * 100} ${100 - cubic[1] * 100}, ${cubic[2] * 100} ${100 - cubic[3] * 100}, 100 0`}
            />
          </svg>
          <div className="cubic-controls">
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
                  onChange({ ...frame, easing: { cubic_bezier: next } });
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
