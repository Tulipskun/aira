# Gemini

Gemini 1 และ Gemini 2 ใช้คนละ model และรองรับ API key หลายตัว

## Key rotation

- เริ่มจาก key ปัจจุบัน
- 429 -> rotate ไป key ถัดไป
- ไม่ rotate กลับจนกว่าจะเจอ 429 อีก
- 5xx -> retry key เดิมด้วย backoff

## Gemini 1

รับ conversation context พร้อม relationship instructions และ temporary fake memory tool result แล้วคืน text response

## Gemini 2

รับ context หลัง Gemini 1 ตอบแล้ว และใช้ forced `execute` tool เพื่อส่งคำสั่ง state/stat/memory กลับ application parser

Fake tool call/result ใช้ครั้งเดียวใน request และไม่เก็บเป็น history
