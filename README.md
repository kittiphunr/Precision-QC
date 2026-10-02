# 🍄 Precision QC — ระบบตรวจสอบความสมบูรณ์ของเชื้อรา

วิเคราะห์ภาพโคโลนีเชื้อรา (เส้นใย / mycelium) บนจานเพาะเชื้อ แล้วตัดสินผล **PASS / FAIL**
พร้อมคะแนน เกรด และภาพประกอบ 8 ส่วน (ตามรูปแบบรายงาน Precision QC)

ตัวประมวลผลเขียนด้วย **Python** (ใช้แค่ `numpy` + `Pillow`) โค้ดชุดเดียวกันรันได้ 3 ทาง:

| วิธี | ใช้ทำอะไร |
|---|---|
| 🌐 **เว็บบน GitHub Pages** | เปิดเว็บ อัปโหลดภาพ เห็นผลทันที — Python รันในเบราว์เซอร์ผ่าน [Pyodide](https://pyodide.org) ไม่ต้องมีเซิร์ฟเวอร์ ภาพไม่ถูกส่งออกไปไหน |
| ⚙️ **GitHub Actions (QC Batch)** | push ภาพเข้าโฟลเดอร์ `inputs/` → ได้ตาราง PASS/FAIL ในหน้า Summary + ไฟล์รายงานให้ดาวน์โหลด |
| 💻 **Command line / Codespaces** | `python -m precision_qc <โฟลเดอร์ภาพ>` |

---

## เริ่มใช้งานบน GitHub

### 1) เปิดเว็บด้วย GitHub Pages
1. Push โค้ดขึ้น branch `main`
2. ไปที่ **Settings → Pages → Build and deployment → Source** เลือก **GitHub Actions**
3. Workflow **Deploy web app to GitHub Pages** จะรันเทสต์และ deploy ให้อัตโนมัติ
   (หรือกด *Run workflow* ในแท็บ Actions)
4. เปิด `https://<username>.github.io/<repo>/` → ลากภาพมาวาง หรือกดปุ่มภาพตัวอย่าง

### 2) อัปโหลดขึ้นโฮสต์จริง (Shared hosting / Apache / Nginx)
ไฟล์ที่พร้อมอัปโหลดอยู่ในโฟลเดอร์ **`deploy/`** แล้ว เว็บนี้เป็น static ทั้งหมด จึงไม่ต้องติดตั้ง Python หรือฐานข้อมูลบนเซิร์ฟเวอร์

1. อัปโหลด**ไฟล์ทั้งหมดในโฟลเดอร์ `deploy/`** (ไม่ใช่ตัวโฟลเดอร์) ขึ้น `public_html/` หรือโฟลเดอร์ย่อย เช่น `public_html/qc/`
   ด้วย FTP/SFTP (FileZilla) หรือ File Manager ของ cPanel/DirectAdmin
2. ต้องมีไฟล์ซ่อน **`.htaccess`** ไปด้วย (ใน FileZilla เปิด *Server → Force showing hidden files*)
   ไฟล์นี้กันไม่ให้เซิร์ฟเวอร์รันไฟล์ `.py` เป็นสคริปต์ และตั้งค่า cache ให้เห็นเวอร์ชันใหม่ทันที
3. เปิด `https://<โดเมน>/` (หรือ `https://<โดเมน>/qc/`) ผ่าน **HTTPS** แล้วลองกดภาพตัวอย่าง

เครื่องผู้ใช้ต้องต่ออินเทอร์เน็ตได้ เพราะหน้าเว็บโหลด Pyodide, Pure.css และฟอนต์จาก CDN
ถ้าใช้ **Nginx** (ไม่อ่าน `.htaccess`) ให้ตั้ง `location ~ \.py$ { default_type text/plain; }` แทน

**อัปเดตเวอร์ชัน:** หลังแก้โค้ดใน `web/` หรือ `precision_qc/` ให้สร้างโฟลเดอร์ใหม่ แล้วอัปโหลดทับทั้งหมด
```bash
python scripts/build_site.py --out deploy
```
CI จะแจ้งเตือนถ้าโฟลเดอร์ `deploy/` ไม่ตรงกับโค้ดล่าสุด

### ภาษา · Language · 语言
- หน้าเว็บและรายงาน PDF รองรับ **ไทย · English · 中文** — สลับได้จากปุ่มมุมขวาบน ระบบจำภาษาที่เลือกไว้
- ลิงก์ตรงเข้าภาษาที่ต้องการ: `?lang=th`, `?lang=en`, `?lang=zh`
- รายงาน PDF ออกเป็นภาษาที่เลือกอยู่ขณะกดดาวน์โหลด (ชื่อไฟล์ลงท้าย `_TH`, `_EN`, `_ZH`)
- ข้อความทั้งหมดอยู่ในไฟล์ `web/i18n.js` แก้คำแปลได้ที่เดียว

### หน้าตาเว็บ · โหมดสว่าง / มืด
- จัดหน้าด้วย **[Pure.css](https://pure-css.github.io/) 3.0** (grid, ปุ่ม, ฟอร์ม, ตาราง) เสริมด้วย `web/style.css`
- ปุ่ม **สว่าง · มืด · อัตโนมัติ** มุมขวาบน — "อัตโนมัติ" ตามการตั้งค่าของระบบปฏิบัติการ ระบบจำค่าที่เลือกไว้
- มีแถบขั้นตอนการใช้งาน 3 ขั้น (อัปโหลด → ตรวจสอบผล → ดาวน์โหลดรายงาน) และรองรับมือถือ
- รายงาน PDF เป็นพื้นขาวเสมอ ไม่ว่าจะใช้โหมดใด

### รายงาน PDF (A4 แนวตั้ง)
- กด **ดาวน์โหลดรายงาน PDF** ที่การ์ดของแต่ละภาพ หรือ **รายงาน PDF ทั้งหมด** เพื่อรวมทุกภาพไว้ในไฟล์เดียว
- กรอกข้อมูลหน่วยงาน ผู้วิเคราะห์ และรายละเอียดตัวอย่างในหัวข้อ **ข้อมูลสำหรับรายงาน PDF** ระบบจะจำค่าไว้ในเบราว์เซอร์
- โครงสร้างรายงานตาม **ISO/IEC 17025:2017 ข้อ 7.8**: ชื่อหน่วยงาน, เลขที่รายงานเฉพาะบนทุกหน้า, หน้า x จาก y,
  ข้อมูลลูกค้าและตัวอย่าง, วันที่ (รูปแบบ ISO 8601), วิธีทดสอบ, ผลพร้อมหน่วยและเกณฑ์, คำแถลงความสอดคล้อง
  (decision rule แบบ simple acceptance ตาม ILAC-G8:09/2019), หมายเหตุ/ข้อเบี่ยงเบน, ผู้วิเคราะห์และผู้อนุมัติ,
  ข้อความจำกัดความรับผิด และเครื่องหมายสิ้นสุดรายงาน — หน้า 2 เป็นภาคผนวกภาพวิเคราะห์

### 2) ตรวจภาพเป็นชุดด้วย GitHub Actions
- วางภาพใน `inputs/` แล้ว commit + push → workflow **QC Batch** รันเอง
- หรือไปที่ **Actions → QC Batch → Run workflow** แล้วกำหนด `folder`, `min_score`, `plate_cm`, `strict`
- ผลลัพธ์: ตารางในหน้า run summary และ artifact `qc-reports` (ภาพรายงาน PNG, JSON, `summary.csv`)

### 3) Codespaces
กด **Code → Codespaces → Create codespace** — ระบบติดตั้ง dependency และเปิดเว็บที่พอร์ต 8000 ให้

## รันบนเครื่องตัวเอง

```bash
pip install -r requirements-dev.txt
pytest -q                                   # ทดสอบ
python -m precision_qc samples -o reports   # วิเคราะห์ภาพตัวอย่าง
python -m precision_qc my_plates/ --set min_score=70 --set plate_cm=9 --strict
python scripts/build_site.py --serve        # เปิดเว็บที่ http://localhost:8000
```

---

## วิธีการวิเคราะห์

| # | ส่วนของรายงาน | วิธีคำนวณ |
|---|---|---|
| 1 | **Original + Scale** | หาขอบจานด้วย Hough transform → แปลง pixel เป็น cm จากขนาดจาน (ค่าเริ่มต้น 8.5 cm) วัดกว้าง×สูงของโคโลนี |
| 2 | **Whiteness** | ชดเชยแสง (white balance + exposure) แล้วคำนวณความขาวจากค่า CIE L\*a\*b\* : สว่างสูงและสีจาง = ขาว |
| 3 | **Fluffiness** | ความละเอียดของเส้นใยจาก Laplacian, local std และความหนาแน่นของขอบภายในโคโลนี |
| 4 | **Contamination filter** | จำแนกพิกเซลในจาน: เส้นใยสะอาด / วุ้นเปลือย (เหลือง-เบจ) / ปนเปื้อน (แดง-ส้ม-น้ำตาล, เขียว) / หมึกปากกา (น้ำเงิน-ม่วง — ไม่นับเป็นการปนเปื้อน) / พื้นที่มืด |
| 5 | **Color ratio Y/R/B** | สัดส่วนพื้นที่สีเหลือง แดง น้ำเงิน ต่อพื้นที่จาน |
| 6 | **Circularity** | สร้างขอบโคโลนีด้วย radial profile จากจุดศูนย์กลาง → Circularity (4πA/P²), IoU กับวงกลมอุดมคติ, Symmetry |
| 7 | **Color calibration** | เทียบสีเฉลี่ยของแต่ละกลุ่มกับสีมาตรฐาน (ΔE Lab) |
| 8 | **QC report** | คะแนนรวมถ่วงน้ำหนัก + เกรด + ผลตัดสิน |

**คะแนนรวม** = Growth 35% + Whiteness 25% + Fluffiness 25% + Shape 15%
(Growth score = การเจริญ ÷ 75% × 100, สูงสุด 100)

**เกรด**: A ≥ 80 (Excellent) · B ≥ 65 (Good) · C ≥ 50 (Fair) · D < 50 (Poor)

### เกณฑ์ PASS / FAIL (ปรับได้ทั้งในเว็บและ CLI)

ภาพ **ผ่าน** เมื่อไม่ติดเงื่อนไขใดเลย:

| รหัส | เงื่อนไข FAIL | ค่าเริ่มต้น |
|---|---|---|
| `Contaminated` | พื้นที่สีปนเปื้อน (แดง/น้ำตาล/เขียว) เกิน | 3 % |
| `Agar Exposed` | วุ้นเปลือยเกิน | 25 % |
| `Low Growth` | พื้นที่โคโลนีน้อยกว่า | 30 % |
| `Check Shape` | IoU รูปทรงน้อยกว่า | 0.60 |
| `Low Score` | คะแนนรวมน้อยกว่า | 60 |

ค่าทั้งหมดอยู่ใน `QCConfig` (`precision_qc/analyzer.py`) — ส่งผ่าน `--set key=value`, `--config file.json` หรือแผง “ตั้งค่า” บนเว็บ

### ผลกับภาพตัวอย่าง (`samples/`)

| ภาพ | ผล | คะแนน | สาเหตุ |
|---|---|---|---|
| white_colony | ✅ PASS | 83.0 (A) | — |
| labeled_plate | ✅ PASS | 80.4 (A) | หมึกปากกาบนฝาถูกแยกออก ไม่นับเป็นการปนเปื้อน |
| black_king_oyster | ❌ FAIL | 76.5 (B) | Agar Exposed (~34%) |
| sporulation | ❌ FAIL | 39.7 (D) | Contaminated, Low Growth, … |

> ภาพตัวอย่างถูกตัดจากภาพหน้าจอรายงานเดิม จึงมีเส้นกากบาทติดมาด้วย — ใช้เพื่อสาธิตและทดสอบเท่านั้น
> สำหรับงานจริงควรถ่ายภาพจากด้านบน แสงสม่ำเสมอ จานอยู่กลางภาพ และปรับเกณฑ์ให้เข้ากับสายพันธุ์ที่เพาะ

## โครงสร้างโปรเจกต์

```
precision_qc/        Python engine
  analyzer.py        ตรวจจับจาน, จำแนกพิกเซล, คำนวณ metric, ตัดสิน PASS/FAIL
  render.py          สร้างภาพ 6 panel และรายงาน PNG
  api.py             JSON bridge ที่เว็บ (Pyodide) เรียกใช้
  cli.py             คำสั่ง batch  (python -m precision_qc)
web/                 หน้าเว็บ (HTML/CSS/JS) — โหลด Pyodide แล้วเรียก precision_qc.api
  i18n.js            ข้อความ 3 ภาษา (ไทย / English / 中文)
scripts/build_site.py  ประกอบเว็บ + โค้ด Python ลง _site/ สำหรับ GitHub Pages (หรือ deploy/)
deploy/              ไฟล์พร้อมอัปโหลดขึ้นโฮสต์จริง (สร้างจาก build_site.py — อย่าแก้ไฟล์ในนี้ตรง ๆ)
hosting/.htaccess    ค่าเซิร์ฟเวอร์ Apache ที่ build ใส่ลงใน deploy/
samples/             ภาพตัวอย่าง
inputs/              วางภาพที่นี่เพื่อให้ QC Batch workflow ตรวจ
tests/               pytest
.github/workflows/   CI, QC Batch, Pages deploy
```

## ผู้พัฒนา / Developer

**นายกิตติพันธ์ รัตนคร** นักวิชาการคอมพิวเตอร์
มหาวิทยาลัยมหาจุฬาลงกรณราชวิทยาลัย วิทยาเขตแพร่

**Mr. Kittiphun Rattanakorn**, Computer Technical Officer
Mahachulalongkornrajavidyalaya University, Phrae Campus
