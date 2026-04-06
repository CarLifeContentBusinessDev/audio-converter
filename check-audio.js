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
const CONCURRENCY = 5; // 동시 처리 수 (너무 높이면 429 발생 가능성 증가, 너무 낮으면 느려짐)
const PAGE_SIZE = 1000;
const RETRY_COUNT = 2; // 429 발생 시 재시도 횟수
const DELAY_MS = 300; // 요청 사이의 기본 대기 시간 (0.3초)

// 국가(언어)별 검사 대상 설정
const COUNTRY_CONFIGS = {
  ko: { label: "한국", languageFilter: ["ko"] },
  en: { label: "북미", languageFilter: ["en"] },
  de: { label: "독일", languageFilter: ["de"] },
  jp: { label: "일본", languageFilter: ["jp"] },
  all: { label: "전체", languageFilter: null },
};

/**
 * ⏳ 지연 함수
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function selectCountry() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log("\n🌍 검사할 국가를 선택하세요:\n");
    const keys = Object.keys(COUNTRY_CONFIGS);
    keys.forEach((key, i) => {
      console.log(
        `   [${i + 1}] ${key.padEnd(5)} - ${COUNTRY_CONFIGS[key].label}`,
      );
    });
    console.log();

    rl.question("번호 또는 코드 입력 (예: 1 또는 de): ", (answer) => {
      rl.close();
      const trimmed = answer.trim();

      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= keys.length) {
        resolve(keys[num - 1]);
        return;
      }

      if (COUNTRY_CONFIGS[trimmed]) {
        resolve(trimmed);
        return;
      }

      console.error(
        `\n❌ 유효하지 않은 입력: "${trimmed}". 프로그램을 종료합니다.`,
      );
      process.exit(1);
    });
  });
}

function trackMatchesCountry(track, languageFilter) {
  if (!languageFilter) return true;

  const normalizedLanguages = Array.isArray(track.language)
    ? track.language
    : typeof track.language === "string"
      ? [track.language]
      : [];

  return languageFilter.some((lang) => normalizedLanguages.includes(lang));
}

/**
 * 🔍 개선된 URL 체크 함수 (재시도 로직 포함)
 */
async function checkUrl(url, retryLeft = RETRY_COUNT) {
  if (!url) return { ok: false, status: "URL 없음" };

  try {
    // 중복 인코딩 방지: 이미 %가 있으면 그대로 쓰고, 없으면 인코딩
    const encodedUrl = url.includes("%") ? url : encodeURI(url);

    const response = await axios.get(encodedUrl, {
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Range: "bytes=0-0",
        Accept: "*/*",
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
      return checkUrl(url, retryLeft - 1);
    }

    // 200(OK), 206(Partial), 416(Range Error지만 파일은 존재) 모두 정상으로 간주
    const isOk = [200, 206, 416].includes(response.status);
    return { ok: isOk, status: response.status };
  } catch (error) {
    return {
      ok: false,
      status: error.response?.status || error.code || "ERR_NET",
    };
  }
}

async function main() {
  const countryCode = await selectCountry();
  const countryConfig = COUNTRY_CONFIGS[countryCode];

  console.log(`\n🚀 [전수 조사 시작] 대상: ${countryConfig.label}`);

  let allTracks = [];
  let from = 0;
  let hasMore = true;

  // --- 1단계: 데이터 불러오기 ---
  while (hasMore) {
    const { data, error } = await supabase
      .from("episodes")
      .select("id, title, audio_file, audioFile_dubbing, language, is_active")
      .range(from, from + PAGE_SIZE - 1)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("\n❌ Supabase 데이터 로드 실패:", error.message);
      return;
    }

    if (!data || data.length === 0) {
      hasMore = false;
    } else {
      allTracks = [...allTracks, ...data];
      process.stdout.write(`📥 데이터 수집 중: ${allTracks.length}개...\r`);
      if (data.length < PAGE_SIZE) hasMore = false;
      else from += PAGE_SIZE;
    }
  }

  const filteredTracks = allTracks.filter((track) =>
    trackMatchesCountry(track, countryConfig.languageFilter),
  );

  const total = filteredTracks.length;

  if (total === 0) {
    console.log(
      `\nℹ️ 선택한 대상(${countryConfig.label})에 검사할 트랙이 없습니다.`,
    );
    return;
  }

  console.log(
    `\n✅ 총 ${total}개의 트랙 검사를 시작합니다. (동시 작업수: ${CONCURRENCY})\n`,
  );

  // --- 2단계: 오디오 체크 실행 ---
  const deadTracks = [];
  let checkedCount = 0;
  const queue = [...filteredTracks];

  async function worker() {
    while (queue.length > 0) {
      const track = queue.shift();
      if (!track) continue;

      // 메인 오디오 체크
      const mainCheck = await checkUrl(track.audio_file);

      // 서버 부하를 줄이기 위해 짧은 휴식
      await sleep(DELAY_MS);

      // 더빙 오디오 체크
      let dubbingCheck = { ok: true };
      if (track.audioFile_dubbing) {
        dubbingCheck = await checkUrl(track.audioFile_dubbing);
        await sleep(DELAY_MS);
      }

      if (!mainCheck.ok || !dubbingCheck.ok) {
        deadTracks.push({
          id: track.id,
          title: track.title || "제목 없음",
          language: track.language || "N/A",
          mainStatus: mainCheck.status,
          dubbingStatus: track.audioFile_dubbing ? dubbingCheck.status : "-",
          url: track.audio_file,
          isActive: track.is_active,
        });
      }

      checkedCount++;
      if (checkedCount % 10 === 0 || checkedCount === total) {
        const percent = Math.round((checkedCount / total) * 100);
        process.stdout.write(
          `⏳ 진행: ${checkedCount}/${total} (${percent}%) | 찾은 오류: ${deadTracks.length}개\r`,
        );
      }
    }
  }

  // 병렬 작업 시작
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // --- 3단계: 리포트 출력 ---
  console.log("\n\n" + "=".repeat(75));
  console.log("🏁 전수 조사 완료 리포트");
  console.log("=".repeat(75));
  console.log(`🌍 검사 대상: ${countryConfig.label}`);
  console.log(`▶️  전체 대상: ${total}개`);
  console.log(`✅ 정상 트랙: ${total - deadTracks.length}개`);
  console.log(`❌ 재생 불가: ${deadTracks.length}개`);
  console.log("=".repeat(75));

  if (deadTracks.length > 0) {
    console.log("\n[🚨 오류 상세 리스트 (상위 100개)]");
    const tableData = deadTracks.slice(0, 100).map((t) => ({
      ID: t.id,
      제목: t.title.length > 25 ? t.title.substring(0, 25) + "..." : t.title,
      언어: Array.isArray(t.language) ? t.language.join(",") : t.language,
      메인상태: t.mainStatus,
      더빙상태: t.dubbingStatus,
      활성상태: t.isActive ? "True" : "False",
    }));

    console.table(tableData);
  } else {
    console.log("\n🎉 모든 오디오 파일이 정상입니다!");
  }
}

main().catch((err) => console.error("\n💥 치명적 오류 발생:", err));
