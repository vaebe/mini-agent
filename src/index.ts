import 'dotenv/config';
import { streamText } from 'ai';
import type { ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai';
import { createInterface } from 'node:readline'

// 通过 OpenAI 兼容接口连接讯飞模型服务。
const oai = createOpenAI({
  baseURL: 'https://maas-api.cn-huabei-1.xf-yun.com/v1',
  apiKey: process.env.API_KEY,
});

const model = oai.chat('spark-x2.6')

// 从终端读取用户输入，并在终端显示提示。
const rl = createInterface({ input: process.stdin, output: process.stdout })

// 在当前进程中保存对话历史，供后续轮次使用。
const messages: ModelMessage[] = []

async function ask() {

  rl.question('\n你：', async (input) => {
    // 去除输入首尾的空白。
    const trimmed = input.trim()
    // 输入为空或输入 exit 时退出。
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!');
      rl.close();
      return;
    }

    // 向消息数组中添加用户输入的消息
    messages.push({ role: 'user', content: trimmed });

    // 携带历史消息和本轮输入，获取流式回复。
    const result = streamText({
      model,
      system: `你是 Mini Agent，一个专注于软件开发的 AI 助手。
你说话简洁直接，喜欢用代码示例来解释问题。
如果用户的问题不够清晰，你会反问而不是瞎猜。`,
      messages: messages,
    });

    process.stdout.write('Assistant: ');
    let fullResponse = '';

    // 文本片段到达时立即输出，同时累积完整回复。
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);

      fullResponse += chunk
    }

    // 将本轮回复加入历史，让下一轮对话保留上下文。
    messages.push({ role: 'assistant', content: fullResponse });

    console.log(); // 换行

    // 本轮回复结束后，再等待下一次输入。
    ask()
  })
}

console.log('Mini Agent v0.1 (type "exit" to quit)\n');
ask();
