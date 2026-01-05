// 型定義をここにまとめます
export type FishType = 'NORMAL' | 'RARE' | 'TRASH' | 'FRY' | 'MASTER' | 'PHANTOM';

export interface FishEntity {
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

export type SensorData = {
  roll: number;
  pitch: number;
  joyX: number;
  joyY: number;
  btn1: number;
  btn2: number;
};

export type GameState = 'AIMING' | 'SINKING' | 'BITE';

export type Notification = {
  text: string;
  color: string;
  id: number;
} | null;