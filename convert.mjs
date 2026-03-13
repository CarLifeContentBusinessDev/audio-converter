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

// ✅ 국가 코드별 설정 (추가/수정 여기서만!)
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
    r2Prefix: null, // 국가별로 동적 처리
    languageFilter: null, // 필터 없음
  },
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
        `  [${i + 1}] ${key.padEnd(5)} - ${COUNTRY_CONFIGS[key].label}`,
      );
    });
    console.log();

    rl.question("번호 또는 코드 입력 (예: 1 또는 de): ", (answer) => {
      rl.close();
      const trimmed = answer.trim();

      // 번호로 선택
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= keys.length) {
        resolve(keys[num - 1]);
        return;
      }

      // 코드로 선택
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
  // "all" 모드일 때 트랙의 language 필드에서 prefix 동적 결정
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
    console.log(`⏳ [${track.id}] 다운로드 중...`);

    const { Body } = await r2.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }),
    );
    await streamToFile(Body, mp3Path);

    // 원본 mp3 비트레이트 추출
    console.log(`⏳ [${track.id}] 비트레이트 확인 중...`);
    const bitrateResult = await execAsync(
      `ffprobe -v error -select_streams a:0 -show_entries stream=bit_rate -of default=noprint_wrappers=1:nokey=1 "${mp3Path}"`,
    );
    let bitrate = parseInt(bitrateResult.stdout.trim(), 10);
    if (isNaN(bitrate) || bitrate < 32000) {
      bitrate = 128000; // fallback: 128kbps
    }
    const bitrateKbps = Math.round(bitrate / 1000);
    console.log(`⏳ [${track.id}] 변환 중... (비트레이트: ${bitrateKbps}kbps)`);
    await execAsync(
      `ffmpeg -y -i "${mp3Path}" -vn -c:a aac -b:a ${bitrateKbps}k "${m4aPath}"`,
    );

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

      // 더빙 mp3 비트레이트 추출
      console.log(`⏳ [${track.id}] 더빙 비트레이트 확인 중...`);
      const dubbingBitrateResult = await execAsync(
        `ffprobe -v error -select_streams a:0 -show_entries stream=bit_rate -of default=noprint_wrappers=1:nokey=1 "${dubbingMp3Path}"`,
      );
      let dubbingBitrate = parseInt(dubbingBitrateResult.stdout.trim(), 10);
      if (isNaN(dubbingBitrate) || dubbingBitrate < 32000) {
        dubbingBitrate = 128000;
      }
      const dubbingBitrateKbps = Math.round(dubbingBitrate / 1000);
      console.log(
        `⏳ [${track.id}] 더빙 변환 중... (비트레이트: ${dubbingBitrateKbps}kbps)`,
      );
      await execAsync(
        `ffmpeg -y -i "${dubbingMp3Path}" -vn -c:a aac -b:a ${dubbingBitrateKbps}k "${dubbingM4aPath}"`,
      );

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
    console.log(`✅ [${track.id}] 성공`);
  } catch (e) {
    console.error(`❌ [${track.id}] 실패:`, e.message);
    throw e;
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
}

async function main() {
  const countryCode = await selectCountry();
  const config = COUNTRY_CONFIGS[countryCode];

  console.log(`\n✅ 선택된 언어: ${config.label} (${countryCode})\n`);

  // Supabase 쿼리 구성
  let query = supabase
    .from("episodes")
    .select("id, audio_file, audioFile_dubbing, language")
    .or("audio_file.like.%.mp3,audioFile_dubbing.like.%.mp3");

  if (config.languageFilter) {
    query = query.contains("language", config.languageFilter);
  }

  // let query = supabase
  //   .from("episodes")
  //   .select("id, audio_file, audioFile_dubbing, language")
  //   .eq("id", 1756); // 특정 id만 조회

  const { data: tracks, error } = await query;

  if (error) {
    console.error("Supabase 에러:", error);
    return;
  }

  if (!tracks || tracks.length === 0) {
    console.log(
      "변환할 트랙이 없어요. (이미 전부 완료됐거나 해당 언어 데이터 없음)",
    );
    return;
  }

  const total = tracks.length;
  let done = 0;
  let failed = 0;
  console.log(`총 ${total}개 변환 시작\n`);

  const CONCURRENCY = 5;
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
        `📊 진행률: ${done + failed}/${total} (${percent}%) | ✅ ${done} 완료 | ❌ ${failed} 실패\n`,
      );
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log("🎉 전체 완료");
}

main();
