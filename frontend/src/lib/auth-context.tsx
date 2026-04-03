import React, { createContext, useContext, useEffect, useState } from 'react'
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
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const fetchUser = async () => {
    try {
      const u = await api.get<User>('/api/v1/me')
      setUser(u)
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        setUser(null)
      } else {
        // Network error — keep previous state
        console.error('Auth check failed:', err)
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void fetchUser()
  }, [])

  const logout = async () => {
    try {
      await api.post('/api/v1/auth/logout')
    } catch {
      // Best effort
    }
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, isLoading, refetch: fetchUser, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
