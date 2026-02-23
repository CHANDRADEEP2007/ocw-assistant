import 'dotenv/config';
import path from 'node:path';

export const config = {
  port: Number(process.env.PORT || 4318),
  ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  dbPath: path.resolve(process.cwd(), process.env.OCW_DB_PATH || './ocw_assistant.db'),
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://127.0.0.1:8765/oauth/google/callback',
  tokenServiceName: process.env.OCW_TOKEN_SERVICE || 'ocw-assistant',
};
