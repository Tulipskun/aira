# SQL

SQLite (`bun:sqlite`) is the persistent store for structured application state.

## Relationship / stats

Store internal relationship state such as:

- `user_id` — Discord ID; stable identity
- `user_name` — current display name
- `state`
- `xp`
- `affinity`
- other relationship/stat fields required by the state system

`user_id` remains the identity when a Discord username changes.

These internal values are not included in the Gemini `<user_profile>` block. In particular, Discord user ID, XP and affinity must not be sent to Gemini.

## User profile

`user_profiles` stores information intended to become context for Gemini 1:

- `name`
- `nicknames`
- `facts`

The application combines the profile with the relationship's human-readable state when constructing `<user_profile>`.

Example:

```xml
<user_profile>
ชื่อ: Yuuta
ความสัมพันธ์กับ Isla: คนรัก
ฉายาที่ Isla ตั้งให้: คนโปรด, คนขี้แกล้ง
fact:
- ชอบให้ไอล่าเรียกว่าที่รัก
- ชอบหมา
- เคยบอกว่าเป็นประธานบริษัท
</user_profile>
```

Gemini 2 can update profile data in a future structured operation. The profile is separate from relationship stats.

## Conversation history

SQLite also stores conversation history so context can be reconstructed after restart.

User messages retain the application-side user ID, username, text, timestamp and optional filename. Model responses retain their role/text/timestamp. Attachment binary data is not stored here; only the filename is retained.

## Temporary data

Fake tool calls/results used to provide Chroma memories to Gemini are request-local and are not stored as conversation history.
