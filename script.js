// ── 音階定義 ───────────────────────────────────────────
const NOTE_MAP = [
  { name: 'ド',   freq: 261.63, fingers: [0, 1], label: '親指＋人差し指', hand: 'Right' },
  { name: 'レ',   freq: 293.66, fingers: [0, 2], label: '親指＋中指',     hand: 'Right' },
  { name: 'ミ',   freq: 329.63, fingers: [0, 3], label: '親指＋薬指',     hand: 'Right' },
  { name: 'ファ', freq: 349.23, fingers: [0, 4], label: '親指＋小指',     hand: 'Right' },
  { name: 'ソ',   freq: 392.00, fingers: [0, 1], label: '親指＋人差し指', hand: 'Left'  },
  { name: 'ラ',   freq: 440.00, fingers: [0, 2], label: '親指＋中指',     hand: 'Left'  },
  { name: 'シ',   freq: 493.88, fingers: [0, 3], label: '親指＋薬指',     hand: 'Left'  },
  { name: 'ド′',  freq: 523.25, fingers: [0, 4], label: '親指＋小指',     hand: 'Left'  },
];

const FINGERTIPS = [4, 8, 12, 16, 20];

// ── オクターブモード ───────────────────────────────────
let octaveMode    = false;
let currentOctave = 0;      // -1 / 0 / +1
let smoothedSize  = null;   // EMA 平滑化済みの手のサイズ

const HAND_SIZE_ALPHA  = 0.18;  // EMA 係数（小さいほど滑らか）
const OCT_CLOSE_THR    = 0.19;  // refDist > この値 → 近い → 低音域
const OCT_FAR_THR      = 0.11;  // refDist < この値 → 遠い → 高音域

function computeOctave(size) {
  if (size > OCT_CLOSE_THR) return -1;
  if (size < OCT_FAR_THR)   return  1;
  return 0;
}

const octSegPanel  = { low: null, mid: null, high: null };
const octSegCam    = { low: null, mid: null, high: null };

function updateOctaveUI(octave) {
  const classes = { low: 'oct-active-low', mid: 'oct-active-mid', high: 'oct-active-high' };
  const mapping  = { '-1': 'low', '0': 'mid', '1': 'high' };
  const active   = mapping[String(octave)];
  ['low', 'mid', 'high'].forEach(k => {
    const cls = classes[k];
    [octSegPanel[k], octSegCam[k]].forEach(el => {
      if (!el) return;
      el.classList.toggle(cls, k === active);
    });
  });
}

// ── AudioContext ───────────────────────────────────────
let audioCtx = null;
const activeOsc = {};
let noteReleaseTimers = {};
let currentInstrument = 'piano';

function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// ── 楽器音源 ───────────────────────────────────────────

// トランペット用ソフトクリッピング曲線
const BRASS_CURVE = (() => {
  const c = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i * 2 / 256) - 1;
    c[i] = Math.tanh(x * 2.5) * 0.7;
  }
  return c;
})();

function pianoNote(ctx, freq) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = 'sine'; osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.28, t + 0.015);

  const osc2 = ctx.createOscillator(), g2 = ctx.createGain();
  osc2.type = 'triangle'; osc2.frequency.value = freq * 2;
  g2.gain.setValueAtTime(0, t);
  g2.gain.linearRampToValueAtTime(0.06, t + 0.015);

  osc.connect(g).connect(ctx.destination);
  osc2.connect(g2).connect(ctx.destination);
  osc.start(); osc2.start();
  return { oscs: [osc, osc2], gains: [g, g2], nodes: [] };
}

function trumpetNote(ctx, freq) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth'; osc.frequency.value = freq;

  const shaper = ctx.createWaveShaper();
  shaper.curve = BRASS_CURVE;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.22, t + 0.04);

  osc.connect(shaper).connect(g).connect(ctx.destination);
  osc.start();
  return { oscs: [osc], gains: [g], nodes: [shaper] };
}

function guitarNote(ctx, freq) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth'; osc.frequency.value = freq;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = freq * 5; filter.Q.value = 0.8;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.38, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 1.4); // 弦の自然な減衰

  osc.connect(filter).connect(g).connect(ctx.destination);
  osc.start();
  return { oscs: [osc], gains: [g], nodes: [filter], naturalRelease: true, releaseTime: 1500 };
}

function clarinetNote(ctx, freq) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'square'; osc.frequency.value = freq; // 矩形波 = 奇数倍音 = 葦楽器の特性

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.14, t + 0.025);

  osc.connect(g).connect(ctx.destination);
  osc.start();
  return { oscs: [osc], gains: [g], nodes: [] };
}

function fluteNote(ctx, freq) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine'; osc.frequency.value = freq;

  // ビブラート用 LFO
  const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
  lfo.frequency.value = 5.5;
  lfoGain.gain.value = freq * 0.012;
  lfo.connect(lfoGain).connect(osc.frequency);
  lfo.start();

  // 第3倍音
  const osc2 = ctx.createOscillator(), g2 = ctx.createGain();
  osc2.type = 'sine'; osc2.frequency.value = freq * 3;
  g2.gain.setValueAtTime(0, t);
  g2.gain.linearRampToValueAtTime(0.03, t + 0.09);
  osc2.connect(g2).connect(ctx.destination);
  osc2.start();

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.24, t + 0.09); // ゆっくりしたアタック

  osc.connect(g).connect(ctx.destination);
  osc.start();
  return { oscs: [osc, osc2, lfo], gains: [g, g2], nodes: [lfoGain] };
}

function bellNote(ctx, freq) {
  const t = ctx.currentTime;
  const masterGain = ctx.createGain();
  masterGain.connect(ctx.destination);
  masterGain.gain.setValueAtTime(0.4, t);
  masterGain.gain.exponentialRampToValueAtTime(0.001, t + 3.5); // 余韻

  // 非整数倍音（実際のベルの倍音系列）
  const partialGains = [];
  const oscs = [[1, 0.5], [2.756, 0.25], [5.404, 0.15], [8.933, 0.07]].map(([ratio, amp]) => {
    const o = ctx.createOscillator(), pg = ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq * ratio; pg.gain.value = amp;
    o.connect(pg).connect(masterGain);
    o.start();
    partialGains.push(pg);
    return o;
  });
  return { oscs, gains: [masterGain], nodes: partialGains, naturalRelease: true, releaseTime: 3600 };
}

function createNote(freq) {
  const ctx = getCtx();
  switch (currentInstrument) {
    case 'trumpet':  return trumpetNote(ctx, freq);
    case 'guitar':   return guitarNote(ctx, freq);
    case 'clarinet': return clarinetNote(ctx, freq);
    case 'flute':    return fluteNote(ctx, freq);
    case 'bell':     return bellNote(ctx, freq);
    default:         return pianoNote(ctx, freq);
  }
}

// ── 音の開始・停止 ─────────────────────────────────────

function startNote(freq, key) {
  if (activeOsc[key]) forceStopNote(key);
  if (noteReleaseTimers[key]) {
    clearTimeout(noteReleaseTimers[key]);
    delete noteReleaseTimers[key];
  }
  activeOsc[key] = createNote(freq);
}

function stopNote(key) {
  const p = activeOsc[key];
  if (!p) return;

  const releaseMs = p.releaseTime || 70;

  if (!p.naturalRelease) {
    // ピンチ解除時にフェードアウト
    const ctx = getCtx(), t = ctx.currentTime;
    try {
      (p.gains || []).forEach(g => {
        const v = g.gain.value;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(v, t);
        g.gain.linearRampToValueAtTime(0, t + 0.05);
      });
    } catch (e) {}
  }

  // ノードのクリーンアップ
  noteReleaseTimers[key] = setTimeout(() => {
    try {
      (p.oscs  || []).forEach(o => { try { o.stop(); o.disconnect(); } catch (e) {} });
      (p.gains || []).forEach(g => { try { g.disconnect(); } catch (e) {} });
      (p.nodes || []).forEach(n => { try { n.disconnect(); } catch (e) {} });
    } catch (e) {}
    delete activeOsc[key];
    delete noteReleaseTimers[key];
  }, releaseMs);
}

function forceStopNote(key) {
  const p = activeOsc[key];
  if (!p) return;

  if (noteReleaseTimers[key]) {
    clearTimeout(noteReleaseTimers[key]);
    delete noteReleaseTimers[key];
  }

  const ctx = getCtx();
  try {
    (p.gains || []).forEach(g => {
      try {
        g.gain.cancelScheduledValues(ctx.currentTime);
        g.gain.setValueAtTime(0, ctx.currentTime);
        g.disconnect();
      } catch (e) {}
    });
    (p.oscs  || []).forEach(o => { try { o.stop(); o.disconnect(); } catch (e) {} });
    (p.nodes || []).forEach(n => { try { n.disconnect(); } catch (e) {} });
  } catch (e) {}
  delete activeOsc[key];
}

function forceStopAllNotes() {
  Object.keys(noteReleaseTimers).forEach(key => clearTimeout(noteReleaseTimers[key]));
  noteReleaseTimers = {};
  Object.keys(activeOsc).forEach(key => forceStopNote(key));
}

// ── 映像→キャンバス座標変換（object-fit: cover 相当） ─
// 映像がコンテナ比より縦長でも横長でも、中央クロップして歪みなく表示する
let drawState = { scale: 1, ox: 0, oy: 0, vw: 640, vh: 480 };

function updateDrawState(vw, vh, cw, ch) {
  const scale = Math.max(cw / vw, ch / vh); // cover: 短辺を合わせてはみ出しをクロップ
  drawState = {
    scale,
    ox: (cw - vw * scale) / 2, // 水平方向の中央合わせオフセット
    oy: (ch - vh * scale) / 2, // 垂直方向の中央合わせオフセット
    vw, vh,
  };
}

// 正規化ランドマーク座標 (0–1) → キャンバスピクセル座標
function lx(pt) { return pt.x * drawState.vw * drawState.scale + drawState.ox; }
function ly(pt) { return pt.y * drawState.vh * drawState.scale + drawState.oy; }

// ── ピンチ対応表（左右2カラム）構築 ──────────────────
(function buildGuide() {
  const guide = document.getElementById('guide');
  const container = document.createElement('div');
  container.className = 'guide-columns';

  function makeCol(title, notes) {
    const col = document.createElement('div');

    const heading = document.createElement('div');
    heading.className = 'guide-col-title';
    heading.textContent = title;
    col.appendChild(heading);

    notes.forEach(n => {
      const row = document.createElement('div');
      row.className = 'guide-row';
      row.innerHTML = `<span class="guide-fingers">${n.label}</span><span class="guide-note">${n.name}</span>`;
      col.appendChild(row);
    });
    return col;
  }

  // カメラ鏡像を考慮: MediaPipe "Right" → ユーザーの左手側
  container.appendChild(makeCol('左手', NOTE_MAP.filter(n => n.hand === 'Right')));
  container.appendChild(makeCol('右手', NOTE_MAP.filter(n => n.hand === 'Left')));
  guide.appendChild(container);
})();

// ── ビジュアライザーのバー生成 ────────────────────────
const visBars = document.getElementById('vis-bars');
for (let i = 0; i < 28; i++) {
  const b = document.createElement('div');
  b.className = 'vis-bar';
  visBars.appendChild(b);
}
const bars = [...visBars.querySelectorAll('.vis-bar')];

// ── ビジュアライザーアニメーション ────────────────────
let visFrame = 0;
function animateBars(activeNotes) {
  bars.forEach((bar, i) => {
    if (activeNotes.length > 0) {
      const v = activeNotes.reduce((s, ni) => {
        return s + Math.abs(Math.sin((visFrame * 0.2 + i * 0.42) * (NOTE_MAP[ni].freq / 110)));
      }, 0) / activeNotes.length;
      bar.style.height = Math.round(3 + v * 26) + 'px';
      bar.classList.add('lit');
    } else {
      bar.style.height = '3px';
      bar.classList.remove('lit');
    }
  });
  visFrame++;
}

// ── 音名オーバーレイ（カメラ映像に重畳） ─────────────
const noteOverlay = document.getElementById('note-overlay');

function updateNoteOverlay(activeNotes) {
  noteOverlay.innerHTML = '';
  [...activeNotes].forEach(ni => {
    const tag = document.createElement('span');
    tag.className = 'overlay-note';
    tag.textContent = NOTE_MAP[ni].name;
    noteOverlay.appendChild(tag);
  });
}

// ── ピンチ判定 ─────────────────────────────────────────
function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function detectPinches(landmarks, handedness) {
  const pinched = new Set();
  const refDist = dist(landmarks[0], landmarks[9]);
  NOTE_MAP.forEach((n, ni) => {
    if (n.hand !== handedness) return;
    const d = dist(landmarks[FINGERTIPS[n.fingers[0]]], landmarks[FINGERTIPS[n.fingers[1]]]);
    if (d < refDist * 0.38) pinched.add(ni);
  });
  return pinched;
}

// ── 手骨格の描画 ───────────────────────────────────────
const CONNECTIONS = [
  [0, 1], [1, 2],  [2, 3],  [3, 4],
  [0, 5], [5, 6],  [6, 7],  [7, 8],
  [0, 9], [9, 10], [10, 11],[11, 12],
  [0, 13],[13, 14],[14, 15],[15, 16],
  [0, 17],[17, 18],[18, 19],[19, 20],
  [5, 9], [9, 13], [13, 17],
];

function drawHand(ctx2d, landmarks, pinched) {
  // 骨格ライン（lx/ly で cover 変換済み座標を使用）
  ctx2d.strokeStyle = 'rgba(29,158,117,0.55)';
  ctx2d.lineWidth = 2;
  CONNECTIONS.forEach(([a, b]) => {
    ctx2d.beginPath();
    ctx2d.moveTo(lx(landmarks[a]), ly(landmarks[a]));
    ctx2d.lineTo(lx(landmarks[b]), ly(landmarks[b]));
    ctx2d.stroke();
  });

  // 関節点
  landmarks.forEach((pt, i) => {
    ctx2d.beginPath();
    ctx2d.arc(lx(pt), ly(pt), FINGERTIPS.includes(i) ? 5 : 3, 0, Math.PI * 2);
    ctx2d.fillStyle = FINGERTIPS.includes(i) ? '#1D9E75' : 'rgba(29,158,117,0.4)';
    ctx2d.fill();
  });

  // ピンチ中の指先ハイライト
  const activeTips = new Set();
  NOTE_MAP.forEach((n, ni) => {
    if (pinched.has(ni)) n.fingers.forEach(fi => activeTips.add(FINGERTIPS[fi]));
  });
  activeTips.forEach(ti => {
    ctx2d.beginPath();
    ctx2d.arc(lx(landmarks[ti]), ly(landmarks[ti]), 11, 0, Math.PI * 2);
    ctx2d.strokeStyle = '#EF9F27';
    ctx2d.lineWidth = 2.5;
    ctx2d.stroke();
  });

  // ピンチ中の音名ラベル（指の近くに表示・文字反転補正）
  NOTE_MAP.forEach((n, ni) => {
    if (!pinched.has(ni)) return;
    const t0 = landmarks[FINGERTIPS[n.fingers[0]]];
    const t1 = landmarks[FINGERTIPS[n.fingers[1]]];
    const mx = (lx(t0) + lx(t1)) / 2;
    const my = (ly(t0) + ly(t1)) / 2 - 16;
    ctx2d.font = 'bold 14px sans-serif';
    ctx2d.fillStyle = '#EF9F27';
    ctx2d.textAlign = 'center';
    ctx2d.save();
    ctx2d.scale(-1, 1); // CSS の scaleX(-1) を打ち消して文字を正立させる
    ctx2d.fillText(n.name, -mx, my);
    ctx2d.restore();
  });
}

// ── DOM 参照 ───────────────────────────────────────────
const video        = document.getElementById('video');
const canvas       = document.getElementById('canvas');
const ctx2d        = canvas.getContext('2d');
const placeholder  = document.getElementById('placeholder');
const errorMsg     = document.getElementById('error-msg');
const startBtn     = document.getElementById('start-btn');
const resetBtn     = document.getElementById('reset-btn');
const camToggleBtn = document.getElementById('cam-toggle-btn');
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const cameraWrap   = document.getElementById('camera-wrap');

// オクターブモード DOM
const octaveModeBtn   = document.getElementById('octave-mode-btn');
const octPanelSegs    = document.getElementById('oct-panel-segs');
const octCamBar       = document.getElementById('octave-cam-bar');
octSegPanel.low  = document.getElementById('oct-p-low');
octSegPanel.mid  = document.getElementById('oct-p-mid');
octSegPanel.high = document.getElementById('oct-p-high');
octSegCam.low    = document.getElementById('oct-cam-low');
octSegCam.mid    = document.getElementById('oct-cam-mid');
octSegCam.high   = document.getElementById('oct-cam-high');
updateOctaveUI(0);

let lastPinched = new Set();
let lastDetectionTime = 0;
let showCameraImage = true;
const TRACKING_TIMEOUT = 150; // ms: この時間トラッキングが途切れたら音を停止

// ── MediaPipe コールバック ────────────────────────────
function onResults(results) {
  // キャンバスをコンテナの CSS サイズに合わせる（映像サイズでなくコンテナサイズ）
  const cw = cameraWrap.clientWidth;
  const ch = cameraWrap.clientHeight;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width  = cw;
    canvas.height = ch;
  }

  // 映像の実サイズから cover 変換パラメータを計算
  const vw = video.videoWidth  || cw;
  const vh = video.videoHeight || ch;
  updateDrawState(vw, vh, cw, ch);

  ctx2d.clearRect(0, 0, cw, ch);

  // カメラ画像 ON: 通常表示 / OFF: シルエット表示（いずれも cover クロップ）
  const { scale, ox, oy } = drawState;
  if (showCameraImage) {
    ctx2d.drawImage(results.image, ox, oy, vw * scale, vh * scale);
  } else {
    ctx2d.fillStyle = '#18181c';
    ctx2d.fillRect(0, 0, cw, ch);
    ctx2d.save();
    ctx2d.globalAlpha = 0.12; // 人の輪郭がうっすら見える程度
    ctx2d.drawImage(results.image, ox, oy, vw * scale, vh * scale);
    ctx2d.restore();
  }

  let allPinched = new Set();
  const now = Date.now();

  if (results.multiHandLandmarks?.length) {
    lastDetectionTime = now;
    statusDot.className = 'detecting';
    statusText.textContent = `手を検出中 (${results.multiHandLandmarks.length}本)`;

    // オクターブモード: 全手の平均サイズからオクターブ決定
    if (octaveMode) {
      let totalSize = 0;
      results.multiHandLandmarks.forEach(lm => { totalSize += dist(lm[0], lm[9]); });
      const avgSize = totalSize / results.multiHandLandmarks.length;
      smoothedSize = smoothedSize === null
        ? avgSize
        : HAND_SIZE_ALPHA * avgSize + (1 - HAND_SIZE_ALPHA) * smoothedSize;

      const newOctave = computeOctave(smoothedSize);
      if (newOctave !== currentOctave) {
        currentOctave = newOctave;
        forceStopAllNotes();
        lastPinched.clear();
      }
    }

    results.multiHandLandmarks.forEach((lm, idx) => {
      const handedness = results.multiHandedness?.[idx]?.label || 'Right';
      const pinched = detectPinches(lm, handedness);
      pinched.forEach(p => allPinched.add(p));
      drawHand(ctx2d, lm, pinched);
    });
  } else {
    if (now - lastDetectionTime > TRACKING_TIMEOUT) {
      if (lastPinched.size > 0) {
        lastPinched.forEach(ni => stopNote(ni));
        lastPinched.clear();
      }
      if (octaveMode) {
        smoothedSize = null;
        if (currentOctave !== 0) { currentOctave = 0; updateOctaveUI(0); }
      }
    }
    statusDot.className = 'active';
    statusText.textContent = 'カメラ稼働中';
  }

  // オクターブUI更新
  if (octaveMode) updateOctaveUI(currentOctave);

  // 新しくピンチされた音を開始（オクターブシフト適用）
  allPinched.forEach(ni => {
    if (!lastPinched.has(ni)) {
      const freq = NOTE_MAP[ni].freq * Math.pow(2, currentOctave);
      startNote(freq, ni);
    }
  });

  // ピンチが解除された音を停止
  lastPinched.forEach(ni => {
    if (!allPinched.has(ni)) stopNote(ni);
  });

  lastPinched = allPinched;
  updateNoteOverlay(allPinched);
  animateBars([...allPinched]);
}

// ── カメラ起動 ─────────────────────────────────────────
async function startCamera() {
  startBtn.textContent = '読み込み中...';
  startBtn.disabled = true;
  getCtx();

  try {
    const hands = new Hands({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
    });
    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.65,
    });
    hands.onResults(onResults);

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' } // サイズ指定なし: デバイスの自然な解像度を使用
    });
    video.srcObject = stream;
    video.style.display = 'block';
    placeholder.style.display = 'none';
    await video.play();

    statusDot.className = 'active';
    statusText.textContent = 'カメラ稼働中';
    lastDetectionTime = Date.now();

    // カメラ画像トグルを有効化
    camToggleBtn.disabled = false;
    camToggleBtn.textContent = '📷 カメラ画像 OFF';

    (async function loop() {
      if (video.readyState >= 2) {
        await hands.send({ image: video });
      }
      requestAnimationFrame(loop);
    })();

  } catch (e) {
    errorMsg.style.display = 'flex';
    errorMsg.innerHTML = `<span>⚠️</span><span>カメラにアクセスできませんでした。<br>${e.message}</span>`;
    statusText.textContent = 'エラー';
    startBtn.textContent = 'カメラ起動';
    startBtn.disabled = false;
    placeholder.style.display = 'none';
  }
}

// ── イベントリスナー ───────────────────────────────────
startBtn.addEventListener('click', startCamera);

camToggleBtn.addEventListener('click', () => {
  showCameraImage = !showCameraImage;
  camToggleBtn.textContent = showCameraImage ? '📷 カメラ画像 OFF' : '📷 カメラ画像 ON';
  camToggleBtn.classList.toggle('off', !showCameraImage);
});

resetBtn.addEventListener('click', () => {
  forceStopAllNotes();
  lastPinched.clear();
  updateNoteOverlay(new Set());
});

octaveModeBtn.addEventListener('click', () => {
  octaveMode = !octaveMode;
  octaveModeBtn.textContent = `オクターブモード ${octaveMode ? 'ON' : 'OFF'}`;
  octaveModeBtn.classList.toggle('active', octaveMode);
  octPanelSegs.classList.toggle('visible', octaveMode);
  octCamBar.classList.toggle('visible', octaveMode);
  if (!octaveMode) {
    currentOctave = 0;
    smoothedSize  = null;
    forceStopAllNotes();
    lastPinched.clear();
    updateOctaveUI(0);
  }
});

document.querySelectorAll('.inst-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    forceStopAllNotes();
    lastPinched.clear();
    updateNoteOverlay(new Set());
    currentInstrument = btn.dataset.inst;
    document.querySelectorAll('.inst-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

setInterval(() => { if (!video.srcObject) animateBars([]); }, 50);

window.addEventListener('beforeunload', forceStopAllNotes);
