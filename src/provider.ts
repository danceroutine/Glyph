export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface TurnResult {
  usage: Usage | null;
  responseId: string;
}

export interface ChatProvider {
  readonly model: string;
  reset(): void;
  send(text: string, options: {
    signal: AbortSignal;
    onText: (delta: string) => void;
  }): Promise<TurnResult>;
}
