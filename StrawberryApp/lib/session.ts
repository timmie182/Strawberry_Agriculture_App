// lib/session.ts
// Không có màn hình Login - dùng Anonymous Auth của Supabase để có auth.uid()
// (bắt buộc phải có để RLS hoạt động), sau đó tự join/tạo device.

import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

// TODO: thay bằng mã device_code TRÙNG với mã mà firmware ESP32 dùng khi ghi
// dữ liệu vào bảng sensor_readings/devices. Hỏi bạn làm firmware để lấy đúng mã này.
export const DEVICE_CODE = 'ESP32-001';

export async function ensureAnonymousSession(): Promise<Session> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session) return session;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  if (!data.session) throw new Error('Không tạo được phiên ẩn danh');
  return data.session;
}

export async function ensureDeviceAccess(): Promise<string> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc('join_or_create_device', {
    p_device_code: DEVICE_CODE,
  });
  if (error) throw error;
  return data as string; // deviceId (uuid)
}
