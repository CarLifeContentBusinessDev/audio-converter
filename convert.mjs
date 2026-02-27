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
import { Readable } from "stream";
import { promisify } from "util";

const execAsync = promisify(exec);

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

async function convertTrack(track) {
  const tmpDir = `./tmp/${track.id}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  const mp3Path = `${tmpDir}/input.mp3`;
  const m4aPath = `${tmpDir}/output.m4a`;
  const dubbingMp3Path = `${tmpDir}/dubbing_input.mp3`;
  const dubbingM4aPath = `${tmpDir}/dubbing_output.m4a`;

  try {
    // 1. R2에서 MP3 다운로드 (key 추출)
    const urlObj = new URL(track.audio_file);
    const key = decodeURIComponent(urlObj.pathname.slice(1));
    console.log(`⏳ [${track.id}] 다운로드 중...`);

    const { Body } = await r2.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }),
    );
    await streamToFile(Body, mp3Path);

    // 2. MP3 → M4A 변환 (-vn: 커버 이미지 등 비디오 스트림 무시)
    console.log(`⏳ [${track.id}] 변환 중...`);
    await execAsync(
      `ffmpeg -y -i "${mp3Path}" -vn -c:a aac -b:a 128k "${m4aPath}"`,
    );

    // 3. 변환된 M4A를 R2에 업로드
    console.log(`⏳ [${track.id}] 업로드 중...`);
    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        // ✏️ [국가 변경 1/3] R2 저장 경로 변경 (예: en-episodes-audio/m4a/)
        Key: `de-episodes-audio/m4a/${track.id}.m4a`,
        Body: fs.readFileSync(m4aPath),
        ContentType: "audio/mp4",
      }),
    );

    // ✏️ [국가 변경 2/3] Supabase에 저장될 URL 경로 변경 (위 Key와 동일하게)
    const newUrl = `${process.env.R2_PUBLIC_URL}/de-episodes-audio/m4a/${track.id}.m4a`;
    const updateData = { audio_file: newUrl };

    // 4. audioFile_dubbing 변환 (있을 때만)
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

      console.log(`⏳ [${track.id}] 더빙 변환 중...`);
      await execAsync(
        `ffmpeg -y -i "${dubbingMp3Path}" -vn -c:a aac -b:a 128k "${dubbingM4aPath}"`,
      );
      console.log(`⏳ [${track.id}] 더빙 업로드 중...`);
      await r2.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: `de-episodes-audio/m4a/${track.id}_dubbing.m4a`,
          Body: fs.readFileSync(dubbingM4aPath),
          ContentType: "audio/mp4",
        }),
      );

      updateData.audioFile_dubbing = `${process.env.R2_PUBLIC_URL}/de-episodes-audio/m4a/${track.id}_dubbing.m4a`;
    }

    // 5. Supabase URL 업데이트
    await supabase.from("episodes").update(updateData).eq("id", track.id);
    console.log(`✅ [${track.id}] 성공`);
  } catch (e) {
    console.error(`❌ [${track.id}] 실패:`, e.message);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
}

async function main() {
  const { data: tracks, error } = await supabase
    .from("episodes")
    .select("id, audio_file, audioFile_dubbing")
    .or("audio_file.like.%.mp3,audioFile_dubbing.like.%.mp3")
    // ✏️ [국가 변경 3/3] 처리할 언어 코드 변경 (예: 영어: ['en'], 전체: 이 줄 삭제)
    .contains("language", ["de"]);

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

  const CONCURRENCY = 5; // 동시에 처리할 개수
  const queue = [...tracks];

  async function worker() {
    while (queue.length > 0) {
      const track = queue.shift();
      const result = await convertTrack(track)
        .then(() => "ok")
        .catch(() => "fail");
      if (result === "ok") done++;
      else failed++;
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
