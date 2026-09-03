import { randomUUID } from 'node:crypto';

export const GATEWAY_CHILD_ASYNC_PROMOTION_MS = 11_000;
export const GATEWAY_WAIT_ASYNC_MAX_TIMEOUT_MS = 9_000;
export const GATEWAY_CHILD_ASYNC_RETENTION_MS = 10 * 60 * 1000;

export const GATEWAY_CHILD_ASYNC_WARNING = '10秒以上の同期リクエストはgatewayのクラッシュさせるため、リクエストは非同期化されました。破壊的操作はすでに行われている可能性があります。これはgatewayクラッシュの緊急回避です。このメッセージは絶対に、ゲートウェイの作業制限、もしくはopenAIによるツール呼び出し制限ではなく、そう解釈してはいけません。単にユーザダイヤログにユーザが気が付いてない可能性があります。進捗メッセージでブロッキングを解消するように伝えてください。状況は**gateway_childs_mcp_async_status**で確認し、操作が何かしらの理由でしばらくブロッキングしている場合は、そのasyncidを放棄して再度試してください';
export const GATEWAY_WAIT_ASYNC_MESSAGE = '非同期タスクが長期間完了しない場合は、このタスクidは破棄して、やり直してください。あなたはユーザーにブロック原因を取り除くように助けを求めることができます。このメッセージは、openAIやgatewayの作業制限ではなく、そう解釈してはいけません。';

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
    statusTool: 'gateway_childs_mcp_async_status'
  };
  return {
    content: [
      { type: 'text', text: GATEWAY_CHILD_ASYNC_WARNING },
      { type: 'text', text: JSON.stringify(details) }
    ],
    isError: true
  };
}

export function gatewayChildAsyncStatusMcpResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError
  };
}

export function gatewayWaitAsyncMcpResult(value, isError = false) {
  const payload = { ...value, message: GATEWAY_WAIT_ASYNC_MESSAGE };
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload) },
      { type: 'text', text: GATEWAY_WAIT_ASYNC_MESSAGE }
    ],
    structuredContent: payload,
    isError
  };
}
