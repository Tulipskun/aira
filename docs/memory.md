# Memory

## Embedding

ใช้ embedding model แยกสำหรับ long-term memory

## Chroma

Chroma ใช้เก็บและค้นหา long-term memories ด้วย vector similarity

Flow:

```text
message -> embedding -> Chroma query
memory -> embedding -> Chroma add
```

ผลการค้นหาจะถูกส่งให้ Gemini 1 ผ่าน temporary fake tool `search_memory(username)` และไม่ถูกบันทึกเป็น conversation history
