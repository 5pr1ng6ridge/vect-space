import console from "node:console";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = join(root, "game", "assets", "audio", "ambience");
const sampleRate = 22_050;
const durationMs = 1_000;
const sampleCount = (sampleRate * durationMs) / 1_000;
const bitsPerSample = 16;
const channels = 1;
const pcmScale = 32_000;
const quantizationTolerance = 2;
const authoredLoop = { startMs: 200, endMs: 800 };

const sounds = [
  { name: "ambience_birds.wav", frequency: 220, phase: 0.1 },
  { name: "ambience_rain.wav", frequency: 330, phase: 0.7 },
  { name: "ambience_intro.wav", frequency: 440, phase: 1.4 },
  { name: "ambience_demo.wav", frequency: 550, phase: 2.1 },
];

if (!Number.isInteger(sampleCount)) {
  throw new Error(`sample count must be integral, got ${sampleCount}`);
}

function waveformValue(sound, timeSeconds) {
  const phase = 2 * Math.PI * sound.frequency * timeSeconds + sound.phase;
  return (
    0.26 * Math.sin(phase) +
    0.11 * Math.sin(phase * 2) +
    0.06 * Math.cos(phase * 3) +
    0.03 * Math.sin(phase * 5)
  );
}

function waveformDerivative(sound, timeSeconds) {
  const angularFrequency = 2 * Math.PI * sound.frequency;
  const phase = angularFrequency * timeSeconds + sound.phase;
  return (
    0.26 * angularFrequency * Math.cos(phase) +
    0.11 * 2 * angularFrequency * Math.cos(phase * 2) -
    0.06 * 3 * angularFrequency * Math.sin(phase * 3) +
    0.03 * 5 * angularFrequency * Math.cos(phase * 5)
  );
}

function quantize(value) {
  return Math.round(Math.max(-1, Math.min(1, value)) * pcmScale);
}

function pcmSample(sound, index) {
  return quantize(waveformValue(sound, index / sampleRate));
}

function makeWav(sound) {
  const dataBytes = sampleCount * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(pcmSample(sound, index), 44 + index * 2);
  }
  return buffer;
}

function fail(message) {
  throw new Error(`ambience asset integrity check failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    fail(`${message} (actual ${actual}, expected ${expected})`);
  }
}

function sampleIndexAtMs(milliseconds) {
  const index = (milliseconds * sampleRate) / 1_000;
  assert(
    Number.isInteger(index),
    `loop boundary is not sample-aligned: ${milliseconds}ms`,
  );
  return index;
}

function readPcmSamples(sound, buffer) {
  const dataBytes = sampleCount * channels * (bitsPerSample / 8);
  assert(
    buffer.length === 44 + dataBytes,
    `${sound.name} has an unexpected byte length`,
  );
  assert(
    buffer.toString("ascii", 0, 4) === "RIFF",
    `${sound.name} is not RIFF`,
  );
  assert(
    buffer.toString("ascii", 8, 12) === "WAVE",
    `${sound.name} is not WAVE`,
  );
  assert(
    buffer.toString("ascii", 12, 16) === "fmt ",
    `${sound.name} has no fmt chunk`,
  );
  assert(buffer.readUInt16LE(20) === 1, `${sound.name} is not PCM`);
  assert(
    buffer.readUInt16LE(22) === channels,
    `${sound.name} channel count changed`,
  );
  assert(
    buffer.readUInt32LE(24) === sampleRate,
    `${sound.name} sample rate changed`,
  );
  assert(
    buffer.readUInt16LE(34) === bitsPerSample,
    `${sound.name} bit depth changed`,
  );
  assert(
    buffer.toString("ascii", 36, 40) === "data",
    `${sound.name} has no data chunk`,
  );
  assert(
    buffer.readUInt32LE(40) === dataBytes,
    `${sound.name} data size changed`,
  );
  return Array.from({ length: sampleCount }, (_, index) =>
    buffer.readInt16LE(44 + index * 2),
  );
}

function centralDifferenceNumerator(samples, boundaryIndex) {
  const before =
    boundaryIndex === 0 ? samples[sampleCount - 1] : samples[boundaryIndex - 1];
  const after =
    boundaryIndex === sampleCount ? samples[1] : samples[boundaryIndex + 1];
  return after - before;
}

function validateBoundary(sound, samples, label, startIndex, endIndex) {
  const startSeconds = startIndex / sampleRate;
  const endSeconds = endIndex / sampleRate;
  assertClose(
    waveformValue(sound, startSeconds),
    waveformValue(sound, endSeconds),
    1e-12,
    `${sound.name} ${label} values are not continuous`,
  );
  assertClose(
    waveformDerivative(sound, startSeconds),
    waveformDerivative(sound, endSeconds),
    1e-8,
    `${sound.name} ${label} derivatives are not continuous`,
  );

  const startSample = samples[startIndex];
  const endSample = endIndex === sampleCount ? samples[0] : samples[endIndex];
  assertClose(
    startSample,
    pcmSample(sound, startIndex),
    quantizationTolerance,
    `${sound.name} ${label} start sample is not natural`,
  );
  assertClose(
    endSample,
    pcmSample(sound, endIndex),
    quantizationTolerance,
    `${sound.name} ${label} end sample is not natural`,
  );
  assertClose(
    centralDifferenceNumerator(samples, startIndex),
    centralDifferenceNumerator(samples, endIndex),
    quantizationTolerance,
    `${sound.name} ${label} derivatives are not continuous after quantization`,
  );
}

function validateAsset(sound, buffer) {
  const samples = readPcmSamples(sound, buffer);
  const firstSample = pcmSample(sound, 0);
  const naturalLastSample = pcmSample(sound, sampleCount - 1);
  assert(
    naturalLastSample !== firstSample,
    `${sound.name} test waveform does not distinguish its natural final sample`,
  );
  assert(
    samples[sampleCount - 1] === naturalLastSample,
    `${sound.name} has a duplicated endpoint; final sample must be the natural t<1s sample`,
  );
  for (let index = 0; index < sampleCount; index += 1) {
    assert(
      samples[index] === pcmSample(sound, index),
      `${sound.name} sample ${index} differs from its deterministic waveform`,
    );
  }

  validateBoundary(sound, samples, "1s boundary", 0, sampleCount);
  validateBoundary(
    sound,
    samples,
    "authored 200..800ms loop boundary",
    sampleIndexAtMs(authoredLoop.startMs),
    sampleIndexAtMs(authoredLoop.endMs),
  );
}

const checkOnly = process.argv.slice(2).includes("--check");
const generated = sounds.map((sound) => ({ sound, buffer: makeWav(sound) }));
for (const { sound, buffer } of generated) validateAsset(sound, buffer);

if (checkOnly) {
  for (const sound of sounds) {
    validateAsset(sound, await readFile(join(outputDirectory, sound.name)));
  }
  console.log(
    `checked ${sounds.length} deterministic WAV ambience assets, including full-period and authored-loop continuity`,
  );
} else {
  await mkdir(dirname(outputDirectory), { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  for (const { sound, buffer } of generated) {
    await writeFile(join(outputDirectory, sound.name), buffer);
  }
  console.log(
    `generated ${sounds.length} deterministic ${durationMs}ms mono WAV ambience assets in ${outputDirectory}`,
  );
}
