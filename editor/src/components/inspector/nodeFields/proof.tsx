import type { ReactNode } from "react";
import { Field } from "../../Fields";
import { TargetSelect } from "../fieldControls";
import type { FieldsContext, NodeOf } from "../fieldsContext";

export function proofFields(
  node: NodeOf<"proof">,
  ctx: FieldsContext,
): ReactNode {
  const { update, targets, preview } = ctx;
  const puzzles = (preview?.project.proofs ?? []).flatMap(
    (file) => file.definition.puzzles ?? [],
  );
  return (
    <>
      <Field label="证明题">
        <select
          value={node.puzzle}
          onChange={(event) =>
            update({ ...node, puzzle: event.currentTarget.value })
          }
        >
          <option value="">选择证明题</option>
          {node.puzzle &&
            !puzzles.some((puzzle) => puzzle.id === node.puzzle) && (
              <option value={node.puzzle}>{node.puzzle}（未登记）</option>
            )}
          {puzzles.map((puzzle) => (
            <option key={puzzle.id} value={puzzle.id}>
              {puzzle.title} ({puzzle.id})
            </option>
          ))}
        </select>
      </Field>
      <TargetSelect
        label="证明完成后"
        value={node.next}
        targets={targets}
        onChange={(next) => update({ ...node, next })}
      />
      <TargetSelect
        label="放弃后"
        value={node.abandon ?? ""}
        targets={targets}
        emptyLabel="不允许放弃"
        onChange={(abandon) => {
          const next = { ...node };
          if (abandon) next.abandon = abandon;
          else delete next.abandon;
          update(next);
        }}
      />
      <p className="field-note">
        证明题文档为只读，请在项目的 proofs YAML 中编辑。
      </p>
    </>
  );
}
