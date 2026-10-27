// lib/types.ts
// Định nghĩa type dùng chung cho dữ liệu Supabase trong toàn app

export interface SensorReading {
  temperature: number | null;
  humidity: number | null;
  soil_moisture: number | null;
  recorded_at: string; // ISO timestamp
}

export type ActuatorMode = 'manual' | 'auto';

export interface ActuatorState {
  device_id: string;
  fan_state: boolean;
  light_state: boolean;
  pump_state: boolean;
  mode: ActuatorMode;
  updated_at: string;
}

export type ActuatorKind = 'fan' | 'light' | 'pump';
export type ActuatorAction = 'on' | 'off';

export interface ControlLog {
  id: number;
  device_id: string;
  actuator: ActuatorKind;
  action: ActuatorAction;
  mode: ActuatorMode;
  triggered_by: string | null;
  created_at: string;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertRow {
  id: string;
  device_id: string | null;
  type: string;
  message: string;
  severity: AlertSeverity;
  is_read: boolean;   
  name: string;
  plant_code: string;
  planting_date: string; // YYYY-MM-DD
  pesticide: string | null;
  fertilizer_type: string | null;
  notes: string | null;
  created_at: string;
}

export interface PlantPhoto {
  id: string;
  plant_id: string;
  storage_path: string;
  taken_by: string | null;
  taken_at: string;
}

export interface RangeOption {
  key: string;
  label: string;
  days: number;
}

export interface Schedule {
  id: string;
  device_id: string;
  actuator: ActuatorKind;
  action: ActuatorAction;
  time_of_day: string;       // 'HH:MM:SS' từ Postgres
  specific_dates: string[];    // 0=CN,1=T2,...6=T7
  enabled: boolean;
  created_by: string | null;
  last_triggered_at: string | null;
  created_at: string;
}