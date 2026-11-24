import { streamText, type ModelMessage, type LanguageModelResponseMetadata } from 'ai';
import { detect, recordCall, recordResult, resetHistory } from './loop-detection';
import { isRetryable, calculateDelay, sleep } from './retry';

// 最多执行多少步
const MAX_STEPS = 15;
// 最多重试几次
const MAX_RETRIES = 3;

// 预算状态
export interface BudgetState {
  used: number;
  limit: number;
}

export async function agentLoop(
  model: any,
  tools: any,
  messages: ModelMessage[],
  system: string,
  budget: BudgetState,
) {
  let step = 0;
  resetHistory();

  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    // 记录本步是否调用工具，用于决定是否继续请求模型。
    let hasToolCall = false;
    let fullText = '';
    let shouldBreak = false;
    let lastToolCall: { name: string; input: unknown } | null = null;
    let stepResponse: Awaited<LanguageModelResponseMetadata>;
    let stepUsage: Awaited<ReturnType<typeof streamText>['usage']>;

    // 步骤级重试：包裹整个 stream 消费过程
    for (let attempt = 1; ; attempt++) {
      try {
        const result = streamText({
          model,
          system,
          tools,
          messages,
          providerOptions: {
            openai: {
              reasoningEffort: 'low',
            },
          },
          maxRetries: 0,
          onError: () => { }
        });

        // 按事件类型展示回复文本、工具参数和执行结果。
        for await (const part of result.stream) {
          switch (part.type) {
            case 'text-delta':
              // 控制台输出
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            case 'tool-call': {
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              console.log(`  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`);

              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  ${detection.message}`);
                if (detection.level === 'critical') {
                  shouldBreak = true;
                } else {
                  messages.push({
                    role: 'user' as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              recordCall(part.toolName, part.input);
              break;
            }

            case 'tool-result':
              console.log(`  [结果: ${JSON.stringify(part.output)}]`);
              if (lastToolCall) {
                recordResult(lastToolCall.name, lastToolCall.input, part.output);
              }
              break;
          }
        }

        stepResponse = (await result.finalStep).response
        // 本次对话的消耗 token 信息
        stepUsage = await result.usage;

        break;
      } catch (error) {
        // 超过重试次数--直接抛错
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(`  [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`);
        await sleep(delay);
        hasToolCall = false;
        fullText = '';
        shouldBreak = false;
        lastToolCall = null;
      }
    }

    if (shouldBreak) {
      console.log('\n[循环检测触发，Agent 已停止]');
      break;
    }

    messages.push(...stepResponse!.messages);

    // Token 预算追踪：budget 由调用方持有，跨轮持续累计-输入输出 token
    const inp = typeof stepUsage?.inputTokens === 'number' ? stepUsage.inputTokens : (stepUsage?.inputTokens ?? 0);
    const out = typeof stepUsage?.outputTokens === 'number' ? stepUsage.outputTokens : (stepUsage?.outputTokens ?? 0);
    budget.used += inp + out;

    const pct = Math.round(budget.used / budget.limit * 100);
    console.log(`  [Token] ${budget.used}/${budget.limit} (${pct}%)`);
    if (budget.used > budget.limit) {
      console.log('\n[Token 预算耗尽，强制停止]');
      break;
    }

    // 本步没有工具调用时，结束本轮循环。
    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log('  → 继续下一步...');
  }

  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数限制，强制停止]');
  }
}
