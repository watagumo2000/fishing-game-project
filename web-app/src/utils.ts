import type { FishEntity, FishType } from './types';
import { DESPAWN_MIN_MS, DESPAWN_MAX_MS } from './constants';

// 角度補間
export const smoothAngle = (current: number, target: number, smoothing: number) => {
    let delta = target - current;
    while (delta <= -180) delta += 360;
    while (delta > 180) delta -= 360;
    return current + delta * smoothing;
};

// 前進計算
export const moveForward = (currentPos: {x:number, y:number}, angleDeg: number, speed: number) => {
    const rad = angleDeg * (Math.PI / 180);
    return {
        x: currentPos.x + Math.cos(rad) * speed,
        y: currentPos.y + Math.sin(rad) * speed
    };
};

// ランダム座標取得
export const getRandomPos = () => ({
  x: 10 + Math.random() * 80,
  y: 10 + Math.random() * 80
});

// 魚生成ロジック
export const generateFish = (id: number): FishEntity => {
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
        id,
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
        maxPatience, 
        caughtTime: 0,
        ...stats
    } as FishEntity;
};