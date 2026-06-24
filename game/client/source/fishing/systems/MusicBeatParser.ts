export interface OnsetPoint {
  /** seconds from clip start */
  time: number
  /** normalized 0..1 */
  strength: number
}

export interface MusicSectionBoundary {
  /** bar index where this section begins */
  barStart: number
  /** seconds where this section begins */
  time: number
  /** coarse energy label for gameplay mapping */
  energy: 'low' | 'mid' | 'high'
}

export interface MusicAnalysis {
  bpm: number
  beatIntervalSec: number
  durationSec: number
  beatTimes: number[]
  downbeatTimes: number[]
  onsets: OnsetPoint[]
  /** 0..1 confidence based on onset-grid consistency */
  confidence: number
  /**
   * Coarse section suggestions inferred from bar-level energy changes.
   * Useful as a default if no authored section map exists.
   */
  sectionBoundaries: MusicSectionBoundary[]
}

/**
 * Lightweight browser-side beat parser:
 * - onset envelope (energy rise)
 * - BPM estimation from IOI histogram
 * - beat-grid phase fitting
 * - downbeat phase estimation in 4/4
 * - coarse section boundary suggestions
 *
 * This is intentionally deterministic and dependency-free so it can run
 * in the game client for quick "single track gameplay alignment" passes.
 */
export class MusicBeatParser {
  static async analyzeFromUrl(
    url: string,
    audioContextFactory: () => AudioContext = defaultAudioContextFactory,
  ): Promise<MusicAnalysis> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch audio: ${res.status} ${res.statusText}`)
    const arrayBuffer = await res.arrayBuffer()
    return this.analyzeArrayBuffer(arrayBuffer, audioContextFactory)
  }

  static async analyzeArrayBuffer(
    arrayBuffer: ArrayBuffer,
    audioContextFactory: () => AudioContext = defaultAudioContextFactory,
  ): Promise<MusicAnalysis> {
    const ctx = audioContextFactory()
    try {
      const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0))
      return analyzeAudioBuffer(decoded)
    } finally {
      void ctx.close().catch(() => {})
    }
  }

  static analyzeDecodedBuffer(buffer: AudioBuffer): MusicAnalysis {
    return analyzeAudioBuffer(buffer)
  }
}

function defaultAudioContextFactory(): AudioContext {
  const AC =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) throw new Error('Web Audio API unavailable')
  return new AC()
}

function analyzeAudioBuffer(buffer: AudioBuffer): MusicAnalysis {
  const mono = toMono(buffer)
  const sr = buffer.sampleRate
  const durationSec = mono.length / sr

  // 1) Novelty curve from short-time RMS difference.
  const frameSize = 1024
  const hop = 512
  const rms = computeRmsCurve(mono, frameSize, hop)
  const novelty = computeNovelty(rms)
  const noveltySecPerFrame = hop / sr

  // 2) Onset candidates with adaptive threshold.
  const onsetFrames = pickOnsetFrames(novelty, Math.round(0.085 / noveltySecPerFrame))
  const onsetTimes = onsetFrames.map((f) => f * noveltySecPerFrame)
  const onsetStrengthsRaw = onsetFrames.map((f) => novelty[f] ?? 0)
  const onsetMax = Math.max(1e-9, ...onsetStrengthsRaw)
  const onsets: OnsetPoint[] = onsetTimes.map((time, i) => ({
    time,
    strength: clamp01((onsetStrengthsRaw[i] ?? 0) / onsetMax),
  }))

  // 3) BPM estimate (IOI histogram + clamp to musical range).
  const bpm = estimateBpmFromOnsets(onsetTimes)
  const beatIntervalSec = 60 / bpm

  // 4) Beat phase fit (pick offset that best aligns onset cloud to grid).
  const phaseOffsetSec = fitBeatPhase(onsetTimes, beatIntervalSec)

  // Beat grid from first >=0 beat.
  const beatTimes = buildBeatGrid(phaseOffsetSec, beatIntervalSec, durationSec)

  // 5) Downbeat phase in 4/4 from onset energy at beat positions.
  const downbeatPhase = estimateDownbeatPhase(beatTimes, novelty, noveltySecPerFrame)
  const downbeatTimes = beatTimes.filter((_, i) => ((i - downbeatPhase) % 4 + 4) % 4 === 0)

  // 6) Coarse section boundaries from bar-energy changes.
  const sectionBoundaries = inferSectionBoundaries(
    beatTimes,
    downbeatPhase,
    novelty,
    noveltySecPerFrame,
  )

  // Confidence: how tightly onsets lock to nearest beat.
  const confidence = estimateGridConfidence(onsetTimes, beatTimes, beatIntervalSec)

  return {
    bpm: Math.round(bpm * 100) / 100,
    beatIntervalSec,
    durationSec,
    beatTimes,
    downbeatTimes,
    onsets,
    confidence,
    sectionBoundaries,
  }
}

function toMono(buffer: AudioBuffer): Float32Array {
  const n = buffer.length
  const out = new Float32Array(n)
  const channels = buffer.numberOfChannels
  for (let ch = 0; ch < channels; ch += 1) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < n; i += 1) out[i] += data[i] / channels
  }
  return out
}

function computeRmsCurve(signal: Float32Array, frameSize: number, hop: number): Float32Array {
  const frameCount = Math.max(0, Math.floor((signal.length - frameSize) / hop) + 1)
  const out = new Float32Array(frameCount)
  for (let f = 0; f < frameCount; f += 1) {
    const start = f * hop
    let acc = 0
    for (let i = 0; i < frameSize; i += 1) {
      const v = signal[start + i] ?? 0
      acc += v * v
    }
    out[f] = Math.sqrt(acc / frameSize)
  }
  return out
}

function computeNovelty(rms: Float32Array): Float32Array {
  const out = new Float32Array(rms.length)
  let prev = rms[0] ?? 0
  for (let i = 1; i < rms.length; i += 1) {
    const cur = rms[i] ?? 0
    out[i] = Math.max(0, cur - prev)
    prev = cur
  }
  // Slight smoothing to reduce micro-spikes.
  return movingAverage(out, 3)
}

function movingAverage(data: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i += 1) {
    const a = Math.max(0, i - radius)
    const b = Math.min(data.length - 1, i + radius)
    let sum = 0
    for (let j = a; j <= b; j += 1) sum += data[j] ?? 0
    out[i] = sum / (b - a + 1)
  }
  return out
}

function pickOnsetFrames(novelty: Float32Array, minGapFrames: number): number[] {
  const frames: number[] = []
  const localWin = 32 // about ~0.37s with hop 512 @44.1k
  let lastPicked = -1_000_000
  for (let i = 1; i < novelty.length - 1; i += 1) {
    if (i - lastPicked < minGapFrames) continue
    const v = novelty[i] ?? 0
    if (v <= (novelty[i - 1] ?? 0) || v < (novelty[i + 1] ?? 0)) continue
    const a = Math.max(0, i - localWin)
    const b = Math.min(novelty.length - 1, i + localWin)
    let mean = 0
    for (let j = a; j <= b; j += 1) mean += novelty[j] ?? 0
    mean /= Math.max(1, b - a + 1)
    const threshold = mean * 1.55
    if (v >= threshold) {
      frames.push(i)
      lastPicked = i
    }
  }
  return frames
}

function estimateBpmFromOnsets(onsetTimes: number[]): number {
  if (onsetTimes.length < 4) return 88
  const minBpm = 70
  const maxBpm = 180
  const binSize = 0.5
  const binCount = Math.floor((maxBpm - minBpm) / binSize) + 1
  const bins = new Float32Array(binCount)

  for (let i = 0; i < onsetTimes.length; i += 1) {
    const t0 = onsetTimes[i] ?? 0
    for (let j = i + 1; j < Math.min(onsetTimes.length, i + 12); j += 1) {
      const dt = (onsetTimes[j] ?? 0) - t0
      if (dt <= 0.08 || dt >= 2.0) continue
      let bpm = 60 / dt
      while (bpm < minBpm) bpm *= 2
      while (bpm > maxBpm) bpm /= 2
      const idx = Math.round((bpm - minBpm) / binSize)
      if (idx >= 0 && idx < bins.length) bins[idx] += 1
    }
  }

  let bestIdx = 0
  for (let i = 1; i < bins.length; i += 1) {
    if ((bins[i] ?? 0) > (bins[bestIdx] ?? 0)) bestIdx = i
  }
  const coarse = minBpm + bestIdx * binSize

  // Local weighted average around the top bin for a smoother estimate.
  let wSum = 0
  let vSum = 0
  for (let d = -3; d <= 3; d += 1) {
    const idx = bestIdx + d
    if (idx < 0 || idx >= bins.length) continue
    const w = bins[idx] ?? 0
    const bpm = minBpm + idx * binSize
    wSum += w
    vSum += w * bpm
  }
  return wSum > 0 ? vSum / wSum : coarse
}

function fitBeatPhase(onsetTimes: number[], beatIntervalSec: number): number {
  if (onsetTimes.length === 0) return 0
  // Candidate offsets from onset modulo interval.
  const candidates = onsetTimes.slice(0, Math.min(onsetTimes.length, 80)).map((t) => mod(t, beatIntervalSec))
  let bestOffset = candidates[0] ?? 0
  let bestScore = -Infinity
  const sigma = beatIntervalSec * 0.11
  for (const c of candidates) {
    let score = 0
    for (const t of onsetTimes) {
      const d = distanceToGrid(t, c, beatIntervalSec)
      // Gaussian reward: closer onsets to grid -> higher.
      score += Math.exp(-(d * d) / (2 * sigma * sigma))
    }
    if (score > bestScore) {
      bestScore = score
      bestOffset = c
    }
  }
  return bestOffset
}

function buildBeatGrid(offsetSec: number, intervalSec: number, durationSec: number): number[] {
  const beats: number[] = []
  // Start from the first non-negative beat.
  let t = offsetSec
  while (t < 0) t += intervalSec
  // Also backfill one beat so near-zero onsets can still snap.
  if (t - intervalSec >= 0) beats.push(t - intervalSec)
  while (t <= durationSec + intervalSec) {
    beats.push(t)
    t += intervalSec
  }
  return beats
}

function estimateDownbeatPhase(
  beatTimes: number[],
  novelty: Float32Array,
  secPerFrame: number,
): number {
  if (beatTimes.length < 8) return 0
  const phaseEnergy = [0, 0, 0, 0]
  for (let i = 0; i < beatTimes.length; i += 1) {
    const t = beatTimes[i] ?? 0
    const e = sampleNoveltyEnergy(novelty, secPerFrame, t, 0.09)
    phaseEnergy[i % 4] += e
  }
  let best = 0
  for (let p = 1; p < 4; p += 1) {
    if (phaseEnergy[p] > phaseEnergy[best]) best = p
  }
  return best
}

function inferSectionBoundaries(
  beatTimes: number[],
  downbeatPhase: number,
  novelty: Float32Array,
  secPerFrame: number,
): MusicSectionBoundary[] {
  // Build bar energies (4 beats per bar).
  const barStarts: number[] = []
  for (let i = 0; i < beatTimes.length; i += 1) {
    if (((i - downbeatPhase) % 4 + 4) % 4 === 0) barStarts.push(beatTimes[i] ?? 0)
  }
  if (barStarts.length < 2) return [{ barStart: 0, time: 0, energy: 'mid' }]

  const energies: number[] = []
  for (let b = 0; b < barStarts.length - 1; b += 1) {
    const start = barStarts[b] ?? 0
    const end = barStarts[b + 1] ?? start + 2
    energies.push(integrateNovelty(novelty, secPerFrame, start, end))
  }

  const smoothed = smoothNumberArray(energies, 2)
  const mean = smoothed.reduce((a, v) => a + v, 0) / Math.max(1, smoothed.length)
  const std = Math.sqrt(
    smoothed.reduce((a, v) => a + (v - mean) * (v - mean), 0) / Math.max(1, smoothed.length),
  )
  const lowTh = mean - std * 0.35
  const highTh = mean + std * 0.35

  const labelAt = (v: number): 'low' | 'mid' | 'high' => {
    if (v < lowTh) return 'low'
    if (v > highTh) return 'high'
    return 'mid'
  }

  const boundaries: MusicSectionBoundary[] = []
  let prev = labelAt(smoothed[0] ?? mean)
  boundaries.push({ barStart: 0, time: barStarts[0] ?? 0, energy: prev })
  for (let i = 1; i < smoothed.length; i += 1) {
    const cur = labelAt(smoothed[i] ?? mean)
    if (cur !== prev) {
      boundaries.push({ barStart: i, time: barStarts[i] ?? 0, energy: cur })
      prev = cur
    }
  }
  return boundaries
}

function estimateGridConfidence(
  onsetTimes: number[],
  beatTimes: number[],
  intervalSec: number,
): number {
  if (onsetTimes.length === 0 || beatTimes.length === 0) return 0
  const sigma = intervalSec * 0.12
  let score = 0
  for (const t of onsetTimes) {
    const d = nearestDistanceToArray(t, beatTimes)
    score += Math.exp(-(d * d) / (2 * sigma * sigma))
  }
  return clamp01(score / onsetTimes.length)
}

function sampleNoveltyEnergy(
  novelty: Float32Array,
  secPerFrame: number,
  centerSec: number,
  halfWindowSec: number,
): number {
  const a = Math.max(0, Math.floor((centerSec - halfWindowSec) / secPerFrame))
  const b = Math.min(novelty.length - 1, Math.ceil((centerSec + halfWindowSec) / secPerFrame))
  let sum = 0
  for (let i = a; i <= b; i += 1) sum += novelty[i] ?? 0
  return sum
}

function integrateNovelty(
  novelty: Float32Array,
  secPerFrame: number,
  startSec: number,
  endSec: number,
): number {
  const a = Math.max(0, Math.floor(startSec / secPerFrame))
  const b = Math.min(novelty.length - 1, Math.ceil(endSec / secPerFrame))
  let sum = 0
  for (let i = a; i <= b; i += 1) sum += novelty[i] ?? 0
  return sum
}

function smoothNumberArray(values: number[], radius: number): number[] {
  return values.map((_, i) => {
    const a = Math.max(0, i - radius)
    const b = Math.min(values.length - 1, i + radius)
    let sum = 0
    for (let j = a; j <= b; j += 1) sum += values[j] ?? 0
    return sum / (b - a + 1)
  })
}

function nearestDistanceToArray(x: number, arr: number[]): number {
  // arr is sorted ascending.
  let lo = 0
  let hi = arr.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = arr[mid] ?? 0
    if (v < x) lo = mid + 1
    else hi = mid - 1
  }
  const a = lo < arr.length ? Math.abs((arr[lo] ?? x) - x) : Number.POSITIVE_INFINITY
  const b = hi >= 0 ? Math.abs((arr[hi] ?? x) - x) : Number.POSITIVE_INFINITY
  return Math.min(a, b)
}

function distanceToGrid(t: number, offset: number, interval: number): number {
  const m = mod(t - offset, interval)
  return Math.min(m, interval - m)
}

function mod(x: number, m: number): number {
  return ((x % m) + m) % m
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}
