import type { BeatClock } from './BeatClock'

/**
 * Purely-synthesized audio (no bundled assets).
 *
 * Battle music is arranged as a real **song structure** — not just
 * stacked layers — so the fight has shape: intro → verse → pre-chorus
 * → chorus → (optional bridge) → loop back. Each section uses a
 * different combination of instruments (drums, bass, brass, tuba,
 * flute, pad) so the arrangement sounds like a track that actually
 * progresses instead of a single 4-bar loop getting louder.
 *
 *   section   | drums         | brass | tuba | flute     | pad  | note density
 *   ----------|---------------|-------|------|-----------|------|--------------
 *   intro     | kick swell    | —     | —    | —         | hi   | sparse  (L0)
 *   verse     | four-on-floor | —     | —    | accents   | low  | medium  (L1)
 *   preChorus | + 16th hats   | stab  | —    | —         | mid  | thick   (L2)
 *   chorus    | driving       | motif | hits | counter   | low  | max     (L3)
 *   bridge    | half-time     | —     | —    | LEAD melo | hi   | medium  (L1)
 *
 * Player success bumps us forward through the flow (intro → verse →
 * preChorus → chorus). Once we're in the chorus, additional successes
 * **modulate the key up a whole step** instead of advancing — that's
 * the "user actions change the tonality" the design called for.
 *
 * Sustained inactivity causes a decay (chorus → bridge → verse), so
 * the song breathes around player skill.
 *
 * All transitions land on the next **bar boundary** so they feel
 * musical rather than abrupt mid-phrase.
 *
 * AudioContext is lazy-initialized inside a user gesture to satisfy
 * browser autoplay rules; until then `unlocked === false` and play
 * calls are no-ops.
 */
export class AudioSystem {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private stormNode: AudioBufferSourceNode | null = null
  private stormGain: GainNode | null = null
  private stringGain: GainNode | null = null
  private stringOscs: OscillatorNode[] = []

  // Per-instrument gain buses (let us crossfade sections smoothly).
  private beatClock: BeatClock | null = null
  private drumGain: GainNode | null = null
  private brassGain: GainNode | null = null
  private tubaGain: GainNode | null = null
  private fluteGain: GainNode | null = null
  private bassGain: GainNode | null = null
  private padGain: GainNode | null = null
  /** Electronic-flavoured 16th-note arpeggio synth layer — adds the
   *  "more complex arrangement" energy on top of the live kit. */
  private arpGain: GainNode | null = null
  /** Vocal "ahh" choir layer. Sustained notes during chorus + the
   *  voice that visually emanates from the mermaid during cues. */
  private choirGain: GainNode | null = null
  /** Sparkle bell — short metallic chime that adds glitter on chorus
   *  downbeats. */
  private bellGain: GainNode | null = null
  /** Lead synth that plays a melodic hook (NOT just stab notes) on
   *  top of brass in verse + chorus. */
  private leadGain: GainNode | null = null

  private nextScheduledBeat = 0
  private schedulerHandle: number | null = null
  private drumsActive = false

  // ---- Song state ----
  private currentSection: Section = 'intro'
  /**
   * The resting "groove bed" the song never relaxes below. It ratchets
   * UP as the player lands fish (verse → preChorus → chorus) and never
   * drops during a session, so the soundtrack is continuous and grows
   * monotonically richer the longer/deeper you play. Battles lift the
   * song ABOVE this; ending a fight relaxes back DOWN to it (never to
   * silence).
   */
  private sectionFloor: Section = 'verse'
  /** Set during a beat schedule; applied on next bar boundary. */
  private pendingSection: Section | null = null
  /** Number of beats spent in the current section (used to auto-leave intro). */
  private sectionBeatsElapsed = 0
  /** Semitones above the base root. Increases as the player succeeds
   *  during chorus → "key change up" feeling. */
  private keyOffsetSemis = 0
  private motifIndex = 0
  /** Counts how many consecutive chorus-bump key changes the player
   *  has earned, used to escalate brass register one octave at +4. */
  private consecutiveChorusBumps = 0

  private weatherIntensity = 0

  unlocked = false
  private muted = false

  /** Call from a user gesture (e.g. pointerdown). Safe to call repeatedly. */
  unlock(): void {
    if (this.unlocked) return
    try {
      const AC =
        (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
          .AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      this.ctx = new AC()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.6
      this.master.connect(this.ctx.destination)
      this.drumGain = this.makeBus(0)
      this.brassGain = this.makeBus(0)
      this.tubaGain = this.makeBus(0)
      this.fluteGain = this.makeBus(0)
      this.bassGain = this.makeBus(0)
      this.padGain = this.makeBus(0)
      this.arpGain = this.makeBus(0)
      this.choirGain = this.makeBus(0)
      this.bellGain = this.makeBus(0)
      this.leadGain = this.makeBus(0)
      this.unlocked = true
      this.startStorm()
      this.startStringPad()
      if (this.beatClock && !this.beatClock.started) {
        this.beatClock.start(this.ctx.currentTime)
      }
    } catch {
      this.unlocked = false
    }
  }

  setMuted(value: boolean): void {
    this.muted = value
    if (this.master) this.master.gain.value = value ? 0 : 0.6
  }

  /** Apply the current weather intensity (0..1). Storm gain ramps via
   *  setTargetAtTime so successive calls don't pile up. */
  setWeather(intensity: number): void {
    this.weatherIntensity = Math.max(0, Math.min(1, intensity))
    if (!this.ctx || !this.stormGain) return
    const target = this.weatherIntensity * 0.35
    this.stormGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.5)
  }

  attachBeatClock(clock: BeatClock): void {
    this.beatClock = clock
    if (this.unlocked && this.ctx && !clock.started) {
      clock.start(this.ctx.currentTime)
    }
  }

  /**
   * Begin the battle song.
   *
   * @param initialIntensity 0..1 weather pressure — used as a fallback
   *        when no explicit start section is given (storm → skip intro).
   * @param startSection     OPTIONAL explicit section to open the song
   *        at. Used by BattleState to accelerate the arrangement based
   *        on how many fish the player has caught this session, so
   *        fight #4 doesn't have to crawl through intro+verse again.
   */
  startBeats(initialIntensity = 0, startSection?: Section): void {
    if (!this.ctx || !this.beatClock || !this.drumGain) return
    if (this.drumsActive) return
    if (!this.beatClock.started) this.beatClock.start(this.ctx.currentTime)
    this.nextScheduledBeat = this.beatClock.nextBeatAfter(this.ctx.currentTime)
    this.drumsActive = true
    if (startSection) {
      this.currentSection = startSection
    } else {
      this.currentSection = initialIntensity > 0.6 ? 'verse' : 'intro'
    }
    this.pendingSection = null
    this.sectionBeatsElapsed = 0
    this.keyOffsetSemis = 0
    this.consecutiveChorusBumps = 0
    this.motifIndex = 0
    this.applySectionGains(this.currentSection, 0.45)
    this.schedulerHandle = window.setInterval(() => this.tickDrumScheduler(), 25)
  }

  /** Fade the song out (used when leaving battle). */
  stopBeats(): void {
    if (!this.drumsActive) return
    this.drumsActive = false
    this.currentSection = 'intro'
    this.pendingSection = null
    this.sectionFloor = 'verse'
    this.keyOffsetSemis = 0
    this.consecutiveChorusBumps = 0
    if (this.schedulerHandle !== null) {
      window.clearInterval(this.schedulerHandle)
      this.schedulerHandle = null
    }
    if (!this.ctx) return
    const now = this.ctx.currentTime
    for (const g of [
      this.drumGain,
      this.brassGain,
      this.tubaGain,
      this.fluteGain,
      this.bassGain,
      this.padGain,
      this.arpGain,
      this.choirGain,
      this.bellGain,
      this.leadGain,
    ]) {
      if (g) g.gain.setTargetAtTime(0, now, 0.25)
    }
  }

  /**
   * Density level (0..3) for the NoteLane to mirror. Driven by the
   * current section so the chart visually thickens at the chorus and
   * thins at the bridge — exactly what the player hears.
   */
  getMusicIntensity(): number {
    return SECTION_PROFILES[this.currentSection].noteDensity
  }

  /**
   * Public: "the player did something cool, push the song forward."
   * - intro → verse → preChorus → chorus
   * - chorus → chorus + KEY UP (+2 semitones, capped at +4)
   * Returns the *new* NoteLane density level so the caller can sync.
   */
  bumpMusicIntensity(): number {
    if (!this.drumsActive) return this.getMusicIntensity()
    const cur = this.pendingSection ?? this.currentSection
    if (cur === 'chorus') {
      // Key change up a whole step. Re-roll the motif so the upper
      // register feels like a new phrase, not a repeat.
      this.keyOffsetSemis = Math.min(4, this.keyOffsetSemis + 2)
      this.consecutiveChorusBumps += 1
      this.motifIndex = (this.motifIndex + 1) % MOTIFS.length
    } else {
      this.pendingSection = SECTION_FLOW[cur]
      if (this.pendingSection === 'chorus') {
        this.consecutiveChorusBumps = 0
        this.keyOffsetSemis = 0
      }
    }
    return SECTION_PROFILES[this.pendingSection ?? this.currentSection].noteDensity
  }

  /**
   * Public: "the player has been quiet for a while, ease off."
   * - chorus → bridge (a calm interlude)
   * - bridge → verse (return to groove)
   * - preChorus → verse (drop the build-up)
   * Resets key offset when stepping out of chorus.
   */
  decayMusicIntensity(): number {
    if (!this.drumsActive) return this.getMusicIntensity()
    const cur = this.pendingSection ?? this.currentSection
    let next = SECTION_DECAY[cur]
    // Never relax below the earned resting bed — the groove stays alive
    // and as rich as the player has unlocked this session.
    if (SECTION_RANK[next] < SECTION_RANK[this.sectionFloor]) next = this.sectionFloor
    if (next !== cur) {
      this.pendingSection = next
      this.keyOffsetSemis = 0
      this.consecutiveChorusBumps = 0
    }
    return SECTION_PROFILES[next].noteDensity
  }

  // ---- Continuous groove bed ----

  /**
   * Start (or keep) the always-on base groove so the player ALWAYS hears
   * music — not just during a fight. Idempotent: safe to call on every
   * user gesture. If the song is already running it just makes sure it's
   * at least at the resting bed.
   */
  startGrooveBed(): void {
    if (this.drumsActive) {
      this.raiseToAtLeast(this.sectionFloor)
      return
    }
    this.startBeats(0, this.sectionFloor)
  }

  /**
   * Ratchet the resting bed richness UP (verse → preChorus → chorus).
   * Called as the player lands fish so the arrangement gains layers and
   * never thins back out. Lowering is ignored to keep the build monotonic
   * across a session.
   */
  setSectionFloor(section: Section): void {
    if (SECTION_RANK[section] <= SECTION_RANK[this.sectionFloor]) return
    this.sectionFloor = section
    this.raiseToAtLeast(section)
  }

  /**
   * Lift the song up to AT LEAST `section` for an intense moment (e.g.
   * a battle). Never lowers what's already playing.
   */
  riseToSection(section: Section): void {
    this.raiseToAtLeast(section)
  }

  /**
   * Ease the song back down to the resting bed when a fight ends. Keeps
   * the groove playing — it NEVER silences between fights.
   */
  relaxToBed(): void {
    if (!this.drumsActive) return
    const cur = this.pendingSection ?? this.currentSection
    if (SECTION_RANK[cur] > SECTION_RANK[this.sectionFloor]) {
      this.pendingSection = this.sectionFloor
      this.keyOffsetSemis = 0
      this.consecutiveChorusBumps = 0
    }
  }

  /**
   * Re-anchor the beat scheduler after the clock's tempo was rebased.
   * `BeatClock.setBpm()` rebases `audioStart`, which strands the running
   * scheduler's `nextScheduledBeat` (an absolute beat index from the OLD
   * timeline) far in the future — so the groove silently STOPS emitting
   * beats. Call this right after any `setBpm()` while the bed is playing.
   */
  resyncScheduler(): void {
    if (!this.ctx || !this.beatClock || !this.drumsActive) return
    this.nextScheduledBeat = this.beatClock.nextBeatAfter(this.ctx.currentTime)
  }

  /** Schedule a rise to `section` only if the song is currently lower. */
  private raiseToAtLeast(section: Section): void {
    if (!this.drumsActive) return
    const cur = this.pendingSection ?? this.currentSection
    if (SECTION_RANK[cur] < SECTION_RANK[section]) {
      this.pendingSection = section
    }
  }

  // ---- One-shot SFX ----

  playReelClick(): void {
    this.shortPing(880, 0.07, 'square', 0.18)
  }

  /**
   * Lure call-and-response notes. The game "sings" a short motif and the
   * player echoes each hit. Pentatonic keeps any echo pleasant even when
   * slightly off, which suits the zero-stakes luring phase.
   */
  private readonly lureScale = [523.25, 587.33, 659.25, 783.99, 880.0] // C5 D5 E5 G5 A5

  playLureCall(step = 0): void {
    this.shortPing(this.lureScale[step % this.lureScale.length], 0.18, 'triangle', 0.3)
  }

  playLureEcho(step = 0, good = true): void {
    const base = this.lureScale[step % this.lureScale.length]
    this.shortPing(good ? base * 2 : base * 0.5, 0.14, good ? 'sine' : 'sawtooth', good ? 0.26 : 0.16)
  }

  /** Fish takes the lure — bright ascending three-note "got one!" sparkle. */
  playLureSuccess(): void {
    this.shortPing(659.25, 0.12, 'triangle', 0.26)
    setTimeout(() => this.shortPing(880.0, 0.12, 'triangle', 0.26), 90)
    setTimeout(() => this.shortPing(1174.66, 0.18, 'triangle', 0.3), 180)
  }

  playCast(power: number): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const dur = 0.3 + power * 0.25
    const noise = makeNoiseBuffer(ctx, dur)
    const src = ctx.createBufferSource()
    src.buffer = noise
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(400 + power * 1000, t0)
    filter.frequency.exponentialRampToValueAtTime(180, t0 + dur)
    filter.Q.value = 1.2
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, t0)
    gain.gain.linearRampToValueAtTime(0.5, t0 + 0.04)
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
    src.connect(filter).connect(gain).connect(this.master)
    src.start(t0)
    src.stop(t0 + dur)
  }

  playSplash(): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const dur = 0.4
    const noise = makeNoiseBuffer(ctx, dur)
    const src = ctx.createBufferSource()
    src.buffer = noise
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(1800, t0)
    filter.frequency.exponentialRampToValueAtTime(220, t0 + dur)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.45, t0)
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
    src.connect(filter).connect(gain).connect(this.master)
    src.start(t0)
    src.stop(t0 + dur)
  }

  playBiteAlert(): void {
    this.shortPing(1200, 0.12, 'triangle', 0.3)
  }

  playHookset(): void {
    this.shortPing(740, 0.18, 'sawtooth', 0.35)
    setTimeout(() => this.shortPing(1108, 0.12, 'sawtooth', 0.3), 80)
  }

  /**
   * Caught: brass + flute fanfare layered for impact (do-mi-sol over
   * a held tuba root). One of the few moments where every instrument
   * fires together regardless of section.
   */
  playFanfare(): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    // Tuba root sustain underneath.
    this.scheduleTubaNote(t0, 0.9, 130.81, this.master, 0.24)
    this.brassNote(523.25, 0.18, 0)
    this.brassNote(659.25, 0.18, 0.16)
    this.brassNote(783.99, 0.36, 0.32)
    // Flute octave above closing chord — gives the "yes!" sparkle.
    this.scheduleFluteNote(t0 + 0.32, 0.4, 1567.98, this.master, 0.18)
  }

  playFail(): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(440, t0)
    osc.frequency.exponentialRampToValueAtTime(80, t0 + 0.4)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.3, t0)
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4)
    osc.connect(gain).connect(this.master)
    osc.start(t0)
    osc.stop(t0 + 0.45)
  }

  /**
   * Battle event "Follow fish" cue — a rising brass + flute tag that
   * also doubles as a musical signpost telling the player a section
   * push is available.
   *
   * The choir + bell layered on top is what visually emanates from the
   * mermaid on her rock: a vocal "ahh" with a glittering chime.
   */
  playFollowCue(): void {
    if (!this.ctx || !this.master) return
    this.brassNote(311.13, 0.32, 0, 'sawtooth', 0.2)
    this.brassNote(370.0, 0.28, 0.12, 'sawtooth', 0.16)
    this.brassNote(466.16, 0.36, 0.24, 'sawtooth', 0.14)
    // Flute echo two octaves above — the "ear-grab".
    this.scheduleFluteNote(this.ctx.currentTime + 0.06, 0.36, 932.33, this.master, 0.14)
    // Mermaid "ahh" — rising vocal duet on the same chord. The choir is
    // sustained for ~1.5s so it overlaps the entire enhanced beat
    // window, reinforcing the visual mermaid singing.
    const t0 = this.ctx.currentTime
    this.scheduleChoirNote(t0 + 0.02, 1.4, 466.16, this.master, 0.28)
    this.scheduleChoirNote(t0 + 0.18, 1.2, 698.46, this.master, 0.22) // F5
    this.scheduleBellNote(t0 + 0.08, 1.3, 1396.91, this.master, 0.35)
  }

  /**
   * Battle event "Fish running" cue — punchy down-up brass stab
   * paired with a low tuba thud for weight.
   *
   * Choir + bell join in here too — same mermaid character voice but
   * shorter, punctuating the urgency of the "fish running" moment.
   */
  playRunCue(): void {
    if (!this.ctx || !this.master) return
    this.brassNote(880, 0.22, 0, 'square', 0.22)
    this.brassNote(587.33, 0.34, 0.14, 'square', 0.18)
    this.scheduleTubaNote(this.ctx.currentTime, 0.4, 87.31, this.master, 0.28)
    // Sharp mermaid vocal stab — quick "ah!" warning.
    const t0 = this.ctx.currentTime
    this.scheduleChoirNote(t0, 0.55, 880, this.master, 0.3)
    this.scheduleChoirNote(t0 + 0.05, 0.55, 587.33, this.master, 0.22)
    this.scheduleBellNote(t0, 0.7, 1760, this.master, 0.4)
  }

  playKick(): void {
    if (!this.ctx || !this.master) return
    this.synthKick(this.ctx.currentTime, 0.45)
  }

  playPerfectChime(): void {
    if (!this.ctx || !this.master) return
    this.shortPing(1320, 0.1, 'triangle', 0.22)
  }

  destroy(): void {
    this.stopBeats()
    try {
      this.stormNode?.stop()
    } catch {}
    for (const osc of this.stringOscs) {
      try {
        osc.stop()
      } catch {}
    }
    this.stringOscs = []
    this.stormNode = null
    this.stormGain = null
    this.stringGain = null
    this.drumGain = null
    this.brassGain = null
    this.tubaGain = null
    this.fluteGain = null
    this.bassGain = null
    this.padGain = null
    this.arpGain = null
    this.choirGain = null
    this.bellGain = null
    this.leadGain = null
    if (this.ctx) {
      void this.ctx.close().catch(() => {})
      this.ctx = null
    }
    this.master = null
    this.unlocked = false
  }

  // ---- internal: section → bus gain matrix ----

  private makeBus(initial: number): GainNode {
    if (!this.ctx || !this.master) throw new Error('audio not initialised')
    const g = this.ctx.createGain()
    g.gain.value = initial
    g.connect(this.master)
    return g
  }

  /**
   * Crossfade every bus to the levels appropriate for the given
   * section, over `rampSeconds`. Per-bus exponential targets via
   * setTargetAtTime so we don't pop.
   */
  private applySectionGains(section: Section, rampSeconds: number): void {
    if (!this.ctx) return
    const tc = Math.max(0.05, rampSeconds / 3)
    const now = this.ctx.currentTime
    const p = SECTION_PROFILES[section]
    // Drums scale with weather so stormy battles feel weightier.
    const drum = p.drumVol * (0.7 + this.weatherIntensity * 0.35)
    this.setBus(this.drumGain, drum, now, tc)
    this.setBus(this.brassGain, p.brassVol, now, tc)
    this.setBus(this.tubaGain, p.tubaVol, now, tc)
    this.setBus(this.fluteGain, p.fluteVol, now, tc)
    this.setBus(this.bassGain, p.bassVol, now, tc)
    this.setBus(this.padGain, p.padVol, now, tc)
    this.setBus(this.arpGain, p.arpVol, now, tc)
    this.setBus(this.choirGain, p.choirVol, now, tc)
    this.setBus(this.bellGain, p.bellVol, now, tc)
    this.setBus(this.leadGain, p.leadVol, now, tc)
  }

  private setBus(g: GainNode | null, target: number, at: number, tc: number): void {
    if (!g) return
    g.gain.setTargetAtTime(target, at, tc)
  }

  // ---- internal: per-beat scheduling ----

  private tickDrumScheduler(): void {
    if (!this.ctx || !this.beatClock || !this.drumsActive) return
    const lookaheadSec = 0.2
    const horizon = this.ctx.currentTime + lookaheadSec
    while (true) {
      const beatTime = this.beatClock.audioTimeOfBeat(this.nextScheduledBeat)
      if (beatTime > horizon) break
      // Skip past beats (tab was backgrounded) to keep the loop sane.
      if (beatTime < this.ctx.currentTime - 0.05) {
        this.nextScheduledBeat += 1
        continue
      }
      this.scheduleBeat(this.nextScheduledBeat, beatTime)
      this.nextScheduledBeat += 1
    }
  }

  /**
   * Emit every hit that belongs to a given musical beat. A 4/4 bar
   * has beats 0,1,2,3; sub-beat hits (offbeats, 16th hats, ghost
   * snares) are scheduled at fractional audio times so Web Audio
   * handles their precise placement.
   */
  private scheduleBeat(beatIndex: number, beatTime: number): void {
    if (!this.ctx || !this.beatClock || !this.drumGain) return
    const interval = this.beatClock.beatIntervalSec
    const beatInBar = ((beatIndex % 4) + 4) % 4

    // BAR boundary: apply any pending transition first so the new
    // section starts cleanly on beat 0 of its first bar.
    if (beatInBar === 0) {
      if (this.pendingSection && this.pendingSection !== this.currentSection) {
        this.currentSection = this.pendingSection
        this.pendingSection = null
        this.sectionBeatsElapsed = 0
        this.applySectionGains(this.currentSection, 0.35)
      }
      // Intro auto-resolves to verse after its allotted bars — applied
      // on the SAME bar boundary instead of queued for the next one,
      // otherwise the player hears an extra empty bar of intro.
      const profile = SECTION_PROFILES[this.currentSection]
      if (this.currentSection === 'intro' && this.sectionBeatsElapsed >= profile.barsLength * 4) {
        this.currentSection = 'verse'
        this.sectionBeatsElapsed = 0
        this.applySectionGains(this.currentSection, 0.55)
      }
    }
    this.sectionBeatsElapsed += 1

    const profile = SECTION_PROFILES[this.currentSection]
    const drumOut = this.drumGain
    const useMinor = this.weatherIntensity > 0.45 // stormier weather → minor mode

    // ---- Drums ----
    this.scheduleDrums(profile.drumPattern, beatInBar, beatTime, interval, drumOut)

    // ---- Bass (any section that wants it) ----
    if (profile.bassVol > 0 && this.bassGain) {
      const baseRoot = useMinor ? 110 : 130.81
      const root = baseRoot * Math.pow(2, this.keyOffsetSemis / 12)
      const pattern = profile.bassPattern
      const semis = pattern[beatInBar]
      const freq = root * Math.pow(2, semis / 12)
      // Half-time bridge plays only on beats 0 and 2 for a slower feel.
      const isHalfTime = profile.drumPattern === 'half-time'
      if (!isHalfTime || beatInBar === 0 || beatInBar === 2) {
        this.scheduleBassNote(beatTime, interval * (isHalfTime ? 1.9 : 0.95), freq, this.bassGain)
      }
    }

    // ---- Tuba (low brass) on beats 0 and 2 in chorus ----
    if (profile.tubaVol > 0 && (beatInBar === 0 || beatInBar === 2) && this.tubaGain) {
      const baseRoot = useMinor ? 65.41 : 87.31 // C2/E2-ish
      const root = baseRoot * Math.pow(2, this.keyOffsetSemis / 12)
      this.scheduleTubaNote(beatTime, interval * 1.7, root, this.tubaGain, 0.22)
    }

    // ---- Brass motif ----
    // Sustained brass phrase scheduled across all 4 beats of the bar
    // at the moment we hit the downbeat.
    if (profile.brassVol > 0 && beatInBar === 0 && this.brassGain) {
      const motif = MOTIFS[this.motifIndex % MOTIFS.length]
      // Pre-chorus is leaner (only 2 notes), chorus plays the whole 4.
      const slots = this.currentSection === 'preChorus' ? [0, 2] : [0, 1, 2, 3]
      const baseRoot = useMinor ? 220 : 261.63
      // At +4 key shift in chorus, jump brass up an octave for a
      // dramatic key-change reveal.
      const octaveBoost = this.consecutiveChorusBumps >= 2 ? 2 : 1
      const root = baseRoot * Math.pow(2, this.keyOffsetSemis / 12) * octaveBoost
      for (const slot of slots) {
        const semis = motif[slot]
        const freq = root * Math.pow(2, semis / 12)
        const noteAt = beatTime + slot * interval
        const noteDur = interval * (slot === slots[slots.length - 1] ? 1.4 : 1.05)
        this.scheduleBrassNote(noteAt, noteDur, freq, this.brassGain, slot === 0 ? 0.22 : 0.16)
      }
    }

    // ---- Flute ----
    // Three roles depending on section:
    //   accents (verse): sparse high punctuations on the last beat
    //   counter (chorus): call-and-response answering brass, beats 2-3
    //   lead    (bridge): a flowing melodic line across the whole bar
    if (profile.fluteVol > 0 && this.fluteGain) {
      const baseRoot = useMinor ? 440 : 523.25 // A4 / C5
      const root = baseRoot * Math.pow(2, this.keyOffsetSemis / 12)
      const fluteLine = FLUTE_LINES[profile.fluteRole]
      if (fluteLine && beatInBar === 0) {
        for (const note of fluteLine) {
          if (note.semis == null) continue
          const freq = root * Math.pow(2, note.semis / 12)
          const at = beatTime + note.beat * interval
          this.scheduleFluteNote(at, note.lenBeats * interval, freq, this.fluteGain, note.vol)
        }
      }
    }

    // ---- Electronic arpeggio (16th-note pluck synth) ----
    // Driven by 4 hits per beat (= 16 per bar). Adds the "more complex
    // arrangement" body — without being so loud it competes with brass.
    // Each section's `arpPattern` specifies which slots actually fire
    // and the scale degree of each, so verse stays sparse while chorus
    // gets the full driving 1/16 line.
    if (profile.arpVol > 0 && this.arpGain) {
      const baseRoot = useMinor ? 440 : 523.25
      const root = baseRoot * Math.pow(2, this.keyOffsetSemis / 12)
      const arpSlotsPerBeat = 4
      const slotDur = interval / arpSlotsPerBeat
      // 16-slot pattern across the bar; we sample the 4 slots for this beat.
      const pattern = profile.arpPattern
      const beatBase = beatInBar * arpSlotsPerBeat
      for (let i = 0; i < arpSlotsPerBeat; i += 1) {
        const slot = beatBase + i
        const degree = pattern[slot]
        if (degree == null) continue
        const freq = root * Math.pow(2, degree / 12)
        this.scheduleArpNote(beatTime + i * slotDur, slotDur * 0.85, freq, this.arpGain)
      }
    }

    // ---- Choir "ah" pad ----
    // Sustained breathy vocal that adds a "human" warmth on top of the
    // synthetic kit. Two-voice open fifth, scheduled on beats 0 and 2
    // so each note holds for two beats and cross-fades smoothly.
    if (profile.choirVol > 0 && this.choirGain && (beatInBar === 0 || beatInBar === 2)) {
      const baseRoot = useMinor ? 220 : 261.63 // C4-ish
      const root = baseRoot * Math.pow(2, this.keyOffsetSemis / 12)
      // Each cycle we walk through different chord tones so the choir
      // moves with the harmony instead of camping on the root.
      const chordTones = beatInBar === 0 ? [0, 7] : [4, 11]
      for (const semis of chordTones) {
        const freq = root * Math.pow(2, semis / 12)
        this.scheduleChoirNote(beatTime, interval * 2.1, freq, this.choirGain, 0.25)
      }
    }

    // ---- Bell sparkle ----
    // Single high glittering chime on bar downbeats during chorus. Adds
    // the "champagne fizz" on top of brass without contributing to the
    // rhythmic density.
    if (profile.bellVol > 0 && this.bellGain && beatInBar === 0) {
      const baseRoot = useMinor ? 880 : 1046.5 // C6-ish
      const root = baseRoot * Math.pow(2, this.keyOffsetSemis / 12)
      this.scheduleBellNote(beatTime, 1.8, root, this.bellGain, 0.5)
      // A second bell a fifth up adds shimmer.
      this.scheduleBellNote(beatTime + interval * 0.5, 1.4, root * 1.5, this.bellGain, 0.32)
    }

    // ---- Lead synth (melodic hook) ----
    // The lead synth carries actual melody — phrased eighth-note runs,
    // sustained pad swells, or the hook motif depending on section.
    if (profile.leadVol > 0 && this.leadGain && beatInBar === 0) {
      const baseRoot = useMinor ? 440 : 523.25 // C5-ish
      const root = baseRoot * Math.pow(2, this.keyOffsetSemis / 12)
      const line = LEAD_LINES[profile.leadRole]
      if (line) {
        for (const note of line) {
          if (note.semis == null) continue
          const freq = root * Math.pow(2, note.semis / 12)
          const at = beatTime + note.beat * interval
          this.scheduleLeadNote(at, note.lenBeats * interval, freq, this.leadGain, note.vol)
        }
      }
    }
  }

  /**
   * Drum pattern selector. Each pattern names the section it most
   * naturally belongs to but is selectable independently so the
   * scheduler stays driven by data not by `if (section ===)` chains.
   */
  private scheduleDrums(
    pattern: DrumPattern,
    beatInBar: number,
    beatTime: number,
    interval: number,
    out: GainNode,
  ): void {
    switch (pattern) {
      case 'sparse': {
        // Intro: kick swell only on beat 0, no snare, soft quarter hat.
        if (beatInBar === 0) this.synthKick(beatTime, 0.55, out, true)
        this.synthHat(beatTime, 0.07, out)
        break
      }
      case 'four': {
        // Verse: classic four-on-floor + backbeat snare + quarter hat.
        if (beatInBar === 0 || beatInBar === 2) this.synthKick(beatTime, 0.55, out)
        if (beatInBar === 1 || beatInBar === 3) this.synthSnare(beatTime, 0.45, out)
        this.synthHat(beatTime, 0.12, out)
        // Subtle offbeat hat.
        this.synthHat(beatTime + interval * 0.5, 0.07, out)
        break
      }
      case 'four-plus': {
        // Pre-chorus: full kit + 16th hats + drum fill at end of bar.
        if (beatInBar === 0 || beatInBar === 2) this.synthKick(beatTime, 0.55, out)
        if (beatInBar === 1 || beatInBar === 3) this.synthSnare(beatTime, 0.45, out)
        for (let s = 0; s < 4; s += 1) this.synthHat(beatTime + interval * (s * 0.25), 0.09, out)
        // Drum fill on the last beat (snare roll into the chorus).
        if (beatInBar === 3) {
          this.synthSnare(beatTime + interval * 0.25, 0.22, out)
          this.synthSnare(beatTime + interval * 0.5, 0.28, out)
          this.synthSnare(beatTime + interval * 0.75, 0.35, out)
        }
        break
      }
      case 'driving': {
        // Chorus: kick everywhere + ghost snare on 3.5 + dense 16th hats.
        if (beatInBar === 0 || beatInBar === 2) this.synthKick(beatTime, 0.6, out)
        if (beatInBar === 3) this.synthKick(beatTime + interval * 0.5, 0.4, out) // push into next bar
        if (beatInBar === 1 || beatInBar === 3) this.synthSnare(beatTime, 0.5, out)
        if (beatInBar === 2) this.synthSnare(beatTime + interval * 0.5, 0.2, out) // ghost
        for (let s = 0; s < 4; s += 1) this.synthHat(beatTime + interval * (s * 0.25), 0.1, out)
        break
      }
      case 'half-time': {
        // Bridge: kick on 0, snare on 2 (the "3" of an 8-beat half-time
        // count). Sparse quarter hat. Feels like the song breathes.
        if (beatInBar === 0) this.synthKick(beatTime, 0.5, out)
        if (beatInBar === 2) this.synthSnare(beatTime, 0.4, out)
        this.synthHat(beatTime, 0.08, out)
        break
      }
    }
  }

  // ---- Synth voices ----

  private synthKick(at: number, vol: number, output?: GainNode, swell = false): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    if (swell) {
      // Intro: a slow swell that lands on the downbeat — like a heart-thump.
      osc.frequency.setValueAtTime(80, at - 0.06)
      osc.frequency.exponentialRampToValueAtTime(40, at + 0.25)
    } else {
      osc.frequency.setValueAtTime(160, at)
      osc.frequency.exponentialRampToValueAtTime(40, at + 0.15)
    }
    const gain = ctx.createGain()
    if (swell) {
      gain.gain.setValueAtTime(0, at - 0.1)
      gain.gain.linearRampToValueAtTime(vol, at)
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.3)
    } else {
      gain.gain.setValueAtTime(vol, at)
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.18)
    }
    osc.connect(gain).connect(output ?? this.master)
    osc.start(swell ? at - 0.1 : at)
    osc.stop(at + 0.32)
  }

  private synthSnare(at: number, vol: number, output?: GainNode): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const dur = 0.18
    const noise = makeNoiseBuffer(ctx, dur)
    const src = ctx.createBufferSource()
    src.buffer = noise
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 1200
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(vol, at)
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur)
    src.connect(hp).connect(gain).connect(output ?? this.master)
    src.start(at)
    src.stop(at + dur)

    const body = ctx.createOscillator()
    body.type = 'triangle'
    body.frequency.setValueAtTime(220, at)
    body.frequency.exponentialRampToValueAtTime(140, at + dur)
    const bg = ctx.createGain()
    bg.gain.setValueAtTime(vol * 0.4, at)
    bg.gain.exponentialRampToValueAtTime(0.001, at + dur)
    body.connect(bg).connect(output ?? this.master)
    body.start(at)
    body.stop(at + dur)
  }

  private synthHat(at: number, vol: number, output?: GainNode): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const dur = 0.05
    const noise = makeNoiseBuffer(ctx, dur)
    const src = ctx.createBufferSource()
    src.buffer = noise
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 6000
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(vol, at)
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur)
    src.connect(hp).connect(gain).connect(output ?? this.master)
    src.start(at)
    src.stop(at + dur)
  }

  /**
   * Sustained brass with mild vibrato + filter sweep. Designed to be
   * chained so a 4-note motif sounds like one breath.
   */
  private scheduleBrassNote(at: number, dur: number, freq: number, output: GainNode, peak: number): void {
    if (!this.ctx) return
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(freq, at)
    osc.frequency.linearRampToValueAtTime(freq, at + 0.04)
    const vibrato = ctx.createOscillator()
    const vibratoGain = ctx.createGain()
    vibrato.frequency.value = 5.5
    vibratoGain.gain.value = freq * 0.008
    vibrato.connect(vibratoGain).connect(osc.frequency)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(freq * 1.8, at)
    filter.frequency.linearRampToValueAtTime(freq * 3.5, at + dur * 0.4)
    filter.Q.value = 3
    const gain = ctx.createGain()
    const releaseStart = at + dur * 0.7
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(peak, at + 0.035)
    gain.gain.setValueAtTime(peak, releaseStart)
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur)
    osc.connect(filter).connect(gain).connect(output)
    osc.start(at)
    osc.stop(at + dur + 0.04)
    vibrato.start(at)
    vibrato.stop(at + dur + 0.04)
  }

  /**
   * Low brass / tuba: fat fundamental with a softer sub-octave, slow
   * attack, sustained body. Sits in the bass register and gives the
   * chorus weight.
   */
  private scheduleTubaNote(at: number, dur: number, freq: number, output: GainNode, peak = 0.2): void {
    if (!this.ctx) return
    const ctx = this.ctx
    // Fundamental as sawtooth (rich harmonics).
    const fund = ctx.createOscillator()
    fund.type = 'sawtooth'
    fund.frequency.setValueAtTime(freq, at)
    // Sub-octave sine for body.
    const sub = ctx.createOscillator()
    sub.type = 'sine'
    sub.frequency.setValueAtTime(freq * 0.5, at)
    // Sub-bass gentle detune for warmth.
    sub.detune.value = -5
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(freq * 3.2, at)
    filter.frequency.linearRampToValueAtTime(freq * 2.4, at + dur)
    filter.Q.value = 1.4
    const fundGain = ctx.createGain()
    fundGain.gain.value = 0.6
    const subGain = ctx.createGain()
    subGain.gain.value = 0.7
    fund.connect(fundGain).connect(filter)
    sub.connect(subGain).connect(filter)
    const gain = ctx.createGain()
    // Slow attack — feels like a deep breath into a big horn.
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(peak, at + 0.08)
    gain.gain.setValueAtTime(peak, at + dur * 0.7)
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur)
    filter.connect(gain).connect(output)
    fund.start(at)
    sub.start(at)
    fund.stop(at + dur + 0.05)
    sub.stop(at + dur + 0.05)
  }

  /**
   * Flute: airy sine + soft triangle + a touch of filtered breath
   * noise. Vibrato gives it expression; the breath layer is what
   * actually sells the "wind through a tube" character.
   */
  private scheduleFluteNote(at: number, dur: number, freq: number, output: GainNode, peak = 0.16): void {
    if (!this.ctx) return
    const ctx = this.ctx
    const body = ctx.createOscillator()
    body.type = 'sine'
    body.frequency.setValueAtTime(freq, at)
    const overtone = ctx.createOscillator()
    overtone.type = 'triangle'
    overtone.frequency.setValueAtTime(freq, at)
    overtone.detune.value = 4
    const vibrato = ctx.createOscillator()
    const vibratoGain = ctx.createGain()
    vibrato.frequency.value = 4.2
    vibratoGain.gain.value = freq * 0.006
    vibrato.connect(vibratoGain).connect(body.frequency)
    vibrato.connect(vibratoGain).connect(overtone.frequency)
    const bodyGain = ctx.createGain()
    bodyGain.gain.value = 1
    const overGain = ctx.createGain()
    overGain.gain.value = 0.35
    body.connect(bodyGain)
    overtone.connect(overGain)
    // Breath noise — quiet, filtered, gives the "fl-" of fluty.
    const breathLen = Math.min(dur, 0.4)
    const noise = makeNoiseBuffer(ctx, breathLen)
    const breath = ctx.createBufferSource()
    breath.buffer = noise
    const breathBP = ctx.createBiquadFilter()
    breathBP.type = 'bandpass'
    breathBP.frequency.value = freq * 1.5
    breathBP.Q.value = 0.8
    const breathGain = ctx.createGain()
    breathGain.gain.setValueAtTime(peak * 0.18, at)
    breathGain.gain.exponentialRampToValueAtTime(0.001, at + breathLen)
    breath.connect(breathBP).connect(breathGain)
    // Sum, then a final ADSR.
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(peak, at + 0.04)
    gain.gain.setValueAtTime(peak, at + dur * 0.75)
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur)
    bodyGain.connect(gain)
    overGain.connect(gain)
    breathGain.connect(gain)
    gain.connect(output)
    body.start(at)
    overtone.start(at)
    breath.start(at)
    vibrato.start(at)
    const stopAt = at + dur + 0.05
    body.stop(stopAt)
    overtone.stop(stopAt)
    breath.stop(at + breathLen)
    vibrato.stop(stopAt)
  }

  /**
   * Electronic arpeggio voice: tight square-wave pluck through a
   * resonant lowpass that snaps shut quickly. The percussive envelope
   * makes it bounce against the kick instead of muddying it.
   */
  private scheduleArpNote(at: number, dur: number, freq: number, output: GainNode): void {
    if (!this.ctx) return
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.setValueAtTime(freq, at)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    // Filter snap: open quickly, then close — gives the "ploink" pluck.
    lp.frequency.setValueAtTime(freq * 4, at)
    lp.frequency.exponentialRampToValueAtTime(freq * 1.5, at + dur)
    lp.Q.value = 6
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.12, at + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur)
    osc.connect(lp).connect(gain).connect(output)
    osc.start(at)
    osc.stop(at + dur + 0.02)
  }

  private scheduleBassNote(at: number, dur: number, freq: number, output: GainNode): void {
    if (!this.ctx) return
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, at)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(freq * 4, at)
    lp.frequency.exponentialRampToValueAtTime(freq * 1.5, at + dur)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.5, at + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur)
    osc.connect(lp).connect(gain).connect(output)
    osc.start(at)
    osc.stop(at + dur + 0.05)
  }

  /**
   * Synthesised "ahh" choir voice. Two detuned saws through a vowel-
   * formant bandpass produce the breathy vocal timbre — vibrato gives
   * it the living-pitch feel of an actual singer.
   *
   * Used both as a sustained pad (chorus / bridge) and as the visible
   * mermaid's voice when an enhanced beat fires.
   */
  private scheduleChoirNote(
    at: number,
    dur: number,
    freq: number,
    output: GainNode,
    peak = 0.18,
  ): void {
    if (!this.ctx) return
    const ctx = this.ctx
    // Two detuned saws give a chorus-y unison.
    const oscs: OscillatorNode[] = []
    for (const cents of [-7, 0, 9]) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(freq, at)
      osc.detune.setValueAtTime(cents, at)
      oscs.push(osc)
    }
    // Vibrato — 5Hz wobble of ~12 cents amplitude.
    const vibLfo = ctx.createOscillator()
    vibLfo.type = 'sine'
    vibLfo.frequency.value = 5.2
    const vibGain = ctx.createGain()
    vibGain.gain.value = 12 // ±12 cents
    vibLfo.connect(vibGain)
    for (const osc of oscs) vibGain.connect(osc.detune)
    // Vowel formant — bandpass around the "ah" formant (~700Hz) plus a
    // second one near 1100Hz layered in via the same filter Q.
    const bp1 = ctx.createBiquadFilter()
    bp1.type = 'bandpass'
    bp1.frequency.value = 700
    bp1.Q.value = 4
    const bp2 = ctx.createBiquadFilter()
    bp2.type = 'bandpass'
    bp2.frequency.value = 1100
    bp2.Q.value = 3
    // Slow ADSR envelope — long attack and release, sustained body.
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(peak, at + Math.min(0.45, dur * 0.25))
    gain.gain.setValueAtTime(peak * 0.85, at + dur * 0.75)
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur)
    // Connect: oscs → bp1 + bp2 (parallel) → gain → output
    const sum = ctx.createGain()
    sum.gain.value = 0.5
    for (const osc of oscs) {
      osc.connect(bp1)
      osc.connect(bp2)
    }
    bp1.connect(sum)
    bp2.connect(sum)
    sum.connect(gain).connect(output)
    for (const osc of oscs) {
      osc.start(at)
      osc.stop(at + dur + 0.1)
    }
    vibLfo.start(at)
    vibLfo.stop(at + dur + 0.1)
  }

  /**
   * Bright bell / chime — sine fundamental + inharmonic partials,
   * very short attack, long exponential decay. Used as sparkle on top
   * of chorus downbeats.
   */
  private scheduleBellNote(
    at: number,
    dur: number,
    freq: number,
    output: GainNode,
    peak = 0.5,
  ): void {
    if (!this.ctx) return
    const ctx = this.ctx
    // Partial ratios approximate a glockenspiel — 1.0, 2.76, 5.4.
    const partials: { ratio: number; level: number }[] = [
      { ratio: 1.0, level: 1.0 },
      { ratio: 2.76, level: 0.55 },
      { ratio: 5.4, level: 0.22 },
    ]
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(peak, at)
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur)
    gain.connect(output)
    for (const p of partials) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq * p.ratio
      const pg = ctx.createGain()
      pg.gain.value = p.level
      // Higher partials decay faster — that's what makes it "bell"-y
      // instead of "organ"-y.
      pg.gain.setValueAtTime(p.level, at)
      pg.gain.exponentialRampToValueAtTime(0.001, at + dur * (1.0 / p.ratio))
      osc.connect(pg).connect(gain)
      osc.start(at)
      osc.stop(at + dur + 0.05)
    }
  }

  /**
   * Lead synth voice — triangle + sawtooth blend through a resonant
   * lowpass with a brief sweep, gives a soft "soaring" lead tone that
   * sits naturally over the brass + strings without competing with them.
   */
  private scheduleLeadNote(
    at: number,
    dur: number,
    freq: number,
    output: GainNode,
    peak = 0.2,
  ): void {
    if (!this.ctx) return
    const ctx = this.ctx
    const osc1 = ctx.createOscillator()
    osc1.type = 'triangle'
    osc1.frequency.setValueAtTime(freq, at)
    const osc2 = ctx.createOscillator()
    osc2.type = 'sawtooth'
    osc2.frequency.setValueAtTime(freq, at)
    osc2.detune.setValueAtTime(6, at)
    const mix = ctx.createGain()
    mix.gain.value = 0.5
    const osc2Gain = ctx.createGain()
    osc2Gain.gain.value = 0.3
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(freq * 6, at)
    lp.frequency.exponentialRampToValueAtTime(freq * 2.2, at + Math.min(0.4, dur * 0.6))
    lp.Q.value = 3
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, at)
    env.gain.linearRampToValueAtTime(peak, at + Math.min(0.08, dur * 0.2))
    env.gain.setValueAtTime(peak * 0.7, at + dur * 0.7)
    env.gain.exponentialRampToValueAtTime(0.001, at + dur)
    osc1.connect(mix)
    osc2.connect(osc2Gain).connect(mix)
    mix.connect(lp).connect(env).connect(output)
    osc1.start(at); osc1.stop(at + dur + 0.08)
    osc2.start(at); osc2.stop(at + dur + 0.08)
  }

  // ---- Ambient layers ----

  private startStorm(): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const noise = makeNoiseBuffer(ctx, 4)
    const src = ctx.createBufferSource()
    src.buffer = noise
    src.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 700
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 100
    const gain = ctx.createGain()
    gain.gain.value = 0
    src.connect(hp).connect(lp).connect(gain).connect(this.master)
    src.start()
    this.stormNode = src
    this.stormGain = gain
  }

  private startStringPad(): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const gain = ctx.createGain()
    gain.gain.value = 0.04
    gain.connect(this.master)
    this.stringGain = gain
    const freqs = [196.0, 233.08, 293.66]
    for (const freq of freqs) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      const lfo = ctx.createOscillator()
      const lfoGain = ctx.createGain()
      lfo.frequency.value = 0.18 + Math.random() * 0.2
      lfoGain.gain.value = freq * 0.004
      lfo.connect(lfoGain)
      lfoGain.connect(osc.frequency)
      osc.connect(gain)
      osc.start()
      lfo.start()
      this.stringOscs.push(osc, lfo)
    }
  }

  private shortPing(freq: number, dur: number, type: OscillatorType, vol: number): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t0)
    osc.frequency.exponentialRampToValueAtTime(freq * 0.7, t0 + dur)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(vol, t0)
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
    osc.connect(gain).connect(this.master)
    osc.start(t0)
    osc.stop(t0 + dur)
  }

  private brassNote(
    freq: number,
    dur: number,
    delay: number,
    type: OscillatorType = 'sawtooth',
    vol = 0.18,
  ): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const t0 = ctx.currentTime + delay
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t0)
    const vibrato = ctx.createOscillator()
    const vibratoGain = ctx.createGain()
    vibrato.frequency.value = 5.5
    vibratoGain.gain.value = freq * 0.01
    vibrato.connect(vibratoGain).connect(osc.frequency)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(freq * 2, t0)
    filter.frequency.exponentialRampToValueAtTime(freq * 4, t0 + 0.05)
    filter.Q.value = 4
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, t0)
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.04)
    gain.gain.linearRampToValueAtTime(vol * 0.7, t0 + dur * 0.6)
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
    osc.connect(filter).connect(gain).connect(this.master)
    osc.start(t0)
    osc.stop(t0 + dur + 0.05)
    vibrato.start(t0)
    vibrato.stop(t0 + dur + 0.05)
  }
}

// ============================================================
// Song structure data
// ============================================================

/**
 * Public name of one of the five musical sections. Exported so that
 * BattleState can pick a section based on session catch count without
 * stringly-typing the value.
 */
export type Section = 'intro' | 'verse' | 'preChorus' | 'chorus' | 'bridge'

/**
 * Pick the section a new battle should *open* at based on how many
 * fish the player has caught this session.
 *
 *   catches < 1 (1st fight): intro     — full arc, slow build
 *   catches < 2 (2nd fight): verse     — already in the groove
 *   catches < 4 (3rd–4th):   preChorus — straight into the build-up
 *   catches >= 4:            chorus    — boss time, key changes early
 */
export function sectionForCatches(catches: number): Section {
  if (catches >= 4) return 'chorus'
  if (catches >= 2) return 'preChorus'
  if (catches >= 1) return 'verse'
  return 'intro'
}

/**
 * Pick the section a new battle should *open* at based on the run's
 * depth STAGE (0..14). The arrangement thickens as the player descends:
 * the shallows open sparse, and by mid-run every fight starts straight
 * in the full chorus — after which tighter timing + faster tempo carry
 * the remaining escalation.
 *
 *   stage 0       : intro     (sparse, slow build)
 *   stage 1–2     : verse     (in the groove)
 *   stage 3–4     : preChorus (build-up)
 *   stage 5+      : chorus    (full arrangement, key changes)
 */
export function sectionForStage(stageIndex: number): Section {
  if (stageIndex >= 5) return 'chorus'
  if (stageIndex >= 3) return 'preChorus'
  if (stageIndex >= 1) return 'verse'
  return 'intro'
}

/**
 * The RESTING bed richness for a given depth stage — what the song
 * relaxes to between fights. Always trails the in-battle section so a
 * fight still feels like a lift, but climbs with depth so the bed gets
 * permanently richer as the run progresses.
 *
 *   stage 0–1 : verse     (base: four-on-floor + ~3 instruments)
 *   stage 2–4 : preChorus (build-up layers added)
 *   stage 5+  : chorus     (full arrangement is the new resting state)
 */
export function bedFloorForStage(stageIndex: number): Section {
  if (stageIndex >= 5) return 'chorus'
  if (stageIndex >= 2) return 'preChorus'
  return 'verse'
}

/**
 * Coarse rank for comparing section "richness" (intro < verse/bridge <
 * preChorus < chorus). Used to keep the resting bed monotonic and to
 * decide whether to raise/lower the song without restarting it.
 */
const SECTION_RANK: Record<Section, number> = {
  intro: 0,
  verse: 1,
  bridge: 1,
  preChorus: 2,
  chorus: 3,
}

type DrumPattern = 'sparse' | 'four' | 'four-plus' | 'driving' | 'half-time'

type FluteRole = 'off' | 'accents' | 'counter' | 'lead'

type LeadRole = 'off' | 'pad' | 'hook' | 'melody'

interface SectionProfile {
  /** NoteLane density level this section maps to (0..3). */
  noteDensity: 0 | 1 | 2 | 3
  drumPattern: DrumPattern
  /** Base mixer levels. Combined with weather/key shifts at play time. */
  drumVol: number
  brassVol: number
  tubaVol: number
  fluteVol: number
  bassVol: number
  padVol: number
  arpVol: number
  /** Vocal "ahh" choir layer level. Sustained 2-beat chord-tone pads
   *  in chorus, off in intro/verse. */
  choirVol: number
  /** Bell sparkle level — rings on chorus downbeats only. */
  bellVol: number
  /** Lead synth level — plays the section's `leadRole` line. */
  leadVol: number
  /** Sub-bass walking-note pattern across the 4 beats of a bar. */
  bassPattern: number[]
  /**
   * 16-slot (= 4 beats × 4 sixteenths) arpeggio pattern in semitones-
   * from-root. `null` slot = silence. Length must be exactly 16.
   */
  arpPattern: (number | null)[]
  fluteRole: FluteRole
  leadRole: LeadRole
  /** Auto-resolve duration for sections that move on by themselves. */
  barsLength: number
}

/** 16 slots = 4 beats × 4 sixteenths. `_` is silence. */
const _ = null
const SECTION_PROFILES: Record<Section, SectionProfile> = {
  intro: {
    noteDensity: 0,
    drumPattern: 'sparse',
    drumVol: 0.28,
    brassVol: 0,
    tubaVol: 0,
    fluteVol: 0,
    bassVol: 0,
    padVol: 0.18,
    arpVol: 0,
    choirVol: 0,
    bellVol: 0,
    leadVol: 0.08,
    bassPattern: [0, 0, 0, 0],
    arpPattern: [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
    fluteRole: 'off',
    leadRole: 'pad', // soft sustained pad opens the song
    barsLength: 2,
  },
  verse: {
    noteDensity: 1,
    drumPattern: 'four',
    drumVol: 0.5,
    brassVol: 0,
    tubaVol: 0,
    fluteVol: 0.12,
    bassVol: 0.16,
    padVol: 0.08,
    // Subtle off-beat arp pulses (only the &-of-each-beat) so it lives
    // *between* the four-on-floor kicks instead of doubling them.
    arpVol: 0.08,
    choirVol: 0,
    bellVol: 0,
    leadVol: 0.14, // The lead synth carries the verse melody.
    bassPattern: [0, 7, 5, 7],
    arpPattern: [_, _, 7, _, _, _, 12, _, _, _, 7, _, _, _, 5, _],
    fluteRole: 'accents',
    leadRole: 'melody',
    barsLength: 4,
  },
  preChorus: {
    noteDensity: 2,
    drumPattern: 'four-plus',
    drumVol: 0.6,
    brassVol: 0.18,
    tubaVol: 0,
    fluteVol: 0,
    bassVol: 0.2,
    padVol: 0.1,
    // 8th-note arp climbing into the chorus.
    arpVol: 0.12,
    choirVol: 0.05,
    bellVol: 0,
    leadVol: 0.16,
    bassPattern: [0, 5, 7, 10], // climbing line into chorus
    arpPattern: [0, _, 5, _, 7, _, 10, _, 0, _, 5, _, 7, _, 12, _],
    fluteRole: 'off',
    leadRole: 'hook', // recognisable lift-off motif
    barsLength: 2,
  },
  chorus: {
    noteDensity: 3,
    drumPattern: 'driving',
    drumVol: 0.7,
    brassVol: 0.22,
    tubaVol: 0.18,
    fluteVol: 0.15,
    bassVol: 0.22,
    padVol: 0.08,
    // Full 16th-note electronic arp — the "EDM driver" the chorus needs.
    arpVol: 0.13,
    // Sustained choir "ah" + sparkle bell on the downbeat make the
    // chorus feel cinematic and lift the whole arrangement.
    choirVol: 0.12,
    bellVol: 0.18,
    leadVol: 0.18,
    bassPattern: [0, 0, 7, 7],
    arpPattern: [0, 7, 12, 7, 0, 7, 12, 7, 5, 12, 17, 12, 7, 12, 19, 12],
    fluteRole: 'counter',
    leadRole: 'hook',
    barsLength: 4,
  },
  bridge: {
    noteDensity: 1,
    drumPattern: 'half-time',
    drumVol: 0.36,
    brassVol: 0,
    tubaVol: 0,
    fluteVol: 0.2,
    bassVol: 0.12,
    padVol: 0.22,
    // Bridge drops arp completely so the flute lead sits unchallenged.
    arpVol: 0,
    // Choir takes over from arp during the bridge — gives an open,
    // breathing texture beneath the flute lead.
    choirVol: 0.14,
    bellVol: 0,
    leadVol: 0.08,
    bassPattern: [0, 0, 5, 5],
    arpPattern: [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
    fluteRole: 'lead',
    leadRole: 'pad',
    barsLength: 4,
  },
}

/**
 * Where each section moves when the player *pushes* the song forward
 * (i.e. nails an enhanced beat). Chorus loops on itself because at
 * that point we modulate the key up instead.
 */
const SECTION_FLOW: Record<Section, Section> = {
  intro: 'verse',
  verse: 'preChorus',
  preChorus: 'chorus',
  chorus: 'chorus',
  // Bridge → chorus (not verse) so a player who pushes back during the
  // calm part feels like they re-ignited the song instantly, rather
  // than having to climb the whole verse → preChorus → chorus ladder again.
  bridge: 'chorus',
}

/**
 * Where each section drops when the player has been *quiet*. The
 * chorus dropping to a bridge mirrors how a real song breathes.
 */
const SECTION_DECAY: Record<Section, Section> = {
  intro: 'intro',
  verse: 'verse',
  preChorus: 'verse',
  chorus: 'bridge',
  bridge: 'verse',
}

/**
 * Four 4-beat brass motifs in semitones-from-root. Picked at section
 * advance time so the next chorus feels distinct from the last one.
 * Notes intentionally avoid the major 7th since it clashes with the
 * sad string pad we keep running underneath.
 */
const MOTIFS: number[][] = [
  [0, 7, 5, 3],   // heroic call-and-response
  [3, 7, 10, 12], // climbing line
  [12, 7, 5, 3],  // descending fanfare
  [0, 0, 7, 12],  // syncopated punch
]

/**
 * Flute lines per role. Each entry is a note position inside the
 * 4-beat bar with its length (also in beats). Scale degrees are in
 * semitones from the current root.
 *
 * - 'accents' (verse): tiny floating high punctuations on the and-of-4.
 * - 'counter' (chorus): answers the brass — brass owns beats 0-1,
 *   flute weaves through beats 2-3.
 * - 'lead' (bridge): a flowing melody across the whole bar that
 *   becomes the focal point now that drums have dropped to half-time.
 */
const FLUTE_LINES: Record<FluteRole, { beat: number; lenBeats: number; semis: number | null; vol: number }[] | null> = {
  off: null,
  accents: [
    { beat: 3.5, lenBeats: 0.3, semis: 12, vol: 0.12 },
  ],
  counter: [
    // brass plays motif on 0..1, flute answers on 2..3
    { beat: 2.0, lenBeats: 0.5, semis: 7, vol: 0.14 },
    { beat: 2.5, lenBeats: 0.5, semis: 12, vol: 0.13 },
    { beat: 3.0, lenBeats: 1.0, semis: 10, vol: 0.15 },
  ],
  lead: [
    // a singing line across the whole bar
    { beat: 0.0, lenBeats: 1.0, semis: 7, vol: 0.18 },
    { beat: 1.0, lenBeats: 0.5, semis: 10, vol: 0.16 },
    { beat: 1.5, lenBeats: 0.5, semis: 7, vol: 0.15 },
    { beat: 2.0, lenBeats: 1.5, semis: 12, vol: 0.18 },
    { beat: 3.5, lenBeats: 0.5, semis: 10, vol: 0.14 },
  ],
}

/**
 * Lead-synth lines per role. Same schema as flute lines but optimised
 * for the lead voice's more sustained timbre.
 *
 * - 'pad': two long sustained notes per bar — used in intro/bridge for
 *   atmospheric body without competing with the flute's melodic role.
 * - 'melody': a singable 8-note phrase across the bar — this is the
 *   "verse melody" that should be the part players hum afterward.
 * - 'hook': a punchy 3-note motif on the first half of the bar; the
 *   "chorus hook" the brass + bell + choir layer together hits.
 */
const LEAD_LINES: Record<LeadRole, { beat: number; lenBeats: number; semis: number | null; vol: number }[] | null> = {
  off: null,
  pad: [
    { beat: 0.0, lenBeats: 2.0, semis: 7, vol: 0.12 },
    { beat: 2.0, lenBeats: 2.0, semis: 12, vol: 0.12 },
  ],
  melody: [
    // A "verse motif" — singable phrase that returns each bar so the
    // player learns it. Mixes step-wise and leap motion for character.
    { beat: 0.0, lenBeats: 0.5, semis: 7, vol: 0.16 },
    { beat: 0.5, lenBeats: 0.5, semis: 9, vol: 0.16 },
    { beat: 1.0, lenBeats: 1.0, semis: 12, vol: 0.18 },
    { beat: 2.0, lenBeats: 0.5, semis: 10, vol: 0.16 },
    { beat: 2.5, lenBeats: 0.5, semis: 7, vol: 0.14 },
    { beat: 3.0, lenBeats: 1.0, semis: 5, vol: 0.15 },
  ],
  hook: [
    // A "chorus hook" — three accented hits over the first half of the
    // bar with a sustained landing note. Lines up with the brass motif's
    // beats 0/1/2 so they reinforce each other on the downbeat.
    { beat: 0.0, lenBeats: 0.5, semis: 12, vol: 0.2 },
    { beat: 0.5, lenBeats: 0.5, semis: 10, vol: 0.18 },
    { beat: 1.0, lenBeats: 1.0, semis: 7, vol: 0.2 },
    { beat: 2.0, lenBeats: 2.0, semis: 14, vol: 0.2 },
  ],
}

function makeNoiseBuffer(ctx: AudioContext, durationSeconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * durationSeconds))
  const buf = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < length; i += 1) {
    data[i] = Math.random() * 2 - 1
  }
  return buf
}
