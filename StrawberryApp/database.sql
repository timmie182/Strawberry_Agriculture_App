-- ============================================================
-- SCHEMA SUPABASE (PostgreSQL) - NÔNG TRẠI DÂU THÔNG MINH
-- ESP32 + Supabase + React Native + MobileNetV3-Large
-- Hỗ trợ: NHIỀU NGƯỜI DÙNG dùng chung 1 THIẾT BỊ (device)
-- ============================================================

create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------
-- 1. PROFILES - thông tin người dùng mở rộng
-- ------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2. DEVICES - mỗi thiết bị ESP32 (không còn 1-owner cố định)
--    owner_id = người tạo ban đầu, có quyền cao nhất (xoá device, mời/xoá thành viên)
-- ------------------------------------------------------------
create table devices (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_code text not null unique,      -- mã định danh ESP32 (vd: ESP32-001)
  name text not null default 'Nông trại của tôi',
  is_online boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 3. DEVICE_MEMBERS - danh sách người dùng được chia sẻ 1 device
--    role: 'owner' (toàn quyền) | 'member' (xem + điều khiển)
-- ------------------------------------------------------------
create table device_members (
  device_id uuid not null references devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  invited_by uuid references auth.users(id),
  joined_at timestamptz not null default now(),
  primary key (device_id, user_id)
);

-- Khi tạo device mới, tự thêm người tạo vào device_members với role owner
create or replace function fn_add_owner_as_member()
returns trigger as $$
begin
  insert into device_members (device_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$ language plpgsql security definer;

create trigger trg_add_owner_as_member
  after insert on devices
  for each row execute function fn_add_owner_as_member();

-- ------------------------------------------------------------
-- 4. SENSOR_READINGS - dữ liệu cảm biến theo thời gian (time-series)
-- ------------------------------------------------------------
create table sensor_readings (
  id bigint generated always as identity primary key,
  device_id uuid not null references devices(id) on delete cascade,
  temperature numeric(5,2),
  humidity numeric(5,2),
  soil_moisture numeric(5,2),
  recorded_at timestamptz not null default now()
);

create index idx_sensor_readings_device_time
  on sensor_readings (device_id, recorded_at desc);

-- ------------------------------------------------------------
-- 5. ACTUATOR_STATES - trạng thái HIỆN TẠI (quạt/đèn), 1 dòng/device
-- ------------------------------------------------------------
create table actuator_states (
  device_id uuid primary key references devices(id) on delete cascade,
  fan_state boolean not null default false,
  light_state boolean not null default false,
  mode text not null default 'manual' check (mode in ('manual', 'auto')),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 6. CONTROL_LOGS - lịch sử điều khiển, ghi rõ AI THÀNH VIÊN NÀO đã bấm
-- ------------------------------------------------------------
create table control_logs (
  id bigint generated always as identity primary key,
  device_id uuid not null references devices(id) on delete cascade,
  actuator text not null check (actuator in ('fan', 'light')),
  action text not null check (action in ('on', 'off')),
  mode text not null check (mode in ('manual', 'auto')),
  triggered_by uuid references auth.users(id),   -- null nếu hệ thống tự động
  created_at timestamptz not null default now()
);

create index idx_control_logs_device_time
  on control_logs (device_id, created_at desc);

-- ------------------------------------------------------------
-- 7. PLANTS - thông tin cây trồng, thuộc về DEVICE (nhóm dùng chung)
--    created_by lưu ai là người nhập, không giới hạn quyền xem theo người đó
-- ------------------------------------------------------------
create table plants (
  id uuid primary key default uuid_generate_v4(),
  device_id uuid not null references devices(id) on delete cascade,
  created_by uuid references auth.users(id),
  plant_code text not null unique,       -- mã số cây trồng (random generate)
  planting_date date not null,
  pesticide text,
  fertilizer_type text,
  notes text,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 8. PLANT_PHOTOS - ảnh chụp lá/cây
-- ------------------------------------------------------------
create table plant_photos (
  id uuid primary key default uuid_generate_v4(),
  plant_id uuid not null references plants(id) on delete cascade,
  storage_path text not null,
  taken_by uuid references auth.users(id),
  taken_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 9. DISEASES - danh mục bệnh tham chiếu (dataset Kaggle, 7 loại)
-- ------------------------------------------------------------
create table diseases (
  id smallint generated always as identity primary key,
  name text not null unique,
  description text,
  dataset_source text default 'Kaggle'
);

-- ------------------------------------------------------------
-- 10. DISEASE_DIAGNOSES - kết quả AI nhận diện bệnh
-- ------------------------------------------------------------
create table disease_diagnoses (
  id uuid primary key default uuid_generate_v4(),
  plant_id uuid not null references plants(id) on delete cascade,
  photo_id uuid references plant_photos(id) on delete set null,
  disease_id smallint references diseases(id),
  confidence numeric(5,2),
  model_version text default 'MobileNetV3-Large',
  ran_offline boolean not null default false,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 11. ALERTS - thông báo/cảnh báo
-- ------------------------------------------------------------
create table alerts (
  id bigint generated always as identity primary key,
  device_id uuid references devices(id) on delete cascade,
  type text not null,
  message text not null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_alerts_device_time
  on alerts (device_id, created_at desc);

-- ============================================================
-- HELPER FUNCTION - kiểm tra user có phải thành viên của device không
-- (dùng chung trong nhiều policy, tránh lặp subquery)
-- ============================================================
create or replace function fn_is_device_member(p_device_id uuid)
returns boolean as $$
  select exists (
    select 1 from device_members m
    where m.device_id = p_device_id and m.user_id = auth.uid()
  );
$$ language sql security definer stable;

create or replace function fn_is_device_owner(p_device_id uuid)
returns boolean as $$
  select exists (
    select 1 from device_members m
    where m.device_id = p_device_id and m.user_id = auth.uid() and m.role = 'owner'
  );
$$ language sql security definer stable;

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================
alter table profiles enable row level security;
alter table devices enable row level security;
alter table device_members enable row level security;
alter table sensor_readings enable row level security;
alter table actuator_states enable row level security;
alter table control_logs enable row level security;
alter table plants enable row level security;
alter table plant_photos enable row level security;
alter table disease_diagnoses enable row level security;
alter table alerts enable row level security;

-- Profiles
create policy "Xem profile của mình" on profiles
  for select using (auth.uid() = id);
create policy "Sửa profile của mình" on profiles
  for update using (auth.uid() = id);

-- Devices: tất cả thành viên được xem, chỉ owner được sửa/xoá
create policy "Thành viên xem device" on devices
  for select using (fn_is_device_member(id));
create policy "Owner sửa device" on devices
  for update using (fn_is_device_owner(id));
create policy "Owner xoá device" on devices
  for delete using (fn_is_device_owner(id));
create policy "User tạo device mới" on devices
  for insert with check (auth.uid() = owner_id);

-- Device members: thành viên xem danh sách, chỉ owner được mời/xoá thành viên
create policy "Thành viên xem danh sách nhóm" on device_members
  for select using (fn_is_device_member(device_id));
create policy "Owner thêm thành viên" on device_members
  for insert with check (fn_is_device_owner(device_id));
create policy "Owner xoá thành viên" on device_members
  for delete using (fn_is_device_owner(device_id));

-- Sensor readings: mọi thành viên của device được xem
create policy "Thành viên xem sensor data" on sensor_readings
  for select using (fn_is_device_member(device_id));
-- ESP32 ghi dữ liệu bằng service_role key (bypass RLS), không cần policy insert riêng.

-- Actuator states: mọi thành viên xem + điều khiển
create policy "Thành viên xem/điều khiển actuator" on actuator_states
  for all using (fn_is_device_member(device_id));

-- Control logs: mọi thành viên xem, mọi thành viên được ghi log khi họ điều khiển
create policy "Thành viên xem lịch sử điều khiển" on control_logs
  for select using (fn_is_device_member(device_id));
create policy "Thành viên ghi lịch sử điều khiển" on control_logs
  for insert with check (fn_is_device_member(device_id) and triggered_by = auth.uid());

-- Plants: mọi thành viên của device quản lý chung
create policy "Thành viên quản lý plant" on plants
  for all using (fn_is_device_member(device_id));

-- Plant photos: qua liên kết plant -> device
create policy "Thành viên quản lý ảnh cây" on plant_photos
  for all using (
    exists (
      select 1 from plants p
      where p.id = plant_id and fn_is_device_member(p.device_id)
    )
  );

-- Disease diagnoses: qua liên kết plant -> device
create policy "Thành viên xem/tạo chẩn đoán" on disease_diagnoses
  for all using (
    exists (
      select 1 from plants p
      where p.id = plant_id and fn_is_device_member(p.device_id)
    )
  );

-- Alerts: mọi thành viên xem
create policy "Thành viên xem cảnh báo" on alerts
  for select using (fn_is_device_member(device_id));

-- ============================================================
-- REALTIME
-- ============================================================
alter publication supabase_realtime add table sensor_readings;
alter publication supabase_realtime add table actuator_states;
alter publication supabase_realtime add table alerts;

-- ============================================================
-- SEED DATA - 7 loại bệnh theo dataset Kaggle (chỉnh lại theo dataset thực tế)
-- ============================================================
insert into diseases (name, description) values
  ('Bệnh đốm lá', 'Xuất hiện các đốm nâu trên lá, ảnh hưởng đến quá trình quang hợp'),
  ('Bệnh phấn trắng', 'Lớp bột trắng phủ trên bề mặt lá'),
  ('Bệnh héo rũ', 'Cây héo do nấm/vi khuẩn tấn công rễ'),
  ('Bệnh thán thư', 'Đốm đen lõm trên quả và lá'),
  ('Bệnh cháy lá', 'Mép lá cháy khô lan dần vào trong'),
  ('Bệnh gỉ sắt', 'Đốm màu gỉ sắt ở mặt dưới lá'),
  ('Lá khỏe mạnh', 'Không phát hiện dấu hiệu bệnh');

-- ============================================================
-- BỔ SUNG: cho phép app tự join/tạo device mà KHÔNG cần màn hình login
-- (dùng chung với Supabase Anonymous Auth - signInAnonymously())
-- Chạy đoạn này SAU khi đã chạy file schema_nong_trai_dau.sql
-- ============================================================

-- Nhớ bật Anonymous Sign-ins trong Dashboard:
-- Authentication > Sign In / Providers > bật "Allow anonymous sign-ins"

create or replace function join_or_create_device(
  p_device_code text,
  p_device_name text default 'Nông trại của tôi'
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_device_id uuid;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Chưa có phiên đăng nhập (kể cả ẩn danh)';
  end if;

  select id into v_device_id from devices where device_code = p_device_code;

  if v_device_id is null then
    -- Chưa có device với mã này -> tạo mới, người gọi trở thành owner
    insert into devices (owner_id, device_code, name)
    values (v_uid, p_device_code, p_device_name)
    returning id into v_device_id;
    -- trigger trg_add_owner_as_member sẽ tự thêm owner vào device_members
  else
    -- Đã có device -> tự thêm người gọi làm member (nếu chưa có)
    insert into device_members (device_id, user_id, role)
    values (v_device_id, v_uid, 'member')
    on conflict (device_id, user_id) do nothing;
  end if;

  return v_device_id;
end;
$$;

grant execute on function join_or_create_device(text, text) to authenticated;

-- ============================================================
-- BỔ SUNG: thêm tên hiển thị cho cây trồng (khác plant_code)
-- Chạy đoạn này SAU khi đã chạy schema_nong_trai_dau.sql
-- ============================================================

alter table plants
  add column if not exists name text not null default 'Cây dâu';

-- Nếu muốn bỏ giá trị mặc định sau khi đã cập nhật dữ liệu cũ, chạy thêm:
-- alter table plants alter column name drop default;

-- ============================================================
-- STORAGE: bucket lưu ảnh cây trồng
-- Vào Supabase Dashboard > Storage > tạo bucket tên "plant-photos"
-- (nên để Public nếu muốn lấy public URL trực tiếp như code app đang dùng,
--  hoặc để Private rồi đổi code sang dùng createSignedUrl)
-- ============================================================

-- Policy cho phép thành viên của device upload/xem ảnh trong bucket
-- (chỉnh lại theo cấu trúc path bạn dùng, ví dụ path bắt đầu bằng plant_id)
-- Đây chỉ là ví dụ tham khảo, cần chỉnh sửa theo nhu cầu thực tế:

-- create policy "Thành viên upload ảnh cây"
--   on storage.objects for insert
--   with check (bucket_id = 'plant-photos');

-- create policy "Thành viên xem ảnh cây"
--   on storage.objects for select
--   using (bucket_id = 'plant-photos');
