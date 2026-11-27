let prefix = 'sharedrive-suite:unavailable:'

export function setStorageScope(scope: string) {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('Invalid Sharedrive mailbox scope')
  prefix = 'sharedrive-suite:' + scope + ':'
}

export const suiteStorage = {
  getItem: (key: string) => localStorage.getItem(prefix + key),
  setItem: (key: string, value: string) => localStorage.setItem(prefix + key, value),
  removeItem: (key: string) => localStorage.removeItem(prefix + key),
}
