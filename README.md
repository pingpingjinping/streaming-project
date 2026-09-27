# 애니메이션 스트리밍 플레이어 (Anime Streaming Player)

## 네 곳 제목 DB와 미연결 작품

`/catalog`에서 온나다 5,478건과 애니시아 3,539건, 총 9,017건의 한글 제목을
검색할 수 있습니다. 검토된 제목 연결에서 중복되지 않는 영어·일본어 별칭을
`anime_title_aliases`에 추가해 기존 작품 카드의 한글 제목 표시에도 활용합니다.

핵심 연결은 ReAnime 작품 ID와 애니시아 작품 번호입니다. 온나다와 AniList로
검증한 연결을 바탕으로 ReAnime 작품 3,953개에 한글 제목을 표시합니다.
같은 연도에 제목이 일치하고 애니시아 작품 번호가 하나로 특정되는 1,957개는 재생 화면에서 해당 작품의
자막 제작자 목록을 직접 조회합니다. 한 ReAnime ID에 여러 애니시아 번호가
연결되는 경우에는 임의로 고르지 않고 기존 제목 검색을 사용합니다.

`/unmatched`에서 애니시아 기준 미연결 작품 260개를 제목과 연도별로 확인하고,
회차별 스트리밍 주소를 등록할 수 있습니다. 주소는 기존 PostgreSQL의
`manual_stream_sources`에 로그인 계정별로 저장됩니다. 페이지의 후보 점수는
검토용이며 자동 연결이나 동일 작품 확정을 뜻하지 않습니다.

Pi에 검토된 `anime_four_sources_multilingual_prepared.db` 파일을
복사한 다음 저장소 루트에서 아래 명령을 실행하면 네 출처 43,310건,
한글 작품 9,017건, ReAnime 매핑 3,953건, 검토된 제목 별칭과 미연결 검토 목록 260건을 PostgreSQL로 가져옵니다.
기존 사용자 스트림 링크는 유지됩니다.

```bash
python3 scripts/import-anime-db.py /path/to/anime_four_sources_multilingual_prepared.db
```

DB를 다시 검토했다면 `scripts/export-korean-catalog.py`,
`scripts/export-reanime-matches.py`, `scripts/export-unmatched-catalog.py`에
각각 DB 경로를 전달해 사이트에 포함된 목록을 다시 만들 수 있습니다.

Next.js 15 App Router와 Vercel Serverless, Neon Postgres를 기반으로 구축된 고성능 애니메이션 웹 스트리밍 플레이어입니다.

---

## 🚀 Vercel 원클릭 배포 및 시작하기

복잡한 터미널 명령어, 키 발급, DB 세팅 없이 **아래 버튼 클릭 몇 번으로 개인 스트리밍 사이트를 즉시 배포**할 수 있습니다.

### 1. 원클릭 배포 (Deploy to Vercel)
아래 버튼이나 링크를 클릭하면 본인 깃허브 계정으로 저장소가 자동 복제(Fork)되며 Vercel 배포가 바로 진행됩니다:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/13tahlm1-netizen/anime)

> 🔗 **원클릭 배포 주소**:  
> [https://vercel.com/new/clone?repository-url=https://github.com/13tahlm1-netizen/anime](https://vercel.com/new/clone?repository-url=https://github.com/13tahlm1-netizen/anime)

### 2. 데이터베이스 원클릭 자동 연동 (1초 컷)
1. 배포 완료 후 Vercel 프로젝트 대시보드 상단의 **`Storage`** 탭을 클릭합니다.
2. **`Create Database` ➔ `Neon (Postgres)`**을 선택하고 **`Continue`**를 누릅니다.
3. **끝!** Vercel이 알아서 Neon DB를 생성하고 연결 환경 변수(`POSTGRES_URL`, `DATABASE_URL`)까지 프로젝트에 **자동 주입**합니다. (수동 입력 불필요)

### 3. 세션 보안 키 (Zero-Config)
- `AUTH_SECRET`을 별도로 발급받거나 입력할 필요가 없습니다. 연결된 데이터베이스의 고유 암호화 해시를 기반으로 256비트 보안 키가 **자동 안전 생성**됩니다.

### 4. 테이블 자동 생성 및 초기 관리자 설정
- 배포 완료 후 사이트에 접속하면 필요한 모든 DB 테이블(시청 기록, 즐겨찾기, 오디오 스킵, 유저 계정 등)이 **자동으로 생성**됩니다.
- 최초 접속 시 `/setup` 마법사 페이지로 자동 이동하며, 마스터 관리자 계정을 1회 생성하면 즉시 서비스를 이용하실 수 있습니다.

---

## ✨ 주요 기능

### 1. 실시간 스트리밍 & CORS 우회
- **HLS 스트리밍 지원**: `ArtPlayer`와 `Hls.js`를 결합하여 끊김 없는 고화질 m3u8 스트리밍 제공
- **서버리스 프록시**: 외부 m3u8 재생목록 및 세그먼트, 자막에 대한 CORS/Referer 우회 프록시 파이프라인 내장

### 2. 고성능 자막 크롤링 & WASM 렌더링
- **libass WebAssembly (SubtitlesOctopus)**: 브라우저 환경에서 화려한 효과의 `.ass` 자막을 원본 그대로 고해상도 렌더링
- **온디맨드 자막 수집**: 애니시아(Anissia) 및 외부 자막 블로그 크롤링 & 직다운로드
- **다양한 포맷 실시간 변환**: SMI / SRT 포맷 인메모리 압축 해제 및 WebVTT 실시간 변환
- **자막 편의 기능**: 실시간 자막 선택 및 싱크 미세 조정 (±0.1s, ±0.5s)

### 3. 스마트 오프닝/엔딩 스킵
- **AniSkip 연동**: 글로벌 애니메이션 타임스탬프 DB를 조회하여 오프닝/엔딩 자동 스킵
- **플레이어 타임라인 하이라이트**: 프로그레스 바에 오프닝/엔딩 구간 시각화
- **수동 스킵 폴백**: 미등록 작품 시 플레이어 상시 `+85s 스킵` 버튼 및 초반부 플로팅 건너뛰기 제안

### 4. 고도화된 플레이어 및 회차 탐색 UX
- **장편 애니 완벽 대응**: 50화 단위 구간 선택 탭, 회차 번호 직접 입력 점프, 오름차순/내림차순 정렬
- **인플레이어(In-Player) 탐색**: 전체화면이나 재생 중에도 하단 회차 리스트에서 즉시 회차 변경
- **자막/더빙 분기 스위치**: 더빙이 존재하는 회차는 원클릭으로 판본 전환 가능
- **신규 회차 감지 (NEW 뱃지)**: 완주한 방영작에 새 회차가 업데이트되면 시청 기록에서 자동으로 인식 및 강조

### 5. 멀티 디바이스 시청 동기화 & 보안
- **클라우드 이어보기**: Neon Serverless Postgres 기반으로 모바일, 태블릿, PC 간 실시간 시청 진도율 자동 동기화
- **마스터 관리자 설정 마법사 (`/setup`)**: 첫 배포 시 관리자 계정을 직접 생성하여 사이트를 비공개 보호
- **안전한 인증 체계**: Node.js `scrypt` 기반 단방향 해싱 및 암호화 세션 쿠키 인증

---

## 🛠 기술 스택

| 영역 | 기술 |
| :--- | :--- |
| **Frontend** | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS, Lucide React |
| **Player** | ArtPlayer, Hls.js, SubtitlesOctopus (libass WASM) |
| **Backend** | Next.js Serverless API Routes, Cheerio, Adm-zip, Iconv-lite |
| **Database** | Neon Serverless PostgreSQL (`@neondatabase/serverless`) |
| **Deploy** | Vercel (Region: `icn1` 서울) |

---

## ⚙️ 추가 환경 변수 (선택 사항)

외부 소스 미러 도메인 주소가 바뀔 경우에만 Vercel 환경 변수에 등록합니다:

```env
# 선택: 외부 소스 미러 도메인 변경 시
# LINKKF_BASE_URL=https://...
```
