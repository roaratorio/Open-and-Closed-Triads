// Triad Progressions — parse Am/F/G/Cm + slash chords (Am/E)
// Voicing: close / open / voice-led (smart inversions + octave placements)
// Register clamp + MIDI export (block or arpUp) + p5 visual
//
// New in this version:
// - Bass line smoothness slider: weight 0..3
// - Slash bass rule:
//   - if slash pc is in the triad => DO NOT double; force inversion so slash tone is the lowest triad tone.
//   - if slash pc is NOT in triad => add as extra bass note, octave-picked to be smooth vs previous bass.
// - Bass is kept below C4 (MIDI 60) where clamp range allows.
// - Voice-led selection uses weighted cost: upper-voice motion + bassWeight * bass motion.
// - Triads containing a note (pitch-class) => clickable chips that append to progression and regenerate.

let seqSymbols = [];      // [{sym, rootPc, qual, slashPc|null}]
let seqChords = [];       // voiced MIDI arrays (per chord)
let hoverStep = -1;

let cnv, canvasPanelEl;

// -------------------- Utilities --------------------

const NOTE_TO_SEMITONE = {
  "C":0, "C#":1, "Db":1, "D":2, "D#":3, "Eb":3, "E":4, "Fb":4, "E#":5, "F":5,
  "F#":6, "Gb":6, "G":7, "G#":8, "Ab":8, "A":9, "A#":10, "Bb":10, "B":11, "Cb":11, "B#":0
};
const SEMI_TO_NAME = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

const BASS_CEILING_MIDI = 60; // keep bass below C4 if possible

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function sortAsc(a) { return a.slice().sort((x,y)=>x-y); }

function noteToMidi(token) {
  if (typeof token === "number") return Math.round(token);
  const s = String(token).trim();
  if (!s) return NaN;

  if (/^-?\d+$/.test(s)) return parseInt(s, 10);

  const m = s.match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
  if (!m) return NaN;

  const name = m[1].toUpperCase() + (m[2] || "");
  const oct = parseInt(m[3], 10);
  const semi = NOTE_TO_SEMITONE[name];
  if (semi == null) return NaN;

  return (oct + 1) * 12 + semi; // MIDI: C4=60
}

function midiToNote(m) {
  const pc = ((m % 12) + 12) % 12;
  const oct = Math.floor(m / 12) - 1;
  return `${SEMI_TO_NAME[pc]}${oct}`;
}

function parseRangeBounds(loStr, hiStr) {
  const lo = clamp(Math.round(noteToMidi(loStr)), 0, 127);
  const hi = clamp(Math.round(noteToMidi(hiStr)), 0, 127);
  if (Number.isNaN(lo) || Number.isNaN(hi)) {
    throw new Error("Register bounds invalid. Use note names like C2/C6 or MIDI numbers like 36/84.");
  }
  if (lo >= hi) throw new Error("Register bounds invalid: Low must be less than High.");
  return { lo, hi };
}

// choose a midi pitch for a pitch-class near a target centre
function midiNear(pc, targetMidi) {
  const baseOct = Math.floor(targetMidi / 12);
  let best = null;
  let bestCost = 1e9;
  for (let o = baseOct - 2; o <= baseOct + 2; o++) {
    const cand = o * 12 + pc;
    const cost = Math.abs(cand - targetMidi);
    if (cand >= 0 && cand <= 127 && cost < bestCost) {
      bestCost = cost;
      best = cand;
    }
  }
  return best == null ? clamp(targetMidi, 0, 127) : best;
}

// -------------------- Chord parsing --------------------
// Accept: C, F#, Bb, Am, Cm, D#m
// Slash: Am/E, F/C, Cm/G
function parseChordToken(tok) {
  const raw = String(tok || "").trim();
  if (!raw) return null;

  const parts = raw.split("/");
  const chordPart = parts[0].trim();
  const slashPart = parts[1] ? parts[1].trim() : null;

  const m = chordPart.match(/^([A-Ga-g])([#b]?)(m|maj)?$/);
  if (!m) throw new Error(`Invalid chord: "${raw}". Use e.g. Am, F, G#, Bb, Cm, D#m, or Am/E.`);

  const rootName = m[1].toUpperCase() + (m[2] || "");
  const q = (m[3] || "").toLowerCase();
  const qual = (q === "m") ? "min" : "maj";

  const rootPc = NOTE_TO_SEMITONE[rootName];
  if (rootPc == null) throw new Error(`Invalid chord root: "${rootName}".`);

  let slashPc = null;
  if (slashPart) {
    const sm = slashPart.match(/^([A-Ga-g])([#b]?)$/);
    if (!sm) throw new Error(`Invalid slash bass: "${slashPart}" in "${raw}". Use e.g. Am/E, F/C.`);
    const sname = sm[1].toUpperCase() + (sm[2] || "");
    slashPc = NOTE_TO_SEMITONE[sname];
    if (slashPc == null) throw new Error(`Invalid slash bass: "${sname}" in "${raw}".`);
  }

  return { sym: raw, rootPc, qual, slashPc };
}

function parseProgression(str) {
  const toks = String(str || "")
    .trim()
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!toks.length) throw new Error("Please enter at least one chord (e.g. Am, F, G, Cm, Am/E).");
  return toks.map(parseChordToken).filter(Boolean);
}

// -------------------- Triads / voicings --------------------

function triadPCs(rootPc, qual) {
  const third = (qual === "min") ? 3 : 4;
  return [rootPc, (rootPc + third) % 12, (rootPc + 7) % 12];
}

function voiceClose(rootMidi, qual) {
  const pcs = triadPCs(rootMidi % 12, qual);
  let r = rootMidi;
  let t = midiNear(pcs[1], r + 4);
  let f = midiNear(pcs[2], r + 7);

  let arr = sortAsc([r, t, f]);
  for (let i = 1; i < arr.length; i++) while (arr[i] <= arr[i-1]) arr[i] += 12;
  return sortAsc(arr.map(n => clamp(n, 0, 127)));
}

function voiceOpen(rootMidi, qual) {
  const pcs = triadPCs(rootMidi % 12, qual);
  let r = rootMidi;
  let f = midiNear(pcs[2], r + 7);
  let t = midiNear(pcs[1], r + 16);

  let arr = sortAsc([r, f, t]);
  for (let i = 1; i < arr.length; i++) while (arr[i] <= arr[i-1]) arr[i] += 12;
  return sortAsc(arr.map(n => clamp(n, 0, 127)));
}

// clamp chord into [lo,hi] by octave shifting preserving pitch classes
function fitChordToRange(ch, lo, hi) {
  let x = sortAsc(ch);
  if (!x.length) return x;

  while (Math.min(...x) < lo) x = x.map(n => n + 12);
  while (Math.max(...x) > hi) x = x.map(n => n - 12);

  for (let i = 0; i < x.length; i++) {
    let n = x[i];
    while (n < lo) n += 12;
    while (n > hi) n -= 12;

    if (i > 0) {
      while (n <= x[i-1]) n += 12;
      while (n > hi && (n - 12) > x[i-1] && (n - 12) >= lo) n -= 12;
    }
    x[i] = clamp(n, 0, 127);
  }

  while (Math.min(...x) < lo) x = x.map(n => n + 12);
  while (Math.max(...x) > hi) x = x.map(n => n - 12);

  return sortAsc(x.map(n => clamp(n, 0, 127)));
}

// Keep bass below C4 if possible (and range allows)
function enforceBassBelowC4(ch, lo, hi) {
  if (!ch || !ch.length) return ch;
  if (lo >= BASS_CEILING_MIDI) return fitChordToRange(ch, lo, hi);

  let x = sortAsc(ch).map(n => clamp(n, 0, 127));

  while (x[0] >= BASS_CEILING_MIDI) x[0] -= 12;
  while (x[0] < lo) x[0] += 12;

  for (let i = 1; i < x.length; i++) while (x[i] <= x[i-1]) x[i] += 12;

  return fitChordToRange(x, lo, hi);
}

// Apply slash bass:
// - If slashPc is a chord tone: NO doubling; force inversion so slash tone is lowest triad tone.
// - Else: add extra bass note, octave chosen near prevBassMidi for smoothness.
function applySlashBass(ch, slashPc, targetBassMidi, lo, hi, prevBassMidi = null, bassWeight = 1.0) {
  if (slashPc == null) return ch;

  let chord = sortAsc(ch);
  const wantPc = ((slashPc % 12) + 12) % 12;

  const pcsInChord = chord.map(n => ((n % 12) + 12) % 12);
  const contains = pcsInChord.includes(wantPc);

  if (contains) {
    // Force inversion so a matching chord tone is the bass, without adding extra note.
    let best = null;
    let bestScore = 1e18;

    for (let idx = 0; idx < chord.length; idx++) {
      const n0 = chord[idx];
      if (((n0 % 12) + 12) % 12 !== wantPc) continue;

      const others = chord.filter((_, j) => j !== idx);

      let bass = n0;
      const bassCeil = (lo < BASS_CEILING_MIDI) ? (BASS_CEILING_MIDI - 1) : hi;

      while (bass > bassCeil) bass -= 12;
      while (bass < lo) bass += 12;

      let stacked = [bass, ...others].map(n => clamp(n, 0, 127));
      stacked = sortAsc(stacked);

      // restack above bass
      for (let i = 1; i < stacked.length; i++) while (stacked[i] <= stacked[i - 1]) stacked[i] += 12;

      stacked = fitChordToRange(stacked, lo, hi);
      stacked = enforceBassBelowC4(stacked, lo, hi);

      const bassNow = stacked[0];
      const bassCost = (prevBassMidi == null) ? 0 : Math.abs(bassNow - prevBassMidi);
      const score = bassWeight * bassCost;

      if (score < bestScore) {
        bestScore = score;
        best = stacked;
      }
    }

    return best ? best : enforceBassBelowC4(fitChordToRange(chord, lo, hi), lo, hi);
  }

  // slash is NOT chord tone: add extra bass note
  const target = (prevBassMidi == null) ? targetBassMidi : prevBassMidi;
  let bass = midiNear(wantPc, target);
  bass = clamp(bass, 0, 127);

  if (lo < BASS_CEILING_MIDI) {
    while (bass >= BASS_CEILING_MIDI) bass -= 12;
    while (bass < lo) bass += 12;
  } else {
    while (bass < lo) bass += 12;
  }

  const lowest = Math.min(...chord);
  while (bass >= lowest) bass -= 12;
  while (bass < lo) bass += 12;

  bass = clamp(bass, 0, 127);

  const out = [bass, ...chord];
  return enforceBassBelowC4(fitChordToRange(out, lo, hi), lo, hi);
}

// -------------------- Voice-led (smart candidates) --------------------

function motionCost(prevChord, candChord) {
  const a = sortAsc(prevChord);
  const b = sortAsc(candChord);
  const L = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < L; i++) s += Math.abs(a[i] - b[i]);
  return s;
}

function candidatesForTriad(rootPc, qual, targetMidi, lo, hi) {
  const pcs = triadPCs(rootPc, qual);

  // inversions (lowest voice first, as pcs)
  const inversions = [
    [pcs[0], pcs[1], pcs[2]],
    [pcs[1], pcs[2], pcs[0]],
    [pcs[2], pcs[0], pcs[1]]
  ];

  const cands = [];
  for (const inv of inversions) {
    const base = midiNear(inv[0], targetMidi);

    for (let shift = -2; shift <= 2; shift++) {
      let a = base + 12 * shift;
      let b = midiNear(inv[1], a + 4);
      let c = midiNear(inv[2], b + 4);

      while (b <= a) b += 12;
      while (c <= b) c += 12;

      const chord = fitChordToRange([a, b, c], lo, hi);
      cands.push(chord);
    }
  }

  // de-dupe
  const seen = new Set();
  const uniq = [];
  for (const ch of cands) {
    const key = ch.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(ch);
  }
  return uniq;
}

function voiceLeadSequenceSmart(chordSpecs, lo, hi, bassWeight) {
  const out = [];
  let prev = null;

  const targetTriad = 60; // centre for triad body
  const targetBass = lo + Math.round((hi - lo) * 0.20);

  for (const spec of chordSpecs) {
    const rootPc = ((spec.rootMidi % 12) + 12) % 12;
    const cands = candidatesForTriad(rootPc, spec.qual, targetTriad, lo, hi);

    let best = null;
    let bestScore = 1e18;

    const prevBass = prev ? sortAsc(prev)[0] : null;

    // evaluate candidates AFTER applying slash (because slash affects bass & doubling rules)
    const fallback = fitChordToRange(voiceClose(spec.rootMidi, spec.qual), lo, hi);
    const pool = cands.length ? cands : [fallback];

    for (const cand of pool) {
      let ch = fitChordToRange(cand, lo, hi);
      ch = applySlashBass(ch, spec.slashPc, targetBass, lo, hi, prevBass, bassWeight);
      ch = enforceBassBelowC4(ch, lo, hi);

      // motion
      const upper = prev ? motionCost(prev, ch) : 0;
      const bass = (prevBass == null || !ch.length) ? 0 : Math.abs(ch[0] - prevBass);
      const score = upper + bassWeight * bass;

      if (score < bestScore) {
        bestScore = score;
        best = ch;
      }
    }

    if (!best) best = enforceBassBelowC4(fallback, lo, hi);

    out.push(best);
    prev = best;
  }

  return out;
}

// -------------------- Processing pipeline --------------------

function generateSequence() {
  const progStr = document.getElementById("progIn")?.value ?? "";
  const voicingMode = document.getElementById("voicingSel")?.value || "close";
  const bassWeight = clamp(Number(document.getElementById("bassWeight")?.value ?? 1.2), 0, 3);

  const { lo, hi } = parseRangeBounds(
    document.getElementById("rangeLo")?.value ?? "C2",
    document.getElementById("rangeHi")?.value ?? "C6"
  );

  seqSymbols = parseProgression(progStr);

  // choose a root register target around C4-ish
  const targetRoot = 60;
  const chordSpecs = seqSymbols.map(obj => {
    const rootMidi = midiNear(obj.rootPc, targetRoot);
    return { rootMidi, qual: obj.qual, slashPc: obj.slashPc, sym: obj.sym };
  });

  let voiced = [];

  if (voicingMode === "voicelead") {
    voiced = voiceLeadSequenceSmart(chordSpecs, lo, hi, bassWeight);
  } else {
    const baseVoicer = (voicingMode === "open") ? voiceOpen : voiceClose;
    const targetBass = lo + Math.round((hi - lo) * 0.20);

    let prevBass = null;

    voiced = chordSpecs.map(spec => {
      let ch = baseVoicer(spec.rootMidi, spec.qual);
      ch = fitChordToRange(ch, lo, hi);

      ch = applySlashBass(ch, spec.slashPc, targetBass, lo, hi, prevBass, bassWeight);
      ch = enforceBassBelowC4(ch, lo, hi);

      prevBass = ch.length ? ch[0] : prevBass;
      return ch;
    });
  }

  seqChords = voiced;
  updateOutputs(lo, hi);
}

function updateOutputs(lo, hi) {
  const statusOut = document.getElementById("statusOut");
  const seqOut = document.getElementById("seqOut");

  const voicingMode = document.getElementById("voicingSel")?.value || "close";
  const bassWeight = clamp(Number(document.getElementById("bassWeight")?.value ?? 1.2), 0, 3);

  const bassRule = (lo < BASS_CEILING_MIDI) ? "bass < C4 enforced" : "bass < C4 not possible (clamp low >= C4)";

  if (statusOut) {
    statusOut.textContent =
      `Chords = ${seqChords.length}\n` +
      `Voicing = ${voicingMode}\n` +
      `Bass smoothness weight = ${bassWeight.toFixed(1)}\n` +
      `Clamp range = ${midiToNote(lo)} (${lo}) → ${midiToNote(hi)} (${hi})\n` +
      `Bass rule = ${bassRule}\n` +
      `Parsed: ${seqSymbols.map(x => x.sym).join(" | ")}\n`;
  }

  const lines = seqChords.map((ch, i) => {
    const sym = seqSymbols[i]?.sym ?? "?";
    return `${String(i+1).padStart(2,"0")}. ${sym.padEnd(6," ")}  ${ch.map(midiToNote).join(" ")}   (${ch.join(",")})`;
  });

  if (seqOut) seqOut.textContent = lines.length ? lines.join("\n") : "(not generated yet)";
}

// -------------------- MIDI Export (type 0, single track) --------------------

function buildMidiFile(events, opts) {
  const ticksPerBeat = opts.ticksPerBeat ?? 480;
  const bpm = opts.bpm ?? 60;
  const chordDurationBeats = opts.chordDurationBeats ?? 2;

  const style = opts.style ?? "block";            // "block" | "arpUp"
  const arpStepBeats = opts.arpStepBeats ?? 0.25;
  const gate = clamp(opts.gate ?? 0.85, 0.05, 0.98);
  const restBeats = opts.restBeats ?? 0.5;

  const baseVelocity = clamp(opts.velocity ?? 75, 1, 127);
  const minVelocity = clamp(opts.minVelocity ?? 30, 1, 127);
  const singleNoteCap = clamp(opts.singleNoteCap ?? 52, 1, 127);

  const channel = clamp(opts.channel ?? 0, 0, 15);
  const program = clamp(opts.program ?? 0, 0, 127);

  const beatToTicks = (beats) => Math.max(1, Math.round(ticksPerBeat * beats));

  const header = [];
  pushStr(header, "MThd");
  pushU32(header, 6);
  pushU16(header, 0); // format 0
  pushU16(header, 1); // one track
  pushU16(header, ticksPerBeat);

  const track = [];

  const mpqn = Math.round(60000000 / bpm);
  pushVar(track, 0);
  track.push(0xFF, 0x51, 0x03);
  track.push((mpqn >> 16) & 0xFF, (mpqn >> 8) & 0xFF, mpqn & 0xFF);

  // 4/4
  pushVar(track, 0);
  track.push(0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);

  // Program change
  pushVar(track, 0);
  track.push(0xC0 | channel, program);

  if (style === "arpUp") {
    const stepTicks = beatToTicks(arpStepBeats);
    const noteTicks = Math.max(1, Math.round(stepTicks * gate));
    const gapTicks = Math.max(0, stepTicks - noteTicks);
    const restTicks = beatToTicks(restBeats);

    let carryDelta = 0;

    for (const chord of events) {
      const notes = Array.from(new Set((chord || []).map(n => clamp(n, 0, 127)))).sort((a,b)=>a-b);
      if (!notes.length) continue;

      let v = clamp(Math.round(baseVelocity / Math.sqrt(Math.max(1, notes.length))), minVelocity, 127);
      if (notes.length === 1) v = Math.min(v, singleNoteCap);

      for (let i = 0; i < notes.length; i++) {
        pushVar(track, i === 0 ? carryDelta : gapTicks);
        track.push(0x90 | channel, notes[i], v);

        pushVar(track, noteTicks);
        track.push(0x90 | channel, notes[i], 0);
      }

      carryDelta = restTicks;
    }

    // final wait (optional)
    pushVar(track, carryDelta);
  } else {
    const chordTicks = beatToTicks(chordDurationBeats);

    for (const chord of events) {
      const notes = Array.from(new Set((chord || []).map(n => clamp(n, 0, 127)))).sort((a,b)=>a-b);
      if (!notes.length) continue;

      let v = clamp(Math.round(baseVelocity / Math.sqrt(Math.max(1, notes.length))), minVelocity, 127);
      if (notes.length === 1) v = Math.min(v, singleNoteCap);

      for (let i = 0; i < notes.length; i++) {
        pushVar(track, 0);
        track.push(0x90 | channel, notes[i], v);
      }

      for (let i = 0; i < notes.length; i++) {
        pushVar(track, i === 0 ? chordTicks : 0);
        track.push(0x90 | channel, notes[i], 0);
      }
    }

    pushVar(track, 0);
  }

  // End of track
  track.push(0xFF, 0x2F, 0x00);

  const trackChunk = [];
  pushStr(trackChunk, "MTrk");
  pushU32(trackChunk, track.length);
  trackChunk.push(...track);

  return new Uint8Array([...header, ...trackChunk]);
}

function downloadBytes(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

// MIDI helpers
function pushStr(arr, s) { for (let i = 0; i < s.length; i++) arr.push(s.charCodeAt(i)); }
function pushU16(arr, n) { arr.push((n >> 8) & 0xFF, n & 0xFF); }
function pushU32(arr, n) { arr.push((n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF); }
function pushVar(arr, value) {
  let v = value >>> 0;
  let buffer = v & 0x7F;
  while ((v >>= 7)) {
    buffer <<= 8;
    buffer |= ((v & 0x7F) | 0x80);
  }
  while (true) {
    arr.push(buffer & 0xFF);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
}

// -------------------- Triads containing a note (clickable) --------------------

function parsePitchClassOnly(tok) {
  const s = String(tok || "").trim();
  if (!s) return null;

  const m = s.match(/^([A-Ga-g])([#b]?)$/);
  if (!m) throw new Error('Enter a pitch class like "G", "Eb", "F#". (No octave.)');

  const name = m[1].toUpperCase() + (m[2] || "");
  const pc = NOTE_TO_SEMITONE[name];
  if (pc == null) throw new Error(`Unknown note: "${name}".`);
  return pc;
}

function pcToPrettyName(pc) {
  const sharpName = SEMI_TO_NAME[((pc % 12) + 12) % 12];
  const flatMap = { "C#":"Db", "D#":"Eb", "F#":"Gb", "G#":"Ab", "A#":"Bb" };
  return flatMap[sharpName] || sharpName;
}

function triadsContainingPC(pc) {
  const mod12 = (x) => ((x % 12) + 12) % 12;

  const majRoots = [mod12(pc), mod12(pc - 4), mod12(pc - 7)];
  const minRoots = [mod12(pc), mod12(pc - 3), mod12(pc - 7)];

  const uniq = (arr) => Array.from(new Set(arr));
  const toNames = (roots, suf) =>
    uniq(roots)
      .map(r => `${pcToPrettyName(r)}${suf}`)
      .sort((a,b)=>a.localeCompare(b));

  return { major: toNames(majRoots, ""), minor: toNames(minRoots, "m") };
}

function appendChordToProgression(sym) {
  const progIn = document.getElementById("progIn");
  if (!progIn) return;

  const current = String(progIn.value || "").trim();
  if (!current) {
    progIn.value = sym;
  } else {
    // append with comma + space
    progIn.value = current.replace(/[,\s]*$/, "") + ", " + sym;
  }
  safeGenerate();
}

function renderTriadChips(title, list) {
  const wrap = document.createElement("div");
  wrap.style.margin = "6px 0 10px";

  const t = document.createElement("div");
  t.textContent = title;
  t.style.opacity = "0.85";
  t.style.marginBottom = "6px";
  wrap.appendChild(t);

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.flexWrap = "wrap";
  row.style.gap = "8px";

  for (const sym of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost";
    btn.textContent = sym;
    btn.style.width = "auto";
    btn.style.padding = "8px 10px";
    btn.style.borderRadius = "999px";
    btn.style.fontSize = "12px";
    btn.addEventListener("click", () => appendChordToProgression(sym));
    row.appendChild(btn);
  }

  wrap.appendChild(row);
  return wrap;
}

function updateTriadQueryUI() {
  const out = document.getElementById("noteQueryOut");
  if (!out) return;

  out.innerHTML = "";

  const raw = document.getElementById("noteQueryIn")?.value ?? "";
  try {
    const pc = parsePitchClassOnly(raw);
    if (pc == null) {
      out.textContent = "(enter a note)";
      return;
    }

    const res = triadsContainingPC(pc);

    const head = document.createElement("div");
    head.textContent = `Contains ${pcToPrettyName(pc)}:`;
    head.style.marginBottom = "8px";
    head.style.opacity = "0.9";
    out.appendChild(head);

    out.appendChild(renderTriadChips("Major", res.major));
    out.appendChild(renderTriadChips("Minor", res.minor));

    const hint = document.createElement("div");
    hint.textContent = "Click to append to the progression.";
    hint.style.marginTop = "6px";
    hint.style.opacity = "0.6";
    hint.style.fontSize = "12px";
    out.appendChild(hint);

  } catch (e) {
    out.textContent = "Error:\n" + e.message;
  }
}

// -------------------- UI --------------------

function setupUI() {
  const progIn = document.getElementById("progIn");
  const voicingSel = document.getElementById("voicingSel");
  const rangeLo = document.getElementById("rangeLo");
  const rangeHi = document.getElementById("rangeHi");

  const bassWeight = document.getElementById("bassWeight");
  const bassWeightLabel = document.getElementById("bassWeightLabel");

  const midiStyleSel = document.getElementById("midiStyleSel");
  const arpStepIn = document.getElementById("arpStepIn");
  const restIn = document.getElementById("restIn");

  // defaults (only set if empty, so you can keep your own)
  if (progIn && !progIn.value.trim()) progIn.value = "Am, G, C/E, F";
  if (voicingSel) voicingSel.value = voicingSel.value || "voicelead";
  if (rangeLo && !rangeLo.value.trim()) rangeLo.value = "C2";
  if (rangeHi && !rangeHi.value.trim()) rangeHi.value = "C6";

  if (bassWeight && !bassWeight.value) bassWeight.value = "1.2";
  if (bassWeightLabel) bassWeightLabel.textContent = String(Number(bassWeight?.value ?? 1.2).toFixed(1));

  if (midiStyleSel) midiStyleSel.value = midiStyleSel.value || "block";
  if (arpStepIn && !arpStepIn.value) arpStepIn.value = "0.25";
  if (restIn && !restIn.value) restIn.value = "0.5";

  function syncArpUI() {
    const isArp = (document.getElementById("midiStyleSel")?.value === "arpUp");
    if (arpStepIn) { arpStepIn.disabled = !isArp; arpStepIn.style.opacity = isArp ? "1" : "0.55"; }
    if (restIn) { restIn.disabled = !isArp; restIn.style.opacity = isArp ? "1" : "0.55"; }
  }

  function syncBassLabel() {
    const v = clamp(Number(bassWeight?.value ?? 1.2), 0, 3);
    if (bassWeightLabel) bassWeightLabel.textContent = v.toFixed(1);
  }

  midiStyleSel?.addEventListener("change", syncArpUI);
  syncArpUI();

  bassWeight?.addEventListener("input", () => {
    syncBassLabel();
    safeGenerate();
  });
  syncBassLabel();

  document.getElementById("exampleBtn")?.addEventListener("click", () => {
    if (progIn) progIn.value = "Dm, Bb, F, C, Dm/A, Bb/F, C/G";
    if (voicingSel) voicingSel.value = "voicelead";
    if (midiStyleSel) midiStyleSel.value = "block";
    if (bassWeight) bassWeight.value = "1.6";
    syncBassLabel();
    syncArpUI();
    safeGenerate();
  });

  document.getElementById("genBtn")?.addEventListener("click", () => safeGenerate());

  voicingSel?.addEventListener("change", () => safeGenerate());
  rangeLo?.addEventListener("change", () => safeGenerate());
  rangeHi?.addEventListener("change", () => safeGenerate());

  document.getElementById("downloadBtn")?.addEventListener("click", () => {
    if (!seqChords.length) {
      alert("Generate a sequence first.");
      return;
    }

    const bpm = Number(document.getElementById("bpmIn")?.value) || 60;
    const dur = Number(document.getElementById("durIn")?.value) || 2;

    const style = document.getElementById("midiStyleSel")?.value || "block";
    const arpStepBeats = Number(document.getElementById("arpStepIn")?.value) || 0.25;
    const restBeats = Number(document.getElementById("restIn")?.value) || 0.5;

    const midiBytes = buildMidiFile(seqChords, {
      ticksPerBeat: 480,
      bpm,
      chordDurationBeats: dur,
      style,
      arpStepBeats: clamp(arpStepBeats, 0.05, 8),
      restBeats: clamp(restBeats, 0, 32),
      gate: 0.85,
      velocity: 75,
      minVelocity: 30,
      singleNoteCap: 52,
      channel: 0,
      program: 0
    });

    downloadBytes(midiBytes, "triad-progression.mid", "audio/midi");
  });

  // --- triads containing note ---
  document.getElementById("noteQueryBtn")?.addEventListener("click", () => updateTriadQueryUI());
  document.getElementById("noteQueryIn")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") updateTriadQueryUI();
  });
  updateTriadQueryUI();

  // initial
  safeGenerate();
}

function safeGenerate() {
  try {
    generateSequence();
  } catch (e) {
    const statusOut = document.getElementById("statusOut");
    const seqOut = document.getElementById("seqOut");
    if (statusOut) statusOut.textContent = "Error:\n" + e.message;
    if (seqOut) seqOut.textContent = "(not generated yet)";
    seqSymbols = [];
    seqChords = [];
  }
}

// -------------------- p5 Visual --------------------

function setup() {
  setupUI();

  canvasPanelEl = document.querySelector(".canvasPanel");
  const w = Math.max(360, canvasPanelEl.clientWidth - 24);
  const h = 560;
  cnv = createCanvas(w, h);
  cnv.parent(canvasPanelEl);

  textFont("ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace");
  textSize(12);

  window.addEventListener("resize", () => {
    const w2 = Math.max(360, canvasPanelEl.clientWidth - 24);
    resizeCanvas(w2, height);
  });
}

function draw() {
  background(12, 13, 20);

  noFill();
  stroke(255,255,255,24);
  rect(10, 10, width - 20, height - 20, 12);

  const area = { x: 20, y: 24, w: width - 40, h: height - 48 };

  drawSequence(area);
  drawLabels();
}

function getMidiRange() {
  let lo = 48, hi = 84;
  try {
    const r = parseRangeBounds(
      document.getElementById("rangeLo")?.value ?? "C2",
      document.getElementById("rangeHi")?.value ?? "C6"
    );
    lo = r.lo; hi = r.hi;
  } catch {}
  return { lo, hi };
}

function yForMidi(m, area) {
  const { lo, hi } = getMidiRange();
  const padTop = 34;
  const padBottom = 26;
  const t = (m - lo) / Math.max(1, (hi - lo));
  return lerp(area.y + area.h - padBottom, area.y + padTop, t);
}

function drawSequence(area) {
  fill(255,255,255,70);
  noStroke();
  textAlign(LEFT, TOP);
  text("Chord sequence (hover columns)", area.x + 4, area.y + 2);

  noFill();
  stroke(255,255,255,16);
  rect(area.x, area.y + 22, area.w, area.h - 26, 10);

  if (!seqChords.length) {
    fill(255,255,255,55);
    noStroke();
    textAlign(LEFT, TOP);
    text("Enter a progression and click Generate.", area.x + 10, area.y + 34);
    return;
  }

  const inner = { x: area.x, y: area.y + 22, w: area.w, h: area.h - 26 };
  const N = seqChords.length;
  const colW = inner.w / Math.max(1, N);

  hoverStep = -1;
  if (mouseX >= inner.x && mouseX <= inner.x + inner.w && mouseY >= inner.y && mouseY <= inner.y + inner.h) {
    const idx = Math.floor((mouseX - inner.x) / colW);
    if (idx >= 0 && idx < N) hoverStep = idx;
  }

  for (let i = 0; i < N; i++) {
    const x = inner.x + i * colW;
    const isHover = i === hoverStep;

    noStroke();
    fill(255,255,255, isHover ? 18 : 6);
    rect(x, inner.y, colW, inner.h);

    const chord = seqChords[i];
    for (const m of chord) {
      const y = yForMidi(m, area);
      fill(255,255,255, isHover ? 210 : 125);
      circle(x + colW*0.5, constrain(y, inner.y + 12, inner.y + inner.h - 14), 5);
    }

    fill(255,255,255, isHover ? 120 : 55);
    textAlign(CENTER, BOTTOM);
    text(String(i+1), x + colW*0.5, inner.y + inner.h - 6);
  }

  if (hoverStep >= 0) {
    const sym = seqSymbols[hoverStep]?.sym ?? "?";
    const chord = seqChords[hoverStep] ?? [];
    const label = `${hoverStep+1}/${N}  ${sym}  ${chord.map(midiToNote).join(" ")}`;

    const tx = inner.x + 10;
    const ty = inner.y + 10;

    noStroke();
    fill(0,0,0,120);
    rect(tx - 6, ty - 6, textWidth(label) + 12, 24, 8);

    fill(255,255,255,200);
    textAlign(LEFT, TOP);
    text(label, tx, ty);
  }
}

function drawLabels() {
  fill(255,255,255,70);
  noStroke();
  textAlign(LEFT, TOP);
  text("Triads → Voicings → MIDI", 20, 12);
}
