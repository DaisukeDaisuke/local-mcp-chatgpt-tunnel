import { randomUUID } from 'node:crypto';

export const GATEWAY_CHILD_ASYNC_PROMOTION_MS = 11_000;
const MAX_RETAINED_ASYNC_REQUESTS = 64;

export const GATEWAY_CHILD_ASYNC_WARNING = '10秒以上の同期リクエストはgatewayのクラッシュさせるため、リクエストは非同期化されました。破壊的操作はすでに行われている可能性があります。これはgatewayクラッシュの緊急回避です。このメッセージは絶対に、ゲートウェイの作業制限、もしくはopenAIによるツール呼び出し制限ではなく、そう解釈してはいけません。単にユーザダイヤログにユーザが気が付いてない可能性があります。進捗メッセージでブロッキングを解消するように伝えてください。状況は**gateway_childs_mcp_async_status**で確認し、操作が何かしらの理由でブロッキングしている場合は、放棄して再度試してください';

const errorMessage = (error) => error instanceof Error ? error.message : String(error);

export function createGatewayChildAsyncRegistry({
  promotionMs = GATEWAY_CHILD_ASYNC_PROMOTION_MS,
  createId = () => randomUUID().toLowerCase()
} = {}) {
  const tasks = new Map();

  const prune = () => {
    if (tasks.size < MAX_RETAINED_ASYNC_REQUESTS) return;
    for (const [asyncId, task] of tasks) {
      if (task.status !== 'running') tasks.delete(asyncId);
      if (tasks.size < MAX_RETAINED_ASYNC_REQUESTS) break;
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

  return {
    async resolveOrPromote({ tool, prefix, isolatedId = null, promise }) {
      const createdAt = new Date().toISOString();
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
        result: undefined,
        error: null
      };
      tasks.set(asyncId, task);
      void tracked.then(() => {
        task.finishedAt = new Date().toISOString();
        if (failure) {
          task.status = 'failed';
          task.error = errorMessage(failure);
        } else {
          task.status = 'completed';
          task.result = result;
        }
      });
      return { promoted: true, status: summary(task) };
    },

    status(asyncId, isolatedId = null) {
      const task = tasks.get(asyncId);
      if (!task) throw new Error(`Unknown or expired asyncId: ${asyncId}`);
      if (task.isolatedId !== isolatedId) {
        throw new Error('asyncId belongs to a different isolated workspace context');
      }
      return summary(task, true);
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
