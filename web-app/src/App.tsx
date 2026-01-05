import { useRef } from 'react';
import './App.css';
import * as C from './constants';
import { useSerial } from './hooks/useSerial';
import { useFishingGame } from './hooks/useFishingGame';

function App() {
  const sensorRef = useRef<C.SensorData>({ roll: 0, pitch: 0, joyX: 32768, joyY: 32768, btn1: 0, btn2: 0 });
  const { isConnected, connect, sendCommand } = useSerial(sensorRef);

  const {
    playerState, score, combo, message, notification,
    maxFishCount, renderFishList,
    hookDivRef, fishDomRefs
  } = useFishingGame(sensorRef, isConnected, sendCommand);

  return (
    <div className="game-container">
      {!isConnected && (
        <div className="start-screen">
          <h1>🎣 Ultimate Fishing VR</h1>
          <button onClick={connect} className="connect-btn">START</button>
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
                    // 初期状態は非表示 (一瞬見えるのを防ぐ)
                    display: 'none',
                    transformOrigin: 'left center',
                    transition: 'none' // CSS干渉を防ぐ
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