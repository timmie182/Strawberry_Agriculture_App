// screens/HomeScreen.tsx
// Trang chủ: cảm biến realtime + biểu đồ 24h + thống kê theo khoảng thời gian + lịch sử cảnh báo

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
  FlatList,
  Dimensions,
} from 'react-native';
import { LineChart } from 'react-native-chart-kit';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { useDevice } from '../hooks/useDevice';
import { sampleEvenly, formatTime, formatDateTime } from '../lib/utils';
import type { SensorReading, AlertRow, RangeOption } from '../lib/types';

const screenWidth = Dimensions.get('window').width;

const RANGES: RangeOption[] = [
  { key: '7d', label: '7 ngày', days: 7 },
  { key: '30d', label: '30 ngày', days: 30 },
  { key: '3m', label: '3 tháng', days: 90 },
];

// Chỉ giữ lại đúng maxVisible nhãn, chọn cách đều tuyệt đối trên toàn trục
// (tránh trường hợp nhãn cuối bị ép hiển thị dính sát nhãn liền trước nó)
function sparseLabels(labels: string[], maxVisible: number): string[] {
  if (labels.length <= maxVisible) return labels;
  const result = new Array(labels.length).fill('');
  const lastIndex = labels.length - 1;
  const visibleCount = Math.max(2, maxVisible);
  for (let i = 0; i < visibleCount; i++) {
    const idx = Math.round((i * lastIndex) / (visibleCount - 1));
    result[idx] = labels[idx];
  }
  return result;
}

async function fetchLast24h(deviceId: string): Promise<SensorReading[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('sensor_readings')
    .select('temperature, humidity, soil_moisture, recorded_at')
    .eq('device_id', deviceId)
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as SensorReading[];
}

async function fetchReadingsRange(deviceId: string, days: number): Promise<SensorReading[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('sensor_readings')
    .select('temperature, humidity, soil_moisture, recorded_at')
    .eq('device_id', deviceId)
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as SensorReading[];
}

async function fetchAlerts(deviceId: string): Promise<AlertRow[]> {
  const [sensorRes, plantRes] = await Promise.all([
    supabase
      .from('alertsic')
      .select('*')
      .eq('device_id', deviceId)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('alertsplant')
      .select('*')
      .eq('device_id', deviceId)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  if (sensorRes.error) throw sensorRes.error;
  if (plantRes.error) throw plantRes.error;

  const sensorAlerts: AlertRow[] = (sensorRes.data ?? []).map((row: any) => ({
    id: `ic-${row.id}`,
    device_id: row.device_id,
    type: row.type,
    message: row.message,
    severity: row.severity,
    is_read: row.is_read ?? false,
    created_at: row.created_at,
  }));

  const plantAlerts: AlertRow[] = (plantRes.data ?? []).map((row: any) => ({
    id: `plant-${row.id}`,
    device_id: row.device_id,
    type: row.type,
    message: row.message,
    severity: row.severity,
    is_read: false, // bảng này không có cột is_read
    created_at: row.created_at,
  }));

  // Gộp 2 nguồn, sắp xếp theo thời gian mới nhất, lấy 20 dòng đầu
  return [...sensorAlerts, ...plantAlerts]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 20);
}

interface SensorCardProps {
  label: string;
  value: number | null | undefined;
  unit: string;
  color: string;
}

function SensorCard({ label, value, unit, color }: SensorCardProps) {
  return (
    <View style={[styles.card, { borderColor: color }]}>
      <Text style={styles.cardLabel}>{label}</Text>
      <Text style={[styles.cardValue, { color }]}>{value != null ? `${value}${unit}` : '--'}</Text>
    </View>
  );
}

interface MiniChartProps {
  title: string;
  data: number[];
  labels: string[];
  color: string;
  unit: string;
  latestValue: number | null | undefined;
}

function MiniChart({ title, data, labels, color, unit, latestValue }: MiniChartProps) {
  return (
    <View style={styles.chartCard}>
      <View style={styles.chartHeader}>
        <Text style={styles.chartTitle}>{title}</Text>
        <Text style={[styles.chartValue, { color }]}>{latestValue != null ? `${latestValue}${unit}` : '--'}</Text>
      </View>
      {data.length > 0 ? (
        <LineChart
          data={{ labels, datasets: [{ data, color: () => color, strokeWidth: 2 }] }}
          width={screenWidth - 48}
          height={160}
          bezier
          withDots={false}
          chartConfig={{
            backgroundColor: '#fff',
            backgroundGradientFrom: '#fff',
            backgroundGradientTo: '#fff',
            decimalPlaces: 1,
            color: () => color,
            labelColor: () => '#999',
          }}
          style={styles.chart}
        />
      ) : (
        <Text style={styles.emptyText}>Chưa có dữ liệu</Text>
      )}
    </View>
  );
}

export default function HomeScreen() {
  const { deviceId, loading: deviceLoading, error: deviceError } = useDevice();

  // Realtime (24h)
  const [latest, setLatest] = useState<SensorReading | null>(null);
  const [history24h, setHistory24h] = useState<SensorReading[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Thống kê theo khoảng thời gian
  const [range, setRange] = useState<string>('7d');
  const [rangeReadings, setRangeReadings] = useState<SensorReading[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [statsLoading, setStatsLoading] = useState<boolean>(true);

  const loadRealtimeData = async (): Promise<void> => {
    if (!deviceId) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      setErrorMsg(null);
      const data = await fetchLast24h(deviceId);
      setHistory24h(data);
      if (data.length > 0) setLatest(data[data.length - 1]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Không tải được dữ liệu';
      setErrorMsg(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadStatsData = useCallback(async (): Promise<void> => {
    if (!deviceId) {
      setStatsLoading(false);
      return;
    }
    setStatsLoading(true);
    const days = RANGES.find((r) => r.key === range)!.days;
    const [readings, alertsData] = await Promise.all([
      fetchReadingsRange(deviceId, days),
      fetchAlerts(deviceId),
    ]);
    setRangeReadings(readings);
    setAlerts(alertsData);
    setStatsLoading(false);
  }, [deviceId, range]);

  useEffect(() => {
    loadRealtimeData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  useEffect(() => {
    loadStatsData();
  }, [loadStatsData]);

  useEffect(() => {
    if (!deviceId) return;
    const channel = supabase
      .channel(`sensor-readings-${deviceId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sensor_readings', filter: `device_id=eq.${deviceId}` },
        (payload) => {
          const newRow = payload.new as SensorReading;
          setLatest(newRow);
          setHistory24h((prev) => [...prev, newRow].slice(-200));
        }
      )
      .subscribe();
    channelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
    };
  }, [deviceId]);

  const onRefresh = (): void => {
    setRefreshing(true);
    loadRealtimeData();
    loadStatsData();
  };

  if (deviceLoading || loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2e8b57" />
      </View>
    );
  }

  if (deviceError || errorMsg) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{deviceError ?? errorMsg}</Text>
      </View>
    );
  }

  const sampled24h = sampleEvenly(history24h, 12);
  const chartData24h = {
    labels: sparseLabels(sampled24h.map((r) => formatTime(r.recorded_at)), 6),
    datasets: [
      { data: sampled24h.map((r) => r.temperature ?? 0), color: () => '#e74c3c', strokeWidth: 2 },
      { data: sampled24h.map((r) => r.humidity ?? 0), color: () => '#3498db', strokeWidth: 2 },
      { data: sampled24h.map((r) => r.soil_moisture ?? 0), color: () => '#e67e22', strokeWidth: 2 },
    ],
    legend: ['Nhiệt độ', ' Độ ẩm KK', 'Độ ẩm đất'],
  };

  const sampledRange = sampleEvenly(rangeReadings, 8);
  const rangeLabels = sparseLabels(
    sampledRange.map((r) => new Date(r.recorded_at).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })),
    4
  );
  const latestRange = rangeReadings[rangeReadings.length - 1];

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.header}>Nông trại dâu thông minh</Text>

      <View style={styles.cardsRow}>
        <SensorCard label="Nhiệt độ" value={latest?.temperature} unit="°C" color="#e74c3c" />
        <SensorCard label="Độ ẩm không khí" value={latest?.humidity} unit="%" color="#3498db" />
      </View>
      <View style={styles.cardsRow}>
        <SensorCard label="Độ ẩm đất" value={latest?.soil_moisture} unit="%" color="#8b5a2b" />
      </View>

      <Text style={styles.chartTitle}>Biểu đồ môi trường (24h)</Text>
      <View style={styles.mainChartCard}>
        {sampled24h.length > 0 ? (
          <LineChart
            data={chartData24h}
            width={screenWidth - 48}
            height={220}
            bezier
            chartConfig={{
              backgroundColor: '#fff',
              backgroundGradientFrom: '#fff',
              backgroundGradientTo: '#fff',
              decimalPlaces: 1,
              color: () => '#333',
              labelColor: () => '#666',
              propsForDots: { r: '3' },
            }}
            style={styles.chart}
          />
        ) : (
          <Text style={styles.emptyText}>Chưa có dữ liệu trong 24h qua</Text>
        )}
      </View>

      <View style={styles.divider} />

      <Text style={styles.sectionHeader}>Thống kê & Lịch sử</Text>
      <View style={styles.rangeRow}>
        {RANGES.map((r) => (
          <TouchableOpacity
            key={r.key}
            style={[styles.rangeButton, range === r.key && styles.rangeButtonActive]}
            onPress={() => setRange(r.key)}
          >
            <Text style={[styles.rangeText, range === r.key && styles.rangeTextActive]}>{r.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {statsLoading ? (
        <ActivityIndicator size="small" color="#2e8b57" style={{ marginVertical: 16 }} />
      ) : (
        <>
          <MiniChart
            title="Nhiệt độ (°C)"
            data={sampledRange.map((r) => r.temperature ?? 0)}
            labels={rangeLabels}
            color="#e74c3c"
            unit="°C"
            latestValue={latestRange?.temperature}
          />
          <MiniChart
            title="Độ ẩm không khí (%)"
            data={sampledRange.map((r) => r.humidity ?? 0)}
            labels={rangeLabels}
            color="#3498db"
            unit="%"
            latestValue={latestRange?.humidity}
          />
          <MiniChart
            title="Độ ẩm đất (%)"
            data={sampledRange.map((r) => r.soil_moisture ?? 0)}
            labels={rangeLabels}
            color="#e67e22"
            unit="%"
            latestValue={latestRange?.soil_moisture}
          />
        </>
      )}

      <Text style={styles.sectionHeader}>Lịch sử cảnh báo</Text>
      <FlatList
        data={alerts}
        scrollEnabled={false}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <View style={styles.alertItem}>
            <Text style={styles.alertMessage}>{item.message}</Text>
            <Text style={styles.alertMeta}>{formatDateTime(item.created_at)}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.emptyText}>Chưa có cảnh báo nào</Text>}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f9f4', padding: 12 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { fontSize: 20, fontWeight: 'bold', color: '#2e8b57', marginBottom: 12, textAlign: 'center' },
  cardsRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  card: { flex: 1, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, padding: 14, alignItems: 'center' },
  cardLabel: { fontSize: 13, color: '#666', marginBottom: 4 },
  cardValue: { fontSize: 22, fontWeight: 'bold' },
  chartTitle: { fontSize: 16, fontWeight: '600', marginVertical: 8, color: '#333' },
  chart: { borderRadius: 12 },
  divider: { height: 1, backgroundColor: '#ddd', marginVertical: 16 },
  sectionHeader: { fontSize: 18, fontWeight: 'bold', color: '#2e8b57', marginBottom: 10 },
  rangeRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  rangeButton: { flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: '#fff', alignItems: 'center', borderWidth: 1, borderColor: '#ddd' },
  rangeButtonActive: { backgroundColor: '#2e8b57', borderColor: '#2e8b57' },
  rangeText: { color: '#555', fontSize: 13 },
  rangeTextActive: { color: '#fff', fontWeight: 'bold' },
  mainChartCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 8,
    marginBottom: 8,
    alignItems: 'center',
  },
  chartCard: { backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 24, marginBottom: 12 },
  chartHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  chartValue: { fontSize: 14, fontWeight: 'bold' },
  alertItem: { backgroundColor: '#fff', borderRadius: 8, padding: 10, marginBottom: 6 },
  alertMessage: { fontSize: 14, color: '#333' },
  alertMeta: { fontSize: 12, color: '#888', marginTop: 2 },
  errorText: { color: '#e74c3c', textAlign: 'center', padding: 16 },
  emptyText: { textAlign: 'center', color: '#999', padding: 16 },
});