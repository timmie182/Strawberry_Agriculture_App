// components/DiseaseScanner.tsx
// Khối "Chẩn đoán bệnh" đặt trong tab Cây trồng: chụp/chọn ảnh -> chạy model TFLite trên máy -> hiện kết quả.
//
// Lưu ý bản release (APK): require('...tflite') trả về TÊN resource của Android chứ không phải URL,
// nên phải dùng expo-asset để copy file model ra bộ nhớ máy và lấy đường dẫn file:/// thật.

import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ActivityIndicator, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Asset } from 'expo-asset';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { HEALTHY_CLASS, imageUriToInput, toPredictions } from '../lib/disease';
import type { Prediction } from '../lib/disease';

// Đổi tên file ở đây nếu muốn dùng bản fp16 (nhẹ hơn, code giữ nguyên vì input/output vẫn là float32)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MODEL_ASSET = require('../assets/model/strawberry_mobilenetv3_fp32.tflite');

// Dưới ngưỡng này thì nhắc người dùng chụp lại (model luôn chọn 1 trong 8 lớp, không có lớp "không rõ").
// Có thể chỉnh sau khi thử với ảnh thật ngoài vườn.
const LOW_CONFIDENCE = 0.6;

// react-native-fast-tflite v3 bắt buộc truyền danh sách delegate; [] = chạy CPU mặc định.
// Phải khai báo ngoài component để mảng không bị tạo mới mỗi lần render (tránh tải lại model liên tục).
const CPU_ONLY: never[] = [];

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

interface ScannerInnerProps {
  modelUri: string;
}

function ScannerInner({ modelUri }: ScannerInnerProps) {
  // useMemo để object source không bị tạo mới mỗi lần render (tránh tải lại model liên tục)
  const source = useMemo(() => ({ url: modelUri }), [modelUri]);
  const model = useTensorflowModel(source, CPU_ONLY);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [results, setResults] = useState<Prediction[] | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const analyze = async (uri: string): Promise<void> => {
    if (model.state !== 'loaded') {
      Alert.alert('Model chưa sẵn sàng', 'Vui lòng đợi model tải xong rồi thử lại');
      return;
    }
    setPhotoUri(uri);
    setResults(null);
    setBusy(true);
    try {
      const input = await imageUriToInput(uri);
      // v3: đầu vào/đầu ra là ArrayBuffer (không phải TypedArray như v2)
      const outputs = await model.model.run([input.buffer as ArrayBuffer]);
      setResults(toPredictions(new Float32Array(outputs[0])));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lỗi không xác định';
      Alert.alert('Không phân tích được ảnh', message);
    } finally {
      setBusy(false);
    }
  };

  const handleCamera = async (): Promise<void> => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Cần quyền camera', 'Vui lòng cấp quyền camera để chụp ảnh');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      aspect: [1, 1],
      allowsEditing: true, // cắt vuông quanh vùng lá/quả cần chẩn đoán
      quality: 1,
    });
    if (!result.canceled && result.assets?.[0]) analyze(result.assets[0].uri);
  };

  const handleGallery = async (): Promise<void> => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      aspect: [1, 1],
      allowsEditing: true,
      quality: 1,
    });
    if (!result.canceled && result.assets?.[0]) analyze(result.assets[0].uri);
  };

  const top = results?.[0];
  const isHealthy = top?.className === HEALTHY_CLASS;
  const accent = isHealthy ? '#2e8b57' : '#e67e22';
  const modelReady = model.state === 'loaded';

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Chẩn đoán bệnh bằng AI</Text>
      <Text style={styles.subtitle}>Chụp cận cảnh lá, quả hoặc hoa dâu, đủ sáng, vùng cần xem nằm giữa ảnh.</Text>

      {model.state === 'loading' && (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color="#2e8b57" />
          <Text style={styles.statusText}>Đang tải model...</Text>
        </View>
      )}
      {model.state === 'error' && (
        <Text style={styles.errorText}>Không tải được model: {model.error.message}</Text>
      )}

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, !modelReady && styles.buttonDisabled]}
          onPress={handleCamera}
          disabled={!modelReady || busy}
        >
          <Text style={styles.buttonText}>📷 Chụp ảnh</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.buttonOutline, !modelReady && styles.buttonDisabled]}
          onPress={handleGallery}
          disabled={!modelReady || busy}
        >
          <Text style={styles.buttonOutlineText}>🖼️ Chọn từ thư viện</Text>
        </TouchableOpacity>
      </View>

      {photoUri && (
        <View style={styles.resultRow}>
          <Image source={{ uri: photoUri }} style={styles.preview} />
          <View style={styles.resultInfo}>
            {busy && (
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color="#2e8b57" />
                <Text style={styles.statusText}>Đang phân tích...</Text>
              </View>
            )}
            {top && (
              <>
                <Text style={styles.resultLabel}>Kết quả</Text>
                <Text style={[styles.resultName, { color: accent }]}>{top.labelVi}</Text>
                <Text style={styles.resultScore}>Điểm model: {pct(top.score)}</Text>
              </>
            )}
          </View>
        </View>
      )}

      {results && (
        <>
          {top && top.score < LOW_CONFIDENCE && (
            <Text style={styles.warning}>
              Kết quả chưa chắc chắn. Hãy chụp lại gần hơn, đủ sáng và chỉ có một vùng bệnh trong khung.
            </Text>
          )}

          <Text style={styles.sectionLabel}>Các khả năng gần nhất</Text>
          {results.slice(0, 3).map((p) => (
            <View key={p.classId} style={styles.barRow}>
              <View style={styles.barHeader}>
                <Text style={styles.barName}>{p.labelVi}</Text>
                <Text style={styles.barValue}>{pct(p.score)}</Text>
              </View>
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.barFill,
                    {
                      width: `${Math.max(2, p.score * 100)}%`,
                      backgroundColor: p.className === HEALTHY_CLASS ? '#2e8b57' : '#e67e22',
                    },
                  ]}
                />
              </View>
            </View>
          ))}

          <Text style={styles.note}>
            Chỉ mang tính tham khảo: model chỉ phân biệt 8 nhóm trên và không có lựa chọn "không rõ", nên ảnh không
            phải lá/quả dâu vẫn có thể ra một kết quả.
          </Text>
        </>
      )}
    </View>
  );
}

// Component bọc ngoài: lấy đường dẫn file thật của model (copy ra bộ nhớ máy) rồi mới render scanner
export default function DiseaseScanner() {
  const [modelUri, setModelUri] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const asset = Asset.fromModule(MODEL_ASSET);
        await asset.downloadAsync();
        const uri = asset.localUri ?? asset.uri;
        if (mounted) setModelUri(uri);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Không đọc được file model';
        if (mounted) setLoadError(message);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (loadError) {
    return (
      <View style={styles.card}>
        <Text style={styles.errorText}>Không tải được model: {loadError}</Text>
      </View>
    );
  }

  if (!modelUri) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Chẩn đoán bệnh bằng AI</Text>
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color="#2e8b57" />
          <Text style={styles.statusText}>Đang chuẩn bị model...</Text>
        </View>
      </View>
    );
  }

  return <ScannerInner modelUri={modelUri} />;
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 16, gap: 8 },
  title: { fontSize: 16, fontWeight: 'bold', color: '#2e8b57' },
  subtitle: { fontSize: 13, color: '#666' },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusText: { fontSize: 13, color: '#666' },
  errorText: { color: '#e74c3c', fontSize: 13 },

  buttonRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  button: { flex: 1, backgroundColor: '#2e8b57', borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: 'bold' },
  buttonOutline: {
    flex: 1,
    backgroundColor: '#f4f9f4',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2e8b57',
  },
  buttonOutlineText: { color: '#2e8b57', fontWeight: 'bold' },
  buttonDisabled: { opacity: 0.5 },

  resultRow: { flexDirection: 'row', gap: 12, marginTop: 4 },
  preview: { width: 110, height: 110, borderRadius: 10, backgroundColor: '#f4f9f4' },
  resultInfo: { flex: 1, justifyContent: 'center' },
  resultLabel: { fontSize: 12, color: '#999' },
  resultName: { fontSize: 18, fontWeight: 'bold', marginTop: 2 },
  resultScore: { fontSize: 13, color: '#666', marginTop: 4 },

  warning: {
    backgroundColor: '#fff4e5',
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
    color: '#a65d00',
  },

  sectionLabel: { fontSize: 13, fontWeight: '600', color: '#333', marginTop: 4 },
  barRow: { gap: 4 },
  barHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  barName: { fontSize: 13, color: '#333' },
  barValue: { fontSize: 13, color: '#666' },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: '#eef3ee', overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },

  note: { fontSize: 12, color: '#999', marginTop: 4 },
});