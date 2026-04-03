/* eslint-disable */

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import { exec } from "child_process";
import "dotenv/config";
import fs from "fs";
import readline from "readline";
import { Readable } from "stream";
import { promisify } from "util";

const execAsync = promisify(exec);

// ✅ 국가 코드별 설정
const COUNTRY_CONFIGS = {
  ko: {
    label: "한국",
    r2Prefix: "episodes-audio/m4a",
    languageFilter: ["ko"],
  },
  en: {
    label: "북미",
    r2Prefix: "en-episodes-audio/m4a",
    languageFilter: ["en"],
  },
  de: {
    label: "독일",
    r2Prefix: "de-episodes-audio/m4a",
    languageFilter: ["de"],
  },
  jp: {
    label: "일본",
    r2Prefix: "jp_episodes-audio/m4a",
    languageFilter: ["jp"],
  },
  all: {
    label: "전체",
    r2Prefix: null,
    languageFilter: null,
  },
};

// ✅ 압축 및 로딩 최적화 설정
const OPTIMIZATION = {
  bitrate: "48k", // 기존 40k와 유사한 수준 (음성 위주면 48k가 표준적입니다)
  sampleRate: "24000", // 낮은 비트레이트에 맞게 샘플링 레이트도 낮춰야 음질이 깨지지 않습니다.
  fastStart: true, // 🚀 핵심: 로딩 속도를 결정하는 옵션
};

async function selectCountry() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log("\n🌍 변환할 국가를 선택하세요:\n");
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

async function streamToFile(stream, filePath) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    Readable.from(stream).pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
}

async function convertTrack(track, config) {
  let r2Prefix = config.r2Prefix;
  if (!r2Prefix) {
    const lang = Array.isArray(track.language)
      ? track.language[0]
      : track.language;
    const langConfig = COUNTRY_CONFIGS[lang];
    r2Prefix = langConfig ? langConfig.r2Prefix : `${lang}-episodes-audio/m4a`;
  }

  const tmpDir = `./tmp/${track.id}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  const mp3Path = `${tmpDir}/input.mp3`;
  const m4aPath = `${tmpDir}/output.m4a`;
  const dubbingMp3Path = `${tmpDir}/dubbing_input.mp3`;
  const dubbingM4aPath = `${tmpDir}/dubbing_output.m4a`;

  try {
    const urlObj = new URL(track.audio_file);
    const key = decodeURIComponent(urlObj.pathname.slice(1));
    console.log(`⏳ [${track.id}] 원본 다운로드 중...`);

    const { Body } = await r2.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }),
    );
    await streamToFile(Body, mp3Path);

    // ✅ 변환 명령어 구성 (용량 압축 + FastStart 적용)
    console.log(`⏳ [${track.id}] 최적화 변환 중... (${OPTIMIZATION.bitrate})`);
    const ffmpegCmd = `ffmpeg -y -i "${mp3Path}" -vn -c:a aac -b:a 48k -ar 24000 -ac 1 -movflags +faststart "${m4aPath}"`;
    await execAsync(ffmpegCmd);

    console.log(`⏳ [${track.id}] 업로드 중...`);
    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: `${r2Prefix}/${track.id}.m4a`,
        Body: fs.readFileSync(m4aPath),
        ContentType: "audio/mp4",
      }),
    );

    const newUrl = `${process.env.R2_PUBLIC_URL}/${r2Prefix}/${track.id}.m4a`;
    const updateData = { audio_file: newUrl };

    // ✅ 더빙 파일 처리
    if (track.audioFile_dubbing) {
      const dubbingUrlObj = new URL(track.audioFile_dubbing);
      const dubbingKey = decodeURIComponent(dubbingUrlObj.pathname.slice(1));

      console.log(`⏳ [${track.id}] 더빙 다운로드 중...`);
      const { Body: dubbingBody } = await r2.send(
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: dubbingKey,
        }),
      );
      await streamToFile(dubbingBody, dubbingMp3Path);

      console.log(`⏳ [${track.id}] 더빙 최적화 변환 중...`);
      const dubbingFfmpegCmd = `ffmpeg -y -i "${dubbingMp3Path}" -vn -c:a aac -b:a ${OPTIMIZATION.bitrate} -ar ${OPTIMIZATION.sampleRate} -movflags +faststart "${dubbingM4aPath}"`;
      await execAsync(dubbingFfmpegCmd);

      console.log(`⏳ [${track.id}] 더빙 업로드 중...`);
      await r2.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: `${r2Prefix}/${track.id}_dubbing.m4a`,
          Body: fs.readFileSync(dubbingM4aPath),
          ContentType: "audio/mp4",
        }),
      );

      updateData.audioFile_dubbing = `${process.env.R2_PUBLIC_URL}/${r2Prefix}/${track.id}_dubbing.m4a`;
    }

    await supabase.from("episodes").update(updateData).eq("id", track.id);
    console.log(`✅ [${track.id}] 변환 완료`);
  } catch (e) {
    console.error(`❌ [${track.id}] 실패:`, e.message);
    throw e;
  } finally {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  }
}

async function main() {
  const countryCode = await selectCountry();
  const config = COUNTRY_CONFIGS[countryCode];

  console.log(
    `\n✅ 설정 적용: ${config.label} | 압축률: ${OPTIMIZATION.bitrate}\n`,
  );

  // 변환 범위 선택
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  function ask(question) {
    return new Promise((resolve) =>
      rl.question(question, (ans) => resolve(ans.trim())),
    );
  }

  console.log("\n[1] 전체 변환 (mp3만)");
  console.log("[2] 특정 에피소드 ID 입력");
  const mode = await ask("\n번호를 선택하세요 (1 또는 2): ");

  let query = supabase
    .from("episodes")
    .select("id, audio_file, audioFile_dubbing, language");

  if (mode === "1") {
    // 전체 변환: audio_file 또는 audioFile_dubbing이 .mp3로 끝나는 레코드
    query = query.or("audio_file.like.%.mp3,audioFile_dubbing.like.%.mp3");
    if (config.languageFilter) {
      query = query.contains("language", config.languageFilter);
    }
  } else if (mode === "2") {
    // 특정 에피소드 ID 입력
    const idInput = await ask("\n에피소드 ID(쉼표로 구분, 예: 254,318): ");
    const ids = idInput
      .split(",")
      .map((v) => parseInt(v.trim(), 10))
      .filter((v) => !isNaN(v));
    if (ids.length === 0) {
      console.error("유효한 ID를 입력하세요.");
      process.exit(1);
    }
    query = query.in("id", ids);
  } else {
    console.error("잘못된 선택입니다. 프로그램을 종료합니다.");
    process.exit(1);
  }

  rl.close();

  const { data: tracks, error } = await query;

  if (error) {
    console.error("Supabase 에러:", error);
    return;
  }

  if (!tracks || tracks.length === 0) {
    console.log("변환할 트랙이 없습니다.");
    return;
  }

  const total = tracks.length;
  let done = 0;
  let failed = 0;
  console.log(`총 ${total}개 최적화 작업 시작\n`);

  const CONCURRENCY = 3; // 네트워크 부하를 고려해 동시 작업수 조정
  const queue = [...tracks];

  async function worker() {
    while (queue.length > 0) {
      const track = queue.shift();
      try {
        await convertTrack(track, config);
        done++;
      } catch {
        failed++;
      }

      const percent = Math.round(((done + failed) / total) * 100);
      console.log(
        `📊 진행 상황: ${done + failed}/${total} (${percent}%) | ✅ 성공: ${done} | ❌ 실패: ${failed}\n`,
      );
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log("🎉 모든 최적화 작업이 완료되었습니다.");
}

main();
