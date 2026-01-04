import time
from machine import Pin, I2C, ADC, PWM
import ssd1306
import adxl345  # さっきのライブラリを読み込み

# --- 1. セットアップ ---

# I2Cの設定
# Display (I2C0)
i2c_disp = I2C(0, scl=Pin(17), sda=Pin(16), freq=400000)
# Accel (I2C1)
i2c_accel = I2C(1, scl=Pin(19), sda=Pin(18), freq=400000)

# デバイス初期化
display = ssd1306.SSD1306_I2C(128, 64, i2c_disp)
accel = adxl345.ADXL345(i2c_accel) # 使い方は同じ

# 入力ピン
joy_x = ADC(26)
joy_y = ADC(27)
sw1 = Pin(21, Pin.IN, Pin.PULL_UP)
sw2 = Pin(20, Pin.IN, Pin.PULL_UP)

# ブザー
buzzer = PWM(Pin(15))
buzzer.duty_u16(0)

# 内部温度計
sensor_temp = ADC(4)

# 変数
count = 0
state = False

def play_tone(freq, duration_ms=0):
    buzzer.freq(freq)
    buzzer.duty_u16(32768)
    if duration_ms > 0:
        time.sleep_ms(duration_ms)
        buzzer.duty_u16(0)

def stop_tone():
    buzzer.duty_u16(0)

# --- 2. メインループ ---
while True:
    # センサー読み取り (新しいライブラリの書き方に変更！)
    raw_x = accel.xValue
    raw_y = accel.yValue
    raw_z = accel.zValue
    # 角度(Roll, Pitch)を計算
    # 釣り竿の傾きとして使うのに最適です
    roll, pitch = accel.RP_calculate(raw_x, raw_y, raw_z)

    # スティック
    jx_val = joy_x.read_u16()
    jy_val = joy_y.read_u16()
    
    # 温度
    reading = sensor_temp.read_u16() * 3.3 / 65535
    temperature = 27 - (reading - 0.706)/0.001721
    
    # ロジック (ボタン処理)
    is_sw1_pressed = (sw1.value() == 0)
    if is_sw1_pressed:
        play_tone(262)
    else:
        stop_tone()
        
    sw2_val = sw2.value()
    if sw2_val == 0 and not state:
        state = True
        count += 1
    if sw2_val == 1:
        state = False

    # --- 画面描画 ---
    display.fill(0)
    
    # 生の値ではなく「角度」を表示してみる
    display.text(f"R:{roll:.1f}", 0, 0)  # Roll (横の傾き)
    display.text(f"P:{pitch:.1f}", 64, 0) # Pitch (縦の傾き)
    
    display.text(f"J:{jx_val},{jy_val}", 0, 10)
    display.text(f"T:{temperature:.1f}C", 80, 10)
    
    display.text(f"SW1:{'ON' if is_sw1_pressed else 'OFF'}", 0, 25)
    display.text(f"Count:{count}", 64, 25)

    display.hline(0, 35, 128, 1)
    
    # 釣り竿っぽい描画 (ピッチに合わせて動く線)
    # 簡易的な可視化です
    line_y = int(32 + (pitch / 90) * 30) 
    display.line(0, 32, 20, line_y, 1)

    display.show()

    # --- PCへのデータ送信 ---
    # 角度(Roll, Pitch)を送るように変更しました！
    # これならPC側で atan2 とか計算しなくていいので楽です
    # フォーマット: Roll, Pitch, StickX, StickY, Btn1, Btn2
    data_packet = f"{roll:.2f},{pitch:.2f},{jx_val},{jy_val},{1 if is_sw1_pressed else 0},{1 if state else 0}"
    print(data_packet)

    time.sleep(0.05)