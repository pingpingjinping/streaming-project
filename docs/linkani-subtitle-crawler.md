# Linkani 별도 자막 수집

GitHub **Actions → Collect Linkani subtitles → Run workflow**에서 실행한다.
파이나 브라우저를 켜둘 필요가 없다. Python 표준 라이브러리만 사용하고 영상,
원본 플레이어 스크립트, P2P 코드는 내려받아 실행하지 않는다.

첫 실행 기본값은 목록 1페이지 탐색, 작품 2개, 최대 6회차다.
PR 검증에서는 작품 `21639,3327`에서 작품당 최대 3회차씩 수집한다.

## 범위를 늘려 수집하기

| 입력 | 의미 |
| --- | --- |
| `anime_ids` | 비우면 전체 목록. 특정 작품은 숫자 ID를 쉼표로 구분 |
| `catalog_pages` | 이번 실행에 추가로 탐색할 목록 페이지. `0`은 남은 전체 |
| `max_works` | 이번 실행에서 처리할 미완료 작품 수. `0`은 제한 없음 |
| `max_episodes` | 이번 실행에서 시도할 회차 수. `0`은 제한 없음 |
| `resume_run_id` | 이전 Actions 실행 URL의 `/runs/` 뒤 숫자. 첫 실행은 비움 |
| `delay_seconds` | 요청 간 대기. 기본 1초, 요청은 한 번에 하나씩 전송 |

전체 수집은 `anime_ids`를 비우고 나머지 수량 제한을 `0`으로 설정한다.
5시간이 되면 중간 결과를 저장하고 정상 종료한다. 작업 제한 5시간 30분 안에
결과를 업로드하며, Actions의 6시간 제한 전에 멈춘다.
401/403 접근 거부는 우회하지 않고 멈춘다. 일시적 서버 오류는 최대 3회 재시도한다.

## 결과 다운로드와 이어받기

실행 화면 하단 **Artifacts → linkani-subtitles**를 눌러 ZIP을 받는다.
GitHub의 artifact 다운로드에는 로그인이 필요할 수 있다.

- `subtitles/작품ID_제목/a1_k1.vtt`: 원본 UTF-8 자막. `a1`은 재생목록 번호,
  `k1`은 회차 번호다. 다른 재생목록도 별도로 기록한다.
- `index.json`: 작품·회차·파일 경로·SHA-256. 내용이 완전히 같은 자막은 한 파일만
  저장하며, 중복 회차의 `path`가 해당 파일을 가리킨다.
- `checkpoint.json`: 발견한 목록, 진행 상황, 실패 내역.
- `summary.json`: 이번 실행 및 누적 결과.

다음 실행의 `resume_run_id`에 이전 실행 ID를 넣으면 **이전 자막과 체크포인트를
함께 복원**한다. 정상 저장된 파일은 검증 후 건너뛰고, 누락·손상된 파일과 실패한
회차는 재시도한다. 수량 제한으로 일부만 받은 작품은 다음 실행에서 이어진다.
기본 artifact 보관 기간은 **14일**이므로 만료 전에 이어받거나 ZIP을 내려받는다.
수집 결과는 저장소 커밋이나 공개 릴리즈에 넣지 않는다.

별도 자막 주소가 없는 회차는 `no_subtitle`로 기록한다. 영상에 박힌 자막을
OCR로 추출하거나 완료된 작품의 신규 회차를 자동 재탐색하는 기능은 포함하지 않는다.

## 로컬·파이에서 실행

```bash
python3 scripts/crawl-linkani-subtitles.py \
  --anime-ids 21639,3327 --max-works 2 --max-episodes 6 \
  --episodes-per-work 3 --output linkani-subtitles

# 같은 폴더로 다시 실행하면 이어받는다.
python3 scripts/crawl-linkani-subtitles.py \
  --catalog-pages 5 --max-works 20 --max-episodes 300 \
  --output linkani-subtitles

python3 -m unittest discover -s scripts -p test_linkani_crawler.py -v
```
