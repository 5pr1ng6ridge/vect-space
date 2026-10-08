import type { LongTextNode, SceneDefinition, SceneNode } from "../types";
import { uniqueNodeId } from "./project";

export function splitDialogueAt(
  scene: SceneDefinition,
  nodeId: string,
  offset: number,
): { first: SceneNode; continuation: SceneNode; continuationId: string } {
  const node = scene.nodes[nodeId];
  if (node?.type !== "say") throw new Error("只能拆分对话节点。");
  const before = node.text.slice(0, offset);
  const after = node.text.slice(offset);
  if (before.trim() === "" || after.trim() === "") {
    throw new Error("请把光标放在对话正文内部；分段前后都必须有文本。");
  }
  const continuationId = uniqueNodeId(scene, `${nodeId}_continue`);
  const pageId =
    node.page_id === null || node.page_id === undefined || node.page_id === ""
      ? nodeId
      : node.page_id;
  return {
    continuationId,
    first: {
      ...node,
      text: before,
      mode: node.mode ?? "start",
      page_id: pageId,
      next: continuationId,
    },
    continuation: {
      ...node,
      text: after,
      mode: "append",
      page_id: pageId,
      next: node.next,
    },
  };
}

interface SplitLongTextResult {
  first: LongTextNode;
  continuation: LongTextNode;
  continuationId: string;
  previousDocument: string;
  document: string;
}

/**
 * Rewrite references to a long-text document within one scene.  This is
 * intentionally shared by normal document edits and the split command so an
 * implicit document (whose ID is the start node ID) cannot leave controls or
 * continuation nodes dangling.
 */
export function rewriteLongTextDocumentReferences(
  scene: SceneDefinition,
  from: string,
  to: string,
  excludedNodeId?: string,
): void {
  if (from === to) return;
  for (const [candidateId, candidate] of Object.entries(scene.nodes)) {
    if (
      candidateId === excludedNodeId ||
      (candidate.type !== "long_text" &&
        candidate.type !== "long_text_control") ||
      candidate.document !== from
    ) {
      continue;
    }
    candidate.document = to;
  }
}

/**
 * Split a long-text node before `stepIndex`.  The returned continuation only
 * carries fields that are legal on a `continue` node; presentation fields are
 * inherited from the first node at runtime and must not be serialized again.
 */
export function splitLongTextAt(
  scene: SceneDefinition,
  nodeId: string,
  stepIndex: number,
): SplitLongTextResult {
  const source = scene.nodes[nodeId];
  if (source?.type !== "long_text") {
    throw new Error("只能拆分长文本节点。");
  }
  if (stepIndex <= 0 || stepIndex >= source.steps.length) {
    throw new Error("只能在第二段及之后拆分长文本。");
  }

  const continuationId = uniqueNodeId(scene, `${nodeId}_continue`);
  const usedDocuments = new Set(
    Object.entries(scene.nodes).flatMap(([id, node]) =>
      node.type === "long_text" ? [node.document ?? id] : [],
    ),
  );
  const previousDocument = source.document ?? nodeId;
  let document = source.document ?? `${nodeId}_document`;
  let suffix = 2;
  while (usedDocuments.has(document) && document !== source.document) {
    document = `${nodeId}_document_${suffix}`;
    suffix += 1;
  }

  const first: LongTextNode = {
    ...source,
    document,
    mode: source.mode ?? "start",
    on_exit: "keep_visible",
    steps: source.steps.slice(0, stepIndex),
    next: continuationId,
  };
  const continuation: LongTextNode = {
    ...source,
    document,
    mode: "continue",
    steps: source.steps.slice(stepIndex),
    next: source.next,
  };
  delete continuation.paper;
  delete continuation.pagination;
  delete continuation.font_size;
  delete continuation.text_color;
  delete continuation.layout;

  return {
    first,
    continuation,
    continuationId,
    previousDocument,
    document,
  };
}
