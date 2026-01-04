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
const HOOK_TIP_OFFSET_Y = 2.5;

const SPOOK_RADIUS = 6;    
const NIBBLE_RADIUS = 6; 

const JOY_DEAD_ZONE = 8000;   
const JOY_SPEED = 40000;      

const RESPAWN_MIN_MS = 2000;
const RESPAWN_MAX_MS = 5000;

// TOO FARで放置されたとき消えるまでの時間 (10秒)
const DESPAWN_MS = 10000; 

// 焦らし時間
const NIBBLE_MIN_MS = 1000;
const NIBBLE_MAX_MS = 7000;

// 魚のタイプ定義
type FishType = 'NORMAL' | 'RARE' | 'TRASH' | 'FRY' | 'MASTER' | 'PHANTOM';

interface FishStats {
  type: FishType;
  size: number;        
  baseSize: number;    
  baseScore: number;   
  hue: number;         
  baseReaction: number;
}

// 角度補間関数
const smoothAngle = (current: number, target: number, smoothing: number) => {
    let delta = target - current;
    while (delta <= -180) delta += 360;
    while (delta > 180) delta -= 360;
    return current + delta * smoothing;
};

// 前進関数
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
  const [gameState, setGameState] = useState<GameState>('AIMING');
  const [score, setScore] = useState(0);
  const [message, setMessage] = useState("ROD UP TO MOVE");
  
  const [combo, setCombo] = useState(0);

  const [notification, setNotification] = useState<Notification>(null);
  const [debugDist, setDebugDist] = useState(999);

  const [isFishVisible, setIsFishVisible] = useState(false);

  const sensorRef = useRef<SensorData>({ roll: 0, pitch: 0, joyX: 32768, joyY: 32768, btn1: 0, btn2: 0 });
  const hookPosRef = useRef({ x: 50, y: 50 });
  
  const initialPos = getRandomPos();
  const fishPosRef = useRef(initialPos);       
  const fishTargetPosRef = useRef(initialPos); 
  const fishAngleRef = useRef(Math.random() * 360);

  const fishStatsRef = useRef<FishStats>({ 
    type: 'NORMAL', size: 1.0, baseSize: 1.0, baseScore: 100, hue: 0, baseReaction: 1000 
  });
  
  const spawnTimeRef = useRef(0);
  const lastNoticeTimeRef = useRef(0);

  const biteTimeRef = useRef(0);
  const pitchAtBiteRef = useRef(0);
  const lastFishAiTimeRef = useRef(0);
  const nibbleSeedRef = useRef(Math.random() * 100);
  const isAttackingRef = useRef(false);

  const isRecoilingRef = useRef(false);   
  const angleLockRef = useRef<number | null>(null); 
  const isHookedRef = useRef(false);

  const nibbleStartTimeRef = useRef(0);
  const attackDelayRef = useRef(0);

  const isFleeingRef = useRef(false);
  const isFishActiveRef = useRef(false);
  const respawnTimerRef = useRef<number | undefined>(undefined);

  const hookDivRef = useRef<HTMLDivElement>(null);
  const fishDivRef = useRef<HTMLDivElement>(null);

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

  const generateFish = (): FishStats => {
    const rand = Math.random(); 

    if (rand < 0.02) {
      const baseSize = 5.0;
      const size = 4.5 + Math.random() * 1.0; 
      return { type: 'MASTER', size, baseSize, baseScore: 1000, hue: 0, baseReaction: 500 };
    } 
    else if (rand < 0.05) {
      const baseSize = 0.5;
      const size = 0.4 + Math.random() * 0.2;
      return { type: 'PHANTOM', size, baseSize, baseScore: 500, hue: 180, baseReaction: 600 };
    }
    else if (rand < 0.15) {
      const baseSize = 1.2;
      const size = 0.8 + Math.random() * 0.8;
      return { type: 'RARE', size, baseSize, baseScore: 300, hue: 45, baseReaction: 800 };
    }
    else if (rand < 0.30) {
      const baseSize = 1.0;
      const size = 0.8 + Math.random() * 0.7;
      return { type: 'TRASH', size, baseSize, baseScore: -50, hue: 120, baseReaction: 1500 };
    }
    else if (rand < 0.50) {
      const baseSize = 0.4;
      const size = 0.3 + Math.random() * 0.2;
      return { type: 'FRY', size, baseSize, baseScore: 10, hue: 300, baseReaction: 2000 };
    }
    else {
      const baseSize = 1.0;
      const size = 0.8 + Math.random() * 1.2; 
      return { type: 'NORMAL', size, baseSize, baseScore: 100, hue: 240, baseReaction: 1000 };
    }
  };

  const scheduleRespawn = () => {
    if (respawnTimerRef.current) clearTimeout(respawnTimerRef.current);
    const waitTime = RESPAWN_MIN_MS + Math.random() * (RESPAWN_MAX_MS - RESPAWN_MIN_MS);
    respawnTimerRef.current = window.setTimeout(() => {
       const newPos = getRandomPos();
       fishPosRef.current = { ...newPos };
       fishTargetPosRef.current = { ...newPos };
       fishAngleRef.current = Math.random() * 360; 
       isFishActiveRef.current = true;
       
       fishStatsRef.current = generateFish();
       spawnTimeRef.current = performance.now();
       lastNoticeTimeRef.current = performance.now();

       isFleeingRef.current = false;
       nibbleStartTimeRef.current = 0; 
       isAttackingRef.current = false;
       isRecoilingRef.current = false;
       angleLockRef.current = null;
       isHookedRef.current = false;
       
       setIsFishVisible(true);
    }, waitTime);
  };

  useEffect(() => {
    if (isConnected) scheduleRespawn();
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

      const dx = hookPosRef.current.x - fishPosRef.current.x;
      const dy = hookPosRef.current.y - fishPosRef.current.y;
      const distance = Math.sqrt(dx*dx + dy*dy);
      
      if (Math.random() < 0.1) setDebugDist(distance);

      const handleResult = (result: 'win' | 'lose' | 'early' | 'spook' | 'vanish') => {
        if (isFleeingRef.current) return;

        const stats = fishStatsRef.current;
        let potentialScore = Math.round(stats.baseScore * stats.size);

        if (result === 'win') {
          // ★勝利処理
          if (stats.type === 'TRASH') {
              // 雑魚を釣ってしまった -> コンボリセット & 減点
              setCombo(0);
              setScore(s => s + potentialScore); 
              setNotification({ text: `BAD!! ${potentialScore}`, color: "gray", id: now });
          } else {
              // 成功 -> コンボ加算
              setCombo(prev => prev + 1);
              
              // コンボボーナス計算
              const bonusMultiplier = 1.0 + (combo * 0.1);
              const finalScore = Math.round(potentialScore * bonusMultiplier);
              
              setScore(s => s + finalScore);
              
              // 表示用ラベル決定
              let label = "GET!!";
              let color = "gold";

              if (stats.type === 'RARE') { label = "RARE!!"; color = "orange"; }
              else if (stats.type === 'PHANTOM') { label = "PHANTOM!!"; color = "cyan"; }
              else if (stats.type === 'MASTER') { label = "MASTER!!!"; color = "red"; }
              else if (stats.type === 'FRY') { label = "Tiny..."; color = "pink"; }

              // テキスト組み立て
              let resultText = `${label} +${finalScore}`;
              if (combo > 0) resultText += ` (Combo x${bonusMultiplier.toFixed(1)})`;

              setNotification({ text: resultText, color: color, id: now });
          }

          setTimeout(() => {
            isFishActiveRef.current = false;
            setIsFishVisible(false);
            isAttackingRef.current = false;
            setGameState('AIMING');
            scheduleRespawn();
          }, 0);

        } else if (result === 'vanish') {
            // 自然消滅 (コンボは維持)
            setNotification({ text: "Fish left...", color: "gray", id: now });
            setIsFishVisible(false);
            isFishActiveRef.current = false;
            setGameState('AIMING');
            scheduleRespawn();
        } else {
          // 失敗（逃走） -> コンボリセット
          setCombo(0);
          
          isFleeingRef.current = true;
          isHookedRef.current = false; 
          angleLockRef.current = null;

          let scoreChange = 0;
          if (stats.type === 'FRY') {
              scoreChange = 0; 
          } else if (stats.type === 'TRASH') {
              scoreChange = potentialScore * 2; 
          } else {
              scoreChange = -Math.round(potentialScore * 0.5); 
          }
          
          setScore(s => s + scoreChange);

          let text = "";
          let color = "";
          const diffDisplay = (scoreChange > 0) ? `+${scoreChange}` : (scoreChange === 0 ? "±0" : `${scoreChange}`);

          if (result === 'spook') { text = `SPLASH! ${diffDisplay}`; color = "red"; }
          else if (result === 'early') { text = `TOO EARLY! ${diffDisplay}`; color = "orange"; }
          else { text = `MISS... ${diffDisplay}`; color = "cyan"; }

          if (stats.type === 'FRY') color = "white";
          if (stats.type === 'TRASH') color = "purple";

          setNotification({ text, color, id: now });
          setIsFishVisible(false); 

          let fleeDx = fishPosRef.current.x - hookPosRef.current.x;
          let fleeDy = fishPosRef.current.y - hookPosRef.current.y;
          const fleeDist = Math.sqrt(fleeDx * fleeDx + fleeDy * fleeDy);
          
          if (fleeDist > 0.001) {
             fleeDx = (fleeDx / fleeDist) * 100;
             fleeDy = (fleeDy / fleeDist) * 100;
          } else {
             fleeDx = 100; 
             fleeDy = 0;
          }
          
          fishTargetPosRef.current.x = fishPosRef.current.x + fleeDx;
          fishTargetPosRef.current.y = fishPosRef.current.y + fleeDy;

          setGameState('AIMING');

          setTimeout(() => {
            isFishActiveRef.current = false;
            isAttackingRef.current = false;
            isFleeingRef.current = false; 
            scheduleRespawn();
          }, 2000); 
        }
      };

      // --- ゲームロジック ---
      if (gameState === 'AIMING') {
        if (isFishActiveRef.current && !isFleeingRef.current) {
            if (distance < FISH_NOTICE_DIST) {
                lastNoticeTimeRef.current = now; 
            } else {
                if (now - lastNoticeTimeRef.current > DESPAWN_MS) {
                    handleResult('vanish'); 
                }
            }
        }

        if (sensor.pitch >= ANGLE_TO_WAIT) {
           if (isFishActiveRef.current && distance < FISH_NOTICE_DIST) {
               setMessage("AIMING MODE");
           } else if (isFishActiveRef.current) {
               setMessage("TOO FAR... (Target < 20)");
           } else {
               setMessage("SEARCHING...");
           }

           if (Math.abs(sensor.joyX - 32768) > JOY_DEAD_ZONE) hookPosRef.current.x -= (sensor.joyX - 32768) / JOY_SPEED; 
           if (Math.abs(sensor.joyY - 32768) > JOY_DEAD_ZONE) hookPosRef.current.y += (sensor.joyY - 32768) / JOY_SPEED;
           hookPosRef.current.x = Math.max(0, Math.min(100, hookPosRef.current.x));
           hookPosRef.current.y = Math.max(0, Math.min(100, hookPosRef.current.y));
        } else {
           if (isFishActiveRef.current && !isFleeingRef.current) {
             if (distance < SPOOK_RADIUS) {
               handleResult('spook');
             } else if (distance < FISH_NOTICE_DIST) {
                setGameState('SINKING');
                setMessage("🐟 WAITING... 🐟");
                nibbleStartTimeRef.current = 0;
                isAttackingRef.current = false;
                isRecoilingRef.current = false;
                angleLockRef.current = null;
                isHookedRef.current = false;
             } else {
                setMessage("TOO FAR... (Target < 20)");
             }
           } else {
             setMessage("...");
           }
        }
      }
      else if (gameState === 'SINKING') {
        if (sensor.pitch >= ANGLE_TO_MOVE) {
            if (distance < NIBBLE_RADIUS) {
                handleResult('early');
            } else {
                handleResult('spook');
            }
        }
        
        if (distance > FISH_NOTICE_DIST) {
            setGameState('AIMING');
            setMessage("...");
            nibbleStartTimeRef.current = 0;
            isAttackingRef.current = false;
            isRecoilingRef.current = false;
            angleLockRef.current = null;
        }

        if (distance < NIBBLE_RADIUS && !isAttackingRef.current) {
            if (nibbleStartTimeRef.current === 0) {
                nibbleStartTimeRef.current = now;
                attackDelayRef.current = NIBBLE_MIN_MS + Math.random() * (NIBBLE_MAX_MS - NIBBLE_MIN_MS);
            } else {
                if (now - nibbleStartTimeRef.current > attackDelayRef.current) {
                    isAttackingRef.current = true;
                }
            }
        } 
        else if (distance >= NIBBLE_RADIUS + 5.0) {
            nibbleStartTimeRef.current = 0;
        }

        if (isAttackingRef.current && distance < 3.0) { 
             setGameState('BITE');
             setMessage("!!! PULL UP !!!");
             biteTimeRef.current = now;
             pitchAtBiteRef.current = sensor.pitch;
             isAttackingRef.current = false;
             angleLockRef.current = null;
        }
      }
      else if (gameState === 'BITE') {
        const timeDiff = now - biteTimeRef.current;
        const stats = fishStatsRef.current;
        const ratio = stats.size / stats.baseSize;
        const requiredTime = stats.baseReaction * (1.0 / ratio);

        if (timeDiff > requiredTime) handleResult('lose');
        else if (sensor.pitch - pitchAtBiteRef.current > HOOK_FORCE_DIFF) handleResult('win');
      }

      // --- 魚のAI ---
      if (!isFleeingRef.current && isFishActiveRef.current && now - lastFishAiTimeRef.current > FISH_AI_TICK_MS) {
        lastFishAiTimeRef.current = now;
        const isUfoMode = sensor.pitch >= ANGLE_TO_WAIT;
        const speedVar = 0.5 + Math.random(); 

        if (isUfoMode || distance > FISH_NOTICE_DIST) {
          fishTargetPosRef.current.x += (Math.random() - 0.5) * 25 * speedVar;
          fishTargetPosRef.current.y += (Math.random() - 0.5) * 25 * speedVar;
        } 
        else if (distance >= NIBBLE_RADIUS) {
           const fdx = hookPosRef.current.x - fishTargetPosRef.current.x;
           const fdy = hookPosRef.current.y - fishTargetPosRef.current.y;
           fishTargetPosRef.current.x += fdx * 0.3 * speedVar;
           fishTargetPosRef.current.y += fdy * 0.3 * speedVar;
        }
        
        fishTargetPosRef.current.x = Math.max(5, Math.min(95, fishTargetPosRef.current.x));
        fishTargetPosRef.current.y = Math.max(5, Math.min(95, fishTargetPosRef.current.y));
      }

      // --- アニメーション ---
      let targetAngle = fishAngleRef.current;
      let turnSpeed = FISH_TURN_SPEED;
      let moveSpeed = FISH_MOVE_SPEED;
      let currentScale = 1.0;
      let additionalRotate = 0;

      if (gameState === 'BITE' && !isFleeingRef.current) {
        const hookTipX = hookPosRef.current.x;
        const hookTipY = hookPosRef.current.y + HOOK_TIP_OFFSET_Y;
        
        if (isHookedRef.current) {
            fishPosRef.current.x = hookTipX;
            fishPosRef.current.y = hookTipY;
            targetAngle = fishAngleRef.current; 
            moveSpeed = 0;
            additionalRotate = Math.sin(now / 40) * 10;
            currentScale = 1.25;
        } else {
            const tdx = hookTipX - fishPosRef.current.x;
            const tdy = hookTipY - fishPosRef.current.y;
            const distToTip = Math.sqrt(tdx*tdx + tdy*tdy);

            if (distToTip > 1.0) {
                targetAngle = Math.atan2(tdy, tdx) * (180 / Math.PI);
                moveSpeed = FISH_DASH_SPEED * 1.5; 
                turnSpeed = 0.3; 
                currentScale = 1.2;
            } else {
                isHookedRef.current = true;
                fishPosRef.current.x = hookTipX;
                fishPosRef.current.y = hookTipY;
                moveSpeed = 0;
            }
        }
      }
      else if (isFleeingRef.current) {
        const tdx = fishTargetPosRef.current.x - fishPosRef.current.x;
        const tdy = fishTargetPosRef.current.y - fishPosRef.current.y;
        
        if (Math.abs(tdx) > 0.1 || Math.abs(tdy) > 0.1) {
            targetAngle = Math.atan2(tdy, tdx) * (180 / Math.PI);
        }
        moveSpeed = FISH_DASH_SPEED;
        currentScale = 0.9;
        angleLockRef.current = null;
      }
      else if (gameState === 'SINKING') {
        const targetY = hookPosRef.current.y + HOOK_TIP_OFFSET_Y;
        const tdx = hookPosRef.current.x - fishPosRef.current.x;
        const tdy = targetY - fishPosRef.current.y;
        const distToTip = Math.sqrt(tdx*tdx + tdy*tdy);

        if (isAttackingRef.current) {
          if (distToTip > 0.1) {
             targetAngle = Math.atan2(tdy, tdx) * (180 / Math.PI);
          }
          moveSpeed = FISH_DASH_SPEED;
          currentScale = 1.3;
          angleLockRef.current = null; 
        } 
        else {
          if (distToTip < 2.0 && angleLockRef.current === null) {
              angleLockRef.current = fishAngleRef.current;
          } else if (distToTip >= 2.0) {
              angleLockRef.current = null;
          }

          if (angleLockRef.current !== null) {
              targetAngle = angleLockRef.current;
          } else {
              if (distToTip > 0.1) {
                  targetAngle = Math.atan2(tdy, tdx) * (180 / Math.PI);
              }
          }

          const peckSignal = Math.pow(Math.sin(now / 1500 + nibbleSeedRef.current), 20);
          const shouldPeck = peckSignal > 0.1;

          if (isRecoilingRef.current) {
              moveSpeed = -0.15; 
              turnSpeed = 0.5;
              if (distToTip > ORBIT_RADIUS) isRecoilingRef.current = false;
          }
          else if (shouldPeck && distToTip < ORBIT_RADIUS + 2.0) {
              moveSpeed = 0.4;
              turnSpeed = 0.2;
              currentScale = 1.1;
              if (distToTip < 0.5) isRecoilingRef.current = true;
          }
          else {
              if (distToTip > ORBIT_RADIUS + 0.5) {
                  moveSpeed = FISH_MOVE_SPEED * 0.5;
              } else if (distToTip < ORBIT_RADIUS - 0.5) {
                  moveSpeed = -0.05;
              } else {
                  moveSpeed = 0;
                  targetAngle += Math.sin(now / 500) * 5; 
              }
              turnSpeed = 0.05;
              currentScale = 1.0;
          }
        }
      }
      else {
        // AIMING
        if (isFishActiveRef.current) {
            const tdx = fishTargetPosRef.current.x - fishPosRef.current.x;
            const tdy = fishTargetPosRef.current.y - fishPosRef.current.y;
            
            if (Math.abs(tdx) > 0.1 || Math.abs(tdy) > 0.1) {
                targetAngle = Math.atan2(tdy, tdx) * (180 / Math.PI);
            }
            
            const distToTarget = Math.sqrt(tdx*tdx + tdy*tdy);
            if (distToTarget < 5) moveSpeed *= distToTarget / 5;
            if (distToTarget < 1) moveSpeed = 0;
        } else {
            moveSpeed = 0;
        }
      }

      // 移動・回転
      const canMove = !isHookedRef.current || isFleeingRef.current;

      if (canMove) {
          if (Math.abs(moveSpeed) > 0.001) {
              fishAngleRef.current = smoothAngle(fishAngleRef.current, targetAngle, turnSpeed);
              
              let speedReducer = 1.0;
              if (moveSpeed > 0 && gameState !== 'BITE' && !isFleeingRef.current) { 
                 const angleDiff = Math.abs(smoothAngle(fishAngleRef.current, targetAngle, 1.0) - fishAngleRef.current);
                 speedReducer = Math.max(0.2, 1.0 - (angleDiff / 180));
              }
              
              const newPos = moveForward(fishPosRef.current, fishAngleRef.current, moveSpeed * speedReducer);
              fishPosRef.current = newPos;
          } else {
              fishAngleRef.current = smoothAngle(fishAngleRef.current, targetAngle, turnSpeed * 0.5);
          }
      }

      // 描画更新
      if (hookDivRef.current) {
        hookDivRef.current.style.left = `${hookPosRef.current.x}%`;
        hookDivRef.current.style.top = `${hookPosRef.current.y}%`;
        hookDivRef.current.style.transform = `translate(-50%, -50%)`;
      }
      if (fishDivRef.current && isFishActiveRef.current) {
        fishDivRef.current.style.left = `${fishPosRef.current.x}%`;
        fishDivRef.current.style.top = `${fishPosRef.current.y}%`;
        
        const finalAngle = fishAngleRef.current - 180 + additionalRotate;
        const finalScale = fishStatsRef.current.size * currentScale;
        const hue = fishStatsRef.current.hue;

        fishDivRef.current.style.transform = `translate(0%, -50%) rotate(${finalAngle}deg) scale(${finalScale})`;
        
        if (fishStatsRef.current.type === 'MASTER') {
            fishDivRef.current.style.filter = `hue-rotate(${hue}deg) brightness(0.6) saturate(1.5)`;
        } else {
            fishDivRef.current.style.filter = `hue-rotate(${hue}deg)`;
        }
      }

      frameId = requestAnimationFrame(loop);
    };

    frameId = requestAnimationFrame(loop);
    return () => {
        cancelAnimationFrame(frameId);
    };
  }, [isConnected, gameState]);

  const isMoveable = gameState === 'AIMING' && sensorRef.current.pitch >= ANGLE_TO_WAIT;

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
            STATE: <span className={gameState}>{gameState}</span> <br/>
            Angle: {sensorRef.current.pitch.toFixed(0)}°
          </div>

          {/* コンボ表示 */}
          <div className="hud">
            <div>SCORE: {score}</div>
            {combo > 0 && <div style={{ color: 'gold', fontSize: '20px' }}>COMBO: {combo}</div>}
            <div className={`message ${gameState === 'BITE' ? 'bite-text' : ''}`}>{message}</div>
          </div>

          <div className="pond">
            <div 
              ref={hookDivRef} 
              className={`hook ${isMoveable ? 'floating' : 'sinking'}`}
              style={{ transform: 'translate(-50%, -50%)' }}
            >
              {isMoveable ? '🛸' : '📍'}
            </div>
            <div 
              ref={fishDivRef} 
              className={`fish ${isFishVisible ? 'appear' : ''}`}
              style={{ transformOrigin: 'left center' }} 
            >
              🐟
            </div>
          </div>
          
          <div className="debug-bar" style={{fontSize: '20px', color: 'lime'}}>
             DIST: {debugDist.toFixed(1)} (Radius: {ORBIT_RADIUS})
          </div>
        </>
      )}
    </div>
  );
}

export default App;