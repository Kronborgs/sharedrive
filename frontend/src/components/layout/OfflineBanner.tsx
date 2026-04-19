import { WifiOff } from 'lucide-react'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'

export function OfflineBanner() {
  const online = useOnlineStatus()

  if (online) return null

  return (
    <div className="fixed top-0 left-0 right-0 z-[90] bg-amber-500 text-white text-center text-xs font-medium py-1.5 px-4 flex items-center justify-center gap-2">
      <WifiOff size={14} />
      <span>Du er offline — uploads genoptages automatisk når forbindelsen vender tilbage</span>
    </div>
  )
}
