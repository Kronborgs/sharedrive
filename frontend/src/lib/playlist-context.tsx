import { createContext, useContext, useState, type ReactNode } from 'react'

interface PlaylistContextValue {
  activePlaylistId: string | null
  activePlaylistName: string | null
  setPlaylist: (id: string, name: string) => void
  clearPlaylist: () => void
}

const PlaylistContext = createContext<PlaylistContextValue | null>(null)

export function PlaylistProvider({ children }: { children: ReactNode }) {
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(null)
  const [activePlaylistName, setActivePlaylistName] = useState<string | null>(null)

  return (
    <PlaylistContext.Provider
      value={{
        activePlaylistId,
        activePlaylistName,
        setPlaylist: (id, name) => {
          setActivePlaylistId(id)
          setActivePlaylistName(name)
        },
        clearPlaylist: () => {
          setActivePlaylistId(null)
          setActivePlaylistName(null)
        },
      }}
    >
      {children}
    </PlaylistContext.Provider>
  )
}

export function usePlaylist() {
  const ctx = useContext(PlaylistContext)
  if (!ctx) throw new Error('usePlaylist must be used within PlaylistProvider')
  return ctx
}
