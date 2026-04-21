/* eslint-disable */

import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import fs from "fs";
import readline from "readline";

// 설정: 검사할 R2 폴더와 Supabase 참조 테이블/컬럼

// 검사할 R2 폴더 (prefix). 하위 경로 전체를 재귀 탐색합니다.
const TARGET_PREFIXES = [
  // 오디오 파일
  // "episodes-audio",
  // "en-episodes-audio",
  // "de-episodes-audio",
  // "jp_episodes-audio",
  // "gb-episodes-audio",
  // "in-episodes-audio",
  // "ko-episodes-audio",
  // "uk-episodes-audio",
  // 이미지 파일
  "images",
  "de_images",
  "eng_images",
  "gb_images",
  "in_images",
  "jp_images",
  "uk_images",
  // 기타
  "series-1",
  "test",
  "uk",
];

// Supabase에서 R2 URL을 참조하는 테이블/컬럼 목록
// titleColumn : 목록 출력 시 보여줄 제목 컬럼명 (없으면 null)
// r2Prefixes  : 이 테이블의 파일이 저장되는 R2 폴더 (역조회에 사용)
//               비워두면 해당 테이블은 역조회 대상에서 제외
const SUPABASE_REFS = [
  {
    table: "broadcastings",
    columns: ["img_url"],
    titleColumn: "title",
    r2Prefixes: [],
  },
  {
    table: "categories",
    columns: ["img_url", "en_img_url", "de_img_url", "jp_img_url"],
    titleColumn: "name",
    r2Prefixes: [],
  },
  {
    table: "episodes",
    columns: ["img_url", "audio_file", "audioFile_dubbing"],
    titleColumn: "title",
    r2Prefixes: [
      "episodes-audio",
      "en-episodes-audio",
      "de-episodes-audio",
      "jp_episodes-audio",
      "gb-episodes-audio",
      "in-episodes-audio",
      "ko-episodes-audio",
      "uk-episodes-audio",
    ],
  },
  {
    table: "programs",
    columns: ["img_url"],
    titleColumn: "title",
    r2Prefixes: [],
  },
  {
    table: "series",
    columns: ["img_url"],
    titleColumn: "title",
    r2Prefixes: [],
  },
  {
    table: "themes",
    columns: ["img_url"],
    titleColumn: "name",
    r2Prefixes: [],
  },
];

const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL.replace(/\/$/, "");

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function getTopLevelPrefix(key) {
  return key.split("/")[0] ?? "";
}

function getPrefixSortIndex(prefix) {
  const index = TARGET_PREFIXES.indexOf(prefix);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function groupFilesByPrefix(files) {
  const groupedMap = new Map();

  for (const file of files) {
    const prefix = getTopLevelPrefix(file.key);
    if (!groupedMap.has(prefix)) {
      groupedMap.set(prefix, []);
    }
    groupedMap.get(prefix).push(file);
  }

  return [...groupedMap.entries()]
    .sort((a, b) => {
      const orderDiff = getPrefixSortIndex(a[0]) - getPrefixSortIndex(b[0]);
      if (orderDiff !== 0) return orderDiff;
      return a[0].localeCompare(b[0], "en");
    })
    .map(([prefix, filesInGroup]) => {
      const sortedFiles = [...filesInGroup].sort((a, b) => b.size - a.size);
      const totalBytes = sortedFiles.reduce((sum, file) => sum + file.size, 0);

      return {
        prefix,
        totalFiles: sortedFiles.length,
        totalBytes,
        totalFormatted: formatBytes(totalBytes),
        files: sortedFiles,
      };
    });
}

function urlToR2Key(url) {
  if (!url || typeof url !== "string") return null;
  if (!url.startsWith(R2_PUBLIC_URL)) return null;
  const raw = url.slice(R2_PUBLIC_URL.length + 1); // +1 for leading slash
  // Supabase URL은 인코딩된 상태(%20 등)이지만 R2 key는 디코딩된 상태 → 맞춰줌
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// R2에서 prefix 하위 모든 파일 목록 가져오기 (pagination 처리)
async function listR2Files(prefix) {
  const files = [];
  let continuationToken = undefined;

  process.stdout.write(`  [R2] "${prefix}" 탐색 중...`);

  do {
    const command = new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });

    const response = await r2.send(command);

    if (response.Contents) {
      for (const obj of response.Contents) {
        files.push({ key: obj.Key, size: obj.Size ?? 0 });
      }
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  console.log(` ${files.length}개 파일 발견`);
  return files;
}

// Supabase에서 모든 참조 URL 수집
// 반환: { keySet, tableDataMap }
//   keySet      : R2에서 실제 참조 중인 key 집합
//   tableDataMap: table명 → { idMap: Map<id, { title }>, ref }
async function collectSupabaseData() {
  const keySet = new Set();
  const tableDataMap = new Map();

  const PAGE_SIZE = 1000;

  for (const ref of SUPABASE_REFS) {
    process.stdout.write(
      `  [Supabase] ${ref.table} (${ref.columns.join(", ")}) 조회 중...`,
    );

    // id, titleColumn, URL 컬럼 모두 조회
    const selectCols = new Set(["id", ...ref.columns]);
    if (ref.titleColumn) selectCols.add(ref.titleColumn);
    const selectStr = [...selectCols].join(", ");

    // Supabase는 기본 최대 1000행 → 페이지네이션으로 전체 수집
    const idMap = new Map();
    let count = 0;
    let totalRows = 0;
    let from = 0;

    while (true) {
      const { data, error } = await supabase
        .from(ref.table)
        .select(selectStr)
        .range(from, from + PAGE_SIZE - 1);

      if (error) {
        console.log(` ❌ 오류: ${error.message}`);
        break;
      }

      for (const row of data ?? []) {
        for (const col of ref.columns) {
          const key = urlToR2Key(row[col]);
          if (key) {
            keySet.add(key);
            count++;
          }
        }
        idMap.set(row.id, {
          title: ref.titleColumn ? row[ref.titleColumn] : null,
        });
      }

      totalRows += data?.length ?? 0;
      if (!data || data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    tableDataMap.set(ref.table, { idMap, ref });
    console.log(` ${totalRows}행 / ${count}개 URL 수집`);
  }

  return { keySet, tableDataMap };
}

// 고아 파일의 R2 key에서 Supabase 정보를 역조회
// 파일명에서 숫자 ID를 추출하고 r2Prefixes로 테이블을 매핑하여 검색
// 예: "episodes-audio/m4a/123.m4a" → episodes #123 「제목」(DB에 있으나 URL 변경됨)
//     "episodes-audio/m4a/456.m4a" → episodes #456 (레코드 삭제됨)
function lookupOrphanInfo(key, tableDataMap) {
  const filename = key.split("/").pop() ?? "";
  const idMatch = filename.match(/^(\d+)/);
  if (!idMatch) return null;

  const fileId = parseInt(idMatch[1], 10);

  for (const [table, { idMap, ref }] of tableDataMap) {
    if (!ref.r2Prefixes?.length) continue;
    const prefixMatched = ref.r2Prefixes.some(
      (p) => key.startsWith(p + "/") || key === p,
    );
    if (!prefixMatched) continue;

    const record = idMap.get(fileId);
    const titlePart = record?.title ? ` 「${record.title}」` : "";

    if (record) {
      return `${table} #${fileId}${titlePart} (DB에 있으나 URL 변경됨)`;
    } else {
      return `${table} #${fileId} (레코드 삭제됨)`;
    }
  }

  return null;
}

// 배치 삭제 (R2는 최대 1000개 단위)
async function deleteFiles(files) {
  const BATCH_SIZE = 1000;
  let deleted = 0;

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const command = new DeleteObjectsCommand({
      Bucket: process.env.R2_BUCKET,
      Delete: {
        Objects: batch.map((f) => ({ Key: f.key })),
        Quiet: false,
      },
    });

    const response = await r2.send(command);
    deleted += response.Deleted?.length ?? 0;

    if (response.Errors?.length > 0) {
      console.error(`  ⚠️  삭제 실패 항목:`);
      for (const err of response.Errors) {
        console.error(`    - ${err.Key}: ${err.Message}`);
      }
    }

    const progress = Math.min(i + BATCH_SIZE, files.length);
    console.log(`  삭제 진행: ${progress}/${files.length}`);
  }

  return deleted;
}

function saveLog(orphans) {
  const date = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const logPath = `./cleanup-log-${date}.json`;

  // 테이블별 요약 집계
  const summaryMap = {};
  for (const f of orphans) {
    const label = f.supabaseInfo ?? "알 수 없음 (ID 없는 파일)";
    // "episodes #123 「...」 (레코드 삭제됨)" → "episodes (레코드 삭제됨)" 형태로 그룹핑
    const groupMatch = label.match(/^(\w+)\s#\d+.*\((.+)\)$/);
    const group = groupMatch ? `${groupMatch[1]} (${groupMatch[2]})` : label;
    summaryMap[group] = (summaryMap[group] ?? 0) + 1;
  }

  const totalBytes = orphans.reduce((sum, f) => sum + f.size, 0);
  const groupedFiles = groupFilesByPrefix(orphans);
  const log = {
    timestamp: new Date().toISOString(),
    totalFiles: orphans.length,
    totalBytes,
    totalFormatted: formatBytes(totalBytes),
    summary: {
      _description: "각 카테고리별 삭제 후보 파일 수",
      ...summaryMap,
    },
    files: orphans.map((f) => ({
      key: f.key,
      size: f.size,
      sizeFormatted: formatBytes(f.size),
      supabaseInfo: f.supabaseInfo ?? null,
    })),
    fileGroups: groupedFiles,
  };
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf-8");
  return logPath;
}

async function confirm(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });
}

async function main() {
  console.log("\n============================");
  console.log("  R2 고아 파일 정리 도구");
  console.log("============================\n");

  // 1. R2 파일 목록 수집
  console.log("[1단계] R2 파일 목록 수집\n");
  const allR2Files = [];
  for (const prefix of TARGET_PREFIXES) {
    const files = await listR2Files(prefix);
    allR2Files.push(...files);
  }
  console.log(`\n  → R2 전체 파일: ${allR2Files.length}개\n`);

  // 2. Supabase 참조 key 수집 + 역조회용 테이블 데이터 구성
  console.log("[2단계] Supabase 참조 URL 수집\n");
  const { keySet: supabaseKeys, tableDataMap } = await collectSupabaseData();
  console.log(`\n  → Supabase 참조 key: ${supabaseKeys.size}개\n`);

  // 3. 고아 파일 추출 + 역조회 + 크기 큰 순 정렬
  const orphans = allR2Files
    .filter((f) => !supabaseKeys.has(f.key))
    .map((f) => ({ ...f, supabaseInfo: lookupOrphanInfo(f.key, tableDataMap) }))
    .sort((a, b) => b.size - a.size);

  if (orphans.length === 0) {
    console.log("✅ 고아 파일이 없습니다. R2가 깨끗합니다!\n");
    return;
  }

  // 4. 결과 출력
  const totalBytes = orphans.reduce((sum, f) => sum + f.size, 0);
  const groupedFiles = groupFilesByPrefix(orphans);

  console.log("[3단계] 삭제 후보 목록\n");

  for (const group of groupedFiles) {
    console.log(
      `  [${group.prefix}] ${group.totalFiles}개 | ${group.totalFormatted}`,
    );

    group.files.forEach((f, i) => {
      const num = String(i + 1).padStart(3);
      const size = formatBytes(f.size).padStart(9);
      const info = f.supabaseInfo ? `\n            └─ ${f.supabaseInfo}` : "";
      console.log(`    ${num}  ${size}   ${f.key}${info}`);
    });

    console.log();
  }

  console.log();
  console.log(
    `  총 ${orphans.length}개 파일 | 절약 예상 용량: ${formatBytes(totalBytes)}\n`,
  );

  // 5. 로그 저장 안내 및 삭제 확인
  const logPath = saveLog(orphans);
  console.log(`  📄 삭제 후보 목록이 저장되었습니다: ${logPath}\n`);

  const answer = await confirm("삭제하시겠습니까? (yes/no): ");

  if (answer !== "yes") {
    console.log("\n취소되었습니다. 아무것도 삭제하지 않았습니다.\n");
    return;
  }

  // 6. 삭제 실행
  console.log("\n[4단계] 삭제 실행 중...\n");
  const deleted = await deleteFiles(orphans);

  console.log(
    `\n✅ 완료! ${deleted}개 파일 삭제 (${formatBytes(totalBytes)} 절약)\n`,
  );
}

main().catch((e) => {
  console.error("\n❌ 오류 발생:", e.message);
  process.exit(1);
});
