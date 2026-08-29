# SQL

SQLite (`bun:sqlite`) ใช้เก็บข้อมูลถาวรที่ต้อง query แบบ structured

## Relationship

เก็บ:

- `user_id` — Discord ID, stable identity
- `user_name` — ชื่อปัจจุบัน
- `state`
- `xp`
- `affinity`

`user_id` เป็น primary identity เพื่อรองรับกรณี user เปลี่ยนชื่อ

## History

เก็บ conversation history โดยแยก model/user role

- user message: `userId`, username, text, timestamp, filename (ถ้ามี)
- model response: text, timestamp

Fake tool call/result เป็นข้อมูลชั่วคราวของ Gemini request และไม่เก็บลง history
