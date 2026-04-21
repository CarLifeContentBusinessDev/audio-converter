# audio-converter

R2(Cloudflare)와 Supabase 데이터를 대상으로 오디오/이미지 변환, URL 점검, 정리 작업을 수행하는 스크립트 모음입니다.

## 프로젝트 구조

- `script/pickle-web-demo/convert.mjs`
  - episodes 오디오(mp3)를 m4a로 변환 후 R2 업로드, Supabase URL 업데이트
- `script/pickle-web-demo/check-audio.js`
  - episodes 오디오 URL 접근성 전수 점검
- `script/pickle-web-demo/check-image.js`
  - 주요 테이블 이미지 URL 전수 점검
- `script/pickle-web-demo/cleanup-r2.mjs`
  - R2 파일과 Supabase 참조를 비교해 정리(인터랙티브)
- `script/pickle-web-demo/migrate-youtube-images.mjs`
  - 외부(예: YouTube) 이미지 URL을 WebP로 변환 후 R2로 마이그레이션
- `script/gongu/download-gongu-api.mjs`
  - 공유마당 음원 API 기준 동기화(누락 다운로드/불필요 파일 삭제)
- `script/gongu/check-missing.mjs`
  - 공유마당 API 결과에서 중복 파일명을 점검

## 사전 준비

### 1) 의존성 설치

```bash
npm install
```

### 2) ffmpeg 설치 (오디오 변환 시 필수)

```bash
# Windows
winget install ffmpeg

# macOS
brew install ffmpeg
```

설치 확인:

```bash
ffmpeg -version
```

### 3) .env 설정

프로젝트 루트에 `.env` 파일 생성:

```env
# R2
R2_ENDPOINT=https://xxxxx.r2.cloudflarestorage.com
R2_ACCESS_KEY=...
R2_SECRET_KEY=...
R2_BUCKET=...
R2_PUBLIC_URL=https://pub-xxxxx.r2.dev

# Supabase
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=...

# Gongu API
GONGU_API_KEY=...
```

주의:

- `SUPABASE_SERVICE_KEY`는 `anon key`가 아닌 `service_role key`를 사용해야 합니다.

## 실행 방법

아래 명령은 모두 프로젝트 루트에서 실행합니다.

### 1) 오디오 변환

```bash
node script/pickle-web-demo/convert.mjs
```

- 국가 선택: `ko`, `en`, `de`, `jp`, `all`
- 모드 선택:
  - `[1] 전체 변환 (mp3만)`
  - `[2] 특정 에피소드 ID` (예: `254,318`)
- 기본 변환 설정: AAC, 48k, 24kHz, mono, `+faststart`

### 2) 오디오 URL 점검

```bash
node script/pickle-web-demo/check-audio.js
```

- 점검 대상: `episodes.audio_file`, `episodes.audioFile_dubbing`
- 정상 상태코드: `200`, `206`, `416`
- `429` 응답 재시도 로직 포함

### 3) 이미지 URL 점검

```bash
node script/pickle-web-demo/check-image.js
```

- 대상 테이블 선택 가능: `broadcastings`, `categories`, `episodes`, `programs`, `series`, `themes`, `all`
- 이미지 Content-Type 검증 포함
- null 값을 오류로 볼지 선택 가능

### 4) R2 정리

```bash
node script/pickle-web-demo/cleanup-r2.mjs
```

- R2 prefix별 파일을 수집
- Supabase 참조 URL과 비교해 미참조 파일을 탐색/정리

### 5) YouTube 이미지 마이그레이션

```bash
node script/pickle-web-demo/migrate-youtube-images.mjs
```

- 외부 이미지 다운로드 후 WebP 변환
- 대상 크기(약 50KB) 기준으로 품질 조정
- R2 업로드 후 `episodes.img_url` 업데이트

### 6) 공유마당 음원 동기화

```bash
node script/gongu/download-gongu-api.mjs
```

- API 목록 기준으로 파일 폴더 동기화
- 누락 파일 다운로드, API에 없는 파일 삭제

### 7) 공유마당 제목 중복 점검

```bash
node check-missing.mjs
```

- API 결과에서 파일명 충돌(중복 제목) 확인

## 운영 팁

- 변환/점검 스크립트는 대량 데이터 처리 시 시간이 오래 걸릴 수 있습니다.
- 작업 중 강제 종료되면 `tmp` 폴더가 남을 수 있습니다.

```bash
# Windows PowerShell
Remove-Item -Recurse -Force tmp

# macOS / Linux
rm -rf tmp
```
