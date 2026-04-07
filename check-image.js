/* eslint-disable */
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import "dotenv/config";
import readline from "readline";

// Supabase 설정
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// ✅ 설정 최적화
const CONCURRENCY = 5; // 동시 처리 수 (너무 높으면 429 발생 가능성 증가, 너무 낮으면 느려짐)
const PAGE_SIZE = 1000;
const RETRY_COUNT = 2; // 429 발생 시 재시도 횟수
const DELAY_MS = 300; // 요청 사이의 기본 대기 시간 (0.3초)

// 테이블별 이미지 필드 설정
const TABLE_CONFIGS = {
  broadcastings: {
    label: "Broadcastings",
    imageFields: ["img_url"],
  },
  categories: {
    label: "Categories",
    imageFields: ["img_url", "en_img_url", "de_img_url", "jp_img_url"],
  },
  episodes: {
    label: "Episodes",
    imageFields: ["img_url"],
  },
  programs: {
    label: "Programs",
    imageFields: ["img_url"],
  },
  series: {
    label: "Series",
    imageFields: ["img_url"],
  },
  themes: {
    label: "Themes",
    imageFields: ["img_url"],
  },
};

/**
 * ⏳ 지연 함수
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveDisplayField(tableName) {
  const candidates = ["title", "name"];

  for (const field of candidates) {
    const { error } = await supabase
      .from(tableName)
      .select(`id, ${field}`)
      .limit(1);
    if (!error) {
      return field;
    }
  }

  return null;
}

async function selectTable() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log("\n📊 검사할 테이블을 선택하세요:\n");
    const keys = Object.keys(TABLE_CONFIGS);
    console.log("   [0] 전체 테이블 검사");
    keys.forEach((key, i) => {
      const fields = TABLE_CONFIGS[key].imageFields.join(", ");
      console.log(
        `   [${i + 1}] ${key.padEnd(15)} - ${TABLE_CONFIGS[key].label} (${fields})`,
      );
    });
    console.log();

    rl.question(
      "번호 또는 테이블명 입력 (예: 0, 1 또는 episodes): ",
      (answer) => {
        rl.close();
        const trimmed = answer.trim();

        if (trimmed === "0" || trimmed.toLowerCase() === "all") {
          resolve("__ALL__");
          return;
        }

        const num = parseInt(trimmed, 10);
        if (!isNaN(num) && num >= 1 && num <= keys.length) {
          resolve(keys[num - 1]);
          return;
        }

        if (TABLE_CONFIGS[trimmed]) {
          resolve(trimmed);
          return;
        }

        console.error(
          `\n❌ 유효하지 않은 입력: "${trimmed}". 프로그램을 종료합니다.`,
        );
        process.exit(1);
      },
    );
  });
}

async function selectIncludeNull() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log("\n❓ null(빈) 값을 포함시키겠습니까?\n");
    console.log(`   [1] 예   - null 값도 정상으로 간주`);
    console.log(`   [2] 아니오 - null 값을 오류로 간주`);
    console.log();

    rl.question("번호 입력 (기본값: 2): ", (answer) => {
      rl.close();
      const trimmed = answer.trim();

      if (trimmed === "" || trimmed === "2") {
        resolve(false);
        return;
      }

      if (trimmed === "1") {
        resolve(true);
        return;
      }

      console.error(
        `\n❌ 유효하지 않은 입력: "${trimmed}". 기본값(아니오)으로 진행합니다.`,
      );
      resolve(false);
    });
  });
}

/**
 * 🔍 이미지 URL 체크 함수 (재시도 로직 포함)
 */
async function checkImageUrl(url, retryLeft = RETRY_COUNT) {
  if (!url) return { ok: false, status: "URL 없음", contentType: "-" };

  try {
    // 중복 인코딩 방지: 이미 %가 있으면 그대로 쓰고, 없으면 인코딩
    const encodedUrl = url.includes("%") ? url : encodeURI(url);

    const response = await axios.get(encodedUrl, {
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Range: "bytes=0-0",
        Accept: "image/*",
      },
      validateStatus: false,
    });

    // 429 Too Many Requests 대응
    if (response.status === 429 && retryLeft > 0) {
      const waitTime = (RETRY_COUNT - retryLeft + 1) * 3000; // 실패할수록 더 오래 대기 (3초, 6초...)
      process.stdout.write(
        `\n⚠️  429 감지! ${waitTime}ms 후 재시도 합니다... (남은 횟수: ${retryLeft})\n`,
      );
      await sleep(waitTime);
      return checkImageUrl(url, retryLeft - 1);
    }

    // Content-Type 확인 (webp, png, jpeg, gif 등 지원)
    const contentType = response.headers["content-type"] || "-";
    const isValidImageType =
      contentType.includes("image/webp") ||
      contentType.includes("image/png") ||
      contentType.includes("image/jpeg") ||
      contentType.includes("image/jpg") ||
      contentType.includes("image/gif") ||
      contentType.includes("image/svg") ||
      contentType.includes("image/");

    // 200(OK), 206(Partial), 416(Range Error지만 파일은 존재) 모두 정상으로 간주
    // 단, Content-Type이 유효한 이미지 형식이어야 함
    const isOk = [200, 206, 416].includes(response.status) && isValidImageType;

    // Content-Type에서 파일 형식 추출 (예: image/webp -> webp)
    let imageFormat = "-";
    if (isValidImageType) {
      const match = contentType.match(/image\/([a-z+]+)/i);
      if (match) {
        imageFormat = match[1].replace("+", "");
      }
    }

    return {
      ok: isOk,
      status: response.status,
      contentType: imageFormat,
    };
  } catch (error) {
    return {
      ok: false,
      status: error.response?.status || error.code || "ERR_NET",
      contentType: "-",
    };
  }
}

async function inspectTable(tableName, includeNull) {
  const tableConfig = TABLE_CONFIGS[tableName];
  const displayField = await resolveDisplayField(tableName);

  console.log(`\n🚀 [이미지 전수 조사 시작] 테이블: ${tableConfig.label}`);
  console.log(`📋 검사 필드: ${tableConfig.imageFields.join(", ")}`);
  console.log(
    `🧾 제목 표시 컬럼: ${displayField ? displayField : "없음(미표시)"}`,
  );

  let allItems = [];
  let from = 0;
  let hasMore = true;

  // --- 1단계: 데이터 불러오기 ---
  const selectFields = ["id", ...tableConfig.imageFields];
  if (displayField) {
    selectFields.push(displayField);
  }

  while (hasMore) {
    const { data, error } = await supabase
      .from(tableName)
      .select(selectFields.join(", "))
      .range(from, from + PAGE_SIZE - 1)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("\n❌ Supabase 데이터 로드 실패:", error.message);
      return;
    }

    if (!data || data.length === 0) {
      hasMore = false;
    } else {
      allItems = [...allItems, ...data];
      process.stdout.write(`📥 데이터 수집 중: ${allItems.length}개...\r`);
      if (data.length < PAGE_SIZE) hasMore = false;
      else from += PAGE_SIZE;
    }
  }

  const total = allItems.length;

  if (total === 0) {
    console.log(
      `\nℹ️ 선택한 테이블(${tableConfig.label})에 데이터가 없습니다.`,
    );
    return {
      tableName,
      tableLabel: tableConfig.label,
      displayField,
      imageFields: tableConfig.imageFields,
      total: 0,
      deadItems: [],
    };
  }

  console.log(
    `\n✅ 총 ${total}개 항목의 이미지 검사를 시작합니다. (동시 작업수: ${CONCURRENCY})\n`,
  );

  // --- 2단계: 이미지 체크 실행 ---
  const deadItems = [];
  let checkedCount = 0;
  const queue = [...allItems];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;

      const imageChecks = {};
      const missingFields = [];

      // 각 이미지 필드 체크
      for (const field of tableConfig.imageFields) {
        if (item[field]) {
          imageChecks[field] = await checkImageUrl(item[field]);
          await sleep(DELAY_MS);
        } else {
          missingFields.push(field);
        }
      }

      // 오류가 있거나 필드가 누락된 경우 기록
      const hasAnyError = Object.values(imageChecks).some((check) => !check.ok);

      // includeNull이 false면 null이 있어도 오류로 표시
      // includeNull이 true면 null이 있어도 무시
      if (hasAnyError || (!includeNull && missingFields.length > 0)) {
        const record = {
          table: tableName,
          tableLabel: tableConfig.label,
          id: item.id,
          title: displayField ? (item[displayField] ?? "-") : "-",
          imageFields: tableConfig.imageFields,
        };

        // 각 필드별 상태 추가
        for (const field of tableConfig.imageFields) {
          record[`${field}_status`] = imageChecks[field]?.status || "-";
          record[`${field}_type`] = imageChecks[field]?.contentType || "-";
        }

        record.missing =
          missingFields.length > 0 ? missingFields.join(", ") : "-";
        deadItems.push(record);
      }

      checkedCount++;
      if (checkedCount % 10 === 0 || checkedCount === total) {
        const percent = Math.round((checkedCount / total) * 100);
        const lineEnd = checkedCount === total ? "\n" : "\r";
        process.stdout.write(
          `⏳ 진행: ${checkedCount}/${total} (${percent}%) | 찾은 오류: ${deadItems.length}개${lineEnd}`,
        );
      }
    }
  }

  // 병렬 작업 시작
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // --- 3단계: 리포트 출력 ---
  return {
    tableName,
    tableLabel: tableConfig.label,
    displayField,
    imageFields: tableConfig.imageFields,
    total,
    deadItems,
  };
}

function printDetailRows(items, includeTable = false) {
  const tableData = items.slice(0, 50).map((item) => {
    const titleText = String(item.title ?? "-");
    const row = {
      ID: item.id,
      제목: titleText.length > 28 ? `${titleText.slice(0, 28)}...` : titleText,
    };

    if (includeTable) {
      row["테이블"] = item.table;
    }

    for (const field of item.imageFields) {
      const status = item[`${field}_status`];
      const type = item[`${field}_type`];
      if (status !== "-" || type !== "-") {
        row[field] = `${status !== "-" ? status : "OK"}(${type})`;
      } else {
        row[field] = "정상";
      }
    }

    row["누락"] = item.missing;
    return row;
  });

  console.table(tableData);
}

async function main() {
  const selectedTable = await selectTable();
  const includeNull = await selectIncludeNull();
  const allTableNames = Object.keys(TABLE_CONFIGS);
  const targetTables =
    selectedTable === "__ALL__" ? allTableNames : [selectedTable];

  console.log(
    `\n${includeNull ? "✅" : "❌"} Null 값 포함: ${includeNull ? "예" : "아니오"}`,
  );
  console.log(
    `🎯 검사 대상: ${
      selectedTable === "__ALL__"
        ? `전체(${targetTables.length}개 테이블)`
        : selectedTable
    }`,
  );

  const results = [];
  for (const tableName of targetTables) {
    const result = await inspectTable(tableName, includeNull);
    results.push(result);
  }

  const totalCount = results.reduce((sum, r) => sum + r.total, 0);
  const allDeadItems = results.flatMap((r) => r.deadItems);
  const isAllMode = selectedTable === "__ALL__";

  console.log("\n\n" + "=".repeat(100));
  console.log("🏁 이미지 전수 조사 완료 리포트");
  console.log("=".repeat(100));
  console.log(`📊 검사 모드: ${isAllMode ? "전체 테이블" : "단일 테이블"}`);
  console.log(`🔍 Null 값 포함: ${includeNull ? "예" : "아니오"}`);
  console.log(`▶️  전체 항목: ${totalCount}개`);
  console.log(`✅ 정상 항목: ${totalCount - allDeadItems.length}개`);
  console.log(`❌ 오류 발견: ${allDeadItems.length}개`);
  console.log("=".repeat(100));

  if (isAllMode) {
    console.log("\n[📚 테이블별 집계]");
    const summaryRows = results.map((r) => ({
      테이블: r.tableName,
      라벨: r.tableLabel,
      전체: r.total,
      정상: r.total - r.deadItems.length,
      오류: r.deadItems.length,
    }));
    console.table(summaryRows);
  } else if (results[0]) {
    console.log(`📌 검사 테이블: ${results[0].tableLabel}`);
    console.log(
      `🧾 제목 표시 컬럼: ${
        results[0].displayField ? results[0].displayField : "없음(미표시)"
      }`,
    );
    console.log(`📋 검사 필드: ${results[0].imageFields.join(", ")}`);
  }

  if (allDeadItems.length > 0) {
    console.log(
      `\n[🚨 오류 상세 리스트 (상위 50개)${isAllMode ? " - 테이블 포함" : ""}]`,
    );
    printDetailRows(allDeadItems, isAllMode);
  } else {
    console.log("\n🎉 모든 이미지 파일이 정상입니다!");
  }
}

main().catch((err) => console.error("\n💥 치명적 오류 발생:", err));
