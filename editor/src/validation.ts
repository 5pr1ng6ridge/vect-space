import { outputPorts } from "./story";
import { validateTemplate } from "./textTemplate";
import { isIntegerScalar, scalarType } from "./scalars";
import type {
  AssetKind,
  ConditionExpression,
  EditorDiagnostic,
  EditorProject,
  ScalarValue,
  SceneNode,
  TimelineTrack,
  UiMotionPreset,
  ValueOperand,
  VariableType,
} from "./types";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function validateLive(project: EditorProject): EditorDiagnostic[] {
  const diagnostics: EditorDiagnostic[] = [];
  validateManagedDocumentPaths(project, diagnostics);
  const sceneById = new Map(
    project.scenes.map(
      (file) => [file.definition.id, file.definition] as const,
    ),
  );

  if (!sceneById.has(project.manifest.entry_scene)) {
    diagnostics.push(error("missing_entry_scene", "项目入口场景不存在"));
  }

  if (project.manifest.schema_version !== 2) {
    diagnostics.push(
      error("invalid_manifest_schema", "manifest schema_version 必须为 2"),
    );
  }
  for (const [id, definition] of Object.entries(project.manifest.variables)) {
    if (!ID_PATTERN.test(id)) {
      diagnostics.push(error("invalid_variable", `变量名非法：${id}`));
    }
    if (!valueMatchesType(definition.default, definition.type)) {
      diagnostics.push(
        error(
          "invalid_variable_default",
          `变量 ${id} 的默认值不符合 ${definition.type} 类型`,
        ),
      );
    }
  }
  for (const [id, definition] of Object.entries(project.manifest.characters)) {
    if (!ID_PATTERN.test(id)) {
      diagnostics.push(error("invalid_character", `角色 ID 非法：${id}`));
    }
    validateDisplayName(definition.display_name).forEach((message) =>
      diagnostics.push(
        error("invalid_character_name", `角色 ${id}：${message}`),
      ),
    );
    for (const [field, color] of [
      ["姓名色", definition.name_color],
      ["正文色", definition.text_color],
    ] as const) {
      if (
        color != null &&
        !/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(color)
      ) {
        diagnostics.push(
          error("invalid_character_color", `角色 ${id} 的${field}格式非法`),
        );
      }
    }
  }
  const motionIds = new Set(
    project.ui_motions.map((file) => file.definition.id),
  );
  const declaredMotionPaths = new Set(project.manifest.ui_motions);
  for (const file of project.ui_motions) {
    if (!declaredMotionPaths.has(file.path)) {
      diagnostics.push(
        error("undeclared_ui_motion", `UI 动效文件未登记：${file.path}`),
      );
    }
    const preset = file.definition;
    if (preset.schema_version !== 1 || !ID_PATTERN.test(preset.id)) {
      diagnostics.push(
        error("invalid_ui_motion", `UI 动效定义无效：${preset.id}`),
      );
    }
    if (
      !Number.isInteger(preset.duration_ms) ||
      preset.duration_ms < 1 ||
      preset.duration_ms > 1_800_000
    ) {
      diagnostics.push(
        error("invalid_ui_motion_duration", `UI 动效 ${preset.id} 时长无效`),
      );
    }
    validateUiMotionPreset(preset, diagnostics);
  }
  for (const [slot, motion] of [
    ["dialogue_show", project.manifest.ui_motion_defaults.dialogue_show],
    ["dialogue_hide", project.manifest.ui_motion_defaults.dialogue_hide],
  ] as const) {
    if (motion != null && !motionIds.has(motion)) {
      diagnostics.push(
        error(
          "unknown_ui_motion",
          `默认槽位 ${slot} 引用了未知 UI 动效 ${motion}`,
        ),
      );
    }
  }

  const seenScenes = new Set<string>();
  for (const file of project.scenes) {
    const scene = file.definition;
    if (scene.schema_version !== 2) {
      diagnostics.push(
        error(
          "invalid_scene_schema",
          "scene schema_version 必须为 2",
          scene.id,
        ),
      );
    }
    if (!ID_PATTERN.test(scene.id)) {
      diagnostics.push(
        error("invalid_scene_id", `非法场景 ID：${scene.id}`, scene.id),
      );
    }
    if (seenScenes.has(scene.id)) {
      diagnostics.push(
        error("duplicate_scene_id", `场景 ID 重复：${scene.id}`, scene.id),
      );
    }
    seenScenes.add(scene.id);
    if (scene.nodes[scene.entry] === undefined) {
      diagnostics.push(
        error(
          "missing_scene_entry",
          `入口节点不存在：${scene.entry}`,
          scene.id,
        ),
      );
    }

    const longTextDocuments = new Map<
      string,
      {
        hasStart: boolean;
        nodeId: string;
        stepIds: Map<string, string>;
        startPagination?: "continuous" | "auto" | "manual";
      }
    >();
    for (const [nodeId, candidate] of Object.entries(scene.nodes)) {
      if (candidate.type !== "long_text") continue;
      const documentId = candidate.document ?? nodeId;
      const existing = longTextDocuments.get(documentId);
      if (existing === undefined) {
        const stepIds = new Map<string, string>();
        for (const step of candidate.steps) {
          if (stepIds.has(step.id)) {
            diagnostics.push(
              error(
                "duplicate_long_text_step",
                `文稿 ${documentId} 的步骤 ID ${step.id} 在同一节点中重复`,
                scene.id,
                nodeId,
              ),
            );
          }
          stepIds.set(step.id, nodeId);
        }
        longTextDocuments.set(documentId, {
          hasStart: (candidate.mode ?? "start") === "start",
          nodeId,
          startPagination:
            (candidate.mode ?? "start") === "start"
              ? (candidate.pagination ?? "auto")
              : undefined,
          stepIds,
        });
      } else {
        if ((candidate.mode ?? "start") === "start" && existing.hasStart) {
          diagnostics.push(
            error(
              "duplicate_long_text_start",
              `文稿 ${documentId} 只能有一个开始节点`,
              scene.id,
              nodeId,
            ),
          );
        }
        if ((candidate.mode ?? "start") === "start") {
          existing.hasStart = true;
          existing.nodeId = nodeId;
          existing.startPagination = candidate.pagination ?? "auto";
        }
        for (const step of candidate.steps) {
          const previousNodeId = existing.stepIds.get(step.id);
          if (previousNodeId !== undefined) {
            const location =
              previousNodeId === nodeId
                ? "同一节点中重复"
                : `与节点 ${previousNodeId} 重复`;
            diagnostics.push(
              error(
                "duplicate_long_text_step",
                `文稿 ${documentId} 的步骤 ID ${step.id}${location}`,
                scene.id,
                nodeId,
              ),
            );
          }
          existing.stepIds.set(step.id, nodeId);
        }
      }
    }
    for (const [documentId, document] of longTextDocuments) {
      if (!document.hasStart) {
        diagnostics.push(
          error(
            "missing_long_text_start",
            `文稿 ${documentId} 缺少开始节点`,
            scene.id,
            document.nodeId,
          ),
        );
      }
    }

    for (const [nodeId, node] of Object.entries(scene.nodes)) {
      if (!ID_PATTERN.test(nodeId)) {
        diagnostics.push(
          error("invalid_node_id", `非法节点 ID：${nodeId}`, scene.id, nodeId),
        );
      }
      validateNode(project, scene.id, nodeId, node, diagnostics);
      if (node.type === "long_text" && node.mode === "continue") {
        const document = node.document ?? nodeId;
        if (
          longTextDocuments.get(document)?.startPagination === "continuous" &&
          node.steps.some((step) => step.page_break_before)
        ) {
          diagnostics.push(
            error(
              "continuous_long_text_break",
              "开始节点使用连续长卷时，接续段不能使用强制分页",
              scene.id,
              nodeId,
            ),
          );
        }
      }
      for (const port of outputPorts(node)) {
        const destinationScene = port.targetScene ?? scene.id;
        const destination = sceneById.get(destinationScene);
        if (destination === undefined) {
          diagnostics.push(
            error(
              "missing_target_scene",
              `端口“${port.label}”指向不存在的场景 ${destinationScene}`,
              scene.id,
              nodeId,
            ),
          );
        } else if (destination.nodes[port.target] === undefined) {
          diagnostics.push(
            error(
              "missing_target_node",
              `端口“${port.label}”指向不存在的节点 ${destinationScene}/${port.target}`,
              scene.id,
              nodeId,
            ),
          );
        }
      }
    }

    for (const [nodeId, node] of Object.entries(scene.nodes)) {
      if (
        node.type === "long_text_control" &&
        !longTextDocuments.has(node.document)
      ) {
        diagnostics.push(
          error(
            "unknown_long_text_document",
            `文稿控制引用了未知文稿：${node.document}`,
            scene.id,
            nodeId,
          ),
        );
      }
    }
  }

  validateStoryFlow(project, sceneById, diagnostics);
  validateChapterMap(project, sceneById, diagnostics);

  diagnostics.push(...reachabilityWarnings(project, sceneById));
  return deduplicate([...diagnostics, ...project.diagnostics]);
}

function validateManagedDocumentPaths(
  project: EditorProject,
  output: EditorDiagnostic[],
): void {
  const paths: [string, string][] = [
    ...project.manifest.scenes.map((path): [string, string] => ["scene", path]),
    ...project.manifest.ui_motions.map((path): [string, string] => [
      "ui_motion",
      path,
    ]),
  ];
  if (project.manifest.story_flow != null)
    paths.push(["story_flow", project.manifest.story_flow]);
  if (project.manifest.chapter_map != null)
    paths.push(["chapter_map", project.manifest.chapter_map]);
  const seen = new Map<string, string>();
  for (const [kind, path] of paths) {
    const normalized = path.replaceAll("\\", "/").toLowerCase();
    if (
      normalized === "manifest.yaml" ||
      normalized.startsWith("assets/") ||
      normalized.startsWith(".vectspace/")
    ) {
      output.push(
        error(
          "reserved_document_path",
          `${kind} 路径不能覆盖受管制文件：${path}`,
        ),
      );
    }
    const previous = seen.get(normalized);
    if (previous !== undefined) {
      output.push(
        error(
          "duplicate_document_path",
          `内容文件路径与 ${previous} 冲突：${path}`,
        ),
      );
    } else {
      seen.set(normalized, kind);
    }
  }
}

function validateChapterMap(
  project: EditorProject,
  scenes: Map<string, EditorProject["scenes"][number]["definition"]>,
  output: EditorDiagnostic[],
): void {
  const file = project.chapter_map;
  if (file === null || file === undefined) {
    if (project.manifest.chapter_map != null) {
      output.push(
        mapError(
          "missing_chapter_map",
          "manifest 声明了 chapter_map，但编辑器文档不存在",
          null,
        ),
      );
    }
    return;
  }
  const map = file.definition;
  const issue = (
    code: string,
    message: string,
    id: string | null = null,
  ): void => {
    output.push({
      severity: "error",
      code: `map_${code}`,
      message,
      scene_id: null,
      node_id: null,
      workspace: "map",
      flow_element_id: id,
    });
  };
  if (project.manifest.chapter_map !== file.path)
    issue("path", "chapter_map 文件路径与 manifest 不一致");
  if (map.schema_version !== 1)
    issue("schema", "chapter map schema_version 必须为 1");
  if (
    !Number.isInteger(map.width) ||
    !Number.isInteger(map.height) ||
    map.width < 1920 ||
    map.height < 1080 ||
    map.width > 16380 ||
    map.height > 16380 ||
    map.width % 20 !== 0 ||
    map.height % 20 !== 0
  ) {
    issue(
      "size",
      "房间尺寸必须在 1920×1080 到 16380×16380 之间并吸附到 20px 网格",
    );
  }
  const validViewCenter = (
    value: number,
    roomSize: number,
    viewportSize: number,
  ): boolean => {
    if (!Number.isInteger(value) || value < 0) return false;
    if (value % 20 !== 0) return false;
    if (roomSize <= viewportSize) return value === roomSize / 2;
    const half = viewportSize / 2;
    return value >= half && value <= roomSize - half;
  };
  if (
    !validViewCenter(map.view_x, map.width, 1920) ||
    !validViewCenter(map.view_y, map.height, 1080)
  )
    issue("view", "初始视图中心超出 1920×1080 视口边界");
  if (map.background != null) {
    const background = project.manifest.assets[map.background];
    if (background === undefined || background.kind !== "background")
      issue("background", `地图背景素材无效：${map.background}`, null);
  }
  const ids = new Set<string>();
  for (const item of map.decorations) {
    if (!ID_PATTERN.test(item.id) || !ids.add(item.id))
      issue("object_id", `地图装饰 ID 非法或重复：${item.id}`, item.id);
    if (
      !Number.isInteger(item.z) ||
      item.z < -2147483648 ||
      item.z > 2147483647
    )
      issue("z", `地图对象 ${item.id} 层级必须是 32 位整数`, item.id);
    validateMapRect(
      item.x,
      item.y,
      item.width,
      item.height,
      map.width,
      map.height,
      issue,
      item.id,
    );
    const asset = project.manifest.assets[item.asset];
    if (
      asset === undefined ||
      (asset.kind !== "gui" && asset.kind !== "sprite")
    )
      issue("asset", `地图装饰素材无效：${item.asset}`, item.id);
  }
  const scenesInMap = new Set<string>();
  const profileProject: EditorProject = {
    ...project,
    manifest: {
      ...project.manifest,
      variables: Object.fromEntries(
        Object.entries(project.manifest.variables).filter(
          ([, definition]) => definition.scope === "profile",
        ),
      ),
    },
  };
  for (const item of map.hotspots) {
    if (!ID_PATTERN.test(item.id) || !ids.add(item.id))
      issue("object_id", `章节热点 ID 非法或重复：${item.id}`, item.id);
    if (!scenes.has(item.scene_id))
      issue("scene", `章节热点引用未知 Scene：${item.scene_id}`, item.id);
    if (!scenesInMap.add(item.scene_id))
      issue(
        "scene_duplicate",
        `Scene 在地图中有多个热点：${item.scene_id}`,
        item.id,
      );
    if (
      !Number.isInteger(item.z) ||
      item.z < -2147483648 ||
      item.z > 2147483647
    )
      issue("z", `地图对象 ${item.id} 层级必须是 32 位整数`, item.id);
    if (
      item.title.trim() === "" ||
      /[\x00-\x1f]/.test(item.title) ||
      Array.from(item.title).length > 64
    )
      issue("title", `章节热点标题无效：${item.title}`, item.id);
    if (item.asset != null) {
      const asset = project.manifest.assets[item.asset];
      if (
        asset === undefined ||
        (asset.kind !== "gui" && asset.kind !== "sprite")
      )
        issue("asset", `章节热点素材无效：${item.asset}`, item.id);
    }
    validateMapRect(
      item.x,
      item.y,
      item.width,
      item.height,
      map.width,
      map.height,
      issue,
      item.id,
    );
    if (item.reveal?.mode === "condition")
      validateCondition(
        profileProject,
        item.reveal.condition,
        (code, message) =>
          issue(code, `章节热点 ${item.id}：${message}`, item.id),
      );
    for (const [variable, value] of Object.entries(item.variable_overrides)) {
      const definition = project.manifest.variables[variable];
      if (definition === undefined)
        issue(
          "override_variable",
          `章节热点 ${item.id} 覆盖了未知变量 ${variable}`,
          item.id,
        );
      else if (!valueMatchesType(value, definition.type))
        issue(
          "override_type",
          `章节热点 ${item.id} 的变量 ${variable} 类型不匹配`,
          item.id,
        );
    }
  }
}

function validateMapRect(
  x: number,
  y: number,
  width: number,
  height: number,
  roomWidth: number,
  roomHeight: number,
  issue: (code: string, message: string, id?: string | null) => void,
  id: string,
): void {
  if (
    ![x, y, width, height].every(Number.isInteger) ||
    !Number.isFinite(roomWidth) ||
    !Number.isFinite(roomHeight) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x % 20 !== 0 ||
    y % 20 !== 0 ||
    width % 20 !== 0 ||
    height % 20 !== 0 ||
    x > roomWidth ||
    y > roomHeight ||
    width > roomWidth - x ||
    height > roomHeight - y
  )
    issue(
      "rect",
      `地图对象 ${id} 的位置和尺寸必须落在 20px 网格及房间边界内`,
      id,
    );
}

function validateStoryFlow(
  project: EditorProject,
  scenes: Map<string, EditorProject["scenes"][number]["definition"]>,
  output: EditorDiagnostic[],
): void {
  const file = project.story_flow;
  if (file === null) {
    if (project.manifest.story_flow != null)
      output.push(
        flowError(
          "missing_story_flow",
          "manifest 声明了 story_flow，但编辑器文档不存在",
          null,
        ),
      );
    return;
  }
  if (project.manifest.story_flow !== file.path)
    output.push(
      flowError(
        "story_flow_path",
        "story_flow 文件路径与 manifest 不一致",
        null,
      ),
    );
  if (file.definition.schema_version !== 1)
    output.push(
      flowError(
        "story_flow_schema",
        "story flow schema_version 必须为 1",
        null,
      ),
    );
  const edges = new Set<string>();
  const ids = new Set<string>();
  const profileProject: EditorProject = {
    ...project,
    manifest: {
      ...project.manifest,
      variables: Object.fromEntries(
        Object.entries(project.manifest.variables).filter(
          ([, definition]) => definition.scope === "profile",
        ),
      ),
    },
  };
  for (const [id, node] of Object.entries(file.definition.nodes)) {
    if (!scenes.has(id))
      output.push(
        flowError("flow_unknown_scene", `流程节点引用未知场景：${id}`, id),
      );
    if (
      !ID_PATTERN.test(id) ||
      !node.title.trim() ||
      /[\x00-\x1f]/.test(node.title)
    )
      output.push(flowError("flow_invalid_node", `流程节点 ${id} 无效`, id));
    if (
      !Number.isInteger(node.x) ||
      !Number.isInteger(node.y) ||
      node.x % 20 !== 0 ||
      node.y % 20 !== 0
    )
      output.push(
        flowError(
          "flow_invalid_position",
          `流程节点 ${id} 必须吸附到 20px 网格`,
          id,
        ),
      );
    if (node.reveal?.mode === "condition") {
      validateCondition(
        profileProject,
        node.reveal.condition,
        (code, message) =>
          output.push(
            flowError(`flow_${code}`, `流程节点 ${id}：${message}`, id),
          ),
      );
    }
  }
  for (const edge of file.definition.edges) {
    if (!ID_PATTERN.test(edge.id) || !ids.add(edge.id))
      output.push(
        flowError(
          "flow_invalid_edge",
          `流程边 ID 非法或重复：${edge.id}`,
          edge.id,
        ),
      );
    if (
      edge.from === edge.to ||
      !file.definition.nodes[edge.from] ||
      !file.definition.nodes[edge.to] ||
      !edges.add(`${edge.from}\u0000${edge.to}`)
    )
      output.push(
        flowError(
          "flow_invalid_connection",
          `流程连接无效：${edge.from} → ${edge.to}`,
          edge.id,
        ),
      );
  }
}

function validateNode(
  project: EditorProject,
  sceneId: string,
  nodeId: string,
  node: SceneNode,
  output: EditorDiagnostic[],
): void {
  const issue = (code: string, message: string) =>
    output.push(error(code, message, sceneId, nodeId));
  const checkDuration = (duration: number) => {
    if (!Number.isInteger(duration) || duration < 0 || duration > 60_000) {
      issue("invalid_duration", "时长必须在 0–60000 ms 之间");
    }
  };
  const checkTimestamp = (timestamp: number, label: string) => {
    if (!Number.isInteger(timestamp) || timestamp < 0) {
      issue("invalid_timestamp", `${label} 必须是非负整数毫秒数`);
    }
  };
  const checkVolume = (volume: number) => {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      issue("invalid_volume", "音量必须在 0–1 之间");
    }
  };
  const checkAsset = (
    id: string | null,
    kind: AssetKind,
    required: boolean,
  ) => {
    if (id === null || id === "") {
      if (required) issue("missing_asset", `必须选择 ${kind} 素材`);
      return;
    }
    const asset = project.manifest.assets[id];
    if (asset === undefined) {
      issue("unknown_asset", `素材未登记：${id}`);
    } else if (asset.kind !== kind) {
      issue("wrong_asset_kind", `素材 ${id} 的类型应为 ${kind}`);
    }
  };

  switch (node.type) {
    case "background":
      checkAsset(node.background, "background", false);
      checkDuration(node.duration_ms);
      break;
    case "sprite":
      if (!ID_PATTERN.test(node.sprite_id))
        issue("invalid_sprite_id", "立绘实例 ID 非法");
      checkAsset(node.asset, "sprite", node.action === "show");
      checkDuration(node.duration_ms);
      if (
        (node.x !== null && !Number.isFinite(node.x)) ||
        (node.y !== null && !Number.isFinite(node.y))
      ) {
        issue("invalid_sprite_position", "立绘坐标必须是有限数");
      }
      if (
        node.scale !== null &&
        (!Number.isFinite(node.scale) || node.scale <= 0)
      ) {
        issue("invalid_scale", "缩放必须是正数");
      }
      if (
        node.opacity !== null &&
        (!Number.isFinite(node.opacity) || node.opacity < 0 || node.opacity > 1)
      ) {
        issue("invalid_opacity", "透明度必须在 0–1 之间");
      }
      break;
    case "clear":
      checkDuration(node.duration_ms);
      break;
    case "say":
      if (node.text.trim() === "") issue("empty_dialogue", "对话文本不能为空");
      if (node.page_id != null && !ID_PATTERN.test(node.page_id)) {
        issue("invalid_dialogue_page", "对话页 ID 非法");
      }
      if (node.mode === "append" && !node.page_id) {
        issue("missing_dialogue_page", "接续对话必须指定对话页 ID");
      }
      if (
        node.speaker !== null &&
        project.manifest.characters[node.speaker] === undefined
      ) {
        validateDisplayName(node.speaker).forEach((message) =>
          issue("invalid_temporary_speaker", message),
        );
      }
      validateTextTemplate(project, node.text, issue);
      if (
        node.speed_cps !== null &&
        (!Number.isFinite(node.speed_cps) || node.speed_cps <= 0)
      ) {
        issue("invalid_speed", "文字速度必须是正数");
      }
      break;
    case "long_text": {
      if (node.document !== undefined && node.document !== null) {
        if (!ID_PATTERN.test(node.document))
          issue("invalid_long_text_document", "文稿 ID 非法");
      }
      if (
        node.mode !== undefined &&
        node.mode !== "start" &&
        node.mode !== "continue"
      ) {
        issue("invalid_long_text_mode", "长文本模式无效");
      }
      if (node.mode === "continue" && !node.document) {
        issue("missing_long_text_document", "接续长文本必须指定文稿 ID");
      }
      if (
        node.mode === "continue" &&
        (node.paper != null ||
          node.pagination !== undefined ||
          node.font_size !== undefined ||
          node.text_color !== undefined ||
          node.layout !== undefined)
      ) {
        issue(
          "long_text_inherited_style",
          "接续长文本不能重复定义纸张、分页、字号、颜色或布局",
        );
      }
      if (
        node.on_exit !== undefined &&
        node.on_exit !== "close" &&
        node.on_exit !== "hide" &&
        node.on_exit !== "keep_visible"
      ) {
        issue("invalid_long_text_exit", "长文本离开行为无效");
      }
      checkAsset(node.paper ?? null, "gui", false);
      if (
        node.pagination !== undefined &&
        node.pagination !== "continuous" &&
        node.pagination !== "auto" &&
        node.pagination !== "manual"
      ) {
        issue("invalid_long_text_pagination", "长文本分页方式无效");
      }
      if (
        node.font_size !== undefined &&
        (!Number.isFinite(node.font_size) ||
          node.font_size < 16 ||
          node.font_size > 72)
      ) {
        issue("invalid_long_text_font_size", "长文本字号必须在 16 到 72 之间");
      }
      if (
        node.text_color !== undefined &&
        !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(node.text_color)
      ) {
        issue(
          "invalid_long_text_color",
          "长文本颜色必须是 #RRGGBB 或 #RRGGBBAA",
        );
      }
      if (node.layout !== undefined) {
        const layout = node.layout;
        const values = Object.values(layout);
        if (
          values.some((value) => !Number.isFinite(value)) ||
          layout.x < 0 ||
          layout.y < 0 ||
          layout.width < 160 ||
          layout.height < 240 ||
          layout.x + layout.width > 1920 ||
          layout.y + layout.height > 1080 ||
          layout.padding_x < 0 ||
          layout.padding_y < 0 ||
          layout.width <= layout.padding_x * 2 + 80 ||
          layout.height <= layout.padding_y * 2 + 80 ||
          layout.page_height <= layout.padding_y * 2 + 80 ||
          layout.page_gap < 0
        ) {
          issue("invalid_long_text_layout", "长文本位置、边距或页尺寸无效");
        }
      }
      if (node.steps.length === 0 || node.steps.length > 1024) {
        issue("invalid_long_text_steps", "长文本必须包含 1 到 1024 个步骤");
      }
      const ids = new Set<string>();
      for (const [index, step] of node.steps.entries()) {
        if (!ID_PATTERN.test(step.id)) {
          issue("invalid_long_text_step", `第 ${index + 1} 段的 ID 非法`);
        }
        if (ids.has(step.id)) {
          issue("duplicate_long_text_step", `步骤 ID 重复：${step.id}`);
        }
        if (step.text.trim() === "") {
          issue("empty_long_text_step", `第 ${index + 1} 段不能为空`);
        }
        if (
          (node.mode ?? "start") === "start" &&
          index === 0 &&
          step.page_break_before
        ) {
          issue("leading_long_text_break", "第一段不应在前方强制分页");
        }
        if (node.pagination === "continuous" && step.page_break_before) {
          issue("continuous_long_text_break", "连续长卷不能使用强制分页");
        }
        validateTextTemplate(project, step.text, issue);
        ids.add(step.id);
      }
      if (
        node.speed_cps !== null &&
        (!Number.isFinite(node.speed_cps) || node.speed_cps <= 0)
      ) {
        issue("invalid_long_text_speed", "文字速度必须是正数");
      }
      break;
    }
    case "long_text_control":
      if (!ID_PATTERN.test(node.document))
        issue("invalid_long_text_document", "文稿 ID 非法");
      if (
        node.action !== "show" &&
        node.action !== "hide" &&
        node.action !== "close"
      )
        issue("invalid_long_text_action", "文稿控制操作无效");
      break;
    case "choice": {
      if (node.choices.length === 0) issue("empty_choice", "至少需要一个选项");
      const ids = new Set<string>();
      for (const choice of node.choices) {
        if (!ID_PATTERN.test(choice.id))
          issue("invalid_choice_id", `非法选项 ID：${choice.id}`);
        if (ids.has(choice.id))
          issue("duplicate_choice_id", `选项 ID 重复：${choice.id}`);
        if (choice.label.trim() === "")
          issue("empty_choice_label", "选项文本不能为空");
        validateTextTemplate(project, choice.label, issue);
        if (choice.visible_if !== undefined)
          validateCondition(project, choice.visible_if, issue);
        if (choice.enabled_if !== undefined)
          validateCondition(project, choice.enabled_if, issue);
        ids.add(choice.id);
      }
      break;
    }
    case "set":
      if (!ID_PATTERN.test(node.variable))
        issue("invalid_variable", "变量名非法");
      if (project.manifest.variables[node.variable] === undefined) {
        issue("unknown_variable", `变量未声明：${node.variable}`);
      } else validateMutation(project, node, issue);
      break;
    case "condition":
      validateCondition(project, node.condition, issue);
      break;
    case "playback":
      break;
    case "wait":
      checkDuration(node.duration_ms);
      break;
    case "bgm":
      checkAsset(node.asset, "bgm", node.action === "start");
      checkVolume(node.volume);
      checkDuration(node.duration_ms);
      checkTimestamp(node.start_ms ?? 0, "BGM 起始点");
      if ((node.loop_start_ms == null) !== (node.loop_end_ms == null)) {
        issue("invalid_bgm_loop", "BGM 循环起止点必须同时提供");
      } else if (node.loop_start_ms != null && node.loop_end_ms != null) {
        checkTimestamp(node.loop_start_ms, "BGM 循环起点");
        checkTimestamp(node.loop_end_ms, "BGM 循环终点");
        if (
          node.loop_start_ms >= node.loop_end_ms ||
          (node.start_ms ?? 0) > node.loop_end_ms
        ) {
          issue("invalid_bgm_loop", "BGM 循环点顺序无效");
        }
      }
      break;
    case "sfx":
      checkAsset(node.asset, "sfx", true);
      checkVolume(node.volume);
      break;
    case "camera":
      checkDuration(node.duration_ms);
      if (
        ![node.x, node.y, node.zoom].every(Number.isFinite) ||
        node.zoom <= 0
      ) {
        issue("invalid_camera", "镜头坐标必须有限，缩放必须为正数");
      }
      break;
    case "screen_effect":
      checkDuration(node.duration_ms);
      break;
    case "dialogue_ui":
      if (node.duration_ms !== null) checkDuration(node.duration_ms);
      if (
        node.motion !== null &&
        !project.ui_motions.some((file) => file.definition.id === node.motion)
      )
        issue("unknown_ui_motion", `未知 UI 动效：${node.motion}`);
      break;
    case "ui_motion_set":
      if (
        node.motion !== null &&
        !project.ui_motions.some((file) => file.definition.id === node.motion)
      )
        issue("unknown_ui_motion", `未知 UI 动效：${node.motion}`);
      break;
    case "ui_motion_play":
      if (
        !project.ui_motions.some((file) => file.definition.id === node.motion)
      )
        issue("unknown_ui_motion", `未知 UI 动效：${node.motion}`);
      if (node.duration_ms !== null) checkDuration(node.duration_ms);
      break;
    case "timeline": {
      if (
        !Number.isInteger(node.duration_ms) ||
        node.duration_ms < 1 ||
        node.duration_ms > 1_800_000
      ) {
        issue(
          "invalid_timeline_duration",
          "时间线时长必须在 1ms 到 30 分钟之间",
        );
      }
      if (!node.await && node.skippable) {
        issue("invalid_timeline_skip", "非阻塞时间线不能设为可跳过");
      }
      if (node.tracks.length > 64)
        issue("too_many_timeline_tracks", "时间线轨道超过 64 条");
      if (node.events.length > 2048)
        issue("too_many_timeline_events", "时间线事件超过 2048 个");
      let keyframes = 0;
      let videos = 0;
      const trackIds = new Set<string>();
      for (const track of node.tracks) {
        const trackId =
          track.type === "sprite" ? `sprite:${track.sprite_id}` : track.type;
        if (trackIds.has(trackId))
          issue("duplicate_timeline_track", `重复时间线轨道：${trackId}`);
        trackIds.add(trackId);
        if (track.type === "video") {
          videos += 1;
          checkAsset(track.asset, "video", true);
          if (!node.await)
            issue("video_requires_await", "视频时间线必须等待完成");
          checkTimestamp(track.clip_start_ms, "视频裁剪起点");
          if (track.clip_end_ms != null) {
            checkTimestamp(track.clip_end_ms, "视频裁剪终点");
            if (track.clip_end_ms <= track.clip_start_ms) {
              issue("invalid_video_clip", "视频裁剪终点必须晚于起点");
            }
          }
        } else if (track.type === "sprite")
          checkAsset(track.asset, "sprite", false);
        const allowed = timelineChannels(track);
        for (const [channel, frames] of Object.entries(track.channels)) {
          if (!allowed.includes(channel))
            issue(
              "invalid_timeline_channel",
              `${track.type} 不支持 ${channel} 通道`,
            );
          if (frames.length === 0) {
            issue("empty_timeline_channel", `${channel} 通道不能为空`);
          }
          keyframes += frames.length;
          let prior = -1;
          for (const [frameIndex, frame] of frames.entries()) {
            const inherited = frame.value === "inherit";
            if (
              (!inherited && !Number.isFinite(frame.value)) ||
              !Number.isInteger(frame.at_ms) ||
              frame.at_ms < 0 ||
              frame.at_ms <= prior ||
              frame.at_ms > node.duration_ms
            ) {
              issue(
                "invalid_timeline_keyframe",
                `${channel} 关键帧时间或数值无效`,
              );
            }
            if (
              inherited &&
              (track.type === "video" ||
                frameIndex !== 0 ||
                frame.at_ms !== 0 ||
                frames.length < 2)
            ) {
              issue(
                "invalid_timeline_inherit",
                `${channel} 的继承值只能作为非视频轨的 0ms 起始帧`,
              );
            }
            if (
              !inherited &&
              ["opacity", "volume"].includes(channel) &&
              ((frame.value as number) < 0 || (frame.value as number) > 1)
            ) {
              issue(
                "invalid_timeline_range",
                `${channel} 关键帧必须在 0 到 1 之间`,
              );
            }
            if (
              !inherited &&
              [
                "scale",
                "scale_x",
                "scale_y",
                "zoom",
                "width",
                "height",
              ].includes(channel) &&
              (frame.value as number) <= 0
            ) {
              issue("invalid_timeline_range", `${channel} 关键帧必须大于 0`);
            }
            if (typeof frame.easing === "object") {
              const [x1, y1, x2, y2] = frame.easing.cubic_bezier;
              if (
                ![x1, y1, x2, y2].every(Number.isFinite) ||
                x1 < 0 ||
                x1 > 1 ||
                x2 < 0 ||
                x2 > 1
              ) {
                issue(
                  "invalid_cubic_bezier",
                  "贝塞尔曲线的 x 控制点必须在 0 到 1 之间",
                );
              }
            }
            prior = frame.at_ms;
          }
        }
      }
      if (videos > 1)
        issue("too_many_video_tracks", "单条时间线最多一个视频轨");
      if (keyframes > 10_000)
        issue("too_many_keyframes", "时间线关键帧超过 10000 个");
      const ids = new Set<string>();
      let priorEvent = -1;
      for (const event of node.events) {
        if (!ID_PATTERN.test(event.id) || ids.has(event.id))
          issue("invalid_timeline_event", `事件 ID 无效或重复：${event.id}`);
        if (
          !Number.isInteger(event.at_ms) ||
          event.at_ms < 0 ||
          event.at_ms < priorEvent ||
          event.at_ms > node.duration_ms
        )
          issue("invalid_timeline_event_time", `事件 ${event.id} 未排序或越界`);
        if (event.type === "sfx") {
          checkAsset(event.asset, "sfx", true);
          checkVolume(event.volume);
        } else {
          checkDuration(event.duration_ms);
          if (event.at_ms + event.duration_ms > node.duration_ms) {
            issue(
              "invalid_timeline_event_time",
              `事件 ${event.id} 超出时间线时长`,
            );
          }
        }
        ids.add(event.id);
        priorEvent = event.at_ms;
      }
      break;
    }
    case "jump":
    case "end":
      break;
  }
}

function timelineChannels(track: TimelineTrack): string[] {
  switch (track.type) {
    case "sprite":
      return [
        "x",
        "y",
        "scale",
        "scale_x",
        "scale_y",
        "rotation_deg",
        "opacity",
        "z",
      ];
    case "camera":
      return ["x", "y", "zoom", "rotation_deg"];
    case "video":
      return ["x", "y", "width", "height", "opacity", "z", "volume"];
    case "bgm":
      return ["volume"];
  }
}

function validateUiMotionPreset(
  preset: UiMotionPreset,
  output: EditorDiagnostic[],
): void {
  const targets = new Set<string>();
  for (const track of preset.tracks) {
    if (targets.has(track.target)) {
      output.push(
        error(
          "duplicate_ui_motion_target",
          `UI 动效 ${preset.id} 的目标 ${track.target} 重复`,
        ),
      );
    }
    targets.add(track.target);
    if (Object.keys(track.channels).length === 0) {
      output.push(
        error(
          "empty_ui_motion_track",
          `UI 动效 ${preset.id} 的 ${track.target} 轨道没有通道`,
        ),
      );
    }
    for (const [channel, frames] of Object.entries(track.channels)) {
      if (
        ![
          "offset_x",
          "offset_y",
          "scale_x",
          "scale_y",
          "rotation_deg",
          "opacity",
        ].includes(channel)
      ) {
        output.push(
          error(
            "invalid_ui_motion_channel",
            `UI 动效 ${preset.id} 不支持通道 ${channel}`,
          ),
        );
      }
      let prior = -1;
      for (const frame of frames) {
        if (
          typeof frame.value !== "number" ||
          !Number.isFinite(frame.value) ||
          !Number.isInteger(frame.at_ms) ||
          frame.at_ms < 0 ||
          frame.at_ms <= prior ||
          frame.at_ms > preset.duration_ms
        ) {
          output.push(
            error(
              "invalid_ui_motion_keyframe",
              `UI 动效 ${preset.id}/${channel} 的关键帧无效`,
            ),
          );
        }
        if (
          channel === "opacity" &&
          typeof frame.value === "number" &&
          (frame.value < 0 || frame.value > 1)
        ) {
          output.push(
            error(
              "invalid_ui_motion_range",
              `UI 动效 ${preset.id} 的透明度必须在 0–1`,
            ),
          );
        }
        if (
          ["scale_x", "scale_y"].includes(channel) &&
          typeof frame.value === "number" &&
          frame.value <= 0
        ) {
          output.push(
            error(
              "invalid_ui_motion_range",
              `UI 动效 ${preset.id} 的缩放必须大于 0`,
            ),
          );
        }
        prior = frame.at_ms;
      }
    }
  }
}

function validateMutation(
  project: EditorProject,
  node: Extract<SceneNode, { type: "set" }>,
  issue: (code: string, message: string) => void,
): void {
  const target = project.manifest.variables[node.variable];
  if (target === undefined) return;
  const op = node.op ?? "assign";
  if (op === "toggle") {
    if (target.type !== "boolean") {
      issue("invalid_toggle", "toggle 只能用于 boolean 变量");
    }
    if (node.value !== undefined) {
      issue("invalid_toggle_value", "toggle 不接受 value");
    }
    return;
  }
  if (node.value === undefined) {
    issue("missing_mutation_value", `${op} 必须提供 value`);
    return;
  }
  const sourceType = mutationValueType(project, node.value, issue);
  if (sourceType === null) return;
  const compatible = (() => {
    switch (op) {
      case "assign":
        return (
          target.type === sourceType ||
          (target.type === "number" && sourceType === "integer")
        );
      case "add":
      case "sub":
      case "mul":
        return (
          isNumericType(target.type) &&
          isNumericType(sourceType) &&
          (target.type !== "integer" || sourceType === "integer")
        );
      case "mod":
        return target.type === "integer" && sourceType === "integer";
      case "append":
        return target.type === "string" && sourceType === "string";
    }
  })();
  if (!compatible) {
    issue("variable_operation_type", `${op} 的目标变量与操作数类型不兼容`);
  }
  if (op === "mod" && typeof node.value === "number" && node.value === 0) {
    issue("modulo_by_zero", "mod 的除数不能为零");
  }
}

function mutationValueType(
  project: EditorProject,
  value: NonNullable<Extract<SceneNode, { type: "set" }>["value"]>,
  issue: (code: string, message: string) => void,
): VariableType | null {
  if (typeof value === "object" && value !== null) {
    const definition = project.manifest.variables[value.variable];
    if (definition === undefined) {
      issue("unknown_variable", `操作数引用了未声明变量：${value.variable}`);
      return null;
    }
    return definition.type;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    issue("non_finite_literal", "运算数值必须是有限数");
  }
  if (
    typeof value === "string" &&
    new TextEncoder().encode(value).length > 16 * 1024
  ) {
    issue("string_too_long", "字符串不能超过 16 KiB UTF-8");
  }
  return scalarType(value);
}

function validateTextTemplate(
  project: EditorProject,
  source: string,
  issue: (code: string, message: string) => void,
): void {
  const types = Object.fromEntries(
    Object.entries(project.manifest.variables).map(([id, definition]) => [
      id,
      definition.type,
    ]),
  );
  for (const message of validateTemplate(source, types)) {
    issue("invalid_interpolation", message);
  }
}

function validateDisplayName(value: string): string[] {
  const issues: string[] = [];
  if (value.trim() === "") issues.push("显示名不能为空");
  if (Array.from(value).length > 64) issues.push("显示名不能超过 64 个字符");
  if (/\p{Cc}/u.test(value)) issues.push("显示名不能包含控制字符");
  return issues;
}

function validateCondition(
  project: EditorProject,
  condition: ConditionExpression,
  issue: (code: string, message: string) => void,
): void {
  let nodes = 0;
  const visit = (candidate: ConditionExpression, depth: number): void => {
    nodes += 1;
    if (depth > 32) {
      issue("condition_too_deep", "条件表达式嵌套不能超过 32 层");
      return;
    }
    if (nodes > 256) {
      issue("condition_too_large", "条件表达式不能超过 256 个节点");
      return;
    }
    switch (candidate.op) {
      case "eq":
      case "ne": {
        const left = operandType(project, candidate.left, issue);
        const right = operandType(project, candidate.right, issue);
        if (
          left !== null &&
          right !== null &&
          left !== right &&
          !(isNumericType(left) && isNumericType(right))
        ) {
          issue("condition_type_mismatch", "Eq/Ne 两侧类型不兼容");
        }
        break;
      }
      case "lt":
      case "le":
      case "gt":
      case "ge": {
        const left = operandType(project, candidate.left, issue);
        const right = operandType(project, candidate.right, issue);
        if (
          (left !== null && !isNumericType(left)) ||
          (right !== null && !isNumericType(right))
        ) {
          issue("condition_ordering_type", "Lt/Le/Gt/Ge 只允许比较整数或数值");
        }
        break;
      }
      case "and":
      case "or":
        if (candidate.conditions.length === 0) {
          issue("empty_condition_group", "And/Or 至少需要一个子条件");
        }
        candidate.conditions.forEach((child) => visit(child, depth + 1));
        break;
      case "not":
        visit(candidate.condition, depth + 1);
        break;
    }
  };
  visit(condition, 1);
}

function operandType(
  project: EditorProject,
  operand: ValueOperand,
  issue: (code: string, message: string) => void,
): VariableType | null {
  if ("variable" in operand) {
    const definition = project.manifest.variables[operand.variable];
    if (definition === undefined) {
      issue("unknown_variable", `条件引用了未声明变量：${operand.variable}`);
      return null;
    }
    return definition.type;
  }
  if (typeof operand.value === "number" && !Number.isFinite(operand.value)) {
    issue("non_finite_literal", "条件数值必须是有限数");
  }
  return scalarType(operand.value);
}

function valueMatchesType(value: ScalarValue, type: VariableType): boolean {
  switch (type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        isIntegerScalar(value) &&
        (typeof value === "bigint" || Number.isSafeInteger(value))
      );
    case "number":
      return (
        typeof value === "bigint" ||
        (typeof value === "number" && Number.isFinite(value))
      );
    case "string":
      return (
        typeof value === "string" &&
        new TextEncoder().encode(value).length <= 16 * 1024
      );
  }
}

function isNumericType(type: VariableType): boolean {
  return type === "integer" || type === "number";
}

function reachabilityWarnings(
  project: EditorProject,
  sceneById: Map<string, EditorProject["scenes"][number]["definition"]>,
): EditorDiagnostic[] {
  const entry = sceneById.get(project.manifest.entry_scene);
  if (entry === undefined || entry.nodes[entry.entry] === undefined) return [];
  const reached = new Set<string>();
  const queue: [string, string][] = [[entry.id, entry.entry]];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const [sceneId, nodeId] = next;
    const key = `${sceneId}\u0000${nodeId}`;
    if (reached.has(key)) continue;
    reached.add(key);
    const scene = sceneById.get(sceneId);
    const node = scene?.nodes[nodeId];
    if (node === undefined) continue;
    for (const port of outputPorts(node)) {
      queue.push([port.targetScene ?? sceneId, port.target]);
    }
  }
  const warnings: EditorDiagnostic[] = [];
  for (const file of project.scenes) {
    for (const nodeId of Object.keys(file.definition.nodes)) {
      if (!reached.has(`${file.definition.id}\u0000${nodeId}`)) {
        warnings.push({
          severity: "warning",
          code: "unreachable_node",
          message: "节点无法从项目入口到达",
          scene_id: file.definition.id,
          node_id: nodeId,
        });
      }
    }
  }
  return warnings;
}

function error(
  code: string,
  message: string,
  sceneId: string | null = null,
  nodeId: string | null = null,
): EditorDiagnostic {
  return {
    severity: "error",
    code,
    message,
    scene_id: sceneId,
    node_id: nodeId,
  };
}

function flowError(
  code: string,
  message: string,
  flowElementId: string | null,
): EditorDiagnostic {
  return {
    severity: "error",
    code,
    message,
    scene_id: null,
    node_id: null,
    workspace: "flow",
    flow_element_id: flowElementId,
  };
}

function mapError(
  code: string,
  message: string,
  elementId: string | null,
): EditorDiagnostic {
  return {
    severity: "error",
    code,
    message,
    scene_id: null,
    node_id: null,
    workspace: "map",
    flow_element_id: elementId,
  };
}

function deduplicate(diagnostics: EditorDiagnostic[]): EditorDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = [
      diagnostic.severity,
      diagnostic.code,
      diagnostic.scene_id,
      diagnostic.node_id,
      diagnostic.workspace,
      diagnostic.flow_element_id,
      diagnostic.message,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
