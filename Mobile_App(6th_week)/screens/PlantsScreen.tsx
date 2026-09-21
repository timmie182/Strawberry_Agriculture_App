// screens/PlantsScreen.tsx
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
  Image,
  Modal,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from '../lib/supabase';
import { useDevice } from '../hooks/useDevice';
import { generatePlantCode } from '../lib/utils';
import type { Plant } from '../lib/types';

// ==== Cấu hình Cloudinary ====
// Thay 2 giá trị này bằng Cloud name và Upload preset (dạng Unsigned) của bạn
// Lấy tại: https://console.cloudinary.com -> Dashboard (cloud name) và Settings > Upload (upload preset)
const CLOUDINARY_CLOUD_NAME = 'cf68poo7';
const CLOUDINARY_UPLOAD_PRESET = 'plant_photos_unsigned';

interface PlantWithPhoto extends Plant {
  photoUrl?: string | null;
}

// Tự động chèn dấu "-" khi gõ: DD -> DD- -> DD-MM -> DD-MM- -> DD-MM-YYYY
function formatDateInput(text: string): string {
  const digits = text.replace(/\D/g, '').slice(0, 8); // tối đa 8 số: DD MM YYYY
  if (digits.length > 4) return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
  if (digits.length > 2) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return digits;
}

// Chuyển "DD-MM-YYYY" (hiển thị) sang "YYYY-MM-DD" (Postgres date) + kiểm tra ngày hợp lệ
function ddmmyyyyToISO(value: string): string | null {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  const date = new Date(year, month - 1, day);
  const isRealDate = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  if (!isRealDate) return null;
  return `${yyyy}-${mm}-${dd}`;
}

// Chuyển "YYYY-MM-DD" (từ Supabase) sang "DD-MM-YYYY" để hiển thị
function isoToDisplayDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, yyyy, mm, dd] = match;
  return `${dd}-${mm}-${yyyy}`;
}

async function fetchLatestPhotos(plantIds: string[]): Promise<Record<string, string>> {
  if (plantIds.length === 0) return {};
  const { data, error } = await supabase
    .from('plant_photos')
    .select('plant_id, storage_path, taken_at')
    .in('plant_id', plantIds)
    .order('taken_at', { ascending: false });
  if (error || !data) return {};

  const map: Record<string, string> = {};
  for (const row of data as { plant_id: string; storage_path: string }[]) {
    // storage_path giờ lưu thẳng URL ảnh từ Cloudinary, dùng luôn không cần build lại
    if (!map[row.plant_id]) {
      map[row.plant_id] = row.storage_path;
    }
  }
  return map;
}

async function uploadToCloudinary(localUri: string): Promise<string> {
  const uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;

  const result = await FileSystem.uploadAsync(uploadUrl, localUri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: 'file',
    parameters: { upload_preset: CLOUDINARY_UPLOAD_PRESET },
  });

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Tải ảnh lên Cloudinary thất bại (mã lỗi ${result.status})`);
  }

  let data: { secure_url?: string; error?: { message?: string } };
  try {
    data = JSON.parse(result.body);
  } catch {
    throw new Error('Không đọc được phản hồi từ Cloudinary');
  }
  if (!data.secure_url) {
    throw new Error(data.error?.message ?? 'Tải ảnh lên Cloudinary thất bại');
  }
  return data.secure_url;
}

async function uploadPlantPhoto(plantId: string, localUri: string, userId: string | null): Promise<void> {
  const secureUrl = await uploadToCloudinary(localUri);

  const { error: insertError } = await supabase.from('plant_photos').insert({
    plant_id: plantId,
    storage_path: secureUrl,
    taken_by: userId,
  });
  if (insertError) throw insertError;
}

interface PlantRowProps {
  plant: PlantWithPhoto;
}

function PlantRow({ plant }: PlantRowProps) {
  return (
    <View style={styles.plantItem}>
      {plant.photoUrl ? (
        <Image source={{ uri: plant.photoUrl }} style={styles.plantThumb} />
      ) : (
        <View style={[styles.plantThumb, styles.plantThumbEmpty]}>
          <Text style={styles.plantThumbEmptyText}>🌱</Text>
        </View>
      )}
      <View style={styles.plantInfo}>
        <Text style={styles.plantName}>{plant.name}</Text>
        <Text style={styles.plantCode}>ID: {plant.plant_code}</Text>
        <Text style={styles.plantMeta}>Ngày trồng: {isoToDisplayDate(plant.planting_date)}</Text>
        {plant.pesticide ? <Text style={styles.plantMeta}>Thuốc trừ sâu: {plant.pesticide}</Text> : null}
        {plant.fertilizer_type ? <Text style={styles.plantMeta}>Phân bón: {plant.fertilizer_type}</Text> : null}
      </View>
    </View>
  );
}

export default function PlantsScreen() {
  const { deviceId, loading: deviceLoading } = useDevice();
  const [plants, setPlants] = useState<PlantWithPhoto[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);

  // Form thêm cây
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [plantName, setPlantName] = useState<string>('');
  const [plantCode, setPlantCode] = useState<string>(() => generatePlantCode());
  const [plantingDate, setPlantingDate] = useState<string>(''); // hiển thị DD-MM-YYYY
  const [pesticide, setPesticide] = useState<string>('');
  const [fertilizer, setFertilizer] = useState<string>('');

  // Tìm cây trồng
  const [searchVisible, setSearchVisible] = useState<boolean>(false);
  const [searchId, setSearchId] = useState<string>('');
  const [searchDateFrom, setSearchDateFrom] = useState<string>('');
  const [searchDateTo, setSearchDateTo] = useState<string>('');

  const loadPlants = useCallback(async (): Promise<void> => {
    if (!deviceId) return;
    const { data, error } = await supabase
      .from('plants')
      .select('*')
      .eq('device_id', deviceId)
      .order('created_at', { ascending: false });

    if (!error) {
      const list = (data ?? []) as Plant[];
      const photoMap = await fetchLatestPhotos(list.map((p) => p.id));
      setPlants(list.map((p) => ({ ...p, photoUrl: photoMap[p.id] ?? null })));
    }
    setLoading(false);
  }, [deviceId]);

  useEffect(() => {
    loadPlants();
  }, [loadPlants]);

  const handleTakePhoto = async (): Promise<void> => {
    const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
    if (!permissionResult.granted) {
      Alert.alert('Cần quyền camera', 'Vui lòng cấp quyền camera để chụp ảnh cây');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      aspect: [1, 1],
      allowsEditing: true,
      quality: 0.7,
    });
    if (!result.canceled && result.assets?.[0]) {
      setPhotoUri(result.assets[0].uri);
    }
  };

  const resetForm = (): void => {
    setPhotoUri(null);
    setPlantName('');
    setPlantCode(generatePlantCode());
    setPlantingDate('');
    setPesticide('');
    setFertilizer('');
  };

  const handleAddPlant = async (): Promise<void> => {
    if (!plantName.trim()) {
      Alert.alert('Thiếu thông tin', 'Vui lòng nhập tên cây trồng');
      return;
    }
    if (!plantingDate) {
      Alert.alert('Thiếu thông tin', 'Vui lòng nhập ngày trồng (DD-MM-YYYY)');
      return;
    }
    const isoPlantingDate = ddmmyyyyToISO(plantingDate);
    if (!isoPlantingDate) {
      Alert.alert('Ngày trồng không hợp lệ', 'Vui lòng nhập đúng định dạng DD-MM-YYYY');
      return;
    }
    if (!deviceId) return;

    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data: inserted, error } = await supabase
      .from('plants')
      .insert({
        device_id: deviceId,
        created_by: user?.id ?? null,
        name: plantName.trim(),
        plant_code: plantCode,
        planting_date: isoPlantingDate,
        pesticide: pesticide || null,
        fertilizer_type: fertilizer || null,
      })
      .select()
      .single();

    if (error || !inserted) {
      setSaving(false);
      Alert.alert('Lỗi', error?.message ?? 'Không thêm được cây trồng');
      return;
    }

    if (photoUri) {
      try {
        await uploadPlantPhoto(inserted.id as string, photoUri, user?.id ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Lỗi không xác định';
        Alert.alert('Lưu cây thành công, nhưng lỗi khi tải ảnh lên', message);
      }
    }

    setSaving(false);
    resetForm();
    loadPlants();
  };

  // Lọc danh sách cây trong mục "Tìm cây trồng" theo ID và khoảng ngày trồng
  const filteredPlants = useMemo(() => {
    const idQuery = searchId.trim().toLowerCase();
    const isoFrom = ddmmyyyyToISO(searchDateFrom);
    const isoTo = ddmmyyyyToISO(searchDateTo);

    return plants.filter((p) => {
      if (idQuery && !p.plant_code.toLowerCase().includes(idQuery)) return false;
      if (isoFrom && p.planting_date < isoFrom) return false;
      if (isoTo && p.planting_date > isoTo) return false;
      return true;
    });
  }, [plants, searchId, searchDateFrom, searchDateTo]);

  const clearSearchFilters = (): void => {
    setSearchId('');
    setSearchDateFrom('');
    setSearchDateTo('');
  };

  if (deviceLoading || loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2e8b57" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Quản lý cây trồng</Text>

      <View style={styles.form}>
        <View style={styles.topRow}>
          <TouchableOpacity style={styles.photoBox} onPress={handleTakePhoto}>
            {photoUri ? (
              <Image source={{ uri: photoUri }} style={styles.photoPreview} />
            ) : (
              <>
                <Text style={styles.photoIcon}>📷</Text>
                <Text style={styles.photoHint}>Chụp ảnh cây</Text>
              </>
            )}
          </TouchableOpacity>

          <View style={styles.infoCol}>
            <TextInput
              style={styles.nameInput}
              placeholder="Tên cây trồng"
              placeholderTextColor="#999"
              value={plantName}
              onChangeText={setPlantName}
            />
            <View style={styles.idBox}>
              <Text style={styles.idLabel}>ID cây</Text>
              <Text style={styles.idValue} numberOfLines={1}>
                {plantCode}
              </Text>
            </View>
          </View>
        </View>

        <TextInput
          style={styles.input}
          placeholder="Ngày trồng (DD-MM-YYYY)"
          placeholderTextColor="#999"
          value={plantingDate}
          onChangeText={(text) => setPlantingDate(formatDateInput(text))}
          keyboardType="number-pad"
          maxLength={10}
        />
        <TextInput
          style={styles.input}
          placeholder="Thuốc trừ sâu (tuỳ chọn)"
          placeholderTextColor="#999"
          value={pesticide}
          onChangeText={setPesticide}
        />
        <TextInput
          style={styles.input}
          placeholder="Loại phân bón (tuỳ chọn)"
          placeholderTextColor="#999"
          value={fertilizer}
          onChangeText={setFertilizer}
        />
        <TouchableOpacity style={styles.button} onPress={handleAddPlant} disabled={saving}>
          <Text style={styles.buttonText}>{saving ? 'Đang lưu...' : '+ Thêm cây'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => setSearchVisible(true)}>
          <Text style={styles.secondaryButtonText}>🔍 Tìm cây trồng</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={searchVisible} animationType="slide" onRequestClose={() => setSearchVisible(false)}>
        <View style={styles.searchContainer}>
          <View style={styles.searchHeaderRow}>
            <Text style={styles.header}>Tìm cây trồng</Text>
            <TouchableOpacity onPress={() => setSearchVisible(false)}>
              <Text style={styles.searchCloseText}>Đóng</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.filterBox}>
            <TextInput
              style={styles.input}
              placeholder="Lọc theo ID cây trồng"
              placeholderTextColor="#999"
              value={searchId}
              onChangeText={setSearchId}
              autoCapitalize="characters"
            />
            <View style={styles.filterDateRow}>
              <TextInput
                style={[styles.input, styles.filterDateInput]}
                placeholder="Từ ngày (DD-MM-YYYY)"
                placeholderTextColor="#999"
                value={searchDateFrom}
                onChangeText={(text) => setSearchDateFrom(formatDateInput(text))}
                keyboardType="number-pad"
                maxLength={10}
              />
              <TextInput
                style={[styles.input, styles.filterDateInput]}
                placeholder="Đến ngày (DD-MM-YYYY)"
                placeholderTextColor="#999"
                value={searchDateTo}
                onChangeText={(text) => setSearchDateTo(formatDateInput(text))}
                keyboardType="number-pad"
                maxLength={10}
              />
            </View>
            {(searchId || searchDateFrom || searchDateTo) && (
              <TouchableOpacity onPress={clearSearchFilters}>
                <Text style={styles.clearFilterText}>Xoá bộ lọc</Text>
              </TouchableOpacity>
            )}
          </View>

          <FlatList
            data={filteredPlants}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <PlantRow plant={item} />}
            ListEmptyComponent={
              <Text style={styles.emptyText}>Không tìm thấy cây trồng phù hợp</Text>
            }
            contentContainerStyle={styles.searchListContent}
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f9f4', padding: 12 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { fontSize: 20, fontWeight: 'bold', color: '#2e8b57', marginBottom: 12, textAlign: 'center' },

  form: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 16, gap: 8 },
  topRow: { flexDirection: 'row', marginBottom: 4 },

  photoBox: {
    width: 120,
    aspectRatio: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ccc',
    borderStyle: 'dashed',
    backgroundColor: '#f4f9f4',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photoIcon: { fontSize: 26 },
  photoHint: { fontSize: 11, color: '#888', marginTop: 4, textAlign: 'center' },
  photoPreview: { width: '100%', height: '100%' },

  infoCol: { flex: 1, marginLeft: 12, justifyContent: 'center', gap: 8 },
  nameInput: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10, fontSize: 15, fontWeight: '600', color: '#333' },

  idBox: { backgroundColor: '#f4f9f4', borderRadius: 8, borderWidth: 1, borderColor: '#ddd', padding: 8 },
  idLabel: { fontSize: 11, color: '#999' },
  idValue: { fontSize: 14, fontWeight: 'bold', color: '#2e8b57' },

  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10, fontSize: 14, color: '#333' },
  button: { backgroundColor: '#2e8b57', borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 4 },
  buttonText: { color: '#fff', fontWeight: 'bold' },
  secondaryButton: {
    backgroundColor: '#f4f9f4',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2e8b57',
  },
  secondaryButtonText: { color: '#2e8b57', fontWeight: 'bold' },

  plantItem: { flexDirection: 'row', backgroundColor: '#fff', borderRadius: 8, padding: 10, marginBottom: 8, gap: 10 },
  plantThumb: { width: 56, height: 56, borderRadius: 8 },
  plantThumbEmpty: { backgroundColor: '#f4f9f4', alignItems: 'center', justifyContent: 'center' },
  plantThumbEmptyText: { fontSize: 22 },
  plantInfo: { flex: 1, justifyContent: 'center' },
  plantName: { fontSize: 15, fontWeight: 'bold', color: '#2e8b57' },
  plantCode: { fontSize: 12, color: '#666', marginTop: 1 },
  plantMeta: { fontSize: 13, color: '#555', marginTop: 2 },
  emptyText: { textAlign: 'center', color: '#999', padding: 16 },

  searchContainer: { flex: 1, backgroundColor: '#f4f9f4', padding: 12, paddingTop: 20 },
  searchHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  searchCloseText: { color: '#2e8b57', fontWeight: 'bold', fontSize: 15 },
  filterBox: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 12, gap: 8 },
  filterDateRow: { flexDirection: 'row', gap: 8 },
  filterDateInput: { flex: 1 },
  clearFilterText: { color: '#e74c3c', fontSize: 13, textAlign: 'right' },
  searchListContent: { paddingBottom: 24 },
});