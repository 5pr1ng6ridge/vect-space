import { proofFields } from "./nodeFields/proof";
import type { ReactNode } from "react";
import type { SceneNode } from "../../types";
import type { FieldsContext } from "./fieldsContext";
import {
  backgroundFields,
  cameraFields,
  clearFields,
  curtainFields,
  particleFields,
  screenEffectFields,
  spriteFields,
} from "./nodeFields/stage";
import {
  choiceFields,
  longTextControlFields,
  longTextFields,
  sayFields,
} from "./nodeFields/dialogue";
import {
  actionFields,
  conditionFields,
  jumpFields,
  playbackFields,
  setFields,
  timelineFields,
  waitFields,
} from "./nodeFields/flow";
import {
  openWindowFields,
  timerFields,
  windowControlFields,
  windowGeometryFields,
  windowLayerFields,
  windowTitleFields,
} from "./nodeFields/window";
import { ambienceFields, bgmFields, sfxFields } from "./nodeFields/audio";
import {
  buttonCreateFields,
  buttonRemoveFields,
  buttonUpdateFields,
  dialogueUiFields,
  uiMotionPlayFields,
  uiMotionSetFields,
} from "./nodeFields/ui";

export function renderFields(node: SceneNode, ctx: FieldsContext): ReactNode {
  switch (node.type) {
    case "proof":
      return proofFields(node, ctx);
    case "background":
      return backgroundFields(node, ctx);
    case "curtain":
      return curtainFields(node, ctx);
    case "sprite":
      return spriteFields(node, ctx);
    case "particle":
      return particleFields(node, ctx);
    case "clear":
      return clearFields(node, ctx);
    case "say":
      return sayFields(node, ctx);
    case "long_text":
      return longTextFields(node, ctx);
    case "long_text_control":
      return longTextControlFields(node, ctx);
    case "choice":
      return choiceFields(node, ctx);
    case "set":
      return setFields(node, ctx);
    case "condition":
      return conditionFields(node, ctx);
    case "playback":
      return playbackFields(node, ctx);
    case "action":
      return actionFields(node, ctx);
    case "jump":
      return jumpFields(node, ctx);
    case "open_window":
      return openWindowFields(node, ctx);
    case "window_title":
      return windowTitleFields(node, ctx);
    case "window_control":
      return windowControlFields(node, ctx);
    case "window_geometry":
      return windowGeometryFields(node, ctx);
    case "window_layer":
      return windowLayerFields(node, ctx);
    case "timer":
      return timerFields(node, ctx);
    case "wait":
      return waitFields(node, ctx);
    case "bgm":
      return bgmFields(node, ctx);
    case "ambience":
      return ambienceFields(node, ctx);
    case "sfx":
      return sfxFields(node, ctx);
    case "camera":
      return cameraFields(node, ctx);
    case "screen_effect":
      return screenEffectFields(node, ctx);
    case "dialogue_ui":
      return dialogueUiFields(node, ctx);
    case "ui_motion_set":
      return uiMotionSetFields(node, ctx);
    case "ui_motion_play":
      return uiMotionPlayFields(node, ctx);
    case "button_create":
      return buttonCreateFields(node, ctx);
    case "button_update":
      return buttonUpdateFields(node, ctx);
    case "button_remove":
      return buttonRemoveFields(node, ctx);
    case "timeline":
      return timelineFields(node, ctx);
    case "end":
      return (
        <p className="field-note">
          终点节点没有出口。运行时将在这里显示结束状态。
        </p>
      );
  }
}
