// lib/supabase.ts
// Khởi tạo Supabase client dùng chung cho cả app

import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// TODO: thay bằng URL và anon key thật của project bạn
// (Project Settings > API trong Supabase Dashboard)
const SUPABASE_URL = 'https://ocymalulfhsvebwuqkij.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_KEY_HERE';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
