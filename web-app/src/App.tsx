import { useState, useEffect, useRef } from 'react';
import './App.css';

// --- 設定値 ---
const ANGLE_TO_MOVE = 40;     
const ANGLE_TO_WAIT = 30;     
const HOOK_FORCE_DIFF = 15;   
const HIT_RADIUS = 5;
const FISH_AI_TICK_MS = 1000; 

// 基本パラメータ
const FISH_TURN_SPEED = 0.15; 
const FISH_MOVE_SPEED = 0.2;  
const FISH_DASH_SPEED = 0.8;  

const FISH_NOTICE_DIST = 20;
const ORBIT_RADIUS = 4; 

// ★機能復活: 各種オフセット設定 (後で調整可能)
const HOOK_TIP_OFFSET_X = 0.0;  // 針先のXズレ補正
const HOOK_TIP_OFFSET_Y = 1.0;  // 針先のYズレ補正
const FLOAT_OFFSET_X = 0;       // ウキ表示のXズレ補正(px)
const FLOAT_OFFSET_Y = 0;       // ウキ表示のYズレ補正(px)

const SPOOK_RADIUS = 8;    
const NIBBLE_RADIUS = 6; 
const DIRECT_HIT_RADIUS = 3.0;

const SPLASH_PANIC_RADIUS = 25;

const JOY_DEAD_ZONE = 8000;   
const JOY_SPEED = 40000;      

const DESPAWN_MIN_MS = 10000;
const DESPAWN_MAX_MS = 60000;

const NIBBLE_MIN_MS = 1000;
const NIBBLE_MAX_MS = 7000;

type FishType = 'NORMAL' | 'RARE' | 'TRASH' | 'FRY' | 'MASTER' | 'PHANTOM';

interface FishEntity {
  id: number;
  type: FishType;
  x: number;
  y: number;
  angle: number;
  size: number;
  baseSize: number;
  baseScore: number;
  hue: number;
  baseReaction: number;
  
  state: 'IDLE' | 'APPROACHING' | 'NIBBLING' | 'ATTACKING' | 'FLEEING' | 'HOOKED' | 'CAUGHT' | 'GONE';
  targetX: number;
  targetY: number;
  
  spawnTime: number;
  lastNoticeTime: number; 
  nibbleStartTime: number;
  attackDelay: number;
  isRecoiling: boolean;
  angleLock: number | null;
  nibbleSeed: number;
  fleeAngle: number | null;
  maxPatience: number;
  
  caughtTime: number;
}

const smoothAngle = (current: number, target: number, smoothing: number) => {
    let delta = target - current;
    while (delta <= -180) delta += 360;
    while (delta > 180) delta -= 360;
    return current + delta * smoothing;
};

const moveForward = (currentPos: {x:number, y:number}, angleDeg: number, speed: number) => {
    const rad = angleDeg * (Math.PI / 180);
    return {
        x: currentPos.x + Math.cos(rad) * speed,
        y: currentPos.y + Math.sin(rad) * speed
    };
};

type SensorData = {
  roll: number;
  pitch: number;
  joyX: number;
  joyY: number;
  btn1: number;
  btn2: number;
};

type GameState = 'AIMING' | 'SINKING' | 'BITE';

type Notification = {
  text: string;
  color: string;
  id: number;
} | null;

const getRandomPos = () => ({
  x: 10 + Math.random() * 80,
  y: 10 + Math.random() * 80
});

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [playerState, setPlayerState] = useState<GameState>('AIMING');
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [message, setMessage] = useState("ROD UP TO MOVE");
  const [notification, setNotification] = useState<Notification>(null);
  const [debugDist, setDebugDist] = useState(999);

  const [maxFishCount, setMaxFishCount] = useState(5);
  const maxFishCountRef = useRef(5);

  const [renderFishList, setRenderFishList] = useState<FishEntity[]>([]);
  const fishEntitiesRef = useRef<FishEntity[]>([]);
  const fishDomRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  
  const nextParticleIdRef = useRef(1);

  const sensorRef = useRef<SensorData>({ roll: 0, pitch: 0, joyX: 32768, joyY: 32768, btn1: 0, btn2: 0 });
  const hookPosRef = useRef({ x: 50, y: 50 });
  
  const activeFishIdRef = useRef<number | null>(null);
  const biteTimeRef = useRef(0);
  const pitchAtBiteRef = useRef(0);
  
  const nextFishIdRef = useRef(1);
  const hookDivRef = useRef<HTMLDivElement>(null);

  const connectTo_Pico = async () => {
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      setIsConnected(true);
      readLoop(port);
    } catch (e) { console.error(e); }
  };

  const readLoop = async (port: SerialPort) => {
    const decoder = new TextDecoderStream();
    port.readable!.pipeTo(decoder.writable);
    const reader = decoder.readable.getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const lines = buffer.split(/[\r\n]+/);
          buffer = lines.pop() || "";
          lines.forEach(line => { if(line.trim()) parseData(line); });
        }
      }
    } finally { reader.releaseLock(); }
  };

  const parseData = (line: string) => {
    const parts = line.split(',');
    if (parts.length === 6) {
      const p = parts.map(parseFloat);
      if (!isNaN(p[0])) {
        sensorRef.current = { roll: p[1], pitch: p[0], joyX: p[2], joyY: p[3], btn1: p[4], btn2: p[5] };
      }
    }
  };

  const applyPenalty = (fish: FishEntity, reason: string, now: number) => {
      setCombo(0); 
      
      const potentialScore = Math.round(fish.baseScore * fish.size);
      let change = 0;
      
      if (fish.type === 'FRY') change = 0;
      else if (fish.type === 'TRASH') change = potentialScore * 2; 
      else change = -Math.round(potentialScore * 0.5); 
      
      setScore(s => s + change);
      
      const diffDisp = change > 0 ? `+${change}` : (change === 0 ? "±0" : `${change}`);
      let color = "cyan"; 
      if (reason === 'SPOOKED!' || reason === 'SPLASH!') color = "red";
      if (reason.includes('TOO EARLY')) color = "orange";
      
      setNotification({ text: `${reason} ${diffDisp}`, color: color, id: now });
  };

  const createFish = (): FishEntity => {
    const rand = Math.random(); 
    const pos = getRandomPos();
    let stats: Partial<FishEntity> = {};

    if (rand < 0.02) { 
      const baseSize = 5.0; const size = 4.5 + Math.random() * 1.0; 
      stats = { type: 'MASTER', size, baseSize, baseScore: 1000, hue: 0, baseReaction: 500 };
    } else if (rand < 0.05) { 
      const baseSize = 0.5; const size = 0.4 + Math.random() * 0.2;
      stats = { type: 'PHANTOM', size, baseSize, baseScore: 500, hue: 180, baseReaction: 600 };
    } else if (rand < 0.15) { 
      const baseSize = 1.2; const size = 0.8 + Math.random() * 0.8;
      stats = { type: 'RARE', size, baseSize, baseScore: 300, hue: 45, baseReaction: 800 };
    } else if (rand < 0.30) { 
      const baseSize = 1.0; const size = 0.8 + Math.random() * 0.7;
      stats = { type: 'TRASH', size, baseSize, baseScore: -50, hue: 120, baseReaction: 1500 };
    } else if (rand < 0.50) { 
      const baseSize = 0.4; const size = 0.3 + Math.random() * 0.2;
      stats = { type: 'FRY', size, baseSize, baseScore: 10, hue: 300, baseReaction: 2000 };
    } else { 
      const baseSize = 1.0; const size = 0.8 + Math.random() * 1.2; 
      stats = { type: 'NORMAL', size, baseSize, baseScore: 100, hue: 240, baseReaction: 1000 };
    }

    const maxPatience = DESPAWN_MIN_MS + Math.random() * (DESPAWN_MAX_MS - DESPAWN_MIN_MS);

    return {
        id: nextFishIdRef.current++,
        x: pos.x, y: pos.y,
        angle: Math.random() * 360,
        targetX: pos.x, targetY: pos.y,
        state: 'IDLE',
        spawnTime: performance.now(),
        lastNoticeTime: performance.now(),
        nibbleStartTime: 0,
        attackDelay: 0,
        isRecoiling: false,
        angleLock: null,
        nibbleSeed: Math.random() * 100,
        fleeAngle: null,
        maxPatience: maxPatience, 
        caughtTime: 0,
        ...stats
    } as FishEntity;
  };

  useEffect(() => {
    const handleResize = () => {
        const width = window.innerWidth;
        const calcCount = Math.floor(width / 150); 
        const finalCount = Math.max(3, Math.min(20, calcCount));
        
        setMaxFishCount(finalCount);
        maxFishCountRef.current = finalCount;
    };

    window.addEventListener('resize', handleResize);
    handleResize(); 

    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!isConnected) return;
    
    let timeoutId: number;

    const scheduleNextSpawn = () => {
        const currentCount = fishEntitiesRef.current.filter(f => f.state !== 'GONE').length;
        const max = maxFishCountRef.current;

        if (currentCount >= max) {
            timeoutId = window.setTimeout(scheduleNextSpawn, 1000);
            return;
        }

        const ratio = currentCount / max;
        let minMs = 1000;
        let maxMs = 5000;

        if (ratio < 0.3) {
            minMs = 1000; maxMs = 5000;
        } else if (ratio < 0.7) {
            minMs = 5000; maxMs = 10000;
        } else {
            minMs = 10000; maxMs = 30000;
        }

        const delay = minMs + Math.random() * (maxMs - minMs);

        timeoutId = window.setTimeout(() => {
            const currentNow = fishEntitiesRef.current.filter(f => f.state !== 'GONE').length;
            if (currentNow < maxFishCountRef.current) {
                const newFish = createFish();
                fishEntitiesRef.current.push(newFish);
                setRenderFishList([...fishEntitiesRef.current]);
            }
            scheduleNextSpawn();
        }, delay);
    };

    scheduleNextSpawn(); 

    return () => clearTimeout(timeoutId);
  }, [isConnected]); 

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  useEffect(() => {
    if (!isConnected) return;
    let frameId: number;

    const loop = () => {
      const sensor = sensorRef.current;
      const now = performance.now();
      const isRodDown = sensor.pitch < ANGLE_TO_WAIT;
      
      // --- プレイヤー状態制御 ---
      if (!isRodDown && playerState !== 'BITE') {
          if (playerState !== 'AIMING') setPlayerState('AIMING');
          
          if (Math.abs(sensor.joyX - 32768) > JOY_DEAD_ZONE) hookPosRef.current.x -= (sensor.joyX - 32768) / JOY_SPEED; 
          if (Math.abs(sensor.joyY - 32768) > JOY_DEAD_ZONE) hookPosRef.current.y += (sensor.joyY - 32768) / JOY_SPEED;
          hookPosRef.current.x = Math.max(0, Math.min(100, hookPosRef.current.x));
          hookPosRef.current.y = Math.max(0, Math.min(100, hookPosRef.current.y));
          
          setMessage("SEARCHING...");
      } 
      else if (isRodDown && playerState === 'AIMING') {
          setPlayerState('SINKING');
          setMessage("🐟 WAITING... 🐟");

          // 着水時のSPOOK判定
          let splashTriggered = false;
          fishEntitiesRef.current.forEach(f => {
              if (f.state === 'FLEEING' || f.state === 'GONE' || f.state === 'CAUGHT') return;
              
              const dx = hookPosRef.current.x - f.x;
              const dy = hookPosRef.current.y - f.y; 
              const dist = Math.sqrt(dx*dx + dy*dy);

              if (dist < SPOOK_RADIUS) { 
                  f.state = 'FLEEING';
                  f.fleeAngle = null; 
                  if (!splashTriggered) {
                      applyPenalty(f, 'SPOOKED!', now);
                      splashTriggered = true;
                  }
              }
          });
      }

      // --- 全魚のAI & 移動処理 ---
      let closestDist = 999;

      // ★機能復活: X軸オフセット込みでTip座標計算
      const tipX = hookPosRef.current.x + HOOK_TIP_OFFSET_X;
      const tipY = hookPosRef.current.y + HOOK_TIP_OFFSET_Y;

      fishEntitiesRef.current.forEach(fish => {
          if (fish.state === 'GONE') return;

          if (fish.state === 'CAUGHT') {
              const progress = (now - fish.caughtTime) / 1000; 
              if (progress >= 1.0) {
                  fish.state = 'GONE';
              } else {
                  fish.y -= 0.1; 
              }
              return; 
          }

          const dx = hookPosRef.current.x - fish.x;
          const dy = hookPosRef.current.y - fish.y;
          const distToHook = Math.sqrt(dx*dx + dy*dy);
          if (distToHook < closestDist) closestDist = distToHook;

          if (distToHook > FISH_NOTICE_DIST && fish.state !== 'FLEEING' && fish.state !== 'HOOKED') {
              if (now - fish.lastNoticeTime > fish.maxPatience) {
                  fish.state = 'GONE'; 
                  return;
              }
          } else {
              fish.lastNoticeTime = now; 
          }

          if (fish.state === 'FLEEING') {
              if (fish.fleeAngle === null) {
                  if (distToHook < 0.1) {
                      fish.fleeAngle = Math.random() * 360;
                  } else {
                      fish.fleeAngle = Math.atan2(fish.y - hookPosRef.current.y, fish.x - hookPosRef.current.x) * (180/Math.PI);
                  }
              }

              fish.angle = smoothAngle(fish.angle, fish.fleeAngle!, FISH_TURN_SPEED);
              const move = moveForward(fish, fish.angle, FISH_DASH_SPEED);
              fish.x = move.x; fish.y = move.y;
              
              if (fish.x < -10 || fish.x > 110 || fish.y < -10 || fish.y > 110) {
                  fish.state = 'GONE';
              }
          }
          else if (fish.state === 'HOOKED') {
              if (playerState === 'BITE') {
                  fish.x = tipX;
                  fish.y = tipY;
              } else {
                  fish.state = 'FLEEING';
                  fish.fleeAngle = null; 
              }
          }
          else {
              if (playerState === 'BITE' && fish.id !== activeFishIdRef.current) {
                  if (fish.state !== 'FLEEING') {
                      const dxP = hookPosRef.current.x - fish.x;
                      const dyP = hookPosRef.current.y - fish.y;
                      const distP = Math.sqrt(dxP*dxP + dyP*dyP);
                      
                      if (distP < SPLASH_PANIC_RADIUS) {
                          fish.state = 'FLEEING';
                          fish.fleeAngle = null;
                      }
                  }
              }
              else {
                  if (playerState === 'AIMING' || distToHook > FISH_NOTICE_DIST) {
                      fish.state = 'IDLE';
                      if (Math.random() < 0.02) {
                          fish.targetX += (Math.random()-0.5) * 20;
                          fish.targetY += (Math.random()-0.5) * 20;
                          
                          // ★修正: 画面外へ行かないようにクランプ (5%~95%)
                          fish.targetX = Math.max(5, Math.min(95, fish.targetX));
                          fish.targetY = Math.max(5, Math.min(95, fish.targetY));
                      }
                      const tdx = fish.targetX - fish.x;
                      const tdy = fish.targetY - fish.y;
                      const distToTarget = Math.sqrt(tdx*tdx + tdy*tdy);
                      
                      let targetAng = fish.angle;
                      if (distToTarget > 1) targetAng = Math.atan2(tdy, tdx) * (180/Math.PI);
                      
                      fish.angle = smoothAngle(fish.angle, targetAng, FISH_TURN_SPEED * 0.5);
                      const speed = distToTarget > 1 ? FISH_MOVE_SPEED * 0.5 : 0;
                      const move = moveForward(fish, fish.angle, speed);
                      fish.x = move.x; fish.y = move.y;
                  }
                  else {
                      // 着水直撃判定はループ前で行っているのでここでは削除済
                      
                      if (fish.state === 'ATTACKING') {
                          const adx = tipX - fish.x;
                          const ady = tipY - fish.y;
                          const distTip = Math.sqrt(adx*adx + ady*ady);

                          if (distTip > 1.0) {
                              fish.angle = Math.atan2(ady, adx) * (180/Math.PI);
                              const move = moveForward(fish, fish.angle, FISH_DASH_SPEED * 1.5);
                              fish.x = move.x; fish.y = move.y;
                          } else {
                              fish.state = 'HOOKED';
                              setPlayerState('BITE');
                              setMessage("!!! PULL UP !!!");
                              
                              activeFishIdRef.current = fish.id; 
                              biteTimeRef.current = now;
                              pitchAtBiteRef.current = sensor.pitch;
                          }
                      }
                      else {
                          if (distToHook < SPOOK_RADIUS && playerState === 'AIMING') {
                              fish.state = 'FLEEING';
                              fish.fleeAngle = null; 
                          }
                          else {
                              const adx = tipX - fish.x;
                              const ady = tipY - fish.y;
                              const distTip = Math.sqrt(adx*adx + ady*ady); 

                              if (distTip < 2.0 && fish.angleLock === null) fish.angleLock = fish.angle;
                              else if (distTip >= 2.0) fish.angleLock = null;

                              let targetAng = fish.angle;
                              if (fish.angleLock !== null) targetAng = fish.angleLock;
                              else if (distTip > 0.1) targetAng = Math.atan2(ady, adx) * (180/Math.PI);

                              if (distTip < NIBBLE_RADIUS) {
                                  if (fish.nibbleStartTime === 0) {
                                      fish.nibbleStartTime = now;
                                      fish.attackDelay = NIBBLE_MIN_MS + Math.random() * (NIBBLE_MAX_MS - NIBBLE_MIN_MS);
                                  } else {
                                      if (now - fish.nibbleStartTime > fish.attackDelay && playerState !== 'BITE') {
                                          fish.state = 'ATTACKING';
                                          fish.angleLock = null;
                                          fish.isRecoiling = false;
                                      }
                                  }
                              } else {
                                  fish.nibbleStartTime = 0; 
                              }

                              let speed = 0;
                              let turn = FISH_TURN_SPEED;
                              const peckSignal = Math.pow(Math.sin(now / 1500 + fish.nibbleSeed), 20);
                              
                              if (fish.isRecoiling) {
                                  speed = -0.15; turn = 0.5;
                                  if (distTip > ORBIT_RADIUS) fish.isRecoiling = false;
                              } else if (peckSignal > 0.1 && distTip < ORBIT_RADIUS + 2.0) { 
                                  speed = 0.4; turn = 0.2;
                                  if (distTip < 0.5) fish.isRecoiling = true;
                              } else {
                                  if (distTip > ORBIT_RADIUS + 0.5) speed = FISH_MOVE_SPEED * 0.5;
                                  else if (distTip < ORBIT_RADIUS - 0.5) speed = -0.05;
                                  else {
                                      speed = 0;
                                      targetAng += Math.sin(now/500 + fish.nibbleSeed)*5;
                                  }
                              }

                              fish.angle = smoothAngle(fish.angle, targetAng, turn);
                              const move = moveForward(fish, fish.angle, speed);
                              fish.x = move.x; fish.y = move.y;
                          }
                      }
                  }
              }
          }
      });

      // --- 結果判定 ---
      if (playerState === 'BITE' && activeFishIdRef.current !== null) {
          const fish = fishEntitiesRef.current.find(f => f.id === activeFishIdRef.current);
          if (fish) {
              const timeDiff = now - biteTimeRef.current;
              const ratio = fish.size / fish.baseSize;
              const requiredTime = fish.baseReaction * (1.0 / ratio);

              let result: 'win' | 'lose' | null = null;
              
              if (timeDiff > requiredTime) result = 'lose'; 
              else if (sensor.pitch - pitchAtBiteRef.current > HOOK_FORCE_DIFF) result = 'win';

              if (result) {
                  const potentialScore = Math.round(fish.baseScore * fish.size);
                  
                  if (result === 'win') {
                      if (fish.type === 'TRASH') {
                          setCombo(0);
                          setScore(s => s + potentialScore); 
                          setNotification({ text: `BAD!! ${potentialScore}`, color: "gray", id: now });
                      } else {
                          setCombo(c => c + 1);
                          const bonus = 1.0 + ((combo + 1) * 0.1); 
                          const final = Math.round(potentialScore * bonus);
                          setScore(s => s + final);
                          
                          let label = "GET!!"; let col = "gold";
                          if (fish.type === 'RARE') { label = "RARE!!"; col = "orange"; }
                          else if (fish.type === 'PHANTOM') { label = "PHANTOM!!"; col = "cyan"; }
                          else if (fish.type === 'MASTER') { label = "MASTER!!!"; col = "red"; }
                          else if (fish.type === 'FRY') { label = "Tiny..."; col = "pink"; }
                          
                          let txt = `${label} +${final}`;
                          if (combo > 0) txt += ` (Combo x${bonus.toFixed(1)})`;
                          setNotification({ text: txt, color: col, id: now });
                      }
                      
                      fish.state = 'CAUGHT';
                      fish.caughtTime = now;
                      activeFishIdRef.current = null;
                      setPlayerState('AIMING');

                  } else {
                      fish.state = 'FLEEING';
                      fish.fleeAngle = null; 
                      applyPenalty(fish, 'MISS...', now);
                      activeFishIdRef.current = null;
                      setPlayerState('AIMING');
                  }

                  fishEntitiesRef.current.forEach(f => {
                      if (f.state !== 'GONE' && f.state !== 'HOOKED' && f.state !== 'FLEEING' && f.state !== 'CAUGHT') {
                          const dxS = hookPosRef.current.x - f.x;
                          const dyS = hookPosRef.current.y - f.y;
                          const distS = Math.sqrt(dxS*dxS + dyS*dyS);
                          
                          if (distS < SPLASH_PANIC_RADIUS) {
                              f.state = 'FLEEING';
                              f.fleeAngle = null; 
                          }
                      }
                  });
              }
          }
      }
      
      // TOO EARLY (SPOOKED) check
      if (playerState === 'SINKING' && sensor.pitch >= ANGLE_TO_MOVE) {
          let eventTriggered = false; 

          fishEntitiesRef.current.forEach(f => {
             if (f.state === 'FLEEING' || f.state === 'GONE' || f.state === 'CAUGHT') return;

             // ★修正: Tip座標で判定
             const dx = tipX - f.x;
             const dy = tipY - f.y;
             const dist = Math.sqrt(dx*dx + dy*dy);

             if (dist < NIBBLE_RADIUS) {
                 f.state = 'FLEEING';
                 f.fleeAngle = null; 
                 if (!eventTriggered) {
                     applyPenalty(f, 'TOO EARLY!', now); 
                     eventTriggered = true;
                 }
             } 
             else if (dist < FISH_NOTICE_DIST) {
                 f.state = 'FLEEING';
                 f.fleeAngle = null; 
                 if (!eventTriggered) {
                     applyPenalty(f, 'SPOOKED!', now); 
                     eventTriggered = true;
                 }
             }
          });
          
          setPlayerState('AIMING'); 
      }

      setDebugDist(closestDist);

      if (hookDivRef.current) {
        hookDivRef.current.style.left = `${hookPosRef.current.x}%`;
        hookDivRef.current.style.top = `${hookPosRef.current.y}%`;
        // ★機能復活: ウキのオフセット適用
        hookDivRef.current.style.transform = `translate(calc(-50% + ${FLOAT_OFFSET_X}px), calc(-50% + ${FLOAT_OFFSET_Y}px))`;
      }
      
      fishEntitiesRef.current.forEach(fish => {
          const el = fishDomRefs.current.get(fish.id);
          if (el) {
              if (fish.state === 'GONE') {
                  el.style.display = 'none';
              } else {
                  el.style.display = 'block';
                  el.style.left = `${fish.x}%`;
                  el.style.top = `${fish.y}%`;
                  
                  let addRot = 0;
                  let scaleMult = 1.0;
                  let customOpacity = 1.0;

                  if (fish.state === 'HOOKED') {
                      addRot = Math.sin(now/40)*15;
                  } 
                  else if (fish.state === 'ATTACKING') {
                      scaleMult = 1.1;
                  }
                  else if (fish.state === 'CAUGHT') {
                      customOpacity = Math.max(0, 1.0 - ((now - fish.caughtTime) / 1000));
                  }
                  
                  const finalScale = fish.size * scaleMult;
                  el.style.opacity = `${customOpacity}`;
                  el.style.transform = `translate(0%, -50%) rotate(${fish.angle - 180 + addRot}deg) scale(${finalScale})`;
              }
          }
      });
      
      frameId = requestAnimationFrame(loop);
    };

    frameId = requestAnimationFrame(loop);
    return () => {
        cancelAnimationFrame(frameId);
    };
  }, [isConnected, playerState, combo]); 

  // クリーンアップ
  useEffect(() => {
      const interval = setInterval(() => {
          const alive = fishEntitiesRef.current.filter(f => f.state !== 'GONE');
          if (alive.length !== fishEntitiesRef.current.length) {
              fishEntitiesRef.current = alive;
              setRenderFishList([...alive]); 
          }
      }, 5000);
      return () => clearInterval(interval);
  }, []);

  return (
    <div className="game-container">
      {!isConnected && (
        <div className="start-screen">
          <h1>🎣 Ultimate Fishing VR</h1>
          <button onClick={connectTo_Pico} className="connect-btn">START</button>
        </div>
      )}

      {isConnected && (
        <>
          {notification && (
            <div key={notification.id} className="notification" style={{ color: notification.color }}>
              {notification.text}
            </div>
          )}

          <div className="state-display">
            STATE: <span className={playerState}>{playerState}</span> <br/>
            Angle: {sensorRef.current.pitch.toFixed(0)}°
          </div>

          <div className="hud">
            <div>SCORE: {score}</div>
            {combo > 0 && <div style={{ color: 'gold', fontSize: '20px' }}>COMBO: {combo}</div>}
            <div className={`message ${playerState === 'BITE' ? 'bite-text' : ''}`}>{message}</div>
          </div>

          <div className="pond">
            <div 
              ref={hookDivRef} 
              className={`hook ${playerState === 'AIMING' ? 'floating' : 'sinking'}`}
              style={{ transform: 'translate(-50%, -50%)' }}
            >
              {playerState === 'AIMING' ? '🛸' : '📍'}
            </div>
            
            {renderFishList.map(fish => (
              <div 
                key={fish.id}
                ref={el => {
                    if (el) fishDomRefs.current.set(fish.id, el);
                    else fishDomRefs.current.delete(fish.id);
                }}
                className={`fish appear`} 
                style={{ 
                    opacity: 1, 
                    transformOrigin: 'left center',
                    filter: `hue-rotate(${fish.hue}deg) ${fish.type==='MASTER' ? 'brightness(0.6) saturate(1.5)' : ''}`
                }} 
              >
                🐟
              </div>
            ))}
          </div>
          
          <div className="debug-bar" style={{fontSize: '20px', color: 'lime'}}>
             Active Fish: {renderFishList.length} / {maxFishCount}
          </div>
        </>
      )}
    </div>
  );
}

export default App;