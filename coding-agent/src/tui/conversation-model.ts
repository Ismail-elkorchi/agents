export type CodingAgentTuiConversationEntry =
  | CodingAgentTuiUserEntry
  | CodingAgentTuiAssistantEntry
  | CodingAgentTuiReasoningEntry
  | CodingAgentTuiActivityEntry
  | CodingAgentTuiNoticeEntry;

export interface CodingAgentTuiUserEntry {
  readonly id: string;
  readonly kind: 'user';
  readonly text: string;
}

export interface CodingAgentTuiAssistantEntry {
  readonly id: string;
  readonly kind: 'assistant';
  readonly turnId: string;
  readonly text: string;
  readonly status: 'streaming' | 'complete' | 'interrupted';
}

export interface CodingAgentTuiReasoningEntry {
  readonly id: string;
  readonly kind: 'reasoning';
  readonly turnId: string;
  readonly text: string;
}

export interface CodingAgentTuiActivityEntry {
  readonly id: string;
  readonly kind: 'activity';
  readonly activity: 'tool' | 'check';
  readonly label: string;
  readonly status: 'running' | 'success' | 'warning' | 'failed';
  readonly summary?: string;
  readonly details?: string;
}

export interface CodingAgentTuiNoticeEntry {
  readonly id: string;
  readonly kind: 'notice';
  readonly tone: 'info' | 'success' | 'warning' | 'error';
  readonly text: string;
}
