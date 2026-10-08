import type { ReactElement } from "react";
import {
  CopyPlus,
  MousePointerClick,
  Pencil,
  PersonStanding,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { IconButton } from "../../ui/Button";
import { LibraryRow } from "../LibraryRow";
import { idUnavailableReason } from "../../app/ids";
import {
  suggestVisualId,
  visualReferences,
  VISUAL_KIND_LABELS,
} from "../../app/visualLibrary";
import { findButtonTemplateReferences } from "../assetReferences";
import type { ContentManifest, EditorProject } from "../../types";
import { CollapsibleSection } from "./CollapsibleSection";
import { visualRowActions } from "./visualRowActions";
import type { ProjectDialogRequest, VisualLibraryHandlers } from "./types";

interface SectionProps {
  open: boolean;
  onToggle(): void;
}

export function UiMotionSection({
  manifest,
  onChange,
  onCreate,
  onDelete,
  onEdit,
  onToggle,
  open,
  project,
}: SectionProps & {
  manifest: ContentManifest;
  onChange(manifest: ContentManifest): void;
  onCreate(): void;
  onDelete(id: string): void;
  onEdit(id: string): void;
  project: EditorProject;
}): ReactElement {
  const defaultMotionSelect = (
    key: "dialogue_show" | "dialogue_hide",
    label: string,
    noneLabel: string,
  ): ReactElement => (
    <label>
      <span>{label}</span>
      <select
        value={manifest.ui_motion_defaults[key] ?? ""}
        onChange={(event) =>
          onChange({
            ...manifest,
            ui_motion_defaults: {
              ...manifest.ui_motion_defaults,
              [key]: event.currentTarget.value || null,
            },
          })
        }
      >
        <option value="">{noneLabel}</option>
        {project.ui_motions.map(({ definition }) => (
          <option key={definition.id} value={definition.id}>
            {definition.id}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <CollapsibleSection
      actions={
        <IconButton
          icon={Plus}
          label="新建 UI 动效"
          onClick={onCreate}
          size="sm"
        />
      }
      className="ui-motion-settings"
      id="ui-motion"
      onToggle={onToggle}
      open={open}
      title="UI 动效"
    >
      {defaultMotionSelect(
        "dialogue_show",
        "对话框出现默认动效",
        "无（立即出现）",
      )}
      {defaultMotionSelect(
        "dialogue_hide",
        "对话框收起默认动效",
        "无（立即收起）",
      )}
      <div className="library-list">
        {project.ui_motions.map(({ definition, path }) => (
          <LibraryRow
            actions={[
              {
                id: "delete",
                label: "从项目移除",
                icon: Trash2,
                danger: true,
                onSelect: () => onDelete(definition.id),
              },
            ]}
            editLabel={`编辑 UI 动效 ${definition.id}`}
            icon={Sparkles}
            key={definition.id}
            meta={`${definition.duration_ms} ms · ${path}`}
            onOpen={() => onEdit(definition.id)}
            title={definition.id}
          />
        ))}
        {project.ui_motions.length === 0 && (
          <p className="library-empty">
            还没有 UI 动效。创建后可在对话框与 UI 动效节点中复用。
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}

export function ButtonTemplateSection({
  onCreate,
  onDelete,
  onDuplicate,
  onEdit,
  onToggle,
  open,
  project,
}: SectionProps & {
  onCreate(): void;
  onDelete(id: string): void;
  onDuplicate(id: string): void;
  onEdit(id: string): void;
  project: EditorProject;
}): ReactElement {
  const buttons = project.buttons ?? [];
  return (
    <CollapsibleSection
      actions={
        <IconButton
          icon={Plus}
          label="新建按钮模板"
          onClick={onCreate}
          size="sm"
        />
      }
      className="button-template-settings"
      id="button-template"
      onToggle={onToggle}
      open={open}
      title="按钮模板"
    >
      <div className="library-list">
        {buttons.map(({ definition }) => {
          const references = findButtonTemplateReferences(
            project,
            definition.id,
          );
          return (
            <LibraryRow
              actions={[
                {
                  id: "duplicate",
                  label: "创建副本",
                  icon: CopyPlus,
                  onSelect: () => onDuplicate(definition.id),
                },
                { kind: "separator", id: "sep" },
                {
                  id: "delete",
                  label: "从项目移除",
                  icon: Trash2,
                  danger: true,
                  disabled: references.length > 0,
                  hint: `仍被 ${references.length} 处剧情引用`,
                  onSelect: () => onDelete(definition.id),
                },
              ]}
              editLabel={`编辑按钮模板 ${definition.id}`}
              icon={MousePointerClick}
              key={definition.id}
              meta={`${definition.width} × ${definition.height} · ${
                references.length === 0
                  ? "未被引用"
                  : `${references.length} 处引用`
              }`}
              onOpen={() => onEdit(definition.id)}
              title={definition.id}
            />
          );
        })}
        {buttons.length === 0 && (
          <p className="library-empty">
            还没有按钮模板。创建后可在「创建按钮」节点中生成多个实例。
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}

export function ActionSection({
  onDelete,
  onDuplicate,
  onEditKeyframes,
  onRequestDialog,
  onToggle,
  open,
  project,
}: SectionProps & {
  onDelete(id: string): void;
  onDuplicate(id: string): void;
  onEditKeyframes(id: string): void;
  onRequestDialog(request: ProjectDialogRequest): void;
  project: EditorProject;
}): ReactElement {
  const actions = project.actions ?? [];
  return (
    <CollapsibleSection
      actions={
        <IconButton
          onClick={() => {
            let index = actions.length + 1;
            let id = `sprite.action_${index}`;
            while (actions.some((file) => file.definition.id === id)) {
              index += 1;
              id = `sprite.action_${index}`;
            }
            onRequestDialog({
              title: "新立绘动作 ID",
              value: id,
              kind: "action_add",
            });
          }}
          icon={Plus}
          label="新建立绘动作"
          size="sm"
          variant="ghost"
        />
      }
      className="action-settings"
      id="sprite-action"
      onToggle={onToggle}
      open={open}
      title="立绘动作库"
    >
      <div className="library-list">
        {actions.map(({ definition }) => (
          <LibraryRow
            actions={[
              {
                id: "rename",
                label: "重命名 ID…",
                icon: Pencil,
                onSelect: () =>
                  onRequestDialog({
                    title: "新的动作 ID",
                    value: definition.id,
                    kind: "action_rename",
                    previous: definition.id,
                  }),
              },
              {
                id: "duplicate",
                label: "创建副本",
                icon: CopyPlus,
                onSelect: () => onDuplicate(definition.id),
              },
              { kind: "separator", id: "sep" },
              {
                id: "delete",
                label: "从项目移除",
                icon: Trash2,
                danger: true,
                onSelect: () => onDelete(definition.id),
              },
            ]}
            editLabel={`编辑立绘动作 ${definition.id}`}
            icon={PersonStanding}
            key={definition.id}
            meta={`${definition.id} · ${definition.duration_ms} ms`}
            onOpen={() => onEditKeyframes(definition.id)}
            title={definition.name || definition.id}
          />
        ))}
        {actions.length === 0 && (
          <p className="library-empty">
            还没有立绘动作。动作以立绘当前姿态为基准，可在「立绘动作」节点中调用。
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}

export function ParticleSection({
  library,
  onRequestDialog,
  onToggle,
  open,
  project,
}: SectionProps & {
  library: VisualLibraryHandlers;
  onRequestDialog(request: ProjectDialogRequest): void;
  project: EditorProject;
}): ReactElement {
  const label = VISUAL_KIND_LABELS.particle;
  const particles = project.particles ?? [];
  return (
    <CollapsibleSection
      actions={
        <IconButton
          icon={Plus}
          label={`新建${label}`}
          onClick={() =>
            onRequestDialog({
              title: `新${label} ID`,
              value: suggestVisualId(
                project,
                "particle",
                (candidate) =>
                  idUnavailableReason("particle", candidate, project) !== null,
              ),
              kind: "visual_add",
              visual: "particle",
            })
          }
          size="sm"
          variant="ghost"
        />
      }
      id="particle"
      onToggle={onToggle}
      open={open}
      title={label}
    >
      <div className="library-list">
        {particles.map(({ definition }) => {
          const uses = visualReferences(
            project,
            "particle",
            definition.id,
          ).length;
          return (
            <LibraryRow
              actions={visualRowActions(
                "particle",
                definition.id,
                library,
                () =>
                  onRequestDialog({
                    title: `新的${label} ID`,
                    value: definition.id,
                    kind: "visual_rename",
                    previous: definition.id,
                    visual: "particle",
                  }),
              )}
              editLabel={`编辑${label} ${definition.id}`}
              icon={Sparkles}
              key={definition.id}
              meta={`${definition.image || "未选图片"} · 上限 ${definition.max_particles} · ${uses} 处引用`}
              onOpen={() => library.onEdit("particle", definition.id)}
              title={definition.id}
            />
          );
        })}
        {particles.length === 0 && (
          <p className="library-empty">
            还没有粒子效果。粒子由「图片粒子」节点整体启动、停止或爆发。
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}
