$path = "x:\sharedrive\frontend\src\components\files\ShareDialog.tsx"
$c = [System.IO.File]::ReadAllText($path)

# Verify URL fix is already applied
if ($c -notmatch [regex]::Escape('shared/?token=${token}')) {
    Write-Host "ERROR: copyLink URL fix not found"
    exit 1
}

# 2. Insert settings query + linkEnabled + useEffect after [copied] state
$needle = "  const [copied, setCopied] = useState(false)`r`n`r`n  const { data: shares } = useQuery({"
$replacement = "  const [copied, setCopied] = useState(false)`r`n`r`n  const { data: settings } = useQuery({`r`n    queryKey: ['system-settings'],`r`n    queryFn: ({ signal }) => api.get<{ direct_upload_url?: string }>('/api/v1/system/settings', signal),`r`n    staleTime: 5 * 60 * 1000,`r`n  })`r`n  const linkEnabled = !!(settings?.direct_upload_url?.trim())`r`n`r`n  useEffect(() => {`r`n    if (!linkEnabled && tab === 'link') setTab('user')`r`n  }, [linkEnabled, tab])`r`n`r`n  const { data: shares } = useQuery({"

if ($c.IndexOf($needle) -eq -1) {
    Write-Host "ERROR: settings needle not found"
    $c.Substring(5200, 300)  # debug
    exit 1
}
$c = $c.Replace($needle, $replacement)

# 3. Replace tab bar
$oldTab = "        {/* Tab bar */}`r`n        <div className=`"flex border-b border-zinc-100 dark:border-[#2d3148] px-5`">`r`n          {(['user', 'group', 'link'] as ShareTargetType[]).map(t => (`r`n            <button`r`n              key={t}`r`n              onClick={() => setTab(t)}`r`n              className={``py-2.5 px-3 text-sm font-medium border-b-2 transition-colors capitalize `${`r`n                tab === t`r`n                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'`r`n                  : 'border-transparent text-muted hover:text-zinc-700 dark:hover:text-slate-300'`r`n              }``}`r`n            >`r`n              {t === 'link' ? 'Link' : t === 'group' ? 'Group' : 'User'}`r`n            </button>`r`n          ))}`r`n        </div>"

$newTab = "        {/* Tab bar */}`r`n        <div className=`"flex border-b border-zinc-100 dark:border-[#2d3148] px-5`">`r`n          {(['user', 'group', 'link'] as ShareTargetType[]).map(t => {`r`n            const disabled = t === 'link' && !linkEnabled`r`n            return (`r`n              <button`r`n                key={t}`r`n                onClick={() => { if (!disabled) setTab(t) }}`r`n                disabled={disabled}`r`n                title={disabled ? 'Requires Direct Upload URL to be configured in Admin \u2192 Settings' : undefined}`r`n                className={``py-2.5 px-3 text-sm font-medium border-b-2 transition-colors capitalize `${`r`n                  disabled`r`n                    ? 'border-transparent text-zinc-300 dark:text-zinc-600 cursor-not-allowed'`r`n                    : tab === t`r`n                    ? 'border-brand-500 text-brand-600 dark:text-brand-400'`r`n                    : 'border-transparent text-muted hover:text-zinc-700 dark:hover:text-slate-300'`r`n                }``}`r`n              >`r`n                {t === 'link' ? 'Link' : t === 'group' ? 'Group' : 'User'}`r`n              </button>`r`n            )`r`n          })}`r`n        </div>"

if ($c.IndexOf($oldTab) -eq -1) {
    Write-Host "ERROR: tab bar needle not found"
    exit 1
}
$c = $c.Replace($oldTab, $newTab)

[System.IO.File]::WriteAllText($path, $c, [System.Text.Encoding]::UTF8)
Write-Host "Done. Lines: $((Get-Content $path).Count)"
