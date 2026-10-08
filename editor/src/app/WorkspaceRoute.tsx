import { lazy, Suspense, type ReactElement, type ReactNode } from "react";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";

import { findVisualFile, updateVisualDefinition } from "./visualLibrary";
import { visualReturnScene, STORY_ROUTE, type EditorRoute } from "./routes";
import type { EditorHistory } from "./useEditorHistory";
import type { ActiveEdit } from "../editorHistory";
import { findScene } from "../story";
import type { EditorProject, SceneNode } from "../types";

const ChapterMapWorkspace = lazy(() =>
  import("../components/ChapterMapWorkspace").then((module) => ({
    default: module.ChapterMapWorkspace,
  })),
);
const TimelineWorkspace = lazy(() =>
  import("../components/TimelineWorkspace").then((module) => ({
    default: module.TimelineWorkspace,
  })),
);
const LongTextWorkspace = lazy(() =>
  import("../components/LongTextWorkspace").then((module) => ({
    default: module.LongTextWorkspace,
  })),
);
const UiMotionWorkspace = lazy(() =>
  import("../components/UiMotionWorkspace").then((module) => ({
    default: module.UiMotionWorkspace,
  })),
);
const ButtonWorkspace = lazy(() =>
  import("../components/ButtonWorkspace").then((module) => ({
    default: module.ButtonWorkspace,
  })),
);
const ActionWorkspace = lazy(() =>
  import("../components/ActionWorkspace").then((module) => ({
    default: module.ActionWorkspace,
  })),
);
const VisualWorkspace = lazy(() =>
  import("../components/VisualWorkspace").then((module) => ({
    default: module.VisualWorkspace,
  })),
);
const GameplayPreview = lazy(() =>
  import("../components/GameplayPreview").then((module) => ({
    default: module.GameplayPreview,
  })),
);

function WorkspaceFallback(): ReactElement {
  return <main className="workspace-loading">正在载入工作区…</main>;
}

interface WorkspaceRouteProps {
  project: EditorProject;
  route: EditorRoute;
  dirty: boolean;
  activeEdit: ActiveEdit | null;
  animationMap: AnimationMap;
  importTokens: string[];
  canUndo: boolean;
  canRedo: boolean;
  activeSceneId: string;
  mapSelectionId: string | null;
  history: EditorHistory;
  save(): void;
  /** Validate the whole project through the host, then report `success`. */
  validate(blockedMessage: string, success: string): void;
  setRoute(route: EditorRoute): void;
  setActiveSceneId(sceneId: string): void;
  setSelectedNodeId(nodeId: string | null): void;
  setMapSelectionId(id: string | null): void;
  setError(message: string | null): void;
  changeNode(nodeId: string, node: SceneNode): void;
  splitLongText(nodeId: string, stepIndex: number): void;
}

/**
 * The full-screen workspace the current route shows, or `children` (the story
 * shell) when the route is the story or its target no longer exists.
 */
export function WorkspaceRoute({
  children,
  ...props
}: WorkspaceRouteProps & { children: ReactNode }): ReactElement {
  return renderWorkspace(props) ?? <>{children}</>;
}

function renderWorkspace(props: WorkspaceRouteProps): ReactElement | null {
  const {
    project,
    route,
    dirty,
    activeEdit,
    animationMap,
    importTokens,
    canUndo,
    canRedo,
    activeSceneId,
    history,
    save,
    validate,
    setRoute,
    setError,
  } = props;
  const { commit, flushBeforeNavigation, redo, undo } = history;
  const back = (): void => {
    if (flushBeforeNavigation()) setRoute(STORY_ROUTE);
  };
  const common = {
    onRedo: redo,
    onSave: save,
    onUndo: undo,
  };

  switch (route.kind) {
    case "longText": {
      const scene = findScene(project, route.sceneId);
      const node = scene?.definition.nodes[route.nodeId];
      if (node?.type !== "long_text") return null;
      return (
        <Suspense fallback={<WorkspaceFallback />}>
          <LongTextWorkspace
            animationMap={animationMap}
            assets={project.assets}
            dirty={dirty}
            importTokens={importTokens}
            key={`${route.sceneId}/${route.nodeId}`}
            node={node}
            nodeId={route.nodeId}
            onBack={back}
            onChange={(next) => props.changeNode(route.nodeId, next)}
            onPreviewSettingsChange={(settings) =>
              commit((draft) => {
                draft.layout.timeline_previews ??= {};
                draft.layout.timeline_previews[
                  `${route.sceneId}/${route.nodeId}`
                ] = settings;
              }, false)
            }
            {...common}
            onSplitLongText={(stepIndex) =>
              props.splitLongText(route.nodeId, stepIndex)
            }
            project={project}
            redoAvailable={canRedo}
            sceneId={route.sceneId}
            undoAvailable={canUndo}
          />
        </Suspense>
      );
    }
    case "map": {
      const map = project.chapter_map;
      if (map === null || map === undefined) return null;
      return (
        <Suspense fallback={<WorkspaceFallback />}>
          <ChapterMapWorkspace
            animationMap={animationMap}
            assets={project.assets}
            dirty={dirty}
            manifest={project.manifest}
            map={map.definition}
            onChange={(definition) => {
              const mutate = (draft: EditorProject): void => {
                if (
                  draft.chapter_map !== null &&
                  draft.chapter_map !== undefined
                ) {
                  draft.chapter_map.definition = definition;
                }
              };
              // Pointer gestures and inspector edits are opened explicitly by
              // the workspace. Keep every intermediate update inside that
              // active edit so pointer-down → pointer-up produces one undo
              // record instead of one record per pointermove.
              const active = history.editorStateRef.current.activeEdit;
              if (active?.id.startsWith("map:"))
                history.updateEdit(active.id, mutate);
              else commit(mutate, true, "编辑章节地图");
            }}
            onClose={() => {
              if (!history.flushEditorEdits()) {
                setError("地图检查器中存在未提交或无效输入，请修正后再离开。");
                return;
              }
              setRoute(STORY_ROUTE);
            }}
            onSelectionChange={props.setMapSelectionId}
            activeEdit={activeEdit}
            onBeginEdit={history.beginEdit}
            onSetEditDraft={history.setEditDraft}
            onSetEditError={history.setEditError}
            onCommitEdit={history.commitEdit}
            onCancelEdit={history.cancelEdit}
            {...common}
            onValidate={() =>
              validate(
                "地图检查器中存在未提交或无效输入，请修正后再校验。",
                "章节地图已通过完整校验。",
              )
            }
            redoAvailable={canRedo}
            // A chapter map is a way into the main story: secondary-window
            // Scenes can never be a hotspot target.
            sceneIds={project.scenes
              .filter((file) => file.definition.window_role !== "secondary")
              .map((file) => file.definition.id)}
            selectionId={props.mapSelectionId}
            undoAvailable={canUndo}
          />
        </Suspense>
      );
    }
    case "button": {
      const file = (project.buttons ?? []).find(
        (candidate) => candidate.definition.id === route.id,
      );
      if (file === undefined) return null;
      return (
        <Suspense fallback={<WorkspaceFallback />}>
          <ButtonWorkspace
            animationMap={animationMap}
            assets={project.assets}
            dirty={dirty}
            file={file}
            onBack={back}
            onChange={(next) =>
              commit((draft) => {
                const index = (draft.buttons ?? []).findIndex(
                  (candidate) => candidate.definition.id === route.id,
                );
                if (index >= 0 && draft.buttons !== undefined)
                  draft.buttons[index] = next;
              })
            }
            {...common}
            redoAvailable={canRedo}
            undoAvailable={canUndo}
          />
        </Suspense>
      );
    }
    case "action": {
      const file = (project.actions ?? []).find(
        (candidate) => candidate.definition.id === route.id,
      );
      if (file === undefined) return null;
      return (
        <Suspense fallback={<WorkspaceFallback />}>
          <ActionWorkspace
            animationMap={animationMap}
            assets={project.assets}
            definition={file.definition}
            dirty={dirty}
            onBack={back}
            onChange={(definition) =>
              commit((draft) => {
                const files = draft.actions;
                if (files === undefined) return;
                const index = files.findIndex(
                  (candidate) => candidate.definition.id === route.id,
                );
                if (index >= 0) files[index] = { ...file, definition };
              })
            }
            {...common}
            redoAvailable={canRedo}
            undoAvailable={canUndo}
            onValidate={() =>
              validate(
                "动作工作区存在未提交或无效输入，请修正后再校验。",
                "立绘动作已通过完整校验。",
              )
            }
            path={file.path}
          />
        </Suspense>
      );
    }
    case "visual": {
      const file = findVisualFile(project, route.visual, route.id);
      if (file === undefined) return null;
      return (
        <Suspense fallback={<WorkspaceFallback />}>
          <VisualWorkspace
            animationMap={animationMap}
            dirty={dirty}
            file={file}
            key={`${route.visual}/${route.id}`}
            kind={route.visual}
            onBack={() => {
              if (!flushBeforeNavigation()) return;
              // A text opened from a scene's group returns to that scene.
              const origin = visualReturnScene(
                route,
                project.scenes.map((scene) => scene.definition.id),
                activeSceneId,
              );
              if (origin !== null) {
                props.setActiveSceneId(origin);
                props.setSelectedNodeId(null);
              }
              setRoute(STORY_ROUTE);
            }}
            onChange={(definition) =>
              commit((draft) =>
                updateVisualDefinition(
                  draft,
                  route.visual,
                  route.id,
                  definition,
                ),
              )
            }
            {...common}
            onValidate={() =>
              validate(
                "存在未提交或无效的输入，请修正后再校验。",
                "项目已通过完整校验。",
              )
            }
            project={project}
            redoAvailable={canRedo}
            undoAvailable={canUndo}
          />
        </Suspense>
      );
    }
    case "uiMotion": {
      const file = project.ui_motions.find(
        (candidate) => candidate.definition.id === route.id,
      );
      if (file === undefined) return null;
      return (
        <Suspense fallback={<WorkspaceFallback />}>
          <UiMotionWorkspace
            animationMap={animationMap}
            assets={project.assets}
            defaultFontId={project.manifest.default_font}
            dirty={dirty}
            file={file}
            onBack={back}
            onChange={(next) =>
              commit((draft) => {
                const index = draft.ui_motions.findIndex(
                  (candidate) => candidate.definition.id === route.id,
                );
                if (index >= 0) draft.ui_motions[index] = next;
              })
            }
            {...common}
            redoAvailable={canRedo}
            undoAvailable={canUndo}
          />
        </Suspense>
      );
    }
    case "preview":
      return (
        <Suspense fallback={<WorkspaceFallback />}>
          <GameplayPreview
            autoStart={route.autoStart}
            importTokens={importTokens}
            key={`${route.sceneId}/${route.nodeId ?? ""}`}
            nodeId={route.nodeId}
            onBack={() => setRoute(route.returnTo ?? STORY_ROUTE)}
            onError={setError}
            project={project}
            sceneId={route.sceneId}
          />
        </Suspense>
      );
    case "timeline": {
      const scene = findScene(project, route.sceneId);
      const node = scene?.definition.nodes[route.nodeId];
      if (node?.type !== "timeline") return null;
      const previewKey = `${route.sceneId}/${route.nodeId}`;
      return (
        <Suspense fallback={<WorkspaceFallback />}>
          <TimelineWorkspace
            assets={project.assets}
            dirty={dirty}
            importTokens={importTokens}
            futureAvailable={canRedo}
            pastAvailable={canUndo}
            node={node}
            nodeId={route.nodeId}
            onBack={back}
            onChange={(next) => props.changeNode(route.nodeId, next)}
            onError={setError}
            onPreviewSettingsChange={(settings) =>
              commit((draft) => {
                draft.layout.timeline_previews ??= {};
                draft.layout.timeline_previews[previewKey] = settings;
              }, false)
            }
            {...common}
            project={project}
            previewSettings={project.layout.timeline_previews?.[previewKey]}
            sceneId={route.sceneId}
          />
        </Suspense>
      );
    }
    case "story":
      return null;
  }
}
