// screens/ControlScreen.tsx
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, Switch, FlatList, ActivityIndicator } from 'react-native';
import { supabase } from '../lib/supabase';
import { useDevice } from '../hooks/useDevice';
import { formatDateTime } from '../lib/utils';
import type { ActuatorState, ActuatorKind, ControlLog } from '../lib/types';

const DEFAULT_STATE: Pick<ActuatorState, 'fan_state' | 'light_state'> = {
  fan_state: false,
  light_state: false,
};

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
  const field = actuator === 'fan' ? 'fan_state' : 'light_state';

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

export default function ControlScreen() {
  const { deviceId, loading: deviceLoading, error: deviceError } = useDevice();
  const [state, setState] = useState<Pick<ActuatorState, 'fan_state' | 'light_state'>>(DEFAULT_STATE);
  const [logs, setLogs] = useState<ControlLog[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!deviceId) {
      // useDevice đã xong (thành công hoặc lỗi) nhưng không có deviceId
      // -> đừng để loading treo mãi
      setLoading(false);
      return;
    }
    try {
      setLoadError(null);
      const [actuator, controlLogs] = await Promise.all([
        fetchActuatorState(deviceId),
        fetchControlLogs(deviceId),
      ]);
      setState(actuator ?? DEFAULT_STATE);
      setLogs(controlLogs);
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
    setState((prev) => ({ ...prev, [actuator === 'fan' ? 'fan_state' : 'light_state']: value }));
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
      </View>

      <Text style={styles.subHeader}>Lịch sử điều khiển</Text>
      <FlatList
        data={logs}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <View style={styles.logItem}>
            <Text style={styles.logText}>
              {item.action === 'on' ? 'Bật' : 'Tắt'} {item.actuator === 'fan' ? 'quạt' : 'đèn'}
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
  row: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  controlCard: { flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 16, alignItems: 'center', gap: 8 },
  controlLabel: { fontSize: 14, fontWeight: '600', color: '#333' },
  subHeader: { fontSize: 16, fontWeight: '600', marginBottom: 8, color: '#333' },
  logItem: { backgroundColor: '#fff', borderRadius: 8, padding: 10, marginBottom: 6 },
  logText: { fontSize: 14, fontWeight: '600', color: '#333' },
  logMeta: { fontSize: 12, color: '#888', marginTop: 2 },
  emptyText: { textAlign: 'center', color: '#999', padding: 16 },
  errorText: { color: '#e74c3c', textAlign: 'center', padding: 16 },
});
