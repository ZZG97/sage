import { useState, useEffect, useCallback } from 'react';

/** 简单的数据请求 hook，支持自动刷新 */
export function useQuery<T>(
  fetcher: () => Promise<T>,
  deps: any[] = [],
  refreshInterval?: number,
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setError(null);
      const result = await fetcher();
      setData(result);
    } catch (err: any) {
      setError(err.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => {
    setLoading(true);
    refetch();

    if (refreshInterval && refreshInterval > 0) {
      const timer = setInterval(refetch, refreshInterval);
      return () => clearInterval(timer);
    }
  }, [refetch, refreshInterval]);

  return { data, loading, error, refetch };
}
