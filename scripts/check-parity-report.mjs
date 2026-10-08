/* global console */

// Verification of the JSON report the parity harness page produces.
//
// Every check here is a hard gate: an empty fixture (no video target, no
// shader target, no checks executed) fails instead of being skipped silently.

import { relative } from "node:path";

function targetsOf(report) {
  return Array.isArray(report.targets) ? report.targets : [];
}

function printProblems(title, problems) {
  if (problems.length === 0) return;
  console.error(`${title}：${problems.length} 处：`);
  for (const problem of problems) console.error(`  - ${problem}`);
}

// The report must contain exactly the targets the list asked for: a checker
// pointed at an OS-temp list must fail instead of silently accepting a fixture
// set built from a different file.
function checkTargetList(report, targets, root) {
  const reportTargetIds = targetsOf(report).map((target) => target.id);
  const reportIds = new Set(reportTargetIds);
  const problems = [];
  for (const id of targets.ids) {
    if (!reportIds.has(id)) problems.push(`报告缺少目标 ${id}`);
  }
  for (const id of reportIds) {
    if (!targets.ids.has(id)) problems.push(`报告出现清单外的目标 ${id}`);
  }
  if (reportIds.size !== reportTargetIds.length) {
    problems.push(
      `报告目标 id 重复（${reportTargetIds.length} 个目标 / ${reportIds.size} 个 id）`,
    );
  }
  const matched = [...targets.ids].filter((id) => reportIds.has(id)).length;
  console.log(
    `目标清单：${relative(root, targets.path)}，报告 ${matched}/${targets.ids.size} 个目标匹配`,
  );
  if (problems.length > 0) {
    console.error(`目标清单与报告不一致：${problems.length} 处：`);
    for (const problem of problems) console.error(`  - ${problem}`);
  }
  return problems;
}

// The shared ChoiceLayer also gets a real-browser computed-layout probe,
// separate from screenshot parity: an image that looks plausible can still be
// intrinsically sized or stacked above the label.  Every host/mode pair must
// report exact button-box artwork geometry and content above the artwork.
function checkChoiceLayout(report) {
  const cases = Array.isArray(report.choiceLayout?.cases)
    ? report.choiceLayout.cases
    : [];
  const problems = [];
  const expected = new Set([
    "game/separate",
    "game/overlay",
    "editor/separate",
    "editor/overlay",
  ]);
  const actual = new Set();
  for (const probe of cases) {
    const key = `${probe.host}/${probe.mode}`;
    if (actual.has(key)) {
      problems.push(`${key}: 探针结果重复`);
    }
    actual.add(key);
    if (probe.imageBoxesMatchButton !== true) {
      problems.push(`${key}: artwork 未与按钮解析盒一致`);
    }
    if (probe.fallbackHeightMatches !== true) {
      problems.push(`${key}: 80px fallback 高度未按解析按钮盒呈现`);
    }
    if (probe.contentOverlaysArtwork !== true) {
      problems.push(`${key}: icon/KaTeX content 未叠加在 artwork 上`);
    }
  }
  for (const key of expected) {
    if (!actual.has(key)) {
      problems.push(`${key}: 缺少真实浏览器 ChoiceLayer 探针结果`);
    }
  }
  console.log(
    `Choice 布局：${cases.length}/${expected.size} 个 host/mode 探针通过`,
  );
  printProblems("Choice 布局探针失败", problems);
  return problems;
}

// A deterministically scrubbed video must land on the time the playhead
// targets, within the shared 50 ms drift threshold.  Playback-mode seeks are
// checked by the video fixture below; timelines without a video track record
// `media: null` and assert nothing here.
function checkScrubDrift(report) {
  const problems = [];
  for (const target of targetsOf(report)) {
    for (const frame of target.editor?.frames ?? []) {
      const media = frame.media;
      if (media === null || media === undefined) continue;
      if (frame.mode !== "scrub") continue;
      const drift = Math.abs(media.currentTime - media.targetTime);
      if (!(drift <= 0.05)) {
        problems.push(
          `${target.id} @${frame.elapsed_ms}ms: currentTime=${media.currentTime} target=${media.targetTime} drift=${drift.toFixed(3)}s`,
        );
      }
    }
  }
  printProblems("视频定位超过 50ms", problems);
  return problems;
}

// Real-video fixture: the browser entry drives a video-bearing target on both
// shared hosts and records nonzero media observations plus in-page assertions.
function checkVideo(report) {
  const videoTargets = targetsOf(report).filter(
    (target) => target.video?.fixture === true,
  );
  const problems = [];
  let checkCount = 0;
  let failedCount = 0;
  let observationCount = 0;
  if (videoTargets.length === 0) {
    problems.push(
      "没有任何目标包含视频轨：浏览器视频断言为空（夹具缺失，不得静默跳过）",
    );
  }
  for (const target of videoTargets) {
    const video = target.video;
    const checks = Array.isArray(video.checks) ? video.checks : [];
    const observations = Array.isArray(video.observations)
      ? video.observations
      : [];
    checkCount += checks.length;
    observationCount += observations.length;
    if (checks.length === 0) {
      problems.push(`${target.id}: 没有执行任何视频断言`);
      continue;
    }
    const failed = checks.filter((check) => check.ok !== true);
    failedCount += failed.length;
    for (const check of failed) {
      problems.push(`${target.id}/${check.name}: ${check.detail}`);
    }
    if (observations.length < 6) {
      problems.push(
        `${target.id}: 真实视频观测不足（${observations.length} < 6）`,
      );
    }
    for (const host of ["game", "editor"]) {
      const hostObservations = observations.filter(
        (observation) =>
          observation.host === host && observation.media !== null,
      );
      if (hostObservations.length === 0) {
        problems.push(`${target.id}: ${host} 端没有真实媒体观测`);
      }
    }
    const scrubObservations = observations.filter(
      (observation) =>
        observation.mode === "scrub" && observation.media !== null,
    );
    if (scrubObservations.length < 3) {
      problems.push(
        `${target.id}: scrub 媒体观测不足（${scrubObservations.length} < 3）`,
      );
    }
    const playbackObservations = observations.filter(
      (observation) =>
        observation.mode === "playback" && observation.media !== null,
    );
    if (playbackObservations.length < 2) {
      problems.push(
        `${target.id}: 连续播放媒体观测不足（${playbackObservations.length} < 2）`,
      );
    }
  }
  console.log(
    `视频：${videoTargets.length} 个目标 / ${observationCount} 个真实观测 / ${checkCount} 项检查（失败 ${failedCount}）`,
  );
  printProblems("真实视频夹具断言失败", problems);
  return problems;
}

// Four-slot ambience fixture: the harness reads the same read-only
// AudioDiagnostics seam from the game controller and the editor
// TimelineSession.  A report without observations or checks fails.
function checkAmbience(report) {
  const problems = [];
  for (const target of targetsOf(report)) {
    const ambience = target.ambience;
    if (ambience?.fixture !== true) continue;
    const observations = Array.isArray(ambience.observations)
      ? ambience.observations
      : [];
    const checks = Array.isArray(ambience.checks) ? ambience.checks : [];
    if (checks.length === 0) {
      problems.push(`${target.id}: 没有执行四槽位环境声断言`);
    }
    for (const check of checks) {
      if (check.ok !== true) {
        problems.push(`${target.id}/${check.name}: ${check.detail}`);
      }
    }
    for (const host of ["game", "editor"]) {
      const hostObservation = observations.find(
        (observation) => observation.host === host,
      );
      if (hostObservation === undefined) {
        problems.push(`${target.id}: ${host} 端没有环境声诊断观测`);
      }
    }
  }
  console.log(
    `环境声：${
      targetsOf(report).filter((target) => target.ambience?.fixture === true)
        .length
    } 个目标 / ${problems.length} 个问题`,
  );
  printProblems("四槽位环境声断言失败", problems);
  return problems;
}

// Real-WebGL shader assertions: the harness isolates each composable pass by
// pixel-diffing the authored frame against the same timeline with that pass
// zeroed (and removed), so a pass that is visually inert, wrongly anchored
// under a camera transform, or not identical at zero strength fails here.  A
// target list without the shader fixture, or a fixture target whose probe
// produced no checks, fails rather than silently skipping the effects.
function checkShaders(report, targets) {
  const problems = [];
  let checkCount = 0;
  const shaderTargets = targetsOf(report).filter(
    (target) => target.shader?.fixture === true,
  );
  const expectedShaderTargets = [...targets.ids].filter((id) =>
    id.startsWith("shader-"),
  );
  if (shaderTargets.length === 0) {
    problems.push("没有任何目标执行着色器像素断言（夹具缺失，不得静默跳过）");
  }
  for (const target of shaderTargets) {
    const checks = Array.isArray(target.shader.checks)
      ? target.shader.checks
      : [];
    if (checks.length === 0) {
      problems.push(`${target.id}: 没有执行任何着色器像素断言`);
      continue;
    }
    checkCount += checks.length;
    for (const check of checks) {
      if (check.ok !== true) {
        problems.push(`${target.id}/${check.name}: ${check.detail}`);
      }
    }
  }
  for (const id of expectedShaderTargets) {
    if (!shaderTargets.some((target) => target.id === id)) {
      problems.push(`${id}: 缺少着色器像素断言`);
    }
  }
  console.log(
    `着色器：${shaderTargets.length} 个目标 / ${checkCount} 项像素断言`,
  );
  printProblems("着色器像素断言失败", problems);
  return problems;
}

// Browser-driven lifecycle: a cancelled game presentation must settle
// `failed`, a cancelled/reset editor session must reload to exactly the same
// deterministic frame, and a cancel must have released any media.
function checkLifecycle(report) {
  const problems = [];
  for (const target of targetsOf(report)) {
    if (target.game?.cancelledOutcome !== "failed") {
      problems.push(
        `${target.id}: cancelCurrentPresentation settled ${target.game?.cancelledOutcome}`,
      );
    }
    const baseline = target.thumbnails?.["editor-0000"]?.sha256;
    for (const name of ["editor-cancelled-reload", "editor-reset-reload"]) {
      const signature = target.thumbnails?.[name]?.sha256;
      if (baseline === undefined || signature === undefined) {
        problems.push(`${target.id}: missing ${name} capture`);
      } else if (signature !== baseline) {
        problems.push(
          `${target.id}: ${name} does not reproduce editor-0000 (${signature.slice(0, 12)} != ${baseline.slice(0, 12)})`,
        );
      }
    }
    const hasMedia = (target.editor?.frames ?? []).some(
      (frame) => frame.media !== null && frame.media !== undefined,
    );
    if (hasMedia && target.cancelledMedia !== null) {
      problems.push(
        `${target.id}: cancel kept a media element (${JSON.stringify(target.cancelledMedia)})`,
      );
    }
  }
  if (problems.length > 0) {
    printProblems("生命周期断言失败", problems);
  } else {
    console.log("生命周期：取消/重置后重载逐字节复现，取消结果 failed。");
  }
  return problems;
}

/**
 * Prints the run summary and every gate's findings; returns true when any gate
 * failed.  `targets` is the validated list (`{ path, ids }`) the run was asked
 * to cover.
 */
export function checkReport({
  report,
  targets,
  pageErrors,
  captureCount,
  outputDir,
  root,
}) {
  const errors = Array.isArray(report.errors) ? report.errors : [];
  console.log(
    `parity: ${report.targets?.length ?? 0} 个目标 / ${captureCount} 张截图 / ${errors.length} 个步骤错误`,
  );
  console.log(`输出目录：${relative(root, outputDir)}`);
  if (pageErrors.length > 0) {
    console.error(`页面异常 ${pageErrors.length} 条：`);
    for (const error of pageErrors) console.error(`  - ${error}`);
  }
  for (const error of errors) {
    console.error(`步骤错误 ${error.step}: ${error.message}`);
  }
  const problems = [...checkTargetList(report, targets, root)];
  // Diagnostics never fail the run; they are recorded so a reviewer can see
  // whether a visual difference came with a host warning.
  const diagnostics = Array.isArray(report.diagnostics)
    ? report.diagnostics
    : [];
  if (diagnostics.length > 0) {
    console.log(`诊断 ${diagnostics.length} 条：`);
    for (const message of diagnostics) console.log(`  - ${message}`);
  }
  let failed = false;
  if (report.capturePolicy?.editor !== "deterministic-seek") {
    console.error(
      "harness 报告缺少确定性 seek 策略标记；无法判定媒体定位断言。",
    );
    failed = true;
  }
  problems.push(
    ...checkChoiceLayout(report),
    ...checkScrubDrift(report),
    ...checkVideo(report),
    ...checkAmbience(report),
    ...checkShaders(report, targets),
    ...checkLifecycle(report),
  );
  return (
    failed || errors.length > 0 || pageErrors.length > 0 || problems.length > 0
  );
}
