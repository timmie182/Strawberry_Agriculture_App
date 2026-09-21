// lib/supabase.ts
// Khởi tạo Supabase client dùng chung cho cả app

import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// TODO: thay bằng URL và anon key thật của project bạn
// (Project Settings > API trong Supabase Dashboard)
const SUPABASE_URL = 'https://ocymalulfhsvebwuqkij.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9jeW1hbHVsZmhzdmVid3Vxa2lqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxODkwODksImV4cCI6MjEwNDc2NTA4OX0.re8HDRGbDjw_8ohHGCnZFHmpI-EmO3BWh_x6YafW240';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
