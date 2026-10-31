import type { AudioDiagnostics } from "@vectspace/presentation-core/audio";
import type {
  AmbienceSlot,
  PresentationCue,
  RuntimeSnapshot,
} from "@vectspace/presentation-core/types";
import { evaluateTimelineFrame } from "@vectspace/presentation-core/timeline-evaluator";
import type {
  AmbienceAutomationExpectation,
  AmbienceObservation,
  ParityTarget,
  TargetAmbienceReport,
  TimelineCue,
} from "./types";

export const AMBIENCE_DIAGNOSTIC_SLOTS = [
  "slot_1",
  "slot_2",
  "slot_3",
  "slot_4",
] as const;

export function buildAmbienceReport(
  target: ParityTarget,
): TargetAmbienceReport | null {
  const start = target.start_snapshot.audio.ambience;
  const expected = Object.fromEntries(
    AMBIENCE_DIAGNOSTIC_SLOTS.map((slot) => [
      slot,
      start?.[slot]?.asset ?? null,
    ]),
  ) as TargetAmbienceReport["expected"];
  const after = target.update.snapshot.audio.ambience;
  const expectedAfter = Object.fromEntries(
    AMBIENCE_DIAGNOSTIC_SLOTS.map((slot) => [
      slot,
      after?.[slot]?.asset ?? null,
    ]),
  ) as TargetAmbienceReport["expected_after"];
  const snapshotVolumes = Object.fromEntries(
    AMBIENCE_DIAGNOSTIC_SLOTS.map((slot) => [
      slot,
      start?.[slot]?.volume ?? null,
    ]),
  ) as TargetAmbienceReport["snapshot_volumes"];
  const timeline =
    target.update.cues.find(
      (cue): cue is TimelineCue => cue.type === "timeline",
    ) ?? null;
  const transitionCue = target.update.cues.find(
    (cue): cue is Extract<PresentationCue, { type: "ambience_transition" }> =>
      cue.type === "ambience_transition",
  );
  const transition =
    transitionCue === undefined
      ? null
      : { slot: transitionCue.slot, asset: transitionCue.to?.asset ?? null };
  const retune =
    transitionCue?.from !== null &&
    transitionCue?.from !== undefined &&
    transitionCue.to !== null &&
    transitionCue.to !== undefined &&
    transitionCue.from.asset === transitionCue.to.asset
      ? {
          slot: transitionCue.slot,
          asset: transitionCue.to.asset,
          start_ms: transitionCue.to.start_ms,
          loop_start_ms: transitionCue.to.loop_start_ms ?? null,
          loop_end_ms: transitionCue.to.loop_end_ms ?? null,
        }
      : null;
  const fixture =
    Object.values(expected).some((asset) => asset !== null) ||
    Object.values(expectedAfter).some((asset) => asset !== null) ||
    timeline?.tracks.some((track) => track.type === "ambience") === true ||
    transition !== null;
  return fixture
    ? {
        fixture: true,
        expected,
        expected_after: expectedAfter,
        snapshot_volumes: snapshotVolumes,
        automation:
          timeline === null ? null : buildAmbienceAutomation(timeline, start),
        transition,
        retune,
        observations: [],
        checks: [],
      }
    : null;
}

function buildAmbienceAutomation(
  timeline: TimelineCue,
  start: RuntimeSnapshot["audio"]["ambience"],
): AmbienceAutomationExpectation {
  const baseVolumes = Object.fromEntries(
    AMBIENCE_DIAGNOSTIC_SLOTS.map((slot) => [slot, start?.[slot]?.volume ?? 1]),
  ) as Partial<Record<AmbienceSlot, number>>;
  const evaluate = (elapsedMs: number): Record<AmbienceSlot, number | null> => {
    const frame = evaluateTimelineFrame(
      { duration_ms: timeline.duration_ms, tracks: timeline.tracks },
      {
        sprites: {},
        camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        ambience_volumes: baseVolumes,
      },
      elapsedMs,
    );
    return Object.fromEntries(
      AMBIENCE_DIAGNOSTIC_SLOTS.map((slot) => [
        slot,
        frame.ambience_volumes?.[slot] ?? null,
      ]),
    ) as Record<AmbienceSlot, number | null>;
  };
  return {
    duration_ms: timeline.duration_ms,
    values: Object.fromEntries(
      AMBIENCE_DIAGNOSTIC_SLOTS.map((slot) => {
        const startValue = evaluate(0)[slot];
        const midValue = evaluate(timeline.duration_ms / 2)[slot];
        const endValue = evaluate(timeline.duration_ms)[slot];
        return [slot, { start: startValue, mid: midValue, end: endValue }];
      }),
    ) as AmbienceAutomationExpectation["values"],
  };
}

export function recordAmbience(
  report: TargetAmbienceReport | null,
  host: "game" | "editor",
  step: string,
  diagnostics: AudioDiagnostics | null,
): void {
  if (report === null) return;
  const slots = {} as AmbienceObservation["slots"];
  for (const slot of AMBIENCE_DIAGNOSTIC_SLOTS) {
    const track = diagnostics?.ambience[slot] ?? null;
    slots[slot] =
      track === null
        ? null
        : {
            asset: track.asset,
            volume: track.volume,
            paused: track.paused,
            current_time: track.current_time,
          };
  }
  report.observations.push({
    host,
    step,
    slots,
    bus_volume: diagnostics?.buses.ambience ?? null,
    context_state: diagnostics?.context_state ?? null,
  });
}

export function ambienceCheck(
  report: TargetAmbienceReport,
  name: string,
  ok: boolean,
  detail: string,
): void {
  report.checks.push({ name, ok, detail });
}

function ambienceObservation(
  report: TargetAmbienceReport,
  host: "game" | "editor",
  step: string,
): AmbienceObservation | undefined {
  return report.observations.find(
    (candidate) => candidate.host === host && candidate.step === step,
  );
}

function hasExpectedAmbience(
  report: TargetAmbienceReport,
  observation: AmbienceObservation | undefined,
  expectedAssets: Record<AmbienceSlot, string | null> = report.expected,
): boolean {
  return (
    observation !== undefined &&
    AMBIENCE_DIAGNOSTIC_SLOTS.every((slot) => {
      const expected = expectedAssets[slot];
      const actual = observation.slots[slot];
      return expected === null
        ? actual === null
        : actual !== null && actual.asset === expected && !actual.paused;
    })
  );
}

function hasStoppedAmbience(
  observation: AmbienceObservation | undefined,
): boolean {
  return (
    observation !== undefined &&
    AMBIENCE_DIAGNOSTIC_SLOTS.every((slot) => observation.slots[slot] === null)
  );
}

function hasClearedAmbience(
  observation: AmbienceObservation | undefined,
): boolean {
  return hasStoppedAmbience(observation) && observation?.bus_volume === null;
}

function validateAutomationPoint(
  report: TargetAmbienceReport,
  host: "game" | "editor",
  step: string,
  point: "start" | "mid" | "end",
  tolerance: number,
): void {
  const observation = ambienceObservation(report, host, step);
  const expected = report.automation?.values;
  const ok =
    observation !== undefined &&
    expected !== undefined &&
    AMBIENCE_DIAGNOSTIC_SLOTS.every((slot) => {
      const expectedVolume = expected[slot][point];
      const actual = observation.slots[slot];
      return (
        expectedVolume !== null &&
        actual !== null &&
        Number.isFinite(actual.volume) &&
        Math.abs(actual.volume - expectedVolume) <= tolerance
      );
    });
  ambienceCheck(
    report,
    `${host} ${step} 精确应用四槽位音量自动化`,
    ok,
    JSON.stringify({ observation, expected: expected?.["slot_1"] }),
  );
}

function validateSnapshotVolumePoint(
  report: TargetAmbienceReport,
  host: "game" | "editor",
  step: string,
  tolerance: number,
): void {
  const observation = ambienceObservation(report, host, step);
  const ok =
    observation !== undefined &&
    AMBIENCE_DIAGNOSTIC_SLOTS.every((slot) => {
      const expected = report.snapshot_volumes[slot];
      const actual = observation.slots[slot];
      return (
        expected !== null &&
        actual !== null &&
        Number.isFinite(actual.volume) &&
        Math.abs(actual.volume - expected) <= tolerance
      );
    });
  ambienceCheck(
    report,
    `${host} ${step} 恢复权威快照音量`,
    ok,
    JSON.stringify({ observation, expected: report.snapshot_volumes }),
  );
}

export function validateAmbienceReport(
  report: TargetAmbienceReport | null,
): void {
  if (report === null) return;
  const gameStart = ambienceObservation(report, "game", "game-start");
  const editorPreUnlock = ambienceObservation(
    report,
    "editor",
    "editor-pre-unlock",
  );
  const editorStart = ambienceObservation(report, "editor", "editor-0000");
  ambienceCheck(
    report,
    "editor pre-unlock 不创建任何环境声 media resource",
    editorPreUnlock !== undefined &&
      AMBIENCE_DIAGNOSTIC_SLOTS.every(
        (slot) => editorPreUnlock.slots[slot] === null,
      ),
    JSON.stringify(editorPreUnlock ?? null),
  );
  for (const [host, observation] of [
    ["game", gameStart],
    ["editor", editorStart],
  ] as const) {
    ambienceCheck(
      report,
      `${host} 四个环境声槽位由共享诊断可读`,
      hasExpectedAmbience(report, observation),
      JSON.stringify(observation ?? null),
    );
    ambienceCheck(
      report,
      `${host} 使用独立 ambience bus`,
      observation?.bus_volume !== null &&
        observation?.bus_volume !== undefined &&
        observation.bus_volume > 0,
      JSON.stringify(observation?.bus_volume ?? null),
    );
  }

  // Game samples are wall-clock observations, while editor seeks are
  // deterministic. Keep a tight tolerance for the latter and a bounded one
  // for the browser clock while checking every authored slot, not just the
  // first diagnostic snapshot.
  if (report.automation !== null) {
    validateAutomationPoint(report, "game", "game-mid", "mid", 0.08);
    validateSnapshotVolumePoint(report, "game", "game-end", 0.08);
    validateAutomationPoint(report, "editor", "editor-mid", "mid", 0.025);
    validateAutomationPoint(report, "editor", "editor-end", "end", 0.025);
  }
  const expectedCurrent =
    report.transition === null ? report.expected : report.expected_after;
  if (report.transition !== null) {
    ambienceCheck(
      report,
      `game post-demo ${report.transition.slot} replacement/stop`,
      hasExpectedAmbience(
        report,
        ambienceObservation(report, "game", "game-end"),
        report.expected_after,
      ),
      JSON.stringify({
        transition: report.transition,
        observation: ambienceObservation(report, "game", "game-end"),
      }),
    );
    ambienceCheck(
      report,
      `editor post-demo ${report.transition.slot} replacement/stop`,
      hasExpectedAmbience(
        report,
        ambienceObservation(report, "editor", "editor-transition-settled"),
        report.expected_after,
      ),
      JSON.stringify({
        transition: report.transition,
        observation: ambienceObservation(
          report,
          "editor",
          "editor-transition-settled",
        ),
      }),
    );
  }

  if (report.retune !== null) {
    const before = gameStart?.slots[report.retune.slot] ?? null;
    const after =
      ambienceObservation(report, "game", "game-end")?.slots[
        report.retune.slot
      ] ?? null;
    const resetHead = report.retune.start_ms / 1_000;
    const preservedHead =
      before !== null &&
      after !== null &&
      before.asset === report.retune.asset &&
      after.asset === report.retune.asset &&
      Number.isFinite(before.current_time) &&
      Number.isFinite(after.current_time) &&
      Math.abs(after.current_time - before.current_time) <= 0.25 &&
      Math.abs(after.current_time - resetHead) >= 0.25;
    ambienceCheck(
      report,
      "game same-slot same-asset retune 保留播放头而非 seek 到 start_ms",
      preservedHead,
      JSON.stringify({ before, after, retune: report.retune }),
    );
  }

  const phasePoints = [
    {
      observation: ambienceObservation(report, "game", "game-mid"),
      expected: report.expected,
    },
    {
      observation: ambienceObservation(report, "game", "game-end"),
      expected: expectedCurrent,
    },
    {
      observation: ambienceObservation(report, "editor", "editor-end"),
      expected: expectedCurrent,
    },
  ];
  ambienceCheck(
    report,
    "四槽位 phase diagnostics 均为有限非负值",
    phasePoints.every(
      ({ observation, expected }) =>
        observation !== undefined &&
        AMBIENCE_DIAGNOSTIC_SLOTS.every((slot) => {
          const actual = observation.slots[slot];
          return expected[slot] === null
            ? actual === null
            : actual !== null &&
                Number.isFinite(actual.current_time) &&
                actual.current_time >= 0;
        }),
    ),
    JSON.stringify(phasePoints),
  );
  const editorEnd = ambienceObservation(report, "editor", "editor-end");
  ambienceCheck(
    report,
    "editor seek 不把环境声 phase 重置到零",
    editorEnd !== undefined &&
      AMBIENCE_DIAGNOSTIC_SLOTS.every((slot) => {
        if (expectedCurrent[slot] === null)
          return editorEnd.slots[slot] === null;
        return (editorEnd.slots[slot]?.current_time ?? 0) > 0.01;
      }),
    JSON.stringify(editorEnd ?? null),
  );

  ambienceCheck(
    report,
    "游戏与编辑器共享四槽位资产诊断",
    gameStart !== undefined &&
      editorStart !== undefined &&
      AMBIENCE_DIAGNOSTIC_SLOTS.every(
        (slot) =>
          gameStart.slots[slot]?.asset === editorStart.slots[slot]?.asset,
      ),
    JSON.stringify({ game: gameStart, editor: editorStart }),
  );

  ambienceCheck(
    report,
    "game cancellation 清理所有环境声槽位",
    hasStoppedAmbience(ambienceObservation(report, "game", "game-cancelled")),
    JSON.stringify(
      ambienceObservation(report, "game", "game-cancelled") ?? null,
    ),
  );
  ambienceCheck(
    report,
    "editor cancellation 保留并恢复环境声快照",
    hasExpectedAmbience(
      report,
      ambienceObservation(report, "editor", "editor-cancelled"),
      expectedCurrent,
    ),
    JSON.stringify(
      ambienceObservation(report, "editor", "editor-cancelled") ?? null,
    ),
  );
  for (const step of ["editor-cancelled-reload", "editor-reset-reload"]) {
    ambienceCheck(
      report,
      `${step} 恢复四个环境声槽位`,
      hasExpectedAmbience(report, ambienceObservation(report, "editor", step)),
      JSON.stringify(ambienceObservation(report, "editor", step) ?? null),
    );
  }
  if (
    report.observations.some(
      (observation) => observation.step === "scene-boundary-cleanup",
    )
  ) {
    for (const host of ["game", "editor"] as const) {
      ambienceCheck(
        report,
        `${host} scene boundary cleanup`,
        hasClearedAmbience(
          ambienceObservation(report, host, "scene-boundary-cleanup"),
        ),
        JSON.stringify(
          ambienceObservation(report, host, "scene-boundary-cleanup") ?? null,
        ),
      );
    }
  }
}
