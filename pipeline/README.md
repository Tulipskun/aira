# Pipeline

`pipeline.ts` is the application orchestration layer.

Flow:

1. Load conversation history from SQL.
2. Add the new Discord message to the Gemini context.
3. Persist the new user message to SQL.
4. Embed the new text with Gemini Embedding 2.
5. Search Chroma using that vector.
6. Load relationship state for the current and related Discord users from SQL.
7. Put relationship state into Gemini1 `system_instruction`.
8. Put Chroma results into temporary fake `search_memory(username)` function-call/result steps.
9. Send the enriched context to Gemini1.
10. Persist Gemini1's response to SQL.
11. Return Gemini1's response immediately.
12. Schedule Gemini2 in the background with the completed Gemini1 context.
13. Gemini2 is forced to call the single `execute` tool.
14. Background execution applies relationship stats and ingests new memories into Chroma.

Gemini never receives Discord IDs. Gemini2 names users by username in `execute` commands; the application resolves that username back to the internal Discord `user_id` using the SQL relationship records before updating state.

Discord user IDs are used only by the application and SQL. They are never included in Gemini context or instructions.

Fake tool steps are request-only and are never persisted to SQL.
