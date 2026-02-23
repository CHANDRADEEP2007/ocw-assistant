import { config } from '../config.js';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export async function ollamaChat(params: {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
}) {
  const res = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      stream: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ollama_http_${res.status}:${text}`);
  }

  return (await res.json()) as { message?: { content?: string } };
}
