// screens/ControlScreen.tsx
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, Switch, FlatList, ActivityIndicator, TextInput, TouchableOpacity, Alert, Modal } from 'react-native';
import { supabase } from '../lib/supabase';
import { useDevice } from '../hooks/useDevice';
import { formatDateTime } from '../lib/utils';
import type { ActuatorState, ActuatorKind, ActuatorAction, ControlLog, Schedule } from '../lib/types';

const DEFAULT_STATE: Pick<ActuatorState, 'fan_state' | 'light_state' | 'pump_state'> = {
  fan_state: false,
  light_state: false,
  pump_state: false,
};

const ACTUATOR_LABEL: Record<ActuatorKind, string> = {
  fan: 'Quạt',
  light: 'Đèn',
  pump: 'Máy bơm',
};

const WEEKDAY_HEADERS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

async function fetchActuatorState(deviceId: string): Promise<ActuatorState | null> {
  const { data, error } = await supabase
    .from('actuator_states')
    .select('*')
    .eq('device_id', deviceId)
    .maybeSingle();
  if (error) throw error;
  return data as ActuatorState | null;
}

async function fetchControlLogs(deviceId: string): Promise<ControlLog[]> {
  const { data, error } = await supabase
    .from('control_logs')
    .select('*')
    .eq('device_id', deviceId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as ControlLog[];
}

async function toggleActuator(
  deviceId: string,
  actuator: ActuatorKind,
  newValue: boolean,
  userId: string
): Promise<void> {
  const field = `${actuator}_state`;

  const { error: upsertError } = await supabase
    .from('actuator_states')
    .upsert(
      { device_id: deviceId, [field]: newValue, mode: 'manual', updated_at: new Date().toISOString() },
      { onConflict: 'device_id' }
    );
  if (upsertError) throw upsertError;

  const { error: logError } = await supabase.from('control_logs').insert({
    device_id: deviceId,
    actuator,
    action: newValue ? 'on' : 'off',
    mode: 'manual',
    triggered_by: userId,
  });
  if (logError) throw logError;
}

async function fetchSchedules(deviceId: string): Promise<Schedule[]> {
  const { data, error } = await supabase
    .from('schedules')
    .select('*')
    .eq('device_id', deviceId)
    .order('time_of_day', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Schedule[];
}

async function createSchedule(payload: {
  device_id: string;
  actuator: ActuatorKind;
  action: ActuatorAction;
  time_of_day: string; // 'HH:MM'
  specific_dates: string[]; // 'YYYY-MM-DD'
  created_by: string | null;
}): Promise<void> {
  const { error } = await supabase.from('schedules').insert({
    ...payload,
    time_of_day: `${payload.time_of_day}:00`,
  });
  if (error) throw error;
}

async function setScheduleEnabled(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from('schedules').update({ enabled }).eq('id', id);
  if (error) throw error;
}

async function deleteSchedule(id: string): Promise<void> {
  const { error } = await supabase.from('schedules').delete().eq('id', id);
  if (error) throw error;
}

// Tự động chèn dấu ":" khi gõ giờ: HH -> HH: -> HH:MM
function formatTimeInput(text: string): string {
  const digits = text.replace(/\D/g, '').slice(0, 4);
  if (digits.length > 2) return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  return digits;
}

function isValidTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function formatScheduleTime(iso: string): string {
  return iso.slice(0, 5); // 'HH:MM:SS' -> 'HH:MM'
}

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateKeyDisplay(key: string): string {
  const [, m, d] = key.split('-');
  return `${d}/${m}`;
}

function buildCalendarCells(viewYear: number, viewMonth: number): (Date | null)[] {
  const firstDay = new Date(viewYear, viewMonth, 1);
  const startOffset = firstDay.getDay(); // 0 = CN
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(viewYear, viewMonth, d));
  return cells;
}

interface CalendarPickerProps {
  selectedDates: string[];
  onToggleDate: (key: string) => void;
}

function CalendarPicker({ selectedDates, onToggleDate }: CalendarPickerProps) {
  const today = new Date();
  const [viewYear, setViewYear] = useState<number>(today.getFullYear());
  const [viewMonth, setViewMonth] = useState<number>(today.getMonth());

  const cells = buildCalendarCells(viewYear, viewMonth);

  const goPrevMonth = (): void => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  };
  const goNextMonth = (): void => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  return (
    <View>
      <View style={styles.calendarNavRow}>
        <TouchableOpacity onPress={goPrevMonth} style={styles.calendarNavBtnBox}>
          <Text style={styles.calendarNavBtn}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.calendarMonthLabel}>
          Tháng {viewMonth + 1}/{viewYear}
        </Text>
        <TouchableOpacity onPress={goNextMonth} style={styles.calendarNavBtnBox}>
          <Text style={styles.calendarNavBtn}>›</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.calendarWeekRow}>
        {WEEKDAY_HEADERS.map((w) => (
          <Text key={w} style={styles.calendarWeekHeader}>
            {w}
          </Text>
        ))}
      </View>

      <View style={styles.calendarGrid}>
        {cells.map((date, idx) => {
          if (!date) return <View key={idx} style={styles.calendarDateCell} />;
          const key = toDateKey(date);
          const selected = selectedDates.includes(key);
          return (
            <TouchableOpacity
              key={idx}
              style={[styles.calendarDateCell, selected && styles.calendarDateCellActive]}
              onPress={() => onToggleDate(key)}
            >
              <Text style={[styles.calendarDateText, selected && styles.calendarDateTextActive]}>
                {date.getDate()}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

interface ScheduleFormProps {
  onSubmit: (payload: {
    actuator: ActuatorKind;
    action: ActuatorAction;
    time: string;
    dates: string[];
  }) => void;
  saving: boolean;
}

function ScheduleForm({ onSubmit, saving }: ScheduleFormProps) {
  const [actuator, setActuator] = useState<ActuatorKind>('fan');
  const [action, setAction] = useState<ActuatorAction>('on');
  const [time, setTime] = useState<string>('');
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [calendarVisible, setCalendarVisible] = useState<boolean>(false);

  const toggleDate = (key: string): void => {
    setSelectedDates((prev) => (prev.includes(key) ? prev.filter((d) => d !== key) : [...prev, key].sort()));
  };

  const datesSummary =
    selectedDates.length === 0
      ? 'Chọn ngày cụ thể'
      : selectedDates.length <= 3
      ? selectedDates.map(formatDateKeyDisplay).join(', ')
      : `${selectedDates.length} ngày đã chọn`;

  const handleSubmit = (): void => {
    if (!isValidTime(time)) {
      Alert.alert('Giờ không hợp lệ', 'Vui lòng nhập đúng định dạng HH:MM');
      return;
    }
    if (selectedDates.length === 0) {
      Alert.alert('Thiếu thông tin', 'Vui lòng chọn ít nhất 1 ngày trên lịch');
      return;
    }
    onSubmit({ actuator, action, time, dates: selectedDates });
    setTime('');
    setSelectedDates([]);
  };

  return (
    <View style={styles.scheduleForm}>
      <View style={styles.pickerRow}>
        {(['fan', 'light', 'pump'] as ActuatorKind[]).map((a) => (
          <TouchableOpacity
            key={a}
            style={[styles.chip, actuator === a && styles.chipActive]}
            onPress={() => setActuator(a)}
          >
            <Text style={[styles.chipText, actuator === a && styles.chipTextActive]}>{ACTUATOR_LABEL[a]}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.pickerRow}>
        {(['on', 'off'] as ActuatorAction[]).map((a) => (
          <TouchableOpacity
            key={a}
            style={[styles.chip, action === a && styles.chipActive]}
            onPress={() => setAction(a)}
          >
            <Text style={[styles.chipText, action === a && styles.chipTextActive]}>
              {a === 'on' ? 'Bật' : 'Tắt'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <TextInput
        style={styles.timeInput}
        placeholder="Giờ (HH:MM)"
        placeholderTextColor="#999"
        value={time}
        onChangeText={(text) => setTime(formatTimeInput(text))}
        keyboardType="number-pad"
        maxLength={5}
      />

      <TouchableOpacity style={styles.dayPickerBox} onPress={() => setCalendarVisible(true)}>
        <Text style={styles.dayPickerText}>{datesSummary}</Text>
      </TouchableOpacity>

      <Modal visible={calendarVisible} transparent animationType="fade" onRequestClose={() => setCalendarVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.calendarBox}>
            <Text style={styles.calendarTitle}>Chọn ngày chạy lịch</Text>
            <CalendarPicker selectedDates={selectedDates} onToggleDate={toggleDate} />
            <TouchableOpacity style={styles.calendarDoneButton} onPress={() => setCalendarVisible(false)}>
              <Text style={styles.buttonText}>Xong ({selectedDates.length} ngày)</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <TouchableOpacity style={styles.addScheduleButton} onPress={handleSubmit} disabled={saving}>
        <Text style={styles.buttonText}>{saving ? 'Đang lưu...' : '+ Thêm lịch hẹn giờ'}</Text>
      </TouchableOpacity>
    </View>
  );
}

interface ScheduleRowProps {
  schedule: Schedule;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}

function ScheduleRow({ schedule, onToggle, onDelete }: ScheduleRowProps) {
  const datesText =
    schedule.specific_dates.length <= 3
      ? schedule.specific_dates.map(formatDateKeyDisplay).join(', ')
      : `${schedule.specific_dates.length} ngày`;

  return (
    <View style={styles.scheduleItem}>
      <View style={{ flex: 1 }}>
        <Text style={styles.scheduleText}>
          {schedule.action === 'on' ? 'Bật' : 'Tắt'} {ACTUATOR_LABEL[schedule.actuator].toLowerCase()} lúc{' '}
          {formatScheduleTime(schedule.time_of_day)}
        </Text>
        <Text style={styles.logMeta}>{datesText}</Text>
      </View>
      <Switch value={schedule.enabled} onValueChange={(v) => onToggle(schedule.id, v)} trackColor={{ true: '#2e8b57' }} />
      <TouchableOpacity onPress={() => onDelete(schedule.id)} style={styles.deleteBtn}>
        <Text style={styles.deleteText}>🗑</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function ControlScreen() {
  const { deviceId, loading: deviceLoading, error: deviceError } = useDevice();
  const [state, setState] = useState<Pick<ActuatorState, 'fan_state' | 'light_state' | 'pump_state'>>(DEFAULT_STATE);
  const [logs, setLogs] = useState<ControlLog[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [savingSchedule, setSavingSchedule] = useState<boolean>(false);

  const load = useCallback(async (): Promise<void> => {
    if (!deviceId) {
      setLoading(false);
      return;
    }
    try {
      setLoadError(null);
      const [actuator, controlLogs, scheduleList] = await Promise.all([
        fetchActuatorState(deviceId),
        fetchControlLogs(deviceId),
        fetchSchedules(deviceId),
      ]);
      setState(actuator ?? DEFAULT_STATE);
      setLogs(controlLogs);
      setSchedules(scheduleList);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Không tải được dữ liệu điều khiển';
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!deviceId) return;
    const channel = supabase
      .channel(`control-${deviceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'actuator_states', filter: `device_id=eq.${deviceId}` },
        (payload) => setState(payload.new as ActuatorState)
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'control_logs', filter: `device_id=eq.${deviceId}` },
        (payload) => {
          const newLog = payload.new as ControlLog;
          setLogs((prev) => [newLog, ...prev].slice(0, 20));
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [deviceId]);

  const handleToggle = async (actuator: ActuatorKind, value: boolean): Promise<void> => {
    setState((prev) => ({ ...prev, [`${actuator}_state`]: value }));
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user || !deviceId) return;
    try {
      await toggleActuator(deviceId, actuator, value, user.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lỗi không xác định';
      console.warn('Lỗi điều khiển:', message);
    }
  };

  const handleAddSchedule = async (payload: {
    actuator: ActuatorKind;
    action: ActuatorAction;
    time: string;
    dates: string[];
  }): Promise<void> => {
    if (!deviceId) return;
    setSavingSchedule(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    try {
      await createSchedule({
        device_id: deviceId,
        actuator: payload.actuator,
        action: payload.action,
        time_of_day: payload.time,
        specific_dates: payload.dates,
        created_by: user?.id ?? null,
      });
      const updated = await fetchSchedules(deviceId);
      setSchedules(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Không thêm được lịch hẹn giờ';
      Alert.alert('Lỗi', message);
    } finally {
      setSavingSchedule(false);
    }
  };

  const handleToggleSchedule = async (id: string, enabled: boolean): Promise<void> => {
    setSchedules((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
    try {
      await setScheduleEnabled(id, enabled);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lỗi không xác định';
      console.warn('Lỗi cập nhật lịch:', message);
    }
  };

  const handleDeleteSchedule = async (id: string): Promise<void> => {
    setSchedules((prev) => prev.filter((s) => s.id !== id));
    try {
      await deleteSchedule(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lỗi không xác định';
      console.warn('Lỗi xoá lịch:', message);
    }
  };

  if (deviceLoading || loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2e8b57" />
      </View>
    );
  }

  if (deviceError || !deviceId || loadError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{deviceError ?? loadError ?? 'Không tìm thấy thiết bị'}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Điều khiển thiết bị</Text>

      <View style={styles.row}>
        <View style={styles.controlCard}>
          <Text style={styles.controlLabel}>Đèn</Text>
          <Switch value={!!state.fan_state} onValueChange={(v) => handleToggle('fan', v)} trackColor={{ true: '#2e8b57' }} />
        </View>
        <View style={styles.controlCard}>
          <Text style={styles.controlLabel}>Quạt</Text>
          <Switch value={!!state.light_state} onValueChange={(v) => handleToggle('light', v)} trackColor={{ true: '#2e8b57' }} />
        </View>
        <View style={styles.controlCard}>
          <Text style={styles.controlLabel}>Máy bơm</Text>
          <Switch value={!!state.pump_state} onValueChange={(v) => handleToggle('pump', v)} trackColor={{ true: '#2e8b57' }} />
        </View>
      </View>

      <FlatList
        data={logs}
        keyExtractor={(item) => String(item.id)}
        ListHeaderComponent={
          <>
            <Text style={styles.subHeader}>Hẹn giờ</Text>
            <ScheduleForm onSubmit={handleAddSchedule} saving={savingSchedule} />
            {schedules.map((s) => (
              <ScheduleRow key={s.id} schedule={s} onToggle={handleToggleSchedule} onDelete={handleDeleteSchedule} />
            ))}
            {schedules.length === 0 && <Text style={styles.emptyText}>Chưa có lịch hẹn giờ nào</Text>}

            <Text style={styles.subHeader}>Lịch sử điều khiển</Text>
          </>
        }
        renderItem={({ item }) => (
          <View style={styles.logItem}>
            <Text style={styles.logText}>
              {item.action === 'on' ? 'Bật' : 'Tắt'} {ACTUATOR_LABEL[item.actuator].toLowerCase()}
            </Text>
            <Text style={styles.logMeta}>
              {formatDateTime(item.created_at)} · {item.mode === 'manual' ? 'Thủ công' : 'Tự động'}
            </Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.emptyText}>Chưa có lịch sử</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f9f4', padding: 12 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { fontSize: 20, fontWeight: 'bold', color: '#2e8b57', marginBottom: 12, textAlign: 'center' },
  row: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  controlCard: { flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, alignItems: 'center', gap: 8 },
  controlLabel: { fontSize: 13, fontWeight: '600', color: '#333' },
  subHeader: { fontSize: 16, fontWeight: '600', marginBottom: 8, marginTop: 4, color: '#333' },
  logItem: { backgroundColor: '#fff', borderRadius: 8, padding: 10, marginBottom: 6 },
  logText: { fontSize: 14, fontWeight: '600', color: '#333' },
  logMeta: { fontSize: 12, color: '#888', marginTop: 2 },
  emptyText: { textAlign: 'center', color: '#999', padding: 16 },
  errorText: { color: '#e74c3c', textAlign: 'center', padding: 16 },

  scheduleForm: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 12, gap: 8 },
  pickerRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, backgroundColor: '#f4f9f4', borderWidth: 1, borderColor: '#ddd' },
  chipActive: { backgroundColor: '#2e8b57', borderColor: '#2e8b57' },
  chipText: { fontSize: 12, color: '#555' },
  chipTextActive: { color: '#fff', fontWeight: 'bold' },
  timeInput: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10, fontSize: 14, color: '#333' },
  addScheduleButton: { backgroundColor: '#2e8b57', borderRadius: 8, padding: 10, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: 'bold' },

  scheduleItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 8, padding: 10, marginBottom: 6, gap: 8 },
  scheduleText: { fontSize: 14, fontWeight: '600', color: '#333' },
  deleteBtn: { padding: 4 },
  deleteText: { fontSize: 16 },

  dayPickerBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10 },
  dayPickerIcon: { fontSize: 16 },
  dayPickerText: { fontSize: 14, color: '#333' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  calendarBox: { backgroundColor: '#fff', borderRadius: 16, padding: 20, width: '85%', gap: 16 },
  calendarTitle: { fontSize: 16, fontWeight: 'bold', color: '#333', textAlign: 'center' },

  calendarNavRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  calendarNavBtnBox: { padding: 8 },
  calendarNavBtn: { fontSize: 20, color: '#2e8b57', fontWeight: 'bold' },
  calendarMonthLabel: { fontSize: 15, fontWeight: 'bold', color: '#333' },
  calendarWeekRow: { flexDirection: 'row', marginTop: 8 },
  calendarWeekHeader: { flex: 1, textAlign: 'center', fontSize: 12, color: '#999', fontWeight: '600' },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  calendarDateCell: {
    width: '14.28%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 2,
  },
  calendarDateCellActive: { backgroundColor: '#2e8b57', borderRadius: 20 },
  calendarDateText: { fontSize: 13, color: '#333' },
  calendarDateTextActive: { color: '#fff', fontWeight: 'bold' },

  calendarDoneButton: { backgroundColor: '#2e8b57', borderRadius: 8, padding: 10, alignItems: 'center' },
});