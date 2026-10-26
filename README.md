# 애니메이션 스트리밍 플레이어 (Anime Streaming Player)

## Pi: GitHub에서 만든 ARM64 이미지로 업데이트

`Docker ARM64 Build and Publish` Actions는 PR에서 ARM64 이미지를 빌드하고,
Chromium·Node/sharp·앱의 PostgreSQL 연결을 검사합니다. `main`에 머지되면 같은
검사를 통과한 이미지를 GHCR에 저장합니다. Actions에서 `main`을 선택해 수동 실행할 수도 있습니다.

- 최신 성공 이미지: `ghcr.io/pingpingjinping/streaming-project:main-arm64`
- 커밋별 이미지: `ghcr.io/pingpingjinping/streaming-project:sha-<전체 40자리 커밋 SHA>`
- PR 또는 다른 브랜치의 수동 실행은 이미지를 게시하지 않습니다.

첫 게시 직후에는 GHCR 패키지가 **Private**일 수 있습니다. GitHub 프로필의
Packages → streaming-project → Package settings에서 공개 여부를 확인하세요.
Public으로 설정하면 Pi에서 로그인 없이 받을 수 있습니다. Private으로 유지하려면
Pi의 `docker login ghcr.io -u pingpingjinping`에서 `read:packages` 권한의 classic PAT로
로그인합니다. 토큰은 저장소나 명령 인수에 적지 않습니다.

기존 Pi 설치가 동작 중이고 Docker 서버가 `aarch64`/`arm64`, Compose가 v2.20 이상인
경우 다음 명령을 사용합니다. 먼저 해당 커밋의 ARM64 Actions가 성공했는지 확인하세요.

```bash
cd ~/streaming-project
git pull --ff-only
bash scripts/deploy-pi-image.sh "ghcr.io/pingpingjinping/streaming-project:sha-$(git rev-parse HEAD)"
```

Pi에서 빌드하지 않고 이미지를 받은 뒤 기존 Compose 프로젝트의 `anime`만 교체합니다.
`.env`, 자막·작품 검수 bind mount, DB volume, Caddy 설정을 그대로 사용하며
DB/Caddy 컨테이너를 재생성하지 않습니다. 앱 교체 중에는 잠깐 접속이 끊깁니다.
180초 이내에 healthcheck가 성공하지 않으면 이전 앱 이미지로 복구를 시도합니다.

스크립트는 `docker-compose.yml` → 로컬 `docker-compose.override.yml`(또는 `.yaml`)
→ `docker-compose.image.yml` 순으로 합칩니다. 다른 파일 조합을 사용한다면
기존과 동일한 `COMPOSE_FILE`/`COMPOSE_PROJECT_NAME`을 지정하세요.
이미지를 바꾼 뒤에도 업데이트는 위 스크립트로 진행합니다. 일반 `docker compose up --build`는
기존 로컬 빌드 방식으로 돌아가는 명령이며, 다운로드한 버전을 자동 선택하지 않습니다.

특정 커밋 대신 최신 성공 이미지를 적용하려면 인수 없이 실행할 수 있습니다.
최신 이미지가 아직 빌드 중이라면 직전 성공 버전을 받게 됩니다.

```bash
bash scripts/deploy-pi-image.sh
# 이전 앱 이미지로 되돌리기 (네트워크 다운로드/빌드 없음)
bash scripts/deploy-pi-image.sh --rollback
```

다운로드·설정·아키텍처 검사 실패 시 실행 중인 앱은 그대로 둡니다. 실제로 실행 중이던
이미지는 `streaming-project-rollback` 태그로 보관하고 `.pi-image/`에 복구 상태를 기록합니다.
같은 이미지의 재적용은 이전 복구 기록을 덮어쓰지 않습니다. 이미지 자동 삭제는 하지 않으므로
오래된 복구 이미지가 필요 없어지면 직접 정리할 수 있습니다. `docker image prune -a`로
복구 이미지를 지우면 로컬 롤백이 불가능할 수 있습니다. 롤백은 앱 이미지에만 적용되며
DB 데이터·스키마를 과거 상태로 돌리는 기능은 아닙니다.

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

Pi의 자동 updater는 `anime-db-download/db-v1` Release에서 작품 DB와 검수 자막 registry를 독립적으로 확인합니다.

- 작품 DB: `anime_four_sources_multilingual_prepared.zip`
- 검수 registry: `anime_reviewed_subtitle_registry_v1.zip`

각 자산은 별도 SHA-256 상태를 가지므로 월간 작품 DB만 바뀌면 대용량 registry를 다시 받지 않습니다. 기존 합본 Release도 registry 자산이 아직 없으면 자동 감지해 호환 import합니다. 전체 동기화는 아래 명령이며, 필요하면 `--catalog-only` 또는 `--registry-only`로 하나만 다운로드/import할 수 있습니다.

```bash
python3 scripts/update-anime-db-release.py
python3 scripts/update-anime-db-release.py --catalog-only
python3 scripts/update-anime-db-release.py --registry-only
```

작품 SQLite를 수동으로 가져오는 기존 명령도 유지됩니다. catalog import 뒤에는 검수 자막 원본·확정 회차를 건드리지 않고 catalog-derived ReAnime lookup만 보충하며, registry import는 `is_manual=true`인 수동 수정 자막 행을 덮어쓰지 않습니다.

```bash
python3 scripts/import-anime-db.py /path/to/anime_four_sources_multilingual_prepared.db
python3 scripts/refresh-reviewed-subtitle-links.py /path/to/anime_four_sources_multilingual_prepared.db
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
# Linkani (keeps the legacy Linkkf setting/provider key)
# LINKKF_BASE_URL=https://linkani.tv
```
