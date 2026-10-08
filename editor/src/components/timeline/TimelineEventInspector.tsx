import type { ReactElement } from "react";
import type { EditorAsset, TimelineEvent } from "../../types";
import type { TimelineEventSelection } from "../TimelineEditor";
import { ScreenEffectFields } from "../SpecFields";
import { AssetChooser } from "../AssetChooser";

export function TimelineEventInspector({
  assets,
  selection,
  onChange,
}: {
  assets: EditorAsset[];
  selection: TimelineEventSelection;
  onChange(event: TimelineEvent): void;
}): ReactElement {
  const event = selection.event;
  return (
    <section className="timeline-keyframe-inspector">
      <strong>
        选中事件 · {event.type} · {event.id}
      </strong>
      <label>
        时间
        <input
          min={0}
          type="number"
          value={event.at_ms}
          onChange={(input) =>
            onChange({
              ...event,
              at_ms: Number(input.currentTarget.value),
            })
          }
        />
      </label>
      {event.type === "sfx" ? (
        <>
          <label>
            素材
            <AssetChooser
              assets={assets}
              kind="sfx"
              label="音效素材"
              onChange={(value) => onChange({ ...event, asset: value ?? "" })}
              value={event.asset || null}
            />
          </label>
          <label>
            音量
            <input
              max="1"
              min="0"
              step="0.01"
              type="number"
              value={event.volume}
              onChange={(input) =>
                onChange({
                  ...event,
                  volume: Math.max(
                    0,
                    Math.min(1, Number(input.currentTarget.value)),
                  ),
                })
              }
            />
          </label>
        </>
      ) : (
        <>
          <ScreenEffectFields
            onChange={(effect) => onChange({ ...event, effect })}
            value={event.effect}
          />
          <label>
            时长
            <input
              min={1}
              type="number"
              value={event.duration_ms}
              onChange={(input) =>
                onChange({
                  ...event,
                  duration_ms: Math.max(1, Number(input.currentTarget.value)),
                })
              }
            />
          </label>
        </>
      )}
    </section>
  );
}
