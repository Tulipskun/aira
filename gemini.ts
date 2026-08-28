import { GoogleGenAI } from "@google/genai";

export interface ContextConfig {
  model?: string;
  maxTokens?: number;
  apiKey?: string;
}

const DEFAULT_CONFIG: Required<ContextConfig> = {
  model: "gemini-flash-lite-latest",
  maxTokens: 14000,
  apiKey: process.env.GEMINI_API_KEY,
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thought"; signature: string; summary?: string }
  | { type: "function_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "function_result"; call_id: string; result: unknown };

type Turn = {
  role: "user" | "model" | "tool";

  content: ContentBlock[];
  // เนื้อหาของ turn นี้ เป็น "array ของ ContentBlock" เพราะบางที 1 turn
  // อาจมีหลาย block พร้อมกันได้ (เช่น text ปนกับ function_call)
};

// TurnPair คือ "1 รอบสนทนาที่สมบูรณ์" ตั้งแต่ user ถามจนโมเดลตอบ text สุดท้าย
// อาจมี step แทรกกลาง (tool call/result) กี่ step ก็ได้ระหว่างทาง
// เหตุผลที่ต้องห่อเป็น TurnPair แยกจาก Turn เฉยๆ คือ:
//   - เวลาจะ "ตัด history เก่าทิ้ง" ต้องตัดทั้งรอบพร้อมกันเป็นก้อนเดียว
//   - ป้องกันไม่ให้ตัดแค่ function_call ทิ้งแต่เหลือ function_result ค้างไว้ (ผิดโครงสร้าง)
type TurnPair = {
  turns: Turn[];
};


// ----------------------------------------------------------------------------
// SECTION 3: STATE (ตัวแปรเก็บประวัติสนทนา)
// ----------------------------------------------------------------------------

// "let" คือประกาศตัวแปรที่เปลี่ยนค่าได้ (ต่างจาก "const" ที่ห้ามเปลี่ยนค่าที่ชี้ไป)
// history เก็บ "รอบสนทนาที่จบสมบูรณ์แล้วเท่านั้น" — รอบที่กำลังคุยอยู่ยังไม่เข้ามาตรงนี้
let history: TurnPair[] = [];


// ----------------------------------------------------------------------------
// SECTION 4: HELPER FUNCTIONS
// ----------------------------------------------------------------------------

/**
 * flatten: แปลง history (ที่เก็บเป็นกลุ่ม TurnPair) ให้เป็น array แบน (flat)
 * ของ Turn เดี่ยวๆ เรียงตามลำดับเวลา เพื่อเอาไปส่งให้โมเดลจริง
 *
 * @param pairs       ประวัติสนทนาทั้งหมดที่เก็บไว้
 * @param extraTurns  turn เพิ่มเติมที่ยังไม่ถูกบันทึกลง history (เช่น ข้อความ
 *                    ใหม่ของ user รอบนี้ หรือ fake tool injection ที่จะแทรกก่อนส่ง)
 */
function flatten(pairs: TurnPair[], extraTurns: Turn[] = []): Turn[] {
  // สร้าง array ว่างไว้ก่อน แล้วค่อยๆ push ของเข้าไป
  const flat: Turn[] = [];

  // "for...of" คือ loop วนอ่านทีละตัวใน array
  for (const pair of pairs) {
    // "...pair.turns" คือ spread operator — แกะทุกตัวใน pair.turns ออกมา
    // ใส่ต่อท้าย flat ทีละตัว (ไม่ใช่ push ทั้ง array เป็นก้อนเดียว)
    flat.push(...pair.turns);
  }

  // แปะ extraTurns (ถ้ามี) ต่อท้ายสุด เพราะเป็นสิ่งที่ "ใหม่กว่า" ประวัติเก่าทั้งหมด
  flat.push(...extraTurns);

  return flat;
}

/**
 * toCountableContents: แปลง Turn[] ให้เป็นรูปแบบที่ countTokens ของ SDK เข้าใจ
 * ต้องแปลง ContentBlock ที่ไม่ใช่ text (เช่น function_call) ให้เป็น string ก่อน
 * เพราะ countTokens นับจาก "ข้อความ" เป็นหลัก — เราจึง JSON.stringify มันเพื่อให้
 * ยังนับ token ของ args/result ที่ฝังอยู่ข้างในด้วย ไม่ให้ underestimate
 */
function toCountableContents(turns: Turn[]) {
  // ".map()" คือ loop ที่แปลงของทีละตัวแล้วคืน array ใหม่ (ไม่แก้ array เดิม)
  return turns.map((turn) => ({
    role: turn.role,
    parts: turn.content.map((block) => {
      // ตรวจว่า block นี้เป็น text ธรรมดาไหม
      if (block.type === "text") {
        return { text: block.text };
      }
      // ถ้าไม่ใช่ text (คือ function_call หรือ function_result)
      // ให้แปลง object ทั้งก้อนเป็น string ด้วย JSON.stringify เพื่อนับ token
      return { text: JSON.stringify(block) };
    }),
  }));
}

/**
 * countTokens: เรียก API นับ token จริง โดยรับ client + model + turns ที่จะนับ
 * แยกเป็นฟังก์ชันย่อยเพื่อไม่ให้ buildContextWindow ยาวเกินไป
 */
async function countTokens(
  ai: GoogleGenAI,
  model: string,
  turns: Turn[]
): Promise<number> {
  // "await" คือรอผลลัพธ์ของ Promise (งานที่ทำงานแบบ async ไม่ block โปรแกรม)
  const response = await ai.models.countTokens({
    model,
    contents: toCountableContents(turns),
  });

  // countResponse.totalTokens คือจำนวน token รวมที่ API คำนวณให้
  return response.totalTokens;
}


// ----------------------------------------------------------------------------
// SECTION 5: FAKE TOOL INJECTION
// ----------------------------------------------------------------------------
// ฟีเจอร์หลักที่ขอมา: อยากยัดข้อมูล (เช่น ข้อมูล user profile, retrieved docs,
// system state) เข้าไปในบทสนทนา แต่ "ไม่อยากปนกับ user message" ตรงๆ
//
// วิธีแก้คือ: สร้าง function_call ปลอม (สมมติว่าโมเดลเรียก tool ชื่อหนึ่ง)
// ตามด้วย function_result ปลอม (ใส่ข้อมูลที่อยากยัดเข้าไปตรงนี้)
// โมเดลจะอ่านมันเหมือนเป็นผลลัพธ์จาก tool จริงๆ โดยที่ user ไม่เห็นและไม่ได้พิมพ์เอง
//
// ข้อควรระวัง: เทคนิคนี้คือการ "หลอก" โมเดลว่ามี tool call เกิดขึ้นจริง
// ควรใช้เฉพาะกรณีที่คุณควบคุม pipeline เองทั้งหมด และมั่นใจว่าไม่ทำให้
// โมเดลหลงเชื่อข้อมูลที่ไม่ควรเชื่อ (เช่น อย่าเอาไปใช้ฉีด instruction ที่ override
// ความปลอดภัยของระบบ)

/**
 * createFakeToolInjection: สร้างคู่ function_call + function_result ปลอม
 * เพื่อแทรกข้อมูลเข้า context โดยไม่ต้องผ่าน user content
 *
 * @param toolName  ชื่อ tool สมมติ (จะไม่ถูกเรียกจริง แค่ใช้เป็น label ให้โมเดลอ่าน)
 * @param fakeArgs  argument ปลอมที่ "เหมือนว่า" โมเดลเป็นคนขอมา (ใส่อะไรก็ได้ที่
 *                  ทำให้ดูสมเหตุสมผล เช่น { query: "user profile" })
 * @param data      ข้อมูลจริงที่อยากยัดเข้าไปให้โมเดลเห็น (ผลลัพธ์ปลอมของ tool)
 */
function createFakeToolInjection(
  toolName: string,
  fakeArgs: Record<string, unknown>,
  data: unknown
): Turn[] {
  // สร้าง id แบบง่ายๆ ด้วย timestamp + random string กันชนกัน
  // (ใน production จริงอาจใช้ library เช่น uuid แทน)
  const fakeCallId = `injected_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // คืนกลับเป็น array ของ 2 Turn เรียงต่อกัน:
  // 1) role "model" บอกว่าโมเดล (ปลอมๆ) เรียก tool นี้ด้วย argument นี้
  // 2) role "tool" บอกผลลัพธ์ (ปลอมๆ) ที่ได้กลับมา
  return [
    {
      role: "model",
      content: [
        {
          type: "function_call",
          id: fakeCallId,
          name: toolName,
          args: fakeArgs,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "function_result",
          call_id: fakeCallId, // ต้องตรงกับ id ด้านบน ไม่งั้นโมเดลจะงงว่า result มาจากไหน
          result: data,
        },
      ],
    },
  ];
}


// ----------------------------------------------------------------------------
// SECTION 6: BUILD CONTEXT WINDOW (ตัด history เก่าถ้าเกิน budget)
// ----------------------------------------------------------------------------

/**
 * buildContextWindow: ฟังก์ชันหลักที่ประกอบ context window สุดท้าย
 * ก่อนส่งเข้าโมเดลจริง โดยตัด turn เก่าสุดออกทีละ "รอบ" (ไม่ใช่ทีละข้อความ)
 * จนกว่าจำนวน token จะไม่เกิน maxTokens ที่ config ไว้
 *
 * @param ai            instance ของ GoogleGenAI client
 * @param userMessage   ข้อความใหม่จาก user ที่ยังไม่เคยเข้า history
 * @param injectedTurns turn ปลอม (เช่นจาก createFakeToolInjection) ที่อยากแทรก
 *                      ก่อนข้อความ user ในรอบนี้ — ใส่ array ว่างถ้าไม่ต้องการ
 * @param config        การตั้งค่าที่ override ค่า default ได้
 */
async function buildContextWindow(
  ai: GoogleGenAI,
  userMessage: string,
  injectedTurns: Turn[] = [],
  config: ContextConfig = {}
): Promise<Turn[]> {
  // รวม config ที่ผู้ใช้ส่งมา เข้ากับค่า default
  // "..." ตรงนี้คือ spread เหมือนกัน แต่ใช้กับ object แทน array
  // ลำดับสำคัญ: ตัวหลังจะ "ทับ" ตัวก่อนหน้าถ้ามี key ซ้ำกัน
  const finalConfig: Required<ContextConfig> = { ...DEFAULT_CONFIG, ...config };

  // สร้าง turn ของ user message ใหม่ (ยังไม่ถูกบันทึกลง history ถาวร)
  const pendingUserTurn: Turn = {
    role: "user",
    content: [{ type: "text", text: userMessage }],
  };

  // เรียงลำดับ turn ที่จะเป็น "ส่วนเพิ่มเติม" นอกเหนือจาก history เก่า:
  // ให้ fake injection มาก่อน แล้วตามด้วยข้อความ user จริง
  // (จะสลับลำดับก็ได้ แล้วแต่ว่าอยากให้โมเดลเห็นข้อมูลก่อนหรือหลังคำถาม)
  const extraTurns: Turn[] = [...injectedTurns, pendingUserTurn];

  // วน loop ตัด history เก่าออกเรื่อยๆ จนกว่าจะพอดี budget
  // "while (condition)" คือ loop ที่ทำซ้ำตราบเท่าที่เงื่อนไขยังเป็นจริง
  while (history.length > 0) {
    // ประกอบ context ตัวเต็มที่ "จะส่งจริงถ้าไม่ตัดต่อ" เพื่อเอาไปนับ token
    const candidate = flatten(history, extraTurns);

    // เรียกนับ token จริงผ่าน API
    const totalTokens = await countTokens(ai, finalConfig.model, candidate);

    // ถ้า debug mode เปิดอยู่ ให้ print ให้เห็นว่าตอนนี้กี่ token แล้ว
    if (finalConfig.debug) {
      console.log(`[context-window] ตอนนี้มี ${totalTokens} tokens (limit: ${finalConfig.maxTokens})`);
    }

    // ถ้าไม่เกิน budget แล้ว ก็หยุด loop ได้เลย ไม่ต้องตัดต่อ
    if (totalTokens <= finalConfig.maxTokens) {
      break; // "break" คือคำสั่งออกจาก loop ทันที
    }

    // ถ้าเกิน budget: ตัด TurnPair ตัวแรกสุด (เก่าสุด) ออกจาก history ทั้งก้อน
    // ".shift()" คือ method ของ array ที่ลบสมาชิกตัวแรกออก แล้วคืนค่าตัวที่ถูกลบ
    // เราไม่ได้ใช้ค่าที่คืนมา เลยไม่เก็บใส่ตัวแปรไหน
    history.shift();

    // ถ้า history หมดแล้วแต่ token ยังเกิน (เช่น 1 ข้อความยาวเกิน budget เอง)
    // loop จะออกเองเพราะเงื่อนไข while (history.length > 0) เป็น false
  }

  // คืนค่า context window สุดท้ายที่พร้อมส่งเข้าโมเดล
  return flatten(history, extraTurns);
}


// ----------------------------------------------------------------------------
// SECTION 7: SEND MESSAGE (ยิง request จริง + จัดการ tool call จริง + บันทึก history)
// ----------------------------------------------------------------------------

/**
 * SendMessageOptions: ตัวเลือกเพิ่มเติมตอนเรียก sendMessage
 */
export interface SendMessageOptions {
  // รายการ tool จริงที่โมเดลสามารถเรียกใช้ได้ (ตาม schema ของ Gemini function calling)
  tools?: unknown[];

  // ข้อมูลปลอมที่จะแทรกก่อนข้อความ user รอบนี้ (ถ้ามี) — ใช้คู่กับ
  // createFakeToolInjection ด้านบน
  injectedTurns?: Turn[];

  // config เรื่อง model/token/debug เหมือนเดิม
  config?: ContextConfig;

  // ฟังก์ชันจริงที่จะถูกเรียกเมื่อโมเดลขอใช้ tool (ไม่ใช่ fake injection)
  // รับชื่อ tool + argument string แล้วคืนผลลัพธ์อะไรก็ได้กลับมา
  onToolCall?: (name: string, argsText: string) => Promise<unknown>;
}

/**
 * sendMessage: ฟังก์ชันหลักที่ผู้ใช้ทั่วไปจะเรียกใช้งาน
 * ทำหน้าที่ครบวงจร: ประกอบ context -> ยิง request แบบ stream -> จัดการ tool call จริง
 * ที่โมเดลขอมา -> บันทึกผลลัพธ์กลับเข้า history
 */
export async function sendMessage(
  userMessage: string,
  options: SendMessageOptions = {}
): Promise<string> {
  // ดึงค่าจาก options พร้อมตั้งค่า default ให้ field ที่ไม่ได้ส่งมา
  const {
    tools = [],
    injectedTurns = [],
    config = {},
    onToolCall = async () => ({}), // ถ้าไม่ส่งมา ให้เป็นฟังก์ชันที่คืน object ว่างเฉยๆ
  } = options;

  const finalConfig: Required<ContextConfig> = { ...DEFAULT_CONFIG, ...config };

  // สร้าง client ของ Gemini SDK จาก apiKey ที่ config ไว้
  const ai = new GoogleGenAI({ apiKey: finalConfig.apiKey });

  // เรียก buildContextWindow เพื่อได้ context ที่ตัดแล้วเรียบร้อย พร้อมส่งจริง
  const contextWindow = await buildContextWindow(
    ai,
    userMessage,
    injectedTurns,
    finalConfig
  );

  // ยิง request แบบ streaming เข้า Interactions API
  const stream = await ai.interactions.create({
    model: finalConfig.model,
    input: contextWindow,
    tools,
    stream: true,
    store: false, // เราคุม history เองฝั่ง client ไม่ต้องพึ่ง server-side state
  });

  // เตรียม array เก็บทุก step ที่เกิดขึ้นใน "รอบนี้" ก่อนจะ push รวมเข้า history จริง
  // เริ่มด้วย injectedTurns (ถ้ามี) แล้วตามด้วยข้อความ user
  const turnSteps: Turn[] = [
    ...injectedTurns,
    { role: "user", content: [{ type: "text", text: userMessage }] },
  ];

  // ตัวแปรพักข้อความ text ที่โมเดล stream ออกมาทีละ chunk
  let finalText = "";

  // ตัวแปรพัก function call ที่กำลังถูก stream เข้ามา (args มาทีละท่อนต้องต่อกันเอง)
  let currentFuncCall: { id: string; name: string; argsText: string } | null = null;

  // "for await...of" คือ loop สำหรับอ่าน stream แบบ async ทีละ event
  for await (const event of stream) {
    // เช็คว่า event นี้คือ "เริ่มมี step ใหม่" และ step นั้นเป็น function_call
    if (event.event_type === "step.start" && event.step.type === "function_call") {
      // เริ่มเก็บข้อมูล function call ใหม่ (args ยังว่างเปล่า รอ delta มาต่อ)
      currentFuncCall = { id: event.step.id, name: event.step.name, argsText: "" };
    }
    // เช็คว่า event นี้คือ "มีเนื้อหาทยอยส่งมาเพิ่ม" (delta)
    else if (event.event_type === "step.delta") {
      if (event.delta.type === "text") {
        // ถ้าเป็น text ก็ต่อเข้า finalText ไปเรื่อยๆ
        finalText += event.delta.text;
      } else if (event.delta.type === "arguments_delta" && currentFuncCall) {
        // ถ้าเป็นส่วนหนึ่งของ argument ของ function call ที่กำลังสร้างอยู่
        // ให้ต่อ string เข้าไปเรื่อยๆ (สุดท้ายจะได้ JSON string ที่สมบูรณ์)
        currentFuncCall.argsText += event.delta.text;
      }
    }
    // เช็คว่า function call ที่กำลังสร้างอยู่นั้น "จบแล้ว" (args ครบสมบูรณ์)
    else if (
      event.event_type === "step.start" &&
      event.step.type === "function_call_end" &&
      currentFuncCall
    ) {
      // บันทึก function_call ที่สมบูรณ์แล้วลงใน turnSteps
      turnSteps.push({
        role: "model",
        content: [
          {
            type: "function_call",
            id: currentFuncCall.id,
            name: currentFuncCall.name,
            // แปลง argsText (string) กลับเป็น object ด้วย JSON.parse
            // ถ้า argsText ว่างเปล่า ให้ใช้ "{}" กันแตก
            args: JSON.parse(currentFuncCall.argsText || "{}"),
          },
        ],
      });

      // เรียก tool จริงที่ผู้ใช้ฟังก์ชันนี้กำหนดไว้ผ่าน onToolCall
      const toolResult = await onToolCall(
        currentFuncCall.name,
        currentFuncCall.argsText
      );

      // บันทึกผลลัพธ์จาก tool ลงใน turnSteps ด้วย
      turnSteps.push({
        role: "tool",
        content: [
          {
            type: "function_result",
            call_id: currentFuncCall.id,
            result: toolResult,
          },
        ],
      });

      // เคลียร์ currentFuncCall กลับเป็น null รอรอบถัดไป (เผื่อโมเดลเรียก tool ต่ออีก)
      currentFuncCall = null;
    }
  }

  // ถ้ามีข้อความ text สุดท้ายที่โมเดลตอบออกมา ให้บันทึกเป็น turn ปิดท้าย
  if (finalText) {
    turnSteps.push({
      role: "model",
      content: [{ type: "text", text: finalText }],
    });
  }

  // บันทึกรอบสนทนานี้ทั้งก้อนเข้า history แบบถาวร
  // (ทำตรงนี้ที่เดียว หลังจากทุกอย่างในรอบนี้จบสมบูรณ์แล้วเท่านั้น)
  history.push({ turns: turnSteps });

  // คืนข้อความสุดท้ายที่โมเดลตอบกลับให้ผู้เรียกใช้ฟังก์ชัน
  return finalText;
}


// ----------------------------------------------------------------------------
// SECTION 8: ตัวอย่างการใช้งาน (ลบ/แก้ตามต้องการ ไม่ได้ถูกรันอัตโนมัติ)
// ----------------------------------------------------------------------------

async function exampleUsage() {
  // ตัวอย่าง 1: ส่งข้อความธรรมดา พร้อม config แบบ custom
  const reply1 = await sendMessage("สวัสดี ผมชื่อบอส", {
    config: {
      model: "gemini-3.5-flash",
      maxTokens: 4000,
      debug: true,
    },
  });
  console.log("ตอบกลับ 1:", reply1);

  // ตัวอย่าง 2: แทรกข้อมูลปลอมเข้าไปก่อนคำถามของ user
  // เช่น สมมติว่าเรามีข้อมูล user profile จาก database อยากให้โมเดลรู้
  // แต่ไม่อยากให้ปนอยู่ในข้อความ user ตรงๆ
  const fakeInjection = createFakeToolInjection(
    "get_user_profile", // ชื่อ tool สมมติ
    { user_id: "12345" }, // argument ปลอม
    { name: "บอส", plan: "pro", signup_date: "2025-01-01" } // ข้อมูลจริงที่อยากยัดเข้าไป
  );

  const reply2 = await sendMessage("ช่วยแนะนำแพ็กเกจที่เหมาะกับผมหน่อย", {
    injectedTurns: fakeInjection,
    config: { model: "gemini-3.5-flash" },
  });
  console.log("ตอบกลับ 2:", reply2);

  // ตัวอย่าง 3: ใช้ tool จริงร่วมด้วย (โมเดลจะเรียกเองถ้าจำเป็น)
  const weatherTool = {
    name: "get_weather",
    description: "ดึงข้อมูลสภาพอากาศปัจจุบันของเมืองที่ระบุ",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  };

  const reply3 = await sendMessage("วันนี้กรุงเทพอากาศเป็นไงบ้าง", {
    tools: [weatherTool],
    onToolCall: async (name, argsText) => {
      // ตรงนี้คือจุดที่คุณเรียก API สภาพอากาศจริงของคุณเอง
      if (name === "get_weather") {
        return { temperature: 34, condition: "แดดจัด" };
      }
      return {};
    },
  });
  console.log("ตอบกลับ 3:", reply3);
}
