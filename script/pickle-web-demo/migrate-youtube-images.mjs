/* eslint-disable */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";

const R2_FOLDER = "images/youtube";
const PAGE_SIZE = 1000;

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

// YouTube 썸네일 URL 중 최고화질로 교체 (hqdefault → maxresdefault 시도)
function getBestYoutubeUrl(url) {
  return url;
}

async function downloadImage(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  return Buffer.from(response.data);
}

const TARGET_SIZE = 50 * 1024; // 50KB

async function convertToWebp(inputBuffer) {
  // 원본이 50KB 미만이면 고품질 유지
  if (inputBuffer.length < TARGET_SIZE) {
    return sharp(inputBuffer).webp({ quality: 90 }).toBuffer();
  }

  // 50KB 이상이면 이진 탐색으로 50KB 이하를 만족하는 최고 품질 찾기
  let low = 10;
  let high = 90;
  let best = null;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const buf = await sharp(inputBuffer).webp({ quality: mid }).toBuffer();

    if (buf.length <= TARGET_SIZE) {
      best = buf;
      low = mid + 1; // 더 높은 품질 시도
    } else {
      high = mid - 1; // 품질 낮춰야 함
    }
  }

  // 품질 10에서도 50KB 초과하면 그냥 최저 품질로
  return best ?? (await sharp(inputBuffer).webp({ quality: 10 }).toBuffer());
}

async function uploadToR2(key, buffer) {
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: "image/webp",
  });
  await r2.send(command);
}

async function fetchAllEpisodes() {
  const episodes = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("episodes")
      .select("id, title, img_url")
      .not("img_url", "is", null)
      .not("img_url", "like", `${R2_PUBLIC_URL}%`)
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`Supabase 조회 오류: ${error.message}`);
    if (!data || data.length === 0) break;

    episodes.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return episodes;
}

async function main() {
  console.log("\n============================================");
  console.log("  YouTube 이미지 → WebP 변환 & R2 업로드");
  console.log("============================================\n");

  // 1. 대상 에피소드 조회
  console.log("[1단계] Supabase에서 YouTube 이미지 에피소드 조회 중...\n");
  const episodes = await fetchAllEpisodes();

  if (episodes.length === 0) {
    console.log("✅ 변환할 YouTube 이미지가 없습니다.\n");
    return;
  }

  console.log(`  → ${episodes.length}개 에피소드 발견\n`);

  // 2. 처리
  console.log("[2단계] 다운로드 → WebP 변환 → R2 업로드 → Supabase 업데이트\n");

  let success = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const num = `[${i + 1}/${episodes.length}]`;
    const label = `#${ep.id} ${ep.title ?? ""}`.trim();

    process.stdout.write(`  ${num} ${label} ... `);

    try {
      // 다운로드
      const imgBuffer = await downloadImage(ep.img_url);

      // WebP 변환
      const webpBuffer = await convertToWebp(imgBuffer);

      // R2 키 및 공개 URL
      const r2Key = `${R2_FOLDER}/${ep.id}.webp`;
      const newUrl = `${R2_PUBLIC_URL}/${r2Key}`;

      // R2 업로드
      await uploadToR2(r2Key, webpBuffer);

      // Supabase 업데이트
      const { error: updateError } = await supabase
        .from("episodes")
        .update({ img_url: newUrl })
        .eq("id", ep.id);

      if (updateError)
        throw new Error(`Supabase 업데이트 실패: ${updateError.message}`);

      const sizeBefore = imgBuffer.length;
      const sizeAfter = webpBuffer.length;
      const ratio = ((1 - sizeAfter / sizeBefore) * 100).toFixed(1);
      const compressed = sizeBefore >= TARGET_SIZE ? " (압축)" : " (고품질)";

      console.log(
        `✅ ${formatBytes(sizeBefore)} → ${formatBytes(sizeAfter)} (${ratio}% 감소)${compressed}`,
      );
      success++;
    } catch (err) {
      console.log(`❌ ${err.message}`);
      errors.push({
        id: ep.id,
        title: ep.title,
        url: ep.img_url,
        error: err.message,
      });
      failed++;
    }
  }

  // 3. 결과 요약
  console.log("\n============================================");
  console.log(`  완료: 성공 ${success}개 / 실패 ${failed}개`);
  console.log("============================================\n");

  if (errors.length > 0) {
    const logPath = `./migrate-youtube-images-errors-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    fs.writeFileSync(logPath, JSON.stringify(errors, null, 2), "utf-8");
    console.log(`❌ 실패 목록 저장됨: ${logPath}\n`);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

main().catch((e) => {
  console.error("\n❌ 오류 발생:", e.message);
  process.exit(1);
});
