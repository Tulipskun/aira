/**
 * Offline tests for the expression-image catalog (`src/bot/images.ts`).
 *
 * These exist because the catalog used to be a hardcoded list that had drifted completely away from
 * the directory it described: the `select_image` enum offered names (`happy`, `neutral`, …) that had
 * no file behind them, so every picture the model chose failed to resolve and the embed lost its
 * image in silence. The tests below pin the contract that replaces it — *the directory is the enum*.
 *
 *   bun run scripts/test-images.ts
 *
 * No network, no Gemini quota: everything runs against a throwaway directory of fake files.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, seen?: unknown): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${cond || seen === undefined ? "" : ` -- got: ${JSON.stringify(seen)}`}`);
  cond ? pass++ : fail++;
}

const root = mkdtempSync(join(tmpdir(), "aira-images-test-"));
const dir = join(root, "images");
mkdirSync(dir, { recursive: true });

function seed(files: Record<string, string>, manifest: unknown = undefined): string {
  const target = mkdtempSync(join(root, "set-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(target, name), body);
  if (manifest !== undefined) writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest));
  return target;
}

const { imageCatalog, imageNames, imageListForPrompt, isKnownImage, resolveEmotionImage, fetchEmotionImage, IMAGE_EXTENSIONS } =
  await import("../src/bot/images.js");

// ---------------------------------------------------------------- 1. the listing
console.log("=== 1. catalog = the files on disk ===");
{
  const set = seed(
    {
      "b_second.jpg": "B",
      "a_first.png": "A",
      "c_third.webp": "C",
      "notes.txt": "not an image",
      "README.md": "not an image",
      "manifest.json": "{}",
    },
    {
      "a_first.png": "หน้าแรก — ใช้ตอนทดสอบ //group=alpha",
      "b_second.jpg": "ไม่มีคำอธิบาย",
    },
  );
  const catalog = imageCatalog(set);
  check("only image files are offered", catalog.map((e) => e.name).join(",") === "a_first.png,b_second.jpg,c_third.webp", catalog.map((e) => e.name));
  check("sorted by filename (a stable prompt + enum)", imageNames(set).join(",") === "a_first.png,b_second.jpg,c_third.webp");
  check("manifest description becomes the usage note", catalog[1].usage === "ไม่มีคำอธิบาย");
  check("//group is stripped from the usage text", catalog[0].usage === "หน้าแรก — ใช้ตอนทดสอบ" && catalog[0].group === "alpha", catalog[0]);
  check("an undocumented file is still offered", catalog[2].usage === "" && catalog[2].group === "");
  check("isKnownImage follows the listing", isKnownImage("a_first.png", set) && !isKnownImage("notes.txt", set) && !isKnownImage("manifest.json", set));
  check("every offered extension is one we can attach", IMAGE_EXTENSIONS.every((ext) => ext.startsWith(".")));
}

// ---------------------------------------------------------------- 2. broken inputs
console.log("=== 2. a broken catalog must cost the picture, never the reply ===");
{
  const noDir = join(root, "does-not-exist");
  check("missing directory -> empty catalog, no throw", imageCatalog(noDir).length === 0);
  check("missing directory -> prompt says so honestly", imageListForPrompt(noDir).includes("ไม่มีรูปภาพให้ใช้"));
  check("missing directory -> nothing resolves", resolveEmotionImage("a.jpg", noDir) === undefined);

  const noManifest = seed({ "only.jpg": "X" });
  check("no manifest -> files are still offered", imageNames(noManifest).join() === "only.jpg");
  check("no manifest -> usage is empty", imageCatalog(noManifest)[0].usage === "");

  const badManifest = mkdtempSync(join(root, "bad-"));
  writeFileSync(join(badManifest, "ok.jpg"), "OK");
  writeFileSync(join(badManifest, "manifest.json"), "{ this is not json");
  check("unparseable manifest -> files still offered", imageNames(badManifest).join() === "ok.jpg");

  const arrayManifest = mkdtempSync(join(root, "arr-"));
  writeFileSync(join(arrayManifest, "ok.jpg"), "OK");
  writeFileSync(join(arrayManifest, "manifest.json"), "[1,2,3]");
  check("manifest that is not an object -> ignored, not crashed", imageNames(arrayManifest).join() === "ok.jpg");

  const ghost = seed({ "real.jpg": "R" }, { "ghost.jpg": "ไม่มีไฟล์นี้", "real.jpg": "มี" });
  check("a manifest entry with no file is NOT offered", !imageNames(ghost).includes("ghost.jpg"));
  check("the file that does exist is offered", imageNames(ghost).join() === "real.jpg");
}

// ---------------------------------------------------------------- 3. prompt text
console.log("=== 3. the prompt block lists filenames the model can answer with ===");
{
  const set = seed(
    { "isla_angry.jpg": "A", "isla_calm.jpg": "B" },
    { "isla_angry.jpg": "คิ้วขมวด — ใช้ตอนโกรธ //group=angry", "isla_calm.jpg": "ยิ้มนุ่ม — ใช้ตอนสงบ" },
  );
  const text = imageListForPrompt(set);
  check("every filename appears", text.includes("isla_angry.jpg") && text.includes("isla_calm.jpg"), text);
  check("usage notes appear", text.includes("ใช้ตอนโกรธ") && text.includes("ใช้ตอนสงบ"), text);
  check("//group never leaks into the prompt", !text.includes("//group"));
  check("one line per image", text.split("\n").length === 2, text.split("\n"));
  check("undocumented image is marked, not silently blank", imageListForPrompt(seed({ "x.jpg": "X" })).includes("(ไม่มีคำอธิบาย)"));
}

// ---------------------------------------------------------------- 4. allowlisting
console.log("=== 4. only catalogued files may be loaded ===");
{
  const set = seed({ "isla_ok.jpg": "PICTURE-BYTES" }, { "isla_ok.jpg": "ok" });
  check("bare filename resolves inside the images dir", resolveEmotionImage("isla_ok.jpg", set) === join(set, "isla_ok.jpg"));
  check("a path prefix the model may add is tolerated", resolveEmotionImage("images/isla_ok.jpg", set) === join(set, "isla_ok.jpg"));
  check("surrounding whitespace ignored", resolveEmotionImage("  isla_ok.jpg  ", set) !== undefined);
  check("unknown name refused", resolveEmotionImage("nope.jpg", set) === undefined);
  check("path traversal refused", resolveEmotionImage("../../etc/passwd", set) === undefined);
  check("absolute path refused", resolveEmotionImage("/etc/passwd", set) === undefined);
  check("a non-image in the same dir refused", resolveEmotionImage("manifest.json", set) === undefined);
  check("undefined name -> undefined", resolveEmotionImage(undefined, set) === undefined);
}

// ---------------------------------------------------------------- 5. bytes
console.log("=== 5. fetchEmotionImage returns bytes or nothing ===");
{
  const set = seed({ "isla_ok.jpg": "PICTURE-BYTES" }, { "isla_ok.jpg": "ok" });
  check("known image returns its bytes", (await fetchEmotionImage("isla_ok.jpg", set))?.toString() === "PICTURE-BYTES");
  check("unknown image returns undefined", (await fetchEmotionImage("nope.jpg", set)) === undefined);
  check("no name returns undefined", (await fetchEmotionImage(undefined, set)) === undefined);

  // Listed at catalog time, then deleted before the send — the reply must still go out.
  const racy = seed({ "isla_gone.jpg": "X" }, { "isla_gone.jpg": "ok" });
  rmSync(join(racy, "isla_gone.jpg"));
  check("a file that vanished between listing and read returns undefined", (await fetchEmotionImage("isla_gone.jpg", racy)) === undefined);

  // A directory with an image extension is unreadable as a file.
  const weird = mkdtempSync(join(root, "weird-"));
  mkdirSync(join(weird, "trap.jpg"));
  check("an unreadable entry returns undefined instead of throwing", (await fetchEmotionImage("trap.jpg", weird)) === undefined);
}

// ---------------------------------------------------------------- 5b. liveness
console.log("=== 5b. a picture added while the process runs is offerable immediately ===");
{
  // The whole point of reading the directory instead of a copied list: no restart, no code edit.
  const set = seed({ "isla_old.jpg": "OLD" }, { "isla_old.jpg": "รูปเดิม" });
  check("starts with one image", imageNames(set).length === 1);
  writeFileSync(join(set, "isla_new.jpg"), "NEW");
  writeFileSync(join(set, "manifest.json"), JSON.stringify({ "isla_old.jpg": "รูปเดิม", "isla_new.jpg": "รูปใหม่ — ใช้ตอนทดสอบ //group=fresh" }));
  check("the new file is in the catalog", imageNames(set).includes("isla_new.jpg"), imageNames(set));
  check("the new file is in the prompt block", imageListForPrompt(set).includes("isla_new.jpg"));
  check("the new file is loadable", (await fetchEmotionImage("isla_new.jpg", set))?.toString() === "NEW");
  rmSync(join(set, "isla_new.jpg"));
  check("a deleted file leaves the catalog", !imageNames(set).includes("isla_new.jpg"));
  check("and refuses to load", (await fetchEmotionImage("isla_new.jpg", set)) === undefined);
}

// ---------------------------------------------------------------- 6. the real repo
console.log("=== 6. the real images/ directory is a valid catalog ===");
{
  const real = imageCatalog();
  check("the repo ships images", real.length > 0, real.length);
  check("every real entry has a filename", real.every((e) => e.name && !e.name.includes("/")));
  check("every real image is documented", real.every((e) => e.usage !== ""), real.filter((e) => !e.usage).map((e) => e.name));
  check("no manifest entry is missing its file", imageNames().every((n) => resolveEmotionImage(n) !== undefined));
  check("resolveEmotionImage defaults to the repo directory", resolveEmotionImage(real[0].name)?.endsWith(join("images", real[0].name)) === true);
  check("the prompt block for the real catalog is non-empty", imageListForPrompt().split("\n").length === real.length);
}

rmSync(root, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed` : `\n✅ ALL PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
