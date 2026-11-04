import 'dotenv/config';
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const oai = createOpenAI({
  baseURL: 'https://maas-api.cn-huabei-1.xf-yun.com/v1',
  apiKey: process.env.API_KEY,
});

const model = oai.chat('spark-x2.6')

async function main() {
  const result = streamText({
    model,
    prompt: '写一个科幻风格的 1000 字小说，题材不限',
  });

  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
  }

  console.log(); // 换行
}

main();
