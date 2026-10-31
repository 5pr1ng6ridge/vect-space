import { firstVisibleAssetId } from "../assetLibrary";
import {
  findAssetReferences,
  findButtonTemplateReferences,
} from "../components/assetReferences";
import {
  animationDefinition,
  animationFilePath,
  type AnimationDraft,
} from "../imageAnimation";
import {
  countCharacterReferences,
  countVariableReferences,
  ensureSceneLayout,
  newSceneFile,
  renameCharacter as renameCharacterReferences,
  renameScene as renameSceneReferences,
  renameSpriteAction,
  renameVariable as renameVariableReferences,
  setSceneWindowRole,
} from "../story";
import type {
  CharacterDefinition,
  ContentManifest,
  EditorLayout,
  VariableDefinition,
  WindowRole,
} from "../types";
import type { ConfirmFn } from "../ui/feedbackContext";
import { WINDOW_ROLE_LABELS } from "../windowInteraction";
import { currentPlainProject, type ActionContext } from "./actionContext";
import { idFormatError, idUnavailableReason } from "./ids";
import {
  addButtonTemplate,
  addSpriteAction,
  addUiMotion,
  duplicateButtonFile,
  duplicateSpriteActionFile,
  formatReferenceList,
  newButtonFile,
  newSpriteActionFile,
  newUiMotionFile,
  removeAssetRegistration,
  removeButtonTemplate,
  removeScene,
  removeSpriteAction,
  removeUiMotion,
  spriteActionReferences,
  uiMotionReferenceCount,
} from "./libraryCommands";
import { routeShowsScene, STORY_ROUTE } from "./routes";
import {
  addVisualDocument,
  duplicateVisualFile,
  findVisualFile,
  newParticleFile,
  newTextBlockFile,
  removeVisualDocument,
  renameVisualDocument,
  textBlockSceneIds,
  visualReferences,
  VISUAL_KIND_LABELS,
  type VisualKind,
} from "./visualLibrary";

interface LibraryActionContext extends ActionContext {
  confirm: ConfirmFn;
}

/**
 * Create, rename, duplicate and delete the project's named objects: scenes,
 * variables, characters, assets, UI motions, button templates, sprite
 * actions, text blocks and particles.  Every action validates ids and
 * references against `latestProject()` and reports problems through
 * `setError`.
 */
export function createLibraryActions(ctx: LibraryActionContext) {
  const {
    latestProject,
    route,
    confirm,
    commit,
    commitUndoable,
    setError,
    setNotice,
    setActiveSceneId,
    setSelectedNodeId,
    setRoute,
  } = ctx;
  const uiMotionTarget = route.kind === "uiMotion" ? route.id : null;
  const buttonTarget = route.kind === "button" ? route.id : null;
  const visualTarget = route.kind === "visual" ? route : null;

  const setSceneRole = (sceneId: string, role: WindowRole): void => {
    const currentProject = latestProject();
    if (
      role === "secondary" &&
      currentProject.manifest.entry_scene === sceneId
    ) {
      setError("项目入口场景必须是主窗口专用；请先在项目设置中更换入口。");
      return;
    }
    if (
      role === "secondary" &&
      currentProject.chapter_map?.definition.hotspots.some(
        (hotspot) => hotspot.scene_id === sceneId,
      ) === true
    ) {
      setError(
        "章节地图仍有热点指向这个场景；副窗口专用场景不能作为地图入口，请先移除热点。",
      );
      return;
    }
    commit(
      (draft) => setSceneWindowRole(currentPlainProject(draft), sceneId, role),
      true,
      "设置场景用途",
    );
    setNotice(
      `已将场景 ${sceneId} 设为${WINDOW_ROLE_LABELS[role]}专用；引用它的「打开副窗口」和跳转请在问题面板中检查。`,
    );
  };

  const renameScene = (previousId: string, nextId: string): boolean => {
    const reason = idUnavailableReason("scene", nextId, latestProject(), {
      previous: previousId,
    });
    if (reason !== null) {
      setError(reason);
      return false;
    }
    void confirm({
      title: `把场景 ${previousId} 重命名为 ${nextId}？`,
      description:
        "场景文件路径与项目内的所有跳转都会一并更新；但玩家已有存档中记录的旧场景 ID 将无法恢复。",
      confirmLabel: "重命名并更新引用",
    }).then((accepted) => {
      if (!accepted) return;
      commit((draft) =>
        renameSceneReferences(currentPlainProject(draft), previousId, nextId),
      );
      setActiveSceneId(nextId);
    });
    return true;
  };

  const changeAssetLayout = (
    mutate: (layout: EditorLayout) => EditorLayout,
    label: string,
  ): void =>
    commit(
      (draft) => {
        draft.layout = mutate(draft.layout);
      },
      true,
      label,
    );

  const changeManifest = (manifest: ContentManifest): void =>
    commit((draft) => void (draft.manifest = manifest));

  const removeAsset = (id: string): boolean => {
    const references = findAssetReferences(latestProject(), id);
    if (references.length > 0) {
      setError(
        `素材 ${id} 仍被 ${references.length} 处内容引用${formatReferenceList(references)}，不能从清单移除。`,
      );
      return false;
    }
    commitUndoable(
      (draft) => removeAssetRegistration(draft, id),
      "移除素材",
      `已从项目移除素材 ${id}（文件仍保留在磁盘上）。`,
    );
    return true;
  };

  const addVariable = (id: string, definition: VariableDefinition): boolean => {
    const reason = idUnavailableReason("variable", id, latestProject());
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) => {
      draft.manifest.variables[id] = definition;
    });
    return true;
  };

  const changeVariable = (id: string, definition: VariableDefinition): void =>
    commit((draft) => {
      draft.manifest.variables[id] = definition;
    });

  const deleteVariable = (id: string): void => {
    const references = countVariableReferences(latestProject(), id);
    if (references > 0) {
      setError(`变量 ${id} 仍被 ${references} 处剧情引用，不能删除。`);
      return;
    }
    commit((draft) => {
      Reflect.deleteProperty(draft.manifest.variables, id);
    });
  };

  const renameVariable = (previousId: string, nextId: string): boolean => {
    const reason = idUnavailableReason("variable", nextId, latestProject());
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) =>
      renameVariableReferences(currentPlainProject(draft), previousId, nextId),
    );
    return true;
  };

  const addCharacter = (
    id: string,
    definition: CharacterDefinition,
  ): boolean => {
    const reason = idUnavailableReason("character", id, latestProject());
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) => {
      draft.manifest.characters[id] = definition;
    });
    return true;
  };

  const changeCharacter = (id: string, definition: CharacterDefinition): void =>
    commit((draft) => {
      draft.manifest.characters[id] = definition;
    });

  const deleteCharacter = (id: string): void => {
    const references = countCharacterReferences(latestProject(), id);
    if (references > 0) {
      setError(`角色 ${id} 仍被 ${references} 句对话引用，不能删除。`);
      return;
    }
    commit((draft) => {
      Reflect.deleteProperty(draft.manifest.characters, id);
    });
  };

  const renameCharacter = (previousId: string, nextId: string): boolean => {
    const reason = idUnavailableReason("character", nextId, latestProject());
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) =>
      renameCharacterReferences(currentPlainProject(draft), previousId, nextId),
    );
    return true;
  };

  const renameAction = (previousId: string, nextId: string): boolean => {
    const normalized = nextId.trim();
    const reason = idUnavailableReason("action", normalized, latestProject(), {
      previous: previousId,
    });
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) => {
      const renamed = renameSpriteAction(
        currentPlainProject(draft),
        previousId,
        normalized,
      );
      draft.actions = renamed.actions;
      draft.manifest.actions = renamed.manifest.actions;
      draft.scenes = renamed.scenes;
    });
    setNotice(`已重命名立绘动作 ${previousId} → ${normalized}。`);
    return true;
  };

  const addScene = (id: string, role: WindowRole = "main"): boolean => {
    const currentProject = latestProject();
    const reason = idUnavailableReason("scene", id, currentProject);
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) => {
      const file = newSceneFile(id, role);
      draft.scenes.push(file);
      draft.manifest.scenes.push(file.path);
      ensureSceneLayout(draft.layout, id).nodes.start = { x: 120, y: 120 };
    });
    setActiveSceneId(id);
    setSelectedNodeId("start");
    return true;
  };

  const deleteScene = (sceneId: string): void => {
    const currentProject = latestProject();
    if (currentProject.manifest.entry_scene === sceneId) {
      setError("不能删除项目入口场景，请先在项目设置中更换入口。");
      return;
    }
    commitUndoable(
      (draft) => removeScene(draft, sceneId),
      "删除场景",
      `已从项目移除场景 ${sceneId}（场景文件仍保留在磁盘上）。`,
    );
    const next =
      currentProject.scenes.find((file) => file.definition.id !== sceneId)
        ?.definition.id ?? "";
    if (routeShowsScene(route, sceneId)) setRoute(STORY_ROUTE);
    setActiveSceneId(next);
    setSelectedNodeId(null);
  };

  const createUiMotion = (rawId: string): boolean => {
    const id = rawId.trim();
    const currentProject = latestProject();
    const reason = idUnavailableReason("uiMotion", id, currentProject);
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) => addUiMotion(draft, newUiMotionFile(id)));
    setRoute({ kind: "uiMotion", id });
    return true;
  };

  const deleteUiMotion = (id: string): void => {
    const currentProject = latestProject();
    const references = uiMotionReferenceCount(currentProject, id);
    if (references > 0) {
      setError(`UI 动效 ${id} 仍被 ${references} 处引用，不能删除。`);
      return;
    }
    commitUndoable(
      (draft) => removeUiMotion(draft, id),
      "移除 UI 动效",
      `已移除 UI 动效 ${id}（文件仍保留在磁盘上）。`,
    );
    if (uiMotionTarget === id) setRoute(STORY_ROUTE);
  };

  const createButtonTemplate = (rawId: string): boolean => {
    const id = rawId.trim();
    const currentProject = latestProject();
    const reason = idUnavailableReason("button", id, currentProject);
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) => addButtonTemplate(draft, newButtonFile(id)));
    setRoute({ kind: "button", id });
    return true;
  };

  const deleteButtonTemplate = (id: string): void => {
    const currentProject = latestProject();
    const references = findButtonTemplateReferences(currentProject, id);
    if (references.length > 0) {
      setError(
        `按钮模板 ${id} 仍被 ${references.length} 处剧情引用${formatReferenceList(references)}，不能删除。`,
      );
      return;
    }
    if (
      !(currentProject.buttons ?? []).some(
        (candidate) => candidate.definition.id === id,
      )
    )
      return;
    commitUndoable(
      (draft) => removeButtonTemplate(draft, id),
      "移除按钮模板",
      `已移除按钮模板 ${id}（文件仍保留在磁盘上）。`,
    );
    if (buttonTarget === id) setRoute(STORY_ROUTE);
  };

  const createImageAnimation = (draft: AnimationDraft): boolean => {
    const currentProject = latestProject();
    const animations = currentProject.animations ?? [];
    const formatReason =
      idFormatError(draft.id) ?? idFormatError(draft.assetId);
    if (formatReason !== null) {
      setError(formatReason);
      return false;
    }
    if (
      currentProject.manifest.assets[draft.id] !== undefined ||
      currentProject.manifest.assets[draft.assetId] !== undefined ||
      animations.some((file) => file.definition.id === draft.id)
    ) {
      setError("图片动画 ID 或素材 ID 已经存在。");
      return false;
    }
    const path = animationFilePath(draft.id);
    if (animations.some((file) => file.path === path)) {
      setError(`图片动画文件路径 ${path} 已经存在。`);
      return false;
    }
    const definition = animationDefinition(draft);
    // Rust resolves an animated asset to its first frame, so the optimistic
    // asset carries the same path, size and metadata the save response will.
    const firstFrame = currentProject.assets.find(
      (asset) => asset.id === definition.frames[0]?.asset,
    );
    commit((draftProject) => {
      draftProject.manifest.animations ??= [];
      draftProject.manifest.animations.push(path);
      draftProject.manifest.assets[draft.assetId] = {
        kind: draft.kind,
        animation: draft.id,
      };
      draftProject.animations ??= [];
      draftProject.animations.push({ path, definition });
      draftProject.assets.push({
        id: draft.assetId,
        kind: draft.kind,
        animation: draft.id,
        absolute_path: firstFrame?.absolute_path ?? "",
        size_bytes: firstFrame?.size_bytes,
        metadata: firstFrame?.metadata ?? null,
      });
    });
    setNotice(
      `已创建帧动画 ${draft.id}（${definition.frames.length} 帧）；图片与动画描述会在同一次保存中写入。`,
    );
    return true;
  };

  const createSpriteAction = (rawId: string): boolean => {
    const id = rawId.trim();
    const currentProject = latestProject();
    const reason = idUnavailableReason("action", id, currentProject);
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) => addSpriteAction(draft, newSpriteActionFile(id)));
    setNotice(`已创建立绘动作 ${id}。`);
    return true;
  };

  const deleteSpriteAction = (id: string): void => {
    const currentProject = latestProject();
    const references = spriteActionReferences(currentProject, id);
    if (references.length > 0) {
      setError(
        `立绘动作 ${id} 仍被 ${references.length} 个节点引用${formatReferenceList(references)}，不能删除。`,
      );
      return;
    }
    if (
      !(currentProject.actions ?? []).some(
        (candidate) => candidate.definition.id === id,
      )
    )
      return;
    commitUndoable(
      (draft) => removeSpriteAction(draft, id),
      "移除立绘动作",
      `已移除立绘动作 ${id}（文件仍保留在磁盘上）。`,
    );
  };

  const duplicateSpriteAction = (id: string): void => {
    const currentProject = latestProject();
    const file = duplicateSpriteActionFile(currentProject, id);
    if (file === null) return;
    commit((draft) => addSpriteAction(draft, file));
    setNotice(`已复制立绘动作 ${id} → ${file.definition.id}。`);
  };

  const createVisual = (
    kind: VisualKind,
    rawId: string,
    sceneId?: string,
  ): boolean => {
    const id = rawId.trim();
    const currentProject = latestProject();
    const reason = idUnavailableReason(kind, id, currentProject);
    if (reason !== null) {
      setError(reason);
      return false;
    }
    const file =
      kind === "textBlock"
        ? newTextBlockFile(id)
        : newParticleFile(
            id,
            firstVisibleAssetId(currentProject.assets, currentProject.layout, [
              "gui",
              "sprite",
            ]) ?? "",
          );
    // The pin is part of the same commit, so one undo removes both the new
    // definition and its place in the scene's group.
    commit((draft) =>
      addVisualDocument(draft, kind, file, {
        sceneIds: sceneId === undefined ? [] : [sceneId],
      }),
    );
    setRoute({
      kind: "visual",
      visual: kind,
      id,
      ...(kind === "textBlock" && sceneId !== undefined ? { sceneId } : {}),
    });
    return true;
  };

  const renameVisual = (
    kind: VisualKind,
    previousId: string,
    rawId: string,
  ): boolean => {
    const nextId = rawId.trim();
    const currentProject = latestProject();
    const reason = idUnavailableReason(kind, nextId, currentProject, {
      previous: previousId,
    });
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) => renameVisualDocument(draft, kind, previousId, nextId));
    if (visualTarget?.visual === kind && visualTarget.id === previousId)
      setRoute({ ...visualTarget, id: nextId });
    setNotice(
      kind === "particle"
        ? `已重命名粒子效果 ${previousId} → ${nextId}；引用它的旧存档发射器需要重新开始该场景。`
        : `已重命名固定文本块 ${previousId} → ${nextId}。`,
    );
    return true;
  };

  const duplicateVisual = (kind: VisualKind, id: string): void => {
    const currentProject = latestProject();
    const file = duplicateVisualFile(
      currentProject,
      kind,
      id,
      (candidate) =>
        idUnavailableReason(kind, candidate, currentProject) !== null,
    );
    if (file === null) return;
    // A copy is filed wherever its source is listed, so it appears next to it.
    const sceneIds =
      kind === "textBlock" ? textBlockSceneIds(currentProject, id) : [];
    commit((draft) => addVisualDocument(draft, kind, file, { sceneIds }));
    setNotice(
      `已复制${VISUAL_KIND_LABELS[kind]} ${id} → ${file.definition.id}。`,
    );
  };

  const deleteVisual = (kind: VisualKind, id: string): void => {
    const currentProject = latestProject();
    const references = visualReferences(currentProject, kind, id);
    if (references.length > 0) {
      setError(
        `${VISUAL_KIND_LABELS[kind]} ${id} 仍被 ${references.length} 处引用${formatReferenceList(references)}，不能删除。`,
      );
      return;
    }
    if (findVisualFile(currentProject, kind, id) === undefined) return;
    commitUndoable(
      (draft) => removeVisualDocument(draft, kind, id),
      `移除${VISUAL_KIND_LABELS[kind]}`,
      `已移除${VISUAL_KIND_LABELS[kind]} ${id}。`,
    );
    if (visualTarget?.visual === kind && visualTarget.id === id)
      setRoute(STORY_ROUTE);
  };

  const duplicateButtonTemplate = (id: string): void => {
    const currentProject = latestProject();
    const file = duplicateButtonFile(currentProject, id);
    if (file === null) return;
    commit((draft) => addButtonTemplate(draft, file));
    setRoute({ kind: "button", id: file.definition.id });
  };

  return {
    setSceneRole,
    renameScene,
    changeAssetLayout,
    changeManifest,
    removeAsset,
    addVariable,
    changeVariable,
    deleteVariable,
    renameVariable,
    addCharacter,
    changeCharacter,
    deleteCharacter,
    renameCharacter,
    renameAction,
    addScene,
    deleteScene,
    createUiMotion,
    deleteUiMotion,
    createButtonTemplate,
    deleteButtonTemplate,
    createImageAnimation,
    createSpriteAction,
    deleteSpriteAction,
    duplicateSpriteAction,
    createVisual,
    renameVisual,
    duplicateVisual,
    deleteVisual,
    duplicateButtonTemplate,
  };
}
