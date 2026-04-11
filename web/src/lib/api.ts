// API client — 简单 fetch wrapper

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

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
