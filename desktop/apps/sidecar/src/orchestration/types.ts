export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type OrchestrationChannel = 'in_app' | 'telegram';

export type ContextPack = {
  intentGuess: string;
  conversationSummary: string;
  toolContext: {
    enabledTools: string[];
    attachments: Array<{ id?: string; name?: string; mimeType?: string }>;
  };
  constraints: {
    mode: 'quick' | 'deep';
    channel: OrchestrationChannel;
    requiresLocalFirst: boolean;
  };
  userPrefs: Record<string, unknown>;
  latestUserMessage: string;
};

export type ToolCall =
  | {
      id: string;
      tool: 'calendar.summary';
      args: { mode: 'today' | 'week'; anchorDate?: string };
      sideEffect: false;
    }
  | {
      id: string;
      tool: 'calendar.events';
      args: { mode: 'today' | 'week'; anchorDate?: string };
      sideEffect: false;
    }
  | {
      id: string;
      tool: 'email.draft.generate';
      args: {
        to: string[];
        prompt: string;
        tone?: 'professional' | 'friendly' | 'concise';
        requestedBy?: string;
      };
      sideEffect: true;
    }
  | {
      id: string;
      tool: 'email.send';
      args: Record<string, unknown>;
      sideEffect: true;
    }
  | {
      id: string;
      tool: 'calendar.event.create';
      args: Record<string, unknown>;
      sideEffect: true;
    }
  | {
      id: string;
      tool: 'delete.resource';
      args: Record<string, unknown>;
      sideEffect: true;
    };

export type ExecutionPlan = {
  intent: string;
  steps: string[];
  toolCalls: ToolCall[];
  artifacts: string[];
  riskLevel: 'low' | 'medium' | 'high';
};

export type JudgeDecision = {
  status: 'proceed' | 'needs_clarification' | 'requires_approval' | 'blocked';
  requiredFields: string[];
  policyNotes: string[];
  requiresApproval: boolean;
};

export type ToolExecutionResult = {
  toolCallId: string;
  tool: ToolCall['tool'];
  ok: boolean;
  data?: unknown;
  error?: string;
};

export type QuickAction = {
  id: string;
  label: string;
  action: 'approve' | 'clarify' | 'view_calendar' | 'view_draft' | 'retry' | 'open_actions';
  payload?: Record<string, unknown>;
};

export type UiCard =
  | {
      type: 'CalendarSummaryCard';
      title: string;
      summary: string;
      data: Record<string, unknown>;
    }
  | {
      type: 'DraftEmailPreviewCard';
      title: string;
      data: Record<string, unknown>;
    }
  | {
      type: 'ApprovalActionCard';
      title: string;
      data: Record<string, unknown>;
    }
  | {
      type: 'ClarificationPromptCard';
      title: string;
      data: { requiredFields: string[]; prompt: string };
    }
  | {
      type: 'ProjectGenerationCard';
      title: string;
      data: Record<string, unknown>;
    };

export type OrchestrationResponse = {
  runId: string;
  messageText: string;
  cards: UiCard[];
  quickActions: QuickAction[];
  decision: JudgeDecision;
  toolResults: ToolExecutionResult[];
};

export type OrchestratorInput = {
  conversationId?: string;
  mode: 'quick' | 'deep';
  model: string;
  messages: ChatMessage[];
  tools?: string[];
  channel?: OrchestrationChannel;
  attachments?: Array<{ id?: string; name?: string; mimeType?: string }>;
  userPrefs?: Record<string, unknown>;
};
