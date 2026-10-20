import { getDb, getSubtitleEpisodeStart } from "./db";
import { getProviderByAnimeId } from "./providers";

// A shared promise prevents overlapping refresh requests for the same viewer.
// The cursor advances only over batches actually attempted, including timeouts.
interface CheckState { lastCheck?: number; afterAnimeId: string; pending?: Promise<boolean> }
const checkStates = new Map<string, CheckState>();
const CHECK_INTERVAL_MS = 600_000;
const CHECK_STATE_LIMIT = 1000;

// 외부 스크래핑 제한 파라미터
const MAX_ANIME_COUNT = 20;   // 패스당 검사할 완주 작품 수 상한
const CONCURRENCY = 5;        // 동시 외부 스크래핑 개수
const TOTAL_BUDGET_MS = 8000; // 외부 조회 대기 예산
const MIN_USEFUL_WINDOW_MS = 2000; // 남은 예산이 이보다 적으면 새 호출 시작 안 함

/**
 * 타임아웃 래퍼: ms가 지난 뒤에는 null 반환 (바탕 Promise는 배경에서 끝나지만 블로킹하지 않음)
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  if (ms <= 0) return Promise.resolve(null);
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/**
 * 방영 중인 애니메이션의 최신화를 완주한 상태일 때,
 * 새로운 회차가 사이트에 업로드되었는지 감지하여 'NEW • N화'로 자동 승격합니다.
 *
 * 성능/안정:
 * - 직렬이 아닌 CONCURRENCY(5) 제한 병렬 + 전체 TOTAL_BUDGET_MS(8초) 예산
 *   (직렬 20회 스크래핑은 Vercel 함수 타임아웃/SSR 지연의 주원인이었음)
 * - 예산 초과 시 다음 10분 주기에 마지막으로 시도한 작품 다음부터 순환 검사
 * - 기존 진행도(watch_time > 0)가 있는 회차 기록은 초기화하지 않음
 */
export function checkAndPromoteNewEpisodes(userId = "default"): Promise<boolean> {
  let state = checkStates.get(userId);
  if (state?.pending) return state.pending;
  if (state?.lastCheck !== undefined && Date.now() - state.lastCheck < CHECK_INTERVAL_MS) {
    return Promise.resolve(false);
  }
  if (!state) state = { afterAnimeId: "" };
  checkStates.delete(userId);
  checkStates.set(userId, state);
  const current = state;
  current.pending = runCheck(userId, current).then(changed => {
    current.lastCheck = Date.now();
    return changed;
  }).finally(() => {
    current.pending = undefined;
    for (const [key, entry] of checkStates) {
      if (checkStates.size <= CHECK_STATE_LIMIT) break;
      if (!entry.pending) checkStates.delete(key);
    }
  });
  return current.pending;
}

async function runCheck(userId: string, state: CheckState): Promise<boolean> {
  const sql = getDb();
  if (!sql) throw new Error("Database not configured");

  let completedRows: any[];
  try {
    // 사용자의 가장 최신 시청 기록 중 완주(is_completed = true) 상태인 것들을 최대 20개 조회
    completedRows = await sql`
      SELECT * FROM (
        SELECT DISTINCT ON (anime_id)
          id, user_id, anime_id, anime_title, anime_poster, episode_number, episode_title, watch_url, is_completed, updated_at, updated_at::text AS history_version
        FROM anime_history
        WHERE user_id = ${userId}
        ORDER BY anime_id, updated_at DESC
      ) t
      WHERE is_completed = TRUE
      ORDER BY CASE WHEN anime_id > ${state.afterAnimeId} THEN 0 ELSE 1 END, anime_id
      LIMIT ${MAX_ANIME_COUNT};
    `;
  } catch (error) {
    console.error("[checkAndPromoteNewEpisodes db error]:", error);
    throw error;
  }

  if (!completedRows || completedRows.length === 0) {
    return false;
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let hasChange = false;

  // 제한 병렬 배치 처리 (5개씩)
  for (let i = 0; i < completedRows.length; i += CONCURRENCY) {
    // 남은 예산이 새 스크래핑을 감당할 만큼 부족하면 즉시 중단
    if (Date.now() >= deadline - MIN_USEFUL_WINDOW_MS) break;

    const batch = completedRows.slice(i, i + CONCURRENCY);
    state.afterAnimeId = String(batch[batch.length - 1].anime_id);
    const results = await Promise.allSettled(
      batch.map(async (row): Promise<boolean> => {
        const animeId = row.anime_id as string;
        const currentEpNum = Number(row.episode_number) || 0;

        // 남은 예산만큼만 대기 (단, 개별 호출도 최대 8초)
        const detail = await withTimeout(
          getSubtitleEpisodeStart(userId, animeId).then(subtitleEpisodeStart =>
            getProviderByAnimeId(animeId).getAnimeDetail(animeId, { subtitleEpisodeStart })),
          Math.min(deadline - Date.now(), TOTAL_BUDGET_MS)
        );
        if (!detail) return false;

        const epList = detail.sub_episodes || [];
        // 현재 완주한 회차보다 큰 다음 회차가 올라왔는지 확인 (오름차순 기준 첫 번째 다음 화)
        const nextEp = epList.filter(e => e.number > currentEpNum).sort((a, b) => a.number - b.number)[0];
        if (!nextEp) return false;

        // 다음 회차가 새로 등록됨 -> watch_time=0.0, is_completed=false로 신규 레코드 삽입 (NEW 상태 승격)
        // 기존 진행도가 있는 기록은 초기화하지 않음 (진행도 0인 스텁만 갱신)
        const promoted = await sql`
          INSERT INTO anime_history (
            user_id, anime_id, anime_title, anime_poster, episode_number, episode_title, watch_url, watch_time, duration, is_completed, updated_at
          ) SELECT
            ${userId}, ${animeId}, ${row.anime_title || detail.title}, ${row.anime_poster || detail.poster}, ${nextEp.number}, ${nextEp.title}, ${nextEp.watch_url}, 0.0, 0.0, FALSE, CURRENT_TIMESTAMP
          FROM anime_history source
          WHERE source.id = ${row.id} AND source.user_id = ${userId}
            -- Keep the bind parameter as text: the driver's timestamptz serializer
            -- converts strings through JS Date and loses PostgreSQL microseconds.
            AND source.updated_at = ${row.history_version}::text::timestamptz AND source.is_completed = TRUE
            AND NOT EXISTS (
              SELECT 1 FROM anime_history newer
              WHERE newer.user_id = ${userId} AND newer.anime_id = ${animeId}
                AND newer.updated_at > source.updated_at
            )
          ON CONFLICT (user_id, anime_id, episode_number)
          DO UPDATE SET
            episode_title = EXCLUDED.episode_title,
            watch_url = EXCLUDED.watch_url,
            updated_at = CURRENT_TIMESTAMP
          WHERE anime_history.is_completed = FALSE
            AND anime_history.watch_time = 0
            AND anime_history.duration = 0
          RETURNING id;
        `;
        return promoted.length > 0;
      })
    );

    hasChange = hasChange || results.some((r) => r.status === "fulfilled" && r.value === true);
  }

  return hasChange;
}
