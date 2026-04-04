import { Link, useRouterState } from '@tanstack/react-router'
import {
  Files,
  Share2,
  Clock,
  Trash2,
  Settings,
  Users,
  ScrollText,
  ShieldBan,
  HardDrive,
  Database,
  ChevronDown,
  LogOut,
} from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/lib/auth-context'
import { api } from '@/lib/api'
import { useQueryClient } from '@tanstack/react-query'
import { formatBytes } from '@/lib/utils'

interface NavItem {
  to: string
  label: string
  icon: React.ReactNode
  exact?: boolean
}

const mainNav: NavItem[] = [
  { to: '/files',   label: 'My Files',     icon: <Files size={16} />,   exact: true },
  { to: '/shares',  label: 'Shared',        icon: <Share2 size={16} /> },
  { to: '/recent',  label: 'Recent',        icon: <Clock size={16} /> },
  { to: '/trash',   label: 'Trash',         icon: <Trash2 size={16} /> },
]

const adminNav: NavItem[] = [
  { to: '/admin',              label: 'Dashboard',   icon: <HardDrive size={16} />, exact: true },
  { to: '/admin/users',        label: 'Users',        icon: <Users size={16} /> },
  { to: '/admin/audit-logs',   label: 'Audit Log',    icon: <ScrollText size={16} /> },
  { to: '/admin/blocked-ips',  label: 'Blocked IPs',  icon: <ShieldBan size={16} /> },
  { to: '/admin/backup',       label: 'Backup',       icon: <Database size={16} /> },
  { to: '/admin/settings',     label: 'Settings',     icon: <Settings size={16} /> },
]

function NavLink({ item }: { item: NavItem }) {
  const state = useRouterState()
  const active = item.exact
    ? state.location.pathname === item.to
    : state.location.pathname.startsWith(item.to)

  return (
    <Link
      to={item.to}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
        active
          ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-400 font-medium'
          : 'text-zinc-600 dark:text-slate-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148] hover:text-zinc-900 dark:hover:text-slate-100'
      }`}
    >
      <span className={active ? 'text-brand-600 dark:text-brand-400' : ''}>{item.icon}</span>
      {item.label}
    </Link>
  )
}

export function Sidebar() {
  const { user, setUser } = useAuth()
  const qc = useQueryClient()
  const [showUserMenu, setShowUserMenu] = useState(false)

  const handleLogout = async () => {
    try {
      await api.post('/api/v1/auth/logout', {})
    } finally {
      setUser(null)
      void qc.clear()
      window.location.href = '/login'
    }
  }

  const quota = user?.quota_bytes ?? 0
  const used = user?.quota_used_bytes ?? 0
  const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0

  return (
    <aside className="flex flex-col w-60 shrink-0 bg-white dark:bg-[#1a1d27] border-r border-zinc-200 dark:border-[#2d3148] h-screen sticky top-0 overflow-y-auto">
      {/* Logo */}
      <div className="px-4 h-14 flex items-center border-b border-zinc-200 dark:border-[#2d3148] shrink-0">
        <img src="/logo_name.png" alt="Sharedrive" className="h-7 w-auto" />
      </div>

      {/* Main nav */}
      <nav className="px-2 py-3 space-y-0.5">
        {mainNav.map(item => (
          <NavLink key={item.to} item={item} />
        ))}
      </nav>

      {/* Admin nav */}
      {user?.is_admin && (
        <>
          <div className="mx-4 border-t border-zinc-200 dark:border-[#2d3148] my-1" />
          <div className="px-4 py-1">
            <p className="text-[11px] uppercase tracking-widest text-zinc-400 dark:text-slate-500 font-medium">
              Admin
            </p>
          </div>
          <nav className="px-2 pb-3 space-y-0.5">
            {adminNav.map(item => (
              <NavLink key={item.to} item={item} />
            ))}
          </nav>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Quota */}
      {quota > 0 && (
        <div className="px-4 py-3 border-t border-zinc-100 dark:border-[#2d3148]">
          <div className="flex justify-between text-xs text-muted mb-1">
            <span>{formatBytes(used)} used</span>
            <span>{formatBytes(quota)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-[#2d3148] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-amber-500' : 'bg-brand-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {/* User profile */}
      <div className="border-t border-zinc-200 dark:border-[#2d3148] p-2 relative">
        <button
          onClick={() => setShowUserMenu(v => !v)}
          className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors"
        >
          <div className="w-7 h-7 rounded-full bg-brand-600 dark:bg-brand-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
            {user?.display_name?.charAt(0).toUpperCase() ?? '?'}
          </div>
          <div className="flex-1 min-w-0 text-left">
            <p className="text-sm font-medium text-zinc-900 dark:text-slate-100 truncate">
              {user?.display_name}
            </p>
            <p className="text-xs text-muted truncate">{user?.email}</p>
          </div>
          <ChevronDown size={14} className="text-zinc-400 shrink-0" />
        </button>

        {showUserMenu && (
          <div className="absolute bottom-full left-2 right-2 mb-1 bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl shadow-lg py-1 z-50">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
            >
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}
