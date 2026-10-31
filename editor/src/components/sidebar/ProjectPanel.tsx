import { useState, type ReactElement } from "react";
import { Plus } from "lucide-react";
import { sceneRole } from "../../windowInteraction";
import type { ProjectSectionId, SidebarScrollStore } from "../projectSections";
import { firstVisibleAssetId } from "../../assetLibrary";
import { useAssetLayout } from "../AssetChooser";
import { IconButton } from "../../ui/Button";
import { ID_RULE_HINT, idUnavailableReason } from "../../app/ids";
import type {
  CharacterDefinition,
  ContentManifest,
  EditorProject,
  VariableDefinition,
} from "../../types";
import type {
  ProjectDialogRequest,
  ProjectPanelView,
  SidebarTab,
  VisualLibraryHandlers,
} from "./types";
import { useSidebarScroller } from "./useSidebarScroller";
import { DeferredTextInput } from "./projectInputs";
import { CollapsibleSection } from "./CollapsibleSection";
import { TextEntryDialog } from "./TextEntryDialog";
import {
  ActionSection,
  ButtonTemplateSection,
  ParticleSection,
  UiMotionSection,
} from "./LibrarySections";
import { CharacterCard } from "./CharacterCard";
import { VariableCard } from "./VariableCard";

export function ProjectPanel({
  manifest,
  onChange,
  onAddVariable,
  onChangeVariable,
  onDeleteVariable,
  onRenameVariable,
  onAddCharacter,
  onChangeCharacter,
  onDeleteCharacter,
  onRenameCharacter,
  onCreateUiMotion,
  onEditUiMotion,
  onDeleteUiMotion,
  onCreateButtonTemplate,
  onEditButtonTemplate,
  onDuplicateButtonTemplate,
  onDeleteButtonTemplate,
  onCreateAction,
  onRenameAction,
  onDuplicateAction,
  onDeleteAction,
  onEditActionKeyframes,
  visualLibrary,
  onScrollOffset,
  project,
  scrollStore,
  sectionOpen,
  onToggleSection,
  sidebarItemOpen,
  onToggleSidebarItem,
  view = "all",
}: {
  manifest: ContentManifest;
  onChange(manifest: ContentManifest): void;
  onAddVariable(id: string, definition: VariableDefinition): boolean;
  onChangeVariable(id: string, definition: VariableDefinition): void;
  onDeleteVariable(id: string): void;
  onRenameVariable(previousId: string, nextId: string): boolean;
  onAddCharacter(id: string, definition: CharacterDefinition): boolean;
  onChangeCharacter(id: string, definition: CharacterDefinition): void;
  onDeleteCharacter(id: string): void;
  onRenameCharacter(previousId: string, nextId: string): boolean;
  onCreateUiMotion(): void;
  onEditUiMotion(id: string): void;
  onDeleteUiMotion(id: string): void;
  onCreateButtonTemplate(): void;
  onEditButtonTemplate(id: string): void;
  onDuplicateButtonTemplate(id: string): void;
  onDeleteButtonTemplate(id: string): void;
  onCreateAction(id: string): boolean;
  onRenameAction(previousId: string, nextId: string): boolean;
  onDuplicateAction(id: string): void;
  onDeleteAction(id: string): void;
  onEditActionKeyframes(id: string): void;
  visualLibrary?: VisualLibraryHandlers;
  onScrollOffset?(tab: SidebarTab, offset: number): void;
  project: EditorProject;
  scrollStore?: SidebarScrollStore;
  sectionOpen?: Partial<Record<ProjectSectionId, boolean>>;
  onToggleSection?(id: ProjectSectionId): void;
  sidebarItemOpen?: Readonly<Record<string, boolean>>;
  onToggleSidebarItem?(key: string): void;
  /** Which slice of the project settings to show; "all" stacks every section. */
  view?: "all" | ProjectPanelView;
}): ReactElement {
  const show = (group: ProjectPanelView): boolean =>
    view === "all" || view === group;
  const [dialog, setDialog] = useState<ProjectDialogRequest | null>(null);
  const { onScroll: onSettingsScroll, ref: settingsRef } = useSidebarScroller(
    "project",
    scrollStore,
    onScrollOffset,
  );
  const assetLayout = useAssetLayout();
  // A hidden asset must never be chosen silently: the first *visible* sprite
  // seeds a new expression, and with none available the ＋ action is disabled
  // with an explanation instead of falling back to a hidden asset.
  const defaultExpressionSprite = firstVisibleAssetId(
    project.assets,
    assetLayout,
    "sprite",
  );
  const sectionProps = (id: ProjectSectionId) => ({
    open: sectionOpen?.[id] ?? true,
    onToggle: () => onToggleSection?.(id),
  });
  const itemProps = (kind: "character" | "variable", id: string) => ({
    open: sidebarItemOpen?.[`${kind}:${id}`] ?? true,
    onToggle: () => onToggleSidebarItem?.(`${kind}:${id}`),
  });
  const submitDialog = (
    value: string,
    { kind, previous, visual }: ProjectDialogRequest,
  ): boolean => {
    const renamed = previous !== undefined && value !== previous;
    switch (kind) {
      case "character_add":
        return manifest.characters[value] === undefined
          ? onAddCharacter(value, {
              display_name: "新角色",
              name_color: "#1D2948",
              text_color: "#17213A",
            })
          : false;
      case "character_rename":
        return renamed ? onRenameCharacter(previous, value) : true;
      case "variable_add":
        return manifest.variables[value] === undefined
          ? onAddVariable(value, {
              scope: "save",
              type: "boolean",
              default: false,
            })
          : false;
      case "variable_rename":
        return renamed ? onRenameVariable(previous, value) : true;
      case "visual_add":
        return visual === undefined
          ? true
          : (visualLibrary?.onCreate(visual, value) ?? false);
      case "visual_rename":
        return visual !== undefined && renamed
          ? (visualLibrary?.onRename(visual, previous, value) ?? false)
          : true;
      case "action_add":
        return onCreateAction(value);
      case "action_rename":
        return previous === undefined ? true : onRenameAction(previous, value);
    }
  };
  return (
    <div
      className={`sidebar-body project-settings project-view-${view}`}
      data-sidebar-scroller="project"
      onScroll={onSettingsScroll}
      ref={settingsRef}
    >
      {show("project") && (
        <>
          <label>
            <span>内容版本</span>
            <DeferredTextInput
              value={manifest.content_version}
              onCommit={(content_version) =>
                onChange({ ...manifest, content_version })
              }
            />
            <small>改变后旧存档将不再兼容</small>
          </label>
          <label>
            <span>默认语言</span>
            <DeferredTextInput
              value={manifest.default_locale}
              onCommit={(default_locale) =>
                onChange({ ...manifest, default_locale })
              }
            />
          </label>
          <label>
            <span>项目入口场景</span>
            <select
              value={manifest.entry_scene}
              onChange={(event) =>
                onChange({
                  ...manifest,
                  entry_scene: event.currentTarget.value,
                })
              }
            >
              {project.scenes
                .filter(
                  (file) =>
                    sceneRole(file.definition) === "main" ||
                    file.definition.id === manifest.entry_scene,
                )
                .map((file) => (
                  <option key={file.definition.id} value={file.definition.id}>
                    {file.definition.id}
                    {sceneRole(file.definition) === "secondary"
                      ? "（副窗口专用，不能作为入口）"
                      : ""}
                  </option>
                ))}
            </select>
          </label>
        </>
      )}
      {show("library") && (
        <>
          <UiMotionSection
            {...sectionProps("ui-motion")}
            manifest={manifest}
            onChange={onChange}
            onCreate={onCreateUiMotion}
            onDelete={onDeleteUiMotion}
            onEdit={onEditUiMotion}
            project={project}
          />
          <ButtonTemplateSection
            {...sectionProps("button-template")}
            onCreate={onCreateButtonTemplate}
            onDelete={onDeleteButtonTemplate}
            onDuplicate={onDuplicateButtonTemplate}
            onEdit={onEditButtonTemplate}
            project={project}
          />
          <ActionSection
            {...sectionProps("sprite-action")}
            onDelete={onDeleteAction}
            onDuplicate={onDuplicateAction}
            onEditKeyframes={onEditActionKeyframes}
            onRequestDialog={setDialog}
            project={project}
          />
          {visualLibrary !== undefined && (
            <ParticleSection
              {...sectionProps("particle")}
              library={visualLibrary}
              onRequestDialog={setDialog}
              project={project}
            />
          )}
        </>
      )}
      {show("characters") && (
        <CollapsibleSection
          actions={
            <IconButton
              onClick={() =>
                setDialog({
                  title: "新角色 ID",
                  value: "new_character",
                  kind: "character_add",
                })
              }
              icon={Plus}
              label="新建角色"
              size="sm"
              variant="ghost"
            />
          }
          className="character-settings"
          id="character"
          {...sectionProps("character")}
          title="角色"
        >
          {Object.entries(manifest.characters).map(([id, definition]) => (
            <CharacterCard
              {...itemProps("character", id)}
              assets={project.assets}
              defaultExpressionSprite={defaultExpressionSprite}
              definition={definition}
              id={id}
              key={id}
              onChange={(next) => onChangeCharacter(id, next)}
              onDelete={() => onDeleteCharacter(id)}
              onRename={() =>
                setDialog({
                  title: "新的角色 ID",
                  value: id,
                  kind: "character_rename",
                  previous: id,
                })
              }
            />
          ))}
        </CollapsibleSection>
      )}
      {show("variables") && (
        <CollapsibleSection
          actions={
            <IconButton
              onClick={() =>
                setDialog({
                  title: "新变量 ID",
                  value: "new_variable",
                  kind: "variable_add",
                })
              }
              icon={Plus}
              label="新建变量"
              size="sm"
              variant="ghost"
            />
          }
          id="variable"
          {...sectionProps("variable")}
          title="剧情变量"
        >
          {Object.entries(manifest.variables).map(([id, definition]) => (
            <VariableCard
              {...itemProps("variable", id)}
              definition={definition}
              id={id}
              key={id}
              onChange={(next) => onChangeVariable(id, next)}
              onDelete={() => onDeleteVariable(id)}
              onRename={() =>
                setDialog({
                  title: "新的变量 ID",
                  value: id,
                  kind: "variable_rename",
                  previous: id,
                })
              }
            />
          ))}
        </CollapsibleSection>
      )}
      {show("project") && (
        <>
          <dl className="project-facts">
            <div>
              <dt>Schema</dt>
              <dd>{manifest.schema_version}</dd>
            </div>
            <div>
              <dt>场景</dt>
              <dd>{project.scenes.length}</dd>
            </div>
            <div>
              <dt>素材</dt>
              <dd>{Object.keys(manifest.assets).length}</dd>
            </div>
          </dl>
          <code className="project-root">{project.root}</code>
        </>
      )}
      {dialog !== null && (
        <TextEntryDialog
          initialValue={dialog.value}
          onCancel={() => setDialog(null)}
          onSubmit={(value) => {
            const accepted = submitDialog(value, dialog);
            if (accepted) setDialog(null);
            return accepted;
          }}
          hint={ID_RULE_HINT}
          title={dialog.title}
          validate={(value) =>
            idUnavailableReason(
              dialog.visual ??
                (dialog.kind.startsWith("character")
                  ? "character"
                  : dialog.kind.startsWith("variable")
                    ? "variable"
                    : "action"),
              value,
              project,
              { previous: dialog.previous },
            )
          }
        />
      )}
    </div>
  );
}
