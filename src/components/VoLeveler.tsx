"use client";

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import JSZip from "jszip";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import styles from "./VoLeveler.module.css";

const LOUDNESS_PRESETS = {
  "ATSC A/85 (-24 LKFS, -2 dBTP)": { I: "-24", TP: "-2", LRA: "7", suffix: "A85" },
  "EBU R128 (-23 LUFS, -1 dBTP)": { I: "-23", TP: "-1", LRA: "7", suffix: "R128" },
  "Mix-ready only (no loudness normalize)": null,
} as const;

const BREATH_COMPAND = {
  Off: null,
  Light: "compand=attacks=0.2:decays=0.8:points=-90/-90|-60/-66|-40/-40|-20/-20|0/0",
  Medium: "compand=attacks=0.2:decays=0.8:points=-90/-90|-60/-70|-40/-40|-20/-20|0/0",
} as const;

const FLOOR_GUARD =
  "compand=attacks=0.05:decays=0.2:points=-90/-95|-70/-74|-60/-60|-50/-50|-20/-20|0/0";
const FLOOR_GUARD_STRONG =
  "compand=attacks=0.04:decays=0.18:points=-90/-100|-75/-82|-64/-65|-52/-53|-20/-20|0/0";

const LEVELER_PRESETS = {
  "Minimal (no auto-leveler)": {
    dyna: null,
    compressor: { threshold: "-27dB", ratio: "1.7" },
  },
  Gentle: {
    dyna: { f: 181, g: 5, m: 5 },
    compressor: { threshold: "-26dB", ratio: "2.05" },
  },
  Balanced: {
    dyna: { f: 221, g: 7, m: 7 },
    compressor: { threshold: "-24dB", ratio: "2.25" },
  },
  Firm: {
    dyna: { f: 271, g: 9, m: 9 },
    compressor: { threshold: "-22dB", ratio: "2.45" },
  },
} as const;

const LEVELER_CONSISTENCY = {
  "Minimal (no auto-leveler)": 0.15,
  Gentle: 0.45,
  Balanced: 0.65,
  Firm: 0.85,
} as const;

const SMART_MATCH_PRESETS = {
  Off: { tone: 0, dynamics: 0 },
  Gentle: { tone: 0.45, dynamics: 0.3 },
  Balanced: { tone: 0.7, dynamics: 0.5 },
} as const;

const CORE_BASE_URL = "ffmpeg/ffmpeg-core";
const ANALYSIS_SAMPLE_SECONDS = 180;
const ANALYSIS_SAMPLE_RATE = 16000;
const ENVELOPE_FRAME_MS = 10;
const ENVELOPE_FLOOR_DB = -120;
const MIX_SEGMENT_SECONDS = 75;
const MIX_SEGMENT_MIN_DURATION_SECONDS = 105;
const BATCH_MEMORY_GUARD_FILE_THRESHOLD = 8;
const BATCH_MEMORY_GUARD_INTERVAL = 3;
const LIMITER_FILTER = "alimiter=limit=-2dB:level=disabled";
const FATAL_FFMPEG_PATTERN = /memory access out of bounds|runtimeerror/i;
const IMPORTANT_LOG_PATTERN = /error|failed|invalid|aborted|out of bounds/i;

const sanitizeBase = (name: string) =>
  name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9-_]+/g, "_");

const formatBytes = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const toOddInt = (value: number, min: number, max: number) => {
  let rounded = Math.round(clamp(value, min, max));
  if (rounded % 2 === 0) {
    rounded += rounded >= max ? -1 : 1;
  }
  return rounded;
};

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const mean = (values: number[]) => {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const percentile = (values: number[], percent: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (clamp(percent, 0, 100) / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

const toDb = (value: number) => {
  if (value <= 0) return ENVELOPE_FLOOR_DB;
  return 20 * Math.log10(value);
};

const fromDb = (db: number) => Math.pow(10, db / 20);

const robustMedian = (values: number[]) => {
  if (values.length === 0) return null;
  const baseMedian = median(values);
  if (baseMedian === null) return null;

  const deviations = values.map((value) => Math.abs(value - baseMedian));
  const mad = median(deviations) ?? 0;
  if (mad <= 1e-6) return baseMedian;

  const scale = 1.4826 * mad;
  const filtered = values.filter((value) => Math.abs(value - baseMedian) / scale <= 2.8);
  return median(filtered.length > 0 ? filtered : values);
};

const downgradeRoomRisk = (risk: RoomRisk): RoomRisk => {
  if (risk === "high") return "medium";
  if (risk === "medium") return "low";
  return "low";
};

const classifyRoomRisk = (roomScore: number): RoomRisk => {
  if (roomScore < 0.33) return "low";
  if (roomScore < 0.58) return "medium";
  return "high";
};

const parseMaybeNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const formatSigned = (value: number, decimals = 1) =>
  `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}`;

const shouldRecycleFfmpegForBatch = (completedCount: number, totalCount: number) =>
  totalCount >= BATCH_MEMORY_GUARD_FILE_THRESHOLD &&
  completedCount < totalCount &&
  completedCount % BATCH_MEMORY_GUARD_INTERVAL === 0;

type OutputEntry = {
  name: string;
  url: string;
  size: number;
  kind: "mixready" | "loudness";
  variant: "clean" | "blend";
};

type FileAnalysis = {
  inputI: number | null;
  inputLRA: number | null;
  inputTP: number | null;
  inputThresh: number | null;
  lowRms: number | null;
  midRms: number | null;
  highRms: number | null;
  noiseFloorDb: number | null;
  nearSpeechNoiseFloorDb: number | null;
  speechThresholdDb: number | null;
  reverbScore: number | null;
  echoScore: number | null;
  roomScore: number | null;
  echoDelayMs: number | null;
  analysisConfidence: number | null;
  drynessScore: number | null;
  instabilityScore: number | null;
  clickScore: number | null;
};

type BatchReference = {
  lowTilt: number;
  highTilt: number;
  lra: number;
};

type NoiseRisk = "low" | "medium" | "high";
type RoomRisk = "low" | "medium" | "high";

type AdaptiveProfile = {
  highpassHz: number;
  lowMidGainDb: number;
  presenceGainDb: number;
  airGainDb: number;
  emotionalHarshnessCutDb: number;
  topEndHarshnessCutDb: number;
  levelingNeed: number;
  emotionProtection: number;
  compressorRatioOffset: number;
  compressorThresholdOffsetDb: number;
  dynaTrim: number;
  floorGuardFilter: string;
  noiseRisk: NoiseRisk;
  noiseFloorDb: number | null;
  speechThresholdDb: number | null;
  roomRisk: RoomRisk;
  useDenoise: boolean;
  denoiseStrength: number;
  useTailGate: boolean;
  tailGateStrength: number;
  echoNotchCutDb: number;
  instabilityScore: number;
  clickScore: number;
  clickTameStrength: number;
  blendIndoorGain: number;
  blendOutdoorGain: number;
  blendIndoorDelayMs: number;
  blendOutdoorDelayMs: number;
};

type JobEntry = {
  file: File;
  base: string;
  inputName: string;
  mixName: string;
  blendMixName: string;
};

type FailedOptimization = {
  base: string;
  fileName: string;
  reason: string;
};

const createEmptyAnalysis = (): FileAnalysis => ({
  inputI: null,
  inputLRA: null,
  inputTP: null,
  inputThresh: null,
  lowRms: null,
  midRms: null,
  highRms: null,
  noiseFloorDb: null,
  nearSpeechNoiseFloorDb: null,
  speechThresholdDb: null,
  reverbScore: null,
  echoScore: null,
  roomScore: null,
  echoDelayMs: null,
  analysisConfidence: null,
  drynessScore: null,
  instabilityScore: null,
  clickScore: null,
});

export default function VoLeveler() {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const logBufferRef = useRef<string[]>([]);

  const [files, setFiles] = useState<File[]>([]);
  const [outputs, setOutputs] = useState<OutputEntry[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<string>("Idle");
  const [loading, setLoading] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipProgress, setZipProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [failedOptimizations, setFailedOptimizations] = useState<FailedOptimization[]>([]);
  const [showFailureWarning, setShowFailureWarning] = useState(false);

  const [loudnessTarget, setLoudnessTarget] = useState<keyof typeof LOUDNESS_PRESETS>(
    "ATSC A/85 (-24 LKFS, -2 dBTP)"
  );
  const [keepMixReady, setKeepMixReady] = useState(true);
  const [smartMatchMode, setSmartMatchMode] = useState<keyof typeof SMART_MATCH_PRESETS>("Gentle");
  const [eqCleanup, setEqCleanup] = useState(true);
  const [breathControl, setBreathControl] = useState<keyof typeof BREATH_COMPAND>("Light");
  const [leveler, setLeveler] = useState<keyof typeof LEVELER_PRESETS>("Balanced");
  const [roomCleanup, setRoomCleanup] = useState(true);
  const [sceneBlend, setSceneBlend] = useState(true);
  const [softenHarshness, setSoftenHarshness] = useState(true);
  const [noiseGuard, setNoiseGuard] = useState(true);
  const [floorGuard, setFloorGuard] = useState(true);

  const loudnessConfig = useMemo(() => LOUDNESS_PRESETS[loudnessTarget], [loudnessTarget]);
  const smartMatchConfig = useMemo(() => SMART_MATCH_PRESETS[smartMatchMode], [smartMatchMode]);

  useEffect(() => {
    return () => {
      outputs.forEach((output) => URL.revokeObjectURL(output.url));
    };
  }, [outputs]);

  useEffect(() => {
    return () => {
      if (ffmpegRef.current) {
        try {
          ffmpegRef.current.terminate();
        } catch {
          // Ignore terminate failures during unmount.
        }
        ffmpegRef.current = null;
      }
    };
  }, []);

  const appendLog = (message: string) => {
    setLogs((prev) => [...prev.slice(-300), message]);
  };

  const toBlobURLSafe = async (url: string, mime: string) => {
    try {
      return await toBlobURL(url, mime);
    } catch {
      return undefined;
    }
  };

  const teardownFfmpeg = () => {
    if (!ffmpegRef.current) return;
    try {
      ffmpegRef.current.terminate();
    } catch {
      // Ignore terminate failures while resetting worker state.
    } finally {
      ffmpegRef.current = null;
      logBufferRef.current = [];
    }
  };

  const hasFatalFfmpegSignal = (text: string) => FATAL_FFMPEG_PATTERN.test(text);

  const shouldResetFfmpegForError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return hasFatalFfmpegSignal(message) || /RuntimeError|memory access out of bounds/i.test(message);
  };

  const refreshFfmpeg = async (reason: string) => {
    appendLog(`Resetting FFmpeg worker (${reason})...`);
    teardownFfmpeg();
    return await ensureFfmpeg();
  };

  const ensureFfmpeg = async () => {
    if (ffmpegRef.current) return ffmpegRef.current;

    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      if (message.trim() === "Aborted()") {
        // Common during terminate/reset; not a reliable execution failure signal.
        return;
      }
      logBufferRef.current.push(message);
      if (logBufferRef.current.length > 2000) {
        logBufferRef.current = logBufferRef.current.slice(-1200);
      }
      if (IMPORTANT_LOG_PATTERN.test(message)) {
        appendLog(message);
      }
    });

    ffmpeg.on("progress", ({ progress }) => {
      if (progress > 0) {
        setStatus(`Processing ${(progress * 100).toFixed(0)}%`);
      }
    });

    setStatus("Loading FFmpeg core...");
    const coreURL = await toBlobURL(`${CORE_BASE_URL}.js`, "text/javascript");
    const wasmURL = await toBlobURL(`${CORE_BASE_URL}.wasm`, "application/wasm");
    const workerURL = await toBlobURLSafe(`${CORE_BASE_URL}.worker.js`, "text/javascript");

    await ffmpeg.load({
      coreURL,
      wasmURL,
      ...(workerURL ? { workerURL } : {}),
    });

    ffmpegRef.current = ffmpeg;
    setStatus("FFmpeg ready");
    return ffmpeg;
  };

  const resetLogBuffer = () => {
    const snapshot = logBufferRef.current.join("\n");
    logBufferRef.current = [];
    return snapshot;
  };

  const parseLoudnormJson = (text: string) => {
    const matches = text.match(/\{[\s\S]*?\}/g);
    if (!matches || matches.length === 0) return null;
    try {
      return JSON.parse(matches[matches.length - 1]) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

const parseRmsFromAstats = (text: string) => {
    const matches = text.match(/RMS level dB:\s*(-?(?:\d+(?:\.\d+)?|inf))/gi);
    if (!matches || matches.length === 0) return null;
    const raw = matches[matches.length - 1].split(":").at(-1)?.trim().toLowerCase();
    if (!raw) return null;
    if (raw === "-inf" || raw === "inf") return -120;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseDurationSeconds = (text: string) => {
  const match = text.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
};

const summarizeFailureLog = (text: string) => {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const important = lines.filter((line) => IMPORTANT_LOG_PATTERN.test(line));
  const selected = (important.length > 0 ? important : lines).slice(-3);
  return selected.join(" | ");
};

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const summarizeFailureReason = (error: unknown) => {
  const compact = describeError(error).replace(/\s+/g, " ").trim();
  if (compact.length <= 180) return compact;
  return `${compact.slice(0, 177)}...`;
};

  const execOrThrow = async (ffmpeg: FFmpeg, args: string[], context: string) => {
    const exitCode = await ffmpeg.exec(args);
    const snapshot = logBufferRef.current.join("\n");
    if (exitCode !== 0) {
      const summary = summarizeFailureLog(snapshot);
      const exitText = exitCode !== 0 ? ` (exit ${exitCode})` : "";
      throw new Error(`${context} failed${exitText}${summary ? `: ${summary}` : ""}`);
    }
  };

  const runRmsAnalysis = async (ffmpeg: FFmpeg, inputName: string, bandFilter: string) => {
    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-i",
        inputName,
        "-t",
        `${ANALYSIS_SAMPLE_SECONDS}`,
        "-af",
        `${bandFilter},astats=metadata=0:reset=0:measure_perchannel=0`,
        "-f",
        "null",
        "-",
      ],
      "RMS analysis"
    );
    const logText = resetLogBuffer();
    return parseRmsFromAstats(logText);
  };

  const readVirtualFileBytes = async (ffmpeg: FFmpeg, name: string) => {
    const data = await ffmpeg.readFile(name);
    return typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  };

  const toFloatSamples = (bytes: Uint8Array) => {
    const usableLength = bytes.byteLength - (bytes.byteLength % 4);
    if (usableLength <= 0) return new Float32Array(0);
    if (bytes.byteOffset % 4 === 0) {
      return new Float32Array(bytes.buffer, bytes.byteOffset, usableLength / 4).slice();
    }
    const aligned = bytes.slice(0, usableLength);
    return new Float32Array(aligned.buffer, aligned.byteOffset, usableLength / 4);
  };

  const computeEnvelopeMetrics = (samples: Float32Array) => {
    const frameSize = Math.max(1, Math.round((ANALYSIS_SAMPLE_RATE * ENVELOPE_FRAME_MS) / 1000));
    const frameCount = Math.floor(samples.length / frameSize);
    if (frameCount < 20) {
      return {
        noiseFloorDb: null,
        nearSpeechNoiseFloorDb: null,
        speechThresholdDb: null,
        reverbScore: null,
        echoScore: null,
        roomScore: null,
        echoDelayMs: null,
        analysisConfidence: null,
        drynessScore: null,
        instabilityScore: null,
        clickScore: null,
      };
    }

    const frameRms = new Array<number>(frameCount);
    const frameDb = new Array<number>(frameCount);
    const framePeak = new Array<number>(frameCount);
    for (let i = 0; i < frameCount; i += 1) {
      let sumSquares = 0;
      let peakAbs = 0;
      const frameStart = i * frameSize;
      for (let j = 0; j < frameSize; j += 1) {
        const value = samples[frameStart + j] ?? 0;
        const absValue = Math.abs(value);
        if (absValue > peakAbs) peakAbs = absValue;
        sumSquares += value * value;
      }
      const rms = Math.sqrt(sumSquares / frameSize);
      frameRms[i] = rms;
      frameDb[i] = Math.max(ENVELOPE_FLOOR_DB, toDb(rms + 1e-12));
      framePeak[i] = peakAbs;
    }

    const initialNoiseFloorDb = clamp(percentile(frameDb, 20) ?? -68, -90, -28);
    const initialSpeechThresholdDb = clamp(initialNoiseFloorDb + 12, -58, -26);
    const speechMask = frameDb.map((db) => db > initialSpeechThresholdDb);
    const speechDbSeries: number[] = [];
    const nearSpeechNoiseDb: number[] = [];
    const nonSpeechDb: number[] = [];
    const speechContextFrames = Math.round(0.35 / (ENVELOPE_FRAME_MS / 1000));
    for (let i = 0; i < frameCount; i += 1) {
      if (speechMask[i]) {
        speechDbSeries.push(frameDb[i]);
        continue;
      }
      nonSpeechDb.push(frameDb[i]);
      const from = Math.max(0, i - speechContextFrames);
      const to = Math.min(frameCount - 1, i + speechContextFrames);
      for (let j = from; j <= to; j += 1) {
        if (speechMask[j]) {
          nearSpeechNoiseDb.push(frameDb[i]);
          break;
        }
      }
    }

    const nearSpeechNoiseFloorDb =
      nearSpeechNoiseDb.length > 0 ? clamp(percentile(nearSpeechNoiseDb, 72) ?? -90, -90, -28) : null;
    const nonSpeechFloorDb = clamp(percentile(nonSpeechDb, 65) ?? initialNoiseFloorDb, -90, -28);
    const noiseFloorDb = clamp(
      Math.max(initialNoiseFloorDb, nonSpeechFloorDb, nearSpeechNoiseFloorDb ?? ENVELOPE_FLOOR_DB),
      -90,
      -28
    );
    const speechThresholdDb = clamp(noiseFloorDb + 10.5, -58, -26);

    const meanSlice = (values: number[], start: number, end: number) => {
      const safeStart = Math.max(0, start);
      const safeEnd = Math.min(values.length, end);
      if (safeEnd <= safeStart) return null;
      let sum = 0;
      for (let i = safeStart; i < safeEnd; i += 1) {
        sum += values[i];
      }
      return sum / (safeEnd - safeStart);
    };

    const reverbEvents: number[] = [];
    let activeSpeechFrames = 0;
    let speechRun = 0;
    for (let i = 0; i < frameCount - 1; i += 1) {
      if (speechMask[i]) {
        activeSpeechFrames += 1;
        speechRun += 1;
      } else {
        speechRun = 0;
      }

      if (speechRun >= 8 && speechMask[i] && !speechMask[i + 1]) {
        const preDb = meanSlice(frameDb, i - 6, i + 1);
        const shortDb = meanSlice(frameDb, i + 2, i + 10);
        const longDb = meanSlice(frameDb, i + 14, i + 30);
        if (preDb === null || shortDb === null || longDb === null) continue;

        const longDrop = preDb - longDb;
        const shortToLongDecay = shortDb - longDb;
        const tailLift = longDb - noiseFloorDb;

        const eventScore = clamp(
          clamp((20 - longDrop) / 20, 0, 1) * 0.55 +
            clamp((8 - shortToLongDecay) / 8, 0, 1) * 0.35 +
            clamp((tailLift - 4) / 12, 0, 1) * 0.1,
          0,
          1
        );
        reverbEvents.push(eventScore);
      }
    }

    const envelopeMean = mean(frameRms);
    const centered = frameRms.map((value) => value - envelopeMean);
    let bestEchoCorr = 0;
    let bestEchoLagFrames = 0;
    for (let lag = 4; lag <= 18; lag += 1) {
      let num = 0;
      let denA = 0;
      let denB = 0;
      for (let i = 0; i < centered.length - lag; i += 1) {
        const a = centered[i];
        const b = centered[i + lag];
        num += a * b;
        denA += a * a;
        denB += b * b;
      }
      const denom = Math.sqrt(denA * denB) + 1e-12;
      const corr = num / denom;
      if (corr > bestEchoCorr) {
        bestEchoCorr = corr;
        bestEchoLagFrames = lag;
      }
    }

    const p90 = percentile(frameDb, 90) ?? -28;
    const dynamicSpread = Math.max(0, p90 - noiseFloorDb);
    const fallbackReverb = clamp((16 - dynamicSpread) / 16, 0, 0.55);
    const reverbScore = clamp(
      reverbEvents.length > 0 ? (median(reverbEvents) ?? fallbackReverb) : fallbackReverb,
      0,
      1
    );
    const echoScore = clamp((bestEchoCorr - 0.16) / 0.34, 0, 1);
    const noiseIndicator = clamp((noiseFloorDb + 48) / 20, 0, 1);
    const roomScore = clamp(reverbScore * 0.62 + echoScore * 0.28 + noiseIndicator * 0.1, 0, 1);

    const speechCoverage = clamp(activeSpeechFrames / Math.max(frameCount * 0.2, 1), 0, 1);
    const eventCoverage = clamp(reverbEvents.length / 6, 0, 1);
    const analysisConfidence = clamp(eventCoverage * 0.65 + speechCoverage * 0.35, 0, 1);
    const drynessScore = clamp(1 - roomScore - noiseIndicator * 0.15, 0, 1);

    let instabilityScore = 0;
    if (speechDbSeries.length >= 12) {
      const jumpDeltas: number[] = [];
      for (let i = 1; i < speechDbSeries.length; i += 1) {
        jumpDeltas.push(Math.abs(speechDbSeries[i] - speechDbSeries[i - 1]));
      }
      const jumpP85 = percentile(jumpDeltas, 85) ?? 0;
      const jumpP95 = percentile(jumpDeltas, 95) ?? 0;
      instabilityScore = clamp(
        clamp((jumpP85 - 1.7) / 3.8, 0, 1) * 0.65 + clamp((jumpP95 - 2.7) / 5.4, 0, 1) * 0.35,
        0,
        1
      );
      instabilityScore = clamp(instabilityScore * clamp(0.8 + speechCoverage * 0.2, 0.8, 1), 0, 1);
    }

    let nonSpeechFrames = 0;
    let clickFrames = 0;
    for (let i = 0; i < frameCount; i += 1) {
      const crestDb = toDb((framePeak[i] + 1e-9) / (frameRms[i] + 1e-9));
      const peakDb = Math.max(ENVELOPE_FLOOR_DB, toDb(framePeak[i] + 1e-12));
      if (!speechMask[i]) {
        nonSpeechFrames += 1;
        if (crestDb > 20 && peakDb > -20) {
          clickFrames += 1;
        }
      } else if (crestDb > 25 && peakDb > -13) {
        // Catch harsh transients that ride on speech, but keep weighting lower.
        clickFrames += 0.5;
      }
    }
    const clickDensity = clickFrames / Math.max(nonSpeechFrames, 1);
    const clickScore = clamp(clickDensity * 3.2, 0, 1);

    return {
      noiseFloorDb,
      nearSpeechNoiseFloorDb,
      speechThresholdDb,
      reverbScore,
      echoScore,
      roomScore,
      echoDelayMs: bestEchoLagFrames > 0 ? bestEchoLagFrames * ENVELOPE_FRAME_MS : null,
      analysisConfidence,
      drynessScore,
      instabilityScore,
      clickScore,
    };
  };

  const runEnvelopeAnalysis = async (ffmpeg: FFmpeg, inputName: string) => {
    const analysisName = `${sanitizeBase(inputName)}_envelope_analysis.f32`;
    try {
      resetLogBuffer();
      await execOrThrow(
        ffmpeg,
        [
          "-hide_banner",
          "-nostdin",
          "-threads",
          "1",
          "-y",
          "-i",
          inputName,
          "-t",
          `${ANALYSIS_SAMPLE_SECONDS}`,
          "-ac",
          "1",
          "-ar",
          `${ANALYSIS_SAMPLE_RATE}`,
          "-c:a",
          "pcm_f32le",
          "-f",
          "f32le",
          analysisName,
        ],
        "Envelope analysis render"
      );

      const bytes = await readVirtualFileBytes(ffmpeg, analysisName);
      const samples = toFloatSamples(bytes);
      return computeEnvelopeMetrics(samples);
    } finally {
      await safeDeleteFile(ffmpeg, analysisName);
    }
  };

  const analyzeFile = async (ffmpeg: FFmpeg, inputName: string): Promise<FileAnalysis> => {
    const analysis = createEmptyAnalysis();

    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-i",
        inputName,
        "-t",
        `${ANALYSIS_SAMPLE_SECONDS}`,
        "-af",
        "loudnorm=I=-24:TP=-2:LRA=7:print_format=json",
        "-f",
        "null",
        "-",
      ],
      "Smart match loudness analysis"
    );

    const loudData = parseLoudnormJson(resetLogBuffer());
    analysis.inputI = parseMaybeNumber(loudData?.input_i);
    analysis.inputLRA = parseMaybeNumber(loudData?.input_lra);
    analysis.inputTP = parseMaybeNumber(loudData?.input_tp);
    analysis.inputThresh = parseMaybeNumber(loudData?.input_thresh);

    analysis.lowRms = await runRmsAnalysis(ffmpeg, inputName, "highpass=f=50,lowpass=f=220");
    analysis.midRms = await runRmsAnalysis(ffmpeg, inputName, "highpass=f=300,lowpass=f=2400");
    analysis.highRms = await runRmsAnalysis(ffmpeg, inputName, "highpass=f=2800,lowpass=f=9000");

    try {
      const envelope = await runEnvelopeAnalysis(ffmpeg, inputName);
      analysis.noiseFloorDb = envelope.noiseFloorDb;
      analysis.nearSpeechNoiseFloorDb = envelope.nearSpeechNoiseFloorDb;
      analysis.speechThresholdDb = envelope.speechThresholdDb;
      analysis.reverbScore = envelope.reverbScore;
      analysis.echoScore = envelope.echoScore;
      analysis.roomScore = envelope.roomScore;
      analysis.echoDelayMs = envelope.echoDelayMs;
      analysis.analysisConfidence = envelope.analysisConfidence;
      analysis.drynessScore = envelope.drynessScore;
      analysis.instabilityScore = envelope.instabilityScore;
      analysis.clickScore = envelope.clickScore;
    } catch (error) {
      appendLog(
        `[Analysis] Envelope fallback (${inputName}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    return analysis;
  };

  const buildBatchReference = (analyses: FileAnalysis[]) => {
    const lowTilts: number[] = [];
    const highTilts: number[] = [];
    const lras: number[] = [];

    for (const analysis of analyses) {
      if (analysis.lowRms !== null && analysis.midRms !== null) {
        lowTilts.push(analysis.lowRms - analysis.midRms);
      }
      if (analysis.highRms !== null && analysis.midRms !== null) {
        highTilts.push(analysis.highRms - analysis.midRms);
      }
      if (analysis.inputLRA !== null) {
        lras.push(analysis.inputLRA);
      }
    }

    const lowTilt = robustMedian(lowTilts);
    const highTilt = robustMedian(highTilts);
    const lra = robustMedian(lras);

    if (lowTilt === null && highTilt === null && lra === null) return null;

    return {
      lowTilt: lowTilt ?? -11,
      highTilt: highTilt ?? -13,
      lra: lra ?? 6,
    } satisfies BatchReference;
  };

  const buildAdaptiveProfile = (analysis: FileAnalysis | undefined, reference: BatchReference | null) => {
    const needsAdaptiveProfile =
      smartMatchConfig.tone > 0 || smartMatchConfig.dynamics > 0 || roomCleanup || sceneBlend;
    if (!needsAdaptiveProfile || !analysis) return null;

    const smartToneEnabled = smartMatchConfig.tone > 0;
    const smartDynamicsEnabled = smartMatchConfig.dynamics > 0;

    const referenceLowTilt = reference?.lowTilt ?? -11;
    const referenceHighTilt = reference?.highTilt ?? -13;
    const referenceLra = reference?.lra ?? 6;

    const lowTilt =
      analysis.lowRms !== null && analysis.midRms !== null
        ? analysis.lowRms - analysis.midRms
        : referenceLowTilt;
    const highTilt =
      analysis.highRms !== null && analysis.midRms !== null
        ? analysis.highRms - analysis.midRms
        : referenceHighTilt;
    const lowTiltDiff = lowTilt - referenceLowTilt;
    const highTiltDiff = highTilt - referenceHighTilt;

    const toneFactor = smartToneEnabled ? smartMatchConfig.tone : 0;
    const dynamicsFactor = smartDynamicsEnabled ? smartMatchConfig.dynamics : 0;

    const highpassHz = Math.round(clamp(80 + lowTiltDiff * 2.2 * toneFactor, 65, 105));
    const lowMidGainDb = clamp(-2 - lowTiltDiff * 0.28 * toneFactor, -3.6, 1.2);

    let presenceGainDb = clamp(-highTiltDiff * 0.45 * toneFactor, -2.2, 1.8);
    let airGainDb = clamp(-highTiltDiff * 0.25 * toneFactor, -1.4, 1.0);

    const lra = analysis.inputLRA ?? referenceLra;
    const lraDiff = lra - referenceLra;
    const compressorRatioOffset = clamp(lraDiff * 0.07 * dynamicsFactor, -0.35, 0.45);
    const compressorThresholdOffsetDb = clamp(lraDiff * 0.6 * dynamicsFactor, -1.5, 1.5);

    const measuredNoiseFloor = Math.max(analysis.noiseFloorDb ?? -70, analysis.nearSpeechNoiseFloorDb ?? -90);
    const measuredSpeechThreshold =
      analysis.speechThresholdDb ?? clamp(measuredNoiseFloor + 10.5, -58, -26);
    let noiseRisk: NoiseRisk = "low";
    if (analysis.noiseFloorDb !== null || analysis.nearSpeechNoiseFloorDb !== null) {
      noiseRisk = measuredNoiseFloor > -52 ? "high" : measuredNoiseFloor > -62 ? "medium" : "low";
    } else if (analysis.inputThresh !== null) {
      // Only use loudnorm threshold when envelope analysis is unavailable.
      noiseRisk = analysis.inputThresh > -33 ? "high" : analysis.inputThresh > -38 ? "medium" : "low";
    }
    if (noiseRisk === "low" && measuredSpeechThreshold > -44) {
      noiseRisk = "medium";
    }
    if (noiseRisk === "medium" && measuredSpeechThreshold > -40) {
      noiseRisk = "high";
    }

    const inputTP = analysis.inputTP ?? -9;
    const hotPeakFactor = clamp((inputTP + 9) / 7, 0, 1);
    const brightFactor = clamp((highTiltDiff + 1.8) / 4.5, 0, 1);
    const dynamicFactor = clamp((lra - 5.5) / 7, 0, 1);
    const emotionProtection = clamp(
      (hotPeakFactor * 0.48 + dynamicFactor * 0.4) * dynamicsFactor,
      0,
      0.82
    );
    const levelingNeed = clamp(
      (dynamicFactor * 0.72 + Math.max(0, lraDiff) / 8) * dynamicsFactor,
      0,
      1
    );
    const emotionalHarshnessCutDb = clamp(
      (hotPeakFactor * 0.95 + brightFactor * 0.7) * toneFactor,
      0,
      1.6
    );
    const topEndHarshnessCutDb = clamp(emotionalHarshnessCutDb * 0.75, 0, 1.2);

    const analysisConfidence = analysis.analysisConfidence ?? 0.25;
    const rawRoomScore = analysis.roomScore ?? 0;
    const confidenceScaledRoom = rawRoomScore * clamp(0.75 + analysisConfidence * 0.25, 0.75, 1);
    let roomRisk = classifyRoomRisk(confidenceScaledRoom);
    if (analysisConfidence < 0.35) {
      roomRisk = downgradeRoomRisk(roomRisk);
    }

    if (noiseRisk !== "low" || roomRisk !== "low") {
      const positiveTrim =
        roomRisk === "high" ? 0.2 : roomRisk === "medium" ? 0.45 : noiseRisk === "high" ? 0.35 : 0.7;
      if (presenceGainDb > 0) presenceGainDb *= positiveTrim;
      if (airGainDb > 0) airGainDb *= positiveTrim;
    }

    const echoScore = analysis.echoScore ?? 0;
    const roomCleanupEnabled =
      roomCleanup && (analysisConfidence >= 0.4 || echoScore >= 0.58 || roomRisk !== "low");
    const useDenoise = false;
    const instabilityScore = clamp(analysis.instabilityScore ?? 0, 0, 1);
    const clickScore = clamp(analysis.clickScore ?? 0, 0, 1);
    const preserveSentenceEndings = noiseRisk === "low" && instabilityScore >= 0.62 && echoScore < 0.92;
    const forceTailGateForEcho =
      roomCleanupEnabled && roomRisk === "high" && echoScore >= 0.62 && !preserveSentenceEndings;
    const useTailGate =
      roomCleanupEnabled &&
      !preserveSentenceEndings &&
      (forceTailGateForEcho ||
        (analysisConfidence >= 0.52 && (roomRisk === "high" || (roomRisk === "medium" && echoScore >= 0.5))));
    const denoiseStrength = 0;
    const tailGateStrength = !useTailGate
      ? 0
      : roomRisk === "high"
        ? clamp(0.09 + echoScore * 0.1 + analysisConfidence * 0.06, 0.09, 0.22)
        : clamp(0.06 + echoScore * 0.08, 0.06, 0.14);
    const echoNotchCutDb = roomCleanupEnabled
      ? clamp(
          echoScore * (roomRisk === "high" ? 1.02 : roomRisk === "medium" ? 0.68 : 0.42) +
            (roomRisk === "high" ? 0.12 : 0),
          0,
          1.45
        )
      : 0;

    const baseDynaTrim = noiseGuard ? (noiseRisk === "high" ? 3 : noiseRisk === "medium" ? 2 : 0) : 0;
    const roomDynaTrim = roomRisk === "high" ? 1.4 : roomRisk === "medium" ? 0.7 : 0;
    const instabilityAssist =
      instabilityScore * (noiseRisk === "low" ? 0.9 : noiseRisk === "medium" ? 0.4 : 0.15);
    const dynaTrim = Math.max(0, baseDynaTrim + roomDynaTrim - instabilityAssist);
    const clickTameStrength = clamp(
      clickScore * (noiseRisk === "high" ? 1 : noiseRisk === "medium" ? 0.88 : 0.78) * 0.72,
      0,
      1
    );

    const dryness = analysis.drynessScore ?? clamp(1 - confidenceScaledRoom, 0, 1);
    const blendRiskDamp = roomRisk === "high" ? 0.03 : roomRisk === "medium" ? 0.2 : 1;
    const blendEchoDamp = clamp(1 - echoScore * 0.85, 0.08, 1);
    const blendNoiseDamp = noiseRisk === "high" ? 0.22 : noiseRisk === "medium" ? 0.55 : 1;
    const blendInstabilityDamp = instabilityScore >= 0.7 ? 0.65 : 1;
    const blendConfidenceScale = clamp(0.35 + analysisConfidence * 0.65, 0.35, 1);
    const blendBase = clamp(0.022 + dryness * 0.022, 0.016, 0.045);
    let blendAmount = sceneBlend
      ? blendBase * blendRiskDamp * blendConfidenceScale * blendEchoDamp * blendNoiseDamp * blendInstabilityDamp
      : 0;
    if (roomRisk === "high" || echoScore >= 0.72) {
      blendAmount = Math.min(blendAmount, 0.0018);
    }
    const blendIndoorGain = clamp(blendAmount * 0.62, 0, 0.07);
    const blendOutdoorGain = clamp(blendAmount * 0.42, 0, 0.055);
    const blendIndoorDelayMs = Math.round(clamp(24 + (1 - dryness) * 8, 22, 36));
    const blendOutdoorDelayMs = Math.round(clamp(52 + (1 - dryness) * 18, 48, 74));

    return {
      highpassHz,
      lowMidGainDb,
      presenceGainDb,
      airGainDb,
      emotionalHarshnessCutDb,
      topEndHarshnessCutDb,
      levelingNeed,
      emotionProtection,
      compressorRatioOffset,
      compressorThresholdOffsetDb,
      dynaTrim,
      floorGuardFilter: noiseRisk === "high" ? FLOOR_GUARD_STRONG : FLOOR_GUARD,
      noiseRisk,
      noiseFloorDb: measuredNoiseFloor,
      speechThresholdDb: measuredSpeechThreshold,
      roomRisk,
      useDenoise,
      denoiseStrength,
      useTailGate,
      tailGateStrength,
      echoNotchCutDb,
      instabilityScore,
      clickScore,
      clickTameStrength,
      blendIndoorGain,
      blendOutdoorGain,
      blendIndoorDelayMs,
      blendOutdoorDelayMs,
    } satisfies AdaptiveProfile;
  };

  const buildTailGateFilter = (strength: number) => {
    const thresholdDb = clamp(-58 + strength * 3.4, -58, -54.5);
    const threshold = fromDb(thresholdDb);
    const ratio = clamp(1.01 + strength * 0.5, 1.01, 1.22);
    const range = clamp(0.9 - strength * 0.16, 0.72, 0.9);
    const attack = Math.round(clamp(24 - strength * 6, 18, 26));
    const release = Math.round(clamp(760 - strength * 160, 520, 760));
    const makeup = 1;
    return `agate=mode=downward:threshold=${threshold.toFixed(5)}:ratio=${ratio.toFixed(
      2
    )}:range=${range.toFixed(3)}:attack=${attack}:release=${release}:makeup=${makeup.toFixed(
      2
    )}:detection=rms:link=average`;
  };

  const buildClickTamerFilter = (strength: number) => {
    const attack = Math.round(clamp(2 + strength * 4, 2, 6));
    const release = Math.round(clamp(20 + strength * 30, 20, 52));
    const limit = clamp(-3.6 + strength * 0.7, -3.6, -2.8);
    return `alimiter=limit=${limit.toFixed(
      1
    )}dB:attack=${attack}:release=${release}:level=disabled`;
  };

  const buildAdaptiveNoiseReductionFilter = (noiseRisk: NoiseRisk, noiseFloorDb: number | null) => {
    if (noiseRisk === "low") return null;

    const estimatedFloor = noiseFloorDb ?? (noiseRisk === "high" ? -49 : -55);
    const severeNoise = noiseRisk === "high" && estimatedFloor > -46;

    // Use spectral denoise in-browser for stability and voice-preserving behavior.
    const nf = severeNoise
      ? clamp(estimatedFloor + 3.2, -46, -34)
      : noiseRisk === "high"
        ? clamp(estimatedFloor + 4.5, -50, -37)
        : clamp(estimatedFloor + 5.2, -56, -40);
    const nr = severeNoise ? 12 : noiseRisk === "high" ? 10 : 7;
    const ad = severeNoise ? 0.55 : noiseRisk === "high" ? 0.42 : 0.32;
    const gs = severeNoise ? 12 : noiseRisk === "high" ? 10 : 8;
    return `afftdn=nf=${nf.toFixed(1)}:nr=${nr}:tn=1:ad=${ad.toFixed(2)}:gs=${gs}`;
  };

  type MixRenderOptions = {
    disableRoomCleanup?: boolean;
    disableAdaptiveNoiseReduction?: boolean;
    minimalStabilityChain?: boolean;
    disableLimiter?: boolean;
  };

  const resolveAdaptiveNoiseReductionFilter = (
    profile: AdaptiveProfile | null,
    options?: MixRenderOptions
  ) => {
    if (!noiseGuard || !profile) return null;
    if (options?.minimalStabilityChain || options?.disableAdaptiveNoiseReduction) return null;
    return buildAdaptiveNoiseReductionFilter(profile.noiseRisk, profile.noiseFloorDb);
  };

  const buildMixFilter = (profile: AdaptiveProfile | null, options?: MixRenderOptions) => {
    const filters: string[] = [];
    const levelerSettings = LEVELER_PRESETS[leveler];
    const consistency = LEVELER_CONSISTENCY[leveler];
    const dyn = levelerSettings.dyna;
    const minimalStabilityChain = options?.minimalStabilityChain === true;
    const roomCleanupEnabled = roomCleanup && !options?.disableRoomCleanup && !minimalStabilityChain;
    const adaptiveNoiseReductionFilter = resolveAdaptiveNoiseReductionFilter(profile, options);
    const useAdaptiveNoiseReduction = adaptiveNoiseReductionFilter !== null;
    const instabilityScore = profile?.instabilityScore ?? 0;
    const clickTameStrength = profile?.clickTameStrength ?? 0;
    const useClickTamer = !minimalStabilityChain && clickTameStrength >= 0.46;

    if (eqCleanup) {
      const highpassHz = profile?.highpassHz ?? 80;
      const lowMidGainDb = profile?.lowMidGainDb ?? -2;
      filters.push(`highpass=f=${highpassHz}`);
      filters.push(`equalizer=f=250:width_type=q:width=1.0:g=${lowMidGainDb.toFixed(2)}`);
      if (useAdaptiveNoiseReduction && adaptiveNoiseReductionFilter) {
        // Run denoise before dynamic stages so levelers do not lift room bed/hiss.
        filters.push(adaptiveNoiseReductionFilter);
      }
    }
    if (!eqCleanup && useAdaptiveNoiseReduction && adaptiveNoiseReductionFilter) {
      filters.push(adaptiveNoiseReductionFilter);
    }
    if (useClickTamer) {
      filters.push(buildClickTamerFilter(clickTameStrength));
    }

    if (dyn) {
      let dynaF: number = dyn.f;
      let dynaG: number = noiseGuard ? Math.max(3, dyn.g - 1) : dyn.g;
      let dynaM: number = noiseGuard ? Math.max(3, dyn.m - 1) : dyn.m;
      let dynaThresholdAmp = 0;

      if (!minimalStabilityChain) {
        if (profile) {
          const adaptiveLift = profile.levelingNeed * 1.8;
          const emotionRelax = profile.emotionProtection * 1.2;
          dynaG = Math.max(3, dynaG + adaptiveLift - profile.dynaTrim - emotionRelax);
          dynaM = Math.max(3, dynaM + adaptiveLift - profile.dynaTrim - emotionRelax);

          if (profile.instabilityScore >= 0.35) {
            if (profile.noiseRisk === "low") {
              // Unstable but clean takes need faster ride response, not a wider/slow window.
              const instabilityNorm = clamp((profile.instabilityScore - 0.35) / 0.65, 0, 1);
              dynaF = Math.round(clamp(dynaF - instabilityNorm * 80, 161, 261));
              dynaG += profile.instabilityScore * 1.8;
              dynaM += profile.instabilityScore * 1.4;
              if (noiseGuard && profile.noiseRisk !== "low") {
                const gateDb = clamp((profile.speechThresholdDb ?? -46) - 8.5, -58, -44);
                dynaThresholdAmp = Math.max(dynaThresholdAmp, fromDb(gateDb));
              }
            } else {
              dynaF = Math.max(dynaF, Math.round(261 + profile.instabilityScore * 90));
            }
          }

          // Noisy takes need slower and lower lift to avoid raising room noise in pauses.
          if (noiseGuard) {
            if (profile.noiseRisk === "high" || (profile.noiseFloorDb ?? -70) > -46) {
              dynaF = Math.max(dynaF, 281);
              dynaG = Math.min(dynaG, 3);
              dynaM = Math.min(dynaM, 3);
              const gateDb = clamp((profile.noiseFloorDb ?? -46) + 7.2, -54, -34);
              dynaThresholdAmp = fromDb(gateDb);
            } else if (profile.noiseRisk === "medium" || (profile.noiseFloorDb ?? -70) > -52) {
              dynaF = Math.max(dynaF, 241);
              dynaG = Math.min(dynaG, 4);
              dynaM = Math.min(dynaM, 5);
              const gateDb = clamp((profile.noiseFloorDb ?? -50) + 6.0, -56, -36);
              dynaThresholdAmp = fromDb(gateDb);
            }
          }

          if (profile.instabilityScore >= 0.62 && profile.noiseRisk !== "high") {
            const instabilityNorm = clamp((profile.instabilityScore - 0.62) / 0.38, 0, 1);
            dynaF = Math.round(clamp(dynaF - instabilityNorm * 48, 201, 261));
            dynaG = Math.min(7.5, dynaG + instabilityNorm * 1.2);
            dynaM = Math.min(9.5, dynaM + instabilityNorm * 1.0);
            if (noiseGuard && profile.noiseRisk !== "low") {
              const speechGateDb = clamp((profile.speechThresholdDb ?? -46) - 8.2, -58, -43);
              dynaThresholdAmp = Math.max(dynaThresholdAmp, fromDb(speechGateDb));
            }
          }
        }
      } else {
        // Stability-safe fallback keeps mandatory leveler but removes adaptive modifiers.
        dynaF = dyn.f;
        dynaG = dyn.g;
        dynaM = dyn.m;
      }

      const dynaGInt = toOddInt(dynaG, 3, 301);
      const dynaMValue = toOddInt(dynaM, 3, 301);
      const dynaThreshold =
        dynaThresholdAmp > 0 ? `:t=${clamp(dynaThresholdAmp, fromDb(-60), fromDb(-36)).toFixed(5)}` : "";
      filters.push(`dynaudnorm=f=${dynaF}:g=${dynaGInt}:m=${dynaMValue}${dynaThreshold}`);
    }

    const breath = BREATH_COMPAND[breathControl];
    const roomGateFilter =
      roomCleanupEnabled && (profile?.useTailGate ?? false)
        ? buildTailGateFilter(profile?.tailGateStrength ?? 0.12)
        : null;
    const useRoomGate = roomGateFilter !== null;
    const preferFloorGuard =
      floorGuard &&
      (profile?.noiseRisk === "high" || (noiseGuard && profile?.noiseRisk === "medium"));
    const useFloorGuard = !useRoomGate && floorGuard && (breath === null || preferFloorGuard);
    const useBreathCompand = !useRoomGate && breath !== null && !useFloorGuard;

    if (!minimalStabilityChain && useRoomGate && roomGateFilter) {
      filters.push(roomGateFilter);
    }
    if (!minimalStabilityChain && useBreathCompand) {
      filters.push(breath);
    }
    if (!minimalStabilityChain && useFloorGuard) {
      filters.push(profile?.floorGuardFilter ?? FLOOR_GUARD);
    }

    // Merge static harshness softening with smart-match tone offsets to avoid
    // competing EQ moves on the same bands.
    const basePresenceCut = softenHarshness ? -2.0 : 0;
    const baseAirCut = softenHarshness ? -1.1 : 0;
    const harshPresenceCut = profile?.emotionalHarshnessCutDb ?? 0;
    const harshAirCut = profile?.topEndHarshnessCutDb ?? 0;
    const netPresenceGain = clamp(
      basePresenceCut + (profile?.presenceGainDb ?? 0) - harshPresenceCut,
      -4.0,
      0.7
    );
    const netAirGain = clamp(baseAirCut + (profile?.airGainDb ?? 0) - harshAirCut, -2.7, 0.45);

    if (!minimalStabilityChain && Math.abs(netPresenceGain) >= 0.2) {
      filters.push(`equalizer=f=3500:width_type=q:width=1.15:g=${netPresenceGain.toFixed(2)}`);
    }
    if (!minimalStabilityChain && Math.abs(netAirGain) >= 0.2) {
      filters.push(`equalizer=f=8000:width_type=q:width=0.75:g=${netAirGain.toFixed(2)}`);
    }
    if (!minimalStabilityChain && (profile?.topEndHarshnessCutDb ?? 0) >= 0.45) {
      const topShelfCut = clamp(-0.35 - (profile?.topEndHarshnessCutDb ?? 0) * 0.55, -1.1, -0.35);
      filters.push(`equalizer=f=11200:width_type=q:width=0.7:g=${topShelfCut.toFixed(2)}`);
    }
    if (!minimalStabilityChain && roomCleanupEnabled && (profile?.echoNotchCutDb ?? 0) >= 0.25) {
      const echoCut = clamp(profile?.echoNotchCutDb ?? 0, 0.25, 1.25);
      const notch1 = -clamp(echoCut, 0.25, 1.25);
      filters.push(`equalizer=f=2450:width_type=q:width=1.35:g=${notch1.toFixed(2)}`);
      if (echoCut >= 0.55) {
        const notch2 = -clamp(echoCut * 0.62, 0.3, 0.9);
        filters.push(`equalizer=f=1280:width_type=q:width=1.0:g=${notch2.toFixed(2)}`);
      }
      if (echoCut >= 0.9) {
        const notch3 = -clamp(echoCut * 0.45, 0.25, 0.7);
        filters.push(`equalizer=f=3620:width_type=q:width=1.6:g=${notch3.toFixed(2)}`);
      }
    }
    if (!minimalStabilityChain && roomCleanupEnabled && profile?.roomRisk === "high") {
      const roomCutFactor = clamp((profile?.echoNotchCutDb ?? 0.6) / 1.45, 0.25, 1);
      const roomCutLow = -clamp(0.45 + roomCutFactor * 0.55, 0.45, 1.05);
      const roomCutMid = -clamp(0.35 + roomCutFactor * 0.65, 0.35, 1.15);
      filters.push(`equalizer=f=460:width_type=q:width=0.95:g=${roomCutLow.toFixed(2)}`);
      filters.push(`equalizer=f=1650:width_type=q:width=1.2:g=${roomCutMid.toFixed(2)}`);
      if ((profile?.echoNotchCutDb ?? 0) >= 0.95) {
        const roomCutUpperMid = -clamp(0.25 + roomCutFactor * 0.45, 0.25, 0.8);
        filters.push(`equalizer=f=2850:width_type=q:width=1.5:g=${roomCutUpperMid.toFixed(2)}`);
      }
    }

    const thresholdBase = parseFloat(levelerSettings.compressor.threshold.replace("dB", ""));
    const ratioBase = parseFloat(levelerSettings.compressor.ratio);

    let thresholdAdjust = minimalStabilityChain ? 0 : (profile?.compressorThresholdOffsetDb ?? 0);
    let ratioAdjust = minimalStabilityChain ? 0 : (profile?.compressorRatioOffset ?? 0);
    const levelingNeed = minimalStabilityChain ? 0 : (profile?.levelingNeed ?? 0);
    const emotionProtection = minimalStabilityChain ? 0 : (profile?.emotionProtection ?? 0);

    // Keep upstream processors from sounding overcontrolled.
    if (dyn) {
      thresholdAdjust += 0.25;
      ratioAdjust -= 0.08;
    }
    if (useBreathCompand || useFloorGuard) {
      thresholdAdjust += 0.15;
      ratioAdjust -= 0.05;
    }
    if (useRoomGate) {
      thresholdAdjust += 0.22;
      ratioAdjust -= 0.08;
    }
    if (profile?.roomRisk === "high") {
      thresholdAdjust += 0.6;
      ratioAdjust -= 0.24;
    } else if (profile?.roomRisk === "medium") {
      thresholdAdjust += 0.32;
      ratioAdjust -= 0.13;
    }
    const echoPressure = clamp((profile?.echoNotchCutDb ?? 0) / 1.25, 0, 1);
    thresholdAdjust += echoPressure * 0.25;
    ratioAdjust -= echoPressure * 0.12;
    const instabilityCompressorRelax =
      instabilityScore * (profile?.noiseRisk === "high" ? 0.9 : profile?.noiseRisk === "medium" ? 0.75 : 0.65);
    thresholdAdjust += instabilityCompressorRelax * 0.9;
    ratioAdjust -= instabilityCompressorRelax * 0.35;

    // Smarter consistency: tighten when needed, but protect emotional peaks.
    const thresholdTighten = consistency * (0.55 + levelingNeed * 0.75);
    const threshold = clamp(
      thresholdBase + thresholdAdjust - thresholdTighten + emotionProtection * 0.65,
      -32.5,
      -17.2
    );
    const ratio = clamp(
      ratioBase + ratioAdjust + consistency * 0.22 + levelingNeed * 0.3 - emotionProtection * 0.35,
      1.55,
      3.0
    );
    const roomRelax = profile?.roomRisk === "high" ? 1 : profile?.roomRisk === "medium" ? 0.45 : 0;
    const attack = Math.round(
      clamp(
        24 -
          consistency * 8 +
          emotionProtection * 8 +
          roomRelax * 4 +
          echoPressure * 2 +
          instabilityCompressorRelax * 3,
        14,
        36
      )
    );
    const release = Math.round(
      clamp(
        170 -
          consistency * 45 +
          emotionProtection * 75 +
          roomRelax * 40 +
          echoPressure * 30 +
          instabilityCompressorRelax * 55,
        95,
        320
      )
    );
    const compMix = clamp(
      0.9 +
        levelingNeed * 0.07 -
        emotionProtection * 0.24 -
        roomRelax * 0.08 -
        echoPressure * 0.04 -
        instabilityCompressorRelax * 0.12,
      0.58,
      0.95
    );

    filters.push(
      `acompressor=threshold=${threshold.toFixed(1)}dB:ratio=${ratio.toFixed(2)}:attack=${attack}:release=${release}:mix=${compMix.toFixed(2)}:detection=rms`
    );
    if (!options?.disableLimiter) {
      filters.push(LIMITER_FILTER);
    }

    return filters.join(",");
  };

  const buildBlendFilter = (profile: AdaptiveProfile | null) => {
    const indoorGain = profile?.blendIndoorGain ?? 0.015;
    const outdoorGain = profile?.blendOutdoorGain ?? 0.01;
    const indoorDelay = Math.round(profile?.blendIndoorDelayMs ?? 28);
    const outdoorDelay = Math.round(profile?.blendOutdoorDelayMs ?? 58);

    const wetTotal = indoorGain + outdoorGain;
    const dryGain = clamp(1 - wetTotal * 0.55, 0.93, 1);
    const wetGateThreshold = clamp(0.00045 + wetTotal * 0.028, 0.00055, 0.0024);
    const wetGateRatio = clamp(1.16 + wetTotal * 8, 1.16, 1.34);
    const wetGateRange = clamp(0.86 - wetTotal * 2.6, 0.68, 0.86);

    return [
      "asplit=3[dry][ind_src][out_src]",
      `[ind_src]adelay=${indoorDelay}:all=1,highpass=f=280,lowpass=f=4600,volume=${indoorGain.toFixed(
        4
      )}[ind]`,
      `[out_src]adelay=${outdoorDelay}:all=1,highpass=f=220,lowpass=f=3000,volume=${outdoorGain.toFixed(
        4
      )}[out]`,
      `[ind][out]amix=inputs=2:normalize=0,agate=mode=downward:threshold=${wetGateThreshold.toFixed(
        5
      )}:ratio=${wetGateRatio.toFixed(2)}:range=${wetGateRange.toFixed(
        3
      )}:attack=10:release=180:makeup=1.00:detection=rms:link=average[wet]`,
      `[dry]volume=${dryGain.toFixed(4)}[dryv]`,
      "[dryv][wet]amix=inputs=2:normalize=0,alimiter=limit=-2dB:level=disabled",
    ].join(";");
  };

  const writeOutput = async (
    ffmpeg: FFmpeg,
    name: string,
    kind: OutputEntry["kind"],
    variant: OutputEntry["variant"]
  ): Promise<OutputEntry> => {
    const bytes = await readVirtualFileBytes(ffmpeg, name);
    const blob = new Blob([bytes], { type: "audio/wav" });
    return {
      name,
      url: URL.createObjectURL(blob),
      size: blob.size,
      kind,
      variant,
    };
  };

  const runMixReady = async (
    ffmpeg: FFmpeg,
    inputName: string,
    outputName: string,
    profile: AdaptiveProfile | null,
    options?: MixRenderOptions
  ) => {
    const filterChain = buildMixFilter(profile, options);
    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-y",
        "-i",
        inputName,
        "-af",
        filterChain,
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_f32le",
        outputName,
      ],
      "Mix-ready render"
    );
  };

  const runMixReadySplitAdaptiveNr = async (
    ffmpeg: FFmpeg,
    inputName: string,
    outputName: string,
    profile: AdaptiveProfile | null,
    options?: MixRenderOptions
  ) => {
    const adaptiveNoiseReductionFilter = resolveAdaptiveNoiseReductionFilter(profile, options);
    if (!adaptiveNoiseReductionFilter) {
      throw new Error("Split adaptive-NR path unavailable.");
    }

    const preNrFilterChain = buildMixFilter(profile, {
      ...options,
      disableAdaptiveNoiseReduction: true,
      disableLimiter: true,
    });
    const postNrFilterChain = `${adaptiveNoiseReductionFilter},${LIMITER_FILTER}`;
    const tempName = `${sanitizeBase(outputName)}_pre_nr.wav`;

    try {
      resetLogBuffer();
      await execOrThrow(
        ffmpeg,
        [
          "-hide_banner",
          "-nostdin",
          "-threads",
          "1",
          "-filter_threads",
          "1",
          "-y",
          "-i",
          inputName,
          "-af",
          preNrFilterChain,
          "-ar",
          "48000",
          "-ac",
          "1",
          "-c:a",
          "pcm_f32le",
          tempName,
        ],
        "Mix-ready pre-NR render"
      );

      resetLogBuffer();
      await execOrThrow(
        ffmpeg,
        [
          "-hide_banner",
          "-nostdin",
          "-threads",
          "1",
          "-filter_threads",
          "1",
          "-y",
          "-i",
          tempName,
          "-af",
          postNrFilterChain,
          "-ar",
          "48000",
          "-ac",
          "1",
          "-c:a",
          "pcm_f32le",
          outputName,
        ],
        "Mix-ready adaptive-NR compatibility render"
      );
    } finally {
      await safeDeleteFile(ffmpeg, tempName);
    }
  };

  const probeInputDurationSeconds = async (ffmpeg: FFmpeg, inputName: string) => {
    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        inputName,
        "-t",
        "0.1",
        "-f",
        "null",
        "-",
      ],
      "Duration probe"
    );
    const logText = resetLogBuffer();
    return parseDurationSeconds(logText);
  };

  const runMixReadySegmented = async (
    ffmpeg: FFmpeg,
    inputName: string,
    outputName: string,
    profile: AdaptiveProfile | null,
    durationSeconds: number,
    options?: MixRenderOptions
  ) => {
    if (durationSeconds < MIX_SEGMENT_MIN_DURATION_SECONDS) {
      throw new Error("Segmented render skipped (input too short).");
    }
    const segmentCount = Math.ceil(durationSeconds / MIX_SEGMENT_SECONDS);
    if (segmentCount < 2) {
      throw new Error("Segmented render skipped (single segment).");
    }

    const filterChain = buildMixFilter(profile, options);
    const tempBase = sanitizeBase(outputName);
    const segmentNames: string[] = [];
    const concatListName = `${tempBase}_segments.txt`;

    try {
      for (let index = 0; index < segmentCount; index += 1) {
        const start = index * MIX_SEGMENT_SECONDS;
        const remaining = durationSeconds - start;
        const span = Math.min(MIX_SEGMENT_SECONDS, Math.max(remaining, 0));
        if (span <= 0.01) break;
        const segmentName = `${tempBase}_seg_${index + 1}.wav`;
        segmentNames.push(segmentName);

        resetLogBuffer();
        await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-y",
        "-ss",
        start.toFixed(3),
            "-t",
            span.toFixed(3),
            "-i",
            inputName,
            "-af",
            filterChain,
            "-ar",
            "48000",
            "-ac",
            "1",
            "-c:a",
            "pcm_f32le",
            segmentName,
          ],
          `Segment mix-ready render ${index + 1}/${segmentCount}`
        );
      }

      if (segmentNames.length < 2) {
        throw new Error("Segmented render produced insufficient segments.");
      }

      const concatList = `${segmentNames.map((name) => `file '${name}'`).join("\n")}\n`;
      await ffmpeg.writeFile(concatListName, new TextEncoder().encode(concatList));

      resetLogBuffer();
      await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-y",
        "-f",
        "concat",
          "-safe",
          "0",
          "-i",
          concatListName,
          "-c",
          "copy",
          outputName,
        ],
        "Segment concat render"
      );
    } finally {
      await safeDeleteFile(ffmpeg, concatListName);
      for (const segmentName of segmentNames) {
        await safeDeleteFile(ffmpeg, segmentName);
      }
    }
  };

  const runBlendMixReady = async (
    ffmpeg: FFmpeg,
    inputName: string,
    outputName: string,
    profile: AdaptiveProfile | null
  ) => {
    const filterChain = buildBlendFilter(profile);
    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-y",
        "-i",
        inputName,
        "-af",
        filterChain,
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_f32le",
        outputName,
      ],
      "Blend mix-ready render"
    );
  };

  const runOnePassLoudnorm = async (
    ffmpeg: FFmpeg,
    inputName: string,
    outputName: string,
    cfg: NonNullable<(typeof LOUDNESS_PRESETS)[keyof typeof LOUDNESS_PRESETS]>
  ) => {
    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-y",
        "-i",
        inputName,
        "-af",
        `loudnorm=I=${cfg.I}:TP=${cfg.TP}:LRA=${cfg.LRA}:print_format=summary`,
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_f32le",
        outputName,
      ],
      "One-pass loudnorm"
    );
  };

  const runLoudnorm = async (
    ffmpeg: FFmpeg,
    inputName: string,
    outputName: string,
    cfg: NonNullable<(typeof LOUDNESS_PRESETS)[keyof typeof LOUDNESS_PRESETS]>
  ) => {
    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-i",
        inputName,
        "-af",
        `loudnorm=I=${cfg.I}:TP=${cfg.TP}:LRA=${cfg.LRA}:print_format=json`,
        "-f",
        "null",
        "-",
      ],
      "Loudnorm analysis"
    );

    const logText = resetLogBuffer();
    const data = parseLoudnormJson(logText);

    const measuredI = parseMaybeNumber(data?.input_i);
    const measuredTP = parseMaybeNumber(data?.input_tp);
    const measuredLRA = parseMaybeNumber(data?.input_lra);
    const measuredThresh = parseMaybeNumber(data?.input_thresh);
    const offset = parseMaybeNumber(data?.target_offset);

    if (
      measuredI === null ||
      measuredTP === null ||
      measuredLRA === null ||
      measuredThresh === null ||
      offset === null
    ) {
      appendLog("Loudnorm pass1 failed; using one-pass loudnorm.");
      await runOnePassLoudnorm(ffmpeg, inputName, outputName, cfg);
      return;
    }

    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-y",
        "-i",
        inputName,
        "-af",
        `loudnorm=I=${cfg.I}:TP=${cfg.TP}:LRA=${cfg.LRA}:measured_I=${measuredI}:measured_TP=${measuredTP}:measured_LRA=${measuredLRA}:measured_thresh=${measuredThresh}:offset=${offset}:linear=true:print_format=summary`,
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_f32le",
        outputName,
      ],
      "Loudnorm render"
    );
  };

  const safeDeleteFile = async (ffmpeg: FFmpeg, name: string) => {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      // Ignore cleanup failures from missing temp files.
    }
  };

  const buildJobs = (inputFiles: File[]) => {
    const seen = new Map<string, number>();
    return inputFiles.map((file, index) => {
      const baseRaw = sanitizeBase(file.name) || `input_${index + 1}`;
      const count = seen.get(baseRaw) ?? 0;
      seen.set(baseRaw, count + 1);
      const base = count === 0 ? baseRaw : `${baseRaw}_${count + 1}`;
      return {
        file,
        base,
        inputName: `${base}_input.wav`,
        mixName: `${base}_mixready.wav`,
        blendMixName: `${base}_blend_mixready.wav`,
      } satisfies JobEntry;
    });
  };

  const writeJobInput = async (ffmpeg: FFmpeg, job: JobEntry) => {
    // Use a fresh buffer every write; FFmpeg worker postMessage can detach transferred ArrayBuffers.
    await ffmpeg.writeFile(job.inputName, await fetchFile(job.file));
  };

  const processFiles = async () => {
    if (!files.length) return;
    setLoading(true);
    setOutputs([]);
    setLogs([]);
    setFailedOptimizations([]);
    setShowFailureWarning(false);
    setStatus("Preparing...");

    try {
      let ffmpeg = await ensureFfmpeg();
      const outputEntries: OutputEntry[] = [];
      const jobs = buildJobs(files);
      const analysisByBase = new Map<string, FileAnalysis>();
      let batchReference: BatchReference | null = null;
      const smartMatchEnabled = smartMatchConfig.tone > 0 || smartMatchConfig.dynamics > 0;
      const needsAnalysis = smartMatchEnabled || roomCleanup || sceneBlend;

      if (needsAnalysis) {
        appendLog(`Deep analysis started for ${jobs.length} file(s) (up to ${ANALYSIS_SAMPLE_SECONDS}s each).`);
        const analyses: FileAnalysis[] = [];
        for (let i = 0; i < jobs.length; i += 1) {
          const job = jobs[i];
          setStatus(`Analyze: ${job.base} (${i + 1}/${jobs.length})`);
          try {
            await writeJobInput(ffmpeg, job);
            const analysis = await analyzeFile(ffmpeg, job.inputName);
            analysisByBase.set(job.base, analysis);
            analyses.push(analysis);
          } catch (error) {
            appendLog(
              `Analysis fallback (${job.base}): ${error instanceof Error ? error.message : String(error)}`
            );
            const fallback = createEmptyAnalysis();
            analysisByBase.set(job.base, fallback);
            analyses.push(fallback);
            if (shouldResetFfmpegForError(error)) {
              ffmpeg = await refreshFfmpeg(`analysis failure on ${job.base}`);
            }
          } finally {
            await safeDeleteFile(ffmpeg, job.inputName);
          }

          if (shouldRecycleFfmpegForBatch(i + 1, jobs.length)) {
            ffmpeg = await refreshFfmpeg(`analysis memory guard (${i + 1}/${jobs.length})`);
          }
        }

        if (smartMatchEnabled) {
          batchReference = buildBatchReference(analyses);
          if (batchReference) {
            appendLog(
              `Reference tone low/mid ${batchReference.lowTilt.toFixed(1)} dB, high/mid ${batchReference.highTilt.toFixed(1)} dB, LRA ${batchReference.lra.toFixed(1)}.`
            );
          } else {
            appendLog("Reference analysis unavailable; using base processing chain.");
          }
        }
      }

      let hadErrors = false;
      const failedRuns: FailedOptimization[] = [];
      for (let i = 0; i < jobs.length; i += 1) {
        const job = jobs[i];
        let cleanLoudName: string | null = null;
        let blendLoudName: string | null = null;
        let blendRendered = false;

        try {
          await writeJobInput(ffmpeg, job);
          const profile = buildAdaptiveProfile(analysisByBase.get(job.base), batchReference);
          const roomScore = profile ? (analysisByBase.get(job.base)?.roomScore ?? 0) : null;
          const adaptiveNoiseReductionFilter = profile ? resolveAdaptiveNoiseReductionFilter(profile) : null;
          const adaptiveNoiseReductionLabel =
            adaptiveNoiseReductionFilter === null
              ? "off"
              : adaptiveNoiseReductionFilter.trim().toLowerCase().startsWith("afftdn=")
                ? "on(spectral)"
                : "on(wavelet)";

          if (profile) {
            appendLog(
              `[Adaptive] ${job.base}: HPF ${profile.highpassHz} Hz, low-mid ${formatSigned(
                profile.lowMidGainDb
              )} dB, presence ${formatSigned(profile.presenceGainDb)} dB, room ${profile.roomRisk} (${(
                roomScore ?? 0
              ).toFixed(2)}), noise ${profile.noiseRisk} (${(profile.noiseFloorDb ?? -70).toFixed(
                1
              )} dB; adaptive-NR ${adaptiveNoiseReductionLabel}), instability ${(
                profile.instabilityScore * 100
              ).toFixed(0)}%, clicks ${(profile.clickScore * 100).toFixed(0)}%, conf ${(
                analysisByBase.get(job.base)?.analysisConfidence ?? 0
              ).toFixed(2)}, tail-gate ${profile.useTailGate ? "on" : "off"}, echo ${
                analysisByBase.get(job.base)?.echoDelayMs ?? 0
              } ms, blend ${
                (profile.blendIndoorGain * 100).toFixed(1)
              }/${(profile.blendOutdoorGain * 100).toFixed(1)}%.`
            );
          }

          const hasRoomFilters = roomCleanup && !!profile && (profile.useTailGate || profile.echoNotchCutDb >= 0.25);
          const hasAdaptiveNoiseReduction = noiseGuard && !!profile && profile.noiseRisk !== "low";

          setStatus(`Mix-ready: ${job.base} (${i + 1}/${jobs.length})`);
          const fallbackStrategies: Array<{ label: string; options?: MixRenderOptions }> = [
            { label: "primary chain" },
          ];
          if (hasRoomFilters) {
            fallbackStrategies.push({
              label: "room cleanup bypass",
              options: { disableRoomCleanup: true },
            });
          }
          if (hasAdaptiveNoiseReduction) {
            fallbackStrategies.push({
              label: "adaptive-NR bypass",
              options: { disableAdaptiveNoiseReduction: true },
            });
          }
          if (hasRoomFilters && hasAdaptiveNoiseReduction) {
            fallbackStrategies.push({
              label: "room cleanup + adaptive-NR bypass",
              options: { disableRoomCleanup: true, disableAdaptiveNoiseReduction: true },
            });
          }
          fallbackStrategies.push({
            label: "stability-safe chain",
            options: {
              disableRoomCleanup: true,
              disableAdaptiveNoiseReduction: true,
              minimalStabilityChain: true,
            },
          });

          let mixRendered = false;
          let fallbackApplied: string | null = null;
          let lastMixError: unknown = null;
          let inputDurationSeconds: number | null | undefined = undefined;

          const ensureInputDuration = async () => {
            if (inputDurationSeconds !== undefined) return inputDurationSeconds;
            try {
              inputDurationSeconds = await probeInputDurationSeconds(ffmpeg, job.inputName);
            } catch {
              inputDurationSeconds = null;
            }
            return inputDurationSeconds;
          };

          for (let strategyIndex = 0; strategyIndex < fallbackStrategies.length; strategyIndex += 1) {
            const strategy = fallbackStrategies[strategyIndex];
            try {
              await runMixReady(ffmpeg, job.inputName, job.mixName, profile, strategy.options);
              mixRendered = true;
              fallbackApplied = strategyIndex === 0 ? null : strategy.label;
              break;
            } catch (error) {
              lastMixError = error;
              const strategyFailureMessage = describeError(error);
              if (shouldResetFfmpegForError(error)) {
                ffmpeg = await refreshFfmpeg(`mix fallback on ${job.base}`);
                await writeJobInput(ffmpeg, job);
              }

              const adaptiveNoiseReductionFilter = resolveAdaptiveNoiseReductionFilter(profile, strategy.options);
              const canRunSplitAdaptiveNr =
                adaptiveNoiseReductionFilter !== null &&
                adaptiveNoiseReductionFilter.trim().toLowerCase().startsWith("afwtdn=");
              if (canRunSplitAdaptiveNr) {
                try {
                  appendLog(
                    `[MixFallback] ${job.base}: ${strategy.label} failed (${strategyFailureMessage}), trying ${strategy.label} with adaptive-NR compatibility split.`
                  );
                  await runMixReadySplitAdaptiveNr(
                    ffmpeg,
                    job.inputName,
                    job.mixName,
                    profile,
                    strategy.options
                  );
                  mixRendered = true;
                  fallbackApplied =
                    strategyIndex === 0
                      ? "primary chain (adaptive-NR compatibility)"
                      : `${strategy.label} (adaptive-NR compatibility)`;
                  break;
                } catch (splitError) {
                  lastMixError = splitError;
                  if (shouldResetFfmpegForError(splitError)) {
                    ffmpeg = await refreshFfmpeg(`adaptive-NR compatibility fallback on ${job.base}`);
                    await writeJobInput(ffmpeg, job);
                  }
                }
              }

              const durationSeconds = await ensureInputDuration();
              const canRunSegmented =
                durationSeconds !== null && durationSeconds >= MIX_SEGMENT_MIN_DURATION_SECONDS;

              if (canRunSegmented && durationSeconds !== null) {
                try {
                  appendLog(
                    `[MixFallback] ${job.base}: ${strategy.label} failed (${strategyFailureMessage}), trying segmented ${strategy.label}.`
                  );
                  await runMixReadySegmented(
                    ffmpeg,
                    job.inputName,
                    job.mixName,
                    profile,
                    durationSeconds,
                    strategy.options
                  );
                  mixRendered = true;
                  fallbackApplied =
                    strategyIndex === 0 ? "primary chain (segmented)" : `${strategy.label} (segmented)`;
                  break;
                } catch (segmentedError) {
                  lastMixError = segmentedError;
                  if (shouldResetFfmpegForError(segmentedError)) {
                    ffmpeg = await refreshFfmpeg(`segmented mix fallback on ${job.base}`);
                    await writeJobInput(ffmpeg, job);
                  }
                }
              }

              const hasMoreStrategies = strategyIndex < fallbackStrategies.length - 1;
              if (hasMoreStrategies) {
                const finalFailureMessage = describeError(lastMixError);
                appendLog(
                  `[MixFallback] ${job.base}: ${strategy.label} failed (${finalFailureMessage}), trying ${fallbackStrategies[
                    strategyIndex + 1
                  ]?.label}.`
                );
              }
            }
          }

          if (!mixRendered) {
            throw lastMixError ?? new Error("Mix-ready render failed.");
          }
          if (fallbackApplied) {
            appendLog(`[MixFallback] ${job.base}: rendered with ${fallbackApplied}.`);
          }

          const mixOutput = await writeOutput(ffmpeg, job.mixName, "mixready", "clean");
          if (keepMixReady || loudnessConfig === null) {
            outputEntries.push(mixOutput);
          }

          if (sceneBlend) {
            const indoorGain = profile?.blendIndoorGain ?? 0;
            const outdoorGain = profile?.blendOutdoorGain ?? 0;
            if (indoorGain + outdoorGain <= 0.0001) {
              appendLog(`[Blend] ${job.base}: bypassed (adaptive blend gain near zero for room/noise safety).`);
            } else {
              try {
                setStatus(`Blend: ${job.base} (${i + 1}/${jobs.length})`);
                await runBlendMixReady(ffmpeg, job.mixName, job.blendMixName, profile);
                const blendMixOutput = await writeOutput(ffmpeg, job.blendMixName, "mixready", "blend");
                blendRendered = true;
                if (keepMixReady || loudnessConfig === null) {
                  outputEntries.push(blendMixOutput);
                }
              } catch (error) {
                appendLog(
                  `[Blend] ${job.base}: bypassed (${error instanceof Error ? error.message : String(error)})`
                );
              }
            }
          }

          if (loudnessConfig) {
            cleanLoudName = `${job.base}_${loudnessConfig.suffix}.wav`;
            setStatus(`Loudness clean: ${job.base} (${i + 1}/${jobs.length})`);
            await runLoudnorm(ffmpeg, job.mixName, cleanLoudName, loudnessConfig);
            const loudOutput = await writeOutput(ffmpeg, cleanLoudName, "loudness", "clean");
            outputEntries.push(loudOutput);

            if (sceneBlend && blendRendered) {
              blendLoudName = `${job.base}_blend_${loudnessConfig.suffix}.wav`;
              setStatus(`Loudness blend: ${job.base} (${i + 1}/${jobs.length})`);
              await runLoudnorm(ffmpeg, job.blendMixName, blendLoudName, loudnessConfig);
              const blendLoudOutput = await writeOutput(ffmpeg, blendLoudName, "loudness", "blend");
              outputEntries.push(blendLoudOutput);
            }
          }
        } catch (error) {
          hadErrors = true;
          const reason = summarizeFailureReason(error);
          failedRuns.push({
            base: job.base,
            fileName: job.file.name,
            reason,
          });
          appendLog(`Error (${job.base}): ${reason}`);
          if (shouldResetFfmpegForError(error)) {
            ffmpeg = await refreshFfmpeg(`processing failure on ${job.base}`);
          }
        } finally {
          await safeDeleteFile(ffmpeg, job.inputName);
          await safeDeleteFile(ffmpeg, job.mixName);
          await safeDeleteFile(ffmpeg, job.blendMixName);
          if (cleanLoudName) {
            await safeDeleteFile(ffmpeg, cleanLoudName);
          }
          if (blendLoudName) {
            await safeDeleteFile(ffmpeg, blendLoudName);
          }
        }

        if (shouldRecycleFfmpegForBatch(i + 1, jobs.length)) {
          ffmpeg = await refreshFfmpeg(`processing memory guard (${i + 1}/${jobs.length})`);
        }
      }

      setOutputs(outputEntries);
      if (failedRuns.length > 0) {
        setFailedOptimizations(failedRuns);
        setShowFailureWarning(true);
        appendLog(
          `[Warning] ${failedRuns.length} file(s) failed to optimize. Re-submit only the failed files and run again.`
        );
      }
      setStatus(hadErrors ? "Done with warnings" : "Done");
    } catch (err) {
      appendLog(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setStatus("Failed");
    } finally {
      setLoading(false);
    }
  };

  const handleFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const wavs = Array.from(incoming).filter((file) => file.name.toLowerCase().endsWith(".wav"));
    setFiles((prev) => {
      const merged = [...prev];
      const seen = new Set(prev.map((file) => `${file.name}|${file.size}|${file.lastModified}`));
      for (const file of wavs) {
        const key = `${file.name}|${file.size}|${file.lastModified}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(file);
        }
      }
      return merged;
    });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    handleFiles(event.dataTransfer.files);
  };

  const downloadOutputsZip = async () => {
    if (outputs.length === 0 || zipBusy) return;

    setZipBusy(true);
    setZipProgress(0);

    try {
      const zip = new JSZip();

      for (let i = 0; i < outputs.length; i += 1) {
        const output = outputs[i];
        const response = await fetch(output.url);
        const blob = await response.blob();
        zip.file(output.name, blob);
        setZipProgress(Math.round(((i + 1) / outputs.length) * 70));
      }

      const zipBlob = await zip.generateAsync(
        {
          type: "blob",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        },
        ({ percent }) => {
          setZipProgress(70 + Math.round((percent / 100) * 30));
        }
      );

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archiveName = `vo_leveler_outputs_${stamp}.zip`;
      const zipUrl = URL.createObjectURL(zipBlob);
      const link = document.createElement("a");
      link.href = zipUrl;
      link.download = archiveName;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(zipUrl), 30_000);
      appendLog(`ZIP created: ${archiveName} (${formatBytes(zipBlob.size)})`);
    } catch (error) {
      appendLog(`ZIP export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setZipBusy(false);
      setZipProgress(0);
    }
  };

  return (
    <div className={styles.layout}>
      <div className={styles.panel}>
        <div className={styles.card}>
          <div
            className={`${styles.dropzone} ${dragActive ? styles.dropActive : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
          >
            <div className={styles.dropTitle}>Drop WAV files or pick a folder</div>
            <div className={styles.dropHint}>
              Processing runs locally in the browser. Files never leave this machine.
            </div>
            <div className={styles.dropHint}>New drops are added to the current queue.</div>
            <div className={styles.controls}>
              <label className={styles.button}>
                Select Files
                <input
                  type="file"
                  accept=".wav"
                  multiple
                  hidden
                  onChange={(event) => {
                    handleFiles(event.target.files);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <label className={`${styles.button} ${styles.buttonSecondary}`}>
                Select Folder
                <input
                  type="file"
                  accept=".wav"
                  multiple
                  hidden
                  // @ts-expect-error webkitdirectory is supported in Chromium-based browsers.
                  webkitdirectory="true"
                  directory="true"
                  onChange={(event) => {
                    handleFiles(event.target.files);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
            <div className={styles.fileList}>
              {files.length === 0 && <div className={styles.dropHint}>No files selected.</div>}
              {files.map((file, index) => (
                <div className={styles.fileItem} key={`${file.name}-${file.lastModified}-${index}`}>
                  <div>{file.name}</div>
                  <span>{formatBytes(file.size)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.optionGrid}>
            <div className={styles.field}>
              <label className={styles.label}>Loudness target</label>
              <select
                className={styles.select}
                value={loudnessTarget}
                onChange={(event) => setLoudnessTarget(event.target.value as keyof typeof LOUDNESS_PRESETS)}
              >
                {Object.keys(LOUDNESS_PRESETS).map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Smart voice match</label>
              <select
                className={styles.select}
                value={smartMatchMode}
                onChange={(event) =>
                  setSmartMatchMode(event.target.value as keyof typeof SMART_MATCH_PRESETS)
                }
              >
                {Object.keys(SMART_MATCH_PRESETS).map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Leveling strength</label>
              <select
                className={styles.select}
                value={leveler}
                onChange={(event) => setLeveler(event.target.value as keyof typeof LEVELER_PRESETS)}
              >
                {Object.keys(LEVELER_PRESETS).map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
              <div className={styles.label}>
                Balances consistency while keeping performance peaks.
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Breath control</label>
              <select
                className={styles.select}
                value={breathControl}
                onChange={(event) => setBreathControl(event.target.value as keyof typeof BREATH_COMPAND)}
              >
                {Object.keys(BREATH_COMPAND).map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.toggleRow}>
            <div>
              <strong>EQ cleanup</strong>
              <div className={styles.label}>HPF + small low-mid shaping for consistency</div>
            </div>
            <input
              type="checkbox"
              checked={eqCleanup}
              onChange={(event) => setEqCleanup(event.target.checked)}
            />
          </div>
          <div className={styles.toggleRow}>
            <div>
              <strong>Soften harshness</strong>
              <div className={styles.label}>
                Cinematic softening for bright/emotional lines (3.5 kHz + 8 kHz + gentle top-end trim)
              </div>
            </div>
            <input
              type="checkbox"
              checked={softenHarshness}
              onChange={(event) => setSoftenHarshness(event.target.checked)}
            />
          </div>
          <div className={styles.toggleRow}>
            <div>
              <strong>Room cleanup (auto detect)</strong>
              <div className={styles.label}>
                Reduces mild room echo/reverb only when needed.
              </div>
            </div>
            <input
              type="checkbox"
              checked={roomCleanup}
              onChange={(event) => setRoomCleanup(event.target.checked)}
            />
          </div>
          <div className={styles.toggleRow}>
            <div>
              <strong>Scene blend (adaptive subtle)</strong>
              <div className={styles.label}>
                Adds very light mono early reflections so VO sits in-picture without sounding processed.
              </div>
            </div>
            <input
              type="checkbox"
              checked={sceneBlend}
              onChange={(event) => setSceneBlend(event.target.checked)}
            />
          </div>
          <div className={styles.toggleRow}>
            <div>
              <strong>Noise guard</strong>
              <div className={styles.label}>Limits auto-leveler gain to avoid noise lift</div>
            </div>
            <input
              type="checkbox"
              checked={noiseGuard}
              onChange={(event) => setNoiseGuard(event.target.checked)}
            />
          </div>
          <div className={styles.toggleRow}>
            <div>
              <strong>Floor guard</strong>
              <div className={styles.label}>
                Keeps near-silence quiet; auto-prioritized over breath control on noisy tracks
              </div>
            </div>
            <input
              type="checkbox"
              checked={floorGuard}
              onChange={(event) => setFloorGuard(event.target.checked)}
            />
          </div>
          <div className={styles.toggleRow}>
            <div>
              <strong>Keep mix-ready file</strong>
              <div className={styles.label}>Store _mixready.wav alongside loudness exports</div>
            </div>
            <input
              type="checkbox"
              checked={keepMixReady}
              onChange={(event) => setKeepMixReady(event.target.checked)}
              disabled={loudnessConfig === null}
            />
          </div>

          <div className={`${styles.controls} ${styles.sectionTop}`}>
            <button className={styles.button} onClick={processFiles} disabled={loading || files.length === 0}>
              {loading ? "Processing..." : "Run Batch"}
            </button>
            <button
              className={`${styles.button} ${styles.buttonGhost}`}
              onClick={() => {
                setFiles([]);
                setOutputs([]);
                setLogs([]);
                setFailedOptimizations([]);
                setShowFailureWarning(false);
                setStatus("Idle");
              }}
              disabled={loading}
            >
              Clear
            </button>
            <div className={styles.progress}>{status}</div>
          </div>

          <div className={styles.footerNote}>
            Processing order is tuned to avoid processor clashes.
          </div>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.card}>
          <h3>Outputs</h3>
          {outputs.length > 0 && (
            <div className={`${styles.controls} ${styles.sectionTop}`}>
              <button
                className={`${styles.button} ${styles.buttonSecondary}`}
                onClick={downloadOutputsZip}
                disabled={zipBusy}
              >
                {zipBusy ? `Building ZIP ${zipProgress}%` : `Download ZIP (${outputs.length})`}
              </button>
            </div>
          )}
          <div className={`${styles.outputList} ${styles.sectionTop}`}>
            {outputs.length === 0 && <div className={styles.dropHint}>No output yet.</div>}
            {outputs.map((output, index) => (
              <div className={styles.outputItem} key={`${output.name}-${output.size}-${index}`}>
                <div>
                  <strong>{output.name}</strong>
                  <div className={styles.label}>{formatBytes(output.size)}</div>
                  <div className={styles.outputMeta}>
                    <span className={styles.outputBadge}>
                      {output.variant === "blend" ? "Blend pass" : "Clean pass"}
                    </span>
                    {output.kind === "mixready" ? (
                      <>
                        <span className={styles.outputBadge}>Mix-ready</span>
                        <span
                          className={styles.outputHint}
                          title={
                            output.variant === "blend"
                              ? "Blend mix-ready: subtle scene glue applied; not loudness-normalized."
                              : "Mix-ready: processed and leveled, but not loudness-normalized. Best for film mix stems."
                          }
                        >
                          What&apos;s this?
                        </span>
                      </>
                    ) : (
                      <>
                        <span className={styles.outputBadge}>Broadcast loudness</span>
                        <span
                          className={styles.outputHint}
                          title={
                            output.variant === "blend"
                              ? "Broadcast loudness + blend: subtle scene glue plus ATSC A/85 or EBU R128 normalization."
                              : "Broadcast loudness: normalized to ATSC A/85 or EBU R128. Use for delivery or QC."
                          }
                        >
                          What&apos;s this?
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <a href={output.url} download={output.name}>
                  Download
                </a>
              </div>
            ))}
          </div>
        </div>
        <div className={styles.card}>
          <h3>Processing Log</h3>
          <div className={`${styles.log} ${styles.sectionTop}`}>
            {logs.length === 0 ? "No logs yet." : logs.join("\n")}
          </div>
          <div className={styles.footerNote}>
            If processing feels slow, run a smaller batch or disable extra features.
          </div>
        </div>
      </div>
      {showFailureWarning && failedOptimizations.length > 0 && (
        <div className={styles.warningOverlay} role="alertdialog" aria-modal="true" aria-labelledby="failed-title">
          <div className={styles.warningCard}>
            <h3 id="failed-title">Some files need re-submission</h3>
            <p className={styles.warningText}>
              Some audio files failed to optimize on this run. Please re-submit only these files and run again.
            </p>
            <div className={styles.warningList}>
              {failedOptimizations.map((item, index) => (
                <div className={styles.warningItem} key={`${item.base}-${index}`}>
                  <strong>{item.fileName}</strong>
                  <span>{item.reason}</span>
                </div>
              ))}
            </div>
            <div className={styles.warningActions}>
              <button className={styles.button} onClick={() => setShowFailureWarning(false)}>
                Understood
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
