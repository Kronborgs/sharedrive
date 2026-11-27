const shareTokenPattern = /^[A-Za-z0-9_-]{43}$/
const shareDraftParam = 'share-mail'

export function sharedFileUrl(origin: string, token: string): string {
  return new URL('/shared/' + encodeURIComponent(token), origin).href
}

export function shareMailDraftFragment(token: string, filename: string): string {
  return '#' + new URLSearchParams({ [shareDraftParam]: token, name: filename })
}

export function consumeShareMailDraft() {
  const url = new URL(window.location.href)
  const fragment = new URLSearchParams(url.hash.slice(1))
  const token = fragment.get(shareDraftParam)
  if (!token) return undefined
  url.hash = ''
  window.history.replaceState(window.history.state, '', url)
  if (!shareTokenPattern.test(token)) return undefined

  const name = (fragment.get('name') ?? '').replace(/[\x00-\x1F\x7F]+/g, ' ').trim().slice(0, 255)
  const sharedFileUrlValue = sharedFileUrl(url.origin, token)
  return {
    subject: name,
    textBody: name ? name + '\n' + sharedFileUrlValue : sharedFileUrlValue,
    sharedFileUrl: sharedFileUrlValue,
  }
}
