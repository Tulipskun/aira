# Message Scheduler

Scheduler แยก pending turn ตาม Discord `userId`

- ข้อความจาก user เดิม: รวมเข้า batch เดิมและ reset debounce 5 วินาที
- ถ้า user เดิมเงียบครบ 5 วินาที: flush batch
- batch หนึ่งเริ่มนับ maximum wait 12 วินาทีจากข้อความแรก
- ถ้ามี user อื่นส่งข้อความเข้ามา: flush pending ของ user อื่นทันที
- แต่ละ user มี timer และ batch แยกกัน
- `flushAll()` ใช้สำหรับ shutdown handling

หลักการคือ debounce ต่อผู้ใช้ ไม่ใช่ debounce ต่อ channel
