import { randomUUID } from 'node:crypto';

export const GATEWAY_CHILD_ASYNC_PROMOTION_MS = 28_000;
export const GATEWAY_AWAIT_ASYNC_MIN_TIMEOUT_MS = 6_000;
export const GATEWAY_AWAIT_ASYNC_MAX_TIMEOUT_MS = 28_000;
export const GATEWAY_CHILD_ASYNC_RETENTION_MS = 10 * 60 * 1000;

export const GATEWAY_CHILD_ASYNC_WARNING = '同期リクエストが28秒継続したため、Gateway側で観測された30秒前後の境界に余裕を持たせてリクエストを非同期化しました。破壊的操作はすでに行われている可能性があります。進捗確認は**gateway__await_async**へこのasyncIdと6000〜28000msの待機上限を指定してください。await中に完了した場合は即時返却し、未完了の場合だけ指定上限まで待つため、短周期でstatus確認を繰り返さないでください。';
export const GATEWAY_AWAIT_ASYNC_MESSAGE = '同じasyncIdを追跡する場合はgateway__await_asyncを使用してください。待機上限は6000〜28000msで、待機中に完了した場合は即時返却します。';
export const GATEWAY_AWAIT_ASYNC_ALREADY_SETTLED_MESSAGE = 'この非同期タスクはgateway__await_asyncの開始前にすでに完了または失敗していました。これはOpenAIによるツール時間制限やGatewayの作業時間制限を示すものではありません。保持されているstatus/resultを確認してください。';

const errorMessage = (error) => error instanceof Error ? error.message : String(error);

export function createGatewayChildAsyncRegistry({
                                                  promotionMs = GATEWAY_CHILD_ASYNC_PROMOTION_MS,
                                                  retentionMs = GATEWAY_CHILD_ASYNC_RETENTION_MS,
                                                  createId = () => randomUUID().toLowerCase(),
                                                  now = () => Date.now()
                                                } = {}) {
  const tasks = new Map();
  const isoNow = () => new Date(now()).toISOString();

  const prune = () => {
    const cutoff = now() - retentionMs;
    for (const [asyncId, task] of tasks) {
      if (task.status !== 'running' && task.finishedAtMs !== null && task.finishedAtMs <= cutoff) {
        tasks.delete(asyncId);
      }
    }
  };

  const summary = (task, includeResult = false) => ({
    asyncId: task.asyncId,
    tool: task.tool,
    prefix: task.prefix,
    isolatedId: task.isolatedId,
    status: task.status,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    promotedAfterMs: promotionMs,
    hasResult: task.status === 'completed',
    ...(includeResult && task.status === 'completed' ? { result: task.result } : {}),
    ...(task.status === 'failed' ? { error: task.error } : {})
  });

  const retain = ({ tool, prefix, isolatedId, promise, createdAt = isoNow() }) => {
    prune();
    const asyncId = createId();
    const task = {
      asyncId,
      tool,
      prefix,
      isolatedId,
      status: 'running',
      createdAt,
      finishedAt: null,
      finishedAtMs: null,
      result: undefined,
      error: null,
      completion: null
    };
    task.completion = Promise.resolve(promise).then(
        (value) => {
          task.finishedAtMs = now();
          task.finishedAt = new Date(task.finishedAtMs).toISOString();
          task.status = 'completed';
          task.result = value;
          return value;
        },
        (error) => {
          task.finishedAtMs = now();
          task.finishedAt = new Date(task.finishedAtMs).toISOString();
          task.status = 'failed';
          task.error = errorMessage(error);
          throw error;
        }
    );
    tasks.set(asyncId, task);
    void task.completion.catch(() => {});
    return task;
  };

  return {
    async resolveOrPromote({ tool, prefix, isolatedId = null, promise }) {
      const createdAt = isoNow();
      let settled = false;
      let result;
      let failure;
      const tracked = Promise.resolve(promise).then(
          (value) => {
            settled = true;
            result = value;
            return value;
          },
          (error) => {
            settled = true;
            failure = error;
            return undefined;
          }
      );

      let timer;
      await Promise.race([
        tracked,
        new Promise((resolvePromise) => {
          timer = setTimeout(resolvePromise, promotionMs);
        })
      ]);
      if (timer) clearTimeout(timer);
      if (settled) {
        if (failure) throw failure;
        return { promoted: false, result };
      }

      const task = retain({
        tool,
        prefix,
        isolatedId,
        createdAt,
        promise: tracked.then(() => {
          if (failure) throw failure;
          return result;
        })
      });
      return { promoted: true, status: summary(task) };
    },

    promote({ tool, prefix, isolatedId = null, promise }) {
      return summary(retain({ tool, prefix, isolatedId, promise }));
    },

    completion(asyncId, isolatedId = null) {
      prune();
      const task = tasks.get(asyncId);
      if (!task) throw new Error(`Unknown or expired asyncId: ${asyncId}`);
      if (task.isolatedId !== isolatedId) throw new Error('asyncId belongs to a different isolated workspace context');
      return task.completion;
    },

    status(asyncId, isolatedId = null) {
      prune();
      const task = tasks.get(asyncId);
      if (!task) throw new Error(`Unknown or expired asyncId: ${asyncId}`);
      if (task.isolatedId !== isolatedId) {
        throw new Error('asyncId belongs to a different isolated workspace context');
      }
      return summary(task, true);
    },

    waitForCompletion(asyncId, isolatedId = null, timeoutMs) {
      if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < 0) {
        throw new Error('timeoutMs must be a finite non-negative integer');
      }
      prune();
      const task = tasks.get(asyncId);
      if (!task || task.isolatedId !== isolatedId) {
        throw new Error('Async task is unavailable for the specified asyncId/context');
      }
      if (task.status !== 'running') return Promise.resolve(true);
      if (timeoutMs === 0) return Promise.resolve(null);
      let timer;
      const timeout = new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs);
      });
      const completion = task.completion.then(() => true, () => true);
      return Promise.race([completion, timeout]).finally(() => clearTimeout(timer));
    }
  };
}

export function gatewayChildAsyncPromotionMcpResult(status) {
  const details = {
    asyncId: status.asyncId,
    prefix: status.prefix,
    tool: status.tool,
    isolatedId: status.isolatedId,
    status: status.status,
    promotedAfterMs: status.promotedAfterMs,
    awaitTool: 'gateway__await_async'
  };
  return {
    content: [
      { type: 'text', text: GATEWAY_CHILD_ASYNC_WARNING },
      { type: 'text', text: JSON.stringify(details) }
    ],
    isError: true
  };
}

export function gatewayAwaitAsyncMcpResult(value, isError = false) {
  const payload = { ...value, message: GATEWAY_AWAIT_ASYNC_MESSAGE };
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload) },
      { type: 'text', text: GATEWAY_AWAIT_ASYNC_MESSAGE }
    ],
    structuredContent: payload,
    isError
  };
}

export function gatewayAwaitAsyncAlreadySettledMcpResult(value) {
  const payload = { ...value, message: GATEWAY_AWAIT_ASYNC_ALREADY_SETTLED_MESSAGE };
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload) },
      { type: 'text', text: GATEWAY_AWAIT_ASYNC_ALREADY_SETTLED_MESSAGE }
    ],
    structuredContent: payload,
    isError: true
  };
}
