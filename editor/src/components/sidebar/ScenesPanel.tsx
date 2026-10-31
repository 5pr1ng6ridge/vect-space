import { Fragment, useMemo, useState, type ReactElement } from "react";
import { sceneRole, WINDOW_ROLE_LABELS } from "../../windowInteraction";
import type { SidebarScrollStore } from "../projectSections";
import {
  AppWindow,
  Clapperboard,
  Pencil,
  Plus,
  Trash2,
  Type,
} from "lucide-react";
import { IconButton } from "../../ui/Button";
import { LibraryRow } from "../LibraryRow";
import { ID_RULE_HINT, idUnavailableReason } from "../../app/ids";
import {
  suggestVisualId,
  textBlockGroups,
  visualReferences,
  VISUAL_KIND_LABELS,
} from "../../app/visualLibrary";
import type { EditorDiagnostic, EditorProject, WindowRole } from "../../types";
import type { SidebarTab, VisualLibraryHandlers } from "./types";
import { useSidebarScroller } from "./useSidebarScroller";
import { TextEntryDialog } from "./TextEntryDialog";
import { CollapsibleSection } from "./CollapsibleSection";
import { visualRowActions } from "./visualRowActions";

export function ScenesPanel({
  activeSceneId,
  diagnostics,
  onAddScene,
  onDeleteScene,
  onRenameScene,
  onScrollOffset,
  onSelectScene,
  onSetSceneRole,
  onToggleSidebarItem,
  project,
  scrollStore,
  sidebarItemOpen,
  visualLibrary,
}: {
  activeSceneId: string;
  diagnostics: EditorDiagnostic[];
  onAddScene(id: string, role?: WindowRole): boolean;
  onDeleteScene(sceneId: string): void;
  onRenameScene(previousId: string, nextId: string): boolean;
  onScrollOffset?(tab: SidebarTab, offset: number): void;
  onSelectScene(sceneId: string): void;
  onSetSceneRole?(sceneId: string, role: WindowRole): void;
  onToggleSidebarItem?(key: string, defaultOpen?: boolean): void;
  project: EditorProject;
  scrollStore?: SidebarScrollStore;
  sidebarItemOpen?: Readonly<Record<string, boolean>>;
  visualLibrary?: VisualLibraryHandlers;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{
    title: string;
    value: string;
    mode: "add" | "rename";
    previous?: string;
    role?: WindowRole;
  } | null>(null);
  const [textDialog, setTextDialog] = useState<{
    title: string;
    value: string;
    /** Scene whose group is creating; absent for a rename. */
    sceneId?: string;
    previous?: string;
  } | null>(null);
  const scenes = project.scenes.filter((file) =>
    file.definition.id.toLowerCase().includes(query.trim().toLowerCase()),
  );
  // Fixed texts follow the scene content: each scene lists the texts it pins
  // or really uses, and the rest fall into shared / unassigned groups.
  const groups = useMemo(
    () => (visualLibrary === undefined ? null : textBlockGroups(project)),
    [project, visualLibrary],
  );
  // An author's own expand / collapse choice always wins; until then only the
  // active scene and groups that actually hold texts are open, so a project
  // with many scenes does not fill the list with empty headers.
  const textGroupProps = (key: string, defaultOpen: boolean) => ({
    open: sidebarItemOpen?.[key] ?? defaultOpen,
    onToggle: () => onToggleSidebarItem?.(key, defaultOpen),
    project,
  });
  const beginTextRename = (id: string): void =>
    setTextDialog({ title: "新的固定文本块 ID", value: id, previous: id });
  const showFallbackGroups = query.trim() === "";
  const { onScroll: onSceneListScroll, ref: sceneListRef } = useSidebarScroller(
    "scenes",
    scrollStore,
    onScrollOffset,
  );
  return (
    <div className="sidebar-body">
      <div className="sidebar-search-row">
        <input
          aria-label="搜索场景"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="筛选场景…"
          value={query}
        />
        <IconButton
          icon={Plus}
          label="添加场景"
          onClick={() => {
            setDialog({ title: "新场景 ID", value: "new_scene", mode: "add" });
          }}
          tooltip="新建场景"
          variant="secondary"
        />
        <IconButton
          icon={AppWindow}
          label="添加副窗口场景"
          onClick={() => {
            setDialog({
              title: "新副窗口场景 ID",
              value: "new_side_scene",
              mode: "add",
              role: "secondary",
            });
          }}
          tooltip="新建副窗口专用场景"
          variant="secondary"
        />
      </div>
      <div
        className="scene-list"
        data-sidebar-scroller="scenes"
        onScroll={onSceneListScroll}
        ref={sceneListRef}
      >
        {scenes.map((file) => {
          const scene = file.definition;
          const issueCount = diagnostics.filter(
            (diagnostic) => diagnostic.scene_id === scene.id,
          ).length;
          const entry = project.manifest.entry_scene === scene.id;
          const sceneTexts = groups?.scenes.get(scene.id) ?? [];
          return (
            <Fragment key={scene.id}>
              <article
                className={`scene-row${activeSceneId === scene.id ? " active" : ""}`}
              >
                <button
                  className="scene-main"
                  onClick={() => onSelectScene(scene.id)}
                  type="button"
                >
                  <Clapperboard aria-hidden="true" className="scene-icon" />
                  <span className="scene-text">
                    <strong>{scene.id}</strong>
                    <small>
                      {Object.keys(scene.nodes).length} 个节点
                      {entry ? " · 项目入口" : ""}
                      {sceneRole(scene) === "secondary" ? " · 副窗口专用" : ""}
                    </small>
                  </span>
                  {issueCount > 0 && (
                    <span
                      className="scene-issues"
                      title={`${issueCount} 个问题`}
                    >
                      {issueCount}
                    </span>
                  )}
                </button>
                <div className="scene-row-actions">
                  {onSetSceneRole !== undefined && (
                    <IconButton
                      aria-pressed={sceneRole(scene) === "secondary"}
                      icon={AppWindow}
                      label={
                        sceneRole(scene) === "secondary"
                          ? "设为主窗口专用"
                          : "设为副窗口专用"
                      }
                      onClick={() =>
                        onSetSceneRole(
                          scene.id,
                          sceneRole(scene) === "secondary"
                            ? "main"
                            : "secondary",
                        )
                      }
                      size="sm"
                      tooltip={
                        sceneRole(scene) === "secondary"
                          ? `当前：${WINDOW_ROLE_LABELS.secondary}专用，点击改为主窗口专用`
                          : `当前：${WINDOW_ROLE_LABELS.main}专用，点击改为副窗口专用（只能被「打开副窗口」使用）`
                      }
                    />
                  )}
                  <IconButton
                    icon={Pencil}
                    label="重命名场景"
                    onClick={() => {
                      setDialog({
                        title: "新的场景 ID",
                        value: scene.id,
                        mode: "rename",
                        previous: scene.id,
                      });
                    }}
                    size="sm"
                  />
                  <IconButton
                    disabled={entry}
                    icon={Trash2}
                    label="删除场景"
                    onClick={() => onDeleteScene(scene.id)}
                    size="sm"
                    tooltip={entry ? "项目入口场景不能删除" : "从项目移除场景"}
                  />
                </div>
              </article>
              {groups !== null && visualLibrary !== undefined && (
                <TextBlockGroup
                  {...textGroupProps(
                    `text-scene:${scene.id}`,
                    scene.id === activeSceneId || sceneTexts.length > 0,
                  )}
                  groupId={`text-scene-${scene.id}`}
                  ids={sceneTexts}
                  library={visualLibrary}
                  onCreate={() =>
                    setTextDialog({
                      title: "新固定文本块 ID",
                      value: suggestVisualId(
                        project,
                        "textBlock",
                        (candidate) =>
                          idUnavailableReason(
                            "textBlock",
                            candidate,
                            project,
                          ) !== null,
                      ),
                      sceneId: scene.id,
                    })
                  }
                  onRename={beginTextRename}
                  sceneId={scene.id}
                  title="固定文本块"
                  toggleLabel={`场景 ${scene.id} 的固定文本块`}
                />
              )}
            </Fragment>
          );
        })}
        {groups !== null &&
          visualLibrary !== undefined &&
          showFallbackGroups && (
            <>
              {groups.shared.length > 0 && (
                <TextBlockGroup
                  {...textGroupProps("text-shared", true)}
                  groupId="text-shared"
                  hint="被多个场景使用或归入多个场景；仍然只有一份定义，改动会同时影响这些场景。"
                  ids={groups.shared.map((entry) => entry.id)}
                  library={visualLibrary}
                  onRename={beginTextRename}
                  sharedScenes={
                    new Map(
                      groups.shared.map((entry) => [entry.id, entry.sceneIds]),
                    )
                  }
                  title="共享文本块"
                />
              )}
              {groups.unassigned.length > 0 && (
                <TextBlockGroup
                  {...textGroupProps("text-unassigned", true)}
                  groupId="text-unassigned"
                  hint="没有任何场景使用或归入；可从场景的 Sprite 来源中选用，或在这里继续编辑。"
                  ids={groups.unassigned}
                  library={visualLibrary}
                  onRename={beginTextRename}
                  title="未归属文本块"
                />
              )}
            </>
          )}
        {scenes.length === 0 && (
          <p className="library-empty">没有匹配的场景。</p>
        )}
      </div>
      {dialog !== null && (
        <TextEntryDialog
          initialValue={dialog.value}
          onCancel={() => setDialog(null)}
          onSubmit={(value) => {
            const accepted =
              dialog.mode === "add"
                ? onAddScene(value, dialog.role)
                : dialog.previous !== undefined && value !== dialog.previous
                  ? onRenameScene(dialog.previous, value)
                  : true;
            if (accepted) setDialog(null);
            return accepted;
          }}
          hint={ID_RULE_HINT}
          title={dialog.title}
          validate={(value) =>
            idUnavailableReason("scene", value, project, {
              previous: dialog.previous,
            })
          }
        />
      )}
      {textDialog !== null && (
        <TextEntryDialog
          initialValue={textDialog.value}
          onCancel={() => setTextDialog(null)}
          onSubmit={(value) => {
            let accepted = false;
            if (textDialog.previous === undefined)
              accepted =
                visualLibrary?.onCreate(
                  "textBlock",
                  value,
                  textDialog.sceneId,
                ) ?? false;
            else if (value === textDialog.previous) accepted = true;
            else
              accepted =
                visualLibrary?.onRename(
                  "textBlock",
                  textDialog.previous,
                  value,
                ) ?? false;
            if (accepted) setTextDialog(null);
            return accepted;
          }}
          hint={ID_RULE_HINT}
          title={textDialog.title}
          validate={(value) =>
            idUnavailableReason("textBlock", value, project, {
              previous: textDialog.previous,
            })
          }
        />
      )}
    </div>
  );
}

/**
 * One group of fixed text blocks under a scene (or the shared / unassigned
 * fallbacks).  Every text appears in exactly one group, so each row edits the
 * single definition no matter where it is listed.
 */
function TextBlockGroup({
  groupId,
  title,
  toggleLabel,
  hint,
  ids,
  sceneId,
  sharedScenes,
  library,
  project,
  open,
  onToggle,
  onCreate,
  onRename,
}: {
  groupId: string;
  title: string;
  toggleLabel?: string;
  /** Explains a fallback group; also shown instead of rows when empty. */
  hint?: string;
  ids: readonly string[];
  /** Scene this group belongs to; the new-text button and Back target. */
  sceneId?: string;
  /** Text id to the scenes that list it (shared group only). */
  sharedScenes?: ReadonlyMap<string, readonly string[]>;
  library: VisualLibraryHandlers;
  project: EditorProject;
  open: boolean;
  onToggle(): void;
  onCreate?(): void;
  onRename(id: string): void;
}): ReactElement {
  const label = VISUAL_KIND_LABELS.textBlock;
  return (
    <CollapsibleSection
      actions={
        onCreate !== undefined && (
          <IconButton
            icon={Plus}
            label={`在场景 ${sceneId ?? ""} 新建${label}`}
            onClick={onCreate}
            size="sm"
            variant="ghost"
          />
        )
      }
      className="scene-text-group"
      id={groupId}
      onToggle={onToggle}
      open={open}
      title={ids.length > 0 ? `${title} · ${ids.length}` : title}
      toggleLabel={toggleLabel}
    >
      {hint !== undefined && ids.length > 0 && (
        <p className="library-empty">{hint}</p>
      )}
      <div className="library-list">
        {ids.map((id) => {
          const definition = (project.text_blocks ?? []).find(
            (file) => file.definition.id === id,
          )?.definition;
          if (definition === undefined) return null;
          const uses = visualReferences(project, "textBlock", id).length;
          const scenes = sharedScenes?.get(id);
          return (
            <LibraryRow
              actions={visualRowActions("textBlock", id, library, () =>
                onRename(id),
              )}
              editLabel={`编辑${label} ${id}`}
              icon={Type}
              key={id}
              meta={`${definition.width}×${definition.height} · ${uses} 处引用${
                scenes === undefined ? "" : ` · ${scenes.join("、")}`
              }`}
              onOpen={() => library.onEdit("textBlock", id, sceneId)}
              title={id}
            />
          );
        })}
        {ids.length === 0 && (
          <p className="library-empty">
            还没有{label}。新建后可在 Sprite 的图像来源中选用。
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}
