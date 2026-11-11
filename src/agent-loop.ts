import { streamText, type ModelMessage } from 'ai';

// 限制一轮用户输入触发的模型请求次数。
const MAX_STEPS = 10;

// 逐步执行模型请求，直接更新调用方传入的消息数组。
export async function agentLoop(model: any, tools: any, messages: ModelMessage[], system: string) {
  let step = 0;

  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    const result = streamText({
      model,
      system,
      tools,
      messages,
      // 不设 stopWhen，每次只跑一步
    });

    // 记录本步是否调用工具，用于决定是否继续请求模型。
    let hasToolCall = false;
    let fullText = '';

    // 按事件类型展示回复文本、工具参数和执行结果。
    for await (const part of result.stream) {
      switch (part.type) {
        case 'text-delta':
          process.stdout.write(part.text);
          fullText += part.text;
          break;

        case 'tool-call':
          hasToolCall = true;
          console.log(`  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`);
          break;

        case 'tool-result':
          console.log(`  [结果: ${JSON.stringify(part.output)}]`);
          break;
      }
    }

    // 保存本步响应消息，包括工具调用及结果，供后续请求使用。
    const stepMessages = (await result.finalStep).response;
    messages.push(...stepMessages.messages);

    // 本步没有工具调用时，结束本轮循环。
    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    // 下一步请求携带工具结果，让模型继续生成回复。
    console.log('  → 模型还在工作，继续下一步...');
  }

  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数限制，强制停止]');
  }
}
