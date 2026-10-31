import { sceneRole } from "../windowInteraction";
import type { EditorDiagnostic, EditorProject } from "../types";
import { ID_PATTERN, mapError, valueMatchesType } from "./shared";
import { validateCondition } from "./expressions";

export function validateChapterMap(
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
    else if (sceneRole(scenes.get(item.scene_id)) !== "main")
      issue(
        "scene_secondary",
        `章节热点 ${item.id} 不能进入副窗口专用 Scene：${item.scene_id}`,
        item.id,
      );
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
        false,
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
