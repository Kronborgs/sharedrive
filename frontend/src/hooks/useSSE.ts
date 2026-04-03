import { useEffect, useRef, useCallback } from 'react'

type SSEHandler<T> = (data: T) => void

interface UseSSEOptions<T> {
  url: string
  onMessage: SSEHandler<T>
  enabled?: boolean
}

export function useSSE<T = unknown>({ url, onMessage, enabled = true }: UseSSEOptions<T>) {
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  useEffect(() => {
    if (!enabled) return

    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retries = 0
    const MAX_RETRIES = 6

    const connect = () => {
      es = new EventSource(url, { withCredentials: true })

      es.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data as string) as T
          onMessageRef.current(parsed)
        } catch {
          // ignore unparseable messages
        }
      }

      es.onerror = () => {
        es?.close()
        es = null
        if (retries < MAX_RETRIES) {
          const delay = Math.min(1000 * 2 ** retries, 30_000)
          retries++
          retryTimer = setTimeout(connect, delay)
        }
      }

      es.onopen = () => {
        retries = 0
      }
    }

    connect()

    return () => {
      if (retryTimer) clearTimeout(retryTimer)
      es?.close()
    }
  }, [url, enabled])
}
