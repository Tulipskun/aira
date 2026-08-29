import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Emotion images are bundled in ./images.
// Gemini 2 returns a filename; only allow known filenames and resolve locally.
const IMAGE_FILES = [
  "isla_about_to_cry_but_holding_back.jpg",
  "isla_angry_fang.jpg",
  "isla_bashful_blazer_red_tie.jpg",
  "isla_covering_ears_dont_want_to_listen.jpg",
  "isla_curious_checkered_scarf_outdoor.jpg",
  "isla_curious_gaze.jpg",
  "isla_embarrassed_looking_up_folder.jpg",
  "isla_forced_smile_uncomfortable.jpg",
  "isla_gentle_smile_calm.jpg",
  "isla_gentle_smile_straptop.jpg",
  "isla_happy_blush_closeup.jpg",
  "isla_happy_blush_formal.jpg",
  "isla_holding_toast_everyday.jpg",
  "isla_icon_pout_blush.png",
  "isla_looking_with_tears_on_cheeks.jpg",
  "isla_pout_crossed_arms_office.jpg",
  "isla_pout_crossed_arms_outdoor.jpg",
  "isla_pouting_looking_annoyed.jpg",
  "isla_sad_tears_dark.jpg",
  "isla_shocked_scarf.jpg",
  "isla_showing_staff_card.jpg",
  "isla_smile_outdoor.jpg",
  "isla_smiling_tears_proposal_farewell.jpg",
  "isla_sparkle_eyes_excited.jpg",
  "isla_surprised_hand_cheek_bow.jpg",
  "isla_surprised_watering_can.jpg",
  "isla_twin_tails_gentle_smile.jpg",
  "isla_unimpressed_slightly_sad.jpg",
] as const;

const IMAGE_SET = new Set<string>(IMAGE_FILES);

function normalizeImageName(fileName: string): string {
  return fileName.trim().split("/").pop() ?? "";
}

export function resolveEmotionImage(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const normalized = normalizeImageName(fileName);
  return IMAGE_SET.has(normalized) ? join(import.meta.dirname ?? ".", "images", normalized) : undefined;
}

export async function fetchEmotionImage(fileName: string | undefined): Promise<Buffer | undefined> {
  if (!fileName) return undefined;
  const normalized = normalizeImageName(fileName);
  if (!IMAGE_SET.has(normalized)) return undefined;

  try {
    const localPath = join(import.meta.dirname ?? ".", "images", normalized);
    return Buffer.from(await readFile(localPath));
  } catch {
    return undefined;
  }
}
