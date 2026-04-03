import { useState } from 'react';
import { health, type HealthStats, type MedicalRecord, type Medication } from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import { Card, CardTitle, StatValue } from '@/components/Card';
import { clsx } from 'clsx';
import dayjs from 'dayjs';

function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try { return JSON.parse(json); } catch { return []; }
}

function RecordRow({ record, onClick }: { record: MedicalRecord; onClick: () => void }) {
  const diagnoses = parseJsonArray(record.diagnosis);
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-3 border-b border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors last:border-b-0"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-mono text-[var(--color-text-secondary)]">
            {dayjs(record.visit_date).format('MM-DD')}
          </span>
          <span className="font-medium">{record.hospital || '未知医院'}</span>
          {record.department && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
              {record.department}
            </span>
          )}
        </div>
      </div>
      {diagnoses.length > 0 && (
        <div className="mt-1 flex gap-1.5 flex-wrap">
          {diagnoses.map((d, i) => (
            <span key={i} className="text-xs px-2 py-0.5 rounded bg-[var(--color-primary)]/10 text-[var(--color-primary-light)]">
              {d}
            </span>
          ))}
        </div>
      )}
      {record.summary && (
        <p className="mt-1 text-sm text-[var(--color-text-secondary)] line-clamp-2">{record.summary}</p>
      )}
    </button>
  );
}

function RecordDetail({ record, onClose }: { record: any; onClose: () => void }) {
  const diagnoses = parseJsonArray(record.diagnosis);
  const meds = parseJsonArray(record.medications);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-xl max-w-lg w-full max-h-[80vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className="text-lg font-bold">{record.hospital || '就诊记录'}</h3>
            <p className="text-sm text-[var(--color-text-secondary)]">
              {dayjs(record.visit_date).format('YYYY-MM-DD')}
              {record.department && ` · ${record.department}`}
              {record.doctor && ` · ${record.doctor}`}
            </p>
          </div>
          <button onClick={onClose} className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)] text-xl">&times;</button>
        </div>

        {record.chief_complaint && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-[var(--color-text-secondary)] mb-1">主诉</div>
            <p className="text-sm">{record.chief_complaint}</p>
          </div>
        )}

        {diagnoses.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-[var(--color-text-secondary)] mb-1">诊断</div>
            <div className="flex gap-1.5 flex-wrap">
              {diagnoses.map((d, i) => (
                <span key={i} className="text-sm px-2 py-0.5 rounded bg-[var(--color-primary)]/10 text-[var(--color-primary-light)]">{d}</span>
              ))}
            </div>
          </div>
        )}

        {meds.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-[var(--color-text-secondary)] mb-1">用药</div>
            <ul className="text-sm space-y-0.5">
              {meds.map((m, i) => <li key={i}>· {typeof m === 'string' ? m : JSON.stringify(m)}</li>)}
            </ul>
          </div>
        )}

        {record.treatment && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-[var(--color-text-secondary)] mb-1">治疗方案</div>
            <p className="text-sm">{record.treatment}</p>
          </div>
        )}

        {record.doctor_advice && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-[var(--color-text-secondary)] mb-1">医嘱</div>
            <p className="text-sm">{record.doctor_advice}</p>
          </div>
        )}

        {record.summary && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-[var(--color-text-secondary)] mb-1">摘要</div>
            <p className="text-sm">{record.summary}</p>
          </div>
        )}

        {record.metrics?.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-[var(--color-text-secondary)] mb-1">检查指标</div>
            <div className="grid grid-cols-2 gap-2">
              {record.metrics.map((m: any, i: number) => (
                <div key={i} className="text-sm px-2 py-1 rounded bg-[var(--color-bg)] border border-[var(--color-border)]">
                  <span className="text-[var(--color-text-secondary)]">{m.metric_name}</span>
                  <span className="ml-2 font-medium">{m.value}{m.unit ? ` ${m.unit}` : ''}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function HealthDashboard() {
  const { data: stats, loading: statsLoading } = useQuery<HealthStats>(() => health.getStats(), []);
  const { data: recordsData, loading: recordsLoading } = useQuery(() => health.getRecords({ limit: '20' }), []);
  const { data: medications } = useQuery<Medication[]>(() => health.getActiveMedications(), []);

  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const handleRecordClick = async (id: number) => {
    setDetailLoading(true);
    try {
      const detail = await health.getRecord(id);
      setSelectedRecord(detail);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setDetailLoading(false);
    }
  };

  if (statsLoading && !stats) {
    return <div className="text-[var(--color-text-secondary)]">Loading...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h2 className="text-xl font-bold">Health Dashboard</h2>

      {/* Stats Overview */}
      {stats && (
        <Card>
          <CardTitle>Overview</CardTitle>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatValue value={stats.totalRecords} label="Total Records" />
            <StatValue value={stats.totalMetrics} label="Health Metrics" />
            <StatValue value={stats.activeMedications} label="Active Medications" color={stats.activeMedications > 0 ? 'text-[var(--color-warning)]' : undefined} />
            <StatValue value={stats.departments?.length || 0} label="Departments" />
          </div>
        </Card>
      )}

      {/* Active Medications */}
      {medications && medications.length > 0 && (
        <Card>
          <CardTitle>Active Medications</CardTitle>
          <div className="space-y-2">
            {medications.map((med) => (
              <div key={med.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
                <div>
                  <span className="font-medium">{med.medication_name}</span>
                  {med.dosage && <span className="ml-2 text-sm text-[var(--color-text-secondary)]">{med.dosage}</span>}
                </div>
                {med.frequency && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-warning)]/10 text-[var(--color-warning)]">
                    {med.frequency}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Recent Records */}
      <Card className="!p-0">
        <div className="px-5 pt-5 pb-2">
          <CardTitle>Recent Records</CardTitle>
        </div>
        {recordsLoading ? (
          <div className="px-5 pb-5 text-[var(--color-text-secondary)]">Loading...</div>
        ) : recordsData?.records.length === 0 ? (
          <div className="px-5 pb-5 text-[var(--color-text-secondary)]">No records yet</div>
        ) : (
          <div>
            {recordsData?.records.map((record) => (
              <RecordRow key={record.id} record={record} onClick={() => handleRecordClick(record.id)} />
            ))}
          </div>
        )}
      </Card>

      {/* Record Detail Modal */}
      {selectedRecord && (
        <RecordDetail record={selectedRecord} onClose={() => setSelectedRecord(null)} />
      )}

      {/* Loading overlay for detail */}
      {detailLoading && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="text-[var(--color-text-secondary)]">Loading...</div>
        </div>
      )}
    </div>
  );
}
