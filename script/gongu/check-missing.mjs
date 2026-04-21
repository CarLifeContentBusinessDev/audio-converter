import axios from "axios";
import fs from "fs";
import "dotenv/config";

const SAVE_DIR =
  process.env.GONGU_SAVE_DIR ||
  path.resolve(process.cwd(), "tmp", "gongu-audio");

const sanitize = (s) =>
  s
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .slice(0, 200);

const res = await axios.get(
  "https://gongu.copyright.or.kr/gongu/wrt/wrtApi/search.json",
  {
    params: {
      menuNo: "200020",
      pageIndex: 1,
      pageUnit: 3000,
      sortSe: "date",
      depth2ClSn: "10128",
      wrtFileTy: "03",
      apiKey: process.env.GONGU_API_KEY,
    },
  },
);

// 중복 파일명 찾기
const seen = new Map(); // filename → [wrtSn, title]
const duplicates = [];
for (const { wrtSn, orginSj } of res.data.resultList) {
  const fn = sanitize(orginSj) + ".mp3";
  if (seen.has(fn)) {
    duplicates.push({ fn, items: [seen.get(fn), { wrtSn, title: orginSj }] });
  } else {
    seen.set(fn, { wrtSn, title: orginSj });
  }
}

console.log(
  `API 총 ${res.data.resultList.length}건 → 고유 파일명 ${seen.size}개`,
);
console.log(`중복 충돌 ${duplicates.length}건:\n`);
duplicates.forEach(({ fn, items }) => {
  console.log("파일명:", fn);
  items.forEach((i) => console.log(`  wrtSn:${i.wrtSn} 제목:"${i.title}"`));
  console.log();
});
