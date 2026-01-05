import { useState, useEffect, useRef, MutableRefObject } from 'react';
import * as C from '../constants';
import * as U from '../utils';

export const useFishingGame = (
    sensorRef: MutableRefObject<C.SensorData>, 
    isConnected: boolean,
    sendCommand: (text: string) => void 
) => {
  const [playerState, setPlayerState] = useState<C.GameState>('AIMING');
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [message, setMessage] = useState("ROD UP TO MOVE");
  const [notification, setNotification] = useState<C.Notification>(null);
  const [debugDist, setDebugDist] = useState(999);
  
  const [maxFishCount, setMaxFishCount] = useState(5);
  const maxFishCountRef = useRef(5);

  const [renderFishList, setRenderFishList] = useState<C.FishEntity[]>([]);
  
  const fishEntitiesRef = useRef<C.FishEntity[]>([]);
  const fishDomRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const hookPosRef = useRef({ x: 50, y: 50 });
  const activeFishIdRef = useRef<number | null>(null);
  const biteTimeRef = useRef(0);
  const pitchAtBiteRef = useRef(0);
  const nextFishIdRef = useRef(1);
  const hookDivRef = useRef<HTMLDivElement>(null);

  const frameCountRef = useRef(0);

  const applyPenalty = (fish: C.FishEntity, reason: string, now: number) => {
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

  // Resize
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

  // Notification Timer
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // Spawn Control
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
        let minMs = 1000; let maxMs = 5000;
        if (ratio < 0.3) { minMs = 1000; maxMs = 5000; } 
        else if (ratio < 0.7) { minMs = 5000; maxMs = 10000; } 
        else { minMs = 10000; maxMs = 30000; }
        const delay = minMs + Math.random() * (maxMs - minMs);
        timeoutId = window.setTimeout(() => {
            const currentNow = fishEntitiesRef.current.filter(f => f.state !== 'GONE').length;
            if (currentNow < maxFishCountRef.current) {
                const newFish = U.generateFish(nextFishIdRef.current++);
                fishEntitiesRef.current.push(newFish);
                setRenderFishList([...fishEntitiesRef.current]);
            }
            scheduleNextSpawn();
        }, delay);
    };
    scheduleNextSpawn(); 
    return () => clearTimeout(timeoutId);
  }, [isConnected]);

  // Cleanup
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

  // --- Main Loop ---
  useEffect(() => {
    if (!isConnected) return;
    let frameId: number;

    const loop = () => {
      const sensor = sensorRef.current;
      const now = performance.now();
      const isRodDown = sensor.pitch < C.ANGLE_TO_WAIT;
      
      // Player Control
      if (!isRodDown && playerState !== 'BITE') {
          if (playerState !== 'AIMING') setPlayerState('AIMING');
          if (Math.abs(sensor.joyX - 32768) > C.JOY_DEAD_ZONE) hookPosRef.current.x -= (sensor.joyX - 32768) / C.JOY_SPEED; 
          if (Math.abs(sensor.joyY - 32768) > C.JOY_DEAD_ZONE) hookPosRef.current.y += (sensor.joyY - 32768) / C.JOY_SPEED;
          hookPosRef.current.x = Math.max(0, Math.min(100, hookPosRef.current.x));
          hookPosRef.current.y = Math.max(0, Math.min(100, hookPosRef.current.y));
          setMessage("SEARCHING...");
      } 
      else if (isRodDown && playerState === 'AIMING') {
          setPlayerState('SINKING');
          setMessage("🐟 WAITING... 🐟");
          let splashTriggered = false;
          fishEntitiesRef.current.forEach(f => {
              if (f.state === 'FLEEING' || f.state === 'GONE' || f.state === 'CAUGHT') return;
              const dx = hookPosRef.current.x - f.x;
              const dy = hookPosRef.current.y - f.y; 
              const dist = Math.sqrt(dx*dx + dy*dy);
              if (dist < C.SPOOK_RADIUS) { 
                  f.state = 'FLEEING'; f.fleeAngle = null; 
                  if (!splashTriggered) { applyPenalty(f, 'SPOOKED!', now); splashTriggered = true; }
              }
          });
      }

      // Fish AI & Sonar
      let closestDist = 999;
      const tipX = hookPosRef.current.x + C.HOOK_TIP_OFFSET_X;
      const tipY = hookPosRef.current.y + C.HOOK_TIP_OFFSET_Y;

      fishEntitiesRef.current.forEach(fish => {
          if (fish.state === 'GONE') return;
          if (fish.state === 'CAUGHT') {
              const progress = (now - fish.caughtTime) / 1000; 
              if (progress >= 1.0) fish.state = 'GONE';
              else fish.y -= 0.1; 
              return; 
          }

          const dx = tipX - fish.x;
          const dy = tipY - fish.y;
          const distToHook = Math.sqrt(dx*dx + dy*dy);
          if (distToHook < closestDist) closestDist = distToHook;

          if (distToHook > C.FISH_NOTICE_DIST && fish.state !== 'FLEEING' && fish.state !== 'HOOKED') {
              if (now - fish.lastNoticeTime > fish.maxPatience) { fish.state = 'GONE'; return; }
          } else { fish.lastNoticeTime = now; }

          // AI Logic
          if (fish.state === 'FLEEING') {
              if (fish.fleeAngle === null) {
                  if (distToHook < 0.1) fish.fleeAngle = Math.random() * 360;
                  else fish.fleeAngle = Math.atan2(fish.y - hookPosRef.current.y, fish.x - hookPosRef.current.x) * (180/Math.PI);
              }
              fish.angle = U.smoothAngle(fish.angle, fish.fleeAngle!, C.FISH_TURN_SPEED);
              const move = U.moveForward(fish, fish.angle, C.FISH_DASH_SPEED);
              fish.x = move.x; fish.y = move.y;
              if (fish.x < -10 || fish.x > 110 || fish.y < -10 || fish.y > 110) fish.state = 'GONE';
          }
          else if (fish.state === 'HOOKED') {
              if (playerState === 'BITE') { fish.x = tipX; fish.y = tipY; } 
              else { fish.state = 'FLEEING'; fish.fleeAngle = null; }
          }
          else {
              if (playerState === 'BITE' && fish.id !== activeFishIdRef.current) {
                  if (fish.state !== 'FLEEING') {
                      const dxP = hookPosRef.current.x - fish.x;
                      const dyP = hookPosRef.current.y - fish.y;
                      const distP = Math.sqrt(dxP*dxP + dyP*dyP);
                      if (distP < C.SPLASH_PANIC_RADIUS) { fish.state = 'FLEEING'; fish.fleeAngle = null; }
                  }
              }
              else {
                  if (playerState === 'AIMING' || distToHook > C.FISH_NOTICE_DIST) {
                      fish.state = 'IDLE';
                      if (Math.random() < 0.02) {
                          fish.targetX += (Math.random()-0.5) * 20;
                          fish.targetY += (Math.random()-0.5) * 20;
                          fish.targetX = Math.max(5, Math.min(95, fish.targetX));
                          fish.targetY = Math.max(5, Math.min(95, fish.targetY));
                      }
                      const tdx = fish.targetX - fish.x;
                      const tdy = fish.targetY - fish.y;
                      const distToTarget = Math.sqrt(tdx*tdx + tdy*tdy);
                      let targetAng = fish.angle;
                      if (distToTarget > 1) targetAng = Math.atan2(tdy, tdx) * (180/Math.PI);
                      fish.angle = U.smoothAngle(fish.angle, targetAng, C.FISH_TURN_SPEED * 0.5);
                      const speed = distToTarget > 1 ? C.FISH_MOVE_SPEED * 0.5 : 0;
                      const move = U.moveForward(fish, fish.angle, speed);
                      fish.x = move.x; fish.y = move.y;
                  }
                  else {
                      if (fish.state === 'ATTACKING') {
                          const adx = tipX - fish.x;
                          const ady = tipY - fish.y;
                          const distTip = Math.sqrt(adx*adx + ady*ady);
                          if (distTip > 1.0) {
                              fish.angle = Math.atan2(ady, adx) * (180/Math.PI);
                              const move = U.moveForward(fish, fish.angle, C.FISH_DASH_SPEED * 1.5);
                              fish.x = move.x; fish.y = move.y;
                          } else {
                              fish.state = 'HOOKED'; setPlayerState('BITE'); setMessage("!!! PULL UP !!!");
                              activeFishIdRef.current = fish.id; biteTimeRef.current = now; pitchAtBiteRef.current = sensor.pitch;
                          }
                      }
                      else {
                          if (distToHook < C.SPOOK_RADIUS && playerState === 'AIMING') { fish.state = 'FLEEING'; fish.fleeAngle = null; }
                          else {
                              const adx = tipX - fish.x;
                              const ady = tipY - fish.y;
                              const distTip = Math.sqrt(adx*adx + ady*ady); 
                              if (distTip < 2.0 && fish.angleLock === null) fish.angleLock = fish.angle;
                              else if (distTip >= 2.0) fish.angleLock = null;
                              let targetAng = fish.angle;
                              if (fish.angleLock !== null) targetAng = fish.angleLock;
                              else if (distTip > 0.1) targetAng = Math.atan2(ady, adx) * (180/Math.PI);

                              if (distTip < C.NIBBLE_RADIUS) {
                                  if (fish.nibbleStartTime === 0) {
                                      fish.nibbleStartTime = now;
                                      fish.attackDelay = C.NIBBLE_MIN_MS + Math.random() * (C.NIBBLE_MAX_MS - C.NIBBLE_MIN_MS);
                                  } else {
                                      if (now - fish.nibbleStartTime > fish.attackDelay && playerState !== 'BITE') {
                                          fish.state = 'ATTACKING'; fish.angleLock = null; fish.isRecoiling = false;
                                      }
                                  }
                              } else { fish.nibbleStartTime = 0; }

                              let speed = 0; let turn = C.FISH_TURN_SPEED;
                              const peckSignal = Math.pow(Math.sin(now / 1500 + fish.nibbleSeed), 20);
                              
                              if (fish.isRecoiling) {
                                  speed = -0.15; turn = 0.5;
                                  if (distTip > C.ORBIT_RADIUS) fish.isRecoiling = false;
                              } else if (peckSignal > 0.1 && distTip < C.ORBIT_RADIUS + 2.0) { 
                                  speed = 0.4; turn = 0.2;
                                  if (distTip < 0.5) fish.isRecoiling = true;
                              } else {
                                  if (distTip > C.ORBIT_RADIUS + 0.5) speed = C.FISH_MOVE_SPEED * 0.5;
                                  else if (distTip < C.ORBIT_RADIUS - 0.5) speed = -0.05;
                                  else { speed = 0; targetAng += Math.sin(now/500 + fish.nibbleSeed)*5; }
                              }
                              fish.angle = U.smoothAngle(fish.angle, targetAng, turn);
                              const move = U.moveForward(fish, fish.angle, speed);
                              fish.x = move.x; fish.y = move.y;
                          }
                      }
                  }
              }
          }
      });

      // Sonar Data Send
frameCountRef.current++;
      if (frameCountRef.current % 10 === 0) { 
          const sonarData: string[] = [];
          
          const tipX = hookPosRef.current.x + C.HOOK_TIP_OFFSET_X;
          const tipY = hookPosRef.current.y + C.HOOK_TIP_OFFSET_Y;

          // 生存数
          const activeCount = fishEntitiesRef.current.filter(f => f.state !== 'GONE').length;

          // ★ナビゲーション用: 全魚の中で一番近いものを探す (範囲制限なし)
          let minDist = 999;
          let navX = 0;
          let navY = 0;

          fishEntitiesRef.current.forEach(fish => {
              if (fish.state === 'GONE') return;

              const dx = fish.x - tipX;
              const dy = fish.y - tipY;
              const dist = Math.sqrt(dx*dx + dy*dy);

              // 1. ナビ用データ更新 (距離制限なし)
              if (dist < minDist) {
                  minDist = dist;
                  navX = dx;
                  navY = dy;
              }

              // 2. ソナー描画用データ (範囲内のみ)
              if (dist < C.SONAR_RANGE) {
                  let visualSize = 1; 
                  if (['NORMAL', 'RARE', 'TRASH'].includes(fish.type)) visualSize = 3;
                  else if (fish.type === 'MASTER') visualSize = 5;

                  let soundRank = 1;
                  switch (fish.type) {
                      case 'TRASH':   soundRank = 1; break;
                      case 'FRY':     soundRank = 2; break; 
                      case 'NORMAL':  soundRank = 3; break;
                      case 'RARE':    soundRank = 4; break; 
                      case 'MASTER':
                      case 'PHANTOM': soundRank = 5; break;
                  }
                  sonarData.push(`${Math.round(dx)},${Math.round(dy)},${visualSize},${soundRank}`);
              }
          });

          // ★ヘッダー変更: "最短距離, 魚の数, NavX, NavY"
          const distSend = minDist > 99 ? 99.9 : minDist;
          // ナビ座標も整数に丸めて送る
          const header = `${distSend.toFixed(1)},${activeCount},${Math.round(navX)},${Math.round(navY)}`;

          if (sonarData.length > 0) {
              const payload = sonarData.slice(0, 5).join(':'); 
              sendCommand(`S:${header}|${payload}`);
          } else {
              sendCommand(`S:${header}|OUT`);
          }
      }
      // Result Check
      if (playerState === 'BITE' && activeFishIdRef.current !== null) {
          const fish = fishEntitiesRef.current.find(f => f.id === activeFishIdRef.current);
          if (fish) {
              const timeDiff = now - biteTimeRef.current;
              const ratio = fish.size / fish.baseSize;
              const requiredTime = fish.baseReaction * (1.0 / ratio);
              let result: 'win' | 'lose' | null = null;
              if (timeDiff > requiredTime) result = 'lose'; 
              else if (sensor.pitch - pitchAtBiteRef.current > C.HOOK_FORCE_DIFF) result = 'win';

              if (result) {
                  const potentialScore = Math.round(fish.baseScore * fish.size);
                  if (result === 'win') {
                      if (fish.type === 'TRASH') {
                          setCombo(0); setScore(s => s + potentialScore); 
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
                      fish.state = 'CAUGHT'; fish.caughtTime = now;
                      activeFishIdRef.current = null; setPlayerState('AIMING');
                  } else {
                      fish.state = 'FLEEING'; fish.fleeAngle = null; 
                      applyPenalty(fish, 'MISS...', now);
                      activeFishIdRef.current = null; setPlayerState('AIMING');
                  }
                  fishEntitiesRef.current.forEach(f => {
                      if (f.state !== 'GONE' && f.state !== 'HOOKED' && f.state !== 'FLEEING' && f.state !== 'CAUGHT') {
                          const dxS = hookPosRef.current.x - f.x; const dyS = hookPosRef.current.y - f.y;
                          const distS = Math.sqrt(dxS*dxS + dyS*dyS);
                          if (distS < C.SPLASH_PANIC_RADIUS) { f.state = 'FLEEING'; f.fleeAngle = null; }
                      }
                  });
              }
          }
      }
      
      // Early Pull Check
      if (playerState === 'SINKING' && sensor.pitch >= C.ANGLE_TO_MOVE) {
          let eventTriggered = false; 
          fishEntitiesRef.current.forEach(f => {
             if (f.state === 'FLEEING' || f.state === 'GONE' || f.state === 'CAUGHT') return;
             const dx = tipX - f.x; const dy = tipY - f.y; const dist = Math.sqrt(dx*dx + dy*dy);
             if (dist < C.NIBBLE_RADIUS) {
                 f.state = 'FLEEING'; f.fleeAngle = null; 
                 if (!eventTriggered) { applyPenalty(f, 'TOO EARLY!', now); eventTriggered = true; }
             } 
             else if (dist < C.FISH_NOTICE_DIST) {
                 f.state = 'FLEEING'; f.fleeAngle = null; 
                 if (!eventTriggered) { applyPenalty(f, 'SPOOKED!', now); eventTriggered = true; }
             }
          });
          setPlayerState('AIMING'); 
      }

      setDebugDist(closestDist);

      // --- DOM Update (★ここに視界ロジックを統合！) ---
if (hookDivRef.current) {
        hookDivRef.current.style.left = `${hookPosRef.current.x}%`;
        hookDivRef.current.style.top = `${hookPosRef.current.y}%`;
        hookDivRef.current.style.transform = `translate(calc(-50% + ${C.FLOAT_OFFSET_X}px), calc(-50% + ${C.FLOAT_OFFSET_Y}px))`;
      }
      
      fishEntitiesRef.current.forEach(fish => {
          const el = fishDomRefs.current.get(fish.id);
          if (el) {
              if (fish.state === 'GONE') {
                  el.style.display = 'none';
              } else {
                  const limitDist = C.VISIBILITY_RADIUS || 30; 
                  const clearDist = C.CLEAR_RADIUS || 10;      

                  const dx = tipX - fish.x;
                  const dy = tipY - fish.y;
                  const dist = Math.sqrt(dx*dx + dy*dy);
                  
                  let opacity = 0;
                  let blur = 0;
                  let display = 'none';

                  // 1. 釣れている時は無条件で表示
                  if (fish.state === 'HOOKED' || fish.state === 'CAUGHT') {
                      opacity = 1; blur = 0; display = 'block';
                  } 
                  // 2. ★追加: ウキを上げている(AIMING)時は、水中は見えない！
                  else if (playerState === 'AIMING') {
                      opacity = 0; 
                      display = 'none';
                  }
                  // 3. ウキが沈んでいる(SINKING/BITE)時は、距離に応じて見える
                  else {
                      if (dist >= limitDist) {
                          opacity = 0; display = 'none'; 
                      } else if (dist <= clearDist) {
                          opacity = 1; blur = 0; display = 'block'; 
                      } else {
                          const range = limitDist - clearDist;
                          const current = dist - clearDist;
                          let ratio = current / range;
                          if (ratio < 0) ratio = 0;
                          if (ratio > 1) ratio = 1;

                          if (ratio > 0.9) { 
                              opacity = 0; display = 'none';
                          } else {
                              opacity = 1.0 - ratio; 
                              blur = ratio * 10;     
                              display = 'block';
                          }
                      }
                  }

                  // 安全策
                  if (isNaN(opacity)) { display = 'none'; opacity = 0; }

                  el.style.display = display;
                  el.style.opacity = `${opacity}`;
                  
                  let addRot = 0; let scaleMult = 1.0;
                  if (fish.state === 'HOOKED') addRot = Math.sin(now/40)*15;
                  else if (fish.state === 'ATTACKING') scaleMult = 1.1;
                  else if (fish.state === 'CAUGHT') {
                      el.style.display = 'block';
                      el.style.opacity = `${Math.max(0, 1.0 - ((now - fish.caughtTime) / 1000))}`;
                  }
                  
                  const finalScale = fish.size * scaleMult;
                  el.style.filter = `hue-rotate(${fish.hue}deg) blur(${blur}px) ${fish.type==='MASTER' ? 'brightness(0.6)' : ''}`;
                  el.style.left = `${fish.x}%`; 
                  el.style.top = `${fish.y}%`;
                  el.style.transform = `translate(0%, -50%) rotate(${fish.angle - 180 + addRot}deg) scale(${finalScale})`;
              }
          }
      });
      frameId = requestAnimationFrame(loop);
    };

    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [isConnected, playerState, combo]); 

  return {
    playerState, score, combo, message, notification,
    maxFishCount, renderFishList,
    hookDivRef, fishDomRefs
  };
};