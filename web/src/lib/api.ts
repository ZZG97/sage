// API client — 简单 fetch wrapper

export class SageApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SageApiError';
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has('Content-Type') && options?.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new SageApiError(body.message || body.error || `HTTP ${res.status}`, res.status, body.error);
  }
  return res.json();
}

// ─── HTTP Auth ───

export interface HttpAuthStatus {
  authRequired: boolean;
  configured: boolean;
  authenticated: boolean;
}

export const httpAuth = {
  getStatus: () => request<HttpAuthStatus>('/auth/status'),
  createSession: (token: string) =>
    request<{ success: boolean; authRequired: boolean }>('/auth/session', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  clearSession: () =>
    request<{ success: boolean }>('/auth/session', {
      method: 'DELETE',
    }),
};

// ─── Management API ───

export interface SystemStatus {
  isRunning: boolean;
  agentProvider: string;
  sessionCount: number;
  activeCards: number;
  isDraining: boolean;
  activeProvider: string;
  availableProviders: string[];
  autoFallbackEnabled: boolean;
  isFallback: boolean;
  uptime: number;
  timestamp: string;
}

export interface ProviderInfo {
  activeProvider: string;
  availableProviders: string[];
  autoFallbackEnabled: boolean;
  isFallback: boolean;
}

export const management = {
  getStatus: () => request<SystemStatus>('/apps/management/status'),
  getProviders: () => request<ProviderInfo>('/apps/management/providers'),
  switchProvider: (name: string) =>
    request<{ success: boolean; activeProvider: string }>('/apps/management/providers/active', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  setFallback: (enabled: boolean) =>
    request<{ success: boolean; autoFallbackEnabled: boolean }>('/apps/management/fallback', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
};

// ─── Scheduler API ───

export interface BuiltinTask {
  name: string;
  pattern: string;
  allowInDev: boolean;
}

export interface WorkflowShellStep {
  id?: string;
  kind: 'shell';
  command: string;
  cwd?: string | null;
  timeoutSec?: number | null;
}

export interface WorkflowAgentStep {
  id?: string;
  kind: 'agent';
  prompt: string;
  title?: string | null;
}

export interface WorkflowPayload {
  version: 1;
  steps: Array<WorkflowShellStep | WorkflowAgentStep>;
}

export interface DynamicTask {
  id: string;
  kind: 'message' | 'agent' | 'workflow';
  message: string;
  title: string | null;
  payload: WorkflowPayload | null;
  pattern: string | null;
  trigger_at: number | null;
  status: string;
  created_at: number;
}

export interface CreateDynamicTaskInput {
  kind?: 'message' | 'agent' | 'workflow';
  message?: string;
  prompt?: string;
  description?: string;
  title?: string;
  topic?: string;
  workflow?: WorkflowPayload;
  payload?: WorkflowPayload;
  pattern?: string;
  triggerAt?: number;
}

export type UpdateDynamicTaskInput = CreateDynamicTaskInput;

export const schedulerApi = {
  getBuiltinTasks: () => request<{ tasks: BuiltinTask[] }>('/apps/management/scheduler/builtin'),
  runBuiltinTask: (name: string) =>
    request<{ success: boolean; task: string }>(`/apps/management/scheduler/builtin/${encodeURIComponent(name)}/run`, {
      method: 'POST',
    }),
  getDynamicTasks: (all = false) =>
    request<{ tasks: DynamicTask[] }>(`/apps/management/scheduler/tasks${all ? '?all=true' : ''}`),
  createDynamicTask: (input: CreateDynamicTaskInput) =>
    request<{ success: boolean; task: DynamicTask }>('/apps/management/scheduler/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateDynamicTask: (id: string, input: UpdateDynamicTaskInput) =>
    request<{ success: boolean; task: DynamicTask }>(`/apps/management/scheduler/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteDynamicTask: (id: string) =>
    request<{ success: boolean }>(`/apps/management/scheduler/tasks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};

// ─── Operations API ───

export type OperationStatus = 'running' | 'success' | 'warning' | 'failed' | 'cancelled';

export interface OperationRun {
  id: string;
  operation_type: string;
  operation_name: string;
  trigger_type: 'scheduler' | 'feishu' | 'http' | 'manual';
  status: OperationStatus;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  summary: string | null;
  metrics: Record<string, number | string | boolean | null>;
  error: string | null;
  metadata: Record<string, unknown>;
  request_id: string | null;
  trace_id: string | null;
  alerted_at: number | null;
}

export interface OperationsSummary {
  since: number;
  total: number;
  running: number;
  success: number;
  warning: number;
  failed: number;
  cancelled: number;
}

export const operationsApi = {
  getSummary: () => request<OperationsSummary>('/apps/operations/summary'),
  getRuns: (limit = 50) => request<{ runs: OperationRun[] }>(`/apps/operations/runs?limit=${limit}`),
};

// ─── Health API ───

export interface HealthStats {
  totalRecords: number;
  totalMetrics: number;
  activeMedications: number;
  departments: string[];
  recentVisits: Array<{
    id: number;
    visit_date: string;
    hospital: string | null;
    department: string | null;
    diagnosis: string | null;
    summary: string | null;
  }>;
}

export interface MedicalRecord {
  id: number;
  visit_date: string;
  hospital: string | null;
  department: string | null;
  doctor: string | null;
  chief_complaint: string | null;
  diagnosis: string | null;
  medications: string | null;
  treatment: string | null;
  doctor_advice: string | null;
  follow_up_date: string | null;
  attachments: string | null;
  summary: string | null;
  created_at: string;
}

export interface Medication {
  id: number;
  medication_name: string;
  dosage: string | null;
  frequency: string | null;
  start_date: string | null;
  status: string;
}

export interface MetricTrend {
  metric_name: string;
  value: string;
  unit: string | null;
  measured_at: string;
  visit_date: string | null;
}

export const health = {
  getStats: () => request<HealthStats>('/apps/health/stats'),
  getRecords: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<{ records: MedicalRecord[]; total: number }>(`/apps/health/records${qs}`);
  },
  getRecord: (id: number) => request<MedicalRecord & { metrics: any[]; medications: Medication[] }>(`/apps/health/records/${id}`),
  getActiveMedications: () => request<Medication[]>('/apps/health/medications/active'),
  getMetricTrend: (name: string, limit?: number) =>
    request<MetricTrend[]>(`/apps/health/metrics/trend/${encodeURIComponent(name)}${limit ? `?limit=${limit}` : ''}`),
};

// ─── Debug API ───

export interface DebugDatabaseInfo {
  name: string;
  tableCount: number;
}

export interface DebugTableColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface DebugTableInfo {
  name: string;
  columns: DebugTableColumn[];
  count: number;
  defaultOrderBy: string | null;
  defaultOrderDirection: 'desc';
}

export interface DebugRowsResult {
  table: string;
  columns: string[];
  count: number;
  rows: Record<string, unknown>[];
  orderBy: string | null;
  orderDirection: 'desc';
}

export const debugApi = {
  getDatabases: () => request<DebugDatabaseInfo[]>('/apps/debug/databases'),
  getTables: (database: string) =>
    request<DebugTableInfo[]>(`/apps/debug/tables?database=${encodeURIComponent(database)}`),
  getRows: (database: string, table: string, limit = 100) =>
    request<DebugRowsResult>(
      `/apps/debug/rows?database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}&limit=${limit}`,
    ),
};
