export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
};

export type ApprovalStatus = 'prepared' | 'approved' | 'executed' | 'failed' | 'cancelled';

export type ApprovalAction = {
  id: string;
  actionType: string;
  targetType: string;
  targetRef?: string | null;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  requestedBy: string;
  approvedBy?: string | null;
  errorDetails?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuditEntry = {
  id: string;
  timestamp: string;
  actionType: string;
  targetType?: string | null;
  targetRef?: string | null;
  status: string;
  details?: Record<string, unknown> | null;
  errorDetails?: string | null;
};
