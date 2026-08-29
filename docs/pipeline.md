# AI Pipeline

`pipeline.ts` รับข้อความที่ผ่าน scheduler แล้ว

1. อ่าน history จาก SQL
2. สร้าง Gemini context ด้วยข้อความใหม่
3. บันทึก user message ลง SQL
4. ทำ embedding ของข้อความ
5. ค้นหา long-term memories จาก Chroma
6. อ่าน relationship ของ user ที่เกี่ยวข้องจาก SQL
7. ใส่ relationship ใน system instructions
8. ใส่ผล `search_memory(username)` เป็น temporary fake tool call/result ให้ Gemini 1
9. Gemini 1 สร้าง text response
10. บันทึก model response ลง SQL
11. ส่งงาน Gemini 2 ต่อแบบ background
12. Gemini 2 ใช้ forced `execute` สำหรับ state/stat/memory operations
13. memory ใหม่ถูก embedding แล้วบันทึกลง Chroma
14. relationship/stats ถูกบันทึกลง SQL

Temporary fake tool data ใช้ใน request เท่านั้น ไม่ถูกบันทึกเป็น history
