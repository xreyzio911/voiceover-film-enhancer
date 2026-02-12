"use client";

import { useMemo, useState, type DragEvent } from "react";
import styles from "./QcReportLab.module.css";

const FRAME_MS = 10;

type QcReport = {
  fileName: string;
  fileSize: number;
  status: "ok" | "warning" | "error";
  overallRisk: number;
  durationSec: number;
  sampleRate: number;
  peakDb: number;
  clipPct: number;
  noiseFloorDb: number;
  pauseNoiseFloorDb: number;
  noiseContrastDb: number;
  speechRatioPct: number;
  dynamicRangeDb: number;
  instabilityScore: number;
  compressionScore: number;
  clickScore: number;
  echoScore: number;
  flags: string[];
  recommendations: string[];
  error?: string;
};

type QcComparison = {
  key: string;
  before: QcReport;
  after: QcReport;
  deltaRisk: number;
  deltaInstability: number;
  deltaCompression: number;
  deltaNoiseFloor: number;
  deltaNoiseContrast: number;
  deltaClick: number;
  deltaEcho: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

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

const mean = (values: number[]) => {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const toDb = (value: number) => {
  if (value <= 0) return -120;
  return 20 * Math.log10(value);
};

const formatBytes = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const step = 1024;
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(step)), units.length - 1);
  return `${(bytes / step ** exp).toFixed(1)} ${units[exp]}`;
};

const normalizeComparisonKey = (fileName: string) => {
  let stem = fileName.replace(/\.[^/.]+$/, "").toLowerCase();
  stem = stem.replace(/\s+/g, "_");
  stem = stem.replace(/[^\w-]+/g, "_");
  stem = stem.replace(/_+/g, "_");
  stem = stem.replace(/^_+|_+$/g, "");
  stem = stem.replace(/_blend_mixready$/, "");
  stem = stem.replace(/_mixready$/, "");
  stem = stem.replace(/_(?:blend_)?(?:a85|r128)$/, "");
  stem = stem.replace(/^before_/, "");
  stem = stem.replace(/^after_/, "");
  return stem;
};

const guessRole = (fileName: string) => {
  const lowered = fileName.toLowerCase();
  if (/(^|[_\s-])(after|optimized|processed)([_\s-]|$)/.test(lowered)) return "after";
  if (/(^|[_\s-])(before|original|raw)([_\s-]|$)/.test(lowered)) return "before";
  if (/(_blend_)?(a85|r128)\.wav$/i.test(lowered) || /_mixready\.wav$/i.test(lowered)) return "after";
  return "unknown";
};

const buildComparisons = (reports: QcReport[]) => {
  const byKey = new Map<string, QcReport[]>();
  for (const report of reports) {
    if (report.status === "error") continue;
    const key = normalizeComparisonKey(report.fileName);
    const list = byKey.get(key) ?? [];
    list.push(report);
    byKey.set(key, list);
  }

  const comparisons: QcComparison[] = [];
  for (const [key, group] of byKey.entries()) {
    if (group.length < 2) continue;
    const beforeCandidates = group.filter((report) => guessRole(report.fileName) !== "after");
    const afterCandidates = group.filter((report) => guessRole(report.fileName) === "after");
    if (beforeCandidates.length === 0 || afterCandidates.length === 0) continue;

    const before =
      [...beforeCandidates].sort((a, b) => a.fileName.length - b.fileName.length || a.fileName.localeCompare(b.fileName))[0];
    const after =
      [...afterCandidates].sort((a, b) => a.fileName.length - b.fileName.length || a.fileName.localeCompare(b.fileName))[0];

    if (!before || !after) continue;

    comparisons.push({
      key,
      before,
      after,
      deltaRisk: after.overallRisk - before.overallRisk,
      deltaInstability: after.instabilityScore - before.instabilityScore,
      deltaCompression: after.compressionScore - before.compressionScore,
      deltaNoiseFloor: after.pauseNoiseFloorDb - before.pauseNoiseFloorDb,
      deltaNoiseContrast: after.noiseContrastDb - before.noiseContrastDb,
      deltaClick: after.clickScore - before.clickScore,
      deltaEcho: after.echoScore - before.echoScore,
    });
  }

  return comparisons.sort((a, b) => b.before.overallRisk - a.before.overallRisk);
};

const formatSignedPercent = (value: number) => `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`;
const formatSignedDb = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)} dB`;

const decodeToMono = async (file: File, audioContext: AudioContext) => {
  const buffer = await file.arrayBuffer();
  const decoded = await audioContext.decodeAudioData(buffer.slice(0));
  const channels = decoded.numberOfChannels;
  const length = decoded.length;
  const mono = new Float32Array(length);

  for (let channel = 0; channel < channels; channel += 1) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      mono[i] += data[i] / channels;
    }
  }

  let peak = 0;
  let clipCount = 0;
  for (let i = 0; i < mono.length; i += 1) {
    const abs = Math.abs(mono[i]);
    if (abs > peak) peak = abs;
    if (abs >= 0.995) clipCount += 1;
  }

  return {
    samples: mono,
    sampleRate: decoded.sampleRate,
    durationSec: decoded.duration,
    peakDb: toDb(peak + 1e-12),
    clipPct: (clipCount / Math.max(mono.length, 1)) * 100,
  };
};

const buildFlagsAndRecommendations = (report: QcReport) => {
  const flags: string[] = [];
  const recommendations: string[] = [];

  const noiseLiftRisk = clamp((report.pauseNoiseFloorDb + 62) / 18, 0, 1) * 0.45 + clamp((24 - report.noiseContrastDb) / 16, 0, 1) * 0.55;
  if (noiseLiftRisk >= 0.45) {
    flags.push("Noise uplift risk in pauses.");
    recommendations.push("Use stricter noise-lift guard and verify pause regions after leveling.");
  }

  if (report.instabilityScore >= 0.5) {
    flags.push("Large voice-level jumps detected.");
    recommendations.push("Use instability-safe leveling (slower gain riding, less compression mix).");
  }

  if (report.compressionScore >= 0.52) {
    flags.push("Compressed or radio-like tone risk.");
    recommendations.push("Relax compressor ratio/mix and preserve more transient dynamics.");
  }

  if (report.clickScore >= 0.2) {
    flags.push("Click/transient artifacts detected.");
    recommendations.push("Run click-taming cleanup and recheck consonant spikes.");
  }

  if (report.echoScore >= 0.38) {
    flags.push("Echo/reverb tail risk detected.");
    recommendations.push("Keep room cleanup on and verify tail control + notch behavior.");
  }

  if (report.clipPct >= 0.02) {
    flags.push("Potential clipped peaks in source.");
    recommendations.push("Ask for cleaner source if clipped peaks are audible.");
  }

  if (flags.length === 0) {
    flags.push("No major QC risk detected.");
    recommendations.push("Source looks stable for standard optimization.");
  }

  return { flags, recommendations };
};

const analyzeSamples = (
  fileName: string,
  fileSize: number,
  samples: Float32Array,
  sampleRate: number,
  durationSec: number,
  peakDb: number,
  clipPct: number
): QcReport => {
  const frameSize = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const frameCount = Math.floor(samples.length / frameSize);
  if (frameCount < 30) {
    return {
      fileName,
      fileSize,
      status: "error",
      overallRisk: 0,
      durationSec,
      sampleRate,
      peakDb,
      clipPct,
      noiseFloorDb: -120,
      pauseNoiseFloorDb: -120,
      noiseContrastDb: 0,
      speechRatioPct: 0,
      dynamicRangeDb: 0,
      instabilityScore: 0,
      compressionScore: 0,
      clickScore: 0,
      echoScore: 0,
      flags: [],
      recommendations: [],
      error: "Audio is too short for reliable QC analysis.",
    };
  }

  const frameRms = new Array<number>(frameCount);
  const frameDb = new Array<number>(frameCount);
  const framePeak = new Array<number>(frameCount);
  const frameSharpness = new Array<number>(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSize;
    let sumSquares = 0;
    let peak = 0;
    let sharpEnergy = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const value = samples[start + i] ?? 0;
      const abs = Math.abs(value);
      if (abs > peak) peak = abs;
      sumSquares += value * value;
      const prev = i > 0 ? samples[start + i - 1] ?? 0 : value;
      const next = i + 1 < frameSize ? samples[start + i + 1] ?? 0 : value;
      const spike = value - (prev + next) * 0.5;
      sharpEnergy += spike * spike;
    }
    const rms = Math.sqrt(sumSquares / frameSize);
    frameRms[frame] = rms;
    framePeak[frame] = peak;
    frameDb[frame] = Math.max(-120, toDb(rms + 1e-12));
    frameSharpness[frame] = toDb(Math.sqrt(sharpEnergy / frameSize) + 1e-12);
  }

  const baseNoiseFloorDb = percentile(frameDb, 25) ?? -72;
  const speechThresholdDb = clamp(baseNoiseFloorDb + 10.5, -58, -24);
  const speechMask = frameDb.map((db) => db > speechThresholdDb);

  const speechDb: number[] = [];
  const pauseDb: number[] = [];
  const speechCrest: number[] = [];
  let nonSpeechFrames = 0;
  let clickFrames = 0;
  let sampleSpikeCount = 0;
  const refractorySamples = Math.max(1, Math.round(sampleRate * 0.004));
  let lastSpikeIndex = -refractorySamples;

  for (let i = 1; i < samples.length; i += 1) {
    const diff = Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0));
    if (diff < 0.09) continue;
    if (Math.abs(samples[i] ?? 0) < 0.015) continue;
    if (i - lastSpikeIndex < refractorySamples) continue;
    sampleSpikeCount += 1;
    lastSpikeIndex = i;
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    const crestDb = toDb((framePeak[frame] + 1e-9) / (frameRms[frame] + 1e-9));
    const peakFrameDb = toDb(framePeak[frame] + 1e-12);
    if (speechMask[frame]) {
      speechDb.push(frameDb[frame]);
      speechCrest.push(crestDb);
      if ((crestDb > 20.5 && peakFrameDb > -18) || frameSharpness[frame] > -29) {
        clickFrames += 0.5;
      }
    } else {
      nonSpeechFrames += 1;
      pauseDb.push(frameDb[frame]);
      if ((crestDb > 15 && peakFrameDb > -30) || frameSharpness[frame] > -32) {
        clickFrames += 1;
      }
    }
  }

  const pauseNoiseFloorDb = clamp(
    percentile(pauseDb.length > 10 ? pauseDb : frameDb, 70) ?? -72,
    -110,
    -28
  );
  const noiseFloorDb = pauseNoiseFloorDb;
  const speechRatioPct = (speechDb.length / Math.max(frameCount, 1)) * 100;
  const p90Speech = percentile(speechDb, 90) ?? -24;
  const p10Speech = percentile(speechDb, 10) ?? p90Speech;
  const p50Speech = percentile(speechDb, 50) ?? p90Speech;
  const dynamicRangeDb = Math.max(0, p90Speech - p10Speech);
  const pauseP80 = percentile(pauseDb, 80) ?? pauseNoiseFloorDb;
  const noiseContrastDb = clamp(p50Speech - pauseP80, 0, 80);

  let instabilityScore = 0;
  if (speechDb.length >= 12) {
    const smoothSpeech = speechDb.map((value, idx) => {
      const a = speechDb[idx - 1] ?? value;
      const b = value;
      const c = speechDb[idx + 1] ?? value;
      return (a + b + c) / 3;
    });
    const deltas: number[] = [];
    for (let i = 1; i < smoothSpeech.length; i += 1) {
      deltas.push(Math.abs(smoothSpeech[i] - smoothSpeech[i - 1]));
    }
    const p80 = percentile(deltas, 80) ?? 0;
    const p95 = percentile(deltas, 95) ?? 0;
    instabilityScore = clamp(
      clamp((p80 - 1.2) / 3.1, 0, 1) * 0.62 + clamp((p95 - 2.2) / 4.6, 0, 1) * 0.38,
      0,
      1
    );
  }

  const centered = frameRms.map((value) => value - mean(frameRms));
  let bestCorr = 0;
  for (let lag = 4; lag <= 20; lag += 1) {
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
    if (corr > bestCorr) bestCorr = corr;
  }
  const autoCorrEcho = clamp((bestCorr - 0.22) / 0.22, 0, 1);

  const tailEventScores: number[] = [];
  let speechRun = 0;
  for (let frame = 0; frame < frameCount - 30; frame += 1) {
    if (speechMask[frame]) {
      speechRun += 1;
      continue;
    }
    if (speechRun >= 6) {
      const early = mean(frameRms.slice(frame + 1, frame + 8));
      const late = mean(frameRms.slice(frame + 14, frame + 28));
      const pauseFloorAmp = Math.pow(10, pauseNoiseFloorDb / 20);
      const lateLiftDb = toDb((late + 1e-9) / (pauseFloorAmp + 1e-9));
      const decayDb = toDb((early + 1e-9) / (late + 1e-9));
      const eventScore = clamp(
        clamp((lateLiftDb - 3.5) / 10.5, 0, 1) * 0.58 + clamp((5.5 - decayDb) / 5.5, 0, 1) * 0.42,
        0,
        1
      );
      tailEventScores.push(eventScore);
    }
    speechRun = 0;
  }
  const tailEcho = tailEventScores.length > 0 ? mean(tailEventScores) : 0;
  const echoScore = clamp(tailEcho * 0.72 + autoCorrEcho * 0.28, 0, 1);

  const frameClickDensity = clickFrames / Math.max(nonSpeechFrames, 1);
  const sampleClicksPerMinute = (sampleSpikeCount / Math.max(durationSec, 1e-6)) * 60;
  const clickScore = clamp(frameClickDensity * 1.9 + sampleClicksPerMinute / 18, 0, 1);

  const crestSpeechDb = speechCrest.length > 0 ? mean(speechCrest) : 12;
  const compressionScore = clamp(
    clamp((10.2 - dynamicRangeDb) / 5.2, 0, 1) * 0.68 +
      clamp((11.5 - crestSpeechDb) / 5.8, 0, 1) * 0.32,
    0,
    1
  );
  const noiseLiftRisk =
    clamp((pauseNoiseFloorDb + 62) / 18, 0, 1) * 0.45 + clamp((24 - noiseContrastDb) / 16, 0, 1) * 0.55;
  const clipScore = clamp(clipPct / 0.03, 0, 1);
  const overallRisk = clamp(
    instabilityScore * 0.24 +
      compressionScore * 0.24 +
      noiseLiftRisk * 0.22 +
      clickScore * 0.14 +
      echoScore * 0.12 +
      clipScore * 0.08,
    0,
    1
  );

  const baseReport: QcReport = {
    fileName,
    fileSize,
    status:
      overallRisk >= 0.56 || instabilityScore >= 0.74 || noiseLiftRisk >= 0.72 || clickScore >= 0.66
        ? "warning"
        : "ok",
    overallRisk,
    durationSec,
    sampleRate,
    peakDb,
    clipPct,
    noiseFloorDb,
    pauseNoiseFloorDb,
    noiseContrastDb,
    speechRatioPct,
    dynamicRangeDb,
    instabilityScore,
    compressionScore,
    clickScore,
    echoScore,
    flags: [],
    recommendations: [],
  };

  const { flags, recommendations } = buildFlagsAndRecommendations(baseReport);
  return {
    ...baseReport,
    flags,
    recommendations,
  };
};

export default function QcReportLab() {
  const [files, setFiles] = useState<File[]>([]);
  const [reports, setReports] = useState<QcReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [dragActive, setDragActive] = useState(false);

  const hasWarnings = useMemo(() => reports.some((report) => report.status === "warning"), [reports]);
  const comparisons = useMemo(() => buildComparisons(reports), [reports]);

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

  const runAnalysis = async () => {
    if (files.length === 0 || loading) return;

    setLoading(true);
    setReports([]);
    setStatus("Preparing analysis...");

    const audioContext = new AudioContext();
    const nextReports: QcReport[] = [];

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setStatus(`Analyzing ${file.name} (${index + 1}/${files.length})`);
        try {
          const decoded = await decodeToMono(file, audioContext);
          const report = analyzeSamples(
            file.name,
            file.size,
            decoded.samples,
            decoded.sampleRate,
            decoded.durationSec,
            decoded.peakDb,
            decoded.clipPct
          );
          nextReports.push(report);
        } catch (error) {
          nextReports.push({
            fileName: file.name,
            fileSize: file.size,
            status: "error",
            overallRisk: 1,
            durationSec: 0,
            sampleRate: 0,
            peakDb: -120,
            clipPct: 0,
            noiseFloorDb: -120,
            pauseNoiseFloorDb: -120,
            noiseContrastDb: 0,
            speechRatioPct: 0,
            dynamicRangeDb: 0,
            instabilityScore: 0,
            compressionScore: 0,
            clickScore: 0,
            echoScore: 0,
            flags: ["File could not be analyzed."],
            recommendations: ["Check that the file is a valid PCM WAV and retry."],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      setReports(nextReports);
      const hasError = nextReports.some((report) => report.status === "error");
      const hasWarning = nextReports.some((report) => report.status === "warning");
      setStatus(hasError ? "Done with errors" : hasWarning ? "Done with warnings" : "Done");
    } finally {
      await audioContext.close();
      setLoading(false);
    }
  };

  const downloadReportJson = () => {
    if (reports.length === 0) return;
    const payload = {
      generatedAt: new Date().toISOString(),
      status,
      reports,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `qc_report_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
            <div className={styles.dropTitle}>Drop WAV files for QC analysis</div>
            <div className={styles.dropHint}>
              Analyze + QC report runs locally in this browser. No file is uploaded anywhere.
            </div>
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
              <button className={styles.buttonSecondary} onClick={runAnalysis} disabled={loading || files.length === 0}>
                {loading ? "Analyzing..." : "Run Analyze + QC"}
              </button>
              <button className={styles.buttonGhost} onClick={downloadReportJson} disabled={reports.length === 0}>
                Download JSON
              </button>
            </div>
            <div className={styles.progress}>{status}</div>
            <div className={styles.fileList}>
              {files.length === 0 && <div className={styles.dropHint}>No files selected.</div>}
              {files.map((file, index) => (
                <div className={styles.fileItem} key={`${file.name}-${index}-${file.lastModified}`}>
                  <span>{file.name}</span>
                  <span>{formatBytes(file.size)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.card}>
          <h3>QC Summary</h3>
          <div className={styles.summaryRow}>
            <span>{reports.length} analyzed file(s)</span>
            <span>{reports.filter((report) => report.status === "error").length} error(s)</span>
          </div>
          <div className={styles.summaryRow}>
            <span>{reports.filter((report) => report.status === "warning").length} warning(s)</span>
            <span>{reports.filter((report) => report.status === "ok").length} pass</span>
          </div>
          <div className={styles.summaryRow}>
            <span>{comparisons.length} before/after pair(s)</span>
            <span>{comparisons.filter((pair) => pair.deltaRisk > 0.05).length} regressed pair(s)</span>
          </div>
          <div className={styles.badges}>
            <span className={styles.badge}>Instability</span>
            <span className={styles.badge}>Noise lift risk</span>
            <span className={styles.badge}>Clicks + Echo</span>
            <span className={styles.badge}>Compression risk</span>
          </div>
          <p className={styles.footerNote}>
            Use this page as a local diagnostics lab before final production runs.
          </p>
        </div>
      </div>

      <div className={styles.card}>
        <h3>Before vs After Delta</h3>
        {comparisons.length === 0 ? (
          <div className={styles.emptyState}>
            Add before/after files with similar names (for example <code>before_name.wav</code> and{" "}
            <code>name_A85.wav</code>) to auto-generate pair deltas.
          </div>
        ) : (
          <div className={styles.reportList}>
            {comparisons.map((comparison) => {
              const regressed = comparison.deltaRisk > 0.05;
              return (
                <div className={styles.reportItem} key={comparison.key}>
                  <div className={styles.reportHeader}>
                    <div>
                      <strong>{comparison.key}</strong>
                      <div className={styles.muted}>
                        {comparison.before.fileName} {"->"} {comparison.after.fileName}
                      </div>
                    </div>
                    <span className={`${styles.statusBadge} ${regressed ? styles.statusWarning : styles.statusOk}`}>
                      {regressed ? "Regression risk" : "Improved/Stable"}
                    </span>
                  </div>

                  <div className={styles.metricGrid}>
                    <div className={styles.metric}>
                      <span>Overall risk delta</span>
                      <strong>{formatSignedPercent(comparison.deltaRisk)}</strong>
                    </div>
                    <div className={styles.metric}>
                      <span>Instability delta</span>
                      <strong>{formatSignedPercent(comparison.deltaInstability)}</strong>
                    </div>
                    <div className={styles.metric}>
                      <span>Compression delta</span>
                      <strong>{formatSignedPercent(comparison.deltaCompression)}</strong>
                    </div>
                    <div className={styles.metric}>
                      <span>Pause noise floor delta</span>
                      <strong>{formatSignedDb(comparison.deltaNoiseFloor)}</strong>
                    </div>
                    <div className={styles.metric}>
                      <span>Noise contrast delta</span>
                      <strong>{formatSignedDb(comparison.deltaNoiseContrast)}</strong>
                    </div>
                    <div className={styles.metric}>
                      <span>Click / Echo delta</span>
                      <strong>
                        {formatSignedPercent(comparison.deltaClick)} / {formatSignedPercent(comparison.deltaEcho)}
                      </strong>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className={styles.card}>
        <h3>Per-file QC Report</h3>
        {reports.length === 0 ? (
          <div className={styles.emptyState}>Run analysis to generate report cards.</div>
        ) : (
          <div className={styles.reportList}>
            {reports.map((report, index) => (
              <div className={styles.reportItem} key={`${report.fileName}-${index}`}>
                <div className={styles.reportHeader}>
                  <div>
                    <strong>{report.fileName}</strong>
                    <div className={styles.muted}>{formatBytes(report.fileSize)}</div>
                  </div>
                  <span
                    className={`${styles.statusBadge} ${
                      report.status === "error"
                        ? styles.statusError
                        : report.status === "warning"
                          ? styles.statusWarning
                          : styles.statusOk
                    }`}
                  >
                    {report.status === "error"
                      ? "Error"
                      : report.status === "warning"
                        ? "Needs attention"
                        : "Pass"}
                  </span>
                </div>

                {report.status === "error" ? (
                  <div className={styles.errorText}>{report.error ?? "Analysis failed."}</div>
                ) : (
                  <>
                    <div className={styles.metricGrid}>
                      <div className={styles.metric}>
                        <span>Overall risk</span>
                        <strong>{Math.round(report.overallRisk * 100)}%</strong>
                      </div>
                      <div className={styles.metric}>
                        <span>Instability</span>
                        <strong>{Math.round(report.instabilityScore * 100)}%</strong>
                      </div>
                      <div className={styles.metric}>
                        <span>Compression risk</span>
                        <strong>{Math.round(report.compressionScore * 100)}%</strong>
                      </div>
                      <div className={styles.metric}>
                        <span>Noise floor</span>
                        <strong>{report.noiseFloorDb.toFixed(1)} dB</strong>
                      </div>
                      <div className={styles.metric}>
                        <span>Click score</span>
                        <strong>{Math.round(report.clickScore * 100)}%</strong>
                      </div>
                      <div className={styles.metric}>
                        <span>Echo score</span>
                        <strong>{Math.round(report.echoScore * 100)}%</strong>
                      </div>
                      <div className={styles.metric}>
                        <span>Speech range</span>
                        <strong>{report.dynamicRangeDb.toFixed(1)} dB</strong>
                      </div>
                      <div className={styles.metric}>
                        <span>Peak / clip</span>
                        <strong>
                          {report.peakDb.toFixed(1)} dB / {report.clipPct.toFixed(3)}%
                        </strong>
                      </div>
                    </div>

                    <div className={styles.section}>
                      <div className={styles.sectionTitle}>Flags</div>
                      <ul>
                        {report.flags.map((flag, flagIndex) => (
                          <li key={`${report.fileName}-flag-${flagIndex}`}>{flag}</li>
                        ))}
                      </ul>
                    </div>

                    <div className={styles.section}>
                      <div className={styles.sectionTitle}>Recommendations</div>
                      <ul>
                        {report.recommendations.map((item, recIndex) => (
                          <li key={`${report.fileName}-rec-${recIndex}`}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {hasWarnings && (
        <div className={styles.warningBanner}>
          QC warnings found. Review flagged files before production export.
        </div>
      )}
    </div>
  );
}
