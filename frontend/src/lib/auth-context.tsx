import React, { createContext, useContext } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiClientError } from '@/lib/api'
import type { User } from '@/types/api'

interface AuthContextValue {
  user: User | null
  isLoading: boolean
  refetch: () => Promise<void>
  logout: () => Promise<void>
  setUser: (u: User | null) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient()

  const { data: user, isLoading } = useQuery<User | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<User>('/api/v1/me')
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 401) return null
        throw err
      }
    },
    // Re-fetch every 60 s, on window focus, and when the tab becomes visible
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    staleTime: 30_000,
  })

  const refetch = async () => {
    await qc.invalidateQueries({ queryKey: ['me'] })
  }

  const setUser = (u: User | null) => {
    qc.setQueryData<User | null>(['me'], u)
  }

  const logout = async () => {
    try {
      await api.post('/api/v1/auth/logout')
    } catch {
      // Best effort
    }
    qc.setQueryData(['me'], null)
    void qc.clear()
    window.location.href = '/login'
  }

  return (
    <AuthContext.Provider value={{ user: user ?? null, isLoading, refetch, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
