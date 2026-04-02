// 健康管理 App — Service 层
import { Database } from 'bun:sqlite';
import { getDatabase } from '../../shared/db';
import { Logger } from '../../utils';

const logger = new Logger('HealthService');

// ---- Types ----

export interface MedicalRecord {
  id: number;
  visit_date: string;
  hospital: string | null;
  department: string | null;
  doctor: string | null;
  chief_complaint: string | null;
  diagnosis: string | null;      // JSON array
  medications: string | null;    // JSON array
  examinations: string | null;   // JSON array
  treatment: string | null;
  doctor_advice: string | null;
  follow_up_date: string | null;
  cost: number | null;
  tags: string | null;           // JSON array
  attachments: string | null;    // JSON array
  raw_analysis: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface HealthMetric {
  id: number;
  record_id: number;
  category: string;
  metric_name: string;
  value: string;
  numeric_value: number | null;
  unit: string | null;
  reference_range: string | null;
  is_abnormal: number;
  measured_at: string | null;
}

export interface Medication {
  id: number;
  record_id: number | null;
  medication_name: string;
  generic_name: string | null;
  dosage: string | null;
  frequency: string | null;
  route: string | null;
  start_date: string | null;
  end_date: string | null;
  is_active: number;
  notes: string | null;
}

export interface RecordListQuery {
  department?: string;
  diagnosis?: string;
  date_from?: string;
  date_to?: string;
  keyword?: string;
  limit?: number;
  offset?: number;
}

// ---- Service ----

export class HealthService {
  private db: Database;

  constructor() {
    this.db = getDatabase('health');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS medical_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        visit_date TEXT NOT NULL,
        hospital TEXT,
        department TEXT,
        doctor TEXT,
        chief_complaint TEXT,
        diagnosis TEXT,
        medications TEXT,
        examinations TEXT,
        treatment TEXT,
        doctor_advice TEXT,
        follow_up_date TEXT,
        cost REAL,
        tags TEXT,
        attachments TEXT,
        raw_analysis TEXT,
        summary TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS health_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        value TEXT NOT NULL,
        numeric_value REAL,
        unit TEXT,
        reference_range TEXT,
        is_abnormal INTEGER DEFAULT 0,
        measured_at TEXT,
        FOREIGN KEY (record_id) REFERENCES medical_records(id)
      );

      CREATE TABLE IF NOT EXISTS medication_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id INTEGER,
        medication_name TEXT NOT NULL,
        generic_name TEXT,
        dosage TEXT,
        frequency TEXT,
        route TEXT,
        start_date TEXT,
        end_date TEXT,
        is_active INTEGER DEFAULT 1,
        notes TEXT,
        FOREIGN KEY (record_id) REFERENCES medical_records(id)
      );

      CREATE INDEX IF NOT EXISTS idx_records_visit_date ON medical_records(visit_date);
      CREATE INDEX IF NOT EXISTS idx_records_department ON medical_records(department);
      CREATE INDEX IF NOT EXISTS idx_metrics_record_id ON health_metrics(record_id);
      CREATE INDEX IF NOT EXISTS idx_metrics_name ON health_metrics(metric_name);
      CREATE INDEX IF NOT EXISTS idx_medication_name ON medication_history(medication_name);
      CREATE INDEX IF NOT EXISTS idx_medication_active ON medication_history(is_active);
    `);
    logger.info('健康管理数据库 schema 已就绪');
  }

  // ---- Medical Records ----

  listRecords(query: RecordListQuery = {}): { records: MedicalRecord[]; total: number } {
    const conditions: string[] = [];
    const params: any[] = [];

    if (query.department) {
      conditions.push('department = ?');
      params.push(query.department);
    }
    if (query.diagnosis) {
      conditions.push('diagnosis LIKE ?');
      params.push(`%${query.diagnosis}%`);
    }
    if (query.date_from) {
      conditions.push('visit_date >= ?');
      params.push(query.date_from);
    }
    if (query.date_to) {
      conditions.push('visit_date <= ?');
      params.push(query.date_to);
    }
    if (query.keyword) {
      conditions.push('(summary LIKE ? OR chief_complaint LIKE ? OR hospital LIKE ?)');
      params.push(`%${query.keyword}%`, `%${query.keyword}%`, `%${query.keyword}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const total = this.db.prepare(`SELECT COUNT(*) as count FROM medical_records ${where}`).get(...params) as any;
    const records = this.db.prepare(
      `SELECT * FROM medical_records ${where} ORDER BY visit_date DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as MedicalRecord[];

    return { records, total: total.count };
  }

  getRecord(id: number): (MedicalRecord & { metrics: HealthMetric[]; medication_list: Medication[] }) | null {
    const record = this.db.prepare('SELECT * FROM medical_records WHERE id = ?').get(id) as MedicalRecord | null;
    if (!record) return null;

    const metrics = this.db.prepare('SELECT * FROM health_metrics WHERE record_id = ? ORDER BY category, metric_name').all(id) as HealthMetric[];
    const medication_list = this.db.prepare('SELECT * FROM medication_history WHERE record_id = ?').all(id) as Medication[];

    return { ...record, metrics, medication_list };
  }

  createRecord(data: Partial<MedicalRecord>): MedicalRecord {
    const stmt = this.db.prepare(`
      INSERT INTO medical_records (visit_date, hospital, department, doctor, chief_complaint, diagnosis, medications, examinations, treatment, doctor_advice, follow_up_date, cost, tags, attachments, raw_analysis, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.visit_date!, data.hospital ?? null, data.department ?? null, data.doctor ?? null,
      data.chief_complaint ?? null, data.diagnosis ?? null, data.medications ?? null,
      data.examinations ?? null, data.treatment ?? null, data.doctor_advice ?? null,
      data.follow_up_date ?? null, data.cost ?? null, data.tags ?? null,
      data.attachments ?? null, data.raw_analysis ?? null, data.summary ?? null
    );
    return this.getRecord(result.lastInsertRowid as number)! as MedicalRecord;
  }

  updateRecord(id: number, data: Partial<MedicalRecord>): MedicalRecord | null {
    const fields: string[] = [];
    const params: any[] = [];

    const allowedFields = [
      'visit_date', 'hospital', 'department', 'doctor', 'chief_complaint',
      'diagnosis', 'medications', 'examinations', 'treatment', 'doctor_advice',
      'follow_up_date', 'cost', 'tags', 'attachments', 'raw_analysis', 'summary'
    ];

    for (const field of allowedFields) {
      if (field in data) {
        fields.push(`${field} = ?`);
        params.push((data as any)[field]);
      }
    }

    if (fields.length === 0) return this.getRecord(id) as MedicalRecord | null;

    fields.push("updated_at = datetime('now', 'localtime')");
    params.push(id);

    this.db.prepare(`UPDATE medical_records SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return this.getRecord(id) as MedicalRecord | null;
  }

  deleteRecord(id: number): boolean {
    // 级联删除关联数据
    this.db.prepare('DELETE FROM health_metrics WHERE record_id = ?').run(id);
    this.db.prepare('DELETE FROM medication_history WHERE record_id = ?').run(id);
    const result = this.db.prepare('DELETE FROM medical_records WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ---- Health Metrics ----

  addMetrics(recordId: number, metrics: Partial<HealthMetric>[]): HealthMetric[] {
    const stmt = this.db.prepare(`
      INSERT INTO health_metrics (record_id, category, metric_name, value, numeric_value, unit, reference_range, is_abnormal, measured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const m of metrics) {
      stmt.run(recordId, m.category!, m.metric_name!, m.value!, m.numeric_value ?? null,
        m.unit ?? null, m.reference_range ?? null, m.is_abnormal ?? 0, m.measured_at ?? null);
    }

    return this.db.prepare('SELECT * FROM health_metrics WHERE record_id = ?').all(recordId) as HealthMetric[];
  }

  getMetricTrend(metricName: string, limit: number = 20): (HealthMetric & { visit_date: string; hospital: string })[] {
    return this.db.prepare(`
      SELECT m.*, r.visit_date, r.hospital
      FROM health_metrics m
      JOIN medical_records r ON m.record_id = r.id
      WHERE m.metric_name LIKE ?
      ORDER BY COALESCE(m.measured_at, r.visit_date) DESC
      LIMIT ?
    `).all(`%${metricName}%`, limit) as any[];
  }

  // ---- Medications ----

  getActiveMedications(): Medication[] {
    return this.db.prepare('SELECT * FROM medication_history WHERE is_active = 1 ORDER BY start_date DESC').all() as Medication[];
  }

  addMedication(data: Partial<Medication>): Medication {
    const result = this.db.prepare(`
      INSERT INTO medication_history (record_id, medication_name, generic_name, dosage, frequency, route, start_date, end_date, is_active, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.record_id ?? null, data.medication_name!, data.generic_name ?? null,
      data.dosage ?? null, data.frequency ?? null, data.route ?? null,
      data.start_date ?? null, data.end_date ?? null, data.is_active ?? 1, data.notes ?? null
    );
    return this.db.prepare('SELECT * FROM medication_history WHERE id = ?').get(result.lastInsertRowid) as Medication;
  }

  stopMedication(id: number): boolean {
    const result = this.db.prepare('UPDATE medication_history SET is_active = 0 WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ---- Stats ----

  getStats(): {
    total_records: number;
    total_metrics: number;
    active_medications: number;
    departments: { department: string; count: number }[];
    recent_visits: MedicalRecord[];
  } {
    const total_records = (this.db.prepare('SELECT COUNT(*) as c FROM medical_records').get() as any).c;
    const total_metrics = (this.db.prepare('SELECT COUNT(*) as c FROM health_metrics').get() as any).c;
    const active_medications = (this.db.prepare('SELECT COUNT(*) as c FROM medication_history WHERE is_active=1').get() as any).c;
    const departments = this.db.prepare(
      'SELECT department, COUNT(*) as count FROM medical_records WHERE department IS NOT NULL GROUP BY department ORDER BY count DESC'
    ).all() as any[];
    const recent_visits = this.db.prepare(
      'SELECT id, visit_date, hospital, department, summary FROM medical_records ORDER BY visit_date DESC LIMIT 5'
    ).all() as MedicalRecord[];

    return { total_records, total_metrics, active_medications, departments, recent_visits };
  }
}
