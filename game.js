(() => {
  "use strict";

  const inPlayables = typeof ytgame !== "undefined" && ytgame.IN_PLAYABLES_ENV;

  // Dev-only test hook, gated behind an unambiguous query flag so it can never
  // accidentally activate inside a real Playables load. Strip before packaging.
  const DEBUG = new URLSearchParams(location.search).has("pulsedebug");

  // ---------- Canvas setup ----------
  const canvas = document.getElementById("stage");
  const ctx = canvas.getContext("2d");
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let width = 0;
  let height = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  // ---------- Audio (procedural, no external assets) ----------
  let audioEnabled = inPlayables ? ytgame.system.isAudioEnabled() : true;
  let audioCtx = null;

  function ensureAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    return audioCtx;
  }

  function beep(freq, duration, type = "sine", gain = 0.05) {
    if (!audioEnabled) return;
    try {
      const ac = ensureAudioCtx();
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.value = gain;
      osc.connect(g).connect(ac.destination);
      const now = ac.currentTime;
      g.gain.setValueAtTime(gain, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      osc.start(now);
      osc.stop(now + duration);
    } catch (e) {
      // Audio is best-effort; never let it break gameplay.
    }
  }

  if (inPlayables) {
    ytgame.system.onAudioEnabledChange((enabled) => {
      audioEnabled = enabled;
    });
  }

  // ---------- Persistence ----------
  const SAVE_KEY = "pulse_runner_save_v1";

  async function loadSave() {
    try {
      if (inPlayables) {
        const raw = await ytgame.game.loadData();
        return raw ? JSON.parse(raw) : {};
      }
      const raw = window.localStorage.getItem(SAVE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveGame(data) {
    const raw = JSON.stringify(data);
    try {
      if (inPlayables) {
        ytgame.game.saveData(raw);
      } else {
        window.localStorage.setItem(SAVE_KEY, raw);
      }
    } catch (e) {
      // Best-effort save; a failed save should never crash the game.
    }
  }

  function reportScore(value) {
    if (!inPlayables) return;
    ytgame.engagement.sendScore({ value: Math.floor(value) }).catch(() => {});
  }

  function logError() {
    if (inPlayables) {
      try {
        ytgame.health.logError();
      } catch (e) {
        /* best-effort */
      }
    }
  }

  // ---------- Game constants ----------
  const GROUND_RATIO = 0.78; // ground line as a fraction of canvas height
  const GRAVITY = 2600;
  const JUMP_VELOCITY = -980;
  const PLAYER_RADIUS = 22;
  const PLAYER_X_RATIO = 0.22;
  const BASE_SPEED = 380;
  const MAX_SPEED = 900;
  const SPEED_RAMP_PER_SEC = 6;
  const MIN_GAP_RATIO = 0.55; // relative to width, tightens as speed increases

  // ---------- State ----------
  const STATE = { LOADING: "loading", READY: "ready", PLAYING: "playing", GAMEOVER: "gameover" };
  let state = STATE.LOADING;
  let highScore = 0;
  let score = 0;
  let speed = BASE_SPEED;
  let elapsed = 0;
  let lastTime = 0;
  let paused = false;

  let player = { y: 0, vy: 0, onGround: true, squash: 0 };
  let obstacles = [];
  let nextSpawnDist = 0;
  let distSinceSpawn = 0;
  let particles = [];

  function groundY() {
    return height * GROUND_RATIO;
  }

  function playerX() {
    return width * PLAYER_X_RATIO;
  }

  function resetRun() {
    score = 0;
    speed = BASE_SPEED;
    elapsed = 0;
    player.y = groundY() - PLAYER_RADIUS;
    player.vy = 0;
    player.onGround = true;
    player.squash = 0;
    obstacles = [];
    particles = [];
    distSinceSpawn = 0;
    nextSpawnDist = 260 + Math.random() * 160;
  }

  function jump() {
    if (state === STATE.READY) {
      startRun();
      return;
    }
    if (state !== STATE.PLAYING) return;
    if (player.onGround) {
      player.vy = JUMP_VELOCITY;
      player.onGround = false;
      player.squash = 1;
      beep(520, 0.12, "square", 0.04);
    }
  }

  function startRun() {
    resetRun();
    state = STATE.PLAYING;
  }

  function endRun() {
    state = STATE.GAMEOVER;
    beep(140, 0.3, "sawtooth", 0.06);
    if (score > highScore) {
      highScore = score;
    }
    saveGame({ highScore });
    reportScore(highScore);
  }

  function spawnObstacle() {
    const kind = Math.random() < 0.5 ? "block" : "spike";
    const h = kind === "spike" ? 34 + Math.random() * 18 : 30 + Math.random() * 46;
    const w = kind === "spike" ? 26 : 30 + Math.random() * 22;
    obstacles.push({
      x: width + w,
      w,
      h,
      kind,
      passed: false,
    });
  }

  function update(dt) {
    if (state !== STATE.PLAYING) return;

    elapsed += dt;
    speed = Math.min(MAX_SPEED, BASE_SPEED + elapsed * SPEED_RAMP_PER_SEC * 10);
    score += dt * (speed / 10);

    // Player physics
    player.vy += GRAVITY * dt;
    player.y += player.vy * dt;
    const gY = groundY() - PLAYER_RADIUS;
    if (player.y >= gY) {
      player.y = gY;
      if (!player.onGround) {
        player.squash = 1;
      }
      player.vy = 0;
      player.onGround = true;
    }
    if (player.squash > 0) player.squash = Math.max(0, player.squash - dt * 6);

    // Spawn obstacles based on distance traveled, gap tightens with speed
    distSinceSpawn += speed * dt;
    const gapScale = Math.max(0.62, MIN_GAP_RATIO - (speed - BASE_SPEED) / 3200);
    if (distSinceSpawn >= nextSpawnDist) {
      spawnObstacle();
      distSinceSpawn = 0;
      nextSpawnDist = width * gapScale * (0.8 + Math.random() * 0.6);
    }

    // Move obstacles + collision
    const px = playerX();
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      o.x -= speed * dt;

      const oTop = groundY() - o.h;
      const closeX = Math.max(o.x, Math.min(px, o.x + o.w));
      const closeY = Math.max(oTop, Math.min(player.y, groundY()));
      const dx = px - closeX;
      const dy = player.y - closeY;
      if (dx * dx + dy * dy < PLAYER_RADIUS * PLAYER_RADIUS * 0.72) {
        endRun();
        return;
      }

      if (!o.passed && o.x + o.w < px) {
        o.passed = true;
        beep(760, 0.06, "sine", 0.03);
      }
      if (o.x + o.w < -40) {
        obstacles.splice(i, 1);
      }
    }

    // Trail particles
    if (Math.random() < 0.6) {
      particles.push({ x: px - PLAYER_RADIUS, y: player.y + PLAYER_RADIUS * 0.6, life: 0.4, r: 3 + Math.random() * 3 });
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      p.x -= speed * dt * 0.5;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  // ---------- Rendering ----------
  function draw() {
    ctx.clearRect(0, 0, width, height);

    // Background gradient
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, "#0a0a16");
    g.addColorStop(1, "#161027");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    // Ground line
    const gy = groundY();
    ctx.strokeStyle = "rgba(120, 220, 255, 0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, gy + PLAYER_RADIUS + 2);
    ctx.lineTo(width, gy + PLAYER_RADIUS + 2);
    ctx.stroke();

    // Particles (trail)
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / 0.4) * 0.5;
      ctx.fillStyle = "#7fe7ff";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Obstacles
    for (const o of obstacles) {
      const oTop = gy - o.h;
      if (o.kind === "spike") {
        ctx.fillStyle = "#ff5d73";
        ctx.beginPath();
        ctx.moveTo(o.x, gy);
        ctx.lineTo(o.x + o.w / 2, oTop);
        ctx.lineTo(o.x + o.w, gy);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = "#ffb64d";
        roundRect(o.x, oTop, o.w, o.h, 6);
        ctx.fill();
      }
    }

    // Player
    const px = playerX();
    const squash = player.squash;
    const rx = PLAYER_RADIUS * (1 + squash * 0.25);
    const ry = PLAYER_RADIUS * (1 - squash * 0.25);
    ctx.fillStyle = "#7ff0d6";
    ctx.save();
    ctx.translate(px, player.y);
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // HUD
    ctx.fillStyle = "#eaf6ff";
    ctx.font = "600 22px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(String(Math.floor(score)), 20, 18);

    if (state === STATE.READY) {
      drawCenteredPanel("PULSE RUNNER", "Tap, click, or press Space to jump", "Weu Studios");
    } else if (state === STATE.GAMEOVER) {
      drawCenteredPanel(
        "RUN OVER",
        `Score ${Math.floor(score)}   Best ${Math.floor(highScore)}`,
        "Tap to try again"
      );
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCenteredPanel(title, subtitle, footer) {
    ctx.fillStyle = "rgba(10, 10, 20, 0.55)";
    ctx.fillRect(0, 0, width, height);

    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 40px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.fillText(title, width / 2, height / 2 - 40);

    ctx.font = "500 18px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.fillStyle = "#bfe9ff";
    ctx.fillText(subtitle, width / 2, height / 2 + 10);

    ctx.font = "500 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.fillStyle = "#7d8bb0";
    ctx.fillText(footer, width / 2, height / 2 + 46);

    ctx.textAlign = "left";
  }

  // ---------- Main loop ----------
  function frame(t) {
    requestAnimationFrame(frame);
    if (!lastTime) lastTime = t;
    let dt = (t - lastTime) / 1000;
    lastTime = t;
    if (dt < 0) dt = 0; // defensive: rAF timestamps should be monotonic, but never trust it blindly
    if (dt > 0.05) dt = 0.05; // clamp huge gaps (tab switches, etc.)

    if (state === STATE.LOADING) {
      state = STATE.READY;
      if (inPlayables) {
        ytgame.game.firstFrameReady();
      }
    }

    if (!paused) {
      update(dt);
    }
    draw();

    if (state === STATE.READY && !window.__pulseGameReadyCalled) {
      window.__pulseGameReadyCalled = true;
      if (inPlayables) {
        ytgame.game.gameReady();
      }
    }
  }

  // ---------- Input ----------
  function onPointerDown(e) {
    e.preventDefault();
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    if (state === STATE.GAMEOVER) {
      startRun();
      return;
    }
    jump();
  }
  canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp") {
      e.preventDefault();
      onPointerDown(e);
    }
  });

  if (inPlayables) {
    ytgame.system.onPause(() => {
      paused = true;
    });
    ytgame.system.onResume(() => {
      paused = false;
      lastTime = 0;
    });
  } else {
    document.addEventListener("visibilitychange", () => {
      paused = DEBUG ? false : document.hidden;
      if (!paused) lastTime = 0;
    });
  }

  if (DEBUG) {
    window.__pulseTick = frame;
    window.__pulseState = () => ({
      state,
      score,
      highScore,
      speed,
      playerY: player.y,
      onGround: player.onGround,
      obstacleCount: obstacles.length,
      obstacles: obstacles.map((o) => ({ x: o.x, w: o.w, h: o.h, kind: o.kind })),
    });
    window.__pulseJump = jump;
  }

  // ---------- Boot ----------
  loadSave()
    .then((data) => {
      highScore = (data && data.highScore) || 0;
      resetRun();
      requestAnimationFrame(frame);
    })
    .catch((e) => {
      logError();
      resetRun();
      requestAnimationFrame(frame);
    });
})();
