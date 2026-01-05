import { useState, useRef, MutableRefObject } from 'react';
import type { SensorData } from '../constants';

export const useSerial = (sensorRef: MutableRefObject<SensorData>) => {
  const [isConnected, setIsConnected] = useState(false);
  
  // 送信用の Writer を保持する
  const writerRef = useRef<WritableStreamDefaultWriter<string> | null>(null);

  const parseData = (line: string) => {
    const parts = line.split(',');
    if (parts.length === 6) {
      const p = parts.map(parseFloat);
      if (!isNaN(p[0])) {
        sensorRef.current = { roll: p[1], pitch: p[0], joyX: p[2], joyY: p[3], btn1: p[4], btn2: p[5] };
      }
    }
  };

  // ★データをマイコンへ送信する関数
  const sendCommand = async (text: string) => {
    if (writerRef.current) {
      try {
        // 改行コードをつけて送信
        await writerRef.current.write(text + "\n");
      } catch (e) {
        console.error("Write error:", e);
      }
    }
  };

  const readLoop = async (port: SerialPort) => {
    const decoder = new TextDecoderStream();
    port.readable!.pipeTo(decoder.writable);
    const reader = decoder.readable.getReader();
    
    // ★書き込み用ストリームの準備
    const textEncoder = new TextEncoderStream();
    textEncoder.readable.pipeTo(port.writable!);
    writerRef.current = textEncoder.writable.getWriter();

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
    } finally { 
        reader.releaseLock(); 
    }
  };

  const connect = async () => {
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      setIsConnected(true);
      readLoop(port);
    } catch (e) { 
        console.error(e); 
    }
  };

  // sendCommand を外で使えるように返す
  return { isConnected, connect, sendCommand };
};