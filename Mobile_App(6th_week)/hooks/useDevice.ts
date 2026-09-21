// hooks/useDevice.ts
import { useEffect, useState } from 'react';
import { ensureDeviceAccess } from '../lib/session';

export interface UseDeviceResult {
  deviceId: string | null;
  loading: boolean;
  error: string | null;
}

export function useDevice(): UseDeviceResult {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    ensureDeviceAccess()
      .then((id) => {
        if (mounted) setDeviceId(id);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Lỗi kết nối device';
        if (mounted) setError(message);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  return { deviceId, loading, error };
}
