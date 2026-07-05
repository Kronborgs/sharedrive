import sys

filepath = '/mnt/unraid/Githubwork/sharedrive/frontend/src/routes/_auth.backup.index.tsx'

with open(filepath, 'r') as f:
    content = f.read()

# --- 1. Add isPushing + pushProgress query after buddyConfig query ---
old1 = (
    "queryKey: ['backup', 'buddy-config'],\n"
    "    queryFn: ({ signal }) => api.get<BuddyUserConfig>('/api/v1/backup/buddy/config', signal),\n"
    "    // Poll every 3 s while a push is in progress so the UI updates when it finishes.\n"
    "    refetchInterval: (query) => (query.state.data?.push_in_progress ? 3000 : false),\n"
    "  })"
)

new1 = (
    "queryKey: ['backup', 'buddy-config'],\n"
    "    queryFn: ({ signal }) => api.get<BuddyUserConfig>('/api/v1/backup/buddy/config', signal),\n"
    "    refetchInterval: (query) => (query.state.data?.push_in_progress ? 3000 : false),\n"
    "  })\n"
    "\n"
    "  const isPushing = buddyPushing || !!buddyConfig?.push_in_progress\n"
    "\n"
    "  interface PushProgress { total_bytes: number; sent_bytes: number; started_at: string; active: boolean }\n"
    "  const { data: pushProgress } = useQuery({\n"
    "    queryKey: ['backup', 'push-progress'],\n"
    "    queryFn: ({ signal }) => api.get<PushProgress>('/api/v1/backup/buddy/push/progress', signal),\n"
    "    enabled: isPushing,\n"
    "    refetchInterval: isPushing ? 1000 : false,\n"
    "  })"
)

if old1 in content:
    content = content.replace(old1, new1, 1)
    print('patch 1 applied')
else:
    print('patch 1 NOT FOUND')
    sys.exit(1)

# --- 2. Replace occurrences of (buddyPushing || buddyConfig?.push_in_progress) with isPushing ---
content = content.replace(
    'buddyPushing || buddyConfig?.push_in_progress',
    'isPushing'
)
print('patch 2 applied (isPushing replacements)')

# --- 3. Add pushProgressBar helper before first push button usage ---
# Insert progress bar component after the spinning icon in the main push button
progress_bar_jsx = (
    "\n                        {isPushing && pushProgress && pushProgress.total_bytes > 0 && (\n"
    "                          <PushProgressBar progress={pushProgress} />\n"
    "                        )}"
)

# Insert after the main push button's closing </button> tag (the one with handleBuddyPush and w-full)
push_btn_marker = (
    "          {(buddyPushing || buddyConfig?.push_in_progress)\n"
)
# Already replaced above, so now it's isPushing
push_btn_marker_new = (
    "          {isPushing\n"
)

# Find the reset stuck push button and insert progress bar before it
reset_btn_marker = "                        {buddyConfig?.push_in_progress && !buddyPushing && ("
progress_insert = (
    "                        {isPushing && pushProgress && pushProgress.total_bytes > 0 && (\n"
    "                          <PushProgressBar progress={pushProgress} />\n"
    "                        )}\n"
)

if reset_btn_marker in content:
    content = content.replace(reset_btn_marker, progress_insert + reset_btn_marker, 1)
    print('patch 3 applied (progress bar inserted)')
else:
    print('patch 3 marker not found, trying alternate')
    # try with isPushing already replaced
    alt = "                        {buddyConfig?.push_in_progress && !isPushing && ("
    if alt in content:
        content = content.replace(alt, progress_insert + alt, 1)
        print('patch 3 applied (alt)')
    else:
        print('patch 3 NOT FOUND')

with open(filepath, 'w') as f:
    f.write(content)

print('done')
