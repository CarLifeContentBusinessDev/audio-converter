import axios from 'axios';
import fs from 'fs';
import 'dotenv/config';

const SAVE_DIR = 'C:\\Users\\250901\\OneDrive - Obigo Inc\\Car Life Content Business - 문서\\3. Service\\@픽클\\2. 컨텐츠 소싱\\픽클 뮤직\\공유마당 음원\\자연의소리';
const sanitize = s => s.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 200);

const res = await axios.get('https://gongu.copyright.or.kr/gongu/wrt/wrtApi/search.json', {
  params: { menuNo:'200020', pageIndex:1, pageUnit:3000, sortSe:'date', depth2ClSn:'10128', wrtFileTy:'03', apiKey: process.env.GONGU_API_KEY }
});

// 중복 파일명 찾기
const seen = new Map(); // filename → [wrtSn, title]
const duplicates = [];
for (const { wrtSn, orginSj } of res.data.resultList) {
  const fn = sanitize(orginSj) + '.mp3';
  if (seen.has(fn)) {
    duplicates.push({ fn, items: [seen.get(fn), { wrtSn, title: orginSj }] });
  } else {
    seen.set(fn, { wrtSn, title: orginSj });
  }
}

console.log(`API 총 ${res.data.resultList.length}건 → 고유 파일명 ${seen.size}개`);
console.log(`중복 충돌 ${duplicates.length}건:\n`);
duplicates.forEach(({ fn, items }) => {
  console.log('파일명:', fn);
  items.forEach(i => console.log(`  wrtSn:${i.wrtSn} 제목:"${i.title}"`));
  console.log();
});
