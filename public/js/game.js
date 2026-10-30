// ─── Constants ────────────────────────────────────────────────────────────────

const CHAR_COLORS = {
  Blue:   0x5b9bd5,
  Pink:   0xe07aaa,
  Yellow: 0xf5c842,
  Green:  0x5abf6a,
  Beige:  0xd4c89a,
};
const CHAR_NAMES = { Blue: 'Blobby', Pink: 'Pinky', Yellow: 'Sunny', Green: 'Goo', Beige: 'Astro' };
const PLAYER_R = 18;
const PLAYER_H = 52;

// ─── Session data ─────────────────────────────────────────────────────────────

let gameData = null;
try { gameData = JSON.parse(sessionStorage.getItem('blobz_game')); } catch(e) {}

if (!gameData) {
  gameData = {
    myId: 'solo', code: 'TEST', game: 'bullet_barrage',
    players: [{ id: 'solo', name: 'Du', char: 'Blue', x: 400, y: 280, color: '#5b9bd5' }],
    arenaW: 800, arenaH: 560,
  };
}

// ─── Socket ───────────────────────────────────────────────────────────────────

let socket = null;
let activeScene = null;

function connectSocket() {
  socket = io();

  socket.on('connect', () => {
    if (gameData.code && gameData.myId) {
      socket.emit('rejoin_game', { code: gameData.code, myId: gameData.myId });
    }
  });

  socket.on('game_tick', data => { if (activeScene?.onTick) activeScene.onTick(data); });
  socket.on('player_died', data => { if (activeScene?.onPlayerDied) activeScene.onPlayerDied(data); });
  socket.on('game_over', data => showScoreScreen(data.scores));
  socket.on('game_start', newData => {
    gameData = { ...gameData, ...newData };
    const prev = game.scene.getScenes(true)[0];
    if (prev) game.scene.stop(prev.scene.key);
    launchGame(newData.game);
  });
  socket.on('game_night_over', () => {
    document.getElementById('next-msg').textContent = 'Spielabend vorbei!';
    setTimeout(() => window.location.href = '/', 5000);
  });
}

// ─── Phaser config ────────────────────────────────────────────────────────────

const config = {
  type: Phaser.AUTO,
  backgroundColor: '#0d0d1e',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: gameData.arenaW || 800,
    height: gameData.arenaH || 560,
  },
  scene: [],
};

const game = new Phaser.Game(config);

// ─── Base Arena Scene ──────────────────────────────────────────────────────────

class ArenaScene extends Phaser.Scene {
  init() {
    activeScene = this;
    this.players = {};
    this.myX = 400;
    this.myY = 280;
    this.myAlive = true;
    this.joyDx = 0;
    this.joyDy = 0;
    this._moveInterval = null;
  }

  // ── Preload: load all char sprites + atlases ────────────────────────────────
  preload() {
    const colors = ['Blue', 'Pink', 'Yellow', 'Green', 'Beige'];
    const poses = ['front', 'walk1', 'walk2', 'stand', 'hit', 'jump', 'duck'];
    colors.forEach(c => poses.forEach(p => {
      const key = `alien${c}_${p}`;
      if (!this.textures.exists(key)) {
        this.load.image(key, `/assets/chars/alien${c}_${p}.png`);
      }
    }));

    if (!this.textures.exists('bg_colored')) {
      this.load.image('bg_colored', '/assets/bg/colored_land.png');
    }
    if (!this.textures.exists('tiles')) {
      this.load.atlasXML('tiles', '/assets/tiles/spritesheet_tiles.png', '/assets/tiles/spritesheet_tiles.xml');
    }
    if (!this.textures.exists('items')) {
      this.load.atlasXML('items', '/assets/items/spritesheet_items.png', '/assets/items/spritesheet_items.xml');
    }
  }

  // ── Draw arena background + Kenney brick border ───────────────────────────
  createArena() {
    const W = gameData.arenaW, H = gameData.arenaH;

    // Kenney landscape background
    const bg = this.add.image(W / 2, H / 2, 'bg_colored');
    bg.setDisplaySize(W, H);

    // Slight dark overlay for readability
    this.add.rectangle(W / 2, H / 2, W, H, 0x0a1020, 0.42);

    // Brick border using Kenney brickBrown tiles
    const TILE = 40;
    const hCount = Math.ceil(W / TILE);
    const vCount = Math.ceil(H / TILE);
    const hasTiles = this.textures.exists('tiles');

    const addBrick = (x, y) => {
      if (hasTiles) {
        this.add.image(x, y, 'tiles', 'brickBrown.png').setDisplaySize(TILE, TILE);
      } else {
        this.add.rectangle(x, y, TILE, TILE, 0x8B5E3C);
      }
    };

    for (let i = 0; i < hCount; i++) {
      addBrick(i * TILE + TILE / 2, TILE / 2);
      addBrick(i * TILE + TILE / 2, H - TILE / 2);
    }
    for (let j = 1; j < vCount - 1; j++) {
      addBrick(TILE / 2, j * TILE + TILE / 2);
      addBrick(W - TILE / 2, j * TILE + TILE / 2);
    }
  }

  // ── Create player sprites ──────────────────────────────────────────────────
  createPlayers() {
    const me = gameData.players.find(p => p.id === gameData.myId) || gameData.players[0];
    this.myX = me?.x || 400;
    this.myY = me?.y || 280;

    gameData.players.forEach(p => {
      const isMe = p.id === gameData.myId;

      // Shadow under player
      const shadow = this.add.ellipse(p.x, p.y + PLAYER_H * 0.4, 36, 10, 0x000000, 0.3);

      // Player sprite
      const sprite = this.add.image(p.x, p.y, `alien${p.char || 'Blue'}_stand`);
      sprite.setDisplaySize(PLAYER_H * 0.5, PLAYER_H);

      // Highlight ring for own player
      let ring = null;
      if (isMe) {
        ring = this.add.ellipse(p.x, p.y + PLAYER_H * 0.4, 44, 14, CHAR_COLORS[p.char || 'Blue'] || 0x3b82f6, 0.5);
      }

      // Name tag
      const nameText = this.add.text(p.x, p.y - PLAYER_H * 0.6, p.name, {
        fontSize: '12px',
        fontFamily: 'Fredoka One, sans-serif',
        color: isMe ? '#f59e0b' : '#e0e0ff',
        stroke: '#000000',
        strokeThickness: 3,
      }).setOrigin(0.5, 1);

      this.players[p.id] = {
        sprite, shadow, ring, nameText,
        alive: true, x: p.x, y: p.y,
        char: p.char || 'Blue',
        walkFrame: 0, walkTimer: 0,
      };
    });
  }

  // ── Update player visual position ─────────────────────────────────────────
  updatePlayerSprite(id, x, y, moving) {
    const p = this.players[id];
    if (!p) return;
    p.x = x; p.y = y;

    // Walk animation using real scene time
    const now = this.time.now;
    if (!p._lastWalkFlip) p._lastWalkFlip = now;
    if (now - p._lastWalkFlip > 200) {
      p._lastWalkFlip = now;
      p.walkFrame = 1 - p.walkFrame;
    }
    const pose = moving ? (p.walkFrame === 0 ? 'walk1' : 'walk2') : 'stand';
    const key = `alien${p.char}_${pose}`;
    if (this.textures.exists(key)) p.sprite.setTexture(key);

    p.sprite.setPosition(x, y);
    p.shadow.setPosition(x, y + PLAYER_H * 0.4);
    if (p.ring) p.ring.setPosition(x, y + PLAYER_H * 0.4);
    p.nameText.setPosition(x, y - PLAYER_H * 0.6);
  }

  // ── HUD ───────────────────────────────────────────────────────────────────
  createHUD() {
    const W = gameData.arenaW;
    // Kenney-style wooden HUD bar
    this.add.rectangle(W / 2, 20, W, 40, 0x5C3A1E, 1).setDepth(10);
    this.add.rectangle(W / 2, 20, W - 4, 36, 0x8B5E3C, 1).setDepth(10);
    this.add.rectangle(W / 2, 40, W, 2, 0x3d2010, 1).setDepth(10);

    this.timerText = this.add.text(W / 2, 20, '0:00', {
      fontSize: '18px', fontFamily: 'Fredoka One, sans-serif',
      color: '#fff8e7', stroke: '#3d1c00', strokeThickness: 3,
    }).setOrigin(0.5, 0.5).setDepth(11);

    this.aliveText = this.add.text(W - 14, 20, '♥ 1', {
      fontSize: '14px', fontFamily: 'Fredoka One, sans-serif',
      color: '#ffd080', stroke: '#3d1c00', strokeThickness: 2,
    }).setOrigin(1, 0.5).setDepth(11);
  }

  updateHUD(elapsed, aliveCount) {
    if (!this.timerText) return;
    const secs = Math.floor(elapsed / 1000);
    this.timerText.setText(`${Math.floor(secs/60)}:${(secs%60).toString().padStart(2,'0')}`);
    if (this.aliveText) this.aliveText.setText(`♥ ${aliveCount}`);
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  setupInput() {
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys('W,A,S,D');

    if (/Android|iPhone|iPad/i.test(navigator.userAgent) || window.innerWidth < 700) {
      this.setupJoystick();
    }

    if (socket) {
      this._moveInterval = setInterval(() => {
        if (this.myAlive) socket.emit('player_move', { x: this.myX, y: this.myY });
      }, 50);
    }
  }

  setupJoystick() {
    const zone = document.getElementById('joystick-zone');
    const base = document.getElementById('joystick-base');
    const knob = document.getElementById('joystick-knob');
    zone.style.display = 'block';
    let touchId = null, ox = 0, oy = 0;
    const R = 40;

    zone.addEventListener('touchstart', e => {
      e.preventDefault();
      if (touchId !== null) return;
      const t = e.changedTouches[0];
      touchId = t.identifier; ox = t.clientX; oy = t.clientY;
      base.style.cssText += `;left:${ox-50}px;top:${oy-50}px;opacity:1;`;
      knob.style.cssText += `;left:${ox-22}px;top:${oy-22}px;opacity:1;`;
    }, { passive: false });

    zone.addEventListener('touchmove', e => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== touchId) continue;
        const dx = t.clientX - ox, dy = t.clientY - oy;
        const len = Math.sqrt(dx*dx+dy*dy), cl = Math.min(len, R);
        const nx = len > 0 ? dx/len : 0, ny = len > 0 ? dy/len : 0;
        this.joyDx = nx * (cl/R); this.joyDy = ny * (cl/R);
        knob.style.left = (ox + nx*cl - 22) + 'px';
        knob.style.top = (oy + ny*cl - 22) + 'px';
      }
    }, { passive: false });

    const end = () => { touchId = null; this.joyDx = 0; this.joyDy = 0; base.style.opacity = 0; knob.style.opacity = 0; };
    zone.addEventListener('touchend', end);
    zone.addEventListener('touchcancel', end);
  }

  // ── My movement ───────────────────────────────────────────────────────────
  updateMyPosition(delta) {
    if (!this.myAlive) return;
    const speed = 220, dt = delta / 1000;
    let dx = this.joyDx, dy = this.joyDy;

    if (this.cursors?.left.isDown || this.wasd?.A?.isDown) dx = -1;
    else if (this.cursors?.right.isDown || this.wasd?.D?.isDown) dx = 1;
    if (this.cursors?.up.isDown || this.wasd?.W?.isDown) dy = -1;
    else if (this.cursors?.down.isDown || this.wasd?.S?.isDown) dy = 1;

    if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }

    const newX = Math.max(PLAYER_R, Math.min(gameData.arenaW - PLAYER_R, this.myX + dx * speed * dt));
    const newY = Math.max(PLAYER_R, Math.min(gameData.arenaH - PLAYER_R, this.myY + dy * speed * dt));
    const moving = Math.abs(newX - this.myX) > 0.5 || Math.abs(newY - this.myY) > 0.5;
    this.myX = newX; this.myY = newY;

    this.updatePlayerSprite(gameData.myId, this.myX, this.myY, moving);
  }

  // ── Update other players from server ─────────────────────────────────────
  updateOtherPlayers(playerUpdates) {
    if (!playerUpdates) return;
    playerUpdates.forEach(upd => {
      if (upd.id === gameData.myId) return;
      const p = this.players[upd.id];
      if (p) {
        const moving = Math.abs(upd.x - p.x) > 1 || Math.abs(upd.y - p.y) > 1;
        this.updatePlayerSprite(upd.id, upd.x, upd.y, moving);
        if (!upd.alive && p.alive) this.killPlayerVFX(upd.id);
      }
    });
  }

  // ── Death VFX ─────────────────────────────────────────────────────────────
  killPlayerVFX(id) {
    const p = this.players[id];
    if (!p || !p.alive) return;
    p.alive = false;

    // Switch to hit sprite
    const hitKey = `alien${p.char}_hit`;
    if (this.textures.exists(hitKey)) p.sprite.setTexture(hitKey);

    // Spin + fade
    this.tweens.add({
      targets: [p.sprite, p.shadow, p.nameText],
      alpha: 0, y: `+=${30}`, duration: 600, ease: 'Power2',
    });
    this.tweens.add({ targets: p.sprite, angle: 360, duration: 400 });

    // Stars/sparkles
    for (let i = 0; i < 6; i++) {
      const star = this.add.text(p.x, p.y, '⭐', { fontSize: '16px' }).setOrigin(0.5);
      const angle = (i / 6) * Math.PI * 2;
      this.tweens.add({
        targets: star, x: p.x + Math.cos(angle)*50, y: p.y + Math.sin(angle)*50,
        alpha: 0, duration: 600, onComplete: () => star.destroy(),
      });
    }

    if (id === gameData.myId) {
      this.myAlive = false;
      if (socket) socket.emit('player_died');
      // Death text
      const msg = this.add.text(gameData.arenaW/2, gameData.arenaH/2, '💀 Ausgeschieden!', {
        fontSize: '30px', fontFamily: 'Fredoka One, sans-serif',
        color: '#ef4444', stroke: '#000', strokeThickness: 4,
      }).setOrigin(0.5).setDepth(20).setAlpha(0);
      this.tweens.add({ targets: msg, alpha: 1, y: gameData.arenaH/2 - 20, duration: 500 });
      // Dim overlay
      this.add.rectangle(gameData.arenaW/2, gameData.arenaH/2, gameData.arenaW, gameData.arenaH, 0x000000, 0.35).setDepth(15);
    }
  }

  onPlayerDied(data) {
    if (data.id !== gameData.myId) this.killPlayerVFX(data.id);
  }

  onTick() {}

  shutdown() {
    if (this._moveInterval) clearInterval(this._moveInterval);
    document.getElementById('joystick-zone').style.display = 'none';
  }
}

// ─── BULLET BARRAGE ───────────────────────────────────────────────────────────

class BulletBarrageScene extends ArenaScene {
  constructor() { super({ key: 'BulletBarrage' }); }

  create() {
    this.createArena();
    this.createHUD();
    this.createPlayers();
    this.setupInput();

    this._trailGfx = this.add.graphics().setDepth(3);
    this._bullets = [];
    this._bulletTrails = new Map();
    this._bulletSprites = new Map(); // id → { img, rotSpeed }

    // Kenney-style sign banner
    const W = gameData.arenaW, H = gameData.arenaH;
    const banner = this.add.rectangle(W/2, H/2 - 20, 420, 78, 0x5C3A1E, 1).setDepth(20).setAlpha(0);
    const bannerInner = this.add.rectangle(W/2, H/2 - 20, 412, 70, 0x8B5E3C, 1).setDepth(20).setAlpha(0);
    const title = this.add.text(W/2, H/2 - 28, 'BULLET BARRAGE', {
      fontSize: '34px', fontFamily: 'Fredoka One, sans-serif',
      color: '#fff8e7', stroke: '#3d1c00', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(21).setAlpha(0);
    const sub = this.add.text(W/2, H/2 + 10, 'Weiche den Edelsteinen aus!', {
      fontSize: '15px', fontFamily: 'Fredoka One, sans-serif',
      color: '#ffd080', stroke: '#3d1c00', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(21).setAlpha(0);

    const allTitleObjs = [banner, bannerInner, title, sub];
    this.tweens.add({ targets: allTitleObjs, alpha: 1, duration: 300 });
    this.time.delayedCall(2200, () => {
      this.tweens.add({ targets: allTitleObjs, alpha: 0, duration: 400, onComplete: () => allTitleObjs.forEach(o => o.destroy()) });
    });

    if (gameData.myId === 'solo') this._startSolo();
  }

  _startSolo() {
    this._soloStart = Date.now();
    this._lastSpawn = Date.now(); // prevent immediate spawn
    this.time.addEvent({ delay: 50, loop: true, callback: this._soloTick, callbackScope: this });
  }

  _soloTick() {
    const elapsed = Date.now() - this._soloStart;
    const now = Date.now();
    const ramp = Math.max(0, elapsed - 10000);
    const spawnInterval = Math.max(500, 4000 - ramp * 0.09);

    if (now - this._lastSpawn > spawnInterval) {
      this._lastSpawn = now;
      const side = Math.floor(Math.random() * 4);
      const cappedSpeed = Math.min(280, 80 + ramp * 0.003);
      const rand = Math.random();
      let r, speed, color;
      if (elapsed > 40000 && rand < 0.25) {
        r = 6; speed = cappedSpeed * 1.6 + Math.random() * 40; color = 0xffffff;
      } else if (elapsed > 20000 && rand < 0.2) {
        r = 18; speed = cappedSpeed * 0.55 + Math.random() * 20; color = 0xff2200;
      } else {
        r = 10 + Math.random() * 6; speed = cappedSpeed + Math.random() * 35;
        const cols = [0xff4444, 0xff8800, 0x44ffff, 0xff44ff, 0x44ff88];
        color = cols[Math.floor(Math.random() * cols.length)];
      }
      const drift = (Math.random() - 0.5) * 50;
      let x, y, vx, vy;
      switch(side) {
        case 0: x = Math.random()*gameData.arenaW; y = -r-10; vx = drift; vy = speed; break;
        case 1: x = gameData.arenaW+r+10; y = Math.random()*gameData.arenaH; vx = -speed; vy = drift; break;
        case 2: x = Math.random()*gameData.arenaW; y = gameData.arenaH+r+10; vx = drift; vy = -speed; break;
        default: x = -r-10; y = Math.random()*gameData.arenaH; vx = speed; vy = drift;
      }
      const bid = this._soloNextId = (this._soloNextId || 0) + 1;
      this._bullets.push({ id: bid, x, y, vx, vy, r, color });
    }

    const dt = 0.05;
    this._bullets.forEach(b => { b.x += b.vx*dt; b.y += b.vy*dt; });
    this._bullets = this._bullets.filter(b => b.x > -60 && b.x < gameData.arenaW+60 && b.y > -60 && b.y < gameData.arenaH+60);

    if (this.myAlive) {
      this._bullets.forEach(b => {
        const dx = this.myX - b.x, dy = this.myY - b.y;
        if (dx*dx + dy*dy < (13 + b.r * 0.75)**2) this.killPlayerVFX(gameData.myId);
      });
    }

    this.updateHUD(elapsed, this.myAlive ? 1 : 0);
    this._syncBullets(this._bullets);
  }

  onTick(data) {
    this._bullets = data.bullets || [];
    this.updateOtherPlayers(data.players);
    const alive = data.players ? data.players.filter(p => p.alive).length : 0;
    this.updateHUD(data.elapsed, alive);
    this._syncBullets(this._bullets);
  }

  _getBulletTex(b) {
    if (b.type === 'dart') return 'gemYellow.png';
    if (b.type === 'bomb') return 'gemRed.png';
    const c = b.color || '';
    if (c === '#44ffff' || c === '#44ff88') return 'gemBlue.png';
    if (c === '#ff4444' || c === '#ff44ff' || c === '#ff2200') return 'gemRed.png';
    if (c === '#ff8800') return 'gemYellow.png';
    return 'gemGreen.png';
  }

  _syncBullets(bullets) {
    if (!this._trailGfx) return;
    const gfx = this._trailGfx;
    const activeIds = new Set(bullets.map(b => b.id));

    // Remove stale sprites and trails
    for (const [id, data] of this._bulletSprites) {
      if (!activeIds.has(id)) { data.img.destroy(); this._bulletSprites.delete(id); }
    }
    for (const id of this._bulletTrails.keys()) {
      if (!activeIds.has(id)) this._bulletTrails.delete(id);
    }

    gfx.clear();

    const hasItems = this.textures.exists('items');
    bullets.forEach(b => {
      // Trail
      if (!this._bulletTrails.has(b.id)) this._bulletTrails.set(b.id, []);
      const trail = this._bulletTrails.get(b.id);
      const last = trail[trail.length - 1];
      if (!last || Math.abs(last.x - b.x) > 0.5 || Math.abs(last.y - b.y) > 0.5) {
        trail.push({ x: b.x, y: b.y });
        if (trail.length > 6) trail.shift();
      }
      // Draw trail as small fading squares (pixel art style, no glow)
      const c = typeof b.color === 'string' ? parseInt(b.color.replace('#', '0x')) : (b.color || 0x44ffff);
      trail.forEach((pt, i) => {
        const t = (i + 1) / trail.length;
        const sz = b.r * t * 0.55;
        gfx.fillStyle(c, t * 0.45);
        gfx.fillRect(pt.x - sz, pt.y - sz, sz * 2, sz * 2);
      });

      // Gem sprite
      if (!this._bulletSprites.has(b.id)) {
        const frame = hasItems ? this._getBulletTex(b) : null;
        const img = frame
          ? this.add.image(b.x, b.y, 'items', frame).setDepth(4)
          : this.add.circle(b.x, b.y, b.r, c).setDepth(4);
        const size = Math.max(32, b.r * 3.2);
        img.setDisplaySize(size, size);
        img.setPixelPerfect = true;
        const rotSpeed = b.type === 'bomb' ? 0.8 : b.type === 'dart' ? 3.5 : 1.5 + Math.random();
        this._bulletSprites.set(b.id, { img, rotSpeed });
      } else {
        const data = this._bulletSprites.get(b.id);
        data.img.setPosition(b.x, b.y);
        data.img.angle += data.rotSpeed;
      }
    });
  }

  shutdown() {
    super.shutdown();
    for (const data of this._bulletSprites.values()) data.img.destroy();
    this._bulletSprites.clear();
  }

  update(_, delta) { this.updateMyPosition(delta); }
}

// ─── PENGUIN ATTACK ───────────────────────────────────────────────────────────

class PenguinAttackScene extends ArenaScene {
  constructor() { super({ key: 'PenguinAttack' }); }

  preload() {
    super.preload();
    // Load enemy sprites if available
    if (!this.textures.exists('enemies')) {
      this.load.atlas('enemies', '/assets/enemies/spritesheet_enemies.png', '/assets/enemies/spritesheet_enemies.xml');
    }
  }

  create() {
    this.createArena();
    this.createHUD();
    this.createPlayers();
    this.setupInput();

    this._penguinGfx = this.add.graphics().setDepth(3);
    this._penguins = [];

    // Lane dividers - subtle dark lines
    const g = this.add.graphics();
    g.lineStyle(2, 0x3d2010, 0.4);
    for (let i = 0; i < 4; i++) {
      const y = 80 + i * 120;
      g.moveTo(40, y - 45); g.lineTo(gameData.arenaW - 40, y - 45);
    }
    g.strokePath();

    const W = gameData.arenaW, H = gameData.arenaH;
    const banner = this.add.rectangle(W/2, H/2, 400, 78, 0x5C3A1E, 1).setDepth(20);
    const bannerInner = this.add.rectangle(W/2, H/2, 392, 70, 0x8B5E3C, 1).setDepth(20);
    const title = this.add.text(W/2, H/2 - 12, 'PINGUIN-ATTACKE', {
      fontSize: '34px', fontFamily: 'Fredoka One, sans-serif',
      color: '#fff8e7', stroke: '#3d1c00', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(21);
    const sub = this.add.text(W/2, H/2 + 20, 'Weiche den Pinguinen aus!', {
      fontSize: '15px', fontFamily: 'Fredoka One, sans-serif',
      color: '#ffd080', stroke: '#3d1c00', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(21);

    const objs = [banner, bannerInner, title, sub];
    this.time.delayedCall(2200, () => {
      this.tweens.add({ targets: objs, alpha: 0, duration: 400, onComplete: () => objs.forEach(o => o.destroy()) });
    });
  }

  onTick(data) {
    this._penguins = data.penguins || [];
    this.updateOtherPlayers(data.players);
    const alive = data.players ? data.players.filter(p => p.alive).length : 0;
    this.updateHUD(data.elapsed, alive);

    this._penguinGfx.clear();
    this._penguins.forEach(pg => this._drawPenguin(pg));
  }

  _drawPenguin(pg) {
    const g = this._penguinGfx;
    const { x, y } = pg;
    // Shadow
    g.fillStyle(0x000000, 0.2);
    g.fillEllipse(x, y + 28, 36, 8);
    // Body
    g.fillStyle(0x1a1a2e, 1);
    g.fillEllipse(x, y, 42, 58);
    // Belly
    g.fillStyle(0xffffff, 1);
    g.fillEllipse(x + 1, y + 6, 22, 32);
    // Cheek blush
    g.fillStyle(0xff9999, 0.6);
    g.fillCircle(x - 13, y + 4, 7);
    g.fillCircle(x + 13, y + 4, 7);
    // Eyes
    g.fillStyle(0xffffff, 1);
    g.fillCircle(x - 8, y - 8, 7);
    g.fillCircle(x + 8, y - 8, 7);
    g.fillStyle(0x111122, 1);
    g.fillCircle(x - 7, y - 7, 4);
    g.fillCircle(x + 9, y - 7, 4);
    // Pupils reflect
    g.fillStyle(0xffffff, 0.8);
    g.fillCircle(x - 6, y - 8, 1.5);
    g.fillCircle(x + 10, y - 8, 1.5);
    // Beak
    g.fillStyle(0xff8800, 1);
    g.fillTriangle(x - 5, y - 2, x + 5, y - 2, x, y + 5);
    // Feet
    g.fillStyle(0xff8800, 1);
    g.fillEllipse(x - 10, y + 30, 14, 6);
    g.fillEllipse(x + 10, y + 30, 14, 6);
  }

  update(_, delta) { this.updateMyPosition(delta); }
}

// ─── MAGMA MADNESS ────────────────────────────────────────────────────────────

class MagmaMadnessScene extends ArenaScene {
  constructor() { super({ key: 'MagmaMadness' }); }

  create() {
    this.COLS = 16; this.ROWS = 11;
    this._tiles = null;
    this._tileGfx = this.add.graphics().setDepth(1);
    this._t = 0;
    this.createArena();
    this.createHUD();

    const W = gameData.arenaW, H = gameData.arenaH;
    const banner = this.add.rectangle(W/2, H/2, 380, 78, 0x5C3A1E, 1).setDepth(20);
    const bannerInner = this.add.rectangle(W/2, H/2, 372, 70, 0x8B5E3C, 1).setDepth(20);
    const title = this.add.text(W/2, H/2 - 12, 'MAGMA MADNESS', {
      fontSize: '34px', fontFamily: 'Fredoka One, sans-serif',
      color: '#fff8e7', stroke: '#3d1c00', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(21);
    const sub = this.add.text(W/2, H/2 + 20, 'Falle nicht in die Lava!', {
      fontSize: '15px', fontFamily: 'Fredoka One, sans-serif',
      color: '#ffd080', stroke: '#3d1c00', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(21);

    const objs = [banner, bannerInner, title, sub];
    this.time.delayedCall(2200, () => {
      this.tweens.add({ targets: objs, alpha: 0, duration: 400, onComplete: () => { objs.forEach(o => o.destroy()); this.createPlayers(); this.setupInput(); } });
    });
  }

  onTick(data) {
    this._tiles = data.tiles;
    this.updateOtherPlayers(data.players);
    const alive = data.players ? data.players.filter(p => p.alive).length : 0;
    this.updateHUD(data.elapsed, alive);
  }

  update(_, delta) {
    this._t += delta;
    this.updateMyPosition(delta);
    if (this._tiles) this._renderTiles();
  }

  _renderTiles() {
    const tW = gameData.arenaW / this.COLS, tH = gameData.arenaH / this.ROWS;
    this._tileGfx.clear();

    for (let r = 0; r < this.ROWS; r++) {
      for (let c = 0; c < this.COLS; c++) {
        const solid = this._tiles[r][c] === 1;
        const x = c * tW + 1, y = r * tH + 1, w = tW - 2, h = tH - 2;

        if (solid) {
          // Kenney brickBrown style: tan base + highlight top-left + shadow bottom-right
          this._tileGfx.fillStyle(0x9B7540, 1);
          this._tileGfx.fillRect(x, y, w, h);
          this._tileGfx.fillStyle(0xB8924E, 1);
          this._tileGfx.fillRect(x, y, w, 3);
          this._tileGfx.fillRect(x, y, 3, h);
          this._tileGfx.fillStyle(0x7A5C32, 1);
          this._tileGfx.fillRect(x, y + h - 3, w, 3);
          this._tileGfx.fillRect(x + w - 3, y, 3, h);
          // Mortar lines
          this._tileGfx.fillStyle(0x5C3A1E, 0.6);
          this._tileGfx.fillRect(x, y, w, 1);
          this._tileGfx.fillRect(x, y, 1, h);
        } else {
          // Lava - animated orange/red
          const wave = Math.sin(this._t * 0.003 + c * 0.4 + r * 0.6);
          this._tileGfx.fillStyle(0xCC3300, 1);
          this._tileGfx.fillRect(x, y, w, h);
          this._tileGfx.fillStyle(0xFF5500, 0.55 + wave * 0.2);
          this._tileGfx.fillEllipse(x + w/2, y + h/2 + 2, w * 0.65, h * 0.5);
          this._tileGfx.fillStyle(0xFF8800, 0.4 + Math.max(0, wave) * 0.35);
          this._tileGfx.fillEllipse(x + w/2, y + h * 0.35, w * 0.4, h * 0.3);
          this._tileGfx.fillStyle(0xFFCC00, 0.15 + Math.max(0, wave) * 0.2);
          this._tileGfx.fillCircle(x + w/2, y + h * 0.25, h * 0.15);
        }
      }
    }
  }
}

// ─── Score screen ─────────────────────────────────────────────────────────────

const RANK_EMOJIS = ['🥇', '🥈', '🥉', '4.', '5.', '6.', '7.', '8.'];

function showScoreScreen(scores) {
  const sorted = [...scores].sort((a, b) => b.totalPts - a.totalPts);
  const list = document.getElementById('score-list');
  list.innerHTML = '';
  sorted.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="rank">${RANK_EMOJIS[i] || (i+1)}</span>
      <img src="/assets/chars/alien${p.char || 'Blue'}_front.png" style="width:24px;height:48px;object-fit:contain;image-rendering:pixelated;" alt="">
      <span style="flex:1">${p.name}</span>
      <span class="pts">+${p.roundPts || 0}</span>
    `;
    list.appendChild(li);
  });
  document.getElementById('score-screen').style.display = 'flex';
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

const SCENE_KEYS = { bullet_barrage: 'BulletBarrage', penguin_attack: 'PenguinAttack', magma_madness: 'MagmaMadness' };

game.scene.add('BulletBarrage', BulletBarrageScene, false);
game.scene.add('PenguinAttack', PenguinAttackScene, false);
game.scene.add('MagmaMadness', MagmaMadnessScene, false);

function launchGame(gameName) {
  const key = SCENE_KEYS[gameName] || 'BulletBarrage';
  game.scene.start(key);
}

if (gameData.myId !== 'solo') connectSocket();
launchGame(gameData.game || 'bullet_barrage');
