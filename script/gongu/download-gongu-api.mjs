import axios from "axios";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import "dotenv/config";

const SAVE_DIR =
  process.env.GONGU_SAVE_DIR ||
  path.resolve(process.cwd(), "tmp", "gongu-audio");
const TMP_BASE_DIR =
  process.env.TEMP || process.env.TMP || path.resolve(process.cwd(), "tmp");
const TMP_DIR =
  process.env.GONGU_TMP_DIR || path.join(TMP_BASE_DIR, "gongu-download");
const BASE_URL = "https://gongu.copyright.or.kr";
const API_KEY = process.env.GONGU_API_KEY;
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const ERROR_LOG = path.join(SCRIPT_DIR, "download-errors-api.log");

if (!API_KEY) {
  console.error("GONGU_API_KEY가 .env에 없습니다.");
  process.exit(1);
}

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 120000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  },
});

if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .slice(0, 200);
}

function logError(msg) {
  fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// API로 전체 목록 조회
async function fetchAllItems() {
  console.log("API로 전체 목록 조회 중...");
  const res = await http.get("/gongu/wrt/wrtApi/search.json", {
    params: {
      menuNo: "200020",
      pageIndex: 1,
      pageUnit: 3000,
      sortSe: "date",
      depth2ClSn: "10128",
      wrtFileTy: "03",
      apiKey: API_KEY,
    },
  });
  const { resultCnt, resultList } = res.data;
  console.log(`API 총 ${resultCnt}건, 수신 ${resultList.length}건`);
  return resultList;
}

// 파일 다운로드
async function downloadFile(wrtSn, filename) {
  const tmpDest = path.join(TMP_DIR, filename + ".tmp");
  const dest = path.join(SAVE_DIR, filename);

  const res = await http.get("/gongu/wrt/cmmn/wrtFileDownload.do", {
    params: { wrtSn, fileSn: 1 },
    responseType: "stream",
    timeout: 120000,
  });

  const writer = fs.createWriteStream(tmpDest);
  await pipeline(res.data, writer);
  fs.copyFileSync(tmpDest, dest);
  fs.unlinkSync(tmpDest);
}

async function main() {
  console.log("=== 공유마당 자연의소리 동기화 (API) ===\n");
  console.log(`저장 경로: ${SAVE_DIR}`);
  console.log(`임시 경로: ${TMP_DIR}\n`);

  // 1. API에서 전체 목록 조회
  const items = await fetchAllItems();

  // API 기준 파일명 Set
  const apiFilenames = new Map(); // filename → wrtSn
  for (const { wrtSn, orginSj: title } of items) {
    const filename = sanitizeFilename(title) + ".mp3";
    apiFilenames.set(filename, wrtSn);
  }

  // 2. 현재 폴더의 mp3 파일 목록
  const existingFiles = new Set(
    fs.readdirSync(SAVE_DIR).filter((f) => f.endsWith(".mp3")),
  );

  // 3. 비교
  const toDownload = []; // API에 있는데 폴더에 없는 것
  const toDelete = []; // 폴더에 있는데 API에 없는 것

  for (const [filename, wrtSn] of apiFilenames) {
    if (!existingFiles.has(filename)) toDownload.push({ wrtSn, filename });
  }
  for (const filename of existingFiles) {
    if (!apiFilenames.has(filename)) toDelete.push(filename);
  }

  console.log(`현재 폴더: ${existingFiles.size}개`);
  console.log(`다운로드 필요: ${toDownload.length}개`);
  console.log(`삭제 필요 (API에 없음): ${toDelete.length}개\n`);

  // 4. 불필요한 파일 삭제
  if (toDelete.length > 0) {
    console.log("=== 삭제 ===");
    for (const filename of toDelete) {
      fs.unlinkSync(path.join(SAVE_DIR, filename));
      console.log(`  [삭제] ${filename}`);
    }
    console.log();
  }

  // 5. 누락 파일 다운로드
  if (toDownload.length > 0) {
    console.log("=== 다운로드 ===");
    let done = 0,
      failed = 0;
    const failedItems = [];

    for (const { wrtSn, filename } of toDownload) {
      process.stdout.write(
        `  [${done + failed + 1}/${toDownload.length}] ${filename} ... `,
      );
      try {
        await downloadFile(wrtSn, filename);
        console.log("완료");
        done++;
      } catch (err) {
        console.log(`실패 (${err.message})`);
        logError(`wrtSn:${wrtSn} file:${filename} err:${err.message}`);
        failedItems.push({ wrtSn, filename });
        failed++;
      }
      await sleep(300);
    }

    // 실패 재시도
    if (failedItems.length > 0) {
      console.log(`\n=== 실패 ${failedItems.length}건 재시도 ===`);
      for (const { wrtSn, filename } of failedItems) {
        await sleep(2000);
        try {
          await downloadFile(wrtSn, filename);
          console.log(`  [재시도 완료] ${filename}`);
          done++;
          failed--;
        } catch (err) {
          console.log(`  [재시도 실패] ${filename} - ${err.message}`);
          logError(
            `재시도 실패 wrtSn:${wrtSn} file:${filename} err:${err.message}`,
          );
        }
      }
    }
  }

  // 6. 최종 결과
  const finalCount = fs
    .readdirSync(SAVE_DIR)
    .filter((f) => f.endsWith(".mp3")).length;
  console.log("\n=== 동기화 완료 ===");
  console.log(`삭제: ${toDelete.length}건 | 다운로드: ${toDownload.length}건`);
  console.log(`최종 파일 수: ${finalCount} / ${items.length}`);
}

main().catch((err) => {
  console.error("치명적 오류:", err);
  process.exit(1);
});
