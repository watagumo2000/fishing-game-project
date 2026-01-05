import time
import sys
import uselect
import math
from machine import Pin, I2C, ADC, PWM
import ssd1306
import adxl345

# --- セットアップ ---
i2c_disp = I2C(0, scl=Pin(17), sda=Pin(16), freq=400000)
i2c_accel = I2C(1, scl=Pin(19), sda=Pin(18), freq=400000)
display = ssd1306.SSD1306_I2C(128, 64, i2c_disp)
accel = adxl345.ADXL345(i2c_accel)
joy_x = ADC(26)
joy_y = ADC(27)
sw1 = Pin(21, Pin.IN, Pin.PULL_UP)
sw2 = Pin(20, Pin.IN, Pin.PULL_UP)
buzzer = PWM(Pin(15))
buzzer.duty_u16(0)

spoll = uselect.poll()
spoll.register(sys.stdin, uselect.POLLIN)

# データ保持用
live_targets = []
display_targets = []

target_dist = 99.9
active_fish_count = 0
nav_x = 0 # 一番近い魚の相対X
nav_y = 0 # 一番近い魚の相対Y

last_beep_time = 0
is_beeping = False

def start_tone(freq):
    buzzer.freq(freq)
    buzzer.duty_u16(32768)

def stop_tone():
    buzzer.duty_u16(0)

def read_serial_command():
    if spoll.poll(0):
        try:
            line = sys.stdin.readline()
            if line: return line.strip()
        except: pass
    return None

def draw_circle(x0, y0, r):
    x = r
    y = 0
    err = 0
    while x >= y:
        display.pixel(x0 + x, y0 + y, 1)
        display.pixel(x0 + y, y0 + x, 1)
        display.pixel(x0 - y, y0 + x, 1)
        display.pixel(x0 - x, y0 + y, 1)
        display.pixel(x0 - x, y0 - y, 1)
        display.pixel(x0 - y, y0 - x, 1)
        display.pixel(x0 + y, y0 - x, 1)
        display.pixel(x0 + x, y0 - y, 1)
        if err <= 0:
            y += 1
            err += 2*y + 1
        else:
            x -= 1
            err -= 2*x + 1

# ★改良版: 綺麗な三角形の矢印を描く関数
def draw_nav_arrow(cx, cy, angle, size=10):
    # 3つの頂点を計算して三角形を描く
    # P1: 先端
    # P2: 左後ろ
    # P3: 右後ろ
    
    # 角度オフセット (ラジアン)
    # 140度くらい後ろ
    wing_angle = 2.44 
    
    # 先端
    p1_x = cx + int(math.cos(angle) * size)
    p1_y = cy + int(math.sin(angle) * size)
    
    # 左後ろ (サイズを少し小さくしてシャープに)
    wing_size = size * 0.7
    p2_x = cx + int(math.cos(angle + wing_angle) * wing_size)
    p2_y = cy + int(math.sin(angle + wing_angle) * wing_size)
    
    # 右後ろ
    p3_x = cx + int(math.cos(angle - wing_angle) * wing_size)
    p3_y = cy + int(math.sin(angle - wing_angle) * wing_size)
    
    # 線で結ぶ (中抜きの三角形)
    display.line(p1_x, p1_y, p2_x, p2_y, 1)
    display.line(p2_x, p2_y, p3_x, p3_y, 1) # 底辺
    display.line(p3_x, p3_y, p1_x, p1_y, 1)

    # 中心点（あると回転がわかりやすい）
    display.pixel(cx, cy, 1)


while True:
    raw_x = accel.xValue
    raw_y = accel.yValue
    raw_z = accel.zValue
    roll, pitch = accel.RP_calculate(raw_x, raw_y, raw_z)
    jx_val = joy_x.read_u16()
    jy_val = joy_y.read_u16()
    sw1_pressed = (sw1.value() == 0)

    # データ受信
    command = read_serial_command()
    if command:
        if command.startswith("S:"):
            content = command[2:]
            try:
                parts = content.split("|")
                header = parts[0].split(",")
                
                # ★変更: [0]=距離, [1]=魚数, [2]=NavX, [3]=NavY
                target_dist = float(header[0])
                active_fish_count = int(header[1])
                
                # 安全に取得
                if len(header) > 3:
                    nav_x = int(header[2])
                    nav_y = int(header[3])
                
                data_str = parts[1]
                if data_str == "OUT":
                    live_targets = []
                else:
                    raw_list = data_str.split(":")
                    new_targets = []
                    for item in raw_list:
                        try:
                            params = item.split(",")
                            tx = int(params[0])
                            ty = int(params[1])
                            ts = int(params[2]) if len(params) > 2 else 1
                            tr = int(params[3]) if len(params) > 3 else 1
                            new_targets.append((tx, ty, ts, tr))
                        except: pass
                    live_targets = new_targets
            except: pass

    # --- 画面描画 ---
    display.fill(0)

    # 1. レーダー (左)
    cx, cy = 32, 32 
    radar_r = 30    
    draw_circle(cx, cy, radar_r)
    display.pixel(cx, cy, 1)

    now_ms = time.ticks_ms()
    sweep_period = 1000 
    sweep_angle = (now_ms % sweep_period) / sweep_period * (2 * math.pi)
    
    sweep_x = cx + int(math.cos(sweep_angle) * radar_r)
    sweep_y = cy + int(math.sin(sweep_angle) * radar_r)
    display.line(cx, cy, sweep_x, sweep_y, 1)

    sweep_width = 0.6 
    next_display_targets = []
    
    for target in display_targets:
        (tx, ty, ts, tr) = target
        t_angle = math.atan2(ty, tx)
        if t_angle < 0: t_angle += 2 * math.pi
        diff = sweep_angle - t_angle
        while diff < -math.pi: diff += 2 * math.pi
        while diff > math.pi:  diff -= 2 * math.pi
        if abs(diff) > sweep_width:
            next_display_targets.append(target)
            
    for target in live_targets:
        (tx, ty, ts, tr) = target
        if (tx*tx + ty*ty) > radar_r*radar_r: continue
        t_angle = math.atan2(ty, tx)
        if t_angle < 0: t_angle += 2 * math.pi
        diff = sweep_angle - t_angle
        while diff < -math.pi: diff += 2 * math.pi
        while diff > math.pi:  diff -= 2 * math.pi
        if abs(diff) <= sweep_width:
            next_display_targets.append(target)
            
    display_targets = next_display_targets

    # 描画 & 近接ターゲット探索
    nearest_dist_sq = 9999
    nearest_rank = 0
    
    for (tx, ty, ts, tr) in display_targets:
        px = cx + tx 
        py = cy + ty 
        if px > 2 and px < 62 and py > 2 and py < 62:
            dot_w = ts
            off = dot_w // 2
            display.fill_rect(px - off, py - off, dot_w, dot_w, 1)

    # 音判定用
    if len(live_targets) > 0:
        for (tx, ty, ts, tr) in live_targets:
            d_sq = tx*tx + ty*ty
            if d_sq < nearest_dist_sq:
                nearest_dist_sq = d_sq
                nearest_rank = tr

    # レーダー上のVマーク (これはソナー範囲内のときだけ出す)
    if nearest_rank > 0:
        lock_angle = math.atan2(nav_y, nav_x) # live_targetではなくnavデータを使うと正確
        lx = cx + int(math.cos(lock_angle) * radar_r)
        ly = cy + int(math.sin(lock_angle) * radar_r)
        if (now_ms // 100) % 2 == 0:
            display.fill_rect(lx - 1, ly - 1, 3, 3, 1)

    # ==========================
    #  RIGHT: TACTICAL INFO
    # ==========================
    display.vline(65, 0, 64, 1)
    
    # --- 1. 目標距離 (T.DIST) ---
    display.text("DIST.", 72, 2)
    dist_str = f"{target_dist:.1f}m"
    if target_dist < 5.0:
        display.fill_rect(68, 11, 58, 10, 1) 
        display.text(dist_str, 70, 12, 0)    
    else:
        display.rect(68, 11, 58, 10, 1)
        display.text(dist_str, 70, 12, 1)    

    # --- 2. ★方向矢印 (NAV) ---
    arrow_cx = 96
    arrow_cy = 36
    
    # 魚がいるなら矢印を表示 (active_fish_count > 0)
    if active_fish_count > 0:
        # 常に nav_x, nav_y を使って方向を計算
        angle = math.atan2(nav_y, nav_x)
        draw_nav_arrow(arrow_cx, arrow_cy, angle, 12)
    else:
        display.text("-", arrow_cx - 4, arrow_cy - 4)

    # --- 3. 魚の数 (FISH) ---
    display.text(f"FISH:{active_fish_count}", 72, 54)

    display.show()

    # --- 音の制御 ---
    if nearest_rank > 0: 
        interval = 100 + int(nearest_dist_sq / 2) 
        interval = min(1000, max(50, interval))
        tone_freq = 100 + (nearest_rank * 150) 

        if time.ticks_diff(now_ms, last_beep_time) > interval:
            start_tone(tone_freq)
            last_beep_time = now_ms
            is_beeping = True
        
        if is_beeping and time.ticks_diff(now_ms, last_beep_time) > 50:
            stop_tone()
            is_beeping = False
    else:
        stop_tone()
        is_beeping = False

    print(f"{roll:.2f},{pitch:.2f},{jx_val},{jy_val},{1 if sw1_pressed else 0},0")
    time.sleep(0.005)