export type ReasoningMode = 'quick' | 'deep';

export type ModelProfile = {
  mode: ReasoningMode;
  model: string;
  maxTokens: number;
  temperature: number;
  toolUse: boolean;
};

const DEFAULTS: Record<ReasoningMode, ModelProfile> = {
  quick: {
    mode: 'quick',
    model: 'llama3:8b',
    maxTokens: 512,
    temperature: 0.4,
    toolUse: false,
  },
  deep: {
    mode: 'deep',
    model: 'llama3:70b',
    maxTokens: 2048,
    temperature: 0.7,
    toolUse: true,
  },
};

export function resolveModelProfile(mode: ReasoningMode, explicitModel?: string): ModelProfile {
  const base = DEFAULTS[mode];
  return { ...base, model: explicitModel || base.model };
}
