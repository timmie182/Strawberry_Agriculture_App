// lib/utils.ts

export function sampleEvenly<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const result: T[] = [];
  for (let i = 0; i < n; i++) {
    result.push(arr[Math.floor(i * step)]);
  }
  return result;
}

export function generatePlantCode(): string {
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `DAU-${rand}`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN');
}
