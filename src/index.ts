import 'dotenv/config';
import { streamText, stepCountIs } from 'ai';
import type { ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai';
import { createInterface } from 'node:readline'
import { weatherTool, calculatorTool } from './tools/utility-tools';
import { agentLoop } from './agent-loop'


// 每轮模型请求共用的行为说明。
const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

// 通过环境变量指定的 OpenAI 兼容接口连接模型服务。
const oai = createOpenAI({
  baseURL: process.env.OPEN_AI_BASE_URL,
  apiKey: process.env.OPEN_AI_API_KEY,
});

const model = oai.chat('deepseek-v4.1-flash-1017')

// 注册模型可调用的工具，键名就是工具名称。
const tools = { get_weather: weatherTool, calculator: calculatorTool };

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

    // 执行本轮模型与工具交互，并由循环更新对话历史。
    await agentLoop(model, tools, messages, SYSTEM);

    // 本轮回复结束后，再等待下一次输入。
    ask()
  })
}

console.log('Mini Agent v0.1 (type "exit" to quit)\n');
ask();
